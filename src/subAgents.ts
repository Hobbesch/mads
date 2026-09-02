/**
 * Teil-Agenten (SDK-Sub-Agenten via Task/Agent-Tool) — Datenmodell und reine Helfer für das
 * Einblick-Panel im Inspector.
 *
 * Ein Teil-Agent ist KEIN eigener mads-Stream (kein Worktree, keine Branch, kein PR), sondern
 * eine Unter-Schleife INNERHALB der Session eines Streams — in `docs/design/04-sub-agents.md`
 * „Helper-Subagent" genannt. Die Abgrenzung ist hier load-bearing: alles in dieser Datei ist
 * reine Laufzeit-Anzeige, nichts davon wird persistiert oder beeinflusst Git.
 *
 * Alles hier ist bewusst frei von Zustand und Store-Zugriff, damit es ohne laufende App
 * testbar bleibt (`src/subAgents.test.ts`).
 */
import { toolCommand } from "./toolText";

/** Eine Zeile im Live-Mitschnitt eines Teil-Agenten. */
export interface SubAgentFeedItem {
  id: string;
  /** `tool` = Werkzeug-Aufruf (bekommt später ok/✗), `text`/`thinking` = Äusserung, `note` = Meta. */
  kind: "tool" | "text" | "thinking" | "note";
  /** Werkzeugname bei `tool` (Read, Grep, Bash …). */
  name?: string;
  /** Kurzvorschau des Arguments bzw. der Äusserung. */
  detail?: string;
  /** Nur `tool`: zur Zuordnung des späteren Ergebnisses. */
  toolUseId?: string;
  /** Nur `tool`, gesetzt sobald das Ergebnis da ist. */
  ok?: boolean;
  at: number;
}

/** Ein Teil-Agent eines Streams — läuft (`done` false) oder ist abgeschlossen. */
export interface SubAgentEntry {
  /** tool_use_id des startenden Task/Agent-Aufrufs. */
  id: string;
  /** Klartext, was er tut (`description` des Aufrufs) — siehe `subAgentMeta`. */
  label: string;
  /** Typ aus `subagent_type` (z. B. „Explore"), wenn angegeben. */
  type?: string;
  /** Modell aus seiner eigenen `system/init` (oft ein schnelleres als das des Streams). */
  model?: string;
  /** Zuletzt benutztes Werkzeug — „was tut er gerade". */
  currentStep?: string;
  /** Anzahl bisher aufgerufener Werkzeuge (die Zahl neben dem Namen). */
  toolCount: number;
  feed: SubAgentFeedItem[];
  startedAt: number;
  lastAt: number;
  done?: boolean;
  ok?: boolean;
  endedAt?: number;
}

/** Mitschnitt-Länge pro Teil-Agent. Reicht für „was tut er gerade" ohne den Speicher zu fluten. */
export const FEED_CAP = 120;
/** So viele ABGESCHLOSSENE Teil-Agenten bleiben nach dem Ende noch nachlesbar. */
export const FINISHED_CAP = 6;
/** Kurzvorschau: mehr als das ist im Panel nicht lesbar. */
const DETAIL_MAX = 110;
const TEXT_MAX = 220;

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Bezeichnung eines Teil-Agenten aus dem Task/Agent-Input.
 *
 * Reihenfolge: `description` (die eigentliche Absicht, die der Aufrufer mitgibt) → `subagent_type`
 * (immerhin die Gattung) → erster Satz des Prompts. Das reine „Teil-Agent" ist nur noch das
 * allerletzte Netz: ohne diese Kette stand im Panel dreimal dasselbe nichtssagende Wort,
 * obwohl die Absicht im Aufruf mitgeliefert wird.
 */
export function subAgentLabel(input: Record<string, unknown> | undefined): { label: string; type?: string } {
  const i = input ?? {};
  const str = (k: string) => (typeof i[k] === "string" ? (i[k] as string).trim() : "");
  const type = str("subagent_type") || undefined;

  const description = str("description");
  if (description) return { label: clip(description, DETAIL_MAX), type };
  if (type) return { label: type, type };

  const prompt = str("prompt");
  if (prompt) {
    // Erste Zeile mit Inhalt; bei langen Briefings am Satzende kappen statt mitten im Wort.
    const line = prompt.split("\n").find((l) => l.trim()) ?? prompt;
    const sentence = line.split(/(?<=[.!?:])\s/)[0] ?? line;
    return { label: clip(sentence, 70), type };
  }
  return { label: "Teil-Agent", type };
}

