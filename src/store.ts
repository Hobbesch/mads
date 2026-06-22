/**
 * mads UI-Store (zustand).
 *
 * Single Source of Truth (docs/design/01-architecture.md §5.3): der Sidecar-Pool ist
 * autoritativ; dieser Store SPIEGELT nur die über den Channel gemeldeten Events.
 *
 * Anzeige: strukturierte Nachrichten-Timeline pro Agent (`events`), gerendert im
 * VS-Code-Claude-Code-Stil (MessageTimeline).
 */
import { create } from "zustand";
import { startSidecar, sendHost, envelope, pickFolder } from "./ipc";
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
import { loadRecentProjects, rememberProject, forgetProject, type RecentProject } from "./recent";
import { toolCommand } from "./toolText";

export type AgentRole = "integrator" | "sub";

export interface TodoItem {
  content: string;
  status: string; // "pending" | "in_progress" | "completed"
  activeForm?: string;
}

export type NoticeTone = "info" | "warn" | "err" | "ok" | "accent";

export type TimelineEvent =
  | { id: string; kind: "user"; text: string; images?: number }
  | { id: string; kind: "assistant"; text: string }
  | { id: string; kind: "thinking"; text: string }
  | {
      id: string;
      kind: "tool";
      toolUseId: string;
      name: string;
      description?: string;
      command?: string;
      output?: string;
      ok?: boolean;
      running: boolean;
    }
  | { id: string; kind: "todos"; todos: TodoItem[] }
  | { id: string; kind: "notice"; tone: NoticeTone; text: string };

export interface AgentVM {
  id: string;
  label: string;
  role: AgentRole;
  status: AgentStatus;
  currentStep?: string;
  costUsd: number;
  numTurns: number;
  inputTokens: number;
  outputTokens: number;
  sessionId?: string;
  mock: boolean;
  permissionMode: PermissionMode;
  createdAt: number;
  lastEventAt: number;
  /** Zeitpunkt, ab dem der aktuelle aktive Lauf zählt (für die Laufzeit-Anzeige). */
  workStartedAt?: number;
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
  recentProjects: RecentProject[];
  agents: Record<string, AgentVM>;
  order: string[];
  events: Record<string, TimelineEvent[]>;
  permissions: PermissionRequestMsg[];
  escalations: SidecarErrorMsg[];
  resumables: ResumableAgent[];
  collisions: Collision[];
  autonomy: AutonomyConfig;
  selectedId?: string;
  debugLog: string[];
  /** Offener „Parallel starten"-Picker (nach Anforderung der Integrator-Einschätzung). */
  parallelPicker?: { agentId: string; options: { label: string; description: string }[] };

  init: () => Promise<void>;
  setAutonomy: (config: AutonomyConfig) => Promise<void>;
  openProject: () => Promise<void>;
  openRecentProject: (repoRoot: string) => Promise<void>;
  forgetRecentProject: (repoRoot: string) => void;
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
  requestParallelAssessment: (req: PermissionRequestMsg) => Promise<void>;
  spawnParallelStreams: (picks: { label: string; brief: string }[]) => Promise<void>;
  cancelParallelPicker: () => void;
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

const mkId = () => crypto.randomUUID();

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

  function pushEvent(agentId: string, ev: TimelineEvent) {
    set((s) => {
      const prev = s.events[agentId] ?? [];
      const next = [...prev, ev];
      if (next.length > 800) next.splice(0, next.length - 800); // Ringpuffer
      return { events: { ...s.events, [agentId]: next } };
    });
  }

  function notice(agentId: string, tone: NoticeTone, text: string) {
    pushEvent(agentId, { id: mkId(), kind: "notice", tone, text });
  }

  function completeTool(agentId: string, toolUseId: string, output: string | undefined, ok: boolean) {
    set((s) => {
      const list = s.events[agentId];
      if (!list) return {};
      let found = false;
      const next = list.map((e) => {
        if (e.kind === "tool" && e.toolUseId === toolUseId) {
          found = true;
          return { ...e, output, ok, running: false };
        }
        return e;
      });
      if (!found) {
        next.push({ id: mkId(), kind: "tool", toolUseId, name: "Tool", output, ok, running: false });
      }
      return { events: { ...s.events, [agentId]: next } };
    });
  }

