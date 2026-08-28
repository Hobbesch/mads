/**
 * Tests für den Kollisionsschutz (shared/collision.ts). Via `npm run test:collision`.
 */
import { parseDiffRegions, detectCollisions, type AgentRegions } from "./collision";

const results: string[] = [];
let failed = 0;
function check(name: string, cond: boolean): void {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
}

// ---- parseDiffRegions ----
const diff = [
  "diff --git a/src/mail.py b/src/mail.py",
  "+++ b/src/mail.py",
  "@@ -2406,0 +2406,3 @@ def mail_account_view(request):",
  "+    do_stuff()",
  "@@ -2450,0 +2460,2 @@ def _pst_move_targets(x):",
  "+    pst()",
].join("\n");
const regions = parseDiffRegions(diff);
check("parse: one file", regions.length === 1 && regions[0].path === "src/mail.py");
check("parse: two symbols", regions[0].symbols.includes("mail_account_view") && regions[0].symbols.includes("_pst_move_targets"));
check("parse: /dev/null ignored", parseDiffRegions("+++ /dev/null").length === 0);

// ---- detectCollisions (das paix-Szenario) ----
const postfach: AgentRegions = { agentId: "a", label: "postfach", regions: [{ path: "src/mail.py", symbols: ["mail_account_view"] }] };
const pst: AgentRegions = { agentId: "b", label: "pst-test", regions: [{ path: "src/mail.py", symbols: ["_pst_move_targets"] }] };

// gleiche Datei, verschiedene Symbole → KEINE Kollision (Kernfall)
check("same file, different symbols → no collision", detectCollisions([postfach, pst]).length === 0);

// gleiche Datei, gemeinsames Symbol → Region-Kollision
const pstBad: AgentRegions = { agentId: "b", label: "pst-test", regions: [{ path: "src/mail.py", symbols: ["mail_account_view"] }] };
const c1 = detectCollisions([postfach, pstBad]);
check("shared symbol → region collision", c1.length === 1 && c1[0].severity === "region" && c1[0].symbols?.includes("mail_account_view") === true);

// gleiche Datei, eine Seite ohne Symbol-Info → file-Warnung
const unknown: AgentRegions = { agentId: "c", label: "x", regions: [{ path: "src/mail.py", symbols: [] }] };
check("unknown symbols → file warning", detectCollisions([postfach, unknown]).some((c) => c.severity === "file"));

// verschiedene Dateien → keine Kollision
const other: AgentRegions = { agentId: "d", label: "y", regions: [{ path: "src/other.py", symbols: ["foo"] }] };
check("different files → none", detectCollisions([postfach, other]).length === 0);

// drei Agenten: nur das kollidierende Paar wird gemeldet
check("three agents, one clash", detectCollisions([postfach, pst, pstBad]).length === 1);

// ---- Regression: C#-Namespace-Kontext (Vorfall 2026-08-28, Boba) ----
// Ohne Diff-Driver liefert git bei C# als Hunk-Kontext IMMER `namespace X` — für jeden Hunk
// jeder Datei. Wurde das als Symbol gewertet, kollidierten zwei Streams zwangsläufig, auch wenn
// ihre Hunks hunderte Zeilen auseinanderlagen (real: Z. 225-746 gegen Z. 754-1287).
const csharpA = parseDiffRegions(
  [
    "+++ b/server/BoBaAppBe/Services/AggregationService.cs",
    "@@ -224 +225,15 @@ namespace BoBaAppBe.Services",
    "+            var x = 1;",
  ].join("\n"),
);
const csharpB = parseDiffRegions(
  [
    "+++ b/server/BoBaAppBe/Services/AggregationService.cs",
    "@@ -1004 +1017,15 @@ namespace BoBaAppBe.Services",
    "+            var y = 2;",
  ].join("\n"),
);
check("namespace context yields no pseudo-symbol", csharpA[0].symbols.length === 0);
const csharpCollisions = detectCollisions([
  { agentId: "a", label: "csv", regions: csharpA },
  { agentId: "b", label: "perf", regions: csharpB },
]);
check(
  "namespace context → file warning, NOT a region collision",
  csharpCollisions.length === 1 && csharpCollisions[0].severity === "file",
);

// Mit Diff-Driver liefert git den Methodenkopf — dann greift die echte Symbol-Granularität.
const withDriverA = parseDiffRegions(
  ["+++ b/Svc.cs", "@@ -224 +225,15 @@ public ImportCSVResponse ImportCSV(string csvStr, bool p)", "+  var x = 1;"].join("\n"),
);
const withDriverB = parseDiffRegions(
  ["+++ b/Svc.cs", "@@ -1004 +1017,3 @@ private void BoBaCalc(AppDbContext db)", "+  var y = 2;"].join("\n"),
);
check("driver context extracts the method name", withDriverA[0].symbols.includes("ImportCSV"));
check(
  "different methods in the same C# file → no collision",
  detectCollisions([
    { agentId: "a", label: "csv", regions: withDriverA },
    { agentId: "b", label: "perf", regions: withDriverB },
  ]).length === 0,
);
check(
  "same method → region collision stays",
  detectCollisions([
    { agentId: "a", label: "csv", regions: withDriverA },
    { agentId: "b", label: "perf", regions: withDriverA },
  ])[0]?.severity === "region",
);

// Weitere Container-Kontexte (Go/Java/Python-Importzeilen) dürfen ebenfalls nicht ankern.
check(
  "import/package contexts yield no symbol",
  parseDiffRegions(["+++ b/a.go", "@@ -1 +1 @@ package main", "+x"].join("\n"))[0].symbols.length === 0 &&
    parseDiffRegions(["+++ b/B.java", "@@ -1 +1 @@ import java.util.List;", "+x"].join("\n"))[0].symbols.length === 0,
);

for (const r of results) console.log(r);
console.log(`\n${results.length - failed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} collision test(s) failed`);
