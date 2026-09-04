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

import type { CommandKind } from "./safe-command.js";

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
  /** Kleines Anzeige-Thumbnail, das das FRONTEND beim Anhängen per Canvas erzeugt. Es reist INLINE im
   *  user_text-Event mit, damit Mac UND Remote das echte Bild sehen. Das VOLLBILD geht bewusst NICHT
   *  durch Timeline-Ringpuffer/Snapshot-Replay/Bridge (ein Screenshot sind schnell mehrere MB) —
   *  es landet auf Platte und wird nur bei Bedarf (Klick) lokal geladen. Das SDK ignoriert diese
   *  Felder (userMsg liest nur mediaType/dataBase64). */
  thumbBase64?: string;
  thumbMediaType?: string; // z.B. "image/jpeg"
}

/** Ein angehängtes Bild, wie es in der Timeline erscheint: kleines Inline-Thumbnail (überall anzeigbar)
 *  + Pfad zum Vollbild auf Platte (nur lokal am Mac ladbar; fehlt ohne Projekt/Worktree). */
export interface TimelineAttachment {
  id: string;
  mediaType: string;
  thumbBase64?: string;
  thumbMediaType?: string;
  path?: string;
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
  | PanicResolveMsg
  | PanicReleaseMsg
  | CreatePrMsg
  | SyncBranchMsg
  | GateTaskMsg
  | IntegratePrMsg
  | SetAutonomyMsg
  | SetAutopilotMsg
  | SetModelEffortMsg
  | OutsourceMainMsg
  | CommitMainReleaseMsg
  | PollProjectMsg
  | CleanupWorktreeMsg
  | UpdateMainMsg
  | StartDevServerMsg
  | StopDevServerMsg
  | ConfigureDevServerMsg
  | OpenReviewStreamMsg
  | MergeReviewMsg
  | CloseReviewMsg
  | HandoffExportMsg
  | HandoffImportMsg
  | PromptSaveMsg
  | PromptDeleteMsg
  | RequestSnapshotMsg
  | SetAccountMsg
  | RequestAccountsMsg
  | SetSandboxModeMsg
  | TargetsSaveMsg
  | LinkConfigureMsg
  | LinkRemoveMsg
  | PeerSendMsg
  | PeerThreadActionMsg
  | ShutdownMsg;

/**
 * Lokalen Dev-Server dieses Streams starten (Front-/Backend im WORKTREE des Streams, damit
 * noch nicht gemergte Änderungen live getestet werden — main bleibt unangetastet). Wie die
 * App läuft, deklariert `<repoRoot>/.mads/run.json` (projekt-agnostisch). Es läuft immer nur
 * EIN Stream-Dev-Server gleichzeitig — ein Start stoppt einen zuvor laufenden.
 */
export interface StartDevServerMsg extends BaseMsg {
  type: "start_devserver";
  agentId: string;
}
export interface StopDevServerMsg extends BaseMsg {
  type: "stop_devserver";
  agentId: string;
}
/** „Dev-Server konfigurieren": stellt `.mads/run.json` sicher (erzeugt/aktualisiert die Vorlage aus
 *  erkannten Services) und liefert per `devserver_config` den Pfad, den das Frontend im Editor öffnet. */
export interface ConfigureDevServerMsg extends BaseMsg {
  type: "configure_devserver";
  agentId: string;
}

// ─── Review-Streams: eingehende (fremde) PRs read-only prüfen ────────────────
/** Ein eingehender PR (nicht von mads erstellt) — Kandidat für einen Review-Stream. */
export interface IncomingPr {
  number: number;
  title: string;
  author: string;
  headRefName: string;
  url: string;
  isFork: boolean;
  isDraft: boolean;
}
/** „Eingehende PRs" — Liste fremder offener PRs (Bots gefiltert), die mads zum Review anbietet. */
export interface IncomingPrsMsg extends BaseMsg {
  type: "incoming_prs";
  prs: IncomingPr[];
}
/** Einen eingehenden PR als READ-ONLY Review-Stream öffnen (isolierter Worktree auf dem PR-Stand,
 *  keine KI-Session, Autopilot AUS — mads pusht NIE auf den fremden Branch). */
export interface OpenReviewStreamMsg extends BaseMsg {
  type: "open_review_stream";
  prNumber: number;
  headRefName: string;
  title: string;
  author: string;
  url: string;
}
/** Den Review-PR über den Standard-Merge-Weg annehmen (`gh pr merge <#> --squash`) + Stream schließen. */
export interface MergeReviewMsg extends BaseMsg {
  type: "merge_review";
  agentId: string;
}
/** Review-Stream verwerfen (ohne Merge): Worktree entfernen, Kachel schließen. Der fremde PR bleibt. */
export interface CloseReviewMsg extends BaseMsg {
  type: "close_review";
  agentId: string;
}
/** Host→Client: ein gerade geöffneter Review-Stream (passive Kachel) — Descriptor zum Anlegen. */
export interface ReviewStreamMsg extends BaseMsg {
  type: "review_stream";
  agentId: string;
  label: string;
  branch: string;
  worktreePath: string;
  reviewPr: number;
  author: string;
  url: string;
}

/**
 * Standard-Modell — SINGLE SOURCE für Frontend UND Sidecar. Der Sidecar coerciert JEDE fehlende
 * Modell-Angabe hierauf, BEVOR er den Agent-SDK aufruft: gibt man dem SDK `model: undefined`, wählt
 * er still sein Flaggschiff (Fable 5) — das verbrennt teure Tokens „blind", ohne dass die UI es zeigt
 * (der Picker spiegelt den WUNSCH, nicht das Ist). Deshalb nie undefined an den SDK. Siehe ModelActiveMsg.
 */
export const DEFAULT_MODEL = "claude-opus-5";

/**
 * Doppel-Check gegen „blindes Fahren auf dem falschen Modell": Der Sidecar liest aus JEDER
 * Assistant-/Init-Nachricht das TATSÄCHLICH gelaufene Modell und meldet es hier. `mismatch=true`
 * heißt: der SDK lief auf einem anderen Modell als angefordert (z. B. Fable statt Opus) — der Sidecar
 * hat dann aktiv `setModel(requested)` nachgezogen. Die UI zeigt `active` (nicht mehr nur den Wunsch)
 * und warnt bei mismatch, damit unerwartete Kosten sofort sichtbar werden.
 */
export interface ModelActiveMsg extends BaseMsg {
  type: "model_active";
  agentId: string;
  active: string; // real vom SDK gemeldetes Modell
  requested?: string; // was mads angefordert hatte
  mismatch: boolean;
}

// ─── Prompt-Verwaltung ────────────────────────────────────────────────────────
// Kuratierte, wiederverwendbare Anweisungen (z. B. Deploy-Rezepte) je Projekt.
// Persistenz: `<repoRoot>/.mads/prompts.json`. Sicherheits-Eigenschaften by design:
// (1) Ein Prompt wird beim Auswählen NUR in den Composer eingefügt (Review vor Senden,
//     nie Auto-Send). (2) `role` bindet ihn an die Stream-Rolle — Deploy-Prompts z. B.
//     erscheinen nur beim Integrator, nie bei Subs. (3) Platzhalter sind `{{name}}`-Tokens
//     im Text; die UI fragt sie beim Einfügen ab (kein Skript-Aufruf ohne explizite Werte).
export interface SavedPrompt {
  id: string; // stabiler Slug oder uuid
  title: string;
  /** Kurzbeschreibung fürs Auswahlmenü (z. B. Vorbedingungen, Versions-Hinweis). */
  description?: string;
  /** An welche Stream-Rolle der Prompt gebunden ist. "any" = überall wählbar. */
  role: "integrator" | "sub" | "any";
  /** Der Anweisungstext; `{{name}}`-Tokens werden beim Einfügen abgefragt. */
  text: string;
  updatedAt: number;
}

// ---- Sandbox-Betriebsart & Untersuchungsziele (Stufe A/B der Untersuchungs-Freigabe) ----
/**
 * Sandbox-Betriebsart eines SUB-Streams. Der Bedarf: ein Sub muss gelegentlich auf Test-/Prod-
 * Servern UNTERSUCHEN, die Sandbox sperrt aber Egress + Secrets. Statt eines binären Aus-Schalters
 * zwei abgestufte Freigaben (der Integrator läuft ohnehin ohne Sandbox — für ihn irrelevant):
 *
 *  - `"on"` (Default): volle Sandbox — Schreiben nur im Worktree, Egress nur Paketquellen.
 *  - `"targets"` (Stufe A): Sandbox BLEIBT AN (Dateisystem + Secrets geschützt), zusätzlich sind
 *    die projektweiten Untersuchungsziele (`.mads/targets.json`) im Egress erlaubt. Deckt
 *    HTTPS-Untersuchungen (APIs, Health, Logs) ohne echten Schutzverlust ab.
 *  - `"off"` (Stufe B, „Freigang"): Sandbox aus — für SSH/psql-Untersuchungen. Geländer:
 *    nur der MENSCH schaltet (UI; Agenten können keine Protokoll-Nachrichten senden), der Zustand
 *    ist sichtbar (Badge), wird NIE persistiert (Resume startet sandboxed), der Autopilot pusht/
 *    PRt währenddessen nicht automatisch, und nach 15 Min. Inaktivität schaltet der Sidecar
 *    selbst zurück auf "on" (Drift-Schutz: „temporär aus" darf nicht „vergessen aus" werden).
 *
 * Umschalten = Prozess-Neustart mit `resumeSessionId` (Muster wie Kontowechsel) — Kontext bleibt.
 */
export type SandboxMode = "on" | "targets" | "off";

/** Externes Untersuchungsziel des Projekts (Host für die Egress-Allowlist bei `"targets"`). */
export interface InvestigationTarget {
  /** Domain/Host, Wildcards wie im SDK-Schema (z. B. "api.test.example.ch", "*.example.ch"). */
  host: string;
  label?: string;
  /** Prod-Ziel → deutlichere Bestätigung im UI beim Freischalten. */
  prod?: boolean;
}

/** Sandbox-Betriebsart eines Sub-Streams umschalten (nur menschliche UI-Aktion). Mit Session:
 *  Neustart+Resume im selben Gespräch; ganz neuer Stream ohne Session: frischer Neustart
 *  (kein Verlauf zu verlieren). Beim ERSTELLEN wählt man die Betriebsart direkt im
 *  New-Stream-Dialog (StartAgentMsg.sandboxMode) — dann ist gar kein Umschalten nötig. */
export interface SetSandboxModeMsg extends BaseMsg {
  type: "set_sandbox_mode";
  agentId: string;
  mode: SandboxMode;
}

/** Untersuchungsziele des Projekts komplett ersetzen (Editor in den Einstellungen). */
export interface TargetsSaveMsg extends BaseMsg {
  type: "targets_save";
  targets: InvestigationTarget[];
}

/** Vollständige Ziel-Liste des Projekts (bei open_project und nach jeder Änderung). */
export interface TargetsUpdateMsg extends BaseMsg {
  type: "targets_update";
  targets: InvestigationTarget[];
}

/** Prompt anlegen/ändern (Upsert per id). */
export interface PromptSaveMsg extends BaseMsg {
  type: "prompt_save";
  prompt: SavedPrompt;
}
export interface PromptDeleteMsg extends BaseMsg {
  type: "prompt_delete";
  id: string;
}
/** Vollständige Prompt-Liste des Projekts (bei open_project und nach jeder Änderung). */
export interface PromptsUpdateMsg extends BaseMsg {
  type: "prompts_update";
  prompts: SavedPrompt[];
}

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
  /** Multi-Instanz-Lock ignorieren und trotzdem öffnen (Nutzer-Override, z. B. wenn die haltende
   *  Instanz hängt/tot ist und die pid recycelt wurde). Bewusst — kann Doppel-Öffnen erzwingen. */
  force?: boolean;
}

