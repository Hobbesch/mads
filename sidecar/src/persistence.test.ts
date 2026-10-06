/**
 * Tests für mergeRegistry + den Multi-Instanz-Projekt-Lock (persistence.ts). Via `npm run test:persist`.
 * Regression-Schutz für „main verschwindet": der passiv wiederhergestellte Integrator
 * (nicht im Pool, kein Worktree) darf beim Persistieren NICHT aus der Registry fliegen.
 * Und für „Projekt bereits in anderem Fenster offen", obwohl kein mads lief: eine recycelte pid
 * darf ein Projekt nicht aussperren (Vorfall 2026-10-06).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { acquireProjectLock, ensureMadsDir, lockHolderMatches, parseEtime, procInfo } from "./persistence";
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

// Drop wird NICHT mehr still verworfen: onDrop meldet den verwaisten Sub (nur diesen, nicht den Integrator)
{
  const dropped: string[] = [];
  const out = mergeRegistry([integ, subLive, subGone], [], new Set(), exists, (e) => dropped.push(e.agentId));
  check("onDrop feuert für den verwaisten Sub", dropped.includes("sub-gone"));
  check("onDrop feuert NICHT für den lebenden Sub", !dropped.includes("sub-live"));
  check("onDrop feuert NICHT für den Integrator (kein worktreePath)", !dropped.includes("integ-1"));
  check("genau EIN Drop gemeldet", dropped.length === 1);
  check("verwaister Sub trotzdem raus", !out.some((e) => e.agentId === "sub-gone"));
}

// explizit entfernter Sub mit fehlendem Worktree → onDrop feuert NICHT (removed hat Vorrang)
{
  const dropped: string[] = [];
  mergeRegistry([subGone], [], new Set(["sub-gone"]), exists, (e) => dropped.push(e.agentId));
  check("removed-Eintrag löst KEIN onDrop aus", dropped.length === 0);
}

// Invariante „Integrator nicht löschbar" (Vorfall 2026-09-01: EIN Stop-Klick löschte den
// Main-Stream endgültig): ein Integrator MIT Session überlebt selbst ein explizites removed.
{
  const out = mergeRegistry([integ, subLive], [], new Set(["integ-1"]), exists);
  check("Integrator mit Session überlebt explizites removed", out.some((e) => e.agentId === "integ-1"));
  const outSub = mergeRegistry([integ, subLive], [], new Set(["sub-live"]), exists);
  check("Sub bleibt via removed entfernbar", !outSub.some((e) => e.agentId === "sub-live"));
}

// Nur ein Integrator OHNE Session (nie hochgekommen — nichts zu verlieren) bleibt entfernbar.
{
  const fresh: RegistryEntry = { ...integ, agentId: "integ-fresh", sessionId: undefined };
  const out = mergeRegistry([fresh], [], new Set(["integ-fresh"]), exists);
  check("Integrator ohne Session bleibt via removed entfernbar", !out.some((e) => e.agentId === "integ-fresh"));
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

// ─── Projekt-Lock: pid-Recycling ────────────────────────────────────────────────────────────
// `ps`-Laufzeit parsen (locale-unabhängig, anders als lstart)
{
  check("etime mm:ss", parseEtime("36:11") === 36 * 60 + 11);
  check("etime hh:mm:ss", parseEtime("02:03:04") === 2 * 3600 + 3 * 60 + 4);
  check("etime dd-hh:mm:ss", parseEtime("1-02:03:04") === 86400 + 2 * 3600 + 3 * 60 + 4);
  check("etime Müll → null", parseEtime("keine-zeit") === null);
}

// Die Kern-Entscheidung: gehört der lebende Prozess wirklich zu diesem Lock?
{
  const wroteAt = new Date("2026-10-05T22:24:59.750Z");
  const lock = { pid: 1224, startedAt: wroteAt.toISOString(), host: hostname() };
  const sidecarCmd = "/opt/homebrew/bin/node /Users/x/coding/mads/src-tauri/../sidecar/dist/index.js";

  check(
    "echter Sidecar, vor dem Lock gestartet → hält",
    lockHolderMatches(lock, { startedAt: wroteAt.getTime() - 5_000, command: sidecarCmd }),
  );
  check(
    "recycelte pid (Fremdprozess) → hält NICHT",
    !lockHolderMatches(lock, {
      startedAt: wroteAt.getTime() - 5_000,
      command: "/System/Library/PrivateFrameworks/IMTransferServices.framework/…/IMTransferAgent",
    }),
  );
  check(
    "Sidecar, aber erst NACH dem Lock gestartet → hält NICHT (pid-Wrap)",
    !lockHolderMatches(lock, { startedAt: wroteAt.getTime() + 5 * 60_000, command: sidecarCmd }),
  );
  check(
    "Sekunden-Rauschen/NTP innerhalb der Toleranz → hält weiterhin",
    lockHolderMatches(lock, { startedAt: wroteAt.getTime() + 30_000, command: sidecarCmd }),
  );
  check("ohne ps-Auskunft bleibt es konservativ beim Lock", lockHolderMatches(lock, null));
}

// procInfo gegen den echten eigenen Prozess
{
  const me = procInfo(process.pid);
  check("procInfo findet den eigenen Prozess", !!me);
  check("eigene Kommandozeile enthält node", /node/i.test(me?.command ?? ""));
  check("eigene Startzeit liegt in der Vergangenheit", (me?.startedAt ?? Infinity) <= Date.now());
  check("procInfo auf tote pid → null", procInfo(0x7fffffff) === null);
}

// Ende-zu-Ende: Lock-Datei zeigt auf eine LEBENDE, aber projektfremde pid → übernehmbar.
// Genau der Vorfall: nach dem Reboot gehörte pid 1224 einem Systemdienst.
{
  const repo = mkdtempSync(join(tmpdir(), "mads-locktest-"));
  const foreign = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    ensureMadsDir(repo);
    writeFileSync(
      join(repo, ".mads", "instance.lock"),
      JSON.stringify({ pid: foreign.pid, startedAt: new Date().toISOString(), host: hostname() }),
    );
    const got = acquireProjectLock(repo);
    check("recycelte pid sperrt das Projekt NICHT aus", got.ok);
    const after = JSON.parse(readFileSync(join(repo, ".mads", "instance.lock"), "utf8"));
    check("Lock gehört danach uns", after.pid === process.pid);
  } finally {
    foreign.kill("SIGKILL");
  }
}

// Gegenprobe — der Schutz muss stehen bleiben: ein lebender Prozess, dessen Kommandozeile nach
// mads aussieht und der VOR dem Lock startete, hält ihn. Sonst öffneten zwei Fenster dasselbe Repo.
{
  const repo = mkdtempSync(join(tmpdir(), "mads-locktest-"));
  const fakeDir = mkdtempSync(join(tmpdir(), "mads-sidecar-"));
  const fake = join(fakeDir, "index.js");
  writeFileSync(fake, "setTimeout(() => {}, 30000);\n");
  const holder = spawn(process.execPath, [fake], { stdio: "ignore" });
  try {
    ensureMadsDir(repo);
    writeFileSync(
      join(repo, ".mads", "instance.lock"),
      JSON.stringify({ pid: holder.pid, startedAt: new Date().toISOString(), host: hostname() }),
    );
    const got = acquireProjectLock(repo);
    check("lebende mads-Instanz hält den Lock weiterhin", !got.ok && got.byPid === holder.pid);
  } finally {
    holder.kill("SIGKILL");
  }
}

// eslint-disable-next-line no-console
console.log(results.join("\n"));
if (failed > 0) {
  // eslint-disable-next-line no-console
  console.error(`\n${failed} persist-Test(s) fehlgeschlagen.`);
  process.exit(1);
}
