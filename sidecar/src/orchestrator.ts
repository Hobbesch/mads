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
import { loadApprovedKinds, saveApprovedKinds } from "./permissions.js";
import type { CommandKind } from "../../shared/safe-command.js";
import { send, log, envelope, timelineSnapshot } from "./io.js";
import { autoCommit, commitMainRelease, createPr, detectMainVersionBump, discoverWorktrees, ensureWorktreeSeedFile, fastForwardMain, finalizeAdrDrafts, getRepoInfo, gitStatus, mergePr, outsourceMainChanges, prStatus, pushBranch, reconcileAdrCollisions, removeWorktree, run, seedLocalDevFiles, syncBranch, unpushedCount, worktreePathFor, worktreeResidue } from "./git.js";
import { runGate } from "./gate.js";
import { DevServerRun, ensureRunManifest, loadRunManifest } from "./devserver.js";
import { autopilotDecision } from "../../shared/autopilot.js";
import { acquireProjectLock, ensureMadsDir, loadRegistry, mergeRegistry, releaseProjectLock, saveRegistry, type RegistryEntry } from "./persistence.js";
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
import type { HostMessage, ProjectInfo, EscalationKind, AutonomyConfig, ResumableAgent } from "../../shared/protocol.js";

const POLL_INTERVAL_MS = 25_000;

export class Orchestrator {
  private readonly pool = new Map<string, AgentSession>();
  private project?: ProjectInfo;
  // Projektweite „Immer erlauben"-Freigaben für Bash-Kategorien (persistent in .mads/permissions.json).
  // Alle Streams des Projekts teilen sich diesen Zustand; bei Projektwechsel neu geladen.
  private readonly approvedKinds = new Set<CommandKind>();
  private pollTimer?: ReturnType<typeof setInterval>;
  // Re-Entrancy-Schutz: dauert ein Poll-Zyklus (fetch + Autopilot commit/push/PR) länger als das
  // Intervall, würde `setInterval` einen ZWEITEN parallel starten → zwei Push-/Rebase-Zyklen kollidieren
  // (force-with-lease „cannot lock ref … expected …"). Der Guard lässt immer nur EINEN Zyklus laufen.
  private polling = false;
  // Halb-autonomer Integrator (P-Halb): Auto-Sync + Kollisions-Scan.
  private autonomy: AutonomyConfig = { autoSync: true, collisionScan: true };
  private readonly gitState = new Map<string, { behind: number; ahead: number; dirty: boolean }>();
  private readonly syncing = new Set<string>(); // läuft gerade ein Auto-Sync?
  private readonly autoSyncConflicted = new Set<string>(); // Auto-Sync pausiert bis manuell gelöst
  // Nach „Mergen & weiterarbeiten": die Nummer des gemergten PRs, die der Poll ignoriert,
  // bis ein NEUER PR aufgeht (sonst zeigt `gh pr view <branch>` weiter den Alt-PR als MERGED).
  private readonly suppressedMergedPr = new Map<string, number>();
  // Autopilot (Phase 2): PR-Erstellung pro „ahead"-Stand nur einmal versuchen (kein Gate-Spam
  // bei rotem Gate); Secret-Eskalation pro Episode nur einmal melden.
  private readonly autopilotPrTried = new Map<string, number>();
  private readonly autopilotSecretNotified = new Set<string>();
  // Proaktiver Hinweis „main direkt geändert" pro Integrator nur einmal je dirty-Episode.
  private readonly mainDirtyNotified = new Set<string>();
  // Explizit entfernte Agenten (gestoppt/aufgeräumt/gemergt) — mergeRegistry darf sie NICHT
  // aus der Registry wiederbeleben (sonst hebt merge-persist ein bewusstes Entfernen auf).
  private readonly removed = new Set<string>();
  // 3.2: Integrationen serialisieren (kein Merge-Race zweier fast gleichzeitiger Merges).
  private integrateLock: Promise<void> = Promise.resolve();
  // A: PR-Erstellungen serialisieren, damit die ADR-Nummern-Vergabe (Scan aller Worktrees +
  // Umbenennen) atomar ist und zwei Streams nie dieselbe Nummer ziehen.
  private createPrLock: Promise<void> = Promise.resolve();
  // Höchstens EIN Stream-Dev-Server gleichzeitig (Standard-Ports → kein Konflikt). Ein Start
  // stoppt einen zuvor laufenden; jeder Teardown-Pfad (stop/cleanup/merge/switch/shutdown) killt ihn.
  private devServer?: DevServerRun;

