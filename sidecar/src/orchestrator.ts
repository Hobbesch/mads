/**
 * Orchestrator — Agenten-Pool + Projekt-State + Git/GitHub-Routing (P3/P4).
 *
 * P3: ein Worktree pro Agent (in session.ts), parallele Agenten.
 * P4: GitHub-PR-Lifecycle (create_pr), stale-base-Sync (sync_branch) und ein
 *     Polling-Loop, der git-Status (behind/ahead/dirty) + PR-Status (Checks,
 *     mergeable, review) je Agent meldet → Eskalations-Signale fürs Dashboard.
 */
import { existsSync } from "node:fs";
import { AgentSession } from "./session.js";
import { send, log, envelope } from "./io.js";
import { createPr, discoverWorktrees, fastForwardMain, getRepoInfo, gitStatus, mergePr, prStatus, removeWorktree, run, syncBranch, worktreePathFor, worktreeResidue } from "./git.js";
import { runGate } from "./gate.js";
import { ensureMadsDir, loadRegistry, saveRegistry, type RegistryEntry } from "./persistence.js";
import { preMergeGate } from "../../shared/merge.js";
import { parseDiffRegions, detectCollisions, type AgentRegions } from "../../shared/collision.js";
import type { HostMessage, ProjectInfo, EscalationKind, AutonomyConfig, ResumableAgent } from "../../shared/protocol.js";

const POLL_INTERVAL_MS = 25_000;

export class Orchestrator {
  private readonly pool = new Map<string, AgentSession>();
  private project?: ProjectInfo;
  private pollTimer?: ReturnType<typeof setInterval>;
  // Halb-autonomer Integrator (P-Halb): Auto-Sync + Kollisions-Scan.
  private autonomy: AutonomyConfig = { autoSync: true, collisionScan: true };
  private readonly gitState = new Map<string, { behind: number; ahead: number; dirty: boolean }>();
  private readonly syncing = new Set<string>(); // läuft gerade ein Auto-Sync?
  private readonly autoSyncConflicted = new Set<string>(); // Auto-Sync pausiert bis manuell gelöst

