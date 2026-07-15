// SEC-1 / RB-LEAK-1: der zentrale Egress-Redaktor läuft über JEDE ausgehende NDJSON-Nachricht.
// Diese Tests sichern die drei Kern-Zusicherungen ab, auf denen die „ganzer-Envelope"-Redaktion
// beruht: (1) Routing-/Korrelations-Felder überleben unverändert, (2) verschachtelte Secrets in
// BELIEBIGEN Nachrichtentypen werden redigiert (nicht nur agent_event/agent_done/error), (3) saubere
// Nachrichten bleiben dieselbe Referenz und das Original wird nie mutiert.
import { redactForEgress } from "./io.js";

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

const AK = "AKIA" + "1234567890ABCDEF"; // gültiger AWS-Access-Key (AKIA + 16)

// (1)+(2) permission_request (früher NICHT redigiert!) mit Secret im rohen Tool-Input.
const pr = {
  v: 1, id: "env-1", ts: 1720000000,
  type: "permission_request", agentId: "a1b2c3-d4", requestId: "req-9f8e",
  toolName: "Bash", input: { command: `echo ${AK}` },
} as const;
const red = redactForEgress(pr) as Record<string, any>;
check("Routing-Felder bleiben (type/agentId/requestId/toolName)",
  red.type === "permission_request" && red.agentId === "a1b2c3-d4" && red.requestId === "req-9f8e" && red.toolName === "Bash");
check("verschachteltes Secret in permission_request.input redigiert",
  !JSON.stringify(red).includes(AK) && JSON.stringify(red).includes("«redacted:AWS Access Key»"));

// (2) Array von Content-Blöcken (agent_event) — tiefer, gemischter Baum.
const ev = { type: "agent_event", event: { content: [{ type: "text", text: `key=${AK}` }, { type: "text", text: "harmlos" }] } };
const red2 = redactForEgress(ev) as Record<string, any>;
check("Secret in Array-Blatt redigiert", !JSON.stringify(red2).includes(AK));
check("Original-Objekt NICHT mutiert", JSON.stringify(ev).includes(AK));
check("harmloses Geschwister-Blatt unverändert", red2.event.content[1].text === "harmlos");

// (3) Saubere Nachricht → identische Referenz (keine Clone-Kosten, kein Feld-Verlust).
const clean = { v: 1, type: "agent_status", agentId: "x", status: "idle", n: 3, ok: true, extra: null };
check("saubere Nachricht = dieselbe Referenz", redactForEgress(clean) === clean);

// Skalare/undefined/null robust.
check("null/scalar passthrough", redactForEgress(null) === null && redactForEgress(42) === 42);

// devserver_log (früher NICHT redigiert) — Secret in freier Zeile.
const dl = { type: "devserver_log", agentId: "svc", stream: "stdout", line: `DATABASE_URL=postgres://u:p@h and token ${AK}` };
check("devserver_log-Zeile redigiert", !(JSON.stringify(redactForEgress(dl)).includes(AK)));

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} io-redact test(s) failed`);
