// Tests für den „Push"-Schritt — die Lücke aus dem neurolink-Vorfall (2026-09-08).
//
// Ausgangslage dort: Stream „First Step", PR #1 OFFEN, Worktree sauber, `behind` 0, `ahead` 4 —
// aber ein committeter Commit (der CI-Fix, der den PR grün machen sollte) lag nur lokal. mads
// kannte die Zahl (`unpushedCount` im Autopilot-Zyklus), zeigte sie aber nirgends, und die UI bot
// als nächsten Schritt „Mergen & weiterarbeiten" an — ein Merge hätte den PR OHNE den Fix gemergt.
//
// Kernaussage der Tests: `unpushed > 0` bei offenem PR schlägt den Merge-Vorschlag, und ein
// Stream in diesem Zustand ist nicht „merge-bereit".
import { nextStep, integrationPlan } from "./derive";
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

type S = Partial<Pick<AgentVM, "id" | "label" | "role" | "live" | "status" | "ahead" | "behind" | "dirty" | "unpushed">> & {
  pr?: { state?: string; mergeable?: string; mergeStateStatus?: string; checksState?: string };
};
const mk = (o: S): AgentVM =>
  ({
    id: "a",
    label: "Stream",
    role: "sub",
    live: true,
    status: "done",
    ahead: 0,
    behind: 0,
    dirty: false,
    ...o,
  }) as unknown as AgentVM;

// ── nextStep ────────────────────────────────────────────────────────────────
check(
  "offener PR + unpushed>0 → Push (nicht Mergen) — der gemeldete Fall",
  nextStep(mk({ ahead: 4, unpushed: 1, pr: { state: "OPEN" } })).kind === "push",
);

check(
  "Push-Label trägt die Anzahl",
  nextStep(mk({ ahead: 4, unpushed: 2, pr: { state: "OPEN" } })).label === "Push (2)",
);

check(
  "offener PR + alles gepusht → wieder Mergen",
  nextStep(mk({ ahead: 4, unpushed: 0, pr: { state: "OPEN" } })).kind === "integrate",
);

check(
  "unpushed undefined (kein Remote-Branch) → kein Push-Schritt",
  nextStep(mk({ ahead: 4, pr: { state: "OPEN" } })).kind === "integrate",
);

// dirty schlägt Push: erst sichern, dann hochladen (sonst pusht man einen halben Stand).
check(
  "dirty + unpushed>0 → erst Committen",
  nextStep(mk({ ahead: 4, unpushed: 1, dirty: true, pr: { state: "OPEN" } })).kind === "commit",
);

// Ohne OFFENEN PR ist „PR erstellen" richtig — createPr pusht selbst, ein Push-Schritt wäre doppelt.
check(
  "kein PR + unpushed>0 → PR erstellen (createPr pusht selbst)",
  nextStep(mk({ ahead: 4, unpushed: 1 })).kind === "pr",
);

check(
  "gemergter PR + neue unpushed Commits → PR erstellen (nicht Push)",
  nextStep(mk({ ahead: 2, unpushed: 2, pr: { state: "MERGED" } })).kind === "pr",
);

// ── integrationPlan ─────────────────────────────────────────────────────────
const planFor = (a: AgentVM) => integrationPlan([a], []);

check(
  "unpushed>0 + offener PR → NICHT merge-bereit",
  planFor(mk({ ahead: 4, unpushed: 1, pr: { state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" } })).ready
    .length === 0,
);

check(
  "unpushed>0 + offener PR → steht mit Grund im Warteteil",
  planFor(mk({ ahead: 4, unpushed: 1, pr: { state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" } }))
    .waiting[0]?.detail === "1 Commit(s) nicht im PR → pushen",
);

check(
  "alles gepusht + sauberer PR → merge-bereit",
  planFor(mk({ ahead: 4, unpushed: 0, pr: { state: "OPEN", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", checksState: "SUCCESS" } }))
    .ready.length === 1,
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