  function handleSidecarMessage(msg: SidecarMessage) {
    switch (msg.type) {
      case "sidecar_ready": {
        set({ sidecar: { status: "ready", sdkAvailable: msg.sdkAvailable, sdkVersion: msg.sdkVersion } });
        // Beim Start das zuletzt geöffnete Projekt automatisch wiederöffnen, damit man
        // nach App-Neustart/Release nicht jedes Mal neu suchen muss.
        const st = useStore.getState();
        if (!st.project && st.projectStatus === "none" && st.recentProjects.length > 0) {
          void st.openRecentProject(st.recentProjects[0].repoRoot);
        }
        break;
      }

      case "project_resolved":
        set((s) => ({
          project: msg.project,
          projectStatus: "ready",
          recentProjects: rememberProject(s.recentProjects, msg.project, Date.now()),
        }));
        break;

      case "status_update":
        set((s) => {
          const a = s.agents[msg.agentId];
          if (!a) return {};
          const active = msg.status === "running" || msg.status === "starting";
          const workStartedAt = active ? (a.workStartedAt ?? Date.now()) : undefined;
          return {
            agents: {
              ...s.agents,
              [msg.agentId]: { ...a, status: msg.status, currentStep: msg.currentStep, workStartedAt, lastEventAt: Date.now() },
            },
          };
        });
        break;

      case "cost_update":
        patchAgent(msg.agentId, {
          costUsd: msg.totalCostUsd,
          numTurns: msg.numTurns,
          ...(msg.inputTokens !== undefined ? { inputTokens: msg.inputTokens } : {}),
          ...(msg.outputTokens !== undefined ? { outputTokens: msg.outputTokens } : {}),
        });
        break;

      case "worktree_created":
        patchAgent(msg.agentId, { branch: msg.branch, worktreePath: msg.path });
        notice(msg.agentId, "info", `Worktree ${msg.branch} (off ${msg.baseRef})`);
        break;

      case "git_status":
        patchAgent(msg.agentId, { behind: msg.behind, ahead: msg.ahead, dirty: msg.dirty });
        break;

      case "pr_update":
        patchAgent(msg.agentId, { pr: msg.pr });
        break;

      case "merge_result":
        notice(
          msg.agentId,
          msg.ok ? "ok" : "err",
          msg.ok
            ? `✔ PR${msg.prNumber ? ` #${msg.prNumber}` : ""} nach main gemerged`
            : `⛔ Merge blockiert: ${msg.reasons.join(" · ")}`,
        );
        break;

      case "gate_result":
        patchAgent(msg.agentId, { gate: { ok: msg.ok, steps: msg.steps } });
        notice(
          msg.agentId,
          msg.ok ? "ok" : "err",
          `Clean-Code-Gate: ${msg.ok ? "grün" : "rot"} — ${msg.steps.map((s) => `${s.name}:${s.status}`).join(", ")}`,
        );
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
          if (ev.text.trim()) pushEvent(msg.agentId, { id: mkId(), kind: "assistant", text: ev.text });
        } else if (ev.kind === "thinking") {
          pushEvent(msg.agentId, { id: mkId(), kind: "thinking", text: ev.text });
        } else if (ev.kind === "tool_use") {
          if (ev.name === "TodoWrite") {
            const todos = ((ev.input?.todos as TodoItem[]) ?? []).map((t) => ({
              content: String(t.content ?? ""),
              status: String(t.status ?? "pending"),
              activeForm: t.activeForm,
            }));
            pushEvent(msg.agentId, { id: mkId(), kind: "todos", todos });
          } else {
            pushEvent(msg.agentId, {
              id: mkId(),
              kind: "tool",
              toolUseId: ev.toolUseId,
              name: ev.name,
              description: typeof ev.input?.description === "string" ? ev.input.description : undefined,
              command: toolCommand(ev.input ?? {}),
              running: true,
            });
          }
        } else if (ev.kind === "tool_result") {
          completeTool(msg.agentId, ev.toolUseId, ev.output ?? ev.summary, ev.ok);
        }
        break;
      }

