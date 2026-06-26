/**
 * Tests für die Autopilot-Policy (shared/autopilot.ts). Via `npm run test:autopilot`.
 * Sicherheitskritisch: stellt sicher, dass NUR Reversibles automatisiert wird und
 * irreversible/blockierte Zustände NIE eine Aktion auslösen.
 */
import { autopilotDecision, type AutopilotState } from "./autopilot";

const results: string[] = [];
let failed = 0;
function check(name: string, cond: boolean): void {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
}

const base: AutopilotState = {
  level: "assisted",
  role: "sub",
  status: "waiting_input",
  dirty: false,
  ahead: 0,
  unpushed: 0,
  hasPr: false,
  prOpen: false,
  syncBlocked: false,
  busyPermission: false,
  secretBlocked: false,
};
const decide = (p: Partial<AutopilotState>) => autopilotDecision({ ...base, ...p }).action;

// Reversibles wird automatisiert
check("dirty → commit", decide({ dirty: true }) === "commit");
check("committet, kein PR → create_pr", decide({ ahead: 2 }) === "create_pr");
check("offener PR + unpushed → push", decide({ hasPr: true, prOpen: true, ahead: 2, unpushed: 1 }) === "push");
check("alles erledigt → none", decide({ hasPr: true, prOpen: true, ahead: 1, unpushed: 0 }) === "none");

// Reihenfolge: sichern zuerst
check("dirty schlägt PR-Erstellung → commit zuerst", decide({ dirty: true, ahead: 2 }) === "commit");

// NIE automatisieren bei …
check("manual → none", decide({ level: "manual", dirty: true }) === "none");
check("Integrator → none", decide({ role: "integrator", dirty: true }) === "none");
check("läuft → none", decide({ status: "running", dirty: true }) === "none");
check("wartet auf Permission → none", decide({ busyPermission: true, dirty: true }) === "none");
check("Sync-Konflikt → none", decide({ syncBlocked: true, dirty: true }) === "none");
check("Secret erkannt → none (kein Auto-Commit)", decide({ dirty: true, secretBlocked: true }) === "none");

// autopilot-Stufe verhält sich (v1) wie assisted auf den Auto-Aktionen
check("autopilot: dirty → commit", decide({ level: "autopilot", dirty: true }) === "commit");

for (const r of results) console.log(r);
console.log(`\n${results.length - failed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} autopilot test(s) failed`);