  async dispatch(msg: HostMessage): Promise<void> {
    switch (msg.type) {
      case "set_project":
        this.project = msg.project;
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
        this.project = { projectId: msg.projectId, repoRoot: msg.repoRoot, ...info };
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
        const session = new AgentSession(msg.agentId, () => this.persist());
        this.pool.set(msg.agentId, session);
        await session.start(msg);
        this.persist();
        void this.pollAgent(session); // initialer Status
        break;
      }

      case "send_input":
        this.pool.get(msg.agentId)?.sendInput(msg.text, msg.images);
        break;

      case "answer_permission":
        this.pool.get(msg.agentId)?.answerPermission(msg.requestId, msg.decision);
        break;

      case "interrupt_agent":
        await this.pool.get(msg.agentId)?.interrupt();
        break;

      case "set_permission_mode":
        await this.pool.get(msg.agentId)?.setMode(msg.mode);
        break;

      case "stop_agent": {
        const s = this.pool.get(msg.agentId);
        await s?.stop(msg.removeWorktree ?? false);
        this.pool.delete(msg.agentId);
        this.persist();
        break;
      }

      case "create_pr":
        await this.handleCreatePr(msg.agentId, msg.title, msg.body, msg.draft);
        break;

      case "sync_branch":
        await this.handleSync(msg.agentId);
        break;

      case "gate_task":
        await this.handleGate(msg.agentId);
        break;

      case "set_autonomy":
        this.autonomy = msg.config;
        log(`[orchestrator] autonomy: autoSync=${msg.config.autoSync} collisionScan=${msg.config.collisionScan}`);
        break;

      case "integrate_pr":
        await this.handleIntegrate(msg.agentId, msg.method ?? "squash");
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
          await removeWorktree(root, path, msg.branch);
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
        for (const s of this.pool.values()) await s.stop(false);
        this.pool.clear();
        process.exit(0);
        break;

      default:
        log("[orchestrator] unbekannter HostMessage-Typ", JSON.stringify(msg));
    }
  }

  // ---------------------------------------------------------------- GitHub
  private async handleCreatePr(agentId: string, title?: string, body?: string, draft?: boolean): Promise<void> {
    const s = this.pool.get(agentId);
    if (!s || !s.repoRoot || !s.branch || !s.worktreePath || !this.project) {
      this.emitError(agentId, "spawn_failed", "Kein Worktree/Projekt für diesen Agenten — PR nicht möglich.");
      return;
    }

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
    log(`[orchestrator] Branch ${s.branch} rebaset onto origin/${this.project.defaultBranch}`);
    await this.pollAgent(s);
  }

  /**
   * Integrator-Merge (Invariante 1: nur diese Op landet auf main). Serialisiert,
   * gegated: holt frischen git-/PR-Status, prüft das Vor-Merge-Gate, merged nur bei
   * grün, räumt danach den Worktree auf. Sub-Agents haben KEINE Merge-Op.
   */
  private async handleIntegrate(agentId: string, method: "squash" | "merge" | "rebase"): Promise<void> {
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
      this.emit({ ...envelope(), type: "git_status", agentId, ...st });
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

    log(`[orchestrator] PR ${pr?.number ?? s.branch} gemerged (${method})`);
    this.emitMergeResult(agentId, true, [], pr?.number);
    if (pr) this.emit({ ...envelope(), type: "pr_update", agentId, pr: { ...pr, state: "MERGED" } });
    this.emit({ ...envelope(), type: "status_update", agentId, status: "done", currentStep: "merged" });

    // Aufräumen (best effort — blockiert das erfolgreiche Merge-Ergebnis NICHT):
    // Worktree zuerst entfernen (gibt den ausgecheckten Branch frei + löscht den lokalen
    // Branch), danach den Remote-Branch löschen.
    if (s.worktreePath) {
      try {
        await removeWorktree(s.repoRoot, s.worktreePath, s.branch);
      } catch (e) {
        log(`[orchestrator] worktree cleanup after merge failed: ${String(e)}`);
      }
    } else {
      await run("git", ["-C", s.repoRoot, "branch", "-D", s.branch], s.repoRoot);
    }
    await run("git", ["-C", s.repoRoot, "push", "origin", "--delete", s.branch], s.repoRoot);
    s.status = "done";
    await s.stop(false); // Query schließen; Karte bleibt als "merged" sichtbar
    this.persist(); // gemergten Agenten aus der Resume-Registry entfernen
  }

  private emitMergeResult(agentId: string, ok: boolean, reasons: string[], prNumber?: number): void {
    this.emit({ ...envelope(), type: "merge_result", agentId, ok, merged: ok, reasons, prNumber });
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
    const agents: RegistryEntry[] = [];
    for (const s of this.pool.values()) {
      if (s.mock || !s.sessionId) continue; // echte Agenten mit Session sind resumebar (auch fertige/Integrator)
      agents.push({
        agentId: s.agentId,
        label: s.label ?? s.agentId,
        role: s.role ?? "sub",
        sessionId: s.sessionId,
        branch: s.branch,
        worktreePath: s.worktreePath,
        lastPrompt: s.lastPrompt,
        status: s.status,
        model: s.model,
        mock: false,
        updatedAt: Date.now(),
      });
    }
    try {
      saveRegistry(this.project.repoRoot, agents);
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
      if (!res.dirty && res.unpushed === 0) {
        await removeWorktree(repoRoot, c.worktreePath, c.branch);
        dropped.add(c.agentId);
        cleaned.push(c.label);
        log(`[orchestrator] reconcile: ${c.branch} ${doneWord} + sauber → aufgeräumt`);
      } else {
        offer.push({ ...c, prState: pr?.state, prNumber: pr?.number, prUrl: pr?.url, merged: true, localChanges: true });
        residue.push(c.label);
        log(`[orchestrator] reconcile: ${c.branch} ${doneWord}, aber lokale Reste (dirty=${res.dirty} unpushed=${res.unpushed}) → zur Prüfung`);
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
    if (mainFastForwarded > 0 || mainBehind > 0 || cleaned.length > 0 || residue.length > 0) {
      this.emit({ ...envelope(), type: "reconcile_summary", mainFastForwarded, mainBehind, mainBlocked, cleaned, residue });
    }
    log(`[orchestrator] reconcile: ff=${mainFastForwarded} behind=${mainBehind} blocked=${mainBlocked ?? "-"} cleaned=${cleaned.length} residue=${residue.length} offer=${offer.length}`);
  }

  // ---------------------------------------------------------------- Polling
  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.pollAll(), POLL_INTERVAL_MS);
  }

  private async pollAll(): Promise<void> {
    if (!this.project) return;
    // einmal pro Zyklus fetchen, dann pro Agent rev-list (spart Netz).
    await run("git", ["-C", this.project.repoRoot, "fetch", "origin"], this.project.repoRoot);
    for (const s of this.pool.values()) await this.pollAgent(s, true);
    if (this.autonomy.autoSync) await this.autoSyncPass();
    if (this.autonomy.collisionScan) await this.collisionPass();
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
        this.emit({ ...envelope(), type: "git_status", agentId: s.agentId, ...status });
        return;
      }
      if (!s.branch || !s.worktreePath) return; // Sub ohne Worktree → nichts zu pollen
      const status = await gitStatus(s.repoRoot, s.worktreePath, s.branch, defaultBranch, skipFetch);
      this.gitState.set(s.agentId, status);
      this.emit({ ...envelope(), type: "git_status", agentId: s.agentId, ...status });
      const pr = await prStatus(s.repoRoot, s.branch);
      if (pr) this.emit({ ...envelope(), type: "pr_update", agentId: s.agentId, pr });
    } catch (e) {
      log(`[orchestrator] poll ${s.agentId} failed:`, String(e));
    }
  }

  /** Auto-Sync: idle, saubere Sub-Branches, die hinter origin/<default> liegen, automatisch rebasen. */
  private async autoSyncPass(): Promise<void> {
    if (!this.project) return;
    for (const s of this.pool.values()) {
      if (s.role !== "sub" || !s.worktreePath || !s.branch) continue;
      if (s.status === "running") continue; // nicht unter laufender Arbeit rebasen
      if (this.syncing.has(s.agentId) || this.autoSyncConflicted.has(s.agentId)) continue;
      const st = this.gitState.get(s.agentId);
      if (!st || st.behind <= 0 || st.dirty) continue; // nur saubere, zurückliegende Branches
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
        await this.pollAgent(s, true);
      } else {
        // semantischer/Push-Konflikt → an den Menschen eskalieren, Auto-Sync pausieren
        this.autoSyncConflicted.add(s.agentId);
        this.emitError(s.agentId, res.kind, `Auto-Sync gestoppt (manuell „Sync" nötig): ${res.error}`);
      }
    }
  }

  /** Kollisions-Scan: paarweiser Region-Overlap der aktiven Sub-Agenten. */
  private async collisionPass(): Promise<void> {
    if (!this.project) return;
    const agentsRegions: AgentRegions[] = [];
    for (const s of this.pool.values()) {
      if (s.role !== "sub" || !s.worktreePath || s.status === "done") continue;
      try {
        const diff = await run(
          "git",
          ["-C", s.worktreePath, "diff", "--merge-base", `origin/${this.project.defaultBranch}`, "--unified=0"],
          s.worktreePath,
        );
        const regions = parseDiffRegions(diff.stdout);
        if (regions.length) agentsRegions.push({ agentId: s.agentId, label: s.label ?? s.agentId, regions });
      } catch {
        /* einzelner Diff-Fehler ignorieren */
      }
    }
    this.emit({ ...envelope(), type: "collision_warning", collisions: detectCollisions(agentsRegions) });
  }

  private emitError(agentId: string, code: EscalationKind, message: string): void {
    this.emit({ ...envelope(), type: "error", agentId, scope: "agent", code, message, recoverable: true });
  }
  private emit(obj: unknown): void {
    void send(obj);
  }
}
