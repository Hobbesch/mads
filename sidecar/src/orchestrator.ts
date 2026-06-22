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
import { createPr, getRepoInfo, gitStatus, mergePr, prStatus, removeWorktree, run, syncBranch } from "./git.js";
import { runGate } from "./gate.js";
import { loadRegistry, saveRegistry, type RegistryEntry } from "./persistence.js";
import { preMergeGate } from "../../shared/merge.js";
import { parseDiffRegions, detectCollisions, type AgentRegions } from "../../shared/collision.js";
import type { HostMessage, ProjectInfo, EscalationKind, AutonomyConfig } from "../../shared/protocol.js";

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
        this.offerResumable(msg.repoRoot);
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
        ? `Kein PR möglich: Der Branch ${s.branch} hat noch keine Commits gegenüber ${this.project.defaultBranch} — die Änderungen sind nicht committet. Lass den Agenten zuerst committen (eure Commit-Konvention, z. B. scripts/paix-commit.sh), dann erneut „PR erstellen".`
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

    // Worktree aufräumen (gh --delete-branch entfernt das Remote; lokal hier).
    if (s.worktreePath) {
      try {
        await removeWorktree(s.repoRoot, s.worktreePath, s.branch);
      } catch (e) {
        log(`[orchestrator] worktree cleanup after merge failed: ${String(e)}`);
      }
    }
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

  private offerResumable(repoRoot: string): void {
    const resumable = loadRegistry(repoRoot).filter(
      (e) =>
        e.sessionId &&
        !this.pool.has(e.agentId) &&
        // Sub-Agenten brauchen ihren Worktree; der Integrator läuft im Haupt-Checkout
        // (kein Worktree) und ist trotzdem fortsetzbar.
        (e.worktreePath ? existsSync(e.worktreePath) : true),
    );
    if (resumable.length > 0) {
      this.emit({ ...envelope(), type: "resumable_agents", agents: resumable });
      log(`[orchestrator] ${resumable.length} resumebare Agenten gefunden`);
    }
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
    if (!this.project || !s.repoRoot || !s.branch || !s.worktreePath) return;
    try {
      const status = await gitStatus(s.repoRoot, s.worktreePath, s.branch, this.project.defaultBranch, skipFetch);
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
