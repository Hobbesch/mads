/**
 * Tests für die Gate-Darstellung (shared/gate-report.ts). Via `npm run test:gatereport`.
 * Kernaussage: rote Steps kommen MIT ihrer Summary an (Notice + PR-Feedback) — Secret-Werte nie.
 */
import { gateBlockedPrMarkdown, gateNoticeText } from "./gate-report";
import { describeSecretHits, scanSecrets } from "./secrets";
import type { GateStep } from "./protocol";

const results: string[] = [];
let failed = 0;
function check(name: string, cond: boolean): void {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
}

// Fixtures bewusst zerlegt: kein zusammenhängendes Secret-Muster im Quelltext (gitleaks, mads-Push-Scan).
const value = "abcdefghij" + "klmnopqrst" + "uvwxyz1234";
const ghp = "ghp" + "_abcdefghijklmnopqrstuvwxyz0123456789";
const hits = scanSecrets("+const CARTO_API" + "_KEY = " + value + ";");
const steps: GateStep[] = [
  { name: "npm:lint", status: "pass", summary: "npm run lint --silent" },
  { name: "secret-scan", status: "fail", summary: `${hits.length} Treffer: ${describeSecretHits(hits)}` },
  { name: "python", status: "skip", summary: "kein uv.lock / uv nicht gefunden" },
];

// ---- Dashboard-Notice ----
const red = gateNoticeText(false, steps);
const redLines = red.split("\n");
check("rot: Kopfzeile mit allen Steps", redLines[0] === "Clean-Code-Gate: rot — npm:lint:pass, secret-scan:fail, python:skip");
check("rot: Summary des roten Steps enthalten", redLines[1] === "✖ secret-scan: 1 Treffer: Secret-Zuweisung (unquoted) (const CARTO_API_KEY = ***)");
check("rot: nur rote Steps im Detail", redLines.length === 2);
check("rot: kein Klartext", !red.includes(value));
check(
  "grün: einzeilig, ohne Details",
  gateNoticeText(true, [{ name: "secret-scan", status: "pass", summary: "keine Secrets im Diff" }]) === "Clean-Code-Gate: grün — secret-scan:pass",
);
check("roter Step ohne Summary: klarer Platzhalter", gateNoticeText(false, [{ name: "gate", status: "fail" }]).endsWith("✖ gate: fehlgeschlagen (ohne Details)"));

// lint/test-Summaries sind rohe Tool-Ausgabe → werden zusätzlich redigiert.
const rawFail: GateStep[] = [{ name: "npm:test", status: "fail", summary: `FAILED expected ${ghp}` }];
check("rohe Tool-Summary: Token redigiert (Notice)", !gateNoticeText(false, rawFail).includes(ghp));
check("rohe Tool-Summary: Token redigiert (PR-Feedback)", !gateBlockedPrMarkdown(rawFail).includes(ghp.slice(4)));

// ---- PR-Feedback im Stream-Verlauf (Markdown) ----
const md = gateBlockedPrMarkdown(steps);
const mdLines = md.split("\n");
check("PR-Feedback: Kopfzeile", mdLines[0] === "⛔ PR nicht erstellt — Clean-Code-Gate ist rot:");
check("PR-Feedback: je roter Step ein Listenpunkt", mdLines.filter((l) => l.startsWith("- ")).length === 1);
check("PR-Feedback: Step-Name fett", md.includes("- **secret-scan**: "));
check("PR-Feedback: Maske escaped (bleibt Literal statt Hervorhebung)", md.includes("CARTO\\_API\\_KEY = \\*\\*\\*"));
check("PR-Feedback: kein Klartext", !md.includes(value));

for (const r of results) console.log(r);
console.log(`\n${results.length - failed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} gate-report test(s) failed`);