/** Kurzvorschau des Werkzeug-Arguments für eine Mitschnitt-Zeile (Pfad, Befehl, Suchmuster …). */
export function feedDetail(name: string, input: Record<string, unknown> | undefined): string | undefined {
  // Ein geschachtelter Teil-Agent: sein Auftrag ist aussagekräftiger als sein JSON-Input.
  if (name === "Task" || name === "Agent") return subAgentLabel(input).label;
  const raw = toolCommand(input);
  return raw ? clip(raw, DETAIL_MAX) : undefined;
}

/** Äusserung/Denkschritt für den Mitschnitt kürzen (leer → nichts anzeigen). */
export function feedText(text: string): string | undefined {
  const t = clip(text, TEXT_MAX);
  return t || undefined;
}

/** Zeile anhängen, Ringpuffer einhalten. */
export function pushFeed(feed: SubAgentFeedItem[], item: SubAgentFeedItem, cap = FEED_CAP): SubAgentFeedItem[] {
  const next = [...feed, item];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * Ergebnis eines Werkzeugs an SEINER Zeile vermerken (statt eine zweite anzuhängen) — sonst
 * verdoppelt sich der Mitschnitt und die Zuordnung Aufruf→Ergebnis geht optisch verloren.
 * Unbekannte toolUseId (Ergebnis ohne Aufruf, z. B. nach Ringpuffer-Überlauf) → unverändert.
 */
export function markToolResult(feed: SubAgentFeedItem[], toolUseId: string, ok: boolean): SubAgentFeedItem[] {
  let hit = false;
  const next = feed.map((f) => {
    if (!hit && f.kind === "tool" && f.toolUseId === toolUseId && f.ok === undefined) {
      hit = true;
      return { ...f, ok };
    }
    return f;
  });
  return hit ? next : feed;
}

/**
 * Abgeschlossene Teil-Agenten ausdünnen: laufende bleiben IMMER, von den fertigen nur die
 * jüngsten `cap`. Ohne das wüchse die Übersicht über einen langen Lauf unbegrenzt; mit einem
 * sofortigen Löschen bei Abschluss (das frühere Verhalten) wäre dagegen nie nachlesbar,
 * was ein Teil-Agent getan hat — er verschwand in der Sekunde, in der er fertig war.
 */
export function pruneFinished(
  subAgents: Record<string, SubAgentEntry>,
  cap = FINISHED_CAP,
): Record<string, SubAgentEntry> {
  const finished = Object.values(subAgents)
    .filter((s) => s.done)
    .sort((a, b) => (b.endedAt ?? b.lastAt) - (a.endedAt ?? a.lastAt));
  if (finished.length <= cap) return subAgents;
  const drop = new Set(finished.slice(cap).map((s) => s.id));
  return Object.fromEntries(Object.entries(subAgents).filter(([id]) => !drop.has(id)));
}

/**
 * Alle noch als laufend geführten Teil-Agenten stillsetzen — für das Ende eines Streams
 * (fertig/Fehler): danach kann definitionsgemäss keiner mehr laufen. Bewusst kein Löschen:
 * unmittelbar nach dem Lauf will man nachlesen, was die Teil-Agenten getan haben.
 * `ok` bleibt offen, denn ein Abschluss-Ergebnis kam für sie nie an.
 */
export function settleAll(subAgents: Record<string, SubAgentEntry> | undefined): Record<string, SubAgentEntry> | undefined {
  if (!subAgents || Object.keys(subAgents).length === 0) return subAgents;
  const now = Date.now();
  const next = Object.fromEntries(
    Object.entries(subAgents).map(([id, s]) => [
      id,
      s.done ? s : { ...s, done: true, endedAt: now, currentStep: undefined },
    ]),
  );
  return pruneFinished(next);
}

/** Wie viele laufen gerade (die Zahl in Kachel und Panel-Titel). */
export function activeCount(subAgents: Record<string, SubAgentEntry> | undefined): number {
  return Object.values(subAgents ?? {}).filter((s) => !s.done).length;
}

/** Modell-Kurzname fürs Badge: `claude-haiku-4-5-20251001` → `haiku 4.5`. */
export function shortModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const m = /(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/i.exec(model);
  if (!m) return clip(model, 24);
  return `${m[1].toLowerCase()} ${m[3] ? `${m[2]}.${m[3]}` : m[2]}`;
}
