/**
 * Projekt-Verbund — REINE Logik (kein IO, kein node:*, im Frontend UND Sidecar nutzbar).
 *
 * Hier lebt alles, was sich ohne Dateisystem entscheiden lässt: Contract-Fingerprint,
 * Pattern-Filter, Thread-Zustandsmaschine, Drift-Regel, Loop-Guard, Caps. Der Sidecar
 * (`sidecar/src/link.ts`) macht das IO drumherum, das Frontend spiegelt nur.
 *
 * Warum der Hash INJIZIERT wird (`sha256`-Parameter): diese Datei wird vom Frontend-`tsc`
 * mitgeprüft (tsconfig `include: ["src", "shared"]`) — ein `import { createHash } from
 * "node:crypto"` würde dort nicht typprüfen. Der Aufrufer reicht die Implementierung durch
 * (Sidecar: node:crypto), die Logik bleibt pur und testbar.
 *
 * Siehe docs/design/12-project-link.md.
 */
import { pathMatches } from "./ownership";
import type {
  ChangedRegion,
  ContractCompat,
  ContractDelta,
  LinkPresence,
  LinkThread,
  LinkThreadState,
  ProjectLinkConfig,
} from "./protocol";

export type Sha256 = (input: string) => string;

// ─── Caps (OE-58) — Überschreitung ist immer SICHTBAR (`truncated`), nie still ────────
/** Roh-Diff einer `contract_change`. */
export const CONTRACT_DIFF_CAP = 64 * 1024;
/** Brief/Text einer `request`/`reply`. */
export const BRIEF_CAP = 16 * 1024;
/** `peer_read_contract`: gelesene Contract-Datei der Gegenseite. */
export const CONTRACT_FILE_CAP = 256 * 1024;
/** Verarbeitete Nachrichten, die in `cur/` als Audit erhalten bleiben. */
export const MAILDIR_KEEP = 200;
/** Presence gilt als „online", wenn der Heartbeat jünger ist (und die pid lebt). */
export const PRESENCE_TTL_MS = 20_000;
/** Heartbeat-Intervall der eigenen Presence. */
export const PRESENCE_BEAT_MS = 5_000;
/** Ping-Pong-Schutz (OE-59): ab so vielen Hops kein Auto-Dispatch mehr, sondern Eskalation. */
export const LOOP_GUARD_MAX_HOPS = 3;

// ─── Contract ────────────────────────────────────────────────────────────────────────

export interface ContractEntry {
  path: string;
  /** git-Blob-Sha des Pfades auf dem Default-Branch. */
  sha: string;
}

/** Kanonische Fingerprint-Eingabe: sortiert, „path sha" je Zeile. Getrennt exponiert,
 *  damit sich die Determinismus-Eigenschaft ohne Hash-Funktion testen lässt. */
export function contractFpInput(entries: ContractEntry[]): string {
  return [...entries]
    .map((e) => `${e.path} ${e.sha}`)
    .sort()
    .join("\n");
}

/**
 * Fingerprint der Contract-Dateien auf `main` (§4.2). Mechanisch prüfbar — unabhängig davon,
 * ob ein LLM an die Ankündigung gedacht hat. Leerer Contract → leerer Fingerprint (""), damit
 * ein reiner Consumer nie „Drift" gegen sich selbst meldet.
 */
export function contractFingerprint(entries: ContractEntry[], sha256: Sha256): string {
  if (entries.length === 0) return "";
  return sha256(contractFpInput(entries));
}

/** Gehört dieser Pfad zum deklarierten Contract? (Glob-Semantik wie `OwnershipRule.path`.) */
export function matchesContract(path: string, patterns: string[]): boolean {
  return patterns.some((p) => pathMatches(path, p));
}

/** Geänderte Regionen auf die Contract-Muster einschränken (leer = keine Contract-Änderung). */
export function filterContractDelta(regions: ChangedRegion[], patterns: string[]): ChangedRegion[] {
  if (patterns.length === 0) return [];
  return regions.filter((r) => matchesContract(r.path, patterns));
}

/** Diff auf `CONTRACT_DIFF_CAP` kappen — Überschreitung wird als `truncated` mitgemeldet. */
export function capDiff(diff: string): { diff: string; truncated: boolean } {
  if (diff.length <= CONTRACT_DIFF_CAP) return { diff, truncated: false };
  return { diff: diff.slice(0, CONTRACT_DIFF_CAP), truncated: true };
}

