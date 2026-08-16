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
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { startSidecar, sendHost, envelope, pickFolder, pickSaveFile, pickHandoffFile } from "./ipc";
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
  IncomingPr,
  ReconcileSummaryMsg,
  HandoffResultMsg,
  AutonomyConfig,
  PermissionMode,
  AutopilotLevel,
  EffortMode,
  ImageInput,
  TimelineAttachment,
  SavedPrompt,
} from "../shared/protocol";
import { DEFAULT_EFFORT, clampEffort, modelLabel, EFFORT_LABEL } from "./modelCatalog";
import type { Collision } from "../shared/collision";
import { loadRecentProjects, rememberProject, forgetProject, type RecentProject } from "./recent";
import { loadUiPrefs, saveUiPrefs, type ViewId } from "./uiPrefs";
import { notifyOsPermission, dismissOsPermission, notifyOsAuthRelogin } from "./osNotify";
import { toolCommand } from "./toolText";
import { blobToBase64, base64ToBytes, extForMime, dirname, makeThumbnail } from "./blob";
import { openMarkdownWindow } from "./detachWindow";

/** `rel` relativ zu `baseDir` auflösen (mit `..`/`.`-Kollaps). Führendes `/` = absolut. */
function resolveRel(baseDir: string, rel: string): string {
  const out = rel.startsWith("/") ? [] : baseDir.split("/").filter(Boolean);
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return "/" + out.join("/");
}
import { EDIT_TOOLS, toEditOp, editPath, type EditOp } from "./editOps";

export type AgentRole = "integrator" | "sub";
export type { ViewId } from "./uiPrefs";

export interface TodoItem {
  content: string;
  status: string; // "pending" | "in_progress" | "completed"
  activeForm?: string;
}

export type NoticeTone = "info" | "warn" | "err" | "ok" | "accent";

/** Status des lokalen Whisper-Sprachmodells (Spracheingabe). */
export interface WhisperVM {
  installed: boolean;
  checked: boolean;
  downloading: boolean;
  progress: number; // 0..1
}
/** Laufzeit-Status des Diktats (Aufnahme/Transkription). */
export interface DictationVM {
  recording: boolean;
  transcribing: boolean;
  error?: string;
}

export type TimelineEvent =
  | { id: string; kind: "user"; text: string; attachments?: TimelineAttachment[] }
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

/** Eine Ausgabezeile des Stream-Dev-Servers (Live-Log im Inspector). */
export interface DevLogLine {
  id: string;
  service: string;
  stream: "stdout" | "stderr";
  line: string;
}
/** Sicht auf den Stream-Dev-Server (Front-/Backend im Worktree, siehe `.mads/run.json`). */
export interface DevServerVM {
  state: "installing" | "starting" | "running" | "stopped" | "error" | "unconfigured";
  url?: string;
  services?: { name: string; ready: boolean; url?: string; alive?: boolean; assumed?: boolean }[];
  message?: string;
  /** Teilweise gestartet — mindestens ein Dienst tot, andere laufen. Steuert die gelbe Anzeige. */
  degraded?: boolean;
  deadServices?: string[];
}

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
  autopilot: AutopilotLevel; // Autopilot-Stufe dieses Streams (Default „assisted")
  model?: string; // ANGEFORDERTES Modell dieses Streams (Picker-Wunsch + pro-Stream-Umschaltung)
  activeModel?: string; // REAL vom SDK gelaufenes Modell (Doppel-Check) — maßgeblich für die Anzeige
  modelMismatch?: boolean; // true = SDK lief auf einem anderen Modell als angefordert (mads zieht nach)
  effort?: EffortMode; // Reasoning-Effort dieses Streams (undefined = Modell ohne Effort, z. B. Haiku)
  createdAt: number;
  lastEventAt: number;
  /** Zeitpunkt, ab dem der aktuelle aktive Lauf zählt (für die Laufzeit-Anzeige). */
  workStartedAt?: number;
  branch?: string;
  worktreePath?: string;
  behind: number;
  ahead: number;
  dirty: boolean; // uncommitted ODER untracked
  /** main-Dirt stammt aus einem gerade erkannten Deploy (Eskalation `main_deploy_dirty`) —
   *  dann ist „Als Release committen" der Primärschritt (nicht „In Sub-Stream auslagern").
   *  Gelöscht, sobald ein git_status mit dirty=false für diesen Agenten eintrifft. */
  deployDirty?: boolean;
  syncBlocked?: boolean; // Auto-Sync pausiert (Rebase-Konflikt) — manuelles Eingreifen nötig
  pr?: PullRequestInfo;
  gate?: { ok: boolean; steps: GateStep[] };
  /** Zustand des Stream-Dev-Servers (Front-/Backend im Worktree; undefined = nie gestartet). */
  devServer?: DevServerVM;
  /** true = im Sidecar-Pool aktiv (gestartet/fortgesetzt). false = passiv wiederhergestellt
   *  (Kachel + Verlauf sichtbar, aber KEINE laufende KI — wird beim ersten Senden fortgesetzt). */
  live?: boolean;
  /** Zuletzt vom Menschen abgesetzter Prompt (Kachel-Übersicht: „was habe ich wem aufgetragen").
   *  Gesetzt beim user_text-Event, sichtbar bis zum Merge (isMergedDone) — dann gelöscht. Reine
   *  Laufzeit-Anzeige, NICHT persistiert: passiv wiederhergestellte Streams haben daher keinen. */
  lastPrompt?: string;
  /** Aktive Teil-Agenten (Sub-Agenten via Task/Agent-Tool), die dieser Stream gerade laufen hat —
   *  Hintergrund-Agenten-Übersicht. Key = tool_use_id des Task-Aufrufs. Aus dem SDK-Strom abgeleitet
   *  (parent_tool_use_id), reine Laufzeit-Info: bei Abschluss (tool_result) wird der Eintrag entfernt. */
  subAgents?: Record<string, SubAgentEntry>;
  /** Gesetzt = dies ist ein READ-ONLY Review-Stream für einen FREMDEN PR (kein KI-Stream): PR-Nummer,
   *  Autor, URL. Die Kachel zeigt statt „Fortsetzen" ein „PR mergen" + „Verwerfen". */
  reviewPr?: number;
  reviewAuthor?: string;
  reviewUrl?: string;
}

/** Ein laufender Teil-Agent (SDK-Sub-Agent) eines Streams — für die Hintergrund-Aktivitäts-Übersicht. */
export interface SubAgentEntry {
  id: string; // tool_use_id des startenden Task/Agent-Aufrufs
  label: string; // Kurzbeschreibung (description bzw. subagent_type aus dem Task-Input)
  currentStep?: string; // zuletzt vom Teil-Agenten benutztes Tool (= „was tut er gerade")
  startedAt: number;
  lastAt: number;
}

export interface SidecarInfo {
  status: "down" | "starting" | "ready" | "error";
  sdkAvailable: boolean;
  sdkVersion?: string;
}

// ── Change-Overview (docs/design/09-change-overview.md §3.2) ──
/**
 * Ein gerade (oder zuletzt) von einem Stream editierter Datei-Pfad — die Datenquelle
 * der Diff-Panes. Key in `editsByFile`: `${agentId}::${path}` (eine Pane pro Stream×Datei,
 * §3.2). Rein aus dem `tool_use`-Payload abgeleitet (Option A, zero-read).
 */
export interface FileEditEntry {
  agentId: string;
  path: string; // file_path bzw. notebook_path aus dem tool_use-Input
  ops: EditOp[]; // chronologisch; spätere Edits sehen frühere angewandt
  toolUseIds: string[]; // Korrelation mit tool_result (completeTool)
  status: "applying" | "applied" | "failed"; // via tool_result umgeschaltet
  firstEditAt: number;
  lastEditAt: number; // treibt Highlight-Fade (§1.2)
  contextDoc?: string; // optional: durch Core gelesener Vorzustand (Option C, §4) — Post-MVP
}

/** Pane-/File-Deckel (OE-45, §6). Jede Deckelung wird sichtbar gemacht + in debugLog protokolliert. */
export const MAX_VISIBLE_PANES = 8;
export const MAX_FILES = 200;
/** Coalescing-Fenster für schnelle Hunks (§6): mehrere Hunks → ein Re-Render-Tick. */
const EDIT_COALESCE_MS = 50;

export const editKey = (agentId: string, path: string) => `${agentId}::${path}`;

// ── Datei-Explorer (docs/design/07-file-explorer.md §3.1) ──
/**
 * Welcher Stream-Kontext wird gebrowst — main/Integrator ODER ein Sub-Agent-Worktree.
 * BEIDE Varianten sind gleichwertig (lesbar UND schreibbar, OE-35): beide werden per
 * setActiveRoot im Core registriert (mads_register_root → allow_directory).
 */
export type ExplorerRoot =
  | { kind: "project"; path: string }
  | { kind: "worktree"; agentId: string; path: string };

export interface DirNode {
  name: string;
  path: string; // absoluter Pfad (vom Core kanonisiert geliefert)
  isDir: boolean;
  isSymlink: boolean;
}

export type FileKind = "markdown" | "code" | "image" | "binary";

/** Markdown-Editor-View-Modus (docs/design/08-markdown-editor.md §1.1, OE-36).
 *  Global (eine .md zugleich offen), session-only (nicht persistiert). */
export type ViewMode = "preview" | "edit" | "split" | "wysiwyg";

/** Nicht-Bild-Anhang im Composer: nach `<cwd>/.mads/attachments/` geschrieben (gitignored),
 *  im Prompt per `relPath` referenziert. Bilder laufen dagegen als base64-`ImageInput`. */
export interface AttachedFile {
  name: string; // Anzeigename
  relPath: string; // relativ zum Stream-cwd, z.B. .mads/attachments/1699…-report.pdf
  size: number; // Bytes
}

/** Core-Lese-Resultat (FileRead, doc 07 §4.2) — DER CORE entscheidet text/binary. */
type CoreFileRead =
  | { kind: "text"; text: string; mtimeMs: number; size: number; hash: string; truncated: boolean }
  | { kind: "binary"; bytesBase64: string; mtimeMs: number; size: number; hash: string; truncated: boolean };

type CoreWriteResult =
  | { kind: "saved"; mtimeMs: number; size: number; hash: string }
  | { kind: "conflict" };

export interface OpenFile {
  path: string;
  kind: FileKind;
  diskMtimeMs: number; // Conflict-Signal (§7)
  diskSize: number;
  diskHash: string; // autoritatives Conflict-Signal (§7)
  coreKind: "text" | "binary";
  loadedText?: string; // bei coreKind:"text"
  bytesBase64?: string; // bei coreKind:"binary"
  dataUrl?: string; // bei kind:"image"
  truncated: boolean;
}

const IMAGE_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

const CODE_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "rs", "py", "go", "java", "c", "h", "cpp", "hpp",
  "cc", "rb", "php", "sh", "bash", "zsh", "css", "scss", "html", "xml", "yaml", "yml", "toml",
  "sql", "swift", "kt", "lua", "vue", "svelte",
]);

/** Typ-Erkennung aus Endung + Core-Flag (doc 07 §2.2). coreKind:"binary" überstimmt
 *  jede Code-/Markdown-Endung (Nicht-UTF-8 → Binär-Fallback). */
export function fileKind(path: string, coreKind: "text" | "binary"): FileKind {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext in IMAGE_EXT) return "image";
  if (coreKind === "binary") return "binary";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (CODE_EXT.has(ext)) return "code";
  return "code"; // sonstiger UTF-8-Text als Code-Highlight (Plaintext)
}

