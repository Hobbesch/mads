// Test für fastForwardMain (git.ts) — insbesondere den Fall "wrong_branch".
//
// Vorfall (neurolink, 2026-09-08): das Projekt war zuerst mit einem anderen Werkzeug entwickelt
// und danach in mads übernommen worden. Der Haupt-Checkout stand dabei weiter auf dem alten
// Feature-Branch, nicht auf main. fastForwardMain gab für diesen Fall `behind: 0, blocked: null`
// zurück — formal „nichts zu tun". Der Aufrufer las das als Erfolg und meldete „main ist bereits
// aktuell", während main in Wahrheit zwei Commits zurücklag und der Integrator gegen einen
// fremden Baum arbeitete. Ein stiller Fehlschlag, der sich als grüne Bestätigung tarnte.
//
// Nutzt ein echtes git-Repo in einem temp-Verzeichnis mit einem lokalen „origin"-Remote.
// Braucht `git` im PATH.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

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

const base = mkdtempSync(join(tmpdir(), "mads-ffmain-"));
process.env.HOME = base;
process.env.USERPROFILE = base;

async function main(): Promise<void> {
  const { fastForwardMain } = await import("./git.js");

  const remote = join(base, "remote.git");
  const repo = join(base, "coding", "myrepo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  const g = (...args: string[]): string => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  g("config", "commit.gpgsign", "false");
  g("remote", "add", "origin", remote);
  writeFileSync(join(repo, "a.txt"), "1\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  g("push", "-q", "-u", "origin", "main");

  // ── Fall 1: auf main, bereits aktuell → kein FF, kein blocked ──────────────
  const upToDate = await fastForwardMain(repo, "main");
  check("aktuell → ff 0", upToDate.ff === 0);
  check("aktuell → behind 0", upToDate.behind === 0);
  check("aktuell → nicht blockiert", upToDate.blocked === null);

  // origin um zwei Commits vorrücken lassen (über einen zweiten Klon).
  const other = join(base, "other");
  execFileSync("git", ["clone", "-q", remote, other]);
  const o = (...args: string[]): string => execFileSync("git", ["-C", other, ...args], { encoding: "utf8" });
  o("config", "user.email", "t@t");
  o("config", "user.name", "t");
  o("config", "commit.gpgsign", "false");
  for (const n of ["2", "3"]) {
    writeFileSync(join(other, "a.txt"), `${n}\n`);
    o("add", "-A");
    o("commit", "-qm", `c${n}`);
  }
  o("push", "-q", "origin", "main");
  g("fetch", "-q", "origin");

  // ── Fall 2: auf main, 2 zurück → sauberer fast-forward ─────────────────────
  const ff = await fastForwardMain(repo, "main");
  check("behind → ff zieht 2 Commits vor", ff.ff === 2);
  check("behind → behind meldet 2", ff.behind === 2);
  check("behind → nicht blockiert", ff.blocked === null);

  // origin erneut vorrücken, damit main wieder zurückliegt.
  writeFileSync(join(other, "a.txt"), "4\n");
  o("add", "-A");
  o("commit", "-qm", "c4");
  o("push", "-q", "origin", "main");
  g("fetch", "-q", "origin");

  // ── Fall 3: FREMDER Branch ausgecheckt (der gemeldete Fall) ────────────────
  g("checkout", "-q", "-b", "feat/alt");
  const wrong = await fastForwardMain(repo, "main");
  check("fremder Branch → blocked 'wrong_branch' (nicht null)", wrong.blocked === "wrong_branch");
  check("fremder Branch → kein FF", wrong.ff === 0);
  check("fremder Branch → nennt den ausgecheckten Branch", wrong.currentBranch === "feat/alt");
  // Der Kern des Bugs: behind muss den Rückstand von main melden, nicht 0 — sonst liest der
  // Aufrufer „nichts zu tun" und meldet fälschlich „main ist bereits aktuell".
  check("fremder Branch → behind zählt den Rückstand von main (1), nicht 0", wrong.behind === 1);

  // Der fremde Branch darf dabei nicht bewegt worden sein.
  const head = execFileSync("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  check("fremder Branch → HEAD unverändert (nichts angefasst)", head === "feat/alt");

  // ── Fall 4: detached HEAD bleibt sein eigener Grund ────────────────────────
  g("checkout", "-q", "--detach");
  const det = await fastForwardMain(repo, "main");
  check("detached → blocked 'detached' (nicht 'wrong_branch')", det.blocked === "detached");

  // ── Fall 5: auf main, aber getrackte Datei verändert → 'dirty' ─────────────
  g("checkout", "-q", "main");
  writeFileSync(join(repo, "a.txt"), "lokal\n");
  const dirty = await fastForwardMain(repo, "main");
  check("dirty → blocked 'dirty'", dirty.blocked === "dirty");
  check("dirty → behind bleibt sichtbar", dirty.behind === 1);

  console.log(`\n${passed} passed, ${failed} failed`);
  rmSync(base, { recursive: true, force: true });
  if (failed > 0) process.exit(1);
}

void main();