/** Freitext (Brief/Reply) auf `BRIEF_CAP` kappen. */
export function capBrief(text: string): string {
  return text.length <= BRIEF_CAP ? text : `${text.slice(0, BRIEF_CAP)}\n…[gekürzt]`;
}

/**
 * Auto-Detect-Vorschläge fürs Settings-Panel (§4.1): aus den Pfaden des Repos jene Muster
 * ableiten, die typischerweise eine Schnittstelle bilden. Reine Heuristik — der Mensch
 * bestätigt. Liefert Muster (keine Einzelpfade), damit spätere Dateien mitgezogen werden.
 */
export function suggestContractPatterns(paths: string[]): string[] {
  const out = new Set<string>();
  const dirRule = (prefix: string, pattern: string) => {
    if (paths.some((p) => p === prefix || p.startsWith(`${prefix}/`))) out.add(pattern);
  };
  for (const p of paths) {
    const base = p.split("/").pop() ?? "";
    if (/^openapi\.(ya?ml|json)$/i.test(base) || /^swagger\.(ya?ml|json)$/i.test(base)) out.add(p);
    if (/\.graphql$/i.test(base) || /\.graphqls$/i.test(base)) out.add(p);
    if (/^schema\.prisma$/i.test(base)) out.add(p);
    if (/\.proto$/i.test(base)) out.add(p);
    if (/^asyncapi\.(ya?ml|json)$/i.test(base)) out.add(p);
  }
  dirRule("src/api/routes", "src/api/routes/**");
  dirRule("src/api/dto", "src/api/dto/**");
  dirRule("src/api/schemas", "src/api/schemas/**");
  dirRule("packages/shared-types", "packages/shared-types/**");
  dirRule("packages/contracts", "packages/contracts/**");
  dirRule("docs/contracts", "docs/contracts/**");
  dirRule("shared", "shared/**");
  return [...out].sort();
}

// ─── Rollen & Zustand ────────────────────────────────────────────────────────────────

export type LinkRole = "provider" | "consumer" | "bidirectional";

/** Die Rolle ERGIBT sich aus den Contract-Deklarationen beider Seiten (§4.1) — sie wird nicht
 *  konfiguriert, damit es keine widersprüchliche Rollen-Konfiguration auf zwei Seiten gibt. */
export function linkRole(ownPatterns: string[], peerPatterns: string[]): LinkRole {
  const own = ownPatterns.length > 0;
  const peer = peerPatterns.length > 0;
  if (own && peer) return "bidirectional";
  if (own) return "provider";
  return "consumer";
}

/** Ist diese Presence frisch genug UND lebt ihr Prozess? (Gleiche Regel wie beim Projekt-Lock.) */
export function presenceOnline(
  presence: LinkPresence | undefined,
  now: number,
  pidAlive: (pid: number) => boolean,
): boolean {
  if (!presence) return false;
  if (now - presence.ts > PRESENCE_TTL_MS) return false;
  return pidAlive(presence.pid);
}

export type LinkState = "none" | "pending" | "active" | "peer_offline";

/**
 * Zustand des Verbunds inkl. gegenseitigem Einverständnis (§5.3): erst wenn MEINE Konfiguration
 * den Peer nennt UND dessen Presence MICH als `peerRepoRoot` nennt, ist der Link `active`.
 * Verhindert, dass ein beliebiges Repo einem anderen Arbeit unterschiebt.
 */
export function linkState(args: {
  config?: ProjectLinkConfig;
  ownRepoRoot: string;
  peerPresence?: LinkPresence;
  now: number;
  pidAlive: (pid: number) => boolean;
}): { state: LinkState; hint?: string } {
  const { config, ownRepoRoot, peerPresence, now, pidAlive } = args;
  if (!config) return { state: "none" };
  if (!peerPresence) {
    return { state: "pending", hint: "Gegenseite hat den Verbund noch nicht eingerichtet (keine Presence gefunden)." };
  }
  if (peerPresence.peerRepoRoot !== ownRepoRoot) {
    return {
      state: "pending",
      hint: `Gegenseite (${peerPresence.slug}) nennt ${peerPresence.peerRepoRoot ?? "kein Repo"} als Verbund-Partner — nicht dieses Repo. Dort ebenfalls den Verbund auf ${ownRepoRoot} einstellen.`,
    };
  }
  if (peerPresence.linkVersion !== undefined && peerPresence.linkVersion !== LINK_VERSION_LOCAL) {
    return {
      state: "pending",
      hint: `Gegenseite spricht Verbund-Version ${peerPresence.linkVersion}, diese Instanz ${LINK_VERSION_LOCAL}. Beide Sidecars neu bauen (npm run sidecar:build) und mads neu starten.`,
    };
  }
  if (!presenceOnline(peerPresence, now, pidAlive)) {
    return { state: "peer_offline", hint: "Gegenseite ist gerade nicht offen — Nachrichten warten im Eingang." };
  }
  return { state: "active" };
}