  async dispatch(msg: HostMessage): Promise<void> {
    switch (msg.type) {
      case "set_project":
        this.project = msg.project;
        this.reloadApprovedKinds();
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
          log(`[orchestrator] project switch → previous pool stopped & cleared`);
        }
        this.project = { projectId: msg.projectId, repoRoot: msg.repoRoot, ...info };
        this.reloadApprovedKinds();
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
        const session = new AgentSession(msg.agentId, () => this.persist(), this.permHooks());
        this.pool.set(msg.agentId, session);
        await session.start(msg);
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

      case "stop_agent": {
        const s = this.pool.get(msg.agentId);
        await this.stopDevServerIf(msg.agentId); // laufenden Dev-Server dieses Streams zuerst beenden
        await s?.stop(msg.removeWorktree ?? false);
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
        const session = new AgentSession(msg.agentId, () => this.persist(), this.permHooks());
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
          model: "claude-sonnet-4-6",
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
        // G5: Integrator-Aktion — main per fast-forward nachziehen (KEIN rebase/force).
        if (!this.project) break;
        const res = await fastForwardMain(this.project.repoRoot, this.project.defaultBranch);
        if (res.ff > 0) {
          this.emit({
            ...envelope(),
            type: "agent_event",
            agentId: msg.agentId,
            event: { kind: "assistant_text", text: `↻ main per fast-forward auf origin/${this.project.defaultBranch} aktualisiert (+${res.ff} Commits).` },
          });
        } else if (res.blocked) {
          const why =
            res.blocked === "dirty"
              ? "uncommittete Änderungen an getrackten Dateien"
              : res.blocked === "diverged"
                ? "main ist divergiert (lokale Commits) — Merge/Rebase nötig"
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
    if (pre.ahead === 0) {
      const msg = pre.dirty
        ? `Kein PR möglich: Der Branch ${s.branch} hat noch keine Commits gegenüber ${this.project.defaultBranch} — die Änderungen sind nicht committet. Lass den Agenten zuerst LOKAL committen (git add -A && git commit; KEINE projekteigenen Push-Skripte — die pushen auf main), dann erneut „PR erstellen".`
        : `Kein PR möglich: Keine Commits und keine Änderungen auf ${s.branch} gegenüber ${this.project.defaultBranch}.`;
      this.emitError(agentId, "push_rejected", msg);
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
    try {
      await this.doIntegrate(agentId, method, keepBranch);
    } finally {
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
        await this.stopDevServerIf(agentId); // Dev-Server killen, bevor der Worktree hart resettet wird
        const base = this.project.defaultBranch;
        await run("git", ["-C", s.worktreePath, "fetch", "origin", base], s.worktreePath);
        const reset = await run("git", ["-C", s.worktreePath, "reset", "--hard", `origin/${base}`], s.worktreePath);
        resyncOk = reset.code === 0;
        const st = await gitStatus(s.repoRoot, s.worktreePath, s.branch, base);
        this.gitState.set(agentId, st);
        this.emitGitStatus(agentId, st);
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

    // Aufräumen (best effort — blockiert das erfolgreiche Merge-Ergebnis NICHT):
    // Worktree zuerst entfernen (gibt den ausgecheckten Branch frei + löscht den lokalen
    // Branch), danach den Remote-Branch löschen.
    if (s.worktreePath) {
      try {
        await this.stopDevServerIf(agentId); // Dev-Server killen, bevor der Worktree entfernt wird
        this.emitSeedReclaimed(agentId, await removeWorktree(s.repoRoot, s.worktreePath, s.branch));
      } catch (e) {
        log(`[orchestrator] worktree cleanup after merge failed: ${String(e)}`);
      }
    } else {
      await run("git", ["-C", s.repoRoot, "branch", "-D", s.branch], s.repoRoot);
    }
    await run("git", ["-C", s.repoRoot, "push", "origin", "--delete", s.branch], s.repoRoot);
    s.status = "done";
    await s.stop(false); // Query schließen; Karte bleibt als "merged" sichtbar
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
    if (this.project) for (const k of loadApprovedKinds(this.project.repoRoot)) this.approvedKinds.add(k);
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
        mock: false,
        updatedAt: Date.now(),
      });
    }
    try {
      // NICHT den Pool über die Registry drüberbügeln: passiv wiederhergestellte Kacheln
      // (v.a. der Integrator, der beim Reopen live:false ist → NICHT im Pool) blieben sonst
      // nicht erhalten und „main" verschwindet. mergeRegistry bewahrt sie (siehe persistence.ts).
      const merged = mergeRegistry(loadRegistry(this.project.repoRoot), poolEntries, this.removed, existsSync);
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

    const registry = loadRegistry(repoRoot);
    const seen = new Set<string>();
    const candidates: RegistryEntry[] = [];

    // 1) Registry-Einträge mit Claude-Session → Kandidaten fürs echte Fortsetzen.
    for (const e of registry) {
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
        offer.push({ ...c, prState: pr?.state, prNumber: pr?.number, prUrl: pr?.url });
        log(`[orchestrator] reconcile: ${c.branch} ${doneWord} + sauberer Worktree (unpushed=${res.unpushed} = Squash-Artefakt, ignoriert) → als fortsetzbar angeboten`);
      } else {
        // gemergt + WIRKLICH schmutziger Worktree (uncommittete/untrackte Änderungen) → Aufräum-Kandidat mit Warnung.
        offer.push({ ...c, prState: pr?.state, prNumber: pr?.number, prUrl: pr?.url, merged: true, localChanges: true });
        residue.push(c.label);
        log(`[orchestrator] reconcile: ${c.branch} ${doneWord}, aber schmutziger Worktree (dirty=${res.dirty} unpushed=${res.unpushed}) → zur Prüfung`);
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
    if (mainFastForwarded > 0 || mainBehind > 0 || cleaned.length > 0 || residue.length > 0 || seedGenerated > 0) {
      this.emit({ ...envelope(), type: "reconcile_summary", mainFastForwarded, mainBehind, mainBlocked, cleaned, residue, seedGenerated });
    }
    log(`[orchestrator] reconcile: ff=${mainFastForwarded} behind=${mainBehind} blocked=${mainBlocked ?? "-"} cleaned=${cleaned.length} residue=${residue.length} offer=${offer.length} seed=${seedGenerated}`);
  }

  // ---------------------------------------------------------------- Polling
  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.pollAll(), POLL_INTERVAL_MS);
  }

  private async pollAll(): Promise<void> {
    if (!this.project || this.polling) return; // nie zwei Zyklen parallel (Push-/Rebase-Race)
    this.polling = true;
    try {
      // einmal pro Zyklus fetchen, dann pro Agent rev-list (spart Netz).
      await run("git", ["-C", this.project.repoRoot, "fetch", "origin"], this.project.repoRoot);
      for (const s of this.pool.values()) await this.pollAgent(s, true);
      if (this.autonomy.autoSync) await this.autoSyncPass();
      await this.autopilotPass();
      if (this.autonomy.collisionScan) await this.collisionPass();
    } finally {
      this.polling = false;
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
      const st = this.gitState.get(s.agentId);
      if (!st) continue;
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
      }
    }
  }

