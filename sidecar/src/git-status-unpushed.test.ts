// Test für gitStatus().unpushed (git.ts) — die Zahl hinter dem „n Commits nicht gepusht"-Badge.
//
// Zwei Aussagen, die leicht durcheinandergehen:
//  1. `ahead` zählt gegen origin/<default> (ungemergte Arbeit), `unpushed` gegen origin/<branch>
//     (anstehender Push). Der Vorfall neurolink war genau die Verwechslung: die UI zeigte nur
//     `ahead` und hatte für „unpushed" gar kein Feld — ein Commit lag fest, sichtbar nirgends.
//  2. Fehlt origin/<branch> (Branch nie gepusht), endet rev-list mit code!==0. Das ist ein
//     NORMALZUSTAND, kein git-Fehler: es darf `unreliable` NICHT setzen. Täte es das, würden
//     Auto-Sync und Autopilot den Stream dauerhaft überspringen (beide steigen bei `unreliable`
//     aus) — ein neu angelegter Stream käme nie mehr in Bewegung.
//
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

const base = mkdtempSync(join(tmpdir(), "mads-unpushed-"));
process.env.HOME = base;
process.env.USERPROFILE = base;

async function main(): Promise<void> {
  const { gitStatus } = await import("./git.js");

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

  // Feature-Branch mit zwei Commits, noch NICHT gepusht.
  g("checkout", "-q", "-b", "mads/feature");
  for (const n of ["2", "3"]) {
    writeFileSync(join(repo, "a.txt"), `${n}\n`);
    g("add", "-A");
    g("commit", "-qm", `c${n}`);
  }

  // ── Fall 1: origin/<branch> existiert nicht ───────────────────────────────
  const noRemote = await gitStatus(repo, repo, "mads/feature", "main", true);
  check("kein Remote-Branch → unpushed undefined (nicht 0)", noRemote.unpushed === undefined);
  check("kein Remote-Branch → unreliable NICHT gesetzt", noRemote.unreliable === undefined);
  check("kein Remote-Branch → ahead trotzdem korrekt (2)", noRemote.ahead === 2);
  check("kein Remote-Branch → behind korrekt (0)", noRemote.behind === 0);

  // ── Fall 2: gepusht → nichts steht mehr an ────────────────────────────────
  g("push", "-q", "-u", "origin", "mads/feature");
  const pushed = await gitStatus(repo, repo, "mads/feature", "main", true);
  check("gepusht → unpushed 0", pushed.unpushed === 0);
  check("gepusht → ahead bleibt 2 (ungemergt gegen main)", pushed.ahead === 2);

  // ── Fall 3: ein weiterer Commit — der gemeldete Fall ──────────────────────
  writeFileSync(join(repo, "a.txt"), "4\n");
  g("add", "-A");
  g("commit", "-qm", "c4");
  const st = await gitStatus(repo, repo, "mads/feature", "main", true);
  check("neuer Commit → unpushed 1", st.unpushed === 1);
  // Der Kern: ahead und unpushed sind verschiedene Zahlen. Genau diese Differenz war unsichtbar.
  check("neuer Commit → ahead 3, unpushed 1 (verschiedene Zähler)", st.ahead === 3 && st.unpushed === 1);
  check("neuer Commit → sauberer Arbeitsbaum", st.dirty === false);

  // ── Fall 4: uncommittete Änderung ändert unpushed nicht ───────────────────
  writeFileSync(join(repo, "a.txt"), "dirty\n");
  const dirty = await gitStatus(repo, repo, "mads/feature", "main", true);
  check("dirty → unpushed unverändert 1 (zählt Commits, nicht Dateien)", dirty.unpushed === 1);
  check("dirty → dirty true", dirty.dirty === true);

  console.log(`\n${passed} passed, ${failed} failed`);
  rmSync(base, { recursive: true, force: true });
  if (failed > 0) process.exit(1);
}

void main();
