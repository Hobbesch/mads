/**
 * mads UI-Store (zustand).
 *
 * Single Source of Truth (docs/design/01-architecture.md §5.3): der Sidecar-Pool ist
 * autoritativ; dieser Store SPIEGELT nur die über den Channel gemeldeten Events.
 */
import { create } from "zustand";
import { startSidecar, sendHost, envelope, pickFolder } from "./ipc";
import { writeLine } from "./terminal";
import type {
  AgentStatus,
  SidecarMessage,
  SidecarChannelEvent,
  PermissionRequestMsg,
  PermissionDecision,
  SidecarErrorMsg,
  ProjectInfo,
  PullRequestInfo,
  GateStep,
  ResumableAgent,
  AutonomyConfig,
  PermissionMode,
  ImageInput,
} from "../shared/protocol";
import type { Collision } from "../shared/collision";

const C = {
  dim: "\x1b[90m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

export type AgentRole = "integrator" | "sub";

export interface AgentVM {
  id: string;
  label: string;
  role: AgentRole;
  status: AgentStatus;
  currentStep?: string;
  costUsd: number;
  numTurns: number;
  sessionId?: string;
  mock: boolean;
  permissionMode: PermissionMode;
  createdAt: number;
  lastEventAt: number;
  // P3/P4:
  branch?: string;
  worktreePath?: string;
  behind: number;
  ahead: number;
  dirty: boolean;
  pr?: PullRequestInfo;
  gate?: { ok: boolean; steps: GateStep[] };
}

export interface SidecarInfo {
  status: "down" | "starting" | "ready" | "error";
  sdkAvailable: boolean;
  sdkVersion?: string;
}

interface MadsState {
  sidecar: SidecarInfo;
  project?: ProjectInfo;
  projectStatus: "none" | "opening" | "ready" | "error";
  agents: Record<string, AgentVM>;
  order: string[];
  permissions: PermissionRequestMsg[];
  escalations: SidecarErrorMsg[];
  resumables: ResumableAgent[];
  collisions: Collision[];
  autonomy: AutonomyConfig;
  selectedId?: string;
  debugLog: string[];

  init: () => Promise<void>;
  setAutonomy: (config: AutonomyConfig) => Promise<void>;
  openProject: () => Promise<void>;
  createAgent: (opts: {
    label: string;
    prompt: string;
    role: AgentRole;
    mock: boolean;
    model?: string;
    branch?: string;
    permissionMode?: PermissionMode;
  }) => Promise<void>;
  selectAgent: (id: string) => void;
  answerPermission: (req: PermissionRequestMsg, decision: PermissionDecision) => Promise<void>;
  sendInput: (id: string, text: string, images?: ImageInput[]) => Promise<void>;
  setPermissionMode: (id: string, mode: PermissionMode) => Promise<void>;
  interruptAgent: (id: string) => Promise<void>;
  stopAgent: (id: string, removeWorktree: boolean) => Promise<void>;
  createPr: (id: string) => Promise<void>;
  syncBranch: (id: string) => Promise<void>;
  integratePr: (id: string) => Promise<void>;
  runGate: (id: string) => Promise<void>;
  pollProject: () => Promise<void>;
  resumeAgent: (r: ResumableAgent) => Promise<void>;
}

function slugifyBranch(label: string): string {
  const slug = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return `mads/${slug || "task"}`;
}

export const useStore = create<MadsState>((set) => {
  function patchAgent(id: string, patch: Partial<AgentVM>) {
    set((s) => {
      const a = s.agents[id];
      if (!a) return {};
      return { agents: { ...s.agents, [id]: { ...a, ...patch, lastEventAt: Date.now() } } };
    });
  }

  function handleSidecarMessage(msg: SidecarMessage) {
    switch (msg.type) {
      case "sidecar_ready":
        set({ sidecar: { status: "ready", sdkAvailable: msg.sdkAvailable, sdkVersion: msg.sdkVersion } });
        break;

      case "project_resolved":
        set({ project: msg.project, projectStatus: "ready" });
        break;

      case "status_update":
        patchAgent(msg.agentId, { status: msg.status, currentStep: msg.currentStep });
        break;

      case "cost_update":
        patchAgent(msg.agentId, { costUsd: msg.totalCostUsd, numTurns: msg.numTurns });
        break;

      case "worktree_created":
        patchAgent(msg.agentId, { branch: msg.branch, worktreePath: msg.path });
        writeLine(msg.agentId, `${C.dim}⌥ worktree ${msg.path} (${msg.branch} off ${msg.baseRef})${C.reset}`);
        break;

      case "git_status":
        patchAgent(msg.agentId, { behind: msg.behind, ahead: msg.ahead, dirty: msg.dirty });
        break;

      case "pr_update":
        patchAgent(msg.agentId, { pr: msg.pr });
        break;

      case "merge_result":
        if (msg.ok) {
          writeLine(
            msg.agentId,
            `${C.green}${C.bold}✔ PR${msg.prNumber ? ` #${msg.prNumber}` : ""} nach main gemerged${C.reset}`,
          );
        } else {
          writeLine(
            msg.agentId,
            `${C.red}${C.bold}⛔ Merge blockiert:${C.reset}${C.red} ${msg.reasons.join(" · ")}${C.reset}`,
          );
        }
        break;

      case "gate_result":
        patchAgent(msg.agentId, { gate: { ok: msg.ok, steps: msg.steps } });
        writeLine(
          msg.agentId,
          `${C.bold}${msg.ok ? C.green : C.red}▣ Clean-Code-Gate: ${msg.ok ? "grün" : "rot"}${C.reset}`,
        );
        for (const st of msg.steps) {
          const icon = st.status === "pass" ? `${C.green}✓` : st.status === "fail" ? `${C.red}✖` : `${C.dim}–`;
          writeLine(
            msg.agentId,
            `  ${icon} ${st.name}${C.reset}${st.summary ? ` ${C.dim}${st.summary}${C.reset}` : ""}`,
          );
        }
        break;

      case "resumable_agents":
        set({ resumables: msg.agents });
        break;

      case "collision_warning":
        set({ collisions: msg.collisions });
        break;

      case "agent_event": {
        const ev = msg.event;
        if (ev.kind === "assistant_text" || ev.kind === "assistant_delta") {
          writeLine(msg.agentId, ev.text);
        } else if (ev.kind === "thinking") {
          writeLine(msg.agentId, `${C.dim}· ${ev.text}${C.reset}`);
        } else if (ev.kind === "tool_use") {
          const arg = ev.input?.command ?? ev.input?.path ?? "";
          writeLine(msg.agentId, `${C.cyan}⏵ ${ev.name}${C.reset}${arg ? ` ${C.dim}${String(arg)}${C.reset}` : ""}`);
        } else if (ev.kind === "tool_result") {
          writeLine(msg.agentId, `${C.dim}  ↳ ${ev.ok ? "ok" : "fehler"}${ev.summary ? `: ${ev.summary}` : ""}${C.reset}`);
        }
        break;
      }

      case "needs_input":
        patchAgent(msg.agentId, { status: "waiting_input" });
        writeLine(msg.agentId, `${C.yellow}● wartet auf dich${msg.message ? `: ${msg.message}` : ""}${C.reset}`);
        break;

      case "permission_request":
        patchAgent(msg.agentId, { status: "waiting_input" });
        writeLine(msg.agentId, `${C.yellow}${C.bold}● Erlaubnis erforderlich:${C.reset}${C.yellow} ${msg.toolName}${C.reset}`);
        set((s) => ({ permissions: [...s.permissions.filter((p) => p.requestId !== msg.requestId), msg] }));
        break;

      case "agent_done":
        patchAgent(msg.agentId, {
          status: msg.isError ? "error" : "done",
          costUsd: msg.totalCostUsd,
          numTurns: msg.numTurns,
        });
        writeLine(
          msg.agentId,
          `${msg.isError ? C.red : C.green}${C.bold}■ ${msg.isError ? "Fehler" : "fertig"}${C.reset} ${C.dim}(${msg.numTurns} turns, $${msg.totalCostUsd.toFixed(4)})${C.reset}`,
        );
        break;

      case "error":
        if (msg.agentId) {
          // recoverable = Eskalation (sichtbar, behebbar); sonst harter Fehler
          patchAgent(msg.agentId, { status: msg.recoverable ? "escalation" : "error" });
          writeLine(msg.agentId, `${C.red}✖ ${msg.code}: ${msg.message}${C.reset}`);
        }
        set((s) => ({
          // dedupe je agentId+code (letzter gewinnt)
          escalations: [...s.escalations.filter((e) => !(e.agentId === msg.agentId && e.code === msg.code)), msg],
        }));
        break;
    }
  }

  function handleChannelEvent(e: SidecarChannelEvent) {
    if (e.type === "line") {
      let parsed: SidecarMessage;
      try {
        parsed = JSON.parse(e.line) as SidecarMessage;
      } catch {
        set((s) => ({ debugLog: [...s.debugLog.slice(-400), `bad json: ${e.line}`] }));
        return;
      }
      handleSidecarMessage(parsed);
    } else if (e.type === "stderr") {
      set((s) => ({ debugLog: [...s.debugLog.slice(-400), e.line] }));
    } else if (e.type === "exit") {
      set({ sidecar: { status: "down", sdkAvailable: false } });
    }
  }

  return {
    sidecar: { status: "down", sdkAvailable: false },
    project: undefined,
    projectStatus: "none",
    agents: {},
    order: [],
    permissions: [],
    escalations: [],
    resumables: [],
    collisions: [],
    autonomy: { autoSync: true, collisionScan: true },
    selectedId: undefined,
    debugLog: [],

    setAutonomy: async (config) => {
      set({ autonomy: config });
      await sendHost({ ...envelope(), type: "set_autonomy", config });
    },

    init: async () => {
      set({ sidecar: { status: "starting", sdkAvailable: false } });
      try {
        await startSidecar(handleChannelEvent);
      } catch (e) {
        set((s) => ({
          sidecar: { status: "error", sdkAvailable: false },
          debugLog: [...s.debugLog, `start_sidecar fehlgeschlagen: ${String(e)}`],
        }));
      }
    },

    openProject: async () => {
      const repoRoot = await pickFolder();
      if (!repoRoot) return;
      set({ projectStatus: "opening" });
      await sendHost({ ...envelope(), type: "open_project", projectId: crypto.randomUUID(), repoRoot });
    },

    createAgent: async ({ label, prompt, role, mock, model, branch, permissionMode }) => {
      const id = crypto.randomUUID();
      const mode: PermissionMode = permissionMode ?? "acceptEdits";
      const project = useStore.getState().project;
      const agent: AgentVM = {
        id,
        label,
        role,
        status: "starting",
        costUsd: 0,
        numTurns: 0,
        mock,
        permissionMode: mode,
        createdAt: Date.now(),
        lastEventAt: Date.now(),
        behind: 0,
        ahead: 0,
        dirty: false,
      };
      set((s) => ({ agents: { ...s.agents, [id]: agent }, order: [...s.order, id], selectedId: id }));
      writeLine(id, `${C.magenta}${C.bold}▌ ${label}${C.reset} ${C.dim}(${role}${mock ? ", mock" : ""})${C.reset}`);
      writeLine(id, `${C.dim}› ${prompt}${C.reset}`);

      // Echter Agent + Projekt vorhanden → eigener Worktree/Branch.
      const useWorktree = !mock && !!project && role === "sub";
      const finalBranch = branch?.trim() || slugifyBranch(label);
      await sendHost({
        ...envelope(),
        type: "start_agent",
        agentId: id,
        prompt,
        label,
        role,
        model,
        mock,
        permissionMode: mode,
        ...(useWorktree && project
          ? { repoRoot: project.repoRoot, branch: finalBranch, baseRef: `origin/${project.defaultBranch}` }
          : project && !mock
            ? { cwd: project.repoRoot } // Integrator: Haupt-Checkout (kein eigener Worktree)
            : {}),
      });
    },

    selectAgent: (id) => set({ selectedId: id }),

    answerPermission: async (req, decision) => {
      set((s) => ({ permissions: s.permissions.filter((p) => p.requestId !== req.requestId) }));
      patchAgent(req.agentId, { status: "running" });
      await sendHost({ ...envelope(), type: "answer_permission", agentId: req.agentId, requestId: req.requestId, decision });
    },

    sendInput: async (id, text, images) => {
      const tag = images && images.length ? ` ${C.dim}[+${images.length} Bild]${C.reset}` : "";
      writeLine(id, `${C.dim}› ${text}${C.reset}${tag}`);
      patchAgent(id, { status: "running" });
      await sendHost({ ...envelope(), type: "send_input", agentId: id, text, images });
    },

    setPermissionMode: async (id, mode) => {
      patchAgent(id, { permissionMode: mode });
      writeLine(id, `${C.dim}⚙ Permission-Modus: ${mode}${C.reset}`);
      await sendHost({ ...envelope(), type: "set_permission_mode", agentId: id, mode });
    },

    interruptAgent: async (id) => {
      await sendHost({ ...envelope(), type: "interrupt_agent", agentId: id });
    },

    stopAgent: async (id, removeWorktree) => {
      await sendHost({ ...envelope(), type: "stop_agent", agentId: id, removeWorktree });
      set((s) => {
        const agents = { ...s.agents };
        delete agents[id];
        const order = s.order.filter((x) => x !== id);
        return { agents, order, selectedId: s.selectedId === id ? order[0] : s.selectedId };
      });
    },

    createPr: async (id) => {
      const a = useStore.getState().agents[id];
      writeLine(id, `${C.cyan}⏵ gh pr create${C.reset}`);
      await sendHost({ ...envelope(), type: "create_pr", agentId: id, title: a ? `mads: ${a.label}` : undefined });
    },

    syncBranch: async (id) => {
      writeLine(id, `${C.cyan}⏵ sync (rebase onto origin)${C.reset}`);
      await sendHost({ ...envelope(), type: "sync_branch", agentId: id });
    },

    integratePr: async (id) => {
      writeLine(id, `${C.magenta}${C.bold}⏵ Integrieren${C.reset}${C.magenta} (gh pr merge --squash --delete-branch)${C.reset}`);
      await sendHost({ ...envelope(), type: "integrate_pr", agentId: id, method: "squash" });
    },

    runGate: async (id) => {
      writeLine(id, `${C.cyan}⏵ Clean-Code-Gate…${C.reset}`);
      await sendHost({ ...envelope(), type: "gate_task", agentId: id });
    },

    pollProject: async () => {
      await sendHost({ ...envelope(), type: "poll_project" });
    },

    resumeAgent: async (r) => {
      const project = useStore.getState().project;
      const agent: AgentVM = {
        id: r.agentId,
        label: r.label,
        role: r.role,
        status: "starting",
        costUsd: 0,
        numTurns: 0,
        sessionId: r.sessionId,
        mock: false,
        permissionMode: "acceptEdits",
        createdAt: Date.now(),
        lastEventAt: Date.now(),
        branch: r.branch,
        worktreePath: r.worktreePath,
        behind: 0,
        ahead: 0,
        dirty: false,
      };
      set((s) => ({
        agents: { ...s.agents, [r.agentId]: agent },
        order: s.order.includes(r.agentId) ? s.order : [...s.order, r.agentId],
        selectedId: r.agentId,
        resumables: s.resumables.filter((x) => x.agentId !== r.agentId),
      }));
      writeLine(r.agentId, `${C.magenta}${C.bold}▌ ${r.label}${C.reset} ${C.dim}(fortgesetzt${r.branch ? ` · ${r.branch}` : ""})${C.reset}`);
      await sendHost({
        ...envelope(),
        type: "start_agent",
        agentId: r.agentId,
        prompt: "Setze die Arbeit fort. Fasse zuerst kurz den aktuellen Stand zusammen, dann mach weiter.",
        label: r.label,
        role: r.role,
        model: r.model,
        mock: false,
        permissionMode: "acceptEdits",
        resumeSessionId: r.sessionId,
        resumeWorktreePath: r.worktreePath,
        repoRoot: project?.repoRoot,
        branch: r.branch,
      });
    },
  };
});
