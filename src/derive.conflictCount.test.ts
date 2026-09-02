// Tests für conflictCount — die Zahl im Badge des „Konflikt lösen"-Eintrags der Activity-Rail.
// Der Kernpunkt ist die Entprellung: im Vorfall 2026-08-28 (Boba) feuerte EIN Trespass-Alarm
// dutzendfach hintereinander, weil der Autopilot es bei jedem Push-Versuch erneut versuchte.
// Würde das Badge Meldungen zählen, stünde dort eine zweistellige Zahl, obwohl zwei Streams
// betroffen sind. Es zählt deshalb STREAMS.
import { conflictCount } from "./derive";
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

type S = Partial<Pick<AgentVM, "id" | "role" | "live" | "status" | "ahead" | "dirty" | "syncBlocked">> & {
  pr?: { state?: string; mergeable?: string };
};
const mk = (o: S): AgentVM =>
  ({ role: "sub", live: true, status: "done", ahead: 0, dirty: false, ...o }) as unknown as AgentVM;
const esc = (agentId: string, code: string) => ({ agentId, code });

check("keine Streams → 0", conflictCount([], []) === 0);

check(
  "sauberer Stream zählt nicht",
  conflictCount([mk({ id: "a" })], []) === 0,
);

check(
  "syncBlocked zählt",
  conflictCount([mk({ id: "a", syncBlocked: true })], []) === 1,
);

check(
  "PR CONFLICTING zählt",
  conflictCount([mk({ id: "a", pr: { state: "OPEN", mergeable: "CONFLICTING" } })], []) === 1,
);

// Der eigentliche Grund für die Set-Semantik: ein Stream, viele Meldungen.
check(
  "derselbe Stream mit vielen Eskalationen zählt EINMAL",
  conflictCount(
    [mk({ id: "a", syncBlocked: true })],
    [esc("a", "ownership_trespass"), esc("a", "ownership_trespass"), esc("a", "stale_base")],
  ) === 1,
);

check(
  "zwei betroffene Streams → 2",
  conflictCount(
    [mk({ id: "a", syncBlocked: true }), mk({ id: "b" })],
    [esc("b", "merge_conflict")],
  ) === 2,
);

// Nicht jede Eskalation rechtfertigt es, ALLE Streams anzuhalten.
check(
  "ci_red/secret_detected zählen nicht (im Stream selbst zu lösen)",
  conflictCount([mk({ id: "a" })], [esc("a", "ci_red"), esc("a", "secret_detected")]) === 0,
);

check(
  "Eskalation ohne agentId zählt nicht (sidecar-weit, keinem Stream zuzuordnen)",
  conflictCount([mk({ id: "a" })], [{ code: "merge_conflict" }]) === 0,
);

// Abgrenzungen: der Integrator wird nie angehalten, Archiviertes ist kein offenes Problem.
check(
  "Integrator zählt nicht",
  conflictCount([mk({ id: "i", role: "integrator", syncBlocked: true })], []) === 0,
);
check(
  "restaurierter (live=false) Stream zählt nicht",
  conflictCount([mk({ id: "a", live: false, syncBlocked: true })], []) === 0,
);
check(
  "fertig gemergter Stream zählt nicht",
  conflictCount([mk({ id: "a", status: "done", pr: { state: "MERGED" }, ahead: 0, syncBlocked: true })], []) === 0,
);

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} conflictCount test(s) failed`);