/** Lokale Kopie der Protokoll-Version (Import-Zyklus mit protocol.ts vermeiden). */
const LINK_VERSION_LOCAL = 1;

// ─── Drift-Regel (§4.2) ──────────────────────────────────────────────────────────────

/**
 * Drift ⇔ der Peer-Contract hat sich geändert, ich habe ihn NICHT nachvollzogen, und KEIN
 * offener Thread trägt diesen Fingerprint. Genau dieses Sicherheitsnetz fängt auch, was
 * außerhalb von mads passiert (Handmerge, `update_main` mit fremden Commits).
 */
export function isDrift(args: { peerFp?: string; ackedFp?: string; threads: LinkThread[] }): boolean {
  const { peerFp, ackedFp, threads } = args;
  if (!peerFp) return false;
  if (peerFp === ackedFp) return false;
  return !threads.some((t) => t.contractFp === peerFp && isOpenThread(t));
}

/** Thread ist noch „in Arbeit" (erklärt also einen Fingerprint). */
export function isOpenThread(t: LinkThread): boolean {
  return t.state !== "done" && t.state !== "declined";
}

/** Offene Threads, die auf eine menschliche Entscheidung warten (Rail-Badge / Pill). */
export function pendingThreads(threads: LinkThread[]): LinkThread[] {
  return threads.filter((t) => t.state === "open" || t.state === "proposed" || t.state === "escalated");
}

// ─── Loop-Guard (§11) ────────────────────────────────────────────────────────────────

/** Darf zu diesem Hop-Stand noch automatisch dispatcht werden? */
export function loopGuardOk(hops: number, max: number = LOOP_GUARD_MAX_HOPS): boolean {
  return hops < max;
}

/**
 * Darf der Sidecar diesen Thread selbst starten (ohne menschlichen Klick)? Nur bei
 * `autopilot` UND innerhalb des Loop-Guards. `assisted`/`manual` warten auf den Menschen (OE-55).
 */
export function shouldAutoDispatch(level: ProjectLinkConfig["autopilot"], hops: number): boolean {
  return level === "autopilot" && loopGuardOk(hops);
}

// ─── Thread-Zustandsmaschine (§7.5) ──────────────────────────────────────────────────

export type ThreadEvent =
  | { kind: "proposed"; label: string; brief: string; who?: "local" | "peer" | "human" }
  | { kind: "started"; ownerAgentId: string; who?: "local" | "peer" | "human" }
  | { kind: "landed"; sha?: string; prUrl?: string }
  | { kind: "peer_done"; sha?: string; prUrl?: string; contractFp?: string }
  | { kind: "declined"; reason?: string; who?: "local" | "peer" | "human" }
  | { kind: "escalated"; reason: string }
  | { kind: "reopened"; who?: "local" | "peer" | "human" }
  | { kind: "note"; text: string; who: "local" | "peer" | "human" }
  | { kind: "peer_update"; text: string; delta?: ContractDelta; contractFp?: string; breaking?: boolean };

const TERMINAL: LinkThreadState[] = ["done", "declined"];

/**
 * REIN: wendet ein Ereignis auf einen Thread an und liefert den neuen Thread.
 * Regeln, die hier (und nur hier) gelten:
 *  - `done`/`declined` sind terminal — nur `reopened` holt einen Thread zurück.
 *  - `landed` + `peerLanded` ⇒ `done` (beide Seiten fertig).
 *  - jede Folge-Nachricht der Gegenseite erhöht `hops` (Ping-Pong-Zähler).
 *  - der Log wächst monoton (Audit) und wird auf die letzten 50 Einträge gekappt.
 */
