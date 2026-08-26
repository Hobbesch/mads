/**
 * Orchestrator — Agenten-Pool + Projekt-State + Git/GitHub-Routing (P3/P4).
 *
 * P3: ein Worktree pro Agent (in session.ts), parallele Agenten.
 * P4: GitHub-PR-Lifecycle (create_pr), stale-base-Sync (sync_branch) und ein
 *     Polling-Loop, der git-Status (behind/ahead/dirty) + PR-Status (Checks,
 *     mergeable, review) je Agent meldet → Eskalations-Signale fürs Dashboard.
 */
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AgentSession, type PermissionHooks } from "./session.js";
import { loadApprovedKinds, saveApprovedKinds, loadApprovedTools, saveApprovedTools } from "./permissions.js";
import { killProcessesInWorktree } from "./worktree-procs.js";
import type { CommandKind } from "../../shared/safe-command.js";
import { send, log, envelope, timelineSnapshot, randomUUID } from "./io.js";
import { autoCommit, commitMainRelease, createPr, createReviewWorktree, detectMainVersionBump, rebaseMainOntoOrigin, resetMainToOrigin, pushMainToOrigin, discoverWorktrees, ensureWorktreeSeedFile, fastForwardMain, finalizeAdrDrafts, getRepoInfo, gitStatus, isForeignMadsWorktree, listOpenPrs, mergePr, outsourceMainChanges, prStatus, pushBranch, reconcileAdrCollisions, relocateWorktree, removeWorktree, run, seedLocalDevFiles, syncBranch, unpushedCount, worktreeFingerprint, worktreePathFor, worktreeResidue, type GitStatusResult } from "./git.js";
import { runGate } from "./gate.js";
import { DevServerRun, ensureRunManifest, loadRunManifest, runManifestPath } from "./devserver.js";
import { autopilotDecision } from "../../shared/autopilot.js";
import { acquireProjectLock, ensureMadsDir, loadPrompts, loadRegistry, mergeRegistry, releaseProjectLock, savePrompts, saveRegistry, type RegistryEntry } from "./persistence.js";
import { preMergeGate } from "../../shared/merge.js";
import { parseDiffRegions, detectCollisions, type AgentRegions } from "../../shared/collision.js";
import { detectTrespass, pathMatches, type TrespassFinding } from "../../shared/ownership.js";
import type { OwnershipRule, ChangedRegion } from "../../shared/protocol.js";

// Geteilte „land-first"-Dateien (generisch, projekt-agnostisch): Lockfiles, die nicht parallel
// in mehreren Feature-Branches verändert werden sollen (sonst Merge-Hölle). Erweiterbar.
const SHARED_LANDFIRST_GLOBS = [
  "**/package-lock.json",
  "**/Cargo.lock",
  "**/uv.lock",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/go.sum",
];
import type { HostMessage, ProjectInfo, EscalationKind, AutonomyConfig, ResumableAgent, SavedPrompt, OpenReviewStreamMsg, StartAgentMsg } from "../../shared/protocol.js";
import { loadAccounts, pruneCooldowns, saveAccounts } from "./accounts.js";

/**
 * Grundtakt des Orchestrators. Früher 25 s — zusammen mit „eine Aktion pro Zyklus & Stream"
 * ergab das 50–75 s von „Agent fertig" bis PR, unabhängig davon, wie schnell das Modell war.
 * Das war der stärkste Beitrag zum Eindruck „mads ist zäh". Der Takt ist jetzt kürzer UND nur noch
 * das Sicherheitsnetz: den Normalfall löst `schedulePollSoon()` ereignisgetrieben aus, sobald ein
 * Stream seinen Status wechselt (z. B. fertig wird).
 */
const POLL_INTERVAL_MS = 10_000;
/** Debounce für den ereignisgetriebenen Poll — bündelt die Statuswechsel eines Turn-Endes. */
const POLL_SOON_MS = 1_200;

/** Bot-Autoren (Renovate/Dependabot/…) — deren PRs gehören NICHT in die „eingehende PRs zum Review"-Liste.
 *  `gh pr list --json author` liefert GitHub-App-Actors mit „app/"-Präfix (z. B. „app/github-actions",
 *  „app/dependabot") — deshalb reicht die alte, auf den Namensanfang verankerte Prüfung nicht: „app/" ist
 *  ausschließlich Apps/Bots vorbehalten, also gilt jedes „app/…" als Bot; zusätzlich „[bot]"-Suffix und die
 *  bekannten Namen (auch NACH einem evtl. „app/"-Präfix). */
