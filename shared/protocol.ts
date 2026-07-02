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

import type { Collision } from "./collision";

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

export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions" | "dontAsk";

/** Reasoning-Effort eines Streams. "ultracode" = xhigh-Effort + stehende Workflow-Orchestrierung
 *  (SDK-Session-Flag `ultracode`; oberstes Ende der Skala wie in Claude Code). Sidecar mappt:
 *  low/medium/high/xhigh → options.effort; ultracode → effort "xhigh" + settings.ultracode. */
export type EffortMode = "low" | "medium" | "high" | "xhigh" | "ultracode";

/** Bild-Eingabe (z.B. eingefügter Screenshot) für einen Agenten. */
export interface ImageInput {
  mediaType: string; // z.B. "image/png"
  dataBase64: string;
}

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
  | GateTaskMsg
  | IntegratePrMsg
  | SetAutonomyMsg
  | SetAutopilotMsg
  | SetModelEffortMsg
  | OutsourceMainMsg
  | PollProjectMsg
  | CleanupWorktreeMsg
  | UpdateMainMsg
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
  effort?: EffortMode;
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  resumeSessionId?: string;
  forkSession?: boolean;
  /** Resume (P7): vorhandenen Worktree weiterverwenden statt neu anlegen. */
  resumeWorktreePath?: string;
  /** UI-Kontext für agents.json-Persistenz/Resume. */
  label?: string;
  role?: "integrator" | "sub";
  /** Demo ohne echte Claude-Auth: scripted Stream statt query(). */
  mock?: boolean;
  /** Autopilot-Stufe (Default „assisted"). */
  autopilot?: AutopilotLevel;
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

/** Integrator-Aktion: nur diese Op merged nach main (Invariante 1). Gegated. */
export interface IntegratePrMsg extends BaseMsg {
  type: "integrate_pr";
  agentId: string;
  method?: "squash" | "merge" | "rebase"; // default squash (lineare main)
  /** Branch + Worktree + Stream NACH dem Merge behalten (langlebiger Integrations-Branch):
   *  mergt nach main, setzt den Branch dann auf das frische main zurück (sauberer
   *  Weiterarbeits-Stand) und beendet den Stream NICHT. Default false = mergen + aufräumen. */
  keepBranch?: boolean;
}

/** P6: Clean-Code-Gate im Worktree ausführen (lint/type/test + Secret-Scan). */
export interface GateTaskMsg extends BaseMsg {
  type: "gate_task";
  agentId: string;
}

/**
 * Autopilot-Stufe je Stream (reversible Seite automatisieren, Irreversibles bleibt menschlich):
 * - manual: nichts automatisch (wie früher).
 * - assisted (Default): Commit/Push/PR der reversiblen Arbeit automatisch; NIE mergen/verwerfen.
 * - autopilot: wie assisted + (künftig) Merge-Vorschlagskarte bei grünem Gate.
 */
export type AutopilotLevel = "manual" | "assisted" | "autopilot";

/** Halb-autonomer Integrator: Auto-Sync + Kollisions-Scan an/aus. */
export interface AutonomyConfig {
  autoSync: boolean; // Sub-Branches automatisch onto origin/<default> rebasen
  collisionScan: boolean; // Code-Kollisionen zwischen aktiven Agenten erkennen
  autopilotDefault?: AutopilotLevel; // Default-Stufe für neue Streams (Default: "assisted")
}
export interface SetAutonomyMsg extends BaseMsg {
  type: "set_autonomy";
  config: AutonomyConfig;
}
/** Autopilot-Stufe eines laufenden Streams ändern. */
export interface SetAutopilotMsg extends BaseMsg {
  type: "set_autopilot";
  agentId: string;
  level: AutopilotLevel;
}
/** Modell und/oder Effort eines laufenden Streams LIVE umstellen. Sidecar wendet es ohne Neustart
 *  an: Modell via query.setModel(), Effort/Ultracode via query.applyFlagSettings(). */
export interface SetModelEffortMsg extends BaseMsg {
  type: "set_model_effort";
  agentId: string;
  model?: string;
  effort?: EffortMode;
}
/** Uncommittete Änderungen im Main-Checkout (Integrator) in einen NEUEN Sub-Stream auslagern
 *  (main bleibt sauber; die Änderungen gehen über den normalen PR-Fluss). */
export interface OutsourceMainMsg extends BaseMsg {
  type: "outsource_main";
  integratorId: string;
  agentId: string; // neuer Sub-Stream
  label: string;
  branch: string;
}

export interface PollProjectMsg extends BaseMsg {
  type: "poll_project"; // git-/PR-Status aller Agenten jetzt aktualisieren
}

export interface SendInputMsg extends BaseMsg {
  type: "send_input";
  agentId: string;
  text: string;
  images?: ImageInput[];
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
  mode: PermissionMode;
}

export interface StopAgentMsg extends BaseMsg {
  type: "stop_agent";
  agentId: string;
  removeWorktree?: boolean;
}

/**
 * Verwalteten Zustand bereinigen: Worktree + lokalen Branch eines erledigten
 * (gemergten) Streams entfernen und aus der Resume-Registry nehmen. Wird vom
 * Frontend für „gemergt, aber lokale Reste"-Streams nach Nutzer-Bestätigung
 * gesendet (Reconcile beim Öffnen räumt saubere Fälle bereits selbst auf).
 */
