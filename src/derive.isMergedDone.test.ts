// Regressionstest für isMergedDone — der Lifecycle-Klassifikator, der entscheidet, ob eine Stream-
// Kachel im aktiven Grid bleibt oder in die zugeklappte „Erledigt"-Sektion wandert. Dieser Bereich
// hatte schon zwei bewusste Fixes (caa3619: aktiver Stream bleibt; 0b81571: squash-gemergt =
// fortsetzbar); die Fälle hier halten beide + den Fix „gemergter+fertiger Stream verschwindet" fest.
import { isMergedDone } from "./derive";
import type { AgentVM } from "./store";

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

// Nur die von isMergedDone gelesenen Felder (live/status/pr/ahead/dirty) — Rest ist irrelevant.
type S = Pick<AgentVM, "live" | "status" | "ahead" | "dirty"> & { pr?: { state: string } };
const mk = (o: S): AgentVM => o as unknown as AgentVM;

// (Bug) gemergt + Turn beendet + sauber, aber live-Flag klebt noch → MUSS erledigt sein (Archiv).
check(
  "gemergt+done+ahead0+clean → erledigt (der gemeldete Bug)",
  isMergedDone(mk({ live: true, status: "done", pr: { state: "MERGED" }, ahead: 0, dirty: false })) === true,
);
check(
  "gemergt+error+ahead0+clean → erledigt (Turn ebenfalls beendet)",
  isMergedDone(mk({ live: true, status: "error", pr: { state: "MERGED" }, ahead: 0, dirty: false })) === true,
);

// (caa3619) noch arbeitend/wartend → NIE erledigt, auch wenn ein Poll MERGED refresht.
for (const status of ["starting", "running", "waiting_input", "paused", "queued", "escalation"] as const) {
  check(
    `${status} + live → bleibt aktiv (caa3619)`,
    isMergedDone(mk({ live: true, status, pr: { state: "MERGED" }, ahead: 0, dirty: false })) === false,
  );
}

// „Mergen & weiterarbeiten": alter PR wieder MERGED (Poll), aber neue ungemergte Commits (ahead>0).
check(
  "done + MERGED + ahead>0 → bleibt aktiv (ungemergte Arbeit)",
  isMergedDone(mk({ live: true, status: "done", pr: { state: "MERGED" }, ahead: 2, dirty: false })) === false,
);
// done + gemergt, aber uncommittete Reste → bleibt aktiv (ungesicherte Arbeit nicht still archivieren).
check(
  "done + MERGED + dirty → bleibt aktiv",
  isMergedDone(mk({ live: true, status: "done", pr: { state: "MERGED" }, ahead: 0, dirty: true })) === false,
);
// Turn beendet, aber PR noch offen (nicht gemergt) → bleibt aktiv (Integrieren noch möglich).
check(
  "done + OPEN-PR → bleibt aktiv",
  isMergedDone(mk({ live: true, status: "done", pr: { state: "OPEN" }, ahead: 1, dirty: false })) === false,
);
// Passiver Restore (live=false) eines gemergten sauberen Streams → erledigt (unverändertes Verhalten).
check(
  "restore (live=false) + MERGED + ahead0 + clean → erledigt",
  isMergedDone(mk({ live: false, status: "done", pr: { state: "MERGED" }, ahead: 0, dirty: false })) === true,
);

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} isMergedDone test(s) failed`);