export interface StartAgentMsg extends BaseMsg {
  type: "start_agent";
  agentId: string;
  prompt: string;
  /** Screenshots/Bilder zum initialen Prompt (New-Stream-Dialog) — wie SendInputMsg.images. */
  images?: ImageInput[];
  /** Claude-Konto für diesen Stream (Profil-ID). Fehlt = aktives Konto der Registry. */
  accountId?: string;
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
  /** OS-Sandbox für Agenten-Bash (macOS/Seatbelt, SDK-nativ). Default: AN (undefined = an).
   *  `false` schaltet sie für diesen Stream ab — Notfall/Debug, wenn eine Toolchain am Sandkasten
   *  scheitert. Global geht das auch per Env `MADS_SANDBOX=off`. Siehe sidecar/src/sandbox.ts. */
  sandbox?: boolean;
  /** Sandbox-Betriebsart (Untersuchungs-Freigabe, siehe SandboxMode). Präziser als `sandbox` und
   *  gewinnt gegen es. Wird NIE persistiert — ein Resume startet immer wieder mit "on". */
  sandboxMode?: SandboxMode;
  /** Nur für `sandboxMode: "targets"`: zusätzliche Egress-Hosts. Wird vom ORCHESTRATOR aus
   *  `.mads/targets.json` gesetzt (Single Source of Truth auf Platte) — Client-Angaben hier
   *  werden überschrieben, damit kein (Remote-)Client beliebige Domains freischalten kann. */
  investigationDomains?: string[];
  /** true = automatische „Setze die Arbeit fort"-Anweisung beim Resume (kein echter Nutzer-Auftrag).
   *  Der Sidecar überschreibt damit NICHT den zuletzt gemerkten Auftrag (`lastPrompt`) — die Kachel
   *  zeigt weiter den echten Auftrag, den der Mensch abgesetzt hat. */
  continuation?: boolean;
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

/** Den aktuellen (Deploy-)Stand des Main-Checkouts als Release-Commit festhalten (`chore(release): …`).
 *  Nur lokal auf dem Default-Branch; Push bleibt separat/explizit. Für den „Als Release committen"-Knopf. */
export interface CommitMainReleaseMsg extends BaseMsg {
  type: "commit_main_release";
  agentId: string; // Integrator
}

export interface PollProjectMsg extends BaseMsg {
  type: "poll_project"; // git-/PR-Status aller Agenten jetzt aktualisieren
}

/**
 * [Remote-Bridge] Ein (später) verbindender Remote-Client fordert den aktuellen Ist-Zustand an
 * (docs/design/remote-companion-app.md §4.3). Der Orchestrator re-emittiert gecachten State über
 * exakt die Nachrichten, die der Store ohnehin verarbeitet — `project_resolved`, je Agent
 * `status_update` + `cost_update` + (gecachtes) `git_status` + `pr_update` — und schiebt einen
 * frischen Poll für Live-git/PR nach. Sendet KEINE neuen Fakten: reiner Re-Emit, damit ein
 * Late-Joiner denselben Reducer aufbaut wie das lokale Frontend.
 */
export interface RequestSnapshotMsg extends BaseMsg {
  type: "request_snapshot";
}

/** Kompletten Projekt-Stand (alle Streams: Code+Uncommittet+Registry+Verlauf+Claude-Sessions)
 *  in EINE portable Datei exportieren (scripts/mads-handoff.mjs). */
export interface HandoffExportMsg extends BaseMsg {
  type: "handoff_export";
  repoRoot: string;
  outFile: string;
}

/** Einen zuvor exportierten Handoff-Stand importieren und die Streams wiederherstellen. */
export interface HandoffImportMsg extends BaseMsg {
  type: "handoff_import";
  file: string;
  targetRepoRoot?: string;
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
 * „Don't Panic": übergreifende Konfliktlösung. Die erste bewusst GLOBALE Aktion (kein `agentId`) —
 * genau das ist der Punkt.
 *
 * WARUM global: Der frühere per-Stream-Knopf („Konflikt lösen") schickte nur einen Prompt in den
 * betroffenen Sub-Stream. Der läuft aber laut sandbox.ts eingesperrt in seinem eigenen Worktree —
 * `git merge-tree` zwischen zwei Branches, ein Hunk-Vergleich oder die Frage „welcher Branch
 * sollte zuerst gemergt werden" sind ihm damit prinzipiell unmöglich. Er rebaset blind, während
 * die anderen Streams weiterarbeiten und die Lage erneut verschieben.
 *
 * Stattdessen: alle Sub-Streams anhalten (nichts verändert sich mehr), Autopilot einfrieren, und
 * den INTEGRATOR beauftragen — der einzige Stream ohne Sandbox, mit Sicht auf alle Worktrees, und
 * per Invariante 1 ohnehin der Einzige, der mergen darf. Er bekommt das Playbook
 * (sidecar/playbooks/conflict-resolution.md) plus einen Lagebericht über alle Streams.
 */
export interface PanicResolveMsg extends BaseMsg {
  type: "panic_resolve";
}

/**
 * Gegenstück zu `panic_resolve`: gibt die angehaltenen Sub-Streams wieder frei und stellt ihren
 * gemerkten Autopilot-Level wieder her. Bewusst ein eigener, menschlicher Schritt — nach einer
 * Konfliktlösung hat sich die Basis geändert, und kein Stream soll unbemerkt darauf weiterlaufen.
 */
export interface PanicReleaseMsg extends BaseMsg {
  type: "panic_release";
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
  /** true: lokale, nicht gepushte ahead-Commits VERWERFEN und main hart auf origin/<base> setzen
   *  (mit automatischem Backup-Branch). Für den Fall, dass main lokal voraus ist (z. B. Release-/
   *  Versions-Bump-Commits), den ein fast-forward nicht auflösen kann. Ohne Flag: nur fast-forward. */
  hard?: boolean;
  /** true: lokale ahead-Commits BEHALTEN und nach origin/<base> PUSHEN (Fast-Forward, kein force) —
   *  die sichere Alternative zu `hard`, wenn die Commits echt sind (z. B. Release-Version-Bumps). */
  push?: boolean;
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
  | AgentTimelineMsg
  | NeedsInputMsg
  | PermissionRequestMsg
  | PermissionResolvedMsg
  | PermissionsOpenMsg
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
  | PanicStateMsg
  | SpawnSubstreamsRequestMsg
  | DevServerStatusMsg
  | DevServerConfigMsg
  | IncomingPrsMsg
  | ReviewStreamMsg
  | DevServerLogMsg
  | ProjectLockedMsg
  | SidecarErrorMsg
  | HandoffResultMsg
  | PromptsUpdateMsg
  | AccountsUpdateMsg
  | AccountUsageMsg
  | RateLimitNoticeMsg
  | ModelActiveMsg
  | LinkStatusMsg
  | PeerMessageMsg
  | PeerProposalMsg
  | TargetsUpdateMsg;

/**
 * Öffnen abgelehnt: dieses Projekt ist bereits in einer ANDEREN, laufenden mads-Instanz offen
 * (Multi-Instanz-Schutz — zwei Sidecars dürfen nicht parallel denselben `.mads`-State/Worktrees
 * schreiben). Das Frontend fällt auf die Projektauswahl zurück und zeigt einen Hinweis.
 */
export interface ProjectLockedMsg extends BaseMsg {
  type: "project_locked";
  repoRoot: string;
  /** pid der Instanz, die das Projekt hält (nur informativ). */
  byPid?: number;
}

/** Ein einzelner Service des Stream-Dev-Servers (aus `.mads/run.json`), für die Statusanzeige. */
export interface DevServerService {
  name: string;
  /** BEWIESEN bereit (Ready-Marker erkannt oder Port antwortet) — nicht bloß „Prozess läuft". */
  ready: boolean;
  url?: string;
  /** Prozess lebt. Trennt „startet noch" (alive && !ready) von „abgestürzt" (!alive) — ohne das
   *  sähen beide Zustände in der UI gleich aus. */
  alive?: boolean;
  /** Bereitschaft nur ANGENOMMEN (kein Ready-Marker, kein prüfbarer Port) → UI zeigt gelb statt grün. */
  assumed?: boolean;
  /** Nicht erreichbare Abhängigkeit (z. B. „:5433") — der Dienst lauscht, kann aber nicht arbeiten. */
  depMissing?: string;
}
/** Externe Abhängigkeit eines Dienstes (Datenbank, Cache …) — eigener Indikator in der UI. */
export interface DevServerDependency {
  name: string;
  /** host:port — was geprüft wurde. */
  target: string;
  ok: boolean;
}
/** Zustand des Stream-Dev-Servers (treibt Button/Badge/„im Browser öffnen"-Link im Frontend). */
export interface DevServerStatusMsg extends BaseMsg {
  type: "devserver_status";
  agentId: string;
  // „unconfigured": kein lauffähiges .mads/run.json (fehlt/leer/nicht erkannt) → Frontend bietet
  // „Konfigurieren" an, statt einen toten Fehler zu zeigen.
  state: "installing" | "starting" | "running" | "stopped" | "error" | "unconfigured";
  services?: DevServerService[];
  /** Geprüfte externe Abhängigkeiten (aus `requires` in run.json). Eigene Indikatoren, weil ein
   *  Dienst OHNE seine Datenbank zwar lauscht, aber nichts kann — das sah vorher grün aus. */
  dependencies?: DevServerDependency[];
  /** primäre URL zum Öffnen im Browser (i. d. R. das Frontend), sobald bereit. */
  url?: string;
  /** menschenlesbarer Hinweis (Fehlergrund / „Vorlage erzeugt" o. Ä.). */
  message?: string;
  /**
   * TEILWEISE gestartet: mindestens ein konfigurierter Service ist tot, andere laufen weiter
   * (Survivor-Modus). `state` bleibt dabei bewusst „running" — sonst würde ein toter Backend-Dienst
   * das ansehbare Frontend als „Fehler" darstellen. Ohne dieses Flag sah die UI aber schlicht GRÜN
   * aus, obwohl genau der Dienst fehlte, den der Nutzer öffnen wollte (er landete auf einem
   * API-Endpunkt mit 404 und suchte den Fehler im eigenen Code). Die UI zeigt damit „teilweise".
   */
  degraded?: boolean;
  /** Namen der konfigurierten, aber nicht (mehr) laufenden Services — für die Anzeige. */
  deadServices?: string[];
}
/** Antwort auf `configure_devserver`: Pfad der (sichergestellten) `.mads/run.json`, die der Client
 *  im Editor öffnet. `detected` = Anzahl automatisch erkannter Services in der frischen Vorlage. */
export interface DevServerConfigMsg extends BaseMsg {
  type: "devserver_config";
  agentId: string;
  path: string;
  detected: number;
}
/** Eine Ausgabezeile eines Dev-Server-Services (Live-Log im Inspector). */
export interface DevServerLogMsg extends BaseMsg {
  type: "devserver_log";
  agentId: string;
  service: string;
  stream: "stdout" | "stderr";
  line: string;
}

export interface SidecarReadyMsg extends BaseMsg {
  type: "sidecar_ready";
  pid: number;
  sdkVersion: string;
  sdkAvailable: boolean;
  resumableAgents: Array<{ agentId: string; sessionId: string; branch?: string }>;
  /** Kurzer Git-Commit, mit dem dist/index.js gebaut wurde (sidecar/scripts/build.mjs stempelt ihn ein). */
  buildCommit: string;
  /** true, wenn buildCommit vom aktuellen Repo-HEAD abweicht — der laufende Sidecar ist älter als main
   *  (z. B. Fix gemergt, aber `npm run sidecar:build` + Neustart vergessen). */
  buildStale: boolean;
}

// parentToolUseId (auf allen Event-Arten, die ein Teil-Agent erzeugen kann): gesetzt, wenn das
// Event aus einem SUB-AGENTEN (Task/Agent-Tool) stammt — dann ist es die tool_use_id des
// Task-Aufrufs, der ihn startete. Erlaubt dem Frontend, die Aktivität dem richtigen Teil-Agenten
// zuzuordnen (Einblick-Panel im Inspector). null/fehlt = Hauptloop.
// Ursprünglich trug nur `tool_use` das Feld; damit liess sich zwar zählen, WIE VIELE Teil-Agenten
// laufen, aber nicht, was sie tun: Ergebnis (ok/Fehler), Antworttext und Denkschritte kamen ohne
// Zuordnung an und landeten als vermeintliche Äusserungen des Hauptloops in der Timeline.
export type AgentEvent =
  | { kind: "assistant_text"; text: string; parentToolUseId?: string }
  | { kind: "assistant_delta"; text: string; parentToolUseId?: string }
  | { kind: "thinking"; text: string; parentToolUseId?: string }
  // Vom Menschen eingegebene Anweisung (Prompt). Der Sidecar emittiert sie als Event, damit sie
  // auf ALLEN Clients (Mac + Remote) im Verlauf erscheint — nicht nur dort, wo sie getippt wurde.
  | { kind: "user_text"; text: string; attachments?: TimelineAttachment[]; continuation?: boolean }
  | { kind: "tool_use"; toolUseId: string; name: string; input: Record<string, unknown>; parentToolUseId?: string }
  | { kind: "tool_result"; toolUseId: string; ok: boolean; summary?: string; output?: string; parentToolUseId?: string }
  | { kind: "system"; subtype: string; data?: Record<string, unknown>; parentToolUseId?: string };

export interface AgentEventMsg extends BaseMsg {
  type: "agent_event";
  agentId: string;
  event: AgentEvent;
}

/**
 * Timeline-VERLAUF eines Agenten für einen SNAPSHOT (emitSnapshot) — spielt einem Client, der
 * MITTEN in einen Lauf verbindet (z. B. der iOS-Mirror), die bereits gestreamten `agent_event`s
 * zurück. Das mads-Frontend baut seine Timeline aus dem Live-Strom und IGNORIERT diese Nachricht
 * (kein Case im Reducer). Der iOS-Client ERSETZT damit die Timeline des Agenten (idempotent: die
 * Events sind wireserialisiert und in Reihenfolge, ein späterer Live-Event hängt strikt danach an).
 */
export interface AgentTimelineMsg extends BaseMsg {
  type: "agent_timeline";
  agentId: string;
  events: AgentEvent[];
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
  /** Bash-Kategorie (network/pkg/secret/git/write/danger) — steuert das projektweite „Immer erlauben".
   *  Fehlt bei nicht-Bash-Tools und bei `danger` gibt es KEINEN „Immer erlauben"-Knopf. */
  commandKind?: CommandKind;
}

/**
 * Eine offene permission_request ist erledigt → ALLE Clients (Mac, Remote/iOS, zweites Fenster)
 * entfernen die Karte und verwerfen eine ggf. offene lokale Notification. Nötig, weil JEDER
 * gekoppelte Client eine Anfrage beantworten kann: wer nicht selbst geantwortet hat, erführe sonst
 * nie, dass die Karte weg darf — sie bliebe hängen. Gegenstück zu resnapshotPermissions().
 */
export interface PermissionResolvedMsg extends BaseMsg {
  type: "permission_resolved";
  agentId: string;
  requestId: string;
  /** Wie aufgelöst: beantwortet (allow/deny/answer_questions) oder anderweitig verworfen
   *  (cancelled: Interrupt/Stop/Session-Ende). Clients brauchen zum Entfernen nur die requestId;
   *  outcome ist additiv (Audit / künftige „woanders beantwortet"-Anzeige). */
  outcome: "allow" | "deny" | "answer_questions" | "cancelled";
}

/**
 * Autoritative Liste der aktuell OFFENEN Permission-requestIds eines Agents — Teil des Snapshots.
 * Clients entfernen lokale Karten dieses Agents, deren requestId NICHT in `requestIds` steht (z. B.
 * eine Anfrage, die aufgelöst wurde, WÄHREND der Client offline war → deren permission_resolved ging
 * verloren). Prunt nur; fügt nichts hinzu und benachrichtigt nicht erneut (offene werden separat via
 * resnapshotPermissions re-emittiert). Reihenfolge-sicher: später live erzeugte Anfragen kommen als
 * eigenes permission_request nach dieser Liste und bleiben erhalten.
 */
export interface PermissionsOpenMsg extends BaseMsg {
  type: "permissions_open";
  agentId: string;
  requestIds: string[];
}

export interface StatusUpdateMsg extends BaseMsg {
  type: "status_update";
  agentId: string;
  status: AgentStatus;
  currentStep?: string;
  /** Menschlicher Stream-Name + Rolle — für Remote-Clients (iOS zeigt sonst nur die UUID). */
  label?: string;
  role?: "integrator" | "sub";
  /**
   * Claude-Konto, unter dem dieser Stream WIRKLICH läuft (Profil-ID). Der Sidecar startet den
   * Prozess und besitzt damit die Wahrheit — die Oberfläche spiegelt sie nur. Ohne diese
   * Bestätigung konnte eine Kachel dauerhaft ein anderes Konto anzeigen als das laufende
   * (`CLAUDE_CONFIG_DIR` steht nach dem Spawn fest), ohne dass es je auffiel.
   */
  accountId?: string;
  /** Sandbox-Betriebsart, in der dieser Stream WIRKLICH läuft (der Sidecar hat den Prozess mit
   *  genau diesen Sandbox-Optionen gestartet — die Oberfläche spiegelt nur). */
  sandboxMode?: SandboxMode;
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
  /** Projekt-Verbund (docs/design/12-project-link.md §4.3.1): berührt der Branch Dateien des
   *  deklarierten Contracts, steht hier das erkannte Delta — die Ankündigung an die Gegenseite
   *  hat der Sidecar dann bereits gesendet. Fehlt = keine Contract-Datei betroffen. */
  contract?: ContractDelta;
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
  /** Gesetzt = persistierter READ-ONLY Review-Stream (fremder PR). Beim Start wird daraus die
   *  Review-Kachel wiederhergestellt (nicht als normaler Resume-Kandidat behandelt). */
  reviewPr?: number;
  reviewAuthor?: string;
  reviewUrl?: string;
  /** PR gemergt/geschlossen UND Worktree sauber, keine ungemergte Arbeit (ahead 0): wird zwar noch als
   *  fortsetzbar angeboten (bleibt im Grid), aber der zugehörige Auftrag ist ERLEDIGT → die Kachel zeigt
   *  ihn nach dem Neustart NICHT mehr (in-Session verbirgt ihn isMergedDone bereits — hier fehlt nur der
   *  pr-Kontext, den wir bewusst nicht ins passive VM heben, um die Grid-Platzierung nicht zu ändern). */
  mergedClean?: boolean;
  /** Claude-Konto (Profil-ID aus der Account-Registry), unter dem dieser Stream läuft. Muss den
   *  Neustart überleben: die Claude-Session liegt im `projects/`-Verzeichnis GENAU DIESES Profils —
   *  ein Resume unter dem falschen Konto fände sie nicht und würde still frisch starten. */
  accountId?: string;
}
export interface ResumableAgentsMsg extends BaseMsg {
  type: "resumable_agents";
  agents: ResumableAgent[];
}

// ---- Mehrere Claude-Konten (Failover bei erschöpftem Kontingent) ----
/**
 * Ein Claude-Konto, ausgewählt über `CLAUDE_CONFIG_DIR` beim Start des Agent-Prozesses.
 * mads speichert KEINE Zugangsdaten — die liegen im macOS-Schlüsselbund, den Claude Code
 * selbst pro Config-Verzeichnis verwaltet. Hier steht nur, WELCHES Verzeichnis gilt.
 */
export interface AccountProfile {
  /** Stabile ID, wird pro Agent persistiert (`ResumableAgent.accountId`). */
  id: string;
  /** Anzeigename in der Oberfläche. */
  label: string;
  /** Absoluter Pfad des Config-Verzeichnisses (z. B. `/Users/x/.claude`). */
  configDir: string;
  /** Nur informativ (aus `<configDir>/.claude.json` gelesen), nie zum Anmelden benutzt. */
  email?: string;
}

/**
 * Kontingent-Zustand eines Kontos. Gefüttert aus dem `rate_limit_event` des Agent-SDK —
 * also aus MASCHINENLESBAREN Feldern, nicht aus geparster Fließtext-Fehlermeldung.
 */
export interface AccountCooldown {
  /** Millisekunden-Zeitstempel, ab dem das Kontingent wieder verfügbar ist. */
  until: number;
  /** Welches Fenster erschöpft ist — vom SDK gemeldet (z. B. "five_hour", "seven_day"). */
  window?: string;
  /** true = bereits abgewiesen; false = nur Vorwarnung (`allowed_warning`), läuft noch. */
  rejected: boolean;
  /** Auslastung 0..1, sofern gemeldet. */
  utilization?: number;
}

export interface AccountsState {
  profiles: AccountProfile[];
  /** Konto für neue Streams (Vorauswahl im Dialog). */
  activeId: string;
  /** Cooldowns je Profil-ID; fehlender Eintrag = verfügbar. */
  cooldowns: Record<string, AccountCooldown>;
}

/** Ein Kontingent-Fenster (5 Stunden, Woche, …) wie es die Plan-Nutzungslimits ausweisen. */
export interface UsageWindow {
  /** Auslastung in PROZENT (0–100), so wie die Usage-API sie liefert. */
  utilization?: number;
  /** Zeitpunkt der Zurücksetzung (ms seit Epoche). */
  resetsAt?: number;
}

/**
 * Sidecar → Host: Plan-Nutzungslimits eines Kontos, abgefragt über die Usage-API des SDK.
 * Anders als `rate_limit_notice` (reagiert nur auf Ereignisse) liefert das ALLE Fenster auf einmal
 * und auf Abruf — damit lässt sich das Limit kommen sehen, statt es erst beim Anschlag zu merken.
 */
export interface AccountUsageMsg extends BaseMsg {
  type: "account_usage";
  accountId: string;
  /** 5-Stunden-Fenster. */
  fiveHour?: UsageWindow;
  /** Wochenfenster über alle Modelle. */
  sevenDay?: UsageWindow;
  /** Wochenfenster für die teuersten Modelle (separat limitiert). */
  sevenDayOpus?: UsageWindow;
  /** Abo-Art ("max", "pro", …) — rein informativ. */
  subscription?: string;
}

/** Sidecar → Host: vollständiger Account-Zustand (Registry + Cooldowns). Ersetzt lokal alles. */
export interface AccountsUpdateMsg extends BaseMsg {
  type: "accounts_update";
  accounts: AccountsState;
}

/**
 * Sidecar → Host: Kontingent-Meldung zu einem Stream. Rein informativ — mads wechselt das Konto
 * NICHT von selbst (bewusste Entscheidung: der Wechsel bleibt eine menschliche Aktion), sondern
 * zeigt den Hinweis samt Reset-Zeitpunkt und bietet den Umschalter an.
 */
export interface RateLimitNoticeMsg extends BaseMsg {
  type: "rate_limit_notice";
  agentId: string;
  accountId: string;
  /** Vom SDK gemeldeter Stand. "allowed" = reine Verbrauchsanzeige, keine Meldung im Verlauf. */
  status: "allowed" | "allowed_warning" | "rejected";
  /** true = Anfrage wurde abgewiesen (Limit erreicht); false = läuft noch. */
  rejected: boolean;
  resetsAt?: number;
  window?: string;
  /** Auslastung 0..1 des genannten Fensters — Grundlage der laufenden Verbrauchsanzeige. */
  utilization?: number;
  /** ID eines verfügbaren Ausweich-Kontos, falls vorhanden → die UI kann den Wechsel anbieten. */
  suggestId?: string;
}

/**
 * Host → Sidecar: Konto dieses Streams wechseln. Der laufende Claude-Prozess wird dafür beendet
 * und im Ziel-Konto per `--resume` derselben Session neu gestartet (die Umgebung eines Prozesses
 * ist nach dem Start nicht mehr änderbar). Ohne `agentId`: nur das Default-Konto für neue Streams.
 */
export interface SetAccountMsg extends BaseMsg {
  type: "set_account";
  accountId: string;
  agentId?: string;
}

/** Host → Sidecar: Account-Zustand neu senden (beim Start / nach Reconnect). */
export interface RequestAccountsMsg extends BaseMsg {
  type: "request_accounts";
}

/** Ergebnis eines Handoff-Export/-Imports → treibt einen dismissbaren Hinweis-Banner im Frontend. */
export interface HandoffResultMsg extends BaseMsg {
  type: "handoff_result";
  action: "export" | "import";
  ok: boolean;
  message: string;
  path?: string;      // exportierte Datei (export) bzw. Ziel-Repo (import)
  repoRoot?: string;  // nach Import: Projekt-Repo, das geöffnet werden kann
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
  /**
   * Beim ERSTEN Öffnen dieses Projekts hat mads N lokale, gitignorte Config-Dateien erkannt und
   * `.mads/worktree-seed` angelegt — sie werden künftig in jeden neuen Stream kopiert. Nur gesetzt
   * (> 0), wenn die Liste gerade generiert wurde UND ≥ 1 Datei erkannt wurde. Rein informativ.
   */
  seedGenerated?: number;
  /**
   * Cross-Machine-Reparatur: Streams, deren Worktree-Pfad unter einem FREMDEN Home eingebacken war
   * (Repo zwischen zwei Macs kopiert), wurden auf den lokalen Kanon-Pfad umgezogen und der Worktree
   * aus dem bestehenden Branch neu ausgecheckt — Labels der umgezogenen Streams. Früher fielen diese
   * Subs beim Öffnen still aus dem Grid; jetzt sind sie zurück + der Nutzer sieht, dass es passiert ist.
   */
  relocated?: string[];
  /**
   * Cross-Machine-Fortsetzung: Branches, die auf origin AKTIV sind (ungemergt über <default>, nicht
   * von einem Bot und nicht nachweislich einem fremden GitHub-Account zugeordnet), für die es hier
   * aber weder Registry-Eintrag noch Worktree gab — typisch: auf dem ZWEITEN Mac angelegt. Sie wurden
   * beim Öffnen automatisch als lokale Worktrees ausgecheckt und stehen als Streams bereit — Labels.
   * `.mads/agents.json` ist gitignored und damit maschinen-lokal; ohne diesen Schritt ist ein nur auf
   * origin existierender Branch für mads unsichtbar (die Ursache der „mein Stream fehlt"-Lücke).
   */
  adopted?: string[];
}

/** Laufzeit-Kollisionen zwischen aktiven Agenten (leeres Array = aufgeräumt). */
export interface CollisionWarningMsg extends BaseMsg {
  type: "collision_warning";
  collisions: Collision[];
}

/**
 * Panic-Zustand (Gegenstück zu `panic_resolve`/`panic_release`). Solange `active`, sind die
 * genannten Sub-Streams angehalten und ihr Autopilot steht auf `manual`; das Frontend zeigt
 * dann statt des Panic-Knopfs die Freigabe.
 *
 * GRENZE: nur Laufzeit-Zustand des Sidecars — ein Neustart verliert ihn. Die Streams bleiben dann
 * korrekt auf `manual` (das ist in agents.json persistiert, es geht also nichts verloren und
 * niemand läuft unbemerkt los), aber die Sammel-Freigabe fehlt; die Level werden dann einzeln im
 * Inspector zurückgestellt. Bewusst so belassen, statt ein zweites Persistenz-Schema einzuführen —
 * der Panic-Lauf dauert Minuten, ein Sidecar-Neustart genau darin ist der seltene Fall.
 */
export interface PanicStateMsg extends BaseMsg {
  type: "panic_state";
  active: boolean;
  /** Sub-Streams, die durch den Panic angehalten wurden (leer, wenn nicht aktiv). */
  stoppedAgentIds: string[];
  /** agentId des Integrators, der die Auflösung übernommen hat. */
  resolverAgentId?: string;
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
  | "main_deploy_dirty" // main-Dirt stammt aus einem gerade gelaufenen Deploy → „Als Release committen" anbieten
  | "foreign_edit" // Worktree änderte sich, während der Agent ruhte → Autopilot committet nicht blind mit
  // ── Projekt-Verbund (docs/design/12-project-link.md §6.3) ──
  | "peer_contract_drift" // Gegenseite hat den Contract geändert, ohne dass ein Thread es erklärt
  | "peer_loop_guard" // Ping-Pong zwischen den Instanzen (hops ≥ Schwelle) → Mensch entscheidet
  | "peer_version_mismatch" // Gegenseite spricht eine andere LINK_VERSION → nur hello wird verarbeitet
  | "peer_land_order" // Consumer will mergen, obwohl die Provider-Seite noch nicht gelandet ist (Warnung)
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
// Projekt-Verbund: zwei mads-Instanzen, zwei Repos, ein Contract
// (docs/design/12-project-link.md)
//
// Zwei fachlich gekoppelte Repos (z. B. Server + App) laufen in je EINER eigenen
// mads-Instanz. Beide Integratoren koordinieren sich über einen deklarierten
// CONTRACT (die Dateien, die die Schnittstelle bilden), ein mechanisches
// Drift-Gate (Fingerprint) und einen Peer-Kanal (Maildir unter ~/.mads/links/).
//
// Kern-Disziplin (§8.3): Peer-Nachrichten sind DATEN, keine Autorität. Nichts im
// Kanal kann eine HostMessage auslösen — der Kanal kennt nur PeerMessage-Kinds.
// ============================================================================

/** Version des Verbund-Protokolls. Weicht sie zwischen den Instanzen ab, werden nur
 *  `hello`/Presence verarbeitet (inhaltliche Nachrichten nicht) — §5.4. */
export const LINK_VERSION = 1 as const;

/** Kompatibilitätsregel für Contract-Änderungen (§4.5). */
export type ContractCompat =
  /** Expand/Contract: Neues additiv ergänzen, Altes bleibt bis der Consumer nachgezogen hat. */
  | "additive"
  /** Breaking Changes erlaubt — Landing-Reihenfolge Provider → Consumer wird zur roten Warnung. */
  | "lockstep";

/** Verbund-Konfiguration eines Repos. Lokal in `<repoRoot>/.mads/link.json` (OE-54). */
export interface ProjectLinkConfig {
  v: 1;
  peer: { repoRoot: string; label?: string };
  /** Glob-Muster der eigenen Contract-Dateien (Semantik wie `OwnershipRule.path`).
   *  Leer = reiner Consumer; nicht leer = Provider; beide Seiten nicht leer = bidirektional. */
  provides: { patterns: string[]; compat?: ContractCompat };
  /** Dispatch-Stufe für Peer-Anfragen (§7.6). Default: "assisted" (OE-55). */
  autopilot?: AutopilotLevel;
  /** P3 (noch nicht implementiert): Verbund-Gate-Kommando auf der Consumer-Seite. */
  gate?: { command: string; env?: Record<string, string> };
}

/** Die Contract-Änderung eines Branches/Stands: welche Contract-Dateien wie geändert wurden. */
export interface ContractDelta {
  baseSha: string;
  headSha: string;
  files: string[];
  regions: ChangedRegion[];
  /** Roh-Diff, gekappt bei 64 KB (OE-58) — nur Text, wird NIE angewendet, nur gezeigt. */
  diff?: string;
  truncated?: boolean;
}

export type LinkThreadState =
  | "open" // Anfrage liegt vor, noch nichts entschieden
  | "proposed" // Integrator hat Label/Brief entworfen (Karte sichtbar)
  | "in_progress" // Abgleich-Sub-Stream läuft (ownerAgentId gesetzt)
  | "landed" // Änderung DIESER Seite ist auf main
  | "done" // beide Seiten fertig (ackedFp fortgeschrieben)
  | "declined" // Mensch/Integrator hat abgelehnt (mit Begründung an den Peer)
  | "escalated"; // Loop-Guard, Version-Mismatch, offene Frage an den Menschen

/** Ein Abgleich-Vorgang zwischen den beiden Instanzen — das Cross-Repo-Gegenstück
 *  zum `CoordinationArtifact`. Persistiert in `<repoRoot>/.mads/link-threads.json`. */
export interface LinkThread {
  id: string;
  /** "local" = hier entstanden; "peer" = von der Gegenseite angestoßen. */
  origin: "local" | "peer";
  kind: "contract_change" | "request";
  title: string;
  state: LinkThreadState;
  /** Lokaler Stream, der den Thread bearbeitet (Folge-Nachrichten routen dorthin). */
  ownerAgentId?: string;
  /** Stream der Gegenseite (informativ). */
  peerAgentId?: string;
  /** Branch, aus dem dieser Thread entstand (ein Thread pro Branch, §11). */
  branch?: string;
  prUrl?: string;
  /** Fingerprint, den dieser Thread „erklärt" (Drift-Regel, §4.2). */
  contractFp?: string;
  /** Der zuletzt übermittelte/empfangene Delta dieses Threads (für die Karte). */
  delta?: ContractDelta;
  breaking?: boolean;
  /** Ping-Pong-Zähler: jede Folge-Nachricht erhöht ihn; ab LOOP_GUARD_MAX_HOPS kein Auto-Dispatch. */
  hops: number;
  causedBy?: string;
  /** Vorschlag des Integrators (Label + Brief), auf den [Starten] wartet. */
  proposal?: { label: string; brief: string };
  /** Vom Sidecar vorbereiteter Auftrag, falls (noch) kein Proposal existiert — damit [Starten]
   *  auch auf Stufe `manual` sofort einen vollständigen Brief hat und die Ableitung an EINER
   *  Stelle lebt (nicht doppelt im Frontend). */
  suggestedBrief?: string;
  /** Gegenseite hat gemeldet, dass ihre Änderung gelandet ist. */
  peerLanded?: boolean;
  landedSha?: string;
  createdAt: number;
  updatedAt: number;
  log: Array<{ ts: number; who: "local" | "peer" | "human"; text: string }>;
}

/** Presence einer Instanz (Heartbeat unter `~/.mads/links/<linkId>/presence/<slug>.json`, §5.2). */
export interface LinkPresence {
  pid: number;
  ts: number;
  slug: string;
  repoRoot: string;
  owner?: string;
  repo?: string;
  defaultBranch?: string;
  mainSha?: string;
  contractFp?: string;
  provides: string[];
  compat: ContractCompat;
  /** Wen DIESE Seite als Gegenseite konfiguriert hat — Grundlage des gegenseitigen
   *  Einverständnisses (§5.3): ein Link ist erst aktiv, wenn beide einander nennen. */
  peerRepoRoot?: string;
  devServers?: Array<{ agentId: string; branch?: string; url: string; ready: boolean }>;
  protocolVersion: number;
  linkVersion: number;
  buildCommit?: string;
}

/** Presence + abgeleitete Sicht für die Oberfläche. */
export interface PresenceView extends LinkPresence {
  online: boolean;
}

/** Nachrichten zwischen den beiden Instanzen (§6.2). Bewusst eine EIGENE, kleine Union —
 *  sie überschneidet sich NICHT mit HostMessage: der Peer kann keine Freigabe erteilen,
 *  nichts mergen und keinen Permission-Modus setzen. */
export type PeerMessage =
  | { kind: "hello" }
  | {
      kind: "contract_change";
      threadId: string;
      title: string;
      summary: string;
      delta: ContractDelta;
      breaking: boolean;
      migration?: string;
      source: { agentId: string; branch?: string; prUrl?: string; landed: boolean };
      devServer?: { url: string; ready: boolean };
      causedBy?: string;
    }
  | { kind: "request"; threadId: string; title: string; brief: string; fromHuman: boolean; causedBy?: string }
  | { kind: "reply"; threadId: string; text: string; state?: "ack" | "question" | "answer" | "declined" }
  | { kind: "done"; threadId: string; landedSha?: string; prUrl?: string; contractFp?: string };

/** Umschlag einer Peer-Nachricht auf der Platte (eine Datei = eine Nachricht, §5.5). */
export interface PeerEnvelope {
  v: number;
  id: string;
  ts: number;
  linkId: string;
  linkVersion: number;
  from: { slug: string; repoRoot: string; pid: number };
  msg: PeerMessage;
}

// ─── Frontend ↔ Sidecar ───────────────────────────────────────────────────────

/** Verbund anlegen/ändern (Settings-Panel). Der Sidecar persistiert `.mads/link.json`. */
export interface LinkConfigureMsg extends BaseMsg {
  type: "link_configure";
  config: ProjectLinkConfig;
}
/** Verbund lösen. Threads bleiben als Audit erhalten. */
export interface LinkRemoveMsg extends BaseMsg {
  type: "link_remove";
}
/** Der MENSCH schreibt der Gegenseite (neuer `request` bzw. `reply` auf einem Thread). */
export interface PeerSendMsg extends BaseMsg {
  type: "peer_send";
  text: string;
  threadId?: string;
  title?: string;
}
/** Karten-Aktion auf einem Thread. `start` startet das Proposal als Sub-Stream. */
export interface PeerThreadActionMsg extends BaseMsg {
  type: "peer_thread_action";
  threadId: string;
  action: "start" | "decline" | "resolve" | "accept_drift";
  reason?: string;
  /** Nur für `start`: die agentId des Streams, den das FRONTEND soeben über den normalen
   *  createAgent-Pfad angelegt hat. Streams entstehen weiterhin ausschließlich dort — der
   *  Sidecar merkt sich hier nur, wer den Thread bearbeitet (`ownerAgentId`). */
  agentId?: string;
  /** Nur für `start`: vom Menschen bearbeitetes Label/Brief (sonst gilt das Proposal). */
  label?: string;
  brief?: string;
}

/** Zustand des Verbunds — vollständige Spiegelung für Pill, Tab und Settings.
 *  Re-Emit bei `request_snapshot` (idempotent, ersetzt lokal alles). */
export interface LinkStatusMsg extends BaseMsg {
  type: "link_status";
  state: "none" | "pending" | "active" | "peer_offline";
  config?: ProjectLinkConfig;
  peer?: PresenceView;
  contract: { ownFp?: string; peerFp?: string; peerAckedFp?: string; drift: boolean };
  threads: LinkThread[];
  /** Unverarbeitete Nachrichten im eigenen Eingang (Gegenseite war offline / noch pending). */
  queued: number;
  /** Grund, weshalb der Link (noch) nicht aktiv ist — für den Hinweis im Settings-Panel. */
  hint?: string;
}

/** Eine EINGEGANGENE Peer-Nachricht für Timeline/Karte. Trägt die `agentId` des Integrators
 *  (Routing-Regel §6.3: der Verbund ist Integrator-Sache). */
export interface PeerMessageMsg extends BaseMsg {
  type: "peer_message";
  agentId: string;
  threadId: string;
  msg: PeerMessage;
  from: { slug: string; repoRoot: string };
}

/** Entwurf des Integrators für einen Abgleich-Stream → Karte mit [Starten] [Bearbeiten] [Ablehnen]. */
export interface PeerProposalMsg extends BaseMsg {
  type: "peer_proposal";
  agentId: string;
  threadId: string;
  label: string;
  brief: string;
  /** Verbund steht auf `autopilot` UND der Loop-Guard ist frei → das Frontend legt den Stream
   *  SOFORT an (wie bei `spawn_substreams_request`), statt auf den Klick zu warten. Die
   *  Entscheidung trifft der Sidecar; das Frontend führt sie nur aus. */
  autostart?: boolean;
}

// ============================================================================
// Rust-Core -> Frontend (Channel-Payload). Der Core forwarded rohe Zeilen.
// ============================================================================
export type SidecarChannelEvent =
  | { type: "line"; line: string } // eine NDJSON-Zeile (zu SidecarMessage parsen)
  | { type: "stderr"; line: string } // Sidecar-Log (Diagnose)
  | { type: "exit"; code: number | null };