export interface MadsState {
  sidecar: SidecarInfo;
  project?: ProjectInfo;
  projectStatus: "none" | "opening" | "ready" | "error";
  /** Öffnen abgelehnt: Projekt ist in einer anderen mads-Instanz offen (Multi-Instanz-Schutz). */
  projectLocked?: { repoRoot: string };
  recentProjects: RecentProject[];
  agents: Record<string, AgentVM>;
  order: string[];
  events: Record<string, TimelineEvent[]>;
  /** Live-Log des Stream-Dev-Servers pro Agent (Ringpuffer). */
  devLog: Record<string, DevLogLine[]>;
  permissions: PermissionRequestMsg[];
  escalations: SidecarErrorMsg[];
  /** Maschinenweiter Auth-Ausfall (authentication_failed/oauth_org_not_allowed): zeigt den
   *  „Bei Claude neu anmelden"-Banner. Dedupliziert (ein Banner/eine OS-Meldung pro Episode). */
  authReloginNeeded: boolean;
  resumables: ResumableAgent[];
  /** Eingehende fremde PRs (Bots gefiltert), die mads zum read-only Review anbietet. */
  incomingPrs: IncomingPr[];
  /** Einmaliger GitHub-Abgleich beim Öffnen (FF main / aufgeräumt / Reste) — dismissbar. */
  reconcileSummary?: ReconcileSummaryMsg;
  /** Ergebnis des letzten Handoff-Export/-Imports — treibt einen dismissbaren Banner. */
  handoff?: HandoffResultMsg;
  collisions: Collision[];
  /** Kuratierte, wiederverwendbare Prompts des Projekts (reiner Spiegel — Persistenz macht
   *  der Sidecar in `<repoRoot>/.mads/prompts.json`, gemeldet via prompts_update). */
  prompts: SavedPrompt[];
  // ── Spracheingabe (lokales Whisper) ──
  whisper: WhisperVM;
  dictation: DictationVM;
  autonomy: AutonomyConfig;
  selectedId?: string;
  /** Signal an App, den „Neuer Stream"-Dialog zu öffnen (z. B. Integrator-Guard → „Als Sub-Stream starten"
   *  öffnet ihn vorbefüllt aus dem newStreamDraft). App setzt es beim Schließen zurück. */
  newStreamRequested: boolean;
  debugLog: string[];
  /** Offener „Parallel starten"-Picker (nach Anforderung der Integrator-Einschätzung). */
  parallelPicker?: { agentId: string; options: { label: string; description: string }[] };
  /** Composer-Entwürfe je Agent (Text + Anhänge) — bleiben beim Umschalten erhalten. */
  drafts: Record<string, string>;
  draftImages: Record<string, ImageInput[]>;
  /** Nicht-Bild-Anhänge je Agent: liegen in `<cwd>/.mads/attachments/` (gitignored) und werden
   *  beim Senden per relativem Pfad im Prompt referenziert (der Agent liest sie). */
  draftFiles: Record<string, AttachedFile[]>;

  // ── Activity-Rail / Primary-Panel (docs/design/10-navigation-toolbar.md §3.1) ──
  /** Welcher Rail-View aktiv ist (persistiert). "streams" (Default) ⇒ KEIN Primary-Panel
   *  — nur Content (§1a.5); "files"/"settings" ⇒ aktivitäts-spezifisches Mittel-Panel.
   *  "changes" ist KEIN ViewId — Overlay via changeOverviewOn (§2.3). */
  activeView: ViewId;
  /** Rail nur-Icon (true) vs. Icon+Text (false) (persistiert). */
  railCollapsed: boolean;
  /** Globaler Default fürs Modell neuer Streams (linke Navigation, persistiert). */
  defaultModel: string;
  /** Globaler Default für den Effort neuer Streams (persistiert). */
  defaultEffort: EffortMode;
  /** Change-Overview-Overlay an/aus (Owner: doc 09). Der Rail-„Änderungen"-Eintrag toggelt es (§2.3). */
  changeOverviewOn: boolean;
  /** Live-Diff-Quelle: Datei-Edits je Stream×Datei (doc 09 §3.2). Key: `${agentId}::${path}`. */
  editsByFile: Record<string, FileEditEntry>;

  // ── Datei-Explorer (docs/design/07-file-explorer.md §3.1) ──
  activeRoot: ExplorerRoot | null; // gewählter Stream-Kontext; null = kein Projekt offen
  treeChildren: Record<string, DirNode[]>; // keyed by Verzeichnis-Pfad (lazy)
  treeExpanded: Record<string, boolean>;
  treeFilter: string;
  selectedFilePath?: string;
  openFile?: OpenFile;
  editorBuffers: Record<string, string>; // path → ungespeicherter Inhalt (dirty wenn ≠ loadedText)
  externalChanged: Record<string, boolean>;
  fsError?: string;
  fileConflict?: string; // path mit Disk-Drift beim Save → conflicted-Sheet
  // ── Markdown-Editor (docs/design/08-markdown-editor.md §3.1) ──
  editorViewMode: ViewMode; // global (eine .md zugleich, OE-36/OE-38), session-only
  editorSaving: Record<string, boolean>; // path → Save in flight (Doppel-Save/Race vermeiden, §7)
  saveNotice?: { tone: NoticeTone; text: string }; // leichte globale Save-Notice (§3.3, OE-37)

  init: () => Promise<void>;
  setAutonomy: (config: AutonomyConfig) => Promise<void>;
  openProject: () => Promise<void>;
  /** Kompletten Projekt-Stand (alle Streams) in eine Datei exportieren bzw. eine importieren. */
  exportHandoff: () => Promise<void>;
  importHandoff: () => Promise<void>;
  dismissHandoff: () => void;
  openRecentProject: (repoRoot: string, force?: boolean) => Promise<void>;
  forgetRecentProject: (repoRoot: string) => void;
  createAgent: (opts: {
    label: string;
    prompt: string;
    role: AgentRole;
    mock: boolean;
    model?: string;
    effort?: EffortMode;
    branch?: string;
    permissionMode?: PermissionMode;
  }) => Promise<void>;
  selectAgent: (id: string) => void;
  requestNewStream: () => void;
  dismissEscalations: () => void;
  /** Auth-Banner schließen (setzt authReloginNeeded zurück). */
  dismissAuthRelogin: () => void;
  /** Öffnet ein Terminal mit `claude auth login` (Browser-OAuth). mads berührt den Token nie. */
  reloginClaude: () => Promise<void>;
  /** `claude auth status` in der Login-Shell → reiner Status-Text (kein Secret). */
  checkAuthStatus: () => Promise<string>;
  setDraft: (agentId: string, text: string) => void;
  setDraftImages: (agentId: string, images: ImageInput[]) => void;
  setDraftFiles: (agentId: string, files: AttachedFile[]) => void;
  /** Dateien aus „+"-Auswahl oder Drag&Drop anhängen: Bilder → base64-Anhang (multimodal),
   *  sonstige → nach `.mads/attachments/` schreiben + als Datei-Anhang referenzieren. */
  attachToDraft: (agentId: string, files: File[]) => Promise<void>;
  answerPermission: (req: PermissionRequestMsg, decision: PermissionDecision) => Promise<void>;
  requestParallelAssessment: (req: PermissionRequestMsg) => Promise<void>;
  spawnParallelStreams: (picks: { label: string; brief: string }[]) => Promise<void>;
  cancelParallelPicker: () => void;
  /** Prompt anlegen/ändern (Upsert per id) — der Sidecar persistiert und spiegelt via prompts_update. */
  savePrompt: (prompt: SavedPrompt) => Promise<void>;
  /** Prompt löschen (die Bestätigung macht die UI vorher). */
  deletePrompt: (id: string) => Promise<void>;
  sendInput: (id: string, text: string, images?: ImageInput[]) => Promise<void>;
  setPermissionMode: (id: string, mode: PermissionMode) => Promise<void>;
  setAutopilot: (id: string, level: AutopilotLevel) => Promise<void>;
  /** Globalen Default (linke Navigation) setzen — gilt für NEU eröffnete Streams. */
  setDefaultModel: (model: string) => void;
  setDefaultEffort: (effort: EffortMode) => void;
  /** Modell/Effort eines bestehenden Streams LIVE umstellen (Inspector). */
  setStreamModel: (id: string, model: string) => Promise<void>;
  setStreamEffort: (id: string, effort: EffortMode) => Promise<void>;
  interruptAgent: (id: string) => Promise<void>;
  stopAgent: (id: string, removeWorktree: boolean) => Promise<void>;
  commitAgent: (id: string) => Promise<void>;
  createPr: (id: string) => Promise<void>;
  syncBranch: (id: string) => Promise<void>;
  /** Geführte Konfliktlösung: beauftragt den Agenten, den Rebase-Konflikt im Worktree zu lösen. */
  resolveConflict: (id: string) => Promise<void>;
  /** Uncommittete Änderungen des Main-Checkouts in einen neuen Sub-Stream auslagern. */
  outsourceMain: (integratorId: string) => Promise<void>;
  /** Den aktuellen (Deploy-)Stand des Main-Checkouts als Release-Commit festhalten (chore(release): …). */
  commitMainRelease: (integratorId: string) => Promise<void>;
  /** Integrator-only: main per fast-forward auf origin/<default> nachziehen (kein rebase). */
  updateMain: (id: string) => Promise<void>;
  resetMain: (id: string) => Promise<void>;
  pushMain: (id: string) => Promise<void>;
  /** Konsolidiert „Alle aktualisieren": main fast-forward + alle hinterherhängenden Subs rebasen. */
  syncAllBehind: () => Promise<void>;
  integratePr: (id: string, keep?: boolean) => Promise<void>;
  runGate: (id: string) => Promise<void>;
  startDevServer: (id: string) => Promise<void>;
  stopDevServer: (id: string) => Promise<void>;
  configureDevServer: (id: string) => Promise<void>;
  /** Einen eingehenden PR als read-only Review-Stream öffnen. */
  openReviewStream: (pr: IncomingPr) => Promise<void>;
  /** Review-PR annehmen (squash-merge) + Stream schließen. */
  mergeReview: (id: string) => Promise<void>;
  /** Review-Stream verwerfen (ohne Merge) + Worktree entfernen. */
  closeReview: (id: string) => Promise<void>;
  pollProject: () => Promise<void>;
  resumeAgent: (r: ResumableAgent) => Promise<void>;
  resumeAll: () => Promise<void>;
  /** Beim Öffnen: alle Streams als passive Kacheln + Verlauf wiederherstellen, nur laufende fortsetzen. */
  restoreSessions: (agents: ResumableAgent[]) => Promise<void>;
  /** Persistierten Chat-Verlauf eines Streams laden. */
  loadTranscript: (agentId: string) => Promise<void>;
  /** Passiv wiederhergestellten Stream aktiv fortsetzen (Knopf „Fortsetzen"). */
  continueStream: (id: string) => Promise<void>;
  // ── Spracheingabe ──
  checkWhisper: () => Promise<void>;
  downloadWhisper: () => Promise<void>;
  /** Mikro-Icon: Toggle (Start/Stop). */
  toggleDictation: () => Promise<void>;
  /** Hotkey: Push-to-talk. */
  startDictation: () => Promise<void>;
  stopDictation: () => Promise<void>;
  /** Erledigten (gemergten) Stream mit lokalen Resten endgültig aufräumen (Worktree+Branch weg). */
  cleanupResumable: (r: ResumableAgent) => Promise<void>;
  dismissReconcile: () => void;

  // ── Activity-Rail / Primary-Panel actions (doc 10 §3.1) ──
  setActiveView: (view: ViewId) => void;
  toggleRailCollapsed: () => void;
  setRailCollapsed: (collapsed: boolean) => void;
  toggleChangeOverview: () => void;
  /** Alle Diff-Panes räumen (für Tests/Aufräum-Wege) — leert `editsByFile`. */
  clearEdits: () => void;