export function threadReducer(thread: LinkThread, event: ThreadEvent, now: number): LinkThread {
  const t: LinkThread = { ...thread, log: [...thread.log] };
  const note = (who: "local" | "peer" | "human", text: string) => {
    t.log.push({ ts: now, who, text });
    if (t.log.length > 50) t.log.splice(0, t.log.length - 50);
  };
  const terminal = TERMINAL.includes(thread.state);

  switch (event.kind) {
    case "proposed":
      if (terminal) return thread;
      t.proposal = { label: event.label, brief: event.brief };
      t.state = "proposed";
      note(event.who ?? "local", `Abgleich-Auftrag entworfen: ${event.label}`);
      break;

    case "started":
      if (terminal) return thread;
      t.ownerAgentId = event.ownerAgentId;
      t.state = "in_progress";
      note(event.who ?? "local", "Abgleich-Stream gestartet.");
      break;

    case "landed":
      if (terminal) return thread;
      t.landedSha = event.sha ?? t.landedSha;
      t.prUrl = event.prUrl ?? t.prUrl;
      t.state = t.peerLanded ? "done" : "landed";
      note("local", `Auf main gelandet${event.sha ? ` (${event.sha.slice(0, 7)})` : ""}.`);
      break;

    case "peer_done":
      t.peerLanded = true;
      t.prUrl = event.prUrl ?? t.prUrl;
      // Ein `done` der Gegenseite schließt den Thread, sobald die eigene Seite nichts mehr offen
      // hat. „open"/„proposed" heißt: hier wurde nie etwas begonnen (reiner Provider-Thread) —
      // dann ist die Sache mit der Gegenseite erledigt.
      t.state = thread.state === "landed" || thread.state === "open" || thread.state === "proposed" ? "done" : thread.state;
      if (TERMINAL.includes(thread.state)) t.state = thread.state;
      note("peer", `Gegenseite gemeldet: erledigt${event.sha ? ` (${event.sha.slice(0, 7)})` : ""}.`);
      break;

    case "declined":
      t.state = "declined";
      note(event.who ?? "human", `Abgelehnt${event.reason ? `: ${event.reason}` : "."}`);
      break;

    case "escalated":
      if (terminal) return thread;
      t.state = "escalated";
      note("local", `Eskaliert: ${event.reason}`);
      break;

    case "reopened":
      t.state = t.ownerAgentId ? "in_progress" : t.proposal ? "proposed" : "open";
      note(event.who ?? "human", "Wieder geöffnet.");
      break;

    case "note":
      note(event.who, event.text);
      break;

    case "peer_update":
      if (event.delta) t.delta = event.delta;
      if (event.contractFp) t.contractFp = event.contractFp;
      if (event.breaking !== undefined) t.breaking = event.breaking;
      t.hops = thread.hops + 1;
      // Ein Update der Gegenseite holt einen bereits geschlossenen Thread NICHT zurück —
      // sonst ließe sich ein „declined" durch bloßes Nachsenden aushebeln.
      if (!terminal && (thread.state === "landed" || thread.state === "done")) t.state = "open";
      note("peer", event.text);
      break;
  }
  t.updatedAt = now;
  return t;
}

/** Neuen Thread anlegen (gemeinsame Defaults für beide Ursprünge). */
export function newThread(args: {
  id: string;
  origin: "local" | "peer";
  kind: LinkThread["kind"];
  title: string;
  now: number;
  branch?: string;
  contractFp?: string;
  causedBy?: string;
  hops?: number;
  breaking?: boolean;
  delta?: ContractDelta;
}): LinkThread {
  return {
    id: args.id,
    origin: args.origin,
    kind: args.kind,
    title: args.title,
    state: "open",
    branch: args.branch,
    contractFp: args.contractFp,
    causedBy: args.causedBy,
    hops: args.hops ?? 0,
    breaking: args.breaking,
    delta: args.delta,
    createdAt: args.now,
    updatedAt: args.now,
    log: [],
  };
}

// ─── Landing-Reihenfolge (§7.4, OE-56: Warnung, kein Hard-Block) ─────────────────────

/**
 * Warnt der Merge auf DIESER Seite, weil die Provider-Seite noch nicht gelandet ist?
 * Bei `lockstep` ist die Reihenfolge zwingend (rot), bei `additive` nur ein Hinweis:
 * ein alter Client läuft dort weiter gegen den neuen Server.
 */
export function landOrderWarning(
  threads: LinkThread[],
  compat: ContractCompat,
): { thread: LinkThread; severe: boolean } | undefined {
  const blocking = threads.find(
    (t) => t.kind === "contract_change" && t.origin === "peer" && !t.peerLanded && isOpenThread(t),
  );
  if (!blocking) return undefined;
  return { thread: blocking, severe: compat === "lockstep" };
}

