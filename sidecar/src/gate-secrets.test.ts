// Test: Clean-Code-Gate (gate.ts) und Push-Scan (git.ts) prüfen DENSELBEN Bereich.
//
// Vorfall powerblox-gis (2026-09-15), Stream mads/api-key: Commit A führte eine geflaggte Zeile ein,
// Commit B korrigierte sie. Das Gate scannte nur den Netto-Diff → grün; der Push-Scan bei „PR
// erstellen" scannt jeden Commit → blockiert. Jetzt scannt das Gate die Commit-Historie zusätzlich,
// und beide Meldungen sagen, dass die betroffenen lokalen Commits umgeschrieben werden müssen.
//
// Braucht `git` im PATH.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { GateStep } from "../../shared/protocol.js";

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

const base = mkdtempSync(join(tmpdir(), "mads-gate-secrets-"));
process.env.HOME = base;
process.env.USERPROFILE = base;

// Fixtures bewusst zerlegt: kein zusammenhängendes Secret-Muster im Quelltext (gitleaks, mads-Push-Scan).
const value = "abcdefghij" + "klmnopqrst" + "uvwxyz1234";
const leakLine = "VITE_CARTO_API" + "_KEY=" + value;
const envRefLine = "const CARTO_API" + "_KEY =" + " import.meta.env.VITE_CARTO" + "_API_KEY as string | undefined;";

async function main(): Promise<void> {
  const { runGate } = await import("./gate.js");
  const { pushBranch, scanBranchHistory } = await import("./git.js");

  const remote = join(base, "remote.git");
  const repo = join(base, "coding", "powerblox-gis");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const g = (...args: string[]): string => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  g("config", "commit.gpgsign", "false");
  g("remote", "add", "origin", remote);
  writeFileSync(join(repo, "README.md"), "gis\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  g("push", "-q", "-u", "origin", "main");
  const commit = (msg: string): string => {
    g("add", "-A");
    g("commit", "-qm", msg);
    return g("rev-parse", "--short", "HEAD").trim();
  };
  const step = (steps: GateStep[], name: string): GateStep | undefined => steps.find((s) => s.name === name);

  // ── Fall 1: Treffer in Commit A eingeführt, in Commit B korrigiert ─────────
  g("checkout", "-q", "-b", "mads/api-key");
  writeFileSync(join(repo, ".env.example"), `${leakLine}\n`);
  const shaA = commit("feat: CARTO-Basemap");
  writeFileSync(join(repo, ".env.example"), "VITE_CARTO_API_KEY=\n");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "basemap.ts"), `${envRefLine}\nexport default CARTO_API_KEY;\n`);
  const shaB = commit("fix: Platzhalter leer, Key aus der Env");

  const gate1 = await runGate(repo, "main");
  const hist1 = step(gate1.steps, "secret-scan-commits");
  const histText = hist1?.summary ?? "";
  check("Vorfall: Netto-Diff sauber → secret-scan pass", step(gate1.steps, "secret-scan")?.status === "pass");
  check("Vorfall: Historie → secret-scan-commits fail", hist1?.status === "fail");
  check("Vorfall: Gate insgesamt rot (statt grün vor dem blockierten Push)", gate1.ok === false);
  check("Vorfall: Meldung nennt Commit A", histText.includes(shaA));
  check("Vorfall: Korrektur-Commit B wird nicht beschuldigt", !histText.includes(shaB));
  check("Vorfall: nur 1 Treffer — die Env-Referenz in B zählt nicht", histText.startsWith("1 Treffer"));
  check("Vorfall: Meldung verlangt Squash/Umschreiben der lokalen Commits", /squash/i.test(histText) && histText.includes("merge-base"));
  check("Vorfall: maskierte Vorschau in der Meldung", histText.includes("VITE_CARTO_API_KEY=***"));
  check("Vorfall: kein Klartext in den Gate-Steps", !JSON.stringify(gate1.steps).includes(value));

  const push1 = await pushBranch(repo, "mads/api-key", "main");
  const pushErr = push1.ok ? "" : push1.error;
  check("Vorfall: Push-Scan blockiert ebenfalls", !push1.ok && push1.kind === "secret_detected");
  check("Push-Meldung nennt Commit A und verlangt Squash", pushErr.includes(shaA) && /squash/i.test(pushErr));
  check("Push-Meldung ohne Klartext", !pushErr.includes(value));
  check("Push blieb aus: kein Remote-Branch", g("ls-remote", "--heads", "origin", "mads/api-key").trim() === "");

  // ── Fall 2: der empfohlene Weg — auf die merge-base squashen ──────────────
  g("reset", "--soft", g("merge-base", "origin/main", "HEAD").trim());
  const squashed = commit("feat: CARTO-Basemap");
  const gate2 = await runGate(repo, "main");
  check("nach Squash: Gate grün", gate2.ok && step(gate2.steps, "secret-scan-commits")?.status === "pass");
  const push2 = await pushBranch(repo, "mads/api-key", "main");
  check("nach Squash: Push geht durch", push2.ok);
  check("nach Squash: Remote trägt den gesquashten Commit", g("rev-parse", "--short", "origin/mads/api-key").trim() === squashed);

  // ── Fall 3: Treffer nur im Working Tree (uncommittet) ─────────────────────
  writeFileSync(join(repo, ".env.example"), `${leakLine}\n`);
  const gate3 = await runGate(repo, "main");
  check("uncommittet: Netto-Diff inkl. Working Tree → fail", step(gate3.steps, "secret-scan")?.status === "fail");
  check("uncommittet: Historie sauber → pass", step(gate3.steps, "secret-scan-commits")?.status === "pass");
  check("uncommittet: kein Klartext in den Gate-Steps", !JSON.stringify(gate3.steps).includes(value));
  g("checkout", "--", ".env.example");

  // ── Fall 4: Basis unbekannt → nicht prüfbar statt „sauber" ────────────────
  check("unbekannte Basis → scanBranchHistory null", (await scanBranchHistory(repo, "gibt-es-nicht")) === null);
}

main()
  .catch((e) => {
    failed++;
    console.log("FAIL (Exception)", e);
  })
  .finally(() => {
    rmSync(base, { recursive: true, force: true });
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  });