      case "needs_input":
        patchAgent(msg.agentId, { status: "waiting_input" });
        notice(msg.agentId, "warn", `● wartet auf dich${msg.message ? `: ${msg.message}` : ""}`);
        break;

      case "permission_request":
        patchAgent(msg.agentId, { status: "waiting_input" });
        notice(msg.agentId, "warn", `● Erlaubnis erforderlich: ${msg.toolName}`);
        set((s) => ({ permissions: [...s.permissions.filter((p) => p.requestId !== msg.requestId), msg] }));
        break;

      case "agent_done":
        patchAgent(msg.agentId, {
          status: msg.isError ? "error" : "done",
          costUsd: msg.totalCostUsd,
          numTurns: msg.numTurns,
        });
        notice(
          msg.agentId,
          msg.isError ? "err" : "ok",
          `${msg.isError ? "■ Fehler" : "■ fertig"} (${msg.numTurns} turns, $${msg.totalCostUsd.toFixed(4)})`,
        );
        break;

      case "error":
        if (msg.agentId) {
          patchAgent(msg.agentId, { status: msg.recoverable ? "escalation" : "error" });
          notice(msg.agentId, "err", `✖ ${msg.code}: ${msg.message}`);
        } else if (useStore.getState().projectStatus === "opening") {
          // Projekt-Öffnung fehlgeschlagen (z.B. zuletzt geöffneter Ordner existiert nicht
          // mehr) — Status zurücksetzen, sonst hängt die UI auf "öffne…".
          set({ projectStatus: "error" });
        }
        set((s) => ({
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
    recentProjects: loadRecentProjects(),
    agents: {},
    order: [],
    events: {},
    permissions: [],
    escalations: [],
    resumables: [],
    collisions: [],
    autonomy: { autoSync: true, collisionScan: true },
    selectedId: undefined,
    debugLog: [],
    parallelPicker: undefined,

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

    openRecentProject: async (repoRoot) => {
      set({ projectStatus: "opening" });
      await sendHost({ ...envelope(), type: "open_project", projectId: crypto.randomUUID(), repoRoot });
    },

    forgetRecentProject: (repoRoot) => {
      set((s) => ({ recentProjects: forgetProject(s.recentProjects, repoRoot) }));
    },

    createAgent: async ({ label, prompt, role, mock, model, branch, permissionMode }) => {
      const id = crypto.randomUUID();
      const mode: PermissionMode = permissionMode ?? "auto";
      const project = useStore.getState().project;
      const agent: AgentVM = {
        id,
        label,
        role,
        status: "starting",
        costUsd: 0,
        numTurns: 0,
        inputTokens: 0,
        outputTokens: 0,
        mock,
        permissionMode: mode,
        createdAt: Date.now(),
        lastEventAt: Date.now(),
        workStartedAt: Date.now(),
        behind: 0,
        ahead: 0,
        dirty: false,
      };
      set((s) => ({ agents: { ...s.agents, [id]: agent }, order: [...s.order, id], selectedId: id }));
      pushEvent(id, { id: mkId(), kind: "user", text: prompt });

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
            ? { cwd: project.repoRoot }
            : {}),
      });
    },

    selectAgent: (id) => set({ selectedId: id }),

    answerPermission: async (req, decision) => {
      set((s) => ({ permissions: s.permissions.filter((p) => p.requestId !== req.requestId) }));
      patchAgent(req.agentId, { status: "running", workStartedAt: Date.now() });
      await sendHost({ ...envelope(), type: "answer_permission", agentId: req.agentId, requestId: req.requestId, decision });
    },