  // ── Datei-Explorer actions (doc 07 §3.2) ──
  setActiveRoot: (root: ExplorerRoot) => Promise<void>;
  expandDir: (path: string) => Promise<void>;
  collapseDir: (path: string) => void;
  setTreeFilter: (text: string) => void;
  openFilePath: (path: string) => Promise<void>;
  enterEditMode: (path: string) => void;
  setEditorBuffer: (path: string, text: string) => void;
  saveFile: (path: string) => Promise<void>;
  reloadFile: (path: string) => Promise<void>;
  discardEdit: (path: string) => void;
  // ── Markdown-Editor actions (doc 08 §3.1) ──
  setEditorViewMode: (mode: ViewMode) => void;
  /** Bild-Blob nach `<dir>/assets/<ts>-<n>.<ext>` schreiben (Core, binär) und einen
   *  relativen Markdown-Link an `cursor` in den Buffer einfügen. §1.2/§4.2/OE-39. */
  insertImageFromBlob: (path: string, blob: Blob, cursor: number) => Promise<number>;
  /** `[[name]]` relativ zur aktuell offenen .md auf `./<name>.md` auflösen und öffnen (§1.2/§5.4). */
  openWikiLink: (fromPath: string, name: string) => Promise<void>;
  /** Interner `.md`-Verweis (relativer Link) → Ziel auflösen und in eigenem Fenster öffnen. */
  openMdReference: (fromPath: string, href: string) => Promise<void>;
  clearSaveNotice: () => void;
}

const mkId = () => crypto.randomUUID();

// Whisper halluziniert bei (fast) leerem/sehr kurzem Audio typische YouTube-Untertitel-Floskeln
// (die im Trainingsmaterial massenhaft am Clip-Ende stehen). Backstop hinter der PTT-Halte-Schwelle:
// ist der GANZE Transkript-Text nur eine solche Floskel, NICHT in den Entwurf einfügen. Nur exakte
// Voll-Text-Treffer (nach Kleinschreibung + Satzzeichen-Trim), damit echte Diktate unberührt bleiben.
const WHISPER_HALLUCINATIONS = new Set([
  "you",
  "thank you", "thank you very much", "thanks", "thanks for watching",
  "thanks for watching!", "thank you for watching", "please subscribe",
  "subtitles by the amara.org community",
  "vielen dank", "vielen dank fürs zuschauen", "vielen dank für's zuschauen",
  "untertitel", "untertitelung", "untertitel im auftrag des zdf für funk, 2017",
  "untertitel der amara.org-community", "untertitelung des zdf, 2020",
]);
function isWhisperHallucination(text: string): boolean {
  const t = text.toLowerCase().replace(/[\s.!?,…"„"»«]+$/u, "").replace(/^[\s.!?,…"„"»«]+/u, "").trim();
  return WHISPER_HALLUCINATIONS.has(t);
}

