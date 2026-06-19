/**
 * Tests für den Secret-Scan (shared/secrets.ts). Via `npm run test:secrets`.
 */
import { scanSecrets } from "./secrets";

const results: string[] = [];
let failed = 0;
function check(name: string, cond: boolean): void {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
}

// nur hinzugefügte Zeilen werden geprüft
check("added private key → hit", scanSecrets("+-----BEGIN PRIVATE KEY-----").length === 1);
check("context/removed lines ignored", scanSecrets("-AKIAIOSFODNN7EXAMPLE\n AKIAIOSFODNN7EXAMPLE").length === 0);
check("+++ header ignored", scanSecrets("+++ b/secrets.txt").length === 0);

check("AWS key → hit", scanSecrets("+const k = 'AKIAIOSFODNN7EXAMPLE'").some((h) => h.kind === "AWS Access Key"));
check("GitHub token → hit", scanSecrets("+token: ghp_abcdefghijklmnopqrstuvwxyz0123456789").some((h) => h.kind === "GitHub Token"));
check("anthropic key → hit", scanSecrets("+ANTHROPIC=sk-ant-abcdefghijklmnopqrstuvwxyz").length === 1);
check(
  "generic secret assignment → hit",
  scanSecrets(`+  password = "hunter2-supersecret"`).some((h) => h.kind === "Secret-Zuweisung"),
);

// kein Secret → keine Treffer
check("clean code → no hits", scanSecrets("+const x = add(1, 2)\n+return x").length === 0);
check("short value not flagged", scanSecrets(`+password = "short"`).length === 0);

// Maskierung: der Geheim-Wert darf NICHT im Preview stehen
const masked = scanSecrets("+token: ghp_abcdefghijklmnopqrstuvwxyz0123456789");
check("secret is masked", masked.length === 1 && !masked[0].preview.includes("ghp_abcdefghij"));

for (const r of results) console.log(r);
console.log(`\n${results.length - failed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} secret-scan test(s) failed`);