  private async pollAgent(s: AgentSession, skipFetch = false): Promise<void> {
    if (!this.project || !s.repoRoot) return;
    const defaultBranch = this.project.defaultBranch;
    try {
      // Integrator (G1): kein Worktree/Branch — er sitzt im Haupt-Checkout auf
      // <default>. Trotzdem dessen Drift gegen origin/<default> überwachen, sonst
      // merkt der Nutzer nie, dass seine Basis veraltet ist (kein PR für main).
      if (s.role === "integrator") {
        const status = await gitStatus(s.repoRoot, s.repoRoot, defaultBranch, defaultBranch, skipFetch);
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
            // „Als Release committen" (Push bleibt separat/explizit).
            this.emitError(
              s.agentId,
              "main_deploy_dirty",
              "Deploy abgeschlossen — der Versions-Bump liegt uncommittet auf main. „Als Release committen“ (chore(release)) " +
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
      this.gitState.set(s.agentId, status);
      // 3.4: Hat der Branch wieder aufgeholt (behind=0), ist ein zuvor pausierter Sync-Konflikt
      // gelöst (manuell oder vom Agenten rebaset) → Auto-Sync-Pause aufheben (Flag clearen).
      if (status.behind === 0 && this.autoSyncConflicted.has(s.agentId)) this.autoSyncConflicted.delete(s.agentId);
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
    const st = this.gitState.get(s.agentId);
    if (!st || st.behind <= 0 || st.dirty) return; // nur saubere, zurückliegende Branches
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
    this.emit({ ...envelope(), type: "git_status", agentId, ...st, syncBlocked: this.autoSyncConflicted.has(agentId) });
  }
  private emit(obj: unknown): void {
    void send(obj);
  }

  // ---------------------------------------------------------------- Dev-Server
  /** Dev-Server dieses Streams starten (Front-/Backend im Worktree). Nur ein Stream gleichzeitig. */
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
    // Lokale, gitignorte Dev-Config sicherstellen (v. a. bei Worktrees VOR dem Seeding-Feature oder
    // wenn seither Config dazukam) — idempotent, überschreibt nie eine vorhandene Datei.
    try {
      const seeded = seedLocalDevFiles(repoRoot, worktree);
      if (seeded.length) log(`[orchestrator] devserver: ${seeded.length} lokale Config-Datei(en) nachgeseedet (${seeded.slice(0, 5).join(", ")})`);
    } catch {
      /* best effort */
    }
    let manifest = loadRunManifest(repoRoot);
    if (!manifest) {
      // Keine (gültige) run.json → Vorlage erzeugen und den Nutzer prüfen lassen (nicht blind starten).
      const scaf = ensureRunManifest(repoRoot);
      this.emit({
        ...envelope(),
        type: "devserver_status",
        agentId,
        state: "error",
        message: scaf.generated
          ? `Keine .mads/run.json gefunden — Vorlage mit ${scaf.services} erkannten Service(s) erzeugt. Bitte Befehle/Ports prüfen und erneut starten.`
          : "Keine gültige .mads/run.json gefunden. Bitte die Datei anlegen/prüfen.",
      });
      return;
    }
    await this.stopDevServerIf(); // evtl. laufenden (anderen) Dev-Server zuerst stoppen — nur einer
    log(`[orchestrator] devserver start für ${agentId} (${manifest.services.length} service(s)) in ${worktree}`);
    // Frischer Start → Selbstheilungs-Versuche für diesen Stream zurücksetzen.
    for (const k of [...this.devHealAttempts.keys()]) if (k.startsWith(`${agentId}:`)) this.devHealAttempts.delete(k);
    this.devServer = new DevServerRun(agentId, worktree, manifest, (service, code, logLines) =>
      this.handleDevServerCrash(agentId, service, code, logLines),
    );
    await this.devServer.start();
  }

  /** Laufenden Dev-Server stoppen — nur, wenn er zu `agentId` gehört (undefined = immer). */
  private async stopDevServerIf(agentId?: string): Promise<void> {
    const ds = this.devServer;
    if (!ds) return;
    if (agentId !== undefined && ds.agentId !== agentId) return;
    await ds.stop();
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