export interface CleanupWorktreeMsg extends BaseMsg {
  type: "cleanup_worktree";
  agentId: string;
  branch?: string;
  worktreePath?: string;
  /**
   * Lokale Reste (ungespeichert/ungepusht) bewusst verwerfen. Der Sidecar weigert
   * sich ohne dieses Flag, einen Worktree mit Resten zu löschen (Schutz vor
   * versehentlichem/wiederholtem Aufruf); das Frontend setzt es erst NACH der
   * Nutzer-Bestätigung des „Aufräumen"-Dialogs.
   */
  force?: boolean;
}

/**
 * Integrator-Aktion: den Haupt-Checkout (main) per fast-forward auf origin/<default>
 * nachziehen. KEIN rebase/force-push (das ist die Sub-Branch-Operation) — nur ein
 * sicherer fast-forward. Antwortet über git_status + eine Notiz im Integrator-Stream.
 */
export interface UpdateMainMsg extends BaseMsg {
  type: "update_main";
  agentId: string;
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
  | MergeResultMsg
  | GateResultMsg
  | ResumableAgentsMsg
  | ReconcileSummaryMsg
  | CollisionWarningMsg
  | SpawnSubstreamsRequestMsg
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
  | { kind: "tool_result"; toolUseId: string; ok: boolean; summary?: string; output?: string }
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
  suggestions?: unknown[]; // Regel-Vorschläge von Claude Code (für „Immer erlauben")
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
  dirty: boolean; // uncommitted ODER untracked (git status --porcelain nicht leer)
  syncBlocked?: boolean; // Auto-Sync wegen Rebase-Konflikt pausiert (autoSyncConflicted)
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
  pr?: PullRequestInfo; // undefined = PR-Status löschen (z. B. nach „Mergen & weiterarbeiten")
}

export interface MergeResultMsg extends BaseMsg {
  type: "merge_result";
  agentId: string;
  ok: boolean; // true = gemerged; false = durch Gate/gh blockiert
  merged: boolean;
  reasons: string[]; // bei !ok: die blockierenden Gründe
  prNumber?: number;
}

// ---- P6: Clean-Code-Gate ----
export type GateStepStatus = "pass" | "fail" | "skip";
export interface GateStep {
  name: string; // z.B. "lint", "type-check", "test", "secret-scan"
  status: GateStepStatus;
  summary?: string; // Kurzfassung (Befehl / erste Fehlerzeile)
}
export interface GateResultMsg extends BaseMsg {
  type: "gate_result";
  agentId: string;
  ok: boolean; // true = kein Step fehlgeschlagen (skips erlaubt)
  steps: GateStep[];
}

// ---- P7: Resume nach App-Neustart ----
export interface ResumableAgent {
  agentId: string;
  label: string;
  role: "integrator" | "sub";
  /** Claude-Session zum echten Fortsetzen; fehlt bei verwaisten Worktrees → frischer Start darin. */
  sessionId?: string;
  branch?: string;
  worktreePath?: string;
  lastPrompt?: string;
  status: AgentStatus;
  model?: string;
  effort?: EffortMode;
  mock: boolean;
  /**
   * GitHub-PR-Zustand des Branches beim Öffnen abgeglichen. Verlässliche „fertig"-
   * Quelle (squash-fest — git-Heuristiken wie `git cherry`/Diff täuschen unter Squash).
   */
  prState?: PullRequestInfo["state"];
  prNumber?: number;
  prUrl?: string;
  /** PR ist gemergt → Stream ist erledigt: NICHT fortsetzen, sondern aufräumen. */
  merged?: boolean;
  /** Worktree hat ungespeicherte oder ungepushte lokale Reste → nicht still löschen. */
  localChanges?: boolean;
}
export interface ResumableAgentsMsg extends BaseMsg {
  type: "resumable_agents";
  agents: ResumableAgent[];
}

/**
 * Einmaliger Abgleich beim Projekt-Öffnen gegen GitHub: was mads automatisch in
 * Ordnung gebracht hat. Treibt einen dismissbaren Hinweis-Banner im Frontend.
 */
export interface ReconcileSummaryMsg extends BaseMsg {
  type: "reconcile_summary";
  /** main (Haupt-Checkout) per fast-forward aktualisiert (Anzahl Commits; 0 = nichts). */
  mainFastForwarded: number;
  /**
   * main lag hinter origin/<default>, konnte aber NICHT automatisch vorgezogen werden
   * (Anzahl Commits). Treibt eine Warnung — sonst arbeitet der Integrator still gegen
   * einen veralteten Stand (genau dieser Fehler trat auf). 0 = kein Problem.
   */
  mainBehind: number;
  /** Grund, weshalb der fast-forward unterblieb (nur gesetzt, wenn mainBehind > 0). */
  mainBlocked: "dirty" | "diverged" | "detached" | "unknown" | null;
  /** automatisch aufgeräumt (PR gemergt + Worktree sauber + nichts ungepusht) — Labels. */
  cleaned: string[];
  /** PR gemergt, aber lokale Reste → zur Hand-Prüfung angeboten statt gelöscht — Labels. */
  residue: string[];
}

/** Laufzeit-Kollisionen zwischen aktiven Agenten (leeres Array = aufgeräumt). */
export interface CollisionWarningMsg extends BaseMsg {
  type: "collision_warning";
  collisions: Collision[];
}

/** Agent-Tool (Integrator) bittet das Frontend, N Sub-Streams zu starten. */
export interface SpawnSubstreamsRequestMsg extends BaseMsg {
  type: "spawn_substreams_request";
  parentAgentId: string;
  streams: Array<{ label: string; brief: string }>;
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
  | "secret_detected" // Secret im zu pushenden Diff (LEAK-1: Push fail-closed blockiert)
  | "main_edited" // Integrator hat main direkt geändert → in Sub-Stream auslagern (proaktiver Hinweis)
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
