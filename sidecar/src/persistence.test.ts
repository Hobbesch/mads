/**
 * Tests für mergeRegistry (persistence.ts). Via `npm run test:persist`.
 * Regression-Schutz für „main verschwindet": der passiv wiederhergestellte Integrator
 * (nicht im Pool, kein Worktree) darf beim Persistieren NICHT aus der Registry fliegen.
 */
import { mergeRegistry } from "./persistence";
import type { RegistryEntry } from "./persistence";

const results: string[] = [];
let failed = 0;
function check(name: string, cond: boolean): void {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
}

const integ: RegistryEntry = {
  agentId: "integ-1", label: "Main-Agent", role: "integrator", sessionId: "s-integ",
  status: "done", mock: false, updatedAt: 1,
};
const subLive: RegistryEntry = {
  agentId: "sub-live", label: "A2", role: "sub", sessionId: "s-a2",
  branch: "a2", worktreePath: "/wt/a2", status: "done", mock: false, updatedAt: 1,
};
const subGone: RegistryEntry = {
  agentId: "sub-gone", label: "old", role: "sub", sessionId: "s-old",
  branch: "old", worktreePath: "/wt/gone", status: "done", mock: false, updatedAt: 1,
};
const exists = (p: string) => p === "/wt/a2"; // nur /wt/a2 existiert noch

// KERN: Integrator NICHT im Pool → bleibt trotzdem in der Registry
{
  const out = mergeRegistry([integ, subLive], [], new Set(), exists);
  check("Integrator ohne Pool-Eintrag bleibt erhalten", out.some((e) => e.agentId === "integ-1"));
  check("Sub mit existierendem Worktree bleibt", out.some((e) => e.agentId === "sub-live"));
}

// verwaister Sub (Worktree weg) wird verworfen
{
  const out = mergeRegistry([integ, subGone], [], new Set(), exists);
  check("Sub mit verschwundenem Worktree fliegt raus", !out.some((e) => e.agentId === "sub-gone"));
  check("Integrator bleibt auch hier", out.some((e) => e.agentId === "integ-1"));
}

// explizit entfernt (removed) → raus, selbst der Integrator
{
  const out = mergeRegistry([integ, subLive], [], new Set(["integ-1"]), exists);
  check("explizit entfernter Integrator wird NICHT wiederbelebt", !out.some((e) => e.agentId === "integ-1"));
}

// Pool-Stand gewinnt (frische Daten überschreiben alten Registry-Eintrag)
{
  const fresh: RegistryEntry = { ...integ, status: "waiting_input", updatedAt: 999 };
  const out = mergeRegistry([integ], [fresh], new Set(), exists);
  const got = out.find((e) => e.agentId === "integ-1");
  check("Pool-Eintrag überschreibt Registry (frischer Status)", got?.status === "waiting_input" && got?.updatedAt === 999);
}

// neuer Pool-Agent wird hinzugefügt
{
  const out = mergeRegistry([], [subLive], new Set(), exists);
  check("neuer Pool-Agent landet in der Registry", out.some((e) => e.agentId === "sub-live"));
}

// eslint-disable-next-line no-console
console.log(results.join("\n"));
if (failed > 0) {
  // eslint-disable-next-line no-console
  console.error(`\n${failed} persist-Test(s) fehlgeschlagen.`);
  process.exit(1);
}
