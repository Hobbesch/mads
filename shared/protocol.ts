/**
 * mads — gemeinsames Protokoll (Single Source of Truth für die Typen).
 *
 * Zwei Transport-Ebenen (siehe docs/design/01-architecture.md §6):
 *   Frontend  ──invoke('sidecar_send', line)──►  Rust-Core  ──NDJSON(stdin)──►  Sidecar
 *   Frontend  ◄──Channel<SidecarEvent>──────────  Rust-Core  ◄─NDJSON(stdout)──  Sidecar
 *
 * Der Rust-Core ist bewusst "dumm": er forwarded NDJSON-Zeilen 1:1. Die
 * Protokoll-Semantik (HostMessage/SidecarMessage) lebt in TS — geteilt zwischen
 * Sidecar und Frontend, damit beide denselben Vertrag sprechen.
 */

export const PROTOCOL_VERSION = 1 as const;

export type AgentStatus =
  | "starting"
  | "running"
  | "waiting_input"
  | "paused"
  | "escalation"
  | "error"
  | "done"
  | "queued";

export interface BaseMsg {
  v: typeof PROTOCOL_VERSION;
  id: string;
  ts: number;
}

// ============================================================================
// HOST -> SIDECAR
// ============================================================================
export type HostMessage =
  | StartAgentMsg
  | SendInputMsg
  | AnswerPermissionMsg
  | InterruptAgentMsg
  | SetPermissionModeMsg
  | StopAgentMsg
  | ShutdownMsg;

export interface StartAgentMsg extends BaseMsg {
  type: "start_agent";
  agentId: string;
  prompt: string;
  cwd?: string;
  model?: string;
  permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions" | "dontAsk";
  allowedTools?: string[];
  disallowedTools?: string[];
  resumeSessionId?: string;
  forkSession?: boolean;
  /** Demo ohne echte Claude-Auth: scripted Stream statt query(). */
  mock?: boolean;
}

export interface SendInputMsg extends BaseMsg {
  type: "send_input";
  agentId: string;
  text: string;
}

export type PermissionDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; remember?: boolean }
  | { behavior: "deny"; message: string; interrupt?: boolean }
  | { behavior: "answer_questions"; answers: Record<string, string | string[]>; response?: string };

export interface AnswerPermissionMsg extends BaseMsg {
  type: "answer_permission";
  agentId: string;
  requestId: string;
  decision: PermissionDecision;
}

export interface InterruptAgentMsg extends BaseMsg {
  type: "interrupt_agent";
  agentId: string;
}

export interface SetPermissionModeMsg extends BaseMsg {
  type: "set_permission_mode";
  agentId: string;
  mode: "default" | "acceptEdits" | "plan" | "bypassPermissions" | "dontAsk";
}

export interface StopAgentMsg extends BaseMsg {
  type: "stop_agent";
  agentId: string;
  removeWorktree?: boolean;
}

export interface ShutdownMsg extends BaseMsg {
  type: "shutdown";
}

// ============================================================================
// SIDECAR -> HOST
// ============================================================================
export type SidecarMessage =
  | SidecarReadyMsg
  | AgentEventMsg
  | NeedsInputMsg
  | PermissionRequestMsg
  | StatusUpdateMsg
  | CostUpdateMsg
  | AgentDoneMsg
  | SidecarErrorMsg;

export interface SidecarReadyMsg extends BaseMsg {
  type: "sidecar_ready";
  pid: number;
  sdkVersion: string;
  sdkAvailable: boolean;
  resumableAgents: Array<{ agentId: string; sessionId: string; branch?: string }>;
}

export type AgentEvent =
  | { kind: "assistant_text"; text: string }
  | { kind: "assistant_delta"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; toolUseId: string; name: string; input: Record<string, unknown> }
  | { kind: "tool_result"; toolUseId: string; ok: boolean; summary?: string }
  | { kind: "system"; subtype: string; data?: Record<string, unknown> };

export interface AgentEventMsg extends BaseMsg {
  type: "agent_event";
  agentId: string;
  event: AgentEvent;
}

export interface NeedsInputMsg extends BaseMsg {
  type: "needs_input";
  agentId: string;
  reason: "idle_prompt" | "notification" | "permission_prompt";
  message?: string;
}

export interface AskQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string; preview?: string }>;
  multiSelect: boolean;
}

export interface PermissionRequestMsg extends BaseMsg {
  type: "permission_request";
  agentId: string;
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  kind: "tool" | "ask_user_question";
  blockedPath?: string;
  decisionReason?: string;
  questions?: AskQuestion[];
}

export interface StatusUpdateMsg extends BaseMsg {
  type: "status_update";
  agentId: string;
  status: AgentStatus;
  currentStep?: string;
}

export interface CostUpdateMsg extends BaseMsg {
  type: "cost_update";
  agentId: string;
  totalCostUsd: number;
  numTurns: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface AgentDoneMsg extends BaseMsg {
  type: "agent_done";
  agentId: string;
  subtype: "success" | "error_max_turns" | "error_during_execution" | "error_max_budget_usd";
  sessionId?: string;
  resultText?: string;
  totalCostUsd: number;
  numTurns: number;
  isError: boolean;
}

export type EscalationKind =
  | "ci_red"
  | "merge_conflict"
  | "stale_base"
  | "push_rejected"
  | "review_required"
  | "protection_blocked"
  | "auth_broken"
  | "spawn_failed"
  | "consume_failed"
  | "max_budget";

export interface SidecarErrorMsg extends BaseMsg {
  type: "error";
  agentId?: string;
  scope: "agent" | "sidecar";
  code: EscalationKind | string;
  message: string;
  recoverable: boolean;
}

// ============================================================================
// Rust-Core -> Frontend (Channel-Payload). Der Core forwarded rohe Zeilen.
// ============================================================================
export type SidecarChannelEvent =
  | { type: "line"; line: string } // eine NDJSON-Zeile (zu SidecarMessage parsen)
  | { type: "stderr"; line: string } // Sidecar-Log (Diagnose)
  | { type: "exit"; code: number | null };
