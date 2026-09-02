// Tests für die Teil-Agenten-Helfer (Einblick-Panel im Inspector).
//
// Zwei Punkte sind die eigentliche Substanz und deshalb hier festgenagelt:
//  1. Die BEZEICHNUNG. Im Panel stand dreimal „Teil-Agent", obwohl jeder Task/Agent-Aufruf eine
//     `description` mitgibt — die Kette description → subagent_type → erster Satz des Prompts
//     darf nicht wieder auf das nichtssagende Wort zurückfallen, solange irgendetwas da ist.
//  2. Abgeschlossene Teil-Agenten werden STILLGESETZT, nicht gelöscht. Früher verschwand ein
//     Teil-Agent in der Sekunde, in der er fertig war — genau dann, wenn man nachlesen will,
//     was er getan hat.
import {
  subAgentLabel,
  feedDetail,
  feedText,
  pushFeed,
  markToolResult,
  pruneFinished,
  settleAll,
  activeCount,
  shortModel,
  FEED_CAP,
  type SubAgentEntry,
  type SubAgentFeedItem,
} from "./subAgents";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log("PASS", name);
  } else {
    failed++;
    console.log("FAIL", name);
  }
}

// ── Bezeichnung ────────────────────────────────────────────────────────────────
check(
  "description gewinnt",
  subAgentLabel({ description: "Router-Struktur prüfen", subagent_type: "Explore", prompt: "Lies…" }).label ===
    "Router-Struktur prüfen",
);
check("subagent_type wird als Typ mitgeführt", subAgentLabel({ description: "X", subagent_type: "Explore" }).type === "Explore");
check("ohne description gewinnt der Typ", subAgentLabel({ subagent_type: "Explore" }).label === "Explore");
check(
  "ohne beides: erster Satz des Prompts",
  subAgentLabel({ prompt: "Finde alle Vue-Komponenten. Danach berichte." }).label === "Finde alle Vue-Komponenten.",
);
check(
  "langer Prompt-Satz wird gekappt",
  (() => {
    const l = subAgentLabel({ prompt: "A".repeat(200) }).label;
    return l.length <= 71 && l.endsWith("…");
  })(),
);
check("mehrzeiliger Prompt: erste nicht-leere Zeile", subAgentLabel({ prompt: "\n\nErste Zeile\nzweite" }).label === "Erste Zeile");
check("leerer Input → Notnagel", subAgentLabel({}).label === "Teil-Agent");
check("undefined Input → Notnagel", subAgentLabel(undefined).label === "Teil-Agent");
check("Whitespace-description zählt nicht als gesetzt", subAgentLabel({ description: "   ", subagent_type: "Explore" }).label === "Explore");

// ── Mitschnitt-Zeilen ──────────────────────────────────────────────────────────
check("feedDetail nimmt den Pfad", feedDetail("Read", { file_path: "src/store.ts" }) === "src/store.ts");
check("feedDetail nimmt den Befehl", feedDetail("Bash", { command: "npm run build" }) === "npm run build");
check(
  "geschachtelter Teil-Agent zeigt seinen Auftrag statt JSON",
  feedDetail("Agent", { description: "Doku lesen", prompt: "…" }) === "Doku lesen",
);
check("feedDetail ohne Argumente → nichts", feedDetail("TodoWrite", {}) === undefined);
check(
  "feedDetail kappt lange Argumente",
  (feedDetail("Grep", { pattern: "x".repeat(300) }) ?? "").length <= 111,
);
check("feedText faltet Zeilenumbrüche", feedText("Zeile eins\n\nZeile zwei") === "Zeile eins Zeile zwei");
check("feedText auf Leerraum → nichts", feedText("   \n  ") === undefined);

const mkItem = (i: number): SubAgentFeedItem => ({ id: `i${i}`, kind: "tool", name: "Read", at: i });
check(
  "pushFeed hält den Ringpuffer ein",
  (() => {
    let feed: SubAgentFeedItem[] = [];
    for (let i = 0; i < FEED_CAP + 20; i++) feed = pushFeed(feed, mkItem(i));
    return feed.length === FEED_CAP && feed[feed.length - 1].id === `i${FEED_CAP + 19}`;
  })(),
);

// ── Ergebnis an der richtigen Zeile ────────────────────────────────────────────
const feedTwo: SubAgentFeedItem[] = [
  { id: "a", kind: "tool", name: "Read", toolUseId: "t1", at: 1 },
  { id: "b", kind: "tool", name: "Grep", toolUseId: "t2", at: 2 },
];
check("markToolResult trifft die passende Zeile", markToolResult(feedTwo, "t2", false)[1].ok === false);
check("markToolResult lässt andere Zeilen unberührt", markToolResult(feedTwo, "t2", false)[0].ok === undefined);
check("markToolResult ohne Treffer → unverändert (gleiche Referenz)", markToolResult(feedTwo, "t9", true) === feedTwo);
check(
  "markToolResult überschreibt kein bereits gesetztes Ergebnis",
  (() => {
    const once = markToolResult(feedTwo, "t1", true);
    return markToolResult(once, "t1", false)[0].ok === true;
  })(),
);

// ── Lebenszyklus: stillsetzen statt löschen ────────────────────────────────────
const mkSub = (id: string, o: Partial<SubAgentEntry> = {}): SubAgentEntry => ({
  id,
  label: id,
  toolCount: 0,
  feed: [],
  startedAt: 0,
  lastAt: 0,
  ...o,
});
const many: Record<string, SubAgentEntry> = {
  live: mkSub("live"),
  ...Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [`f${i}`, mkSub(`f${i}`, { done: true, endedAt: i })]),
  ),
};
const pruned = pruneFinished(many, 3);
check("pruneFinished behält laufende immer", "live" in pruned);
check("pruneFinished behält nur die jüngsten fertigen", Object.keys(pruned).length === 4 && "f8" in pruned && !("f0" in pruned));
check(
  "pruneFinished unter der Grenze → unverändert (gleiche Referenz)",
  (() => {
    const few = { a: mkSub("a", { done: true }), b: mkSub("b") };
    return pruneFinished(few, 3) === few;
  })(),
);

check(
  "settleAll setzt Laufende auf fertig, ohne sie zu löschen",
  (() => {
    const settled = settleAll({ a: mkSub("a"), b: mkSub("b", { done: true, ok: true, endedAt: 5 }) }) ?? {};
    return Object.keys(settled).length === 2 && settled.a.done === true && settled.a.currentStep === undefined;
  })(),
);
check(
  "settleAll lässt ein bereits gesetztes Ergebnis stehen",
  (settleAll({ b: mkSub("b", { done: true, ok: false, endedAt: 5 }) }) ?? {}).b.ok === false,
);
check("settleAll auf leer → unverändert", settleAll(undefined) === undefined);

check("activeCount zählt nur Laufende", activeCount({ a: mkSub("a"), b: mkSub("b", { done: true }) }) === 1);
check("activeCount ohne Teil-Agenten → 0", activeCount(undefined) === 0);

// ── Modell-Badge ───────────────────────────────────────────────────────────────
check("shortModel kürzt Haiku mit Minor", shortModel("claude-haiku-4-5-20251001") === "haiku 4.5");
check("shortModel kürzt Opus ohne Minor", shortModel("claude-opus-5") === "opus 5");
check("shortModel ohne Muster → gekappter Rohwert", shortModel("mein-eigenes-modell") === "mein-eigenes-modell");
check("shortModel ohne Wert → nichts", shortModel(undefined) === undefined);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