// Transkript-Persistenz (Session-Restore): den UI-Verlauf je Stream debounced auf Platte
// schreiben (<repoRoot>/.mads/transcripts/<agentId>.json), damit er nach dem Neustart
// wieder erscheint. Pro Agent ein Timer; häufige Events werden gebündelt.
const transcriptTimers = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleTranscriptSave(agentId: string): void {
  const existing = transcriptTimers.get(agentId);
  if (existing) clearTimeout(existing);
  transcriptTimers.set(
    agentId,
    setTimeout(() => {
      transcriptTimers.delete(agentId);
      const st = useStore.getState();
      const repo = st.project?.repoRoot;
      const evs = st.events[agentId];
      if (!repo || !evs || evs.length === 0) return;
      void invoke("mads_save_transcript", { repoRoot: repo, agentId, content: JSON.stringify(evs) }).catch(() => {});
    }, 1500),
  );
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

  /** Eine Kachel lokal entfernen (Agent + Verlauf + Diff-Panes + Dev-Log). Genutzt von stopAgent,
   *  Review-Merge/-Verwerfen. */
  function removeAgentLocal(id: string) {
    set((s) => {
      const agents = { ...s.agents };
      delete agents[id];
      const events = { ...s.events };
      delete events[id];
      const order = s.order.filter((x) => x !== id);
      const prefix = `${id}::`;
      const editsByFile = Object.fromEntries(Object.entries(s.editsByFile).filter(([k]) => !k.startsWith(prefix)));
      const devLog = { ...s.devLog };
      delete devLog[id];
      return { agents, events, order, editsByFile, devLog, selectedId: s.selectedId === id ? order[0] : s.selectedId };
    });
  }

  function pushEvent(agentId: string, ev: TimelineEvent) {
    set((s) => {
      const prev = s.events[agentId] ?? [];
      const next = [...prev, ev];
      if (next.length > 800) next.splice(0, next.length - 800); // Ringpuffer
      return { events: { ...s.events, [agentId]: next } };
    });
    scheduleTranscriptSave(agentId); // Verlauf für Session-Restore persistieren (debounced)
  }

  function notice(agentId: string, tone: NoticeTone, text: string) {
    pushEvent(agentId, { id: mkId(), kind: "notice", tone, text });
  }

  // ── Teil-Agenten (Sub-Agenten via Task/Agent-Tool): Hintergrund-Aktivitäts-Übersicht ──
  // Aus dem SDK-Strom abgeleitet: Task-tool_use startet einen, parent_tool_use_id-Aktivität hält ihn
  // aktuell, tool_result auf die Task-id beendet ihn. Rein Laufzeit; sequentiell verarbeitet (kein Race).
  function upsertSubAgent(agentId: string, subId: string, patch: { label?: string; currentStep?: string }) {
    const a = useStore.getState().agents[agentId];
    if (!a) return;
    const now = Date.now();
    const cur = a.subAgents ?? {};
    const prev = cur[subId];
    const entry: SubAgentEntry = prev
      ? { ...prev, ...(patch.label ? { label: patch.label } : {}), ...(patch.currentStep ? { currentStep: patch.currentStep } : {}), lastAt: now }
      : { id: subId, label: patch.label ?? "Teil-Agent", currentStep: patch.currentStep, startedAt: now, lastAt: now };
    patchAgent(agentId, { subAgents: { ...cur, [subId]: entry } });
  }
  function removeSubAgent(agentId: string, subId: string) {
    const a = useStore.getState().agents[agentId];
    if (!a?.subAgents || !(subId in a.subAgents)) return;
    const next = { ...a.subAgents };
    delete next[subId];
    patchAgent(agentId, { subAgents: next });
  }

  function appendDevLog(agentId: string, line: DevLogLine) {
    set((s) => {
      const prev = s.devLog[agentId] ?? [];
      const next = [...prev, line];
      if (next.length > 600) next.splice(0, next.length - 600); // Ringpuffer
      return { devLog: { ...s.devLog, [agentId]: next } };
    });
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
      // Change-Overview: das passende Diff-Pane auf applied/failed umschalten (§3.3).
      // tool_result trägt nur die toolUseId — wir finden den Eintrag über toolUseIds.
      let editsByFile = s.editsByFile;
      for (const [key, entry] of Object.entries(editsByFile)) {
        if (entry.agentId === agentId && entry.toolUseIds.includes(toolUseId)) {
          editsByFile = { ...editsByFile, [key]: { ...entry, status: ok ? "applied" : "failed" } };
        }
      }
      return { events: { ...s.events, [agentId]: next }, editsByFile };
    });
  }

  /**
   * Edit-Hunk in `editsByFile` einsortieren (§3.3). Coalesct schnelle Hunks pro Datei in
   * einem ~50 ms-Fenster (§6): wir akkumulieren in `pendingEdits` und flushen gebündelt.
   * Caps (OE-45): `maxFiles` Ring-Buffer (ältester `lastEditAt` zuerst) — Deckelung sichtbar
   * in debugLog protokolliert (nie still abschneiden).
   */
  let pendingEdits: Array<{ agentId: string; path: string; toolUseId: string; op: EditOp }> = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  function flushEdits() {
    flushTimer = undefined;
    const batch = pendingEdits;
    pendingEdits = [];
    if (!batch.length) return;
    set((s) => {
      const editsByFile = { ...s.editsByFile };
      const now = Date.now();
      for (const { agentId, path, toolUseId, op } of batch) {
        const key = editKey(agentId, path);
        const prev = editsByFile[key];
        editsByFile[key] = prev
          ? {
              ...prev,
              ops: [...prev.ops, op],
              toolUseIds: prev.toolUseIds.includes(toolUseId) ? prev.toolUseIds : [...prev.toolUseIds, toolUseId],
              status: "applying",
              lastEditAt: now,
            }
          : {
              agentId,
              path,
              ops: [op],
              toolUseIds: [toolUseId],
              status: "applying",
              firstEditAt: now,
              lastEditAt: now,
            };
      }
      // Ring-Buffer-Deckel (OE-45) — ältester lastEditAt zuerst geräumt, Deckelung geloggt.
      const keys = Object.keys(editsByFile);
      let debugLog = s.debugLog;
      if (keys.length > MAX_FILES) {
        const sorted = keys.sort((a, b) => editsByFile[a].lastEditAt - editsByFile[b].lastEditAt);
        const dropCount = keys.length - MAX_FILES;
        for (const k of sorted.slice(0, dropCount)) delete editsByFile[k];
        debugLog = [...s.debugLog.slice(-400), `change-overview: ${dropCount} Datei(en) geräumt (Deckel ${MAX_FILES})`];
      }
      return { editsByFile, debugLog };
    });
  }

  function upsertEdit(agentId: string, path: string, toolUseId: string, op: EditOp) {
    pendingEdits.push({ agentId, path, toolUseId, op });
    if (!flushTimer) flushTimer = setTimeout(flushEdits, EDIT_COALESCE_MS);
  }

  function handleSidecarMessage(msg: SidecarMessage) {
    switch (msg.type) {
      case "project_locked":
        // Projekt ist in einer anderen mads-Instanz offen → nicht öffnen. Ist bereits ein Projekt
        // geladen (fehlgeschlagener WECHSEL), es behalten + "ready" bleiben; sonst zurück zur
        // Auswahl ("none"). Der Header-Banner zeigt den Hinweis in beiden Fällen.
        set((s) => ({ projectStatus: s.project ? "ready" : "none", projectLocked: { repoRoot: msg.repoRoot } }));
        break;

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
        set((s) => {
          // Echter Projektwechsel (anderer repoRoot) → den PROJEKT-gebundenen Zustand KOMPLETT
          // räumen, damit keine Streams/Transkripte/Eskalationen/Entwürfe des alten Projekts in
          // der neuen Ansicht hängen bleiben (Fehlklick-Risiko auf einen Fremd-Projekt-Stream).
          // Beim Re-Open DESSELBEN Projekts NICHT räumen — der Sidecar-Pool behält dort die
          // Live-Sessions und würde sie nicht erneut anbieten.
          const switching = !!s.project && s.project.repoRoot !== msg.project.repoRoot;
          return {
            project: msg.project,
            projectStatus: "ready",
            projectLocked: undefined, // erfolgreiches Öffnen → evtl. alten Lock-Hinweis verwerfen
            recentProjects: rememberProject(s.recentProjects, msg.project, Date.now()),
            // Reconcile-Artefakte des Vorprojekts immer verwerfen (frischer Abgleich meldet neu).
            reconcileSummary: undefined,
            resumables: [],
            ...(switching
              ? {
                  agents: {},
                  order: [],
                  events: {},
                  devLog: {},
                  permissions: [],
                  escalations: [],
                  authReloginNeeded: false,
                  collisions: [],
                  editsByFile: {},
                  selectedId: undefined,
                  parallelPicker: undefined,
                  drafts: {},
                  draftImages: {},
                  draftFiles: {},
                }
              : {}),
          };
        });
        // repoRoot im Core registrieren + als Default-Explorer-Root setzen (doc 07 §4.2:
        // „aufgerufen direkt nachdem project gesetzt ist"). Erst bei aktiver Files-View geladen.
        void useStore.getState().setActiveRoot({ kind: "project", path: msg.project.repoRoot });
        // Remote-Bridge (falls aktiviert) auf DIESES Projekt umschalten → per-Projekt-Zertifikat/
        // -Identität in <repoRoot>/.mads/remote-bridge/ (Multi-Instanz: jede Instanz eindeutig).
        void invoke("remote_set_project", {
          repoRoot: msg.project.repoRoot,
          label: `${msg.project.owner}/${msg.project.repo}`,
        }).catch(() => {});
        break;

      case "status_update":
        set((s) => {
          const a = s.agents[msg.agentId];
          if (!a) return {};
          const active = msg.status === "running" || msg.status === "starting";
          const workStartedAt = active ? (a.workStartedAt ?? Date.now()) : undefined;
          // Terminaler Status (fertig/Fehler) → keine Teil-Agenten mehr aktiv (fängt den Rand-Fall ab,
          // dass ein Stream endet, während ein Sub-Agent noch als „laufend" gemerkt war).
          const subAgents = msg.status === "done" || msg.status === "error" ? undefined : a.subAgents;
          return {
            agents: {
              ...s.agents,
              [msg.agentId]: { ...a, status: msg.status, currentStep: msg.currentStep, workStartedAt, lastEventAt: Date.now(), subAgents },
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
        patchAgent(msg.agentId, {
          behind: msg.behind,
          ahead: msg.ahead,
          dirty: msg.dirty,
          syncBlocked: msg.syncBlocked ?? false,
          // Deploy-Flag löschen, sobald main wieder sauber ist (Release committet/ausgelagert).
          ...(msg.dirty ? {} : { deployDirty: false }),
        });
        break;

      case "pr_update":
        patchAgent(msg.agentId, { pr: msg.pr });
        break;

      case "merge_result": {
        notice(
          msg.agentId,
          msg.ok ? "ok" : "err",
          msg.ok
            ? `✔ PR${msg.prNumber ? ` #${msg.prNumber}` : ""} nach main gemerged`
            : `⛔ Merge blockiert: ${msg.reasons.join(" · ")}`,
        );
        // Review-Stream erfolgreich gemerged → Kachel entfernen (Sidecar hat den Worktree abgeräumt).
        if (msg.ok && useStore.getState().agents[msg.agentId]?.reviewPr) removeAgentLocal(msg.agentId);
        break;
      }

      case "incoming_prs":
        set({ incomingPrs: msg.prs });
        break;

      case "review_stream": {
        // Neuer READ-ONLY Review-Stream (fremder PR) → als passive Kachel anlegen (keine KI-Session).
        const id = msg.agentId;
        set((s) => {
          if (s.agents[id]) return {}; // schon da
          const vm: AgentVM = {
            id,
            label: msg.label,
            role: "sub",
            status: "done",
            costUsd: 0,
            numTurns: 0,
            inputTokens: 0,
            outputTokens: 0,
            mock: false,
            permissionMode: "auto",
            autopilot: "manual", // Review-Stream committet/pusht NIE
            createdAt: Date.now(),
            lastEventAt: Date.now(),
            branch: msg.branch,
            worktreePath: msg.worktreePath,
            behind: 0,
            ahead: 0,
            dirty: false,
            live: false,
            reviewPr: msg.reviewPr,
            reviewAuthor: msg.author,
            reviewUrl: msg.url,
          };
          return { agents: { ...s.agents, [id]: vm }, order: [...s.order, id], selectedId: id };
        });
        notice(id, "accent", `🔍 Review-Stream für PR #${msg.reviewPr} (@${msg.author}) geöffnet — Dev-Server starten, prüfen, dann „PR mergen".`);
        break;
      }

      case "gate_result":
        patchAgent(msg.agentId, { gate: { ok: msg.ok, steps: msg.steps } });
        notice(
          msg.agentId,
          msg.ok ? "ok" : "err",
          `Clean-Code-Gate: ${msg.ok ? "grün" : "rot"} — ${msg.steps.map((s) => `${s.name}:${s.status}`).join(", ")}`,
        );
        break;

      case "devserver_status":
        patchAgent(msg.agentId, {
          devServer: {
            state: msg.state,
            url: msg.url,
            services: msg.services,
            message: msg.message,
            degraded: msg.degraded,
            deadServices: msg.deadServices,
          },
        });
        if (msg.state === "running" && msg.url) notice(msg.agentId, "ok", `▶ Dev-Server läuft → ${msg.url}`);
        else if (msg.state === "stopped") notice(msg.agentId, "info", "■ Dev-Server gestoppt");
        else if (msg.state === "error") notice(msg.agentId, "err", `Dev-Server: ${msg.message ?? "Fehler"}`);
        else if (msg.state === "unconfigured") notice(msg.agentId, "warn", `⚙ ${msg.message ?? "Dev-Server noch nicht eingerichtet — auf Konfigurieren tippen."}`);
        break;

      case "devserver_config":
        // Sidecar hat .mads/run.json sichergestellt → im Editor öffnen, damit der Nutzer den
        // Dev-Server für dieses Projekt konstruiert (Befehle/Ports/Runtime). Danach „Dev-Server" starten.
        notice(
          msg.agentId,
          "accent",
          `⚙ Dev-Server-Konfig geöffnet (.mads/run.json${msg.detected > 0 ? ` — ${msg.detected} Service(s) erkannt` : " — noch leer, bitte ausfüllen"}).`,
        );
        void useStore.getState().openFilePath(msg.path);
        break;

      case "devserver_log":
        appendDevLog(msg.agentId, { id: mkId(), service: msg.service, stream: msg.stream, line: msg.line });
        break;

      case "resumable_agents":
        void useStore.getState().restoreSessions(msg.agents);
        break;

      case "reconcile_summary":
        set({ reconcileSummary: msg });
        break;

      case "handoff_result":
        set({ handoff: msg });
        break;

      case "collision_warning":
        set({ collisions: msg.collisions });
        break;

      case "prompts_update":
        // Vollständige Prompt-Liste des Projekts (bei open_project + nach jeder Änderung) — Spiegel.
        set({ prompts: msg.prompts });
        break;

      case "model_active":
        // Doppel-Check: das REAL gelaufene Modell (Grundwahrheit aus den SDK-Nachrichten). Die
        // Anzeige richtet sich hiernach, nicht nach dem Picker-Wunsch — so kann ein stiller
        // Fable-Default nicht mehr unbemerkt Tokens verbrennen.
        patchAgent(msg.agentId, { activeModel: msg.active, modelMismatch: msg.mismatch });
        break;

      case "spawn_substreams_request": {
        // Der Integrator-Chat hat per Tool N Sub-Streams angefordert → über den
        // normalen createAgent-Pfad anlegen (eigener Worktree/Branch je Stream).
        for (const st of msg.streams) {
          void useStore.getState().createAgent({ label: st.label, prompt: st.brief, role: "sub", mock: false });
        }
        notice(
          msg.parentAgentId,
          "accent",
          `▶ ${msg.streams.length} Sub-Stream(s) gestartet: ${msg.streams.map((s) => s.label).join(", ")}`,
        );
        set({ selectedId: msg.parentAgentId }); // Auswahl beim Dispatcher belassen
        break;
      }

      case "agent_event": {
        const ev = msg.event;
        if (ev.kind === "user_text") {
          // Vom Menschen eingegebene Anweisung (Mac ODER Remote) — vom Sidecar ausgespielt, damit sie
          // auf ALLEN Clients im Verlauf steht. Ersetzt die frühere rein lokale, optimistische Anzeige.
          // Auch eine reine Bild-Nachricht (Text leer) anzeigen.
          if (ev.text.trim() || ev.attachments?.length)
            pushEvent(msg.agentId, { id: mkId(), kind: "user", text: ev.text, attachments: ev.attachments });
          // Kachel-Übersicht: den zuletzt abgesetzten Auftrag merken (nur bei echtem Text — eine
          // reine Bild-Folgenachricht lässt den vorigen Auftrag stehen). Sichtbar bis zum Merge.
          // Die automatische Resume-Anweisung (continuation) ist KEIN Nutzer-Auftrag → nicht übernehmen.
          if (ev.text.trim() && !ev.continuation) patchAgent(msg.agentId, { lastPrompt: ev.text.trim() });
        } else if (ev.kind === "assistant_text" || ev.kind === "assistant_delta") {
          if (ev.text.trim()) pushEvent(msg.agentId, { id: mkId(), kind: "assistant", text: ev.text });
        } else if (ev.kind === "thinking") {
          pushEvent(msg.agentId, { id: mkId(), kind: "thinking", text: ev.text });
        } else if (ev.kind === "tool_use") {
          // Hintergrund-Agenten-Übersicht: Aktivität eines Teil-Agenten (parent_tool_use_id) hält seinen
          // „aktuellen Schritt" aktuell; ein Task/Agent-tool_use startet einen neuen Teil-Agenten.
          if (ev.parentToolUseId) upsertSubAgent(msg.agentId, ev.parentToolUseId, { currentStep: ev.name });
          if (ev.name === "Task" || ev.name === "Agent") {
            const label =
              typeof ev.input?.description === "string" ? ev.input.description
              : typeof ev.input?.subagent_type === "string" ? ev.input.subagent_type
              : "Teil-Agent";
            upsertSubAgent(msg.agentId, ev.toolUseId, { label });
          }
          if (ev.name === "TodoWrite") {
            const todos = ((ev.input?.todos as TodoItem[]) ?? []).map((t) => ({
              content: String(t.content ?? ""),
              status: String(t.status ?? "pending"),
              activeForm: t.activeForm,
            }));
            pushEvent(msg.agentId, { id: mkId(), kind: "todos", todos });
          } else {
            // Change-Overview (doc 09 §3.3): die vier Edit-Tools zusätzlich in editsByFile
            // ableiten — additiv, ohne die Timeline-Karte zu ändern. Rein Frontend-derived
            // aus dem bereits ankommenden tool_use-Payload (kein Protokoll-/Core-Change).
            if (EDIT_TOOLS.has(ev.name)) {
              const path = editPath(ev.input ?? {});
              if (path) upsertEdit(msg.agentId, path, ev.toolUseId, toEditOp(ev.name, ev.input ?? {}));
            }
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
          removeSubAgent(msg.agentId, ev.toolUseId); // war es der Abschluss eines Teil-Agenten? → aus der Übersicht nehmen
        }
        break;
      }

      case "needs_input":
        patchAgent(msg.agentId, { status: "waiting_input" });
        notice(msg.agentId, "warn", `● wartet auf dich${msg.message ? `: ${msg.message}` : ""}`);
        break;

      case "permission_request": {
        patchAgent(msg.agentId, { status: "waiting_input" });
        notice(msg.agentId, "warn", `● Erlaubnis erforderlich: ${msg.toolName}`);
        // NUR bei einer wirklich neuen Anfrage benachrichtigen (Snapshot-Replay re-emittiert dieselbe).
        const isNew = !useStore.getState().permissions.some((p) => p.requestId === msg.requestId);
        set((s) => ({ permissions: [...s.permissions.filter((p) => p.requestId !== msg.requestId), msg] }));
        if (isNew) {
          const label = useStore.getState().agents[msg.agentId]?.label ?? msg.agentId;
          void notifyOsPermission(msg, label); // macOS-Benachrichtigung, falls Fenster nicht im Fokus
        }
        break;
      }

      case "permission_resolved": {
        // Die Anfrage wurde IRGENDWO beantwortet (Mac, Remote/iOS, zweites Fenster) oder verworfen →
        // Karte hier entfernen, auch wenn NICHT dieser Client geantwortet hat. Idempotent zur
        // optimistischen Entfernung in answerPermission. Auch die OS-Notification zurückziehen.
        set((s) => ({ permissions: s.permissions.filter((p) => p.requestId !== msg.requestId) }));
        void dismissOsPermission(msg.requestId);
        break;
      }

      case "permissions_open": {
        // Autoritativer Snapshot: Karten dieses Agents entfernen, deren requestId nicht (mehr) offen ist
        // — fängt Auflösungen ab, die dieser Client verpasst hat (z. B. war offline). Andere Agents unberührt.
        const open = new Set(msg.requestIds);
        const stale = useStore.getState().permissions.filter((p) => p.agentId === msg.agentId && !open.has(p.requestId));
        if (stale.length) {
          set((s) => ({ permissions: s.permissions.filter((p) => p.agentId !== msg.agentId || open.has(p.requestId)) }));
          for (const p of stale) void dismissOsPermission(p.requestId);
        }
        break;
      }

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

      case "error": {
        // Auth-Fehler ist maschinenweit (nicht stream-spezifisch): einmalig ein globales Flag
        // setzen (dedupliziert → nur ein Banner, eine OS-Benachrichtigung pro Episode). Der
        // stream-spezifische Notice unten bleibt zusätzlich erhalten.
        if (msg.code === "authentication_failed" || msg.code === "oauth_org_not_allowed") {
          if (!useStore.getState().authReloginNeeded) {
            set({ authReloginNeeded: true });
            void notifyOsAuthRelogin();
          }
        }
        let removedGhost = false;
        if (msg.agentId && (msg.code === "main_edited" || msg.code === "main_deploy_dirty")) {
          // Proaktiver Hinweis (kein Fehler-Status): main-Dirt → auslagern ODER (nach Deploy) als Release
          // committen. Status bleibt unberührt; die Aktionen bietet der Inspector an, solange main dirty ist.
          // Deploy-Fall merken: der geführte nextStep hebt dann „Als Release committen" als Primäraktion
          // hervor (statt „In Sub-Stream auslagern"). git_status mit dirty=false löscht das Flag wieder.
          // main_edited löscht das Flag explizit: bleibt main nach einem Deploy DURCHGEHEND dirty
          // (Bump weg, andere Edits bleiben), würde „Als Release committen" sonst als Primäraktion
          // für Nicht-Deploy-Dirt kleben — ein chore(release) für beliebige Änderungen.
          patchAgent(msg.agentId, { deployDirty: msg.code === "main_deploy_dirty" });
          notice(msg.agentId, "accent", `↗ ${msg.message}`);
        } else if (msg.agentId) {
          const a = useStore.getState().agents[msg.agentId];
          // Ein Stream, der beim START scheitert (z.B. fehlgeschlagene Auslagerung), hinterlässt
          // sonst eine ewig hängende „startet"-Kachel ohne Backing — entfernen statt Fehler-Status.
          if (a && a.status === "starting" && a.numTurns === 0) {
            removedGhost = true;
            set((s) => {
              const agents = { ...s.agents };
              delete agents[msg.agentId!];
              const events = { ...s.events };
              delete events[msg.agentId!];
              const devLog = { ...s.devLog };
              delete devLog[msg.agentId!];
              const order = s.order.filter((x) => x !== msg.agentId);
              return { agents, events, devLog, order, selectedId: s.selectedId === msg.agentId ? order[0] : s.selectedId };
            });
          } else {
            patchAgent(msg.agentId, { status: msg.recoverable ? "escalation" : "error" });
            notice(msg.agentId, "err", `✖ ${msg.code}: ${msg.message}`);
          }
        } else if (useStore.getState().projectStatus === "opening") {
          // Projekt-Öffnung fehlgeschlagen (z.B. zuletzt geöffneter Ordner existiert nicht
          // mehr) — Status zurücksetzen, sonst hängt die UI auf "öffne…".
          set({ projectStatus: "error" });
        }
        // Auth-Fehler NICHT in die generische Eskalations-Leiste — dafür gibt es den dedizierten
        // „Bei Claude neu anmelden"-Banner (authReloginNeeded); sonst zwei Banner für dasselbe.
        const isAuthErr = msg.code === "authentication_failed" || msg.code === "oauth_org_not_allowed";
        if (!removedGhost && !isAuthErr) {
          set((s) => ({
            escalations: [...s.escalations.filter((e) => !(e.agentId === msg.agentId && e.code === msg.code)), msg],
          }));
        }
        break;
      }
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
    projectLocked: undefined,
    recentProjects: loadRecentProjects(),
    agents: {},
    order: [],
    events: {},
    devLog: {},
    permissions: [],
    escalations: [],
    authReloginNeeded: false,
    resumables: [],
    incomingPrs: [],
    reconcileSummary: undefined,
    collisions: [],
    prompts: [],
    whisper: { installed: false, checked: false, downloading: false, progress: 0 },
    dictation: { recording: false, transcribing: false },
    autonomy: { autoSync: true, collisionScan: true },
    selectedId: undefined,
    newStreamRequested: false,
    debugLog: [],
    parallelPicker: undefined,
    drafts: {},
    draftImages: {},
    draftFiles: {},

    activeView: loadUiPrefs().activeView,
    railCollapsed: loadUiPrefs().railCollapsed,
    defaultModel: loadUiPrefs().defaultModel,
    defaultEffort: loadUiPrefs().defaultEffort,
    changeOverviewOn: false,
    editsByFile: {},

    activeRoot: null,
    treeChildren: {},
    treeExpanded: {},
    treeFilter: "",
    selectedFilePath: undefined,
    openFile: undefined,
    editorBuffers: {},
    externalChanged: {},
    fsError: undefined,
    fileConflict: undefined,
    editorViewMode: "preview", // .md öffnet im Preview (OE-36)
    editorSaving: {},
    saveNotice: undefined,

    setActiveView: (view) => {
      set({ activeView: view });
      saveUiPrefs({ activeView: view, railCollapsed: useStore.getState().railCollapsed });
    },
    toggleRailCollapsed: () => {
      const next = !useStore.getState().railCollapsed;
      set({ railCollapsed: next });
      saveUiPrefs({ activeView: useStore.getState().activeView, railCollapsed: next });
    },
    setRailCollapsed: (collapsed) => {
      set({ railCollapsed: collapsed });
      saveUiPrefs({ activeView: useStore.getState().activeView, railCollapsed: collapsed });
    },
    toggleChangeOverview: () => set((s) => ({ changeOverviewOn: !s.changeOverviewOn })),
    clearEdits: () => set({ editsByFile: {} }),

    setAutonomy: async (config) => {
      set({ autonomy: config });
      await sendHost({ ...envelope(), type: "set_autonomy", config });
    },

    init: async () => {
      set({ sidecar: { status: "starting", sdkAvailable: false } });
      void useStore.getState().checkWhisper(); // Sprachmodell-Status für das Mikro-Icon
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
      set({ projectStatus: "opening", projectLocked: undefined });
      await sendHost({ ...envelope(), type: "open_project", projectId: crypto.randomUUID(), repoRoot });
    },

    exportHandoff: async () => {
      const project = useStore.getState().project;
      if (!project) return;
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
      const outFile = await pickSaveFile(`mads-handoff-${project.repo}-${stamp}.tar.gz`);
      if (!outFile) return;
      set({ handoff: undefined });
      await sendHost({ ...envelope(), type: "handoff_export", repoRoot: project.repoRoot, outFile });
    },

    importHandoff: async () => {
      const file = await pickHandoffFile();
      if (!file) return;
      set({ handoff: undefined });
      await sendHost({ ...envelope(), type: "handoff_import", file });
    },

    dismissHandoff: () => set({ handoff: undefined }),

    openRecentProject: async (repoRoot, force) => {
      set({ projectStatus: "opening", projectLocked: undefined });
      await sendHost({ ...envelope(), type: "open_project", projectId: crypto.randomUUID(), repoRoot, ...(force ? { force: true } : {}) });
    },

    forgetRecentProject: (repoRoot) => {
      set((s) => ({ recentProjects: forgetProject(s.recentProjects, repoRoot) }));
    },

    createAgent: async ({ label, prompt, role, mock, model, effort, branch, permissionMode }) => {
      const id = crypto.randomUUID();
      const mode: PermissionMode = permissionMode ?? "auto";
      const st0 = useStore.getState();
      // Modell/Effort: explizit (New-Stream-Dialog) sonst globaler Default (linke Navigation).
      const finalModel = model ?? st0.defaultModel;
      const finalEffort = clampEffort(finalModel, effort ?? st0.defaultEffort);
      const project = st0.project;
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
        autopilot: "assisted",
        model: finalModel,
        effort: finalEffort,
        createdAt: Date.now(),
        lastEventAt: Date.now(),
        workStartedAt: Date.now(),
        behind: 0,
        ahead: 0,
        dirty: false,
        live: true,
      };
      set((s) => ({ agents: { ...s.agents, [id]: agent }, order: [...s.order, id], selectedId: id }));
      // Start-Prompt NICHT optimistisch pushen: der Sidecar emittiert ihn als user_text-Event
      // (session.start, vor der Worktree-Erstellung → praktisch instant) — so ist er auf Mac
      // UND Remote identisch sichtbar, ohne Duplikat.

      const useWorktree = !mock && !!project && role === "sub";
      const finalBranch = branch?.trim() || slugifyBranch(label);
      await sendHost({
        ...envelope(),
        type: "start_agent",
        agentId: id,
        prompt,
        label,
        role,
        model: finalModel,
        effort: finalEffort,
        mock,
        permissionMode: mode,
        autopilot: "assisted",
        ...(useWorktree && project
          ? { repoRoot: project.repoRoot, branch: finalBranch, baseRef: `origin/${project.defaultBranch}` }
          : project && !mock
            ? { cwd: project.repoRoot }
            : {}),
      });
    },

    requestNewStream: () => set({ newStreamRequested: true }),

    selectAgent: (id) => {
      set({ selectedId: id });
      // Datei-Basis dem gewählten Stream folgen lassen — sonst betrachtet man leicht die
      // falschen Dateien (anderer/alter Kontext). Sub → sein Worktree; Integrator bzw. ohne
      // Worktree → Projekt-Root (main-Checkout). Nur umschalten, wenn sich der Pfad ändert.
      const st = useStore.getState();
      const a = st.agents[id];
      if (!a) return;
      const target: ExplorerRoot | null = a.worktreePath
        ? { kind: "worktree", agentId: id, path: a.worktreePath }
        : st.project
          ? { kind: "project", path: st.project.repoRoot }
          : null;
      if (target && st.activeRoot?.path !== target.path) void st.setActiveRoot(target);
    },

    dismissEscalations: () => set({ escalations: [] }),
    dismissAuthRelogin: () => set({ authReloginNeeded: false }),
    reloginClaude: async () => {
      // Öffnet Terminal.app mit `claude auth login`. Best effort — Fehler nur loggen (kein
      // Stream-Kontext für einen Notice). Den Token schreibt die CLI selbst in den Keychain.
      try {
        await invoke("claude_relogin");
      } catch (e) {
        console.warn("[mads] claude_relogin fehlgeschlagen:", e);
      }
    },
    checkAuthStatus: async () => (await invoke("claude_auth_status")) as string,

    setDraft: (agentId, text) => set((s) => ({ drafts: { ...s.drafts, [agentId]: text } })),
    setDraftImages: (agentId, images) => set((s) => ({ draftImages: { ...s.draftImages, [agentId]: images } })),
    setDraftFiles: (agentId, files) => set((s) => ({ draftFiles: { ...s.draftFiles, [agentId]: files } })),
    attachToDraft: async (agentId, files) => {
      const st = useStore.getState();
      const cwd = st.agents[agentId]?.worktreePath ?? st.project?.repoRoot;
      if (!cwd) {
        set({ saveNotice: { tone: "err", text: "Kein Projekt/Worktree — Anhang nicht möglich" } });
        return;
      }
      const base = cwd.replace(/\/$/, "");
      const newImgs: ImageInput[] = [];
      const newFiles: AttachedFile[] = [];
      const MAX_ATTACH_BYTES = 20 * 1024 * 1024; // 20 MB — größere Dateien blähen das IPC-JSON auf
      for (const f of files) {
        if (f.size > MAX_ATTACH_BYTES) {
          set({ saveNotice: { tone: "err", text: `„${f.name}“ ist zu groß (max. 20 MB) — nicht angehängt` } });
          continue;
        }
        if (f.type.startsWith("image/")) {
          // Thumbnail mitgeben → die Timeline zeigt später das echte Bild (Mac + Remote), nicht nur „+1 Bild".
          const thumb = await makeThumbnail(f);
          newImgs.push({ mediaType: f.type || "image/png", dataBase64: await blobToBase64(f), ...thumb });
          continue;
        }
        try {
          const bytes = new Uint8Array(await f.arrayBuffer());
          // Dateinamen säubern (kein Pfad-Traversal) + eindeutig machen.
          const safe =
            ((f.name || "datei").split(/[\\/]/).pop() ?? "datei").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "datei";
          const rel = `.mads/attachments/${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${safe}`;
          const res = (await invoke("mads_write_file_bytes", {
            path: `${base}/${rel}`,
            bytes: Array.from(bytes),
            baseMtimeMs: 0,
            baseSize: 0,
            baseHash: "",
          })) as CoreWriteResult;
          if (res.kind === "conflict") continue;
          newFiles.push({ name: safe, relPath: rel, size: f.size });
        } catch (e) {
          set({ saveNotice: { tone: "err", text: `Anhang „${f.name}“ fehlgeschlagen: ${String(e)}` } });
        }
      }
      if (newImgs.length)
        set((s) => ({ draftImages: { ...s.draftImages, [agentId]: [...(s.draftImages[agentId] ?? []), ...newImgs] } }));
      if (newFiles.length)
        set((s) => ({ draftFiles: { ...s.draftFiles, [agentId]: [...(s.draftFiles[agentId] ?? []), ...newFiles] } }));
    },

    answerPermission: async (req, decision) => {
      set((s) => ({ permissions: s.permissions.filter((p) => p.requestId !== req.requestId) }));
      void dismissOsPermission(req.requestId); // eigene Antwort → Notification sofort zurückziehen (nicht erst nach dem Echo)
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

    // ── Prompt-Verwaltung: der Store sendet nur die HostMessage — der Sidecar persistiert
    // (.mads/prompts.json) und spiegelt die neue Liste via prompts_update zurück (SSOT).
    savePrompt: async (prompt) => {
      await sendHost({ ...envelope(), type: "prompt_save", prompt });
    },
    deletePrompt: async (id) => {
      await sendHost({ ...envelope(), type: "prompt_delete", id });
    },

    sendInput: async (id, text, images) => {
      const a = useStore.getState().agents[id];
      // Folge-Anweisung NICHT optimistisch pushen: der Sidecar emittiert sie als user_text-Event
      // (session.sendInput bzw. beim Resume session.start) → beidseitig sichtbar, kein Duplikat.
      patchAgent(id, { status: "running", workStartedAt: Date.now(), live: true });
      if (a && a.live === false) {
        // Passiv wiederhergestellter Stream (nicht im Pool) → Session erst fortsetzen,
        // diese Nachricht ist der Resume-Prompt. (Bilder werden beim Resume nicht mitgesendet.)
        const project = useStore.getState().project;
        await sendHost({
          ...envelope(),
          type: "start_agent",
          agentId: id,
          prompt: text,
          label: a.label,
          role: a.role,
          // Modell UND Effort MITSENDEN: ohne sie fällt der Sidecar auf DEFAULT_MODEL und
          // effort=undefined zurück (session.ts) — ein Stream, der auf Ultracode/xhigh stand,
          // lief nach dem Fortsetzen still auf SDK-Default weiter („warum ist das so langsam?").
          model: a.model,
          effort: clampEffort(a.model, a.effort),
          mock: false,
          permissionMode: a.permissionMode,
          autopilot: a.autopilot ?? "assisted",
          resumeSessionId: a.sessionId,
          resumeWorktreePath: a.worktreePath,
          repoRoot: project?.repoRoot,
          cwd: a.worktreePath ?? project?.repoRoot,
          branch: a.branch,
        });
        return;
      }
      await sendHost({ ...envelope(), type: "send_input", agentId: id, text, images });
    },

    setPermissionMode: async (id, mode) => {
      patchAgent(id, { permissionMode: mode });
      notice(id, "accent", `⚙ Permission-Modus: ${mode}`);
      await sendHost({ ...envelope(), type: "set_permission_mode", agentId: id, mode });
    },

    setAutopilot: async (id, level) => {
      patchAgent(id, { autopilot: level });
      const label =
        level === "manual" ? "Manuell" : level === "autopilot" ? "Autopilot" : "Assisted (auto commit/push/PR)";
      notice(id, "accent", `🤖 Autopilot: ${label}`);
      await sendHost({ ...envelope(), type: "set_autopilot", agentId: id, level });
    },

    // ── Modell/Effort: globaler Default (linke Navigation) + pro-Stream-Umschaltung ──
    setDefaultModel: (model) => {
      const effort = clampEffort(model, useStore.getState().defaultEffort) ?? DEFAULT_EFFORT;
      set({ defaultModel: model, defaultEffort: effort });
      saveUiPrefs({ defaultModel: model, defaultEffort: effort });
    },
    setDefaultEffort: (effort) => {
      const e = clampEffort(useStore.getState().defaultModel, effort) ?? effort;
      set({ defaultEffort: e });
      saveUiPrefs({ defaultEffort: e });
    },
    setStreamModel: async (id, model) => {
      // Modellwechsel → Effort auf das neue Modell begrenzen (z. B. Haiku hat keinen Effort).
      const effort = clampEffort(model, useStore.getState().agents[id]?.effort);
      patchAgent(id, { model, effort });
      notice(id, "accent", `⚙ Modell: ${modelLabel(model)}`);
      await sendHost({ ...envelope(), type: "set_model_effort", agentId: id, model, effort });
    },
    setStreamEffort: async (id, effort) => {
      const e = clampEffort(useStore.getState().agents[id]?.model, effort) ?? effort;
      patchAgent(id, { effort: e });
      notice(id, "accent", `⚙ Effort: ${EFFORT_LABEL[e]}`);
      await sendHost({ ...envelope(), type: "set_model_effort", agentId: id, effort: e });
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
        // Change-Overview (doc 09 §7): die Diff-Panes des gestoppten Agenten mit räumen —
        // alle editsByFile-Keys mit Prefix `${id}::`. Fällt NICHT automatisch an.
        const prefix = `${id}::`;
        const editsByFile = Object.fromEntries(
          Object.entries(s.editsByFile).filter(([k]) => !k.startsWith(prefix)),
        );
        const devLog = { ...s.devLog };
        delete devLog[id];
        return { agents, events, order, editsByFile, devLog, selectedId: s.selectedId === id ? order[0] : s.selectedId };
      });
    },

    commitAgent: async (id) => {
      await useStore.getState().sendInput(
        id,
        "Committe deine bisherige Arbeit in DIESEM Worktree LOKAL: `git add -A && git commit` mit einer " +
          "aussagekräftigen Message im Commit-Format des Repos (z. B. Conventional Commits: feat/fix/docs …). " +
          "WICHTIG: KEINE projekteigenen Commit-/Push-Skripte verwenden — die " +
          "pushen direkt auf origin/main und kollidieren mit mads' Ablauf. NUR lokal committen — NICHT pushen, " +
          "keinen PR, keinen Merge. Push, PR und Integrieren übernimmt mads über seine eigenen Knöpfe.",
      );
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

    outsourceMain: async (integratorId) => {
      // Uncommittete main-Änderungen in einen NEUEN Sub-Stream verschieben (main bleibt sauber).
      const newId = mkId();
      const branch = `mads/main-changes-${newId.slice(0, 6)}`;
      const label = "Ausgelagerte main-Änderungen";
      set((s) => ({
        agents: {
          ...s.agents,
          [newId]: {
            id: newId,
            label,
            role: "sub",
            status: "starting",
            costUsd: 0,
            numTurns: 0,
            inputTokens: 0,
            outputTokens: 0,
            mock: false,
            permissionMode: "auto",
            autopilot: "assisted",
            createdAt: Date.now(),
            lastEventAt: Date.now(),
            workStartedAt: Date.now(),
            branch,
            behind: 0,
            ahead: 0,
            dirty: false,
            live: true,
          },
        },
        order: [...s.order, newId],
        selectedId: newId,
      }));
      notice(integratorId, "accent", `↗ Main-Änderungen → neuer Sub-Stream „${label}"`);
      await sendHost({ ...envelope(), type: "outsource_main", integratorId, agentId: newId, label, branch });
    },

    commitMainRelease: async (integratorId) => {
      // Den aktuellen (Deploy-)Stand von main als Release-Commit festhalten (chore(release): …).
      // Der Sidecar committet lokal auf dem Default-Branch (Push bleibt separat/explizit) und meldet
      // Ergebnis + neuen git-Status zurück (Banner verschwindet dann).
      notice(integratorId, "accent", "⤓ Release wird committet …");
      await sendHost({ ...envelope(), type: "commit_main_release", agentId: integratorId });
    },

    resolveConflict: async (id) => {
      // Geführte Konfliktlösung (3.4): den Agenten den Rebase IN SEINEM Worktree lösen lassen
      // (reine git-Arbeit; kein Push/PR/Merge — das macht mads). Das syncBlocked-Flag löscht der
      // Sidecar automatisch, sobald der Branch wieder aufgeholt hat (behind=0).
      const db = useStore.getState().project?.defaultBranch ?? "main";
      notice(id, "accent", "▶ Konflikt lösen (Agent rebaset im Worktree)");
      await useStore.getState().sendInput(
        id,
        `Dein Branch hat einen Rebase-Konflikt mit origin/${db}. Löse ihn IN DIESEM Worktree:\n` +
          `1. \`git rebase origin/${db}\` ausführen.\n` +
          `2. Konfliktmarkierungen beheben. Ergänzen BEIDE Seiten unabhängig etwas (neue Routes, ` +
          `Nav-Links, Dependencies, i18n-Keys), dann BEIDE behalten (nicht eine Seite verwerfen).\n` +
          `3. GENERIERTE Sperrdateien NICHT von Hand mergen — neu erzeugen, nachdem die Quelldatei ` +
          `konfliktfrei ist: \`uv.lock\` → \`uv lock\`; \`package-lock.json\` → \`npm install\`. ` +
          `(Handgemergte Lockfiles sind kaputt und lassen das Gate „Lockfile up-to-date" scheitern.)\n` +
          `4. \`git add -A && git rebase --continue\` (ggf. mehrfach, bis der Rebase durch ist).\n` +
          `5. Verifizieren: die Projekt-Checks lokal grün laufen lassen (z. B. \`uv run ruff check .\`, ` +
          `\`uv run mypy\`, \`uv run pytest -q\` bzw. \`npm run lint/typecheck/test\`).\n` +
          `NICHT pushen, keinen PR, keinen Merge — Push/PR/Integration übernimmt mads. ` +
          `Fasse am Ende kurz zusammen, welche Dateien du angepasst hast.`,
      );
    },

    integratePr: async (id, keep = false) => {
      notice(
        id,
        "accent",
        keep ? "▶ Mergen & weiterarbeiten (Branch behalten, auf main zurücksetzen)" : "▶ Integrieren (gh pr merge --squash + aufräumen)",
      );
      await sendHost({ ...envelope(), type: "integrate_pr", agentId: id, method: "squash", keepBranch: keep });
    },

    runGate: async (id) => {
      notice(id, "accent", "▶ Clean-Code-Gate…");
      await sendHost({ ...envelope(), type: "gate_task", agentId: id });
    },

    startDevServer: async (id) => {
      // NUR den geklickten Stream optimistisch auf „starting" setzen. Andere laufende NICHT vorab auf
      // „stopped" spiegeln: der Orchestrator stoppt einen evtl. anderen erst NACH seinen Vorab-Checks
      // (existiert der Worktree? gibt es eine run.json?) — schlägt der Start dort fehl, bleibt der alte
      // Server am Leben. Nur sein echtes „stopped"-Event (das genau dann kommt, wenn er wirklich
      // gestoppt wird) räumt die UI — so lügt die Kachel nie über einen noch laufenden Dev-Server.
      set((s) => ({ devLog: { ...s.devLog, [id]: [] } })); // altes Log verwerfen
      patchAgent(id, { devServer: { state: "starting" } }); // optimistisch (nur dieser Stream)
      notice(id, "accent", "▶ Dev-Server startet…");
      await sendHost({ ...envelope(), type: "start_devserver", agentId: id });
    },

    stopDevServer: async (id) => {
      await sendHost({ ...envelope(), type: "stop_devserver", agentId: id });
    },

    configureDevServer: async (id) => {
      // Sidecar stellt .mads/run.json sicher (frische Vorlage bei leer/fehlend) und meldet den Pfad
      // per devserver_config zurück → dort öffnen wir die Datei im Editor (siehe Reducer).
      await sendHost({ ...envelope(), type: "configure_devserver", agentId: id });
    },

    openReviewStream: async (pr) => {
      await sendHost({
        ...envelope(),
        type: "open_review_stream",
        prNumber: pr.number,
        headRefName: pr.headRefName,
        title: pr.title,
        author: pr.author,
        url: pr.url,
      });
    },

    mergeReview: async (id) => {
      await sendHost({ ...envelope(), type: "merge_review", agentId: id });
      // Kachel bleibt bis merge_result(ok) stehen (Merge kann fehlschlagen → dann keine falsche Entfernung).
    },

    closeReview: async (id) => {
      await sendHost({ ...envelope(), type: "close_review", agentId: id });
      removeAgentLocal(id); // Verwerfen ist sofortig — Kachel gleich weg
    },

    pollProject: async () => {
      await sendHost({ ...envelope(), type: "poll_project" });
    },

    resumeAll: async () => {
      // NUR Streams fortsetzen, die beim Beenden LIEFEN (durch den Shutdown unterbrochene
      // Arbeit) — nicht idle/wartende/erledigte und keine gemergten Reste. Wer einen idle
      // Stream zurückholen will, klickt ihn einzeln an.
      const list = useStore
        .getState()
        .resumables.filter((r) => !r.merged && (r.status === "running" || r.status === "starting"));
      for (const r of list) await useStore.getState().resumeAgent(r);
    },

    cleanupResumable: async (r) => {
      // Erledigter (gemergter) Stream mit lokalen Resten → Worktree + lokalen Branch entfernen.
      // force: true — der Nutzer hat den „Reste verwerfen"-Dialog bereits bestätigt (G4).
      set((s) => ({ resumables: s.resumables.filter((x) => x.agentId !== r.agentId) }));
      await sendHost({
        ...envelope(),
        type: "cleanup_worktree",
        agentId: r.agentId,
        branch: r.branch,
        worktreePath: r.worktreePath,
        force: true,
      });
    },

    updateMain: async (id) => {
      // G5: Integrator zieht main per fast-forward nach (NICHT rebase/force — das ist Sub).
      notice(id, "accent", "↻ main aktualisieren (fast-forward auf origin)…");
      await sendHost({ ...envelope(), type: "update_main", agentId: id });
    },

    resetMain: async (id) => {
      // Feature A: main ist lokal VORAUS (nicht gepushte Commits, z. B. Release-/Versions-Bumps, die ein
      // fast-forward nicht auflöst) → hart auf origin setzen. Die Sicherheits-Bestätigung läuft über den
      // In-App-ConfirmDialog im Inspector — NICHT window.confirm: das zeigt in der Tauri-Webview keinen
      // Dialog und würde ohne Warnung durchlaufen. Der Sidecar sichert vorher automatisch einen
      // Backup-Branch (verlustfrei rückholbar).
      const db = useStore.getState().project?.defaultBranch ?? "main";
      notice(id, "accent", `↺ ${db} hart auf origin/${db} setzen…`);
      await sendHost({ ...envelope(), type: "update_main", agentId: id, hard: true });
    },

    pushMain: async (id) => {
      // main ist lokal VORAUS und die Commits sind echt (behalten, z. B. Release-Version-Bumps) →
      // nach origin pushen statt verwerfen. Ungefährlich (Fast-Forward, kein force) → keine Rückfrage nötig.
      const db = useStore.getState().project?.defaultBranch ?? "main";
      notice(id, "accent", `⤒ ${db} nach origin pushen…`);
      await sendHost({ ...envelope(), type: "update_main", agentId: id, push: true });
    },

    syncAllBehind: async () => {
      // Konsolidierter „Alle aktualisieren": Projekt-Default-Branch per fast-forward
      // (Integrator) + jeden hinterherhängenden, aktiven Sub-Stream rebasen onto origin.
      const { agents, order, reconcileSummary } = useStore.getState();
      const list = order.map((id) => agents[id]).filter(Boolean);
      const integrator = list.find((a) => a.role === "integrator");
      if (integrator && (reconcileSummary?.mainBehind ?? 0) > 0) {
        await useStore.getState().updateMain(integrator.id);
      }
      for (const a of list) {
        if (a.role === "sub" && a.behind > 0 && a.live !== false) {
          await useStore.getState().syncBranch(a.id);
        }
      }
    },

    dismissReconcile: () => set({ reconcileSummary: undefined }),

    // ── Session-Restore beim Öffnen ──────────────────────────────────────────
    loadTranscript: async (agentId) => {
      const repo = useStore.getState().project?.repoRoot;
      if (!repo) return;
      try {
        const json = (await invoke("mads_load_transcript", { repoRoot: repo, agentId })) as string | null;
        if (!json) return;
        const evs = JSON.parse(json) as TimelineEvent[];
        if (Array.isArray(evs) && evs.length) set((s) => ({ events: { ...s.events, [agentId]: evs } }));
      } catch {
        /* kein/kaputtes Transkript → ignorieren */
      }
    },

    restoreSessions: async (agents) => {
      const live = agents.filter((r) => !r.merged); // gemergte Reste bleiben Aufräum-Banner
      const residue = agents.filter((r) => r.merged);
      // 1) ALLE Streams als PASSIVE Kacheln wiederherstellen (sichtbar, kein KI-Start).
      set((s) => {
        const next = { ...s.agents };
        const order = [...s.order];
        for (const r of live) {
          if (next[r.agentId]) continue;
          next[r.agentId] = {
            id: r.agentId,
            label: r.label,
            role: r.role,
            status: r.status,
            costUsd: 0,
            numTurns: 0,
            inputTokens: 0,
            outputTokens: 0,
            sessionId: r.sessionId,
            mock: false,
            permissionMode: "auto",
            autopilot: "assisted",
            model: r.model,
            effort: clampEffort(r.model, r.effort),
            createdAt: Date.now(),
            lastEventAt: Date.now(),
            branch: r.branch,
            worktreePath: r.worktreePath,
            behind: 0,
            ahead: 0,
            // localChanges (gemergt + schmutziger Worktree = ungesicherte Arbeit) → dirty, damit die
            // „Arbeit nicht gesichert"-Warnung sofort auf der Kachel steht (vor dem ersten Poll).
            dirty: r.localChanges === true,
            live: false, // passiv — erst beim Senden / „Fortsetzen" aktivieren
            // Auftrag überlebt den Neustart — AUSSER der Stream ist bereits gemergt/geschlossen + sauber
            // (mergedClean): dann ist die Arbeit erledigt und die Kachel bleibt (wie in-Session) auftragsfrei.
            lastPrompt: r.mergedClean ? undefined : r.lastPrompt,
          };
          if (!order.includes(r.agentId)) order.push(r.agentId);
        }
        return { agents: next, order, resumables: residue };
      });
      // 2) Chat-Verläufe laden (erscheinen wie vor dem Schließen).
      for (const r of live) void useStore.getState().loadTranscript(r.agentId);
      // 3) NUR beim Schließen laufende (unterbrochene) Streams automatisch fortsetzen.
      for (const r of live.filter((r) => r.status === "running" || r.status === "starting")) {
        void useStore.getState().resumeAgent(r);
      }
    },

    continueStream: async (id) => {
      const a = useStore.getState().agents[id];
      if (!a || a.live) return; // schon aktiv
      await useStore.getState().resumeAgent({
        agentId: id,
        label: a.label,
        role: a.role,
        sessionId: a.sessionId,
        branch: a.branch,
        worktreePath: a.worktreePath,
        status: a.status,
        lastPrompt: a.lastPrompt, // gemerkten Auftrag ins Resume mitgeben → Kachel behält ihn
        mock: false,
      });
    },

    // ── Spracheingabe (lokales Whisper) ──────────────────────────────────────
    checkWhisper: async () => {
      try {
        const st = (await invoke("whisper_model_status")) as { installed: boolean };
        set((s) => ({ whisper: { ...s.whisper, installed: st.installed, checked: true } }));
      } catch {
        set((s) => ({ whisper: { ...s.whisper, checked: true } }));
      }
    },

    downloadWhisper: async () => {
      if (useStore.getState().whisper.downloading) return;
      set((s) => ({ whisper: { ...s.whisper, downloading: true, progress: 0 } }));
      const un = await listen<{ downloaded: number; total: number }>("whisper-download-progress", (e) => {
        const p = e.payload.total > 0 ? e.payload.downloaded / e.payload.total : 0;
        set((s) => ({ whisper: { ...s.whisper, progress: p } }));
      });
      try {
        await invoke("whisper_download_model");
        set((s) => ({ whisper: { ...s.whisper, installed: true, downloading: false, progress: 1 } }));
      } catch (e) {
        set((s) => ({
          whisper: { ...s.whisper, downloading: false },
          dictation: { ...s.dictation, error: `Modell-Download fehlgeschlagen: ${String(e)}` },
        }));
      } finally {
        un();
      }
    },

    startDictation: async () => {
      const s = useStore.getState();
      if (!s.selectedId || s.dictation.recording || s.dictation.transcribing) return;
      if (!s.whisper.installed) {
        void s.downloadWhisper(); // erst Modell laden — dann erneut auslösen
        return;
      }
      set(() => ({ dictation: { recording: true, transcribing: false, error: undefined } }));
      try {
        await invoke("dictation_start");
      } catch (e) {
        set(() => ({ dictation: { recording: false, transcribing: false, error: `Mikrofon: ${String(e)}` } }));
      }
    },

    stopDictation: async () => {
      const s = useStore.getState();
      if (!s.dictation.recording) return;
      const id = s.selectedId;
      set((st) => ({ dictation: { ...st.dictation, recording: false, transcribing: true } }));
      try {
        const text = ((await invoke("dictation_stop")) as string).trim();
        if (text && id && !isWhisperHallucination(text)) {
          // trailing Leerzeichen (u. a. das durchgelassene PTT-Leerzeichen) entfernen → kein doppeltes Space.
          const cur = (useStore.getState().drafts[id] ?? "").replace(/[ \t]+$/, "");
          useStore.getState().setDraft(id, cur ? `${cur} ${text}` : text);
        }
        set(() => ({ dictation: { recording: false, transcribing: false } }));
      } catch (e) {
        set(() => ({ dictation: { recording: false, transcribing: false, error: `Transkription: ${String(e)}` } }));
      }
    },

    toggleDictation: async () => {
      const s = useStore.getState();
      if (s.dictation.transcribing) return;
      if (s.dictation.recording) await s.stopDictation();
      else await s.startDictation();
    },

    resumeAgent: async (r) => {
      const project = useStore.getState().project;
      const existing = useStore.getState().agents[r.agentId]; // ggf. passive Kachel mit gemerktem Auftrag
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
        autopilot: "assisted",
        createdAt: Date.now(),
        lastEventAt: Date.now(),
        workStartedAt: Date.now(),
        branch: r.branch,
        worktreePath: r.worktreePath,
        behind: 0,
        ahead: 0,
        dirty: false,
        live: true,
        // Auftrag über das Resume hinweg behalten — der automatische „Fortsetzen"-Nudge ersetzt ihn nicht.
        lastPrompt: r.lastPrompt ?? existing?.lastPrompt,
      };
      set((s) => ({
        agents: { ...s.agents, [r.agentId]: agent },
        order: s.order.includes(r.agentId) ? s.order : [...s.order, r.agentId],
        selectedId: r.agentId,
        resumables: s.resumables.filter((x) => x.agentId !== r.agentId),
      }));
      notice(r.agentId, "accent", `↩︎ fortgesetzt${r.branch ? ` · ${r.branch}` : ""}`);
      // G2: Den Integrator (arbeitet im Haupt-Checkout) über den realen Basis-Stand
      // informieren — sonst analysiert er gegen einen veralteten Working Tree (genau
      // dieser Fehler trat auf: main war 9 behind, er prüfte gegen den alten Stand).
      const rc = useStore.getState().reconcileSummary;
      const db = project?.defaultBranch ?? "main";
      let prompt = "Setze die Arbeit fort. Fasse zuerst kurz den aktuellen Stand zusammen, dann mach weiter.";
      if (r.role === "integrator" && rc) {
        if (rc.mainFastForwarded > 0) {
          prompt =
            `WICHTIG: Dein Working Tree (${db}) wurde gerade per fast-forward auf origin/${db} ` +
            `aktualisiert (+${rc.mainFastForwarded} Commits) — dein lokaler Stand ist jetzt aktuell. ` +
            `Analysiere ab dem AKTUELLEN Stand (nicht ab deinem vorherigen). ` +
            prompt;
        } else if (rc.mainBehind > 0) {
          prompt =
            `ACHTUNG: Dein Working Tree (${db}) ist ${rc.mainBehind} Commits HINTER origin/${db} und konnte ` +
            `nicht automatisch nachgezogen werden (Grund: ${rc.mainBlocked ?? "unbekannt"}). Ziehe zuerst nach ` +
            `(Knopf „main aktualisieren" bzw. prüfe gegen origin/${db} via \`git show\`, ohne den Working Tree zu ändern), ` +
            `bevor du Annahmen über den Code-Stand triffst. ` +
            prompt;
        }
      }
      await sendHost({
        ...envelope(),
        type: "start_agent",
        agentId: r.agentId,
        prompt,
        continuation: true, // automatische Fortsetzung — überschreibt den gemerkten Auftrag NICHT
        label: r.label,
        role: r.role,
        model: r.model,
        effort: clampEffort(r.model, r.effort),
        mock: false,
        permissionMode: "auto",
        autopilot: "assisted",
        resumeSessionId: r.sessionId,
        resumeWorktreePath: r.worktreePath,
        repoRoot: project?.repoRoot,
        // Ohne Worktree (Integrator) im Haupt-Checkout fortsetzen — sonst landet der
        // Agent im falschen Arbeitsverzeichnis.
        cwd: project?.repoRoot,
        branch: r.branch,
      });
    },

    // ── Datei-Explorer (doc 07 §3.2) — kapseln die invoke-Aufrufe an den Core ──
    setActiveRoot: async (root) => {
      try {
        await invoke("mads_register_root", { path: root.path });
        // Top-Level laden; Tree-/Datei-State für den neuen Kontext zurücksetzen.
        const children = (await invoke("mads_read_dir", { path: root.path })) as DirNode[];
        set({
          activeRoot: root,
          treeChildren: { [root.path]: children },
          treeExpanded: { [root.path]: true },
          selectedFilePath: undefined,
          openFile: undefined,
          editorBuffers: {},
          externalChanged: {},
          fsError: undefined,
          fileConflict: undefined,
        });
      } catch (e) {
        set({ fsError: String(e) });
      }
    },

    expandDir: async (path) => {
      set((s) => ({ treeExpanded: { ...s.treeExpanded, [path]: true } }));
      // Bereits geladen? dann nur aufklappen.
      if (useStore.getState().treeChildren[path]) return;
      try {
        const children = (await invoke("mads_read_dir", { path })) as DirNode[];
        set((s) => ({ treeChildren: { ...s.treeChildren, [path]: children }, fsError: undefined }));
      } catch (e) {
        set({ fsError: String(e) });
      }
    },

    collapseDir: (path) => set((s) => ({ treeExpanded: { ...s.treeExpanded, [path]: false } })),

    setTreeFilter: (text) => set({ treeFilter: text }),

    openFilePath: async (path) => {
      try {
        const res = (await invoke("mads_read_file", { path })) as CoreFileRead;
        const kind = fileKind(path, res.kind);
        const open: OpenFile = {
          path,
          kind,
          diskMtimeMs: res.mtimeMs,
          diskSize: res.size,
          diskHash: res.hash,
          coreKind: res.kind,
          truncated: res.truncated,
        };
        if (res.kind === "text") {
          open.loadedText = res.text;
        } else {
          open.bytesBase64 = res.bytesBase64;
          if (kind === "image" && res.bytesBase64) {
            const ext = path.split(".").pop()?.toLowerCase() ?? "";
            const mime = IMAGE_EXT[ext] ?? "application/octet-stream";
            open.dataUrl = `data:${mime};base64,${res.bytesBase64}`;
          }
        }
        set((s) => {
          const buffers = { ...s.editorBuffers };
          delete buffers[path]; // frische Vorschau → kein alter Buffer
          const ext = { ...s.externalChanged };
          delete ext[path];
          return { selectedFilePath: path, openFile: open, editorBuffers: buffers, externalChanged: ext, fsError: undefined };
        });
      } catch (e) {
        set({ fsError: String(e) });
      }
    },

    enterEditMode: (path) => {
      const open = useStore.getState().openFile;
      if (!open || open.path !== path || open.coreKind !== "text") return;
      set((s) => ({ editorBuffers: { ...s.editorBuffers, [path]: open.loadedText ?? "" } }));
    },

    setEditorBuffer: (path, text) => set((s) => ({ editorBuffers: { ...s.editorBuffers, [path]: text } })),

    saveFile: async (path) => {
      const st = useStore.getState();
      const open = st.openFile;
      const content = st.editorBuffers[path];
      if (!open || open.path !== path || content === undefined) return;
      if (st.editorSaving[path]) return; // Doppel-Save/Race blocken (§7)
      set((s) => ({ editorSaving: { ...s.editorSaving, [path]: true } }));
      try {
        const res = (await invoke("mads_write_file", {
          path,
          content,
          baseMtimeMs: open.diskMtimeMs,
          baseSize: open.diskSize,
          baseHash: open.diskHash,
        })) as CoreWriteResult;
        if (res.kind === "conflict") {
          // Conflict ist KEIN Fehler — dirty bleibt, Sheet/Dialog (§7).
          set((s) => ({ fileConflict: path, editorSaving: { ...s.editorSaving, [path]: false } }));
          return;
        }
        // saved → openFile-Signatur aktualisieren, Buffer als gespeichert markieren.
        set((s) => {
          const buffers = { ...s.editorBuffers };
          delete buffers[path];
          return {
            openFile: { ...open, loadedText: content, diskMtimeMs: res.mtimeMs, diskSize: res.size, diskHash: res.hash },
            editorBuffers: buffers,
            editorSaving: { ...s.editorSaving, [path]: false },
            fileConflict: undefined,
            fsError: undefined,
            saveNotice: { tone: "ok", text: "Gespeichert" },
          };
        });
      } catch (e) {
        // Echter IO-/Scope-Fehler — nie „gespeichert" vortäuschen (§7).
        set((s) => ({
          fsError: String(e),
          editorSaving: { ...s.editorSaving, [path]: false },
          saveNotice: { tone: "err", text: `Speichern fehlgeschlagen: ${String(e)}` },
        }));
      }
    },

    reloadFile: async (path) => {
      set((s) => {
        const buffers = { ...s.editorBuffers };
        delete buffers[path];
        const ext = { ...s.externalChanged };
        delete ext[path];
        return { editorBuffers: buffers, externalChanged: ext, fileConflict: undefined };
      });
      await useStore.getState().openFilePath(path);
    },

    discardEdit: (path) =>
      set((s) => {
        const buffers = { ...s.editorBuffers };
        delete buffers[path];
        return { editorBuffers: buffers, fileConflict: undefined };
      }),

    // ── Markdown-Editor (doc 08 §3.1) ──
    setEditorViewMode: (mode) => set({ editorViewMode: mode }),

    clearSaveNotice: () => set({ saveNotice: undefined }),

    insertImageFromBlob: async (path, blob, cursor) => {
      const st = useStore.getState();
      const open = st.openFile;
      if (!open || open.path !== path) return cursor;
      const b64 = await blobToBase64(blob);
      const bytes = base64ToBytes(b64);
      const ext = extForMime(blob.type || "image/png");
      // Eindeutiger, relativer Ziel-Name in `<dir>/assets/` (OE-39): Zeitstempel + Zufall.
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const rel = `assets/${stamp}.${ext}`;
      const dir = dirname(path);
      const target = `${dir}/${rel}`;
      try {
        // Neu-Anlegen: keine base-Signatur (Core legt `assets/` an, §7).
        const res = (await invoke("mads_write_file_bytes", {
          path: target,
          bytes: Array.from(bytes),
          baseMtimeMs: 0,
          baseSize: 0,
          baseHash: "",
        })) as CoreWriteResult;
        if (res.kind === "conflict") {
          set({ saveNotice: { tone: "err", text: "Bild-Ziel bereits geändert — abgebrochen" } });
          return cursor;
        }
        // Relativen Markdown-Link an der Cursor-Position in den Buffer einsetzen.
        const cur = useStore.getState();
        const text = cur.editorBuffers[path] ?? open.loadedText ?? "";
        const snippet = `![](./${rel})`;
        const next = text.slice(0, cursor) + snippet + text.slice(cursor);
        set((s) => ({
          editorBuffers: { ...s.editorBuffers, [path]: next },
          saveNotice: { tone: "ok", text: `Bild eingefügt (${rel})` },
        }));
        return cursor + snippet.length;
      } catch (e) {
        set({ fsError: String(e), saveNotice: { tone: "err", text: `Bild-Paste fehlgeschlagen: ${String(e)}` } });
        return cursor;
      }
    },

    openWikiLink: async (fromPath, name) => {
      // `[[name]]` → `./<name>.md` relativ zur aktuellen Datei; öffnet wie jeder interne
      // Verweis in einem eigenen Fenster (§1.2/§5.4).
      const slug = name.endsWith(".md") ? name : `${name}.md`;
      await useStore.getState().openMdReference(fromPath, `./${slug}`);
    },

    openMdReference: async (fromPath, href) => {
      // Interner Markdown-Verweis → Ziel relativ zur aktuellen Datei auflösen und in einem
      // EIGENEN Fenster öffnen (Detach). Anker/Query strippen; `..`/`.` werden aufgelöst.
      // Bare Name ohne Endung → `.md` annehmen. Nicht-.md oder Fenster-Fehlschlag →
      // im Haupt-Viewer öffnen (Fallback). Scope-Check liegt im Core (sonst fsError).
      const clean = href.split("#")[0].split("?")[0].trim();
      if (!clean) return; // reiner Anker → (noch) kein In-Doc-Scroll
      let target = resolveRel(dirname(fromPath), clean);
      const lastSeg = target.split("/").pop() ?? "";
      if (!lastSeg.includes(".")) target += ".md"; // bloßer Name → .md annehmen
      if (/\.md$/i.test(target) && (await openMarkdownWindow(target))) return;
      await useStore.getState().openFilePath(target); // Nicht-.md oder Fenster-Fehlschlag
    },
  };
});
