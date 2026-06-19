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

for (const r of results) console.log(r);
console.log(`\n${results.length - failed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} collision test(s) failed`);
