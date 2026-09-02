import { normalizeDep } from "./devserver.js";

let passed = 0, failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) { passed++; console.log("PASS", name); } else { failed++; console.log("FAIL", name); }
}

// Kurzform "port" → localhost
const a = normalizeDep("5433");
check("nur Port → 127.0.0.1", a?.host === "127.0.0.1" && a?.port === 5433);
check("Anzeigename ist der Port", a?.name === ":5433");
// Kurzform "host:port"
const b = normalizeDep("db.local:5432");
check("host:port wird zerlegt", b?.host === "db.local" && b?.port === 5432);
// Objektform mit Auto-Start
const c = normalizeDep({ port: 5433, name: "postgres", start: "docker compose up -d postgres" });
check("Objektform: Name + Startbefehl", c?.name === "postgres" && c?.start === "docker compose up -d postgres");
check("Objektform: Port als Zahl", c?.port === 5433);
check("Objektform: Port als String wird geparst", normalizeDep({ port: "5433" })?.port === 5433);
// FAIL CLOSED — Unsinn darf nie zu einer Abhängigkeit werden (sonst prüft mads Zufallsports)
check("Text ohne Port → null", normalizeDep("abc") === null);
check("ungültiger Port → null", normalizeDep({ port: "x" } as never) === null);
check("leerer String → null", normalizeDep("") === null);
check("Port 0 → null", normalizeDep({ port: 0 }) === null);
check("zu langer Port → null", normalizeDep("999999") === null);
check("ohne start bleibt start undefined", normalizeDep("5433")?.start === undefined);

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} devserver-dep test(s) failed`);