// ─── Identität ───────────────────────────────────────────────────────────────────────

/** Kanal-ID beider Seiten: symmetrisch (beide Instanzen berechnen dieselbe). */
export function linkIdFor(repoRootA: string, repoRootB: string, sha256: Sha256): string {
  return sha256([repoRootA, repoRootB].sort().join("\n")).slice(0, 12);
}

/** Verzeichnis-Slug einer Seite (letztes Pfad-Segment, dateisystem-sicher). */
export function slugFor(repoRoot: string): string {
  const base = repoRoot.replace(/\/+$/, "").split("/").pop() ?? "repo";
  return base.replace(/[^A-Za-z0-9._-]/g, "-") || "repo";
}

/**
 * Die beiden Kanal-Namen eines Verbunds (`to-<slug>/`) und die Presence-Dateinamen.
 *
 * Normalfall: die Verzeichnisnamen der beiden Repos. Zwei VERSCHIEDENE Repos können aber sehr
 * wohl gleich heißen (`~/work/acme/api` und `~/work/beta/api`) — dann wären die beiden
 * Richtungen des Kanals nicht unterscheidbar und beide Seiten schrieben in denselben
 * Briefkasten. Deshalb in diesem Fall beide Namen mit einem kurzen, stabilen Hash ihres Pfades
 * eindeutig machen. Beide Instanzen kennen beide Pfade und berechnen dasselbe Ergebnis — der
 * Kanal bleibt also symmetrisch, ohne dass jemand ein Verzeichnis umbenennen muss.
 */
export function channelSlugs(ownRepoRoot: string, peerRepoRoot: string, sha256: Sha256): { own: string; peer: string } {
  const own = slugFor(ownRepoRoot);
  const peer = slugFor(peerRepoRoot);
  if (own !== peer) return { own, peer };
  return { own: `${own}-${sha256(ownRepoRoot).slice(0, 6)}`, peer: `${peer}-${sha256(peerRepoRoot).slice(0, 6)}` };
}

/** Contract-Deklaration einer Seite normalisieren (leere/doppelte Muster raus). */
export function normalizePatterns(patterns: string[]): string[] {
  return [...new Set(patterns.map((p) => p.trim()).filter(Boolean))];
}

/** Konfiguration defensiv normalisieren (kommt aus einer Datei bzw. vom Frontend). */
export function normalizeLinkConfig(raw: unknown): ProjectLinkConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const peer = r.peer as { repoRoot?: unknown; label?: unknown } | undefined;
  const repoRoot = typeof peer?.repoRoot === "string" ? peer.repoRoot.trim() : "";
  if (!repoRoot) return undefined;
  const provides = r.provides as { patterns?: unknown; compat?: unknown } | undefined;
  const patterns = Array.isArray(provides?.patterns)
    ? normalizePatterns(provides!.patterns.filter((x): x is string => typeof x === "string"))
    : [];
  const compat: ContractCompat = provides?.compat === "lockstep" ? "lockstep" : "additive";
  const autopilot =
    r.autopilot === "manual" || r.autopilot === "assisted" || r.autopilot === "autopilot" ? r.autopilot : "assisted";
  const gate = r.gate as { command?: unknown; env?: unknown } | undefined;
  return {
    v: 1,
    peer: { repoRoot, label: typeof peer?.label === "string" && peer.label.trim() ? peer.label.trim() : undefined },
    provides: { patterns, compat },
    autopilot,
    ...(typeof gate?.command === "string" && gate.command.trim()
      ? { gate: { command: gate.command.trim(), env: (gate.env as Record<string, string> | undefined) ?? undefined } }
      : {}),
  };
}

// ─── Aufbereitung für Prompt & Anzeige ───────────────────────────────────────────────

/** Kurzfassung eines Deltas für Karte/Prompt (Dateien + Symbole, ohne Roh-Diff). */
export function describeDelta(delta: ContractDelta | undefined): string {
  if (!delta || delta.files.length === 0) return "keine Contract-Dateien betroffen";
  const parts = delta.files.slice(0, 8).map((f) => {
    const region = delta.regions.find((r) => r.path === f);
    const syms = region?.symbols.slice(0, 3).join(", ");
    return syms ? `${f} (${syms})` : f;
  });
  const rest = delta.files.length - parts.length;
  return parts.join(", ") + (rest > 0 ? ` … +${rest} weitere` : "");
}
