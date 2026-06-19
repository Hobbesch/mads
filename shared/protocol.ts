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
  | OpenProjectMsg
  | SetProjectMsg
  | StartAgentMsg
  | SendInputMsg
  | AnswerPermissionMsg
  | InterruptAgentMsg
  | SetPermissionModeMsg
  | StopAgentMsg
  | CreatePrMsg
  | SyncBranchMsg
  | PollProjectMsg
  | ShutdownMsg;

export interface ProjectInfo {
  projectId: string;
  repoRoot: string; // absoluter Pfad zum Haupt-Checkout (z.B. das PAIX-Repo)
  owner: string; // GitHub owner (aus origin-Remote)
  repo: string; // GitHub repo
  defaultBranch: string; // i.d.R. "main"
}

export interface SetProjectMsg extends BaseMsg {
  type: "set_project";
  project: ProjectInfo;
}

/** Ordner auswählen → Sidecar löst owner/repo/defaultBranch via git/gh auf. */
export interface OpenProjectMsg extends BaseMsg {
  type: "open_project";
  projectId: string;
  repoRoot: string;
}

export interface StartAgentMsg extends BaseMsg {
  type: "start_agent";
  agentId: string;
  prompt: string;
  cwd?: string; // explizit; sonst wird aus repoRoot+branch ein Worktree erzeugt
  repoRoot?: string; // P3: Worktree aus diesem Repo anlegen
  branch?: string; // P3: feat/<task> für den Worktree
  baseRef?: string; // P3: i.d.R. "origin/<defaultBranch>"
  model?: string;
  permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions" | "dontAsk";
  allowedTools?: string[];
  disallowedTools?: string[];
  resumeSessionId?: string;
  forkSession?: boolean;
  /** Demo ohne echte Claude-Auth: scripted Stream statt query(). */
  mock?: boolean;
}

export interface CreatePrMsg extends BaseMsg {
  type: "create_pr";
  agentId: string;
  title?: string;
  body?: string;
  draft?: boolean;
}

export interface SyncBranchMsg extends BaseMsg {
  type: "sync_branch"; // rebase onto origin/<default> + force-with-lease (stale-base-Killer)
  agentId: string;
}

export interface PollProjectMsg extends BaseMsg {
  type: "poll_project"; // git-/PR-Status aller Agenten jetzt aktualisieren
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
  | ProjectResolvedMsg
  | AgentEventMsg
  | NeedsInputMsg
  | PermissionRequestMsg
  | StatusUpdateMsg
  | CostUpdateMsg
  | AgentDoneMsg
  | WorktreeCreatedMsg
  | GitStatusMsg
  | PrUpdateMsg
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

export interface ProjectResolvedMsg extends BaseMsg {
  type: "project_resolved";
  project: ProjectInfo;
}

export interface WorktreeCreatedMsg extends BaseMsg {
  type: "worktree_created";
  agentId: string;
  path: string;
  branch: string;
  baseRef: string;
}

export interface GitStatusMsg extends BaseMsg {
  type: "git_status";
  agentId: string;
  behind: number; // commits hinter origin/<default> (stale-base-Badge)
  ahead: number;
  dirty: boolean;
}

export type PrChecksState = "SUCCESS" | "FAILURE" | "PENDING" | "ERROR" | "EXPECTED" | null;
export type MergeStateStatus =
  | "BEHIND"
  | "BLOCKED"
  | "CLEAN"
  | "DIRTY"
  | "DRAFT"
  | "HAS_HOOKS"
  | "UNKNOWN"
  | "UNSTABLE";

export interface PullRequestInfo {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  headRefName: string;
  mergeable: "CONFLICTING" | "MERGEABLE" | "UNKNOWN";
  mergeStateStatus: MergeStateStatus;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  checksState: PrChecksState;
}

export interface PrUpdateMsg extends BaseMsg {
  type: "pr_update";
  agentId: string;
  pr: PullRequestInfo;
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
  | "ownership_trespass" // Agent editiert eine Region, die einem anderen Stream gehört
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
// Region-Ownership & Koordination (docs/design/06-ownership-and-coordination.md)
//
// Datei-grobes Ownership reicht nicht: zwei Streams dürfen DIESELBE Datei in
// VERSCHIEDENEN Funktionen anfassen. Eine OwnershipRule ankert deshalb auf
// Symbol/Pattern (NICHT Zeile — Zeilen driften). Konfliktvermeidungs-Klassen
// aus _paix-multi-agent-reference §6 / _paix-ownership-reference.
// ============================================================================
export type OwnershipKind =
  | "exclusive" // gehört einem Stream allein (ganze Datei oder benannte Symbole)
  | "shared_seam" // geteilte Region, genau EINEM Owner zugewiesen; andere fassen sie nicht an
  | "land_first"; // unvermeidbarer geteilter Edit → erst als winziger PR auf main landen

export interface OwnershipRule {
  id: string;
  path: string; // Datei oder Glob, z.B. "src/mail/pst/**" oder "src/mail/mail.py"
  symbols?: string[]; // Funktions-/Symbol-Anker innerhalb der Datei (bevorzugt vor lineHint)
  pattern?: string; // Regex-Heuristik für eine Region (z.B. "is_pst"-Branches)
  lineHint?: [number, number]; // optionaler Zeilen-Hinweis — driftet, nur informativ
  ownerAgentId?: string; // der Single-Owner-Stream (undefined = frei/unowned)
  ownerBranch?: string;
  kind: OwnershipKind;
  note?: string;
}

export interface CoordinationArtifact {
  id: string;
  projectId: string;
  path: string; // committet unter docs/coordination/<name>.md (transient)
  streams: string[]; // teilnehmende agentIds/branches
  baseCommit: string; // Branch-Punkt-Anker
  rules: OwnershipRule[];
  status: "active" | "resolved"; // resolved → Artefakt nach Merge beider löschen
  createdAt: number;
}

/** Eine geänderte Region eines Agenten (aus git-diff: Datei + umgebende Symbole). */
export interface ChangedRegion {
  path: string;
  symbols: string[];
}

// ============================================================================
// Rust-Core -> Frontend (Channel-Payload). Der Core forwarded rohe Zeilen.
// ============================================================================
export type SidecarChannelEvent =
  | { type: "line"; line: string } // eine NDJSON-Zeile (zu SidecarMessage parsen)
  | { type: "stderr"; line: string } // Sidecar-Log (Diagnose)
  | { type: "exit"; code: number | null };