    requestParallelAssessment: async (req) => {
      // Optionen der Frage merken und den Integrator um eine Unabhängigkeits-Einschätzung
      // bitten (er startet selbst nichts). Danach wählt der Nutzer im Parallel-Picker.
      const options = (req.questions ?? []).flatMap((q) =>
        (q.options ?? []).map((o) => ({ label: o.label, description: o.description })),
      );
      const instruction =
        "Der Nutzer möchte mehrere der gerade vorgeschlagenen Optionen PARALLEL bearbeiten lassen — " +
        "je in einem eigenen git-Worktree/Branch (eigene Sub-Agenten).\n" +
        "Beurteile ZUERST, welche der Optionen voneinander UNABHÄNGIG sind (gleichzeitig bearbeitbar, " +
        "ohne sich gegenseitig zu beeinflussen: keine geteilten Dateien/Funktionen, keine Reihenfolge-/" +
        "Ergebnis-Abhängigkeit). Gib pro Option kurz an: unabhängig ja/nein + 1 Satz Begründung, " +
        "und für die unabhängigen je einen knappen Aufgaben-Brief für einen Sub-Agenten.\n" +
        "Starte selbst KEINE Arbeit und rufe das Frage-Tool nicht erneut auf — der Nutzer wählt anhand " +
        "deiner Einschätzung aus.";
      set((s) => ({
        permissions: s.permissions.filter((p) => p.requestId !== req.requestId),
        parallelPicker: { agentId: req.agentId, options },
      }));
      patchAgent(req.agentId, { status: "running", workStartedAt: Date.now() });
      await sendHost({
        ...envelope(),
        type: "answer_permission",
        agentId: req.agentId,
        requestId: req.requestId,
        decision: { behavior: "answer_questions", answers: {}, response: instruction },
      });
    },

    spawnParallelStreams: async (picks) => {
      const create = useStore.getState().createAgent;
      for (const p of picks) {
        await create({ label: p.label, prompt: p.brief, role: "sub", mock: false, permissionMode: "auto" });
      }
      set({ parallelPicker: undefined });
    },

    cancelParallelPicker: () => set({ parallelPicker: undefined }),

    sendInput: async (id, text, images) => {
      pushEvent(id, { id: mkId(), kind: "user", text, images: images?.length });
      patchAgent(id, { status: "running", workStartedAt: Date.now() });
      await sendHost({ ...envelope(), type: "send_input", agentId: id, text, images });
    },

    setPermissionMode: async (id, mode) => {
      patchAgent(id, { permissionMode: mode });
      notice(id, "accent", `⚙ Permission-Modus: ${mode}`);
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
        const events = { ...s.events };
        delete events[id];
        const order = s.order.filter((x) => x !== id);
        return { agents, events, order, selectedId: s.selectedId === id ? order[0] : s.selectedId };
      });
    },

    createPr: async (id) => {
      const a = useStore.getState().agents[id];
      notice(id, "accent", "▶ PR erstellen (gh pr create)");
      await sendHost({ ...envelope(), type: "create_pr", agentId: id, title: a ? `mads: ${a.label}` : undefined });
    },

    syncBranch: async (id) => {
      notice(id, "accent", "▶ Sync (rebase onto origin/main)");
      await sendHost({ ...envelope(), type: "sync_branch", agentId: id });
    },

    integratePr: async (id) => {
      notice(id, "accent", "▶ Integrieren (gh pr merge --squash --delete-branch)");
      await sendHost({ ...envelope(), type: "integrate_pr", agentId: id, method: "squash" });
    },

    runGate: async (id) => {
      notice(id, "accent", "▶ Clean-Code-Gate…");
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
        inputTokens: 0,
        outputTokens: 0,
        sessionId: r.sessionId,
        mock: false,
        permissionMode: "auto",
        createdAt: Date.now(),
        lastEventAt: Date.now(),
        workStartedAt: Date.now(),
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
      notice(r.agentId, "accent", `↩︎ fortgesetzt${r.branch ? ` · ${r.branch}` : ""}`);
      await sendHost({
        ...envelope(),
        type: "start_agent",
        agentId: r.agentId,
        prompt: "Setze die Arbeit fort. Fasse zuerst kurz den aktuellen Stand zusammen, dann mach weiter.",
        label: r.label,
        role: r.role,
        model: r.model,
        mock: false,
        permissionMode: "auto",
        resumeSessionId: r.sessionId,
        resumeWorktreePath: r.worktreePath,
        repoRoot: project?.repoRoot,
        branch: r.branch,
      });
    },
  };
});
