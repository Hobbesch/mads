/**
 * mads UI-Store (zustand).
 *
 * WICHTIG (Single Source of Truth, docs/design/01-architecture.md §5.3):
 * Der Sidecar-Pool ist autoritativ für den Agenten-State. Dieser Store ist nur ein
 * SPIEGEL der vom Sidecar gemeldeten Events — er trifft selbst keine Wahrheits-
 * Entscheidungen, sondern rendert, was über den Channel hereinkommt.
 */
import { create } from "zustand";
import { startSidecar, sendHost, envelope } from "./ipc";
import { writeLine } from "./terminal";
import type {
  AgentStatus,
  SidecarMessage,
  SidecarChannelEvent,
  PermissionRequestMsg,
  PermissionDecision,
  SidecarErrorMsg,
} from "../shared/protocol";

// ANSI-Farben für die Terminal-Ausgabe (Claude-Code-ähnlich).
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
  createdAt: number;
  lastEventAt: number;
}

export interface SidecarInfo {
  status: "down" | "starting" | "ready" | "error";
  sdkAvailable: boolean;
  sdkVersion?: string;
}

interface MadsState {
  sidecar: SidecarInfo;
  agents: Record<string, AgentVM>;
  order: string[];
  permissions: PermissionRequestMsg[];
  escalations: SidecarErrorMsg[];
  selectedId?: string;
  debugLog: string[];

  init: () => Promise<void>;
  createAgent: (opts: { label: string; prompt: string; role: AgentRole; mock: boolean; model?: string }) => Promise<void>;
  selectAgent: (id: string) => void;
  answerPermission: (req: PermissionRequestMsg, decision: PermissionDecision) => Promise<void>;
  sendInput: (id: string, text: string) => Promise<void>;
  interruptAgent: (id: string) => Promise<void>;
  stopAgent: (id: string) => Promise<void>;
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

      case "status_update":
        patchAgent(msg.agentId, { status: msg.status, currentStep: msg.currentStep });
        break;

      case "cost_update":
        patchAgent(msg.agentId, { costUsd: msg.totalCostUsd, numTurns: msg.numTurns });
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
          patchAgent(msg.agentId, { status: "error" });
          writeLine(msg.agentId, `${C.red}✖ ${msg.code}: ${msg.message}${C.reset}`);
        }
        set((s) => ({ escalations: [...s.escalations, msg] }));
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
    agents: {},
    order: [],
    permissions: [],
    escalations: [],
    selectedId: undefined,
    debugLog: [],

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

    createAgent: async ({ label, prompt, role, mock, model }) => {
      const id = crypto.randomUUID();
      const agent: AgentVM = {
        id,
        label,
        role,
        status: "starting",
        costUsd: 0,
        numTurns: 0,
        mock,
        createdAt: Date.now(),
        lastEventAt: Date.now(),
      };
      set((s) => ({ agents: { ...s.agents, [id]: agent }, order: [...s.order, id], selectedId: id }));
      writeLine(id, `${C.magenta}${C.bold}▌ ${label}${C.reset} ${C.dim}(${role}${mock ? ", mock" : ""})${C.reset}`);
      writeLine(id, `${C.dim}› ${prompt}${C.reset}`);
      await sendHost({ ...envelope(), type: "start_agent", agentId: id, prompt, model, mock, permissionMode: "default" });
    },

    selectAgent: (id) => set({ selectedId: id }),

    answerPermission: async (req, decision) => {
      set((s) => ({ permissions: s.permissions.filter((p) => p.requestId !== req.requestId) }));
      patchAgent(req.agentId, { status: "running" });
      await sendHost({ ...envelope(), type: "answer_permission", agentId: req.agentId, requestId: req.requestId, decision });
    },

    sendInput: async (id, text) => {
      writeLine(id, `${C.dim}› ${text}${C.reset}`);
      patchAgent(id, { status: "running" });
      await sendHost({ ...envelope(), type: "send_input", agentId: id, text });
    },

    interruptAgent: async (id) => {
      await sendHost({ ...envelope(), type: "interrupt_agent", agentId: id });
    },

    stopAgent: async (id) => {
      await sendHost({ ...envelope(), type: "stop_agent", agentId: id, removeWorktree: false });
      set((s) => {
        const agents = { ...s.agents };
        delete agents[id];
        const order = s.order.filter((x) => x !== id);
        return { agents, order, selectedId: s.selectedId === id ? order[0] : s.selectedId };
      });
    },
  };
});