function isBotAuthor(login: string): boolean {
  const name = login.replace(/^app\//i, "");
  return /^app\//i.test(login) || /\[bot\]$/i.test(login) || /^(renovate|dependabot|github-actions|copilot|snyk|greenkeeper)/i.test(name);
}

export class Orchestrator {
  private readonly pool = new Map<string, AgentSession>();
  private project?: ProjectInfo;
  // Projektweite „Immer erlauben"-Freigaben für Bash-Kategorien (persistent in .mads/permissions.json).
  // Alle Streams des Projekts teilen sich diesen Zustand; bei Projektwechsel neu geladen.
  private readonly approvedKinds = new Set<CommandKind>();
  // Dito, aber pro TOOL-NAME (MCP-/Nicht-Bash-Tools) — siehe permissions.ts.
  private readonly approvedTools = new Set<string>();
  private pollTimer?: ReturnType<typeof setInterval>;
  private pollSoonTimer?: ReturnType<typeof setTimeout>;
  // Re-Entrancy-Schutz: dauert ein Poll-Zyklus (fetch + Autopilot commit/push/PR) länger als das
  // Intervall, würde `setInterval` einen ZWEITEN parallel starten → zwei Push-/Rebase-Zyklen kollidieren
  // (force-with-lease „cannot lock ref … expected …"). Der Guard lässt immer nur EINEN Zyklus laufen.
  private polling = false;
  // Halb-autonomer Integrator (P-Halb): Auto-Sync + Kollisions-Scan.
  private autonomy: AutonomyConfig = { autoSync: true, collisionScan: true };
  private readonly gitState = new Map<string, GitStatusResult>();
  private readonly syncing = new Set<string>(); // läuft gerade ein Auto-Sync?
  private readonly autoSyncConflicted = new Set<string>(); // Auto-Sync pausiert bis manuell gelöst
  // Nach „Mergen & weiterarbeiten": die Nummer des gemergten PRs, die der Poll ignoriert,
  // bis ein NEUER PR aufgeht (sonst zeigt `gh pr view <branch>` weiter den Alt-PR als MERGED).
  private readonly suppressedMergedPr = new Map<string, number>();
  // Autopilot (Phase 2): PR-Erstellung pro „ahead"-Stand nur einmal versuchen (kein Gate-Spam
  // bei rotem Gate); Secret-Eskalation pro Episode nur einmal melden.
  private readonly autopilotPrTried = new Map<string, number>();
  /** B3: Zähler aufeinanderfolgender unzuverlässiger Polls je Agent — bei 5 einmalige Nutzer-Notiz. */
  private readonly unreliablePolls = new Map<string, number>();
  private readonly autopilotSecretNotified = new Set<string>();
  /** Auto-Commit ist pausiert, solange der Dev-Server dieses Streams läuft — je Dev-Server-Sitzung
   *  einmal erklären, damit „nichts passiert" nicht rätselhaft wirkt (cleared beim Dev-Server-Stopp). */
  private readonly autopilotDevserverDeferred = new Set<string>();
  /** Fremd-Edit-Schutz: je Agent einmalig gewarnt, dass der Autopilot wegen fremder Worktree-
   *  Änderungen pausiert (verhindert Warn-Spam; wird bei sauberer Lage wieder gelöscht). */
  private readonly foreignEditNotified = new Set<string>();
  // Proaktiver Hinweis „main direkt geändert" pro Integrator nur einmal je dirty-Episode.
  private readonly mainDirtyNotified = new Set<string>();
  // Explizit entfernte Agenten (gestoppt/aufgeräumt/gemergt) — mergeRegistry darf sie NICHT
  // aus der Registry wiederbeleben (sonst hebt merge-persist ein bewusstes Entfernen auf).
  private readonly removed = new Set<string>();
  // 3.2: Integrationen serialisieren (kein Merge-Race zweier fast gleichzeitiger Merges).
  private integrateLock: Promise<void> = Promise.resolve();
  // Streams, die gerade doIntegrate() durchlaufen (Merge + Cleanup) — autopilotPass() muss sie
  // währenddessen aussparen, sonst pusht ein paralleler Poll-Zyklus auf Basis des Vor-Merge-Stands
  // noch, während der Worktree schon entfernt wird (git-Unterprozess ohne cwd → push_rejected,
  // obwohl längst alles gemerged ist — realer Vorfall, siehe „Tooltip-Erweiterung"/PR #430).
  private readonly integrating = new Set<string>();
  // A: PR-Erstellungen serialisieren, damit die ADR-Nummern-Vergabe (Scan aller Worktrees +
  // Umbenennen) atomar ist und zwei Streams nie dieselbe Nummer ziehen.
  private createPrLock: Promise<void> = Promise.resolve();
  // Höchstens EIN Stream-Dev-Server gleichzeitig (Standard-Ports → kein Konflikt). Ein Start
  // stoppt einen zuvor laufenden; jeder Teardown-Pfad (stop/cleanup/merge/switch/shutdown) killt ihn.
  private devServer?: DevServerRun;
  // Offene READ-ONLY Review-Streams (fremde PRs), Key = agentId (`review-pr-<#>`). Laufzeit-Spiegel;
  // in agents.json persistiert (persistReviewEntry) und beim Start wiederhergestellt (hydrateReviewStreams).
  // Beim Merge/Verwerfen wird Worktree + Registry-Eintrag abgeräumt.
  private reviewStreams = new Map<string, { prNumber: number; branch: string; worktreePath: string; url: string; label: string; author: string }>();

  async dispatch(msg: HostMessage): Promise<void> {
    switch (msg.type) {
      case "set_project":
        this.project = msg.project;
        this.reloadApprovedKinds();
        this.emitPrompts(); // gespeicherte Prompts des Projekts an die Clients
        log(`[orchestrator] project set: ${msg.project.owner}/${msg.project.repo} @ ${msg.project.repoRoot}`);
        this.startPolling();
        break;

      case "open_project": {
        const info = await getRepoInfo(msg.repoRoot);
        if (!info) {
          this.emit({
            ...envelope(),
            type: "error",
            scope: "sidecar",
            code: "auth_broken",
            message: `Kein git-Remote in ${msg.repoRoot} gefunden (origin nötig).`,
            recoverable: true,
          });
          break;
        }
        // Multi-Instanz-Schutz: dasselbe Projekt darf nicht in zwei mads-Fenstern offen sein
        // (zwei Sidecars, die parallel `.mads/agents.json` + dieselben Worktrees schreiben →
        // Korruption). Ist das Projekt in einer anderen, lebenden Instanz offen → ablehnen und
        // das Frontend auf die Projektauswahl zurückfallen lassen (deckt auch den Auto-Öffnen-Fall
        // beim Start ab: dann startet das zweite Fenster nicht im selben Projekt).
        const lock = acquireProjectLock(msg.repoRoot, msg.force);
        if (!lock.ok) {
          this.emit({ ...envelope(), type: "project_locked", repoRoot: msg.repoRoot, byPid: lock.byPid });
          log(`[orchestrator] open_project abgelehnt: ${msg.repoRoot} bereits offen in Instanz pid ${lock.byPid}`);
          break;
        }
        // Echter Projektwechsel: den alten Projekt-Zustand sauber TRENNEN — laufende Sessions
        // beenden (Query schließen; Worktrees, Commits UND agents.json bleiben erhalten → beim
        // Zurückwechseln wieder fortsetzbar) und alle projekt-gebundenen Caches leeren. Sonst
        // blieben die alten Streams im Pool und würden weiter gepollt; ihre git/PR-Updates
        // würden in die UI des NEUEN Projekts lecken (falsche Kacheln, Fehlklick-Risiko).
        if (this.project && this.project.repoRoot !== msg.repoRoot) {
          releaseProjectLock(this.project.repoRoot); // altes Projekt-Lock freigeben (wir haben schon das neue)
          await this.stopDevServerIf(); // Projektwechsel → jeden laufenden Dev-Server beenden
          for (const s of this.pool.values()) await s.stop(false);
          this.pool.clear();
          this.gitState.clear();
          this.removed.clear();
          this.autoSyncConflicted.clear();
          // Review-Streams gehören zum ALTEN Repo — Map leeren, sonst unterdrückt ein alter
          // `review-pr-<#>`-Key einen gleichnummerierten PR im neuen Projekt. (Worktree-Rest ist
          // harmlos: Discovery überspringt `mads-review/*`.)
          this.reviewStreams.clear();
          log(`[orchestrator] project switch → previous pool stopped & cleared`);
        }
        this.project = { projectId: msg.projectId, repoRoot: msg.repoRoot, ...info };
        this.reloadApprovedKinds();
        this.emitPrompts(); // gespeicherte Prompts des Projekts an die Clients
        this.emit({ ...envelope(), type: "project_resolved", project: this.project });
        log(`[orchestrator] project resolved: ${info.owner}/${info.repo} (default ${info.defaultBranch})`);
        void this.offerResumable(msg.repoRoot);
        this.startPolling();
        break;
      }

      case "start_agent": {
        if (this.pool.has(msg.agentId)) {
          log(`[orchestrator] agent ${msg.agentId} existiert bereits`);
          return;
        }
        const session = new AgentSession(msg.agentId, () => { this.persist(); this.schedulePollSoon(); }, this.permHooks(), () => this.activeStreamsSummary(msg.agentId));
        this.pool.set(msg.agentId, session);
        // Resume: den zuletzt gemerkten Auftrag aus agents.json in die frische Session vorladen. Sonst
        // stünde lastPrompt beim automatischen „Fortsetzen" (continuation) auf undefined und das nächste
        // persist() würde den guten Wert auf der Platte überschreiben — der Auftrag ginge verloren.
        let startMsg = msg;
        if (this.project) {
          const known = loadRegistry(this.project.repoRoot).find((e) => e.agentId === msg.agentId);
          if (known?.lastPrompt) session.lastPrompt = known.lastPrompt;
          // Konto aus der Registry übernehmen, wenn der Aufrufer keins mitgibt — sonst würde ein
          // Resume nach Neustart im falschen Konto nach der Session suchen.
          if (!startMsg.accountId && known?.accountId) startMsg = { ...startMsg, accountId: known.accountId };
        }
        await session.start(startMsg);
        this.persist();
        void this.pollAgent(session); // initialer Status
        break;
      }

      case "send_input":
        this.pool.get(msg.agentId)?.sendInput(msg.text, msg.images);
        break;

      case "answer_permission": {
        const target = this.pool.get(msg.agentId);
        const applied = target?.answerPermission(msg.requestId, msg.decision) ?? false;
        // Doppel-Antwort auf eine GERADE aufgelöste Anfrage (anderer Client war schneller) ist harmlos —
        // keine irreführende „nicht angekommen"-Meldung dafür.
        if (!applied && target?.wasRecentlyResolved(msg.requestId)) break;
        if (!applied) {
          // Bisher lief eine nicht zuordenbare (Fern-)Antwort LAUTLOS ins Leere → die Frage blieb
          // ewig offen. Jetzt: Grund loggen UND ein sichtbares System-Event senden, damit der
          // Client (iPad/Desktop) sieht, dass die Antwort nicht angekommen ist.
          const why = target ? "Anfrage nicht mehr offen" : "Stream nicht aktiv";
          log(`[orchestrator] answer_permission verworfen (${why}): agent=${msg.agentId} req=${msg.requestId}`);
          this.emit({
            ...envelope(),
            type: "agent_event",
            agentId: msg.agentId,
            event: { kind: "system", subtype: `⚠ Antwort nicht angekommen (${why}) — Stream fortsetzen und erneut beantworten` },
          });
        }
        break;
      }

      case "interrupt_agent":
        await this.pool.get(msg.agentId)?.interrupt();
        break;

      case "set_permission_mode":
        await this.pool.get(msg.agentId)?.setMode(msg.mode);
        break;

      case "set_model_effort":
        await this.pool.get(msg.agentId)?.setModelEffort(msg.model, msg.effort);
        this.persist(); // Modell/Effort in agents.json festhalten (Resume-fest)
        break;

      case "set_account":
        await this.setAccount(msg.accountId, msg.agentId);
        break;

      case "request_accounts":
        this.emitAccounts();
        break;

      case "stop_agent": {
        const s = this.pool.get(msg.agentId);
        const wt = s?.worktreePath;
        await this.stopDevServerIf(msg.agentId); // laufenden Dev-Server dieses Streams zuerst beenden
        await s?.stop(msg.removeWorktree ?? false);
        // Vom AGENTEN selbst gestartete Prozesse (Repro-Server, Watcher, Headless-Browser) ueberleben
        // das Stream-Ende sonst und belegen Ports. Erst JETZT — der CLI-Prozess der Session laeuft
        // ebenfalls mit cwd = Worktree und wurde gerade regulaer beendet.
        await this.reapWorktreeProcesses(msg.agentId, wt);
        this.pool.delete(msg.agentId);
        this.removed.add(msg.agentId); // bewusst entfernt → merge-persist nicht wiederbeleben
        this.persist();
        break;
      }

      case "start_devserver":
        await this.handleStartDevServer(msg.agentId);
        break;

      case "stop_devserver":
        await this.stopDevServerIf(msg.agentId);
        break;

      case "configure_devserver":
        this.handleConfigureDevServer(msg.agentId);
        break;

      case "open_review_stream":
        await this.handleOpenReviewStream(msg);
        break;

      case "merge_review":
        await this.handleMergeReview(msg.agentId);
        break;

      case "close_review":
        await this.handleCloseReview(msg.agentId);
        break;

      case "create_pr":
        await this.handleCreatePr(msg.agentId, msg.title, msg.body, msg.draft);
        break;

      case "sync_branch":
        await this.handleSync(msg.agentId);
        break;

      case "gate_task":
        await this.handleGate(msg.agentId);
        break;

      case "set_autopilot": {
        const s = this.pool.get(msg.agentId);
        if (s) {
          s.autopilot = msg.level;
          this.autopilotPrTried.delete(msg.agentId);
          this.autopilotSecretNotified.delete(msg.agentId);
          log(`[orchestrator] autopilot ${msg.agentId} → ${msg.level}`);
        }
        break;
      }

      case "outsource_main": {
        if (!this.project) break;
        const integ = this.pool.get(msg.integratorId);
        if (!integ || !integ.repoRoot) {
          // Fehler AUCH an die (optimistisch erzeugte) neue Kachel — sonst bleibt sie ewig „startet".
          this.emitError(msg.agentId, "spawn_failed", "Kein Integrator/Repo — Auslagern nicht möglich.");
          this.emitError(msg.integratorId, "main_edited", "Auslagern nicht möglich (kein Integrator/Repo).");
          break;
        }
        const res = await outsourceMainChanges(integ.repoRoot, this.project.defaultBranch, msg.agentId, msg.branch);
        if (!res.ok) {
          // Auslagern scheiterte (z.B. nichts zu verschieben, main sauber) → die neue Kachel als
          // fehlgeschlagen melden (das Frontend entfernt eine noch startende Kachel), und dem
          // Integrator den Grund status-neutral zeigen.
          this.emitError(msg.agentId, "spawn_failed", `Auslagern fehlgeschlagen: ${res.error}`);
          this.emitError(msg.integratorId, "main_edited", `Auslagern fehlgeschlagen: ${res.error}`);
          break;
        }
        // Neuen Sub-Stream im ausgelagerten Worktree starten (Autopilot committet/PRt die Änderungen).
        const session = new AgentSession(msg.agentId, () => { this.persist(); this.schedulePollSoon(); }, this.permHooks(), () => this.activeStreamsSummary(msg.agentId));
        this.pool.set(msg.agentId, session);
        await session.start({
          ...envelope(),
          type: "start_agent",
          agentId: msg.agentId,
          prompt:
            "Diese Änderungen wurden aus dem Main-Checkout in diesen Sub-Stream ausgelagert. Sieh sie dir an und " +
            "fasse kurz zusammen, was sie bewirken. Committen/Push/PR übernimmt mads — nicht selbst pushen.",
          repoRoot: integ.repoRoot,
          branch: msg.branch,
          resumeWorktreePath: res.worktreePath,
          label: msg.label,
          role: "sub",
          // Kein hartcodiertes Modell (war vorher ein veraltetes "claude-sonnet-4-6" — ignorierte
          // die Picker-Wahl komplett) — das Modell des Integrators übernehmen, dessen main-Änderungen
          // hier ausgelagert werden. Fehlt es, coerciert session.ts auf DEFAULT_MODEL.
          model: integ.model,
          // Konto des Integrators übernehmen, aus dessen main-Checkout ausgelagert wird. Ohne die
          // Angabe fiele der neue Stream auf das globale Standardkonto — also womöglich auf ein
          // anderes Abo als das, unter dem die Arbeit entstanden ist.
          accountId: integ.accountId,
          permissionMode: "auto",
          autopilot: "assisted",
        });
        this.persist();
        await this.pollAgent(session);
        await this.pollAgent(integ); // dirty-Flag des Integrators clearen (main ist jetzt sauber)
        if (res.conflicted) {
          this.emitError(
            msg.agentId,
            "merge_conflict",
            "Die ausgelagerten Änderungen kollidieren mit dem aktuellen main — bitte im Worktree auflösen (Knopf „Konflikt lösen“).",
          );
        }
        this.emit({
          ...envelope(),
          type: "agent_event",
          agentId: msg.integratorId,
          event: { kind: "assistant_text", text: `↗ Main-Änderungen in neuen Sub-Stream „${msg.label}" ausgelagert (Branch ${msg.branch}).` },
        });
        break;
      }

      case "commit_main_release": {
        if (!this.project) break;
        const integ = this.pool.get(msg.agentId);
        if (!integ || !integ.repoRoot) {
          this.emit({ ...envelope(), type: "agent_event", agentId: msg.agentId, event: { kind: "system", subtype: "⚠ Release-Commit nicht möglich (kein Integrator/Repo)." } });
          break;
        }
        // Nur der Integrator committet auf main (Invariante) — im Core erzwingen, nicht nur die UI verstecken.
        if (integ.role !== "integrator") {
          this.emit({ ...envelope(), type: "agent_event", agentId: msg.agentId, event: { kind: "system", subtype: "⚠ Release-Commit nur für den Integrator (main-Checkout) erlaubt." } });
          break;
        }
        const res = await commitMainRelease(integ.repoRoot, this.project.defaultBranch);
        if (!res.ok && res.secrets?.length) {
          // Fail-closed: Secret im Diff → als Eskalation sichtbar machen (nicht committen).
          this.emitError(msg.agentId, "secret_detected", `${res.error} Bitte das Secret entfernen oder gitignoren, dann erneut.`);
          break;
        }
        const skippedNote = res.ok && res.skipped?.length ? ` — übersprungen (Hygiene): ${res.skipped.join(", ")}` : "";
        this.emit({
          ...envelope(),
          type: "agent_event",
          agentId: msg.agentId,
          event: {
            kind: "system",
            subtype: res.ok
              ? `✓ Release committet: ${res.message} (lokal auf ${this.project.defaultBranch} — noch nicht gepusht)${skippedNote}`
              : `⚠ Release-Commit fehlgeschlagen: ${res.error}`,
          },
        });
        if (res.ok) {
          this.mainDirtyNotified.delete(msg.agentId); // Episode beendet → nächste Dirt meldet wieder
          await this.pollAgent(integ); // git-Status neu → main jetzt sauber, Banner verschwindet
        }
        break;
      }

      case "set_autonomy":
        this.autonomy = msg.config;
        log(`[orchestrator] autonomy: autoSync=${msg.config.autoSync} collisionScan=${msg.config.collisionScan}`);
        break;

      case "integrate_pr":
        await this.handleIntegrate(msg.agentId, msg.method ?? "squash", msg.keepBranch ?? false);
        break;

      case "poll_project":
        await this.pollAll();
        break;

      case "cleanup_worktree": {
        if (!this.project) break;
        const root = this.project.repoRoot;
        const path = msg.worktreePath ?? worktreePathFor(root, msg.agentId);
        try {
          // Schutz (G4): einen Worktree mit lokalen Resten (ungespeichert/ungepusht)
          // NUR mit explizitem force löschen — das Frontend setzt es erst nach der
          // Nutzer-Bestätigung. Schützt vor versehentlichem/wiederholtem Aufruf.
          // Ohne Branch lässt sich „unpushed" nicht prüfen → fail-closed (als Rest werten).
          if (!msg.force && existsSync(path)) {
            const res = msg.branch ? await worktreeResidue(path, msg.branch) : { dirty: true, unpushed: 1 };
            if (res.dirty || res.unpushed > 0) {
              this.emitError(
                msg.agentId,
                "spawn_failed",
                `Aufräumen abgelehnt: ${msg.branch ?? path} hat (oder evtl.) lokale Reste (ungespeichert/ungepusht). Im Dialog bestätigen, um sie zu verwerfen.`,
              );
              break;
            }
          }
          await this.stopDevServerIf(msg.agentId); // Dev-Server hält den Worktree offen → erst killen
          await this.reapWorktreeProcesses(msg.agentId, path); // Agenten-Prozesse halten ihn ebenso offen
          this.emitSeedReclaimed(msg.agentId, await removeWorktree(root, path, msg.branch));
          this.removed.add(msg.agentId); // aufgeräumt → merge-persist nicht wiederbeleben
          saveRegistry(root, loadRegistry(root).filter((e) => e.agentId !== msg.agentId));
          log(`[orchestrator] aufgeräumt: ${msg.branch ?? msg.agentId} (${path})`);
        } catch (e) {
          log(`[orchestrator] cleanup_worktree fehlgeschlagen: ${String(e)}`);
        }
        break;
      }

      case "update_main": {
        // G5: Integrator-Aktion — main nachziehen. Zuerst fast-forward (unverfänglich).
        if (!this.project) break;
        // main ist lokal VORAUS und die Commits sind ECHT (z. B. Release-/Versions-Bumps, behalten) →
        // nach origin/<base> pushen statt verwerfen (Fast-Forward, kein force). Sichere Alternative zu `hard`.
        if (msg.push) {
          const pr = await pushMainToOrigin(this.project.repoRoot, this.project.defaultBranch);
          if (!pr.ok) {
            this.emitError(msg.agentId, pr.kind, `main pushen fehlgeschlagen: ${pr.error}`);
            break;
          }
          this.emit({
            ...envelope(),
            type: "agent_event",
            agentId: msg.agentId,
            event: {
              kind: "assistant_text",
              text: `⤒ ${pr.pushed} lokale(n) Commit(s) nach origin/${this.project.defaultBranch} gepusht — main ist jetzt in Sync (0/0).`,
            },
          });
          const stP = await gitStatus(this.project.repoRoot, this.project.repoRoot, this.project.defaultBranch, this.project.defaultBranch);
          if (!stP.unreliable) {
            this.gitState.set(msg.agentId, stP);
            this.emitGitStatus(msg.agentId, stP);
          }
          const sP = this.pool.get(msg.agentId);
          if (sP) await this.pollAgent(sP);
          break;
        }
        // Feature A: main ist lokal VORAUS (z. B. nicht gepushte Release-/Versions-Bump-Commits, die ein
        // fast-forward nicht auflöst) → auf Wunsch hart auf origin/<base> setzen (mit Backup-Branch).
        if (msg.hard) {
          const rr = await resetMainToOrigin(this.project.repoRoot, this.project.defaultBranch);
          if (!rr.ok) {
            this.emitError(msg.agentId, "stale_base", `main zurücksetzen fehlgeschlagen: ${rr.error}`);
            break;
          }
          this.emit({
            ...envelope(),
            type: "agent_event",
            agentId: msg.agentId,
            event: {
              kind: "assistant_text",
              text:
                rr.discarded > 0
                  ? `↺ main hart auf origin/${this.project.defaultBranch} gesetzt — ${rr.discarded} lokale(n), nicht gepushte(n) Commit(s) verworfen (gesichert auf Branch ${rr.backup}, verlustfrei rückholbar).`
                  : "main ist nicht voraus — nichts zu verwerfen.",
            },
          });
          const stH = await gitStatus(this.project.repoRoot, this.project.repoRoot, this.project.defaultBranch, this.project.defaultBranch);
          if (!stH.unreliable) {
            this.gitState.set(msg.agentId, stH);
            this.emitGitStatus(msg.agentId, stH);
          }
          const sH = this.pool.get(msg.agentId);
          if (sH) await this.pollAgent(sH);
          break;
        }
        let res = await fastForwardMain(this.project.repoRoot, this.project.defaultBranch);
        // DIVERGIERT (lokale Commits auf main + origin voraus) war bisher eine Sackgasse: die UI sagte
        // „Merge/Rebase nötig", bot aber keinen Weg — der Nutzer musste in den Terminal. Das passiert im
        // Alltag ständig, weil jeder Deploy-Versions-Bump/Release-Commit lokal auf main liegt. Jetzt:
        // die lokalen Commits verlustfrei auf origin/<base> rebasen (Konflikt → abort, alles bleibt).
        if (res.blocked === "diverged") {
          const rb = await rebaseMainOntoOrigin(this.project.repoRoot, this.project.defaultBranch);
          if (rb.ok) {
            this.emit({
              ...envelope(),
              type: "agent_event",
              agentId: msg.agentId,
              event: {
                kind: "assistant_text",
                text:
                  `↻ main war divergiert → deine ${rb.rebased} lokale(n) Commit(s) wurden verlustfrei auf ` +
                  `origin/${this.project.defaultBranch} rebased. main ist jetzt aktuell (Push bleibt deine Entscheidung).`,
              },
            });
            const st = await gitStatus(this.project.repoRoot, this.project.repoRoot, this.project.defaultBranch, this.project.defaultBranch);
            // B3: git-Fehler nie als frischen Stand cachen/senden — letzter guter Stand bleibt.
            if (!st.unreliable) {
              this.gitState.set(msg.agentId, st);
              this.emitGitStatus(msg.agentId, st);
            }
            break;
          }
          this.emitError(msg.agentId, "stale_base", `main aktualisieren fehlgeschlagen: ${rb.error}`);
          break;
        }
        if (res.ff > 0) {
          this.emit({
            ...envelope(),
            type: "agent_event",
            agentId: msg.agentId,
            event: { kind: "assistant_text", text: `↻ main per fast-forward auf origin/${this.project.defaultBranch} aktualisiert (+${res.ff} Commits).` },
          });
        } else if (res.blocked) {
          // "diverged" ist oben bereits per Rebase aufgelöst → hier bleiben nur diese Fälle.
          const why =
            res.blocked === "dirty"
              ? "uncommittete Änderungen an getrackten Dateien"
              : res.blocked === "detached"
                ? "detached HEAD"
                : "unerwartet (git-Status prüfen)";
          this.emitError(msg.agentId, "stale_base", `main konnte nicht vorgezogen werden: ${why} (${res.behind} behind).`);
        } else {
          this.emit({
            ...envelope(),
            type: "agent_event",
            agentId: msg.agentId,
            event: { kind: "assistant_text", text: "main ist bereits aktuell." },
          });
        }
        const s = this.pool.get(msg.agentId);
        if (s) await this.pollAgent(s); // Badge aktualisieren
        break;
      }

      case "shutdown":
        if (this.pollTimer) clearInterval(this.pollTimer);
        if (this.pollSoonTimer) clearTimeout(this.pollSoonTimer); // sonst hielte er den Prozess offen
        await this.stopDevServerIf(); // laufenden Dev-Server sauber beenden (Prozess-Gruppen-Kill)
        if (this.project) releaseProjectLock(this.project.repoRoot); // Projekt-Lock freigeben
        for (const s of this.pool.values()) await s.stop(false);
        this.pool.clear();
        process.exit(0);
        break;

      case "request_snapshot":
        // [Remote-Bridge] Ist-Zustand für einen (später) verbindenden Client re-emittieren (§4.3).
        this.emitSnapshot();
        break;

      case "prompt_save": {
        // Prompt-Verwaltung: Upsert per id in <repoRoot>/.mads/prompts.json. Validierung hier
        // (nicht nur in der UI), damit auch Remote-Clients keine kaputten Einträge schreiben.
        if (!this.project) break;
        const p = msg.prompt;
        // Whitelist-Kopie statt Spread: ein (Remote-)Client darf weder beliebige Zusatzfelder
        // in prompts.json persistieren noch mit Nicht-String-Typen den Handler crashen.
        const title = (typeof p?.title === "string" ? p.title : "").trim();
        const description = typeof p?.description === "string" ? p.description.slice(0, 500) : undefined;
        const text = typeof p?.text === "string" ? p.text : "";
        if (!title || !text.trim()) {
          log(`[orchestrator] prompt_save verworfen: title/text leer`);
          break;
        }
        if (title.length > 200 || text.length > 20_000) {
          log(`[orchestrator] prompt_save verworfen: title/text zu lang`);
          break;
        }
        const role: SavedPrompt["role"] = p.role === "integrator" || p.role === "sub" || p.role === "any" ? p.role : "any";
        const saved: SavedPrompt = {
          id: typeof p.id === "string" && p.id.trim() ? p.id : randomUUID(),
          title,
          ...(description ? { description } : {}),
          role,
          text,
          updatedAt: Date.now(),
        };
        const prompts = loadPrompts(this.project.repoRoot);
        const idx = prompts.findIndex((x) => x.id === saved.id);
        if (idx >= 0) prompts[idx] = saved;
        else if (prompts.length >= 100) {
          log(`[orchestrator] prompt_save verworfen: Limit von 100 Prompts erreicht`);
          break;
        } else prompts.push(saved);
        savePrompts(this.project.repoRoot, prompts);
        this.emitPrompts();
        break;
      }

      case "prompt_delete": {
        if (!this.project) break;
        savePrompts(
          this.project.repoRoot,
          loadPrompts(this.project.repoRoot).filter((x) => x.id !== msg.id),
        );
        this.emitPrompts();
        break;
      }

      case "handoff_export":
        this.runHandoff("export", ["export", msg.repoRoot, msg.outFile]);
        break;

      case "handoff_import":
        this.runHandoff("import", ["import", msg.file, ...(msg.targetRepoRoot ? [msg.targetRepoRoot] : [])]);
        break;

      default:
        log("[orchestrator] unbekannter HostMessage-Typ", JSON.stringify(msg));
    }
  }

  /**
   * Re-Emit des aktuellen Ist-Zustands für einen (später) verbindenden Remote-Client
   * (docs/design/remote-companion-app.md §4.3). Sendet KEINE neuen Fakten, sondern re-emittiert
   * gecachten State über exakt die Nachrichten, die der zustand-Store ohnehin verarbeitet, und
   * schiebt ein frisches `pollAll()` (Live-git/PR) asynchron nach — der Snapshot blockiert nicht.
   *
   * Hinweis: stdout ist geteilt — die (idempotenten) State-Updates sehen auch das lokale Frontend
   * und andere Clients. Das ist harmlos (der Reducer ist für diese Nachrichten idempotent).
   *
   * Bewusst (noch) NICHT enthalten: `gate_result` (nirgends gecacht — ein Re-Run wäre ein
   * Seiteneffekt), `devserver_log`-Historie, `resumable_agents`/`reconcile_summary` (kommen aus
   * `offerResumable`, das Reconciliation-Seiteneffekte hätte). Kommen in einem späteren Hardening-Pass.
   */
  private emitSnapshot(): void {
    if (this.project) this.emit({ ...envelope(), type: "project_resolved", project: this.project });
    this.emitPrompts(); // gespeicherte Prompts — sonst fehlt einem neu verbundenen Client die Liste
    for (const s of this.pool.values()) {
      this.emit({ ...envelope(), type: "status_update", agentId: s.agentId, status: s.status, label: s.label, role: s.role });
      this.emit({
        ...envelope(),
        type: "cost_update",
        agentId: s.agentId,
        totalCostUsd: s.costUsd,
        numTurns: s.numTurns,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
      });
      const gs = this.gitState.get(s.agentId);
      if (gs) this.emitGitStatus(s.agentId, gs);
      if (s.lastPr) this.emit({ ...envelope(), type: "pr_update", agentId: s.agentId, pr: s.lastPr });
      // Timeline-VERLAUF zurückspielen — sonst sieht ein mitten im Lauf verbundener Client (iOS)
      // nur den Live-Rest ab jetzt, nicht die bereits gestreamten Schritte. Frontend ignoriert das.
      const tl = timelineSnapshot(s.agentId);
      if (tl.length) this.emit({ ...envelope(), type: "agent_timeline", agentId: s.agentId, events: tl });
      // Offene Permission-Requests erneut senden — sonst sieht ein (wieder) verbundener Remote-Client
      // eine noch wartende Rückfrage/Tool-Freigabe nicht und kann sie nicht beantworten.
      s.resnapshotPermissions();
    }
    // Live-Refresh (git/PR) asynchron nachschieben — blockiert den Snapshot nicht.
    void this.pollAll();
  }

  /** Vollständige Prompt-Liste des Projekts emitten (nach Projekt-Öffnen und jeder Änderung). */
  private emitPrompts(): void {
    if (!this.project) return;
    this.emit({ ...envelope(), type: "prompts_update", prompts: loadPrompts(this.project.repoRoot) });
  }

  /**
   * scripts/mads-handoff.mjs export|import als Subprozess ausführen und das Ergebnis als
   * `handoff_result` melden. Bei erfolgreichem Import wird das (ggf. re-homed) Ziel-Repo aus der
   * Skript-Ausgabe geparst und mitgeschickt → das Frontend bietet „Projekt öffnen" an, der
   * anschließende Reconcile zeigt die Streams als fortsetzbar (mit Kontext).
   */
  private runHandoff(action: "export" | "import", args: string[]): void {
    const script = fileURLToPath(new URL("../../scripts/mads-handoff.mjs", import.meta.url));
    log(`[orchestrator] handoff ${action}: node ${script} ${args.join(" ")}`);
    execFile("node", [script, ...args], { maxBuffer: 1 << 28, timeout: 600_000 }, (err, stdout, stderr) => {
      const out = `${stdout ?? ""}${stderr ?? ""}`.trim();
      const lines = out.split("\n").filter(Boolean);
      if (err) {
        const message = lines.slice(-3).join(" · ") || String(err);
        this.emit({ ...envelope(), type: "handoff_result", action, ok: false, message });
        log(`[orchestrator] handoff ${action} FEHLER: ${out}`);
        return;
      }
      const summary = lines.filter((l) => /✓|Streams|Sessions|origin/.test(l)).join(" · ") || lines.slice(-2).join(" · ");
      let repoRoot: string | undefined;
      let path: string | undefined;
      if (action === "export") {
        path = args[2]; // outFile
      } else {
        repoRoot = out.match(/Import fertig → (.+)/)?.[1]?.trim();
        path = repoRoot;
      }
      this.emit({ ...envelope(), type: "handoff_result", action, ok: true, message: summary, path, repoRoot });
      log(`[orchestrator] handoff ${action} ok → ${summary}`);
    });
  }

  // ---------------------------------------------------------------- GitHub
  /** PR-Erstellung — SERIALISIERT (A: atomare ADR-Nummern-Vergabe). */
  private async handleCreatePr(agentId: string, title?: string, body?: string, draft?: boolean): Promise<void> {
    const prev = this.createPrLock;
    let release!: () => void;
    this.createPrLock = new Promise<void>((r) => (release = r));
    await prev.catch(() => {});
    try {
      await this.doCreatePr(agentId, title, body, draft);
    } finally {
      release();
    }
  }

  private async doCreatePr(agentId: string, title?: string, body?: string, draft?: boolean): Promise<void> {
    const s = this.pool.get(agentId);
    // B2: bereits aufgeräumte Streams (Merge/Cleanup hat den Worktree entfernt) NICHT rot
    // eskalieren — ein verspäteter Klick/Autopilot-Lauf trifft sonst einen längst fertigen
    // Stream und erzeugt eine „Geist"-Eskalation. Ehrlicher Hinweis reicht.
    if (this.removed.has(agentId) || (s?.worktreePath && !existsSync(s.worktreePath))) {
      this.emit({
        ...envelope(),
        type: "agent_event",
        agentId,
        event: { kind: "assistant_text", text: "Kein PR möglich: Dieser Stream ist bereits aufgeräumt — nichts zu tun." },
      });
      return;
    }
    if (!s || !s.repoRoot || !s.branch || !s.worktreePath || !this.project) {
      this.emitError(agentId, "spawn_failed", "Kein Worktree/Projekt für diesen Agenten — PR nicht möglich.");
      return;
    }

    // 3.6: Ownership durchsetzen — kein PR/Push, wenn dieser Stream eine Region/geteilte Datei
    // berührt, die ein früher gestarteter Stream besitzt. Koordiniert statt parallel kollidiert.
    const trespass = await this.ownershipGate(agentId);
    if (trespass.length) {
      this.emitError(
        agentId,
        "ownership_trespass",
        `PR gestoppt — Überschneidung: ${this.trespassReason(trespass)}. Warte, bis der andere Stream gemergt ist, dann „Sync" (rebase) und erneut.`,
      );
      return;
    }

    // A: ADR-Entwürfe (ADR-DRAFT-*) jetzt eindeutig nummerieren — Nummer global frei über
    // origin/main UND alle anderen aktiven Worktrees (deren bereits vergebene Nummern). Durch
    // createPrLock atomar → zwei Streams ziehen nie dieselbe Nummer. No-Op ohne Draft-Dateien.
    const usedByOthers: number[] = [];
    for (const o of this.pool.values()) {
      if (o.agentId === agentId || o.role !== "sub" || !o.worktreePath) continue;
      const r = await run("git", ["-C", o.worktreePath, "ls-files", "*ADR-*.md"], o.worktreePath);
      for (const m of r.stdout.match(/ADR-0*(\d+)/g) ?? []) usedByOthers.push(parseInt(m.replace(/\D/g, ""), 10));
    }
    const fin = await finalizeAdrDrafts(s.worktreePath, this.project.defaultBranch, usedByOthers);
    if (fin.error) {
      this.emitError(agentId, "push_rejected", `ADR-Nummerierung fehlgeschlagen: ${fin.error}`);
      return;
    }
    if (fin.renamed.length) {
      this.emit({
        ...envelope(),
        type: "agent_event",
        agentId,
        event: {
          kind: "assistant_text",
          text: `🔢 ${fin.renamed.length} ADR-Entwurf/Entwürfe nummeriert: ${fin.renamed.map((r) => "ADR-" + r.num).join(", ")}.`,
        },
      });
    }

    // Backstop (unabhängig von der DRAFT-Convention): hat der Branch eine NUMMERIERTE ADR
    // hinzugefügt, deren Nummer auf origin/main inzwischen für eine andere Datei vergeben ist,
    // jetzt umnummerieren — sonst ginge die Kollision in den PR.
    const rec = await reconcileAdrCollisions(s.worktreePath, this.project.defaultBranch);
    if (rec.error) {
      this.emitError(agentId, "push_rejected", `ADR-Kollisionsauflösung fehlgeschlagen: ${rec.error}`);
      return;
    }
    if (rec.renamed.length) this.emitAdrRenamed(agentId, rec.renamed);

    // Ohne Commits gegenüber dem Default-Branch scheitert `gh pr create` mit einem
    // kryptischen „No commits between …". Vorab klar prüfen und führen.
    const pre = await gitStatus(s.repoRoot, s.worktreePath, s.branch, this.project.defaultBranch);
    // B3: git-Fehler (z. B. Worktree/Ref gerade weg) → ahead=0 wäre eine LÜGE. Ehrlich sagen
    // statt fälschlich „Keine Commits" zu eskalieren.
    if (pre.unreliable) {
      this.emit({
        ...envelope(),
        type: "agent_event",
        agentId,
        event: {
          kind: "assistant_text",
          text: "Kein PR möglich: Der git-Status dieses Streams ist gerade nicht zuverlässig ermittelbar (git-Fehler) — bitte gleich noch einmal versuchen.",
        },
      });
      return;
    }
    if (pre.ahead === 0) {
      // KEIN roter push_rejected: „nichts zu PRen" ist keine Ablehnung. Der bereits gemergte/leere
      // Branch (clean) ist ein harmloser Normalzustand (häufig nach „Mergen & weiterarbeiten");
      // uncommittete Änderungen sind ein Hinweis, kein Fehler. Beides → assistant_text statt Eskalation.
      const text = pre.dirty
        ? `Kein PR möglich: Der Branch ${s.branch} hat noch keine Commits gegenüber ${this.project.defaultBranch} — die Änderungen sind nicht committet. Lass den Agenten zuerst LOKAL committen (git add -A && git commit; KEINE projekteigenen Push-Skripte — die pushen auf main), dann erneut „PR erstellen".`
        : `Nichts zu PRen: ${s.branch} ist bereits auf dem Stand von ${this.project.defaultBranch} (gemergt / keine Änderungen) — kein PR nötig.`;
      this.emit({ ...envelope(), type: "agent_event", agentId, event: { kind: "assistant_text", text } });
      return;
    }

    // P6: kein roter PR — erst das Clean-Code-Gate.
    const gate = await this.handleGate(agentId);
    if (!gate.ok) {
      this.emit({
        ...envelope(),
        type: "agent_event",
        agentId,
        event: { kind: "assistant_text", text: "⛔ PR nicht erstellt — Clean-Code-Gate ist rot (siehe oben)." },
      });
      return;
    }

    const res = await createPr(
      s.worktreePath,
      s.repoRoot,
      s.branch,
      this.project.defaultBranch,
      title ?? `mads: ${s.branch}`,
      body ?? "Erstellt von mads.",
      draft ?? false,
    );
    if (!res.ok) {
      if (res.noCommits) {
        // GitHub selbst: „No commits between …" — der Branch-Inhalt ist bereits im Default-Branch
        // (typisch nach Squash-Merge: voraus nach Commit-SHA, aber leer nach Inhalt). KEINE Ablehnung
        // → harmloser Hinweis statt roter push_rejected-Eskalation. Der Stream ist fertig.
        this.emit({
          ...envelope(),
          type: "agent_event",
          agentId,
          event: {
            kind: "assistant_text",
            text: `Nichts zu PRen: ${s.branch} ist inhaltlich bereits in ${this.project.defaultBranch} (gemergt) — GitHub meldet „keine Commits dazwischen". Kein PR nötig; der Stream kann beendet werden.`,
          },
        });
        return;
      }
      if (res.transient) {
        // Der Push war ERFOLGREICH; nur GitHub lieferte beim PR-Anlegen einen transienten Server-Fehler
        // (GraphQL-500 o. Ä.) — auch nach mehreren Wiederholungen. Das ist KEINE Ablehnung und nicht der
        // Code des Streams → sichtbarer Hinweis statt roter push_rejected-Eskalation.
        this.emit({
          ...envelope(),
          type: "agent_event",
          agentId,
          event: {
            kind: "assistant_text",
            text:
              `⚠ PR-Erstellung: GitHub lieferte einen vorübergehenden Server-Fehler (auch nach mehreren Versuchen). ` +
              `Der Branch ist gepusht — das liegt an GitHub, nicht an deinem Code. Bitte gleich noch einmal „PR erstellen".\n\n` +
              `Details: ${res.error}`,
          },
        });
        return;
      }
      this.emitError(agentId, "push_rejected", `PR-Erstellung fehlgeschlagen: ${res.error}`);
      return;
    }
    log(`[orchestrator] PR erstellt für ${agentId}: ${res.url}`);
    await this.pollAgent(s);
  }

  private async handleSync(agentId: string): Promise<void> {
    const s = this.pool.get(agentId);
    if (!s || !s.worktreePath || !s.branch || !this.project) {
      this.emitError(agentId, "spawn_failed", "Kein Worktree/Projekt — Sync nicht möglich.");
      return;
    }
    const res = await syncBranch(s.worktreePath, s.branch, this.project.defaultBranch);
    if (!res.ok) {
      this.emitError(agentId, res.kind, `Sync fehlgeschlagen: ${res.error}`);
      return;
    }
    this.autoSyncConflicted.delete(agentId); // manuell gelöst → Auto-Sync wieder erlauben
    if (res.renamedAdrs?.length) this.emitAdrRenamed(agentId, res.renamedAdrs);
    log(`[orchestrator] Branch ${s.branch} rebaset onto origin/${this.project.defaultBranch}`);
    await this.pollAgent(s);
  }

  /**
   * Integrator-Merge (Invariante 1: nur diese Op landet auf main). 3.2: über `integrateLock`
   * SERIALISIERT — zwei fast gleichzeitige Merges würden sich gegenseitig veralten lassen.
   * Jede Integration wartet auf die vorige; `doIntegrate` holt oben jeweils frischen
   * git-/PR-Status + prüft das Vor-Merge-Gate neu (sieht also den Stand nach dem Vorgänger).
   */
  private async handleIntegrate(
    agentId: string,
    method: "squash" | "merge" | "rebase",
    keepBranch = false,
  ): Promise<void> {
    const prev = this.integrateLock;
    let release!: () => void;
    this.integrateLock = new Promise<void>((r) => (release = r));
    await prev.catch(() => {});
    this.integrating.add(agentId);
    try {
      await this.doIntegrate(agentId, method, keepBranch);
    } finally {
      this.integrating.delete(agentId);
      release();
    }
  }

  /** gegated: holt frischen git-/PR-Status, prüft das Vor-Merge-Gate, merged nur bei grün,
   *  rebaset danach die anderen Streams (3.1) und räumt auf bzw. behält den Branch. */
  private async doIntegrate(
    agentId: string,
    method: "squash" | "merge" | "rebase",
    keepBranch = false,
  ): Promise<void> {
    const s = this.pool.get(agentId);
    if (!s || !s.repoRoot || !s.branch || !this.project) {
      this.emitMergeResult(agentId, false, ["Kein Worktree/Projekt — Integration nicht möglich."]);
      return;
    }

    // frischen Status holen (die UI kann bis zu einem Poll-Zyklus veraltet sein)
    let behind = 0;
    if (s.worktreePath) {
      const st = await gitStatus(s.repoRoot, s.worktreePath, s.branch, this.project.defaultBranch);
      // B3: ein erlogenes behind=0 würde den Stale-Base-Check des Merge-Gates aushebeln —
      // dann merged ein tatsächlich zurückliegender Branch (Kern-Invariante 2). Abbrechen.
      if (st.unreliable) {
        this.emitMergeResult(agentId, false, ["git-Status nicht zuverlässig ermittelbar — bitte erneut versuchen."], undefined);
        return;
      }
      behind = st.behind;
      this.emitGitStatus(agentId, st);
    }
    const pr = await prStatus(s.repoRoot, s.branch);
    if (pr) this.emit({ ...envelope(), type: "pr_update", agentId, pr });

    const gate = preMergeGate(pr ?? undefined, behind);
    if (!gate.ok) {
      this.emitMergeResult(agentId, false, gate.reasons, pr?.number);
      return;
    }

    const res = await mergePr(s.repoRoot, s.branch, method);
    if (!res.ok) {
      this.emitMergeResult(agentId, false, [res.error], pr?.number);
      return;
    }

    log(`[orchestrator] PR ${pr?.number ?? s.branch} gemerged (${method})${keepBranch ? " — Branch behalten" : ""}`);
    this.emitMergeResult(agentId, true, [], pr?.number);

    if (keepBranch) {
      // Langlebiger Integrations-Branch: NICHT aufräumen. Den Branch auf das frische main
      // zurücksetzen (sauberer Weiterarbeits-Stand — die Arbeit liegt jetzt als Squash in
      // main), Stream offen lassen. Der gemergte PR wird im Poll unterdrückt, bis ein neuer
      // PR aufgeht; das PR-Badge wird sofort gelöscht.
      if (pr) this.suppressedMergedPr.set(agentId, pr.number);
      let resyncOk = true;
      if (s.worktreePath) {
        await this.stopDevServerIf(agentId); // Dev-Server killen, bevor der Worktree bewegt wird
        const base = this.project.defaultBranch;
        await run("git", ["-C", s.worktreePath, "fetch", "origin", base], s.worktreePath);
        resyncOk = await this.resyncAfterMerge(agentId, s.worktreePath, base);
        const st = await gitStatus(s.repoRoot, s.worktreePath, s.branch, base);
        // B3: git-Fehler nie als frischen Stand cachen/senden — letzter guter Stand bleibt.
        if (!st.unreliable) {
          this.gitState.set(agentId, st);
          this.emitGitStatus(agentId, st);
        }
      }
      this.emit({ ...envelope(), type: "pr_update", agentId, pr: undefined }); // PR-Badge löschen
      this.emit({ ...envelope(), type: "status_update", agentId, status: "waiting_input", currentStep: undefined });
      this.emit({
        ...envelope(),
        type: "agent_event",
        agentId,
        event: {
          kind: "assistant_text",
          text:
            `✓ PR${pr?.number ? ` #${pr.number}` : ""} nach ${this.project.defaultBranch} gemerged & Branch „${s.branch}" ` +
            `auf origin/${this.project.defaultBranch} zurückgesetzt${resyncOk ? "" : " (Reset fehlgeschlagen — bitte manuell Sync drücken)"}. ` +
            `Du kannst hier weiterarbeiten; neue Änderungen ergeben einen neuen PR.`,
        },
      });
      this.persist();
      await this.rebaseOthersOnMain(agentId); // 3.1: die anderen Streams sofort nachziehen
      return;
    }

    if (pr) this.emit({ ...envelope(), type: "pr_update", agentId, pr: { ...pr, state: "MERGED" } });
    this.emit({ ...envelope(), type: "status_update", agentId, status: "done", currentStep: "merged" });

    // Session ZUERST schließen — VOR jedem Aufräumen im Worktree. Der CLI-Prozess dieser Session
    // läuft mit cwd = Worktree; das Reap unten würde ihn sonst per SIGTERM erwischen, während der
    // Stream noch offen ist → „consume_failed: exited with code 143" als roter Fehler auf einem
    // GELUNGENEN Merge (siehe Kontrakt in worktree-procs.ts: erst Session beenden, dann reapen —
    // der stop_agent-Pfad hält diese Reihenfolge bereits ein).
    s.status = "done";
    await s.stop(false); // Query schließen; Karte bleibt als "merged" sichtbar

    // Aufräumen (best effort — blockiert das erfolgreiche Merge-Ergebnis NICHT):
    // Worktree zuerst entfernen (gibt den ausgecheckten Branch frei + löscht den lokalen
    // Branch), danach den Remote-Branch löschen.
    if (s.worktreePath) {
      try {
        await this.stopDevServerIf(agentId); // Dev-Server killen, bevor der Worktree entfernt wird
        await this.reapWorktreeProcesses(agentId, s.worktreePath); // dito für vom Agenten gestartete Prozesse
        this.emitSeedReclaimed(agentId, await removeWorktree(s.repoRoot, s.worktreePath, s.branch));
      } catch (e) {
        log(`[orchestrator] worktree cleanup after merge failed: ${String(e)}`);
      }
    } else {
      await run("git", ["-C", s.repoRoot, "branch", "-D", s.branch], s.repoRoot);
    }
    await run("git", ["-C", s.repoRoot, "push", "origin", "--delete", s.branch], s.repoRoot);
    // B1: nach Merge + Aufräumen den git-Status EXPLIZIT auf „fertig" setzen und emitten.
    // Bisher emittierte dieser Pfad keinen git_status → das UI leitete bis zu 25 s aus dem
    // stale ahead>0 einen „Geist"-Stream ab, statt sofort „erledigt" anzuzeigen.
    const doneStatus: GitStatusResult = { behind: 0, ahead: 0, dirty: false };
    this.gitState.set(agentId, doneStatus);
    this.emitGitStatus(agentId, doneStatus);
    this.removed.add(agentId); // gemergt+aufgeräumt → nicht mehr in die Resume-Registry
    this.persist(); // gemergten Agenten aus der Resume-Registry entfernen
    await this.rebaseOthersOnMain(agentId); // 3.1: origin/main bewegte sich → andere nachziehen
  }

  private emitMergeResult(agentId: string, ok: boolean, reasons: string[], prNumber?: number): void {
    this.emit({ ...envelope(), type: "merge_result", agentId, ok, merged: ok, reasons, prNumber });
  }

  /** Hinweis im Stream-Verlauf, dass beim Aufräumen gitignorte Dev-Config gerettet wurde. */
  /** Projektweite „Immer erlauben"-Freigaben aus .mads/permissions.json (neu) laden. */
  private reloadApprovedKinds(): void {
    this.approvedKinds.clear();
    this.approvedTools.clear();
    if (!this.project) return;
    for (const k of loadApprovedKinds(this.project.repoRoot)) this.approvedKinds.add(k);
    for (const t of loadApprovedTools(this.project.repoRoot)) this.approvedTools.add(t);
  }

  /** Permission-Hooks, die jede Session bekommt: geteilter (live) Projekt-Zustand + Persistenz. */
  private permHooks(): PermissionHooks {
    return {
      isKindApproved: (k) => this.approvedKinds.has(k),
      approveKind: (k) => {
        if (this.approvedKinds.has(k)) return;
        this.approvedKinds.add(k);
        if (this.project) saveApprovedKinds(this.project.repoRoot, this.approvedKinds);
      },
      isToolApproved: (t) => this.approvedTools.has(t),
      approveTool: (t) => {
        if (this.approvedTools.has(t)) return;
        this.approvedTools.add(t);
        if (this.project) saveApprovedTools(this.project.repoRoot, this.approvedTools);
      },
    };
  }

  private emitSeedReclaimed(agentId: string, salvage: { restored: string[]; reclaimed: string[] }): void {
    if (!salvage.restored.length && !salvage.reclaimed.length) return;
    const parts: string[] = [];
    if (salvage.restored.length)
      parts.push(`in den Haupt-Checkout gerettet: ${salvage.restored.join(", ")}`);
    if (salvage.reclaimed.length)
      parts.push(`abweichende nach .mads/reclaimed/ gesichert (Haupt-Version unberührt): ${salvage.reclaimed.join(", ")}`);
    this.emit({
      ...envelope(),
      type: "agent_event",
      agentId,
      event: {
        kind: "assistant_text",
        text: `🔐 Aufräumen: gitignorte Dev-Config (Secrets/Keys) bewahrt — ${parts.join("; ")}.`,
      },
    });
  }

  /** Hinweis im Stream-Verlauf, dass der ADR-Kollisions-Backstop umnummeriert hat. */
  private emitAdrRenamed(agentId: string, renamed: { num: string; to: string }[]): void {
    this.emit({
      ...envelope(),
      type: "agent_event",
      agentId,
      event: {
        kind: "assistant_text",
        text: `🔢 ADR-Nummern-Kollision mit ${this.project?.defaultBranch ?? "main"} aufgelöst: ${renamed
          .map((r) => "ADR-" + r.num)
          .join(", ")} (Datei + Verweise umnummeriert).`,
      },
    });
  }

  // ---------------------------------------------------------------- Gate (P6)
  private async handleGate(agentId: string): Promise<{ ok: boolean }> {
    const s = this.pool.get(agentId);
    if (!s || !s.worktreePath || !this.project) {
      this.emit({
        ...envelope(),
        type: "gate_result",
        agentId,
        ok: false,
        steps: [{ name: "gate", status: "fail", summary: "Kein Worktree/Projekt" }],
      });
      return { ok: false };
    }
    const res = await runGate(s.worktreePath, this.project.defaultBranch);
    this.emit({ ...envelope(), type: "gate_result", agentId, ok: res.ok, steps: res.steps });
    return { ok: res.ok };
  }

  // ---------------------------------------------------------- Persistenz/Resume (P7)
  private persist(): void {
    if (!this.project) return;
    const poolEntries: RegistryEntry[] = [];
    for (const s of this.pool.values()) {
      if (s.mock || !s.sessionId) continue; // echte Agenten mit Session sind resumebar (auch fertige/Integrator)
      poolEntries.push({
        agentId: s.agentId,
        label: s.label ?? s.agentId,
        role: s.role ?? "sub",
        sessionId: s.sessionId,
        branch: s.branch,
        worktreePath: s.worktreePath,
        lastPrompt: s.lastPrompt,
        status: s.status,
        model: s.model,
        effort: s.effort as ResumableAgent["effort"],
        // Konto mitschreiben: die Claude-Session liegt im `projects/` GENAU dieses Kontos —
        // ohne diese Angabe würde ein Resume nach Neustart im falschen Konto suchen, nichts finden
        // und still frisch starten (= Kontextverlust).
        accountId: s.accountId,
        mock: false,
        // „Mergen & weiterarbeiten"-Absicht mitschreiben — sonst überlebt sie den Neustart nicht und
        // der Stream fällt beim ersten Poll als „erledigt" aus dem Grid.
        suppressedPr: this.suppressedMergedPr.get(s.agentId),
        updatedAt: Date.now(),
      });
    }
    try {
      // NICHT den Pool über die Registry drüberbügeln: passiv wiederhergestellte Kacheln
      // (v.a. der Integrator, der beim Reopen live:false ist → NICHT im Pool) blieben sonst
      // nicht erhalten und „main" verschwindet. mergeRegistry bewahrt sie (siehe persistence.ts).
      const merged = mergeRegistry(loadRegistry(this.project.repoRoot), poolEntries, this.removed, existsSync, (e) =>
        log(
          `[orchestrator] persist: Sub „${e.label}" (${e.agentId}) hat keinen Worktree mehr unter ${e.worktreePath} → aus Registry entfernt ` +
            `(Branch/Transcripts bleiben; Worktree-Discovery bietet ihn beim nächsten Öffnen ggf. erneut an)`,
        ),
      );
      saveRegistry(this.project.repoRoot, merged);
    } catch (e) {
      log(`[orchestrator] persist failed: ${String(e)}`);
    }
  }

  /**
   * Beim Projekt-Öffnen den verwalteten Zustand gegen GitHub abgleichen (P7+).
   *
   * Problem: wird ein Stream auf einem anderen Rechner fertiggestellt & gemergt,
   * bleiben auf diesem Rechner Registry-Eintrag + Worktree stehen — und würden
   * fälschlich als „fortsetzbar/laufend" angeboten. Sauberer Vorgang:
   *
   *  0) `git fetch --prune` — frischer Remote-Stand.
   *  1) main (Haupt-Checkout) sauber & behind → fast-forward auf origin/<default>.
   *  2) Pro Kandidat den **GitHub-PR-Zustand** prüfen — die EINZIG verlässliche
   *     „fertig"-Quelle (squash-merge bricht alle git-lokalen Heuristiken).
   *       • PR gemergt + Worktree sauber + nichts ungepusht → automatisch aufräumen.
   *       • PR gemergt + lokale Reste → NICHT löschen, als „erledigt – prüfen" anbieten.
   *       • sonst (offen / kein PR) → echtes Fortsetzen anbieten.
   *  3) Registry bereinigen, Ergebnis-Summary melden.
   */
  private async offerResumable(repoRoot: string): Promise<void> {
    // `.mads/` selbst-ignorieren, BEVOR wir „dirty" prüfen — sonst blockiert mads'
    // eigener untracked-State den fast-forward von main (genau dieser Bug trat auf).
    ensureMadsDir(repoRoot);
    // Beim ersten Öffnen: lokale, gitignorte Dev-Config ermitteln + `.mads/worktree-seed` anlegen,
    // damit neu erzeugte Streams sofort front-/backend-lauffähig sind. Best effort, generate-if-absent.
    let seedGenerated = 0;
    try {
      const s = ensureWorktreeSeedFile(repoRoot);
      if (s.generated && s.confident > 0) seedGenerated = s.confident;
    } catch (e) {
      log(`[orchestrator] worktree-seed-Erkennung fehlgeschlagen: ${String(e)}`);
    }
    await run("git", ["-C", repoRoot, "fetch", "origin", "--prune"], repoRoot);
    const defaultBranch = this.project?.defaultBranch ?? "main";
    const ff = await fastForwardMain(repoRoot, defaultBranch);
    const mainFastForwarded = ff.ff;

    // Cross-Machine-Härtung: Registry-Subs, deren worktreePath unter einem FREMDEN Home liegt (Repo
    // zwischen zwei Macs kopiert), auf den lokalen Kanon-Pfad umziehen — MUSS vor dem Kandidaten-Loop
    // laufen (der existsSync(worktreePath) prüft) und vor jedem persist, das sie sonst still verwürfe.
    const relocated = await this.relocateForeignWorktrees(repoRoot);

    const registry = loadRegistry(repoRoot);
    const seen = new Set<string>();
    const candidates: RegistryEntry[] = [];

    // 1) Registry-Einträge mit Claude-Session → Kandidaten fürs echte Fortsetzen.
    for (const e of registry) {
      // „Mergen & weiterarbeiten"-Absicht ZUERST wiederherstellen — sie muss stehen, BEVOR unten
      // prStatus läuft, sonst meldet der Poll den gemergten PR erneut und der Stream wird als
      // „erledigt" eingestuft, obwohl der Mensch bewusst weiterarbeiten wollte.
      if (e.suppressedPr) this.suppressedMergedPr.set(e.agentId, e.suppressedPr);
      if (!e.sessionId || this.pool.has(e.agentId)) continue;
      if (e.worktreePath && !existsSync(e.worktreePath)) continue; // Worktree weg → überspringen
      candidates.push(e);
      seen.add(e.agentId);
    }

    // 2) Verwaiste mads-Worktrees (kein Registry-Eintrag mit Session) → frischer Stream
    //    im bestehenden Worktree/Branch, damit nichts liegen bleibt.
    try {
      const reg = new Map(registry.map((e) => [e.agentId, e]));
      for (const wt of await discoverWorktrees(repoRoot)) {
        if (seen.has(wt.agentId) || this.pool.has(wt.agentId)) continue;
        if (wt.branch.startsWith("mads-review/")) continue; // Review-Worktree-Rest → kein Geister-Stream

        const known = reg.get(wt.agentId);
        candidates.push({
          agentId: wt.agentId,
          label: known?.label ?? wt.branch.replace(/^mads\//, "") ?? wt.agentId,
          role: "sub",
          sessionId: known?.sessionId, // i.d.R. undefined → frischer Start im Worktree
          branch: wt.branch,
          worktreePath: wt.path,
          lastPrompt: known?.lastPrompt,
          status: "queued",
          model: known?.model,
          effort: known?.effort,
          mock: false,
          updatedAt: Date.now(),
        });
        seen.add(wt.agentId);
      }
    } catch (e) {
      log(`[orchestrator] Worktree-Discovery fehlgeschlagen: ${String(e)}`);
    }

    // 3) Jeden Kandidaten gegen GitHub einordnen.
    const offer: ResumableAgent[] = [];
    const cleaned: string[] = [];
    const residue: string[] = [];
    const dropped = new Set<string>(); // aufgeräumte agentIds → aus Registry nehmen

    for (const c of candidates) {
      // Ohne Branch/Worktree (z.B. Integrator im Haupt-Checkout) → unverändert anbieten.
      if (!c.branch || !c.worktreePath || !existsSync(c.worktreePath)) {
        offer.push(c);
        continue;
      }
      // `.mads/` auch IM WORKTREE selbst-ignorieren, BEVOR unten „dirty" geprüft wird. Oben passiert das
      // nur für den repoRoot — Worktrees hatten den Schutz nie. Folge: mads' EIGENE Dateien (Paste-
      // Screenshots unter .mads/attachments/) machten den Worktree „schmutzig", worauf ein gemergter
      // Stream als „gemergt MIT lokalen Resten" eingestuft und nur noch zum Aufräumen angeboten wurde —
      // der Nutzer verlor seinen aktiven Stream aus dem Grid. Idempotent; heilt auch Worktrees, die vor
      // dem createWorktree-Fix entstanden sind.
      try {
        ensureMadsDir(c.worktreePath);
      } catch (e) {
        log(`[orchestrator] .mads-Schutz im Worktree ${c.worktreePath} fehlgeschlagen: ${String(e)}`);
      }
      const pr = await prStatus(repoRoot, c.branch).catch(() => null);
      const isDone = pr?.state === "MERGED" || pr?.state === "CLOSED";
      if (!isDone) {
        // Hinweis: ein gh-Timeout liefert pr=null → isDone=false → der Stream wird als
        // fortsetzbar angeboten (fail-open, sicher: NIE Auto-Cleanup bei Unsicherheit).
        offer.push({ ...c, prState: pr?.state, prNumber: pr?.number, prUrl: pr?.url });
        continue;
      }
      const doneWord = pr?.state === "MERGED" ? "gemergt" : "geschlossen";
      // PR erledigt → Sicherheits-Check vor dem Löschen.
      const res = await worktreeResidue(c.worktreePath, c.branch);
      // Commits über main (NEUE, noch nicht gemergte Arbeit): entscheidend, denn ein
      // „Mergen & weiterarbeiten"-Branch wird nach dem Merge auf main zurückgesetzt und läuft
      // dann WEITER — der alte PR ist gemergt, die neuen Commits aber nicht. Solche Streams
      // dürfen NICHT als „erledigt" verbucht werden (sonst Aufräum-Falle für echte Arbeit).
      const db = this.project?.defaultBranch ?? "main";
      const aheadR = await run("git", ["-C", c.worktreePath, "rev-list", "--count", `origin/${db}..HEAD`], c.worktreePath);
      const aheadOfMain = aheadR.code === 0 ? parseInt(aheadR.stdout.trim() || "0", 10) : 0;
      if (aheadOfMain > 0) {
        // Gemergter PR, aber der Branch ist seither weitergelaufen → AKTIVER Stream mit
        // ungemergter Arbeit (normal fortsetzbar), NICHT „erledigt". Kein merged-Flag.
        offer.push({ ...c, prState: pr?.state, prNumber: pr?.number, prUrl: pr?.url });
        log(`[orchestrator] reconcile: ${c.branch} ${doneWord}, aber ${aheadOfMain} neue Commit(s) über ${db} → aktiver Stream (ungemergte Arbeit)`);
      } else if (!res.dirty) {
        // Wir sind im else-Zweig NACH `aheadOfMain > 0`, hier gilt also IMMER aheadOfMain === 0:
        // HEAD ⊆ origin/main → ALLE Commits des Branches sind bereits in main. Ein von
        // worktreeResidue gemeldetes `unpushed > 0` (origin/<branch>..<branch>) ist dann KEIN echter
        // Rest, sondern ein SQUASH-MERGE-ARTEFAKT: nach dem Merge wird der Branch auf main
        // zurückgesetzt; der Squash-Commit steckt in main/HEAD, aber nicht im alten Feature-Branch auf
        // origin → rev-list zählt ihn fälschlich als „unpushed". Solche Streams sind sauber gemergt und
        // sollen NORMAL FORTSETZBAR sein (der Nutzer merged regelmäßig, um weiterzuarbeiten) — NICHT
        // fälschlich als „erledigt mit lokalen Resten" ins Aufräum-Banner (wo sie ohne Kachel
        // „verschwinden"). Nur ein wirklich schmutziger Worktree (uncommittete Änderungen, unten) ist
        // ein echter Rest. FRÜHER wurde hier zudem AUTOMATISCH aufgeräumt — auch das ist weg:
        // Aufräumen ist ausschließlich ein EXPLIZITER Klick. So schließt/versteckt ein Neustart nie einen Stream.
        offer.push({ ...c, prState: pr?.state, prNumber: pr?.number, prUrl: pr?.url, mergedClean: true });
        log(`[orchestrator] reconcile: ${c.branch} ${doneWord} + sauberer Worktree (unpushed=${res.unpushed} = Squash-Artefakt, ignoriert) → als fortsetzbar angeboten`);
      } else {
        // gemergt + WIRKLICH schmutziger Worktree (uncommittete/untrackte Änderungen): der „Rest" ist
        // sehr oft AKTIVE, ungespeicherte Arbeit (nicht Müll — z. B. ein weitergebautes deploy.sh) und
        // darf NICHT aus dem aktiven Grid in die Aufräum-Leiste verschwinden. Darum als AKTIVEN,
        // fortsetzbaren Stream anbieten (localChanges → „Arbeit nicht gesichert"-Flag); Aufräumen bleibt
        // ein EXPLIZITER manueller Schritt (Stop im Inspector). KEIN merged-Flag, KEIN residue.
        offer.push({ ...c, prState: pr?.state, prNumber: pr?.number, prUrl: pr?.url, localChanges: true });
        log(`[orchestrator] reconcile: ${c.branch} ${doneWord}, aber schmutziger Worktree (dirty=${res.dirty}) → aktiver Stream mit ungesicherter Arbeit (nicht Aufräum-Rest)`);
      }
    }

    // 4) Registry um die aufgeräumten Einträge bereinigen.
    if (dropped.size > 0) {
      try {
        saveRegistry(repoRoot, registry.filter((e) => !dropped.has(e.agentId)));
      } catch (e) {
        log(`[orchestrator] Registry-Bereinigung fehlgeschlagen: ${String(e)}`);
      }
    }

    // 5) Ergebnis melden — inkl. „main hängt zurück, konnte aber nicht automatisch
    //    vorgezogen werden" (sonst arbeitet der Integrator still gegen veralteten Stand).
    const mainBehind = ff.blocked ? ff.behind : 0;
    const mainBlocked = ff.blocked;
    if (offer.length > 0) this.emit({ ...envelope(), type: "resumable_agents", agents: offer });
    if (mainFastForwarded > 0 || mainBehind > 0 || cleaned.length > 0 || residue.length > 0 || seedGenerated > 0 || relocated.length > 0) {
      this.emit({ ...envelope(), type: "reconcile_summary", mainFastForwarded, mainBehind, mainBlocked, cleaned, residue, seedGenerated, relocated });
    }
    log(`[orchestrator] reconcile: ff=${mainFastForwarded} behind=${mainBehind} blocked=${mainBlocked ?? "-"} cleaned=${cleaned.length} residue=${residue.length} offer=${offer.length} seed=${seedGenerated} relocated=${relocated.length}`);
    await this.hydrateReviewStreams(); // persistierte Review-Streams (fremde PRs) als Kacheln wiederherstellen
  }

  /**
   * Cross-Machine-Härtung: Registry-Einträge, deren `worktreePath` unter einem FREMDEN Home liegt
   * (das Repo wurde zwischen zwei Macs mit verschiedenen Home-Verzeichnissen kopiert — /Users/amedici
   * ↔ /Users/alessandromedici), auf den lokalen Kanon-Pfad umziehen, STATT sie später still zu
   * verlieren. Ohne das griff die Kette: fremder Pfad → existsSync(false) → aus Kandidaten UND (beim
   * nächsten persist) aus der Registry gefallen → „branch mads/<name> already exists" beim Neuanlegen.
   * Branch (`mads/<name>` bzw. `mads-review/pr-<#>`) und Transcripts (per agentId) wurden mitkopiert
   * und sind intakt; nur der Worktree fehlt lokal und wird aus dem Branch neu ausgecheckt. Der
   * aktualisierte `worktreePath` wird zurück in die Registry geschrieben. Liefert die Labels der
   * umgezogenen Streams (für die Reconcile-Summary/Banner).
   */
  private async relocateForeignWorktrees(repoRoot: string): Promise<string[]> {
    const registry = loadRegistry(repoRoot);
    const foreign = registry.filter((e) => e.worktreePath && isForeignMadsWorktree(e.worktreePath, repoRoot, e.agentId));
    if (foreign.length === 0) return []; // Normalfall: nichts Fremdes → keine git-Operationen
    const relocated: string[] = [];
    let changed = false;
    for (const e of foreign) {
      // Branch ableiten: Sub → e.branch; persistierter Review-Stream → mads-review/pr-<#>.
      const branch = e.branch ?? (e.reviewPr != null ? `mads-review/pr-${e.reviewPr}` : undefined);
      if (!branch) {
        log(`[orchestrator] relocate: „${e.label}" (${e.agentId}) hat fremden Worktree-Pfad, aber keinen Branch → übersprungen`);
        continue;
      }
      const res = await relocateWorktree(repoRoot, e.agentId, branch);
      if (res.ok) {
        log(
          `[orchestrator] relocate: „${e.label}" (${e.agentId}) ${e.worktreePath} → ${res.path} ` +
            `(${res.recreated ? "aus Branch neu ausgecheckt" : "lokal vorhanden, Admin-Link repariert"})`,
        );
        e.worktreePath = res.path; // mutiert den frisch geladenen Registry-Eintrag → unten persistiert
        changed = true;
        relocated.push(e.label);
      } else {
        log(`[orchestrator] relocate: „${e.label}" (${e.agentId}) konnte nicht umgezogen werden: ${res.error}`);
      }
    }
    if (changed) {
      try {
        saveRegistry(repoRoot, registry);
      } catch (err) {
        log(`[orchestrator] relocate: Registry-Update fehlgeschlagen: ${String(err)}`);
      }
    }
    return relocated;
  }

  // ---------------------------------------------------------------- Polling
  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.pollAll(), POLL_INTERVAL_MS);
  }

  /**
   * Ereignisgetriebener Poll: wird aufgerufen, wenn ein Stream seinen Status wechselt (Turn-Ende,
   * Fehler, Freigabe erteilt). Statt bis zu einem vollen Intervall zu warten, reagiert der
   * Orchestrator so binnen ~1 s — das ist der eigentliche Tempo-Gewinn; der Timer bleibt nur das
   * Sicherheitsnetz für Zustandsänderungen ohne Ereignis (z. B. Remote-Pushes).
   * Debounced (ein Turn-Ende erzeugt mehrere Statuswechsel) und re-armt sich, falls gerade ein
   * Zyklus läuft — `pollAll()` würde sonst wegen des `polling`-Guards einfach verpuffen.
   */
  private schedulePollSoon(delayMs: number = POLL_SOON_MS): void {
    if (this.pollSoonTimer || !this.project) return;
    this.pollSoonTimer = setTimeout(() => {
      this.pollSoonTimer = undefined;
      if (this.polling) {
        this.schedulePollSoon(1_500); // Zyklus läuft → gleich noch einmal versuchen
        return;
      }
      void this.pollAll();
    }, delayMs);
  }

  private async pollAll(): Promise<void> {
    if (!this.project || this.polling) return; // nie zwei Zyklen parallel (Push-/Rebase-Race)
    this.polling = true;
    try {
      // einmal pro Zyklus fetchen, dann pro Agent rev-list (spart Netz).
      await run("git", ["-C", this.project.repoRoot, "fetch", "origin"], this.project.repoRoot);
      for (const s of this.pool.values()) await this.pollAgent(s, true);
      await this.pollPassiveIntegrator(); // C: auch der NICHT fortgesetzte Integrator braucht git-Status
      await this.pollIncomingPrs(); // eingehende fremde PRs → Review-Angebot
      if (this.autonomy.autoSync) await this.autoSyncPass();
      await this.autopilotPass();
      if (this.autonomy.collisionScan) await this.collisionPass();
    } finally {
      this.polling = false;
    }
  }

  /**
   * C: Passiver Integrator (nach App-Neustart `live:false` → NICHT im Sidecar-Pool) wurde nie
   * gepollt → sein dirty-Zustand blieb unbekannt und der „In Sub-Stream auslagern"-Knopf
   * erschien erst, nachdem der Mensch „Fortsetzen" drückte. Deshalb: gibt es KEINEN Integrator
   * im Pool, den Registry-Eintrag heranziehen und den Haupt-Checkout direkt pollen.
   * KEINE Eskalation aus diesem Pfad (es läuft keine Session) — nur der reine git_status.
   */
  private async pollPassiveIntegrator(): Promise<void> {
    if (!this.project) return;
    for (const s of this.pool.values()) if (s.role === "integrator") return; // aktiver Integrator pollt sich selbst
    const entry = loadRegistry(this.project.repoRoot).find((e) => e.role === "integrator");
    if (!entry) return;
    // IDENTITÄT des passiven Integrators an ALLE Clients (v. a. Remote): ohne dies kennt der Remote ihn
    // nur aus diesem git_status-Poll — der trägt WEDER Label NOCH Rolle → der Remote zeigt die rohe
    // agentId als „Namen" und (weil git_status keinen Status setzt) den Default „starting" (grün). Ein
    // status_update mit Label + Rolle + zuletzt persistiertem Status (z. B. „done") stellt ihn korrekt
    // dar. Idempotent; der Desktop-Store patcht nur Label/Status (nie `live`), bleibt also passiv.
    this.emit({ ...envelope(), type: "status_update", agentId: entry.agentId, status: entry.status, label: entry.label, role: entry.role });
    try {
      const st = await gitStatus(this.project.repoRoot, this.project.repoRoot, this.project.defaultBranch, this.project.defaultBranch, true);
      if (!st.unreliable) this.emitGitStatus(entry.agentId, st); // B3: nie einen git-Fehler als „clean" verkaufen
    } catch (e) {
      log(`[orchestrator] poll passiver Integrator fehlgeschlagen: ${String(e)}`);
    }
  }

  /**
   * Autopilot (Phase 2): automatisiert die REVERSIBLE Seite je Sub-Stream gemäß seiner Stufe
   * (assisted/autopilot) — committen → pushen → PR. EINE Aktion pro Zyklus & Stream, nur wenn
   * der Stream ruhig ist (nicht laufend, keine Permission-Rückfrage, kein Sync-Konflikt).
   * Irreversibles (Merge/Force/Aufräumen) bleibt menschlich. Secret-gescannt (fail-closed).
   */
  private async autopilotPass(): Promise<void> {
    if (!this.project) return;
    for (const s of this.pool.values()) {
      if (s.role !== "sub" || !s.worktreePath || !s.branch) continue;
      // B2: aufgeräumte Streams (Worktree weg) überspringen — der Autopilot darf keine
      // Aktionen (commit/push/PR) gegen einen nicht mehr existierenden Worktree anstoßen.
      if (this.removed.has(s.agentId) || !existsSync(s.worktreePath)) continue;
      // Läuft doIntegrate() gerade für diesen Stream (Merge + Cleanup), NICHT parallel drauf
      // pushen — der Worktree kann währenddessen jederzeit verschwinden (push_rejected-Race).
      if (this.integrating.has(s.agentId)) continue;
      const st = this.gitState.get(s.agentId);
      // B3: unreliable-Status = git-Fehler → daraus keine Autopilot-Entscheidung ableiten.
      if (!st || st.unreliable) continue;
      const prOpen = s.lastPr?.state === "OPEN";
      const unpushed = prOpen ? await unpushedCount(s.worktreePath, s.branch) : 0;
      const { action } = autopilotDecision({
        level: s.autopilot,
        role: "sub",
        status: s.status,
        dirty: st.dirty,
        ahead: st.ahead,
        unpushed,
        hasPr: !!s.lastPr,
        prOpen,
        syncBlocked: this.autoSyncConflicted.has(s.agentId),
        busyPermission: s.hasPending(),
        secretBlocked: false, // der echte Secret-Gate sitzt in autoCommit (re-scannt jeden Zyklus)
      });
      if (action === "none") continue;
      try {
        if (action === "commit") {
          // FREMD-EDIT-SCHUTZ: hat sich der Worktree seit dem Turn-Ende des Agenten geändert, kam
          // etwas von aussen dazu (Mensch/anderer Prozess editiert im Worktree). Dann NICHT blind
          // `git add -A` — sonst mischt der Autopilot Fremd-Edits in seinen Checkpoint (realer Vorfall).
          // Anhalten + einmal warnen; der Mensch committet dann bewusst manuell (oder entfernt den Edit).
          // Läuft in diesem Worktree ein Dev-Server, verändert er legitim Dateien (Build-Output,
          // Hot-Reload-Artefakte) — das würde den Fremd-Edit-Guard fälschlich auslösen. Solange der
          // Nutzer testet, gar nicht auto-committen (wie syncOne den Auto-Rebase aufschiebt). Einmal
          // je Dev-Server-Sitzung erklären, sonst wirkt das ausbleibende Auto-Commit rätselhaft.
          if (this.devServer?.agentId === s.agentId) {
            if (!this.autopilotDevserverDeferred.has(s.agentId)) {
              this.autopilotDevserverDeferred.add(s.agentId);
              this.emit({
                ...envelope(),
                type: "agent_event",
                agentId: s.agentId,
                event: {
                  kind: "assistant_text",
                  text: "⏸ Auto-Commit pausiert, solange der Dev-Server dieses Streams läuft (er verändert beim Testen legitim Dateien). Stoppe den Dev-Server → Auto-Commit läuft weiter, oder committe jetzt mit „Committen“.",
                },
              });
            }
            continue;
          }
          this.autopilotDevserverDeferred.delete(s.agentId); // Dev-Server nicht (mehr) aktiv → Hinweis wieder scharf
          if (s.turnFingerprint) {
            const cur = await worktreeFingerprint(s.worktreePath);
            if (cur !== s.turnFingerprint) {
              if (!this.foreignEditNotified.has(s.agentId)) {
                this.foreignEditNotified.add(s.agentId);
                const changed = (await run("git", ["-C", s.worktreePath, "status", "--porcelain"], s.worktreePath)).stdout.trim();
                this.emitError(
                  s.agentId,
                  "foreign_edit",
                  "Autopilot pausiert (Fremd-Edit): der Worktree hat sich geändert, seit der Agent seinen Turn " +
                    "beendet hat — vermutlich hat jemand/etwas hier editiert. mads committet NICHT automatisch, um " +
                    "keine fremde Arbeit in den Checkpoint zu mischen. Bitte prüfen und bewusst manuell committen. " +
                    (changed ? `\nGeänderte Dateien:\n${changed}` : ""),
                );
              }
              continue; // diesen Zyklus nicht committen
            }
          }
          this.foreignEditNotified.delete(s.agentId);
          const res = await autoCommit(s.worktreePath, `chore(autopilot): checkpoint — ${s.label ?? s.branch}`);
          if (res.secrets?.length) {
            if (!this.autopilotSecretNotified.has(s.agentId)) {
              this.autopilotSecretNotified.add(s.agentId);
              const kinds = [...new Set(res.secrets.map((h) => h.kind))].join(", ");
              this.emitError(
                s.agentId,
                "secret_detected",
                `Autopilot: Commit gestoppt — mögliches Secret im Worktree (${kinds}). Entferne es; danach committet der Autopilot automatisch weiter.`,
              );
            }
            continue;
          }
          this.autopilotSecretNotified.delete(s.agentId);
          if (res.ok) {
            // Post-Commit-Zustand als neue „agent-authored"-Basis merken (der Worktree ist jetzt
            // sauber/rest-committet) — sonst würde der nächste Zyklus die gerade committeten
            // Änderungen fälschlich als Fremd-Edit sehen.
            s.turnFingerprint = await worktreeFingerprint(s.worktreePath);
            const skipNote = res.skipped?.length
              ? ` (nicht versioniert, übersprungen: ${res.skipped.slice(0, 4).join(", ")}${res.skipped.length > 4 ? " …" : ""})`
              : "";
            this.emit({
              ...envelope(),
              type: "agent_event",
              agentId: s.agentId,
              event: { kind: "assistant_text", text: `↻ Autopilot: Arbeit lokal committet.${skipNote}` },
            });
            await this.pollAgent(s, true);
          }
        } else if (action === "push") {
          const tres = await this.ownershipGate(s.agentId);
          if (tres.length) {
            this.emitError(s.agentId, "ownership_trespass", `Autopilot-Push gestoppt — Überschneidung: ${this.trespassReason(tres)}.`);
            continue;
          }
          const r = await pushBranch(s.worktreePath, s.branch, this.project.defaultBranch);
          if (r.ok) await this.pollAgent(s, true);
          else this.emitError(s.agentId, r.kind, `Autopilot-Push gestoppt: ${r.error}`);
        } else if (action === "create_pr") {
          if (this.autopilotPrTried.get(s.agentId) === st.ahead) continue; // diesen Stand schon versucht
          this.autopilotPrTried.set(s.agentId, st.ahead);
          await this.handleCreatePr(s.agentId); // Gate + push + PR; bei rotem Gate kein PR
          await this.pollAgent(s, true);
        }
      } catch (e) {
        log(`[orchestrator] autopilot ${s.agentId} (${action}) failed: ${String(e)}`);
      } finally {
        // „EINE Aktion pro Zyklus & Stream" bleibt bewusst bestehen (der Zustand soll sich zwischen
        // commit → push → PR setzen). Aber die WARTEZEIT dazwischen muss nicht ein voller Takt sein:
        // eine ausgeführte Aktion ändert selbst keinen Agenten-Status, löste also bisher kein Ereignis
        // aus — die Kette brauchte 3 volle Intervalle. Jetzt zieht sie sich selbst weiter.
        this.schedulePollSoon();
      }
    }
  }

  /**
   * Nach „Mergen & weiterarbeiten" den Stream-Worktree auf das frische `main` bringen — OHNE Arbeit zu
   * vernichten. Früher lief hier bedingungslos `git reset --hard origin/<base>`, in der Annahme, die
   * Arbeit liege ja als Squash in main. Der Autopilot committet aber WEITER, während der Merge läuft —
   * belegt im Reflog eines echten Streams: Commit 09:41:20 → reset 09:41:41 → zwei Commits vernichtet
   * (der Nutzer musste die Änderungen neu bauen). Deshalb jetzt gestaffelt, verlustfrei:
   *   1. Uncommittete Arbeit im Worktree → NICHT anfassen, eskalieren (erst sichern, dann syncen).
   *   2. Branch hat noch Inhalt über main hinaus → REBASE darauf (erhält alles; das ist zugleich die
   *      automatische Auflösung, wenn zwei Streams nacheinander mergen). Konflikt → abbrechen +
   *      eskalieren, Arbeit bleibt unangetastet.
   *   3. Sonst (inhaltlich deckungsgleich — der Normalfall direkt nach dem Squash) → reset --hard.
   * Liefert true, wenn der Worktree danach sauber auf dem neuen main sitzt.
   */
  private async resyncAfterMerge(agentId: string, worktree: string, base: string): Promise<boolean> {
    const dirty = (await run("git", ["-C", worktree, "status", "--porcelain"], worktree)).stdout.trim();
    if (dirty) {
      this.emitError(
        agentId,
        "stale_base",
        "Nach dem Merge liegt in diesem Stream noch UNCOMMITTETE Arbeit — mads hat ihn deshalb NICHT auf main " +
          "zurückgesetzt (das würde die Arbeit vernichten). Bitte committen oder auslagern; danach synchronisiert mads.",
      );
      return false;
    }
    // Inhaltlicher Vergleich statt Commit-Zählung: nach einem SQUASH-Merge sind die Branch-Commits keine
    // Vorfahren von main, ihr INHALT aber schon → leerer Diff heißt „alles drin, Reset gefahrlos".
    const extra = await run("git", ["-C", worktree, "diff", "--quiet", `origin/${base}`, "HEAD"], worktree);
    if (extra.code !== 0) {
      // Es liegt Arbeit über main hinaus (typisch: der Autopilot hat während des Merges weiter committet,
      // oder main ist inzwischen weitergelaufen). NIEMALS wegwerfen → auf das neue main rebasen.
      const rb = await run("git", ["-C", worktree, "rebase", `origin/${base}`], worktree);
      if (rb.code !== 0) {
        await run("git", ["-C", worktree, "rebase", "--abort"], worktree); // definierter Zustand für die Auflösung
        this.emitError(
          agentId,
          "merge_conflict",
          "Nach dem Merge kollidiert die noch offene Arbeit dieses Streams mit dem neuen main — bitte „Konflikt lösen“. " +
            "Es wurde NICHTS zurückgesetzt, die Arbeit ist unangetastet.",
        );
        return false;
      }
      log(`[orchestrator] ${agentId}: Rest-Arbeit auf origin/${base} rebased statt verworfen`);
      return true;
    }
    const reset = await run("git", ["-C", worktree, "reset", "--hard", `origin/${base}`], worktree);
    return reset.code === 0;
  }

  private async pollAgent(s: AgentSession, skipFetch = false): Promise<void> {
    if (!this.project || !s.repoRoot) return;
    // Bereits aufgeräumte Streams (gemergt+entfernt) NICHT weiterpollen — sonst schlägt gitStatus()
    // gegen den (bewusst entfernten) Worktree-Pfad fehl und löst nach 5 Fehlversuchen fälschlich die
    // „Worktree beschädigt oder extern entfernt?"-Warnung aus, obwohl mads ihn selbst aufgeräumt hat.
    if (this.removed.has(s.agentId)) return;
    const defaultBranch = this.project.defaultBranch;
    try {
      // Integrator (G1): kein Worktree/Branch — er sitzt im Haupt-Checkout auf
      // <default>. Trotzdem dessen Drift gegen origin/<default> überwachen, sonst
      // merkt der Nutzer nie, dass seine Basis veraltet ist (kein PR für main).
      if (s.role === "integrator") {
        const status = await gitStatus(s.repoRoot, s.repoRoot, defaultBranch, defaultBranch, skipFetch);
        // B3 gilt auch hier — GERADE hier: im Deploy-Fenster laufen git-Befehle im Haupt-Checkout
        // (index.lock-Kontention). Ein Fehler-Status {dirty:false} würde deployDirty im Frontend
        // löschen und mainDirtyNotified resetten → Flackern + doppelte Eskalation beim nächsten Poll.
        if (status.unreliable) {
          log(`[orchestrator] poll ${s.agentId} (integrator): git-Status unzuverlässig → letzter guter Stand bleibt`);
          return;
        }
        this.gitState.set(s.agentId, status);
        // Proaktiv: direkte Edits am main-Checkout erkennen und EINMAL je Episode darauf hinweisen
        // (main ändert sich nur über grüne PR-Merges → in Sub-Stream auslagern). Status-neutral.
        if (status.dirty && !this.mainDirtyNotified.has(s.agentId)) {
          this.mainDirtyNotified.add(s.agentId);
          // Deploy-Rahmung, wenn (a) ein Deploy-Befehl lief ODER (b) die Dirt wie ein Versions-Bump aussieht.
          // (b) ist projekt-agnostisch aus dem Diff abgeleitet → fängt auch `npm version`/`make deploy`, die
          // keinen als Deploy erkennbaren Befehlsnamen haben (Review-Fund).
          const isDeploy = s.deployedRecently() || (await detectMainVersionBump(s.repoRoot)) !== undefined;
          if (isDeploy) {
            // main-Dirt stammt aus einem Deploy/Versions-Bump → kein Fehl-Edit-Alarm, sondern Angebot
            // „Als Release committen" (Push bleibt separat/explizit). D: EHRLICHES Wording — die
            // Erkennung stempelt beim Befehls-START, der Build kann noch laufen. Also nie
            // „abgeschlossen" behaupten, nur was sicher ist: erkannt + Bump liegt uncommittet.
            this.emitError(
              s.agentId,
              "main_deploy_dirty",
              "Deploy erkannt — der Versions-Bump liegt uncommittet auf main. „Als Release committen“ (chore(release)) " +
                "oder in einen Sub-Stream auslagern.",
            );
          } else {
            this.emitError(
              s.agentId,
              "main_edited",
              "Du hast den main-Checkout direkt geändert. main bleibt nur über grün-getestete PR-Merges aktuell — " +
                "lager die Änderungen aus: Main-Stream wählen → „In Sub-Stream auslagern“.",
            );
          }
        } else if (!status.dirty) {
          this.mainDirtyNotified.delete(s.agentId);
        }
        this.emitGitStatus(s.agentId, status);
        return;
      }
      if (!s.branch || !s.worktreePath) return; // Sub ohne Worktree → nichts zu pollen
      const status = await gitStatus(s.repoRoot, s.worktreePath, s.branch, defaultBranch, skipFetch);
      // B3: git-Fehler (Worktree/Ref weg, Timeout) → der Status ist eine Fata Morgana aus
      // Nullen. NICHT den letzten guten Stand überschreiben/emitten — sonst kippt das UI
      // fälschlich auf „clean/erledigt" und Autopilot/Sync entscheiden auf falscher Basis.
      if (status.unreliable) {
        log(`[orchestrator] poll ${s.agentId}: git-Status unzuverlässig (git-Fehler) → letzter guter Stand bleibt`);
        // Dauerhaft unlesbar (Worktree beschädigt/extern entfernt?) → EINMAL sichtbar machen,
        // statt die Kachel still auf dem letzten guten Stand einfrieren zu lassen.
        const n = (this.unreliablePolls.get(s.agentId) ?? 0) + 1;
        this.unreliablePolls.set(s.agentId, n);
        if (n === 5) {
          this.emit({
            ...envelope(),
            type: "agent_event",
            agentId: s.agentId,
            event: {
              kind: "assistant_text",
              text: "⚠ Der git-Status dieses Streams ist seit mehreren Minuten nicht ermittelbar (Worktree beschädigt oder extern entfernt?). Die Kachel zeigt den letzten bekannten Stand.",
            },
          });
        }
        return;
      }
      this.unreliablePolls.delete(s.agentId);
      this.gitState.set(s.agentId, status);
      // 3.4: Hat der Branch wieder aufgeholt (behind=0), ist ein zuvor pausierter Sync-Konflikt
      // gelöst (manuell oder vom Agenten rebaset) → Auto-Sync-Pause aufheben (Flag clearen).
      // ABER: eine PUSH-Rejection in syncOne() (Rebase onto main gelang, nur der anschließende
      // force-with-lease-Push zum EIGENEN origin/<branch> scheiterte — z. B. „stale info" durch
      // einen doppelt erzeugten Checkpoint) macht behind schon durch den Rebase-Schritt selbst 0,
      // OHNE dass je gepusht wurde. Reines behind===0 löschte das syncBlocked-Flag dann sofort im
      // nächsten Poll — der Sync-Button (Inspector: `behind>0 || syncBlocked`) verschwindet, obwohl
      // der Branch weiter ungepusht/divergiert bleibt und die Eskalation unverändert im Verlauf
      // steht (realer Vorfall: „Zähler Handling"). Zusätzlich prüfen, ob der Branch gegenüber
      // seinem EIGENEN origin/<branch> synchron ist — fail-closed (Flag bleibt bei Unsicherheit).
      if (status.behind === 0 && this.autoSyncConflicted.has(s.agentId)) {
        const up = await run("git", ["-C", s.worktreePath, "rev-list", "--count", `origin/${s.branch}..${s.branch}`], s.worktreePath);
        if (up.code === 0 && parseInt(up.stdout.trim() || "0", 10) === 0) this.autoSyncConflicted.delete(s.agentId);
      }
      this.emitGitStatus(s.agentId, status);
      const pr = await prStatus(s.repoRoot, s.branch);
      const suppressed = this.suppressedMergedPr.get(s.agentId);
      // Nach „Mergen & weiterarbeiten": den gemergten Alt-PR ignorieren, bis ein NEUER
      // (offener) PR aufgeht. `s.lastPr` spiegelt den Autopilot-relevanten PR-Zustand.
      if (pr && suppressed !== undefined && pr.number === suppressed && pr.state !== "OPEN") {
        s.lastPr = undefined;
      } else if (pr) {
        if (pr.number !== suppressed) this.suppressedMergedPr.delete(s.agentId);
        s.lastPr = pr;
        this.emit({ ...envelope(), type: "pr_update", agentId: s.agentId, pr });
      } else {
        s.lastPr = undefined;
      }
    } catch (e) {
      log(`[orchestrator] poll ${s.agentId} failed:`, String(e));
    }
  }

  /** Auto-Sync: idle, saubere Sub-Branches, die hinter origin/<default> liegen, automatisch rebasen. */
  private async autoSyncPass(): Promise<void> {
    if (!this.project) return;
    for (const s of this.pool.values()) await this.syncOne(s);
  }

  /** Einen sauberen, zurückliegenden Sub-Branch onto origin/<default> rebasen (force-with-lease).
   *  Konflikt → an den Menschen eskalieren + Auto-Sync pausieren (autoSyncConflicted). */
  private async syncOne(s: AgentSession): Promise<void> {
    if (!this.project || s.role !== "sub" || !s.worktreePath || !s.branch) return;
    if (s.status === "running") return; // nicht unter laufender Arbeit rebasen
    // Läuft in diesem Worktree ein Dev-Server, den Auto-Rebase AUFSCHIEBEN — sonst schreibt der
    // rebase/force die Dateien um, während der Server sie ausliefert. Nach dem Stoppen zieht der
    // nächste Poll nach. (Der Nutzer testet bewusst einen stabilen Stand.)
    if (this.devServer?.agentId === s.agentId) return;
    if (this.syncing.has(s.agentId) || this.autoSyncConflicted.has(s.agentId)) return;
    // Aufgeräumt/Worktree weg → nie syncBranch gegen einen toten Pfad starten: der gecachte
    // Status ist dann der LETZTE GUTE (z. B. behind>0) und würde hier eine Falsch-Eskalation
    // „Auto-Sync gestoppt" erzeugen, die sich nie auflöst (Review-Befund 2).
    if (this.removed.has(s.agentId) || !existsSync(s.worktreePath)) return;
    const st = this.gitState.get(s.agentId);
    // B3: unreliable = git-Fehler → kein Rebase auf Basis eines möglicherweise falschen Status.
    if (!st || st.unreliable || st.behind <= 0 || st.dirty) return; // nur saubere, zurückliegende Branches
    this.syncing.add(s.agentId);
    const res = await syncBranch(s.worktreePath, s.branch, this.project.defaultBranch);
    this.syncing.delete(s.agentId);
    if (res.ok) {
      this.emit({
        ...envelope(),
        type: "agent_event",
        agentId: s.agentId,
        event: {
          kind: "assistant_text",
          text: `↻ Auto-Sync: rebaset onto origin/${this.project.defaultBranch} (war ${st.behind} behind).`,
        },
      });
      if (res.renamedAdrs?.length) this.emitAdrRenamed(s.agentId, res.renamedAdrs);
      await this.pollAgent(s, true);
    } else {
      this.autoSyncConflicted.add(s.agentId);
      this.emitError(s.agentId, res.kind, `Auto-Sync gestoppt (manuell „Sync" nötig): ${res.error}`);
    }
  }

  /**
   * 3.1: Nach einem Merge nach origin/<default> ALLE anderen sauberen Sub-Branches SOFORT
   * nachziehen (statt bis zum nächsten 25s-Poll zu warten) — das Drift-Fenster, das die
   * meisten Rebase-Konflikte erzeugt, schrumpft auf ~0. Jeder andere Stream wird frisch
   * gepollt (neuer behind-Stand), dann rebaset. Dirty/Konflikt → wie beim Auto-Sync behandelt.
   */
  private async rebaseOthersOnMain(exceptAgentId: string): Promise<void> {
    if (!this.project) return;
    for (const s of this.pool.values()) {
      if (s.agentId === exceptAgentId || s.role !== "sub" || !s.worktreePath || !s.branch) continue;
      await this.pollAgent(s); // frischer behind-Stand (origin/main hat sich gerade bewegt)
      await this.syncOne(s);
    }
  }

  /** Geänderte Regionen eines Sub-Streams vs origin/<default> (für Kollision + Ownership). */
  private async streamRegions(s: AgentSession): Promise<ChangedRegion[]> {
    if (!this.project || s.role !== "sub" || !s.worktreePath) return [];
    try {
      const diff = await run(
        "git",
        ["-C", s.worktreePath, "diff", "--merge-base", `origin/${this.project.defaultBranch}`, "--unified=0"],
        s.worktreePath,
      );
      return parseDiffRegions(diff.stdout);
    } catch {
      return [];
    }
  }

  /** Kollisions-Scan: paarweiser Region-Overlap der aktiven Sub-Agenten. */
  private async collisionPass(): Promise<void> {
    if (!this.project) return;
    const agentsRegions: AgentRegions[] = [];
    for (const s of this.pool.values()) {
      if (s.role !== "sub" || !s.worktreePath || s.status === "done") continue;
      const regions = await this.streamRegions(s);
      if (regions.length) agentsRegions.push({ agentId: s.agentId, label: s.label ?? s.agentId, regions });
    }
    this.emit({ ...envelope(), type: "collision_warning", collisions: detectCollisions(agentsRegions) });
  }

  /**
   * Ownership-Durchsetzung (3.6, „first-come-owns"): ein Stream darf keine Region/geteilte
   * Datei pushen, die ein FRÜHER gestarteter Stream (Pool-Reihenfolge = deterministisch →
   * deadlock-frei) bereits bearbeitet — symbol-genau via detectTrespass (gleiche Datei +
   * andere Symbole = erlaubt). Plus land_first für geteilte Lockfiles. Liefert die Verstöße
   * (leer = frei zu pushen). Whole-File-Ownership (Symbole unbekannt) wird NICHT erzwungen
   * (vermeidet Über-Blockaden z. B. bei Doku); nur symbol-genau + land_first.
   */
  /**
   * LIVE-Zusammenfassung der AKTIVEN Streams für den Agent-System-Prompt (Härtung gegen Fehl-Routing
   * an geschlossene „Phantom-Streams"): Der Agent lehnte Arbeit ab „gehört zu Stream X", obwohl X
   * längst gemergt+geschlossen war. Mit dieser Live-Liste sieht er die Grundwahrheit — nur was hier
   * steht, kann überhaupt etwas besitzen. Wird beim Start jeder Session einmal abgefragt.
   */
  private activeStreamsSummary(selfId: string): string {
    const integ = [...this.pool.values()].find((s) => s.role === "integrator");
    const subs = [...this.pool.values()].filter((s) => s.role === "sub" && s.status !== "done" && s.branch);
    const lines = subs.map(
      (s) => `  - ${s.label ?? s.branch} (Branch ${s.branch})${s.agentId === selfId ? " ← DAS BIST DU" : ""}`,
    );
    return (
      "\nAktuell AKTIVE Streams (NUR diese können etwas besitzen — alle anderen sind geschlossen):\n" +
      (integ ? `  - ${integ.label ?? "Main-Agent"} (Integrator, main-Checkout)\n` : "") +
      (lines.length ? lines.join("\n") + "\n" : "  (keine weiteren Sub-Streams aktiv)\n")
    );
  }

  private async ownershipGate(agentId: string): Promise<TrespassFinding[]> {
    if (!this.project) return [];
    const ids = [...this.pool.keys()];
    const idx = ids.indexOf(agentId);
    if (idx < 0) return [];
    const me = this.pool.get(agentId);
    if (!me || me.role !== "sub" || !me.worktreePath) return [];
    const myRegions = await this.streamRegions(me);
    if (myRegions.length === 0) return [];
    const rules: OwnershipRule[] = [];
    for (let i = 0; i < idx; i++) {
      // nur FRÜHERE Streams besitzen (deterministische Reihenfolge → kein Deadlock)
      const o = this.pool.get(ids[i]);
      if (!o || o.role !== "sub" || !o.worktreePath || o.status === "done") continue;
      const oRegions = await this.streamRegions(o);
      for (const r of oRegions) {
        if (r.symbols.length) {
          rules.push({ id: `own-${o.agentId}-${r.path}`, path: r.path, symbols: r.symbols, ownerAgentId: o.agentId, ownerBranch: o.branch, kind: "exclusive", note: o.label ?? o.agentId });
        }
        if (SHARED_LANDFIRST_GLOBS.some((g) => pathMatches(r.path, g))) {
          rules.push({ id: `lf-${r.path}`, path: r.path, ownerAgentId: o.agentId, ownerBranch: o.branch, kind: "land_first", note: o.label ?? o.agentId });
        }
      }
    }
    return detectTrespass(myRegions, rules, agentId);
  }

  /** Trespass-Findings → menschenlesbare Begründung (für die Eskalation). */
  private trespassReason(findings: TrespassFinding[]): string {
    return findings
      .map((f) =>
        f.reason === "land_first"
          ? `geteilte Datei ${f.path} (auch von „${f.rule.note}“ bearbeitet) → land-first: einer landet zuerst`
          : `${f.path}${f.matchedSymbol ? ` (${f.matchedSymbol})` : ""} gehört Stream „${f.rule.note}“`,
      )
      .join("; ");
  }

  private emitError(agentId: string, code: EscalationKind, message: string): void {
    this.emit({ ...envelope(), type: "error", agentId, scope: "agent", code, message, recoverable: true });
  }
  /** git_status emittieren + den (orchestrator-eigenen) syncBlocked-Zustand mitliefern. */
  private emitGitStatus(agentId: string, st: { behind: number; ahead: number; dirty: boolean }): void {
    // Explizit destrukturieren statt spreaden: ein GitStatusResult trägt ggf. `unreliable`,
    // das nicht im Protokoll (GitStatusMsg) definiert ist — strengere Decoder (mads-remote)
    // dürfen nie unbekannte Felder auf dem Draht sehen.
    const { behind, ahead, dirty } = st;
    this.emit({ ...envelope(), type: "git_status", agentId, behind, ahead, dirty, syncBlocked: this.autoSyncConflicted.has(agentId) });
  }
  private emit(obj: unknown): void {
    void send(obj);
  }

  // ------------------------------------------------------- Claude-Konten
  /** Aktuellen Kontenzustand ans Frontend spiegeln (Registry ist die Wahrheit, nicht das UI). */
  private emitAccounts(): void {
    const state = pruneCooldowns(loadAccounts());
    this.emit({ ...envelope(), type: "accounts_update", accounts: state });
  }

  /**
   * Konto wechseln. Ohne `agentId` nur das Default-Konto für NEUE Streams.
   *
   * Mit `agentId`: der laufende Claude-Prozess muss neu gestartet werden — `CLAUDE_CONFIG_DIR` wird
   * beim Spawn gesetzt und ist danach unveränderlich. Damit dabei kein Kontext verloren geht, wird
   * dieselbe Session per `resumeSessionId` im selben Worktree fortgesetzt.
   */
  private async setAccount(accountId: string, agentId?: string): Promise<void> {
    const state = loadAccounts();
    const target = state.profiles.find((p) => p.id === accountId);
    if (!target) {
      // Früher nur ein stderr-Log. Das Frontend hatte seine Auswahl da längst optimistisch
      // übernommen und behielt sie — die Anzeige log dauerhaft. Jeder Zweig, der den Wechsel
      // NICHT ausführt, muss das sichtbar sagen.
      log(`[orchestrator] set_account: unbekanntes Konto "${accountId}" — ignoriert`);
      if (agentId) {
        this.emit({
          ...envelope(),
          type: "error",
          agentId,
          scope: "agent",
          code: "account_switch_failed",
          message: `Kontowechsel nicht möglich: unbekanntes Konto „${accountId}".`,
          recoverable: true,
        });
      }
      return;
    }

    if (!agentId) {
      saveAccounts({ ...state, activeId: accountId });
      this.emitAccounts();
      return;
    }

    const s = this.pool.get(agentId);
    if (!s) {
      // Passiv wiederhergestellter Stream (keine laufende Session). Der Wunsch ist trotzdem
      // sinnvoll — er soll beim nächsten Fortsetzen greifen. Also in agents.json festhalten,
      // statt ihn wegzuwerfen: von dort liest der Resume das Konto (siehe start_agent).
      log(`[orchestrator] set_account: Stream ${agentId} nicht im Pool → für das nächste Fortsetzen vormerken`);
      const noted = this.noteAccountForResume(agentId, accountId);
      this.emit({
        ...envelope(),
        type: "agent_event",
        agentId,
        event: {
          kind: "system",
          subtype: noted
            ? `⇄ Konto „${target.label}" vorgemerkt — dieser Stream läuft gerade nicht; es greift beim nächsten Fortsetzen.`
            : `⚠ Kontowechsel nicht möglich: Stream läuft nicht und ist nicht fortsetzbar.`,
        },
      });
      return;
    }
    if (s.accountId === accountId) {
      // KEIN stiller Abbruch mehr: genau hier lief der Wechsel bisher ins Leere, wenn die Anzeige
      // ein anderes Konto behauptete als das laufende — der Mensch tippte auf das scheinbar andere
      // Konto und traf damit das, auf dem der Stream ohnehin schon lief. Bestätigen statt schweigen.
      this.emit({
        ...envelope(),
        type: "agent_event",
        agentId,
        event: { kind: "system", subtype: `⇄ Dieser Stream läuft bereits auf Konto „${target.label}" — kein Neustart nötig.` },
      });
      return;
    }

    // Ohne Session-ID gäbe es nichts fortzusetzen → der Wechsel würde den Verlauf verlieren.
    // Dann lieber ablehnen und es dem Menschen sagen, statt still Kontext wegzuwerfen.
    if (!s.sessionId) {
      this.emit({
        ...envelope(),
        type: "error",
        agentId,
        scope: "agent",
        code: "account_switch_failed",
        message: "Kontowechsel nicht möglich: dieser Stream hat noch keine fortsetzbare Session.",
        recoverable: true,
      });
      return;
    }

    const prev = s.accountId;
    const sessionId = s.sessionId;
    const worktreePath = s.worktreePath;
    log(`[orchestrator] Stream ${agentId}: Konto ${prev} → ${accountId} (Resume ${sessionId})`);

    await this.stopDevServerIf(agentId); // Dev-Server hängt am alten Prozess
    await s.stop(false); // Worktree BEHALTEN — die Arbeit soll ja weiterlaufen
    this.pool.delete(agentId);

    const session = new AgentSession(agentId, () => { this.persist(); this.schedulePollSoon(); }, this.permHooks(), () => this.activeStreamsSummary(agentId));
    session.lastPrompt = s.lastPrompt;
    this.pool.set(agentId, session);
    await session.start({
      ...envelope(),
      type: "start_agent",
      agentId,
      prompt: "",            // kein neuer Auftrag — nur Kontowechsel, die Session lebt weiter
      continuation: true,    // markiert: kein echter Nutzer-Auftrag (lastPrompt bleibt erhalten)
      accountId,
      label: s.label,
      role: s.role,
      model: s.model,
      effort: s.effort as StartAgentMsg["effort"],
      mock: false,
      permissionMode: s.permissionMode,
      autopilot: s.autopilot,
      resumeSessionId: sessionId,
      resumeWorktreePath: worktreePath,
      repoRoot: this.project?.repoRoot,
      cwd: worktreePath ?? this.project?.repoRoot,
      branch: s.branch,
    });
    this.persist();
    this.emitAccounts();
    // Vollzug melden. Bisher schrieb das Frontend die Meldung optimistisch, BEVOR der Sidecar sie
    // überhaupt gesehen hatte — sie stand also auch dann im Verlauf, wenn der Wechsel nie stattfand.
    // Jetzt sagt sie aus, was wirklich passiert ist.
    this.emit({
      ...envelope(),
      type: "agent_event",
      agentId,
      event: { kind: "system", subtype: `⇄ Konto: ${target.label} — Stream im selben Gespräch dort fortgesetzt.` },
    });
    void this.pollAgent(session);
  }

  /**
   * Konto-Wunsch für einen NICHT laufenden Stream in agents.json festhalten, damit das nächste
   * Fortsetzen ihn übernimmt (start_agent liest von dort, wenn der Aufrufer keins mitgibt).
   * `false` = kein Eintrag vorhanden, es gibt also nichts vorzumerken.
   */
  private noteAccountForResume(agentId: string, accountId: string): boolean {
    if (!this.project) return false;
    const repoRoot = this.project.repoRoot;
    const entries = loadRegistry(repoRoot);
    const idx = entries.findIndex((e) => e.agentId === agentId);
    if (idx < 0) return false;
    entries[idx] = { ...entries[idx], accountId, updatedAt: Date.now() };
    saveRegistry(repoRoot, entries);
    return true;
  }

  // ---------------------------------------------------------------- Dev-Server
  /** Dev-Server dieses Streams starten (Front-/Backend im Worktree). Nur ein Stream gleichzeitig. */
  /** „Dev-Server konfigurieren": `.mads/run.json` sicherstellen (frische Vorlage bei leer/fehlend) und
   *  dem Frontend den Pfad melden → es öffnet die Datei im mads-Editor, wo der Nutzer sie konstruiert. */
  private handleConfigureDevServer(agentId: string): void {
    if (!this.project) return;
    const repoRoot = this.project.repoRoot;
    ensureMadsDir(repoRoot); // .mads/ muss existieren, bevor run.json geschrieben wird
    const scaf = ensureRunManifest(repoRoot);
    this.emit({ ...envelope(), type: "devserver_config", agentId, path: scaf.path, detected: scaf.services });
  }

  // ─── Review-Streams: eingehende (fremde) PRs read-only prüfen ──────────────
  /** Eingehende PRs erkennen (fremd, kein Bot, kein mads-Stream, nicht schon als Review offen) und dem
   *  Frontend melden. Läuft im normalen Poll-Zyklus mit. */
  private async pollIncomingPrs(): Promise<void> {
    if (!this.project) return;
    const prs = await listOpenPrs(this.project.repoRoot);
    const incoming = prs.filter(
      (p) =>
        !isBotAuthor(p.author) &&
        !p.headRefName.startsWith("mads/") &&
        !p.headRefName.startsWith("mads-review/") &&
        !this.reviewStreams.has(`review-pr-${p.number}`),
    );
    this.emit({ ...envelope(), type: "incoming_prs", prs: incoming });
  }

  /** Einen eingehenden PR als READ-ONLY Review-Stream öffnen: isolierter Worktree auf dem PR-Stand,
   *  keine KI-Session, kein Autopilot → mads pusht NIE auf den fremden Branch. */
  private async handleOpenReviewStream(msg: OpenReviewStreamMsg): Promise<void> {
    if (!this.project) return;
    const agentId = `review-pr-${msg.prNumber}`;
    if (this.reviewStreams.has(agentId)) return; // schon offen
    this.removed.delete(agentId); // evtl. Tombstone aus einem früheren Teardown derselben Sitzung lösen
    const res = await createReviewWorktree(this.project.repoRoot, agentId, msg.prNumber);
    if (!res.ok) {
      this.emitError(agentId, "spawn_failed", `Review-Stream für PR #${msg.prNumber} konnte nicht geöffnet werden: ${res.error}`);
      return;
    }
    const label = `PR #${msg.prNumber}: ${msg.title}`.slice(0, 80);
    this.reviewStreams.set(agentId, { prNumber: msg.prNumber, branch: res.branch, worktreePath: res.path, url: msg.url, label, author: msg.author });
    this.persistReviewEntry(agentId); // in agents.json sichern → überlebt den App-Neustart
    this.emit({ ...envelope(), type: "review_stream", agentId, label, branch: res.branch, worktreePath: res.path, reviewPr: msg.prNumber, author: msg.author, url: msg.url });
    // Kachel-Git-Status füllen (behind/ahead ggü. main) — rein informativ fürs Review.
    const st = await gitStatus(this.project.repoRoot, res.path, res.branch, this.project.defaultBranch);
    if (!st.unreliable) this.emitGitStatus(agentId, st);
    log(`[orchestrator] Review-Stream geöffnet: PR #${msg.prNumber} (${res.branch}) in ${res.path}`);
  }

  /** Review-PR über den Standard-Weg annehmen: `gh pr merge <#> --squash` (fork-sicher, mit Retry gegen
   *  transiente GitHub-Fehler), danach Review-Stream abräumen. */
  private async handleMergeReview(agentId: string): Promise<void> {
    const rv = this.reviewStreams.get(agentId);
    if (!rv || !this.project) {
      this.emitMergeResult(agentId, false, ["Kein Review-Stream für diese Kachel."]);
      return;
    }
    const res = await mergePr(this.project.repoRoot, String(rv.prNumber), "squash");
    if (!res.ok) {
      this.emitMergeResult(agentId, false, [res.error], rv.prNumber);
      return;
    }
    log(`[orchestrator] Review-PR #${rv.prNumber} gemerged (squash)`);
    this.emitMergeResult(agentId, true, [], rv.prNumber);
    await this.teardownReview(agentId, rv);
  }

  /** Review-Stream verwerfen (ohne Merge): Worktree + lokaler Review-Branch weg, Kachel schließt. Der
   *  fremde PR bleibt unberührt. */
  private async handleCloseReview(agentId: string): Promise<void> {
    const rv = this.reviewStreams.get(agentId);
    if (rv) await this.teardownReview(agentId, rv);
  }

  private async teardownReview(agentId: string, rv: { branch: string; worktreePath: string }): Promise<void> {
    if (!this.project) return;
    await this.stopDevServerIf(agentId); // Dev-Server hält den Worktree offen → erst killen
    await this.reapWorktreeProcesses(agentId, rv.worktreePath);
    try {
      await removeWorktree(this.project.repoRoot, rv.worktreePath, rv.branch);
    } catch (e) {
      log(`[orchestrator] Review-Teardown (${agentId}) fehlgeschlagen: ${String(e)}`);
    }
    this.reviewStreams.delete(agentId);
    saveRegistry(this.project.repoRoot, loadRegistry(this.project.repoRoot).filter((e) => e.agentId !== agentId));
    this.removed.add(agentId); // falls Discovery/persist diesen agentId je sähe → nicht wiederbeleben
  }

  /** Einen offenen Review-Stream als Registry-Eintrag persistieren (überlebt den App-Neustart). Kein
   *  sessionId → offerResumable behandelt ihn NICHT als normalen Resume-Kandidaten; hydrateReviewStreams
   *  stellt beim Start daraus die Kachel wieder her. */
  private persistReviewEntry(agentId: string): void {
    if (!this.project) return;
    const rv = this.reviewStreams.get(agentId);
    if (!rv) return;
    const root = this.project.repoRoot;
    const entry: RegistryEntry = {
      agentId,
      label: rv.label,
      role: "sub",
      branch: rv.branch,
      worktreePath: rv.worktreePath,
      reviewPr: rv.prNumber,
      reviewAuthor: rv.author,
      reviewUrl: rv.url,
      status: "done",
      mock: false,
      updatedAt: Date.now(),
    };
    saveRegistry(root, [...loadRegistry(root).filter((e) => e.agentId !== agentId), entry]);
  }

  /** Persistierte Review-Streams beim Projekt-Öffnen wiederherstellen: Map füllen + Kachel + git_status
   *  emittieren. Verwaiste Einträge (Worktree weg) aus der Registry entfernen. */
  private async hydrateReviewStreams(): Promise<void> {
    if (!this.project) return;
    const root = this.project.repoRoot;
    for (const e of loadRegistry(root).filter((r) => r.reviewPr != null)) {
      if (this.reviewStreams.has(e.agentId)) continue;
      if (!e.worktreePath || !existsSync(e.worktreePath)) {
        saveRegistry(root, loadRegistry(root).filter((x) => x.agentId !== e.agentId)); // Worktree weg → Eintrag verwerfen
        continue;
      }
      const branch = e.branch ?? `mads-review/pr-${e.reviewPr}`;
      this.reviewStreams.set(e.agentId, {
        prNumber: e.reviewPr!,
        branch,
        worktreePath: e.worktreePath,
        url: e.reviewUrl ?? "",
        label: e.label,
        author: e.reviewAuthor ?? "",
      });
      this.emit({ ...envelope(), type: "review_stream", agentId: e.agentId, label: e.label, branch, worktreePath: e.worktreePath, reviewPr: e.reviewPr!, author: e.reviewAuthor ?? "", url: e.reviewUrl ?? "" });
      const st = await gitStatus(root, e.worktreePath, branch, this.project.defaultBranch);
      if (!st.unreliable) this.emitGitStatus(e.agentId, st);
    }
  }

  private async handleStartDevServer(agentId: string): Promise<void> {
    if (!this.project) return;
    const repoRoot = this.project.repoRoot;
    // Worktree auflösen — auch für PASSIVE (wiederhergestellte, „fertige") Streams, die nicht im
    // Pool liegen: der Dev-Server hängt am Worktree auf der Platte, nicht an einer aktiven KI-Session.
    // Reihenfolge: aktive Session → Registry-Eintrag → Konvention (~/mads-worktrees/<slug>/<agentId>).
    const worktree =
      this.pool.get(agentId)?.worktreePath ??
      loadRegistry(repoRoot).find((e) => e.agentId === agentId)?.worktreePath ??
      worktreePathFor(repoRoot, agentId);
    if (!worktree || !existsSync(worktree)) {
      this.emit({
        ...envelope(),
        type: "devserver_status",
        agentId,
        state: "error",
        message: "Kein Worktree für diesen Stream — Dev-Server nur in Sub-Streams mit eigenem Worktree.",
      });
      return;
    }
    const isReview = this.reviewStreams.has(agentId);
    if (isReview) {
      // Sicherheit: Ein Review-Worktree hält FREMDEN PR-Code. NIE Secrets hineinseeden (sonst könnten
      // die vom PR-Autor kontrollierten Dev-Skripte sie lesen). Und WARNEN: der Start führt fremden Code aus.
      this.emit({
        ...envelope(),
        type: "agent_event",
        agentId,
        event: {
          kind: "assistant_text",
          text: "⚠ Achtung: Der Dev-Server führt den Code dieses FREMDEN PR aus. Es werden bewusst keine lokalen Secrets in den Review-Worktree kopiert. Prüfe den Diff, bevor du startest.",
        },
      });
    } else {
      // Lokale, gitignorte Dev-Config sicherstellen (v. a. bei Worktrees VOR dem Seeding-Feature oder
      // wenn seither Config dazukam) — idempotent, überschreibt nie eine vorhandene Datei.
      try {
        const seeded = seedLocalDevFiles(repoRoot, worktree);
        if (seeded.length) log(`[orchestrator] devserver: ${seeded.length} lokale Config-Datei(en) nachgeseedet (${seeded.slice(0, 5).join(", ")})`);
      } catch {
        /* best effort */
      }
    }
    const manifest = loadRunManifest(repoRoot);
    if (!manifest) {
      // Keine lauffähige run.json (fehlt/leer/nicht erkannt) → NICHT blind starten und KEIN toter Fehler,
      // sondern „unconfigured": Vorlage (frisch) erzeugen und das Frontend „Konfigurieren" anbieten lassen.
      const scaf = ensureRunManifest(repoRoot);
      this.emit({
        ...envelope(),
        type: "devserver_status",
        agentId,
        state: "unconfigured",
        message:
          scaf.services > 0
            ? `Dev-Server noch nicht eingerichtet — Vorlage mit ${scaf.services} erkannten Service(s) erzeugt. „Konfigurieren" öffnen, Befehle/Ports prüfen, dann starten.`
            : `Dev-Server für dieses Projekt noch nicht eingerichtet — „Konfigurieren" öffnen und .mads/run.json ausfüllen.`,
      });
      return;
    }
    await this.stopDevServerIf(); // evtl. laufenden (anderen) Dev-Server zuerst stoppen — nur einer
    log(`[orchestrator] devserver start für ${agentId} (${manifest.services.length} service(s)) in ${worktree}`);
    // Frischer Start → Selbstheilungs-Versuche für diesen Stream zurücksetzen.
    for (const k of [...this.devHealAttempts.keys()]) if (k.startsWith(`${agentId}:`)) this.devHealAttempts.delete(k);
    this.devServer = new DevServerRun(
      agentId,
      worktree,
      manifest,
      (service, code, logLines) => this.handleDevServerCrash(agentId, service, code, logLines),
      this.project?.repoRoot,
    );
    await this.devServer.start();
  }

  /**
   * Prozesse aufräumen, die der Agent SELBST in seinem Worktree gestartet hat (mads' eigener
   * Dev-Server wird separat über stopDevServerIf beendet). Ohne das überleben Repro-Server & Co. das
   * Stream-Ende, halten Ports und tauchen später als „was antwortet da noch?" wieder auf.
   * Sichtbar melden, statt still zu killen — der Mensch soll wissen, dass etwas beendet wurde.
   */
  private async reapWorktreeProcesses(agentId: string, worktree: string | undefined): Promise<void> {
    // KONTRAKT SELBSTDURCHSETZEND (statt ihn an jeder Aufrufstelle zu wiederholen): Der CLI-Prozess
    // einer laufenden Session hat cwd = Worktree und faellt damit in genau das Raster, das
    // killProcessesInWorktree() findet. Wird er per SIGTERM erwischt, waehrend der Stream noch offen
    // ist, meldet consume() „exited with code 143" als ROTEN Fehler auf einer GELUNGENEN Aktion.
    // Genau das passierte auf dem Integrate-Pfad (5a7a527). Der cleanup_worktree-Pfad fasst den Pool
    // gar nicht an und haette dieselbe Falle gestellt — deshalb hier zentral: lebt noch eine Session
    // zu diesem Stream, wird sie ZUERST regulaer geschlossen.
    // Nur STOPPEN, nicht aus dem Pool entfernen: wer den Stream aus dem Pool nimmt (und wann die
    // Registry geschrieben wird), entscheiden die Aufrufstellen — daran wird hier nichts geaendert.
    // stop(false) ist idempotent (schliesst nur die Queues), ein zweiter Aufruf schadet also nicht.
    await this.pool.get(agentId)?.stop(false);
    const killed = await killProcessesInWorktree(worktree);
    if (!killed.length) return;
    this.emit({
      ...envelope(),
      type: "agent_event",
      agentId,
      event: {
        kind: "assistant_text",
        text: `↻ Aufgeräumt: ${killed.length} vom Agenten gestartete(r) Prozess(e) im Worktree beendet (PID ${killed.join(", ")}).`,
      },
    });
  }

  /** Laufenden Dev-Server stoppen — nur, wenn er zu `agentId` gehört (undefined = immer). */
  private async stopDevServerIf(agentId?: string): Promise<void> {
    const ds = this.devServer;
    if (!ds) return;
    if (agentId !== undefined && ds.agentId !== agentId) return;
    await ds.stop();
    this.autopilotDevserverDeferred.delete(ds.agentId); // Dev-Server aus → „Auto-Commit pausiert"-Hinweis wieder scharf
    this.devServer = undefined;
  }

  // Selbstheilungs-Versuche pro `${agentId}:${service}` (Deckel gegen Endlos-Schleifen).
  private readonly devHealAttempts = new Map<string, number>();

  /**
   * Dev-Server-SELBSTHEILUNG bei unerwartetem Absturz:
   *  - Port-Konflikt („address already in use") → deterministisch, `freePort` räumt beim nächsten
   *    Start auf → nur ein Hinweis, KEIN Agent nötig.
   *  - jeder andere Absturz → den Stream-Agenten mit dem Log zur Diagnose+Behebung anstoßen
   *    (max. 2× pro Service; der Agent behebt es oder eskaliert klar an den Nutzer).
   */
  private handleDevServerCrash(agentId: string, service: string, code: number | null, logLines: string[]): void {
    const text = logLines.join("\n");
    if (/address already in use|EADDRINUSE/i.test(text)) {
      this.emit({
        ...envelope(),
        type: "agent_event",
        agentId,
        event: { kind: "assistant_text", text: `⚠ Dev-Server „${service}" scheiterte an einem belegten Port — beim nächsten Start wird der Blockierer automatisch freigeräumt.` },
      });
      return;
    }
    // Review-Stream: der Worktree hält FREMDEN PR-Code. NIEMALS automatisch „reparieren" (kein Agent
    // auf fremdem Code, kein Push auf fremde Branches) — nur erklären. Ein Backend, das DB/Mail-Config
    // braucht, scheitert hier erwartungsgemäß, weil bewusst KEINE lokalen Secrets geseedet werden; zum
    // Ansehen des PR genügt meist das Frontend (läuft dank Survivor-Logik weiter, falls vorhanden).
    if (this.reviewStreams.has(agentId)) {
      this.emit({
        ...envelope(),
        type: "agent_event",
        agentId,
        event: {
          kind: "assistant_text",
          text: `⚠ Dev-Server „${service}" im Review-Stream beendet (exit ${code ?? "?"}). Im Review-Worktree werden bewusst KEINE lokalen Secrets geseedet — ein Backend, das DB/Mail-Config braucht, scheitert hier erwartungsgemäß. Zum Ansehen des PR genügt meist das Frontend (läuft weiter, falls vorhanden). Keine automatische Behebung an fremdem PR-Code.`,
        },
      });
      return;
    }
    const key = `${agentId}:${service}`;
    const tries = (this.devHealAttempts.get(key) ?? 0) + 1;
    this.devHealAttempts.set(key, tries);
    if (tries > 2) {
      this.emit({
        ...envelope(),
        type: "agent_event",
        agentId,
        event: { kind: "assistant_text", text: `⚠ Dev-Server „${service}" ist mehrfach abgestürzt — Selbstheilung pausiert. Bitte den Log prüfen.` },
      });
      return;
    }
    const s = this.pool.get(agentId);
    if (!s) return; // kein aktiver KI-Stream (passiver Worktree) → nichts anzustoßen, Fehler steht im Log
    this.emit({
      ...envelope(),
      type: "agent_event",
      agentId,
      event: { kind: "assistant_text", text: `🔧 Dev-Server-Selbstheilung: „${service}" ist abgestürzt (exit ${code ?? "?"}) — ich analysiere die Ursache …` },
    });
    s.sendInput(
      `[Dev-Server-Selbstheilung] Der Dev-Server-Service „${service}" ist unerwartet abgestürzt (exit ${code ?? "?"}). Letzte Log-Zeilen:\n\n${text}\n\nAnalysiere die Ursache und behebe sie, wenn möglich (fehlende Dependency, Config, DB-Migration, Code-Fehler o. Ä.). Brauchst du dafür fundierten Input von mir, sag klar, WAS du brauchst. Sonst behebe es — ich starte den Dev-Server danach neu.`,
    );
  }
}
