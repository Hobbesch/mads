// Test für resyncWorktreeAfterMerge (git.ts) — „Mergen & weiterarbeiten" nach einem SQUASH-Merge.
//
// Vorfall (Boba, 2026-09-10, PR #725): Der Autopilot committete NACH dem letzten Push noch lokal.
// Beim Merge lag der Branch damit auf „gesquashter Stand + 1 neuer Commit", der inhaltliche
// Vergleich gegen origin/main war also nicht leer — und mads fuhr `git rebase origin/main`. Der
// spielt ALLE Commits ab merge-base erneut ab, auch die, deren Inhalt GitHub gerade als Squash
// nach main gelegt hatte. Ergebnis: ein Rebase-Konflikt des Streams MIT SICH SELBST, in genau den
// Dateien, die er eben gemergt hatte (client/src/components/mapOverview.vue,
// client/src/views/app/portfolio.vue) — und danach dieselbe Kollision bei jedem Auto-Sync und
// jedem manuellen Sync, bis der Mensch von Hand eingriff.
//
// Der Test baut diese Lage nach und prüft BEIDE Seiten: das alte Verhalten (ohne mergedHead)
// muss weiterhin kollidieren, das neue (mit mergedHead) muss sauber durchlaufen und dabei nur
// den Commit umhängen, der nach dem Merge dazukam.
//
// Nutzt echte git-Repos in einem temp-Verzeichnis mit einem lokalen „origin"-Remote.
// Braucht `git` im PATH.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
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

const base = mkdtempSync(join(tmpdir(), "mads-resync-"));
process.env.HOME = base;
process.env.USERPROFILE = base;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@e",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@e",
    },
  });
}

function write(repo: string, file: string, text: string): void {
  writeFileSync(join(repo, file), text);
}

/**
 * Baut die Vorfalls-Lage auf und liefert Worktree-Pfad + den Stand, den „GitHub" gesquasht hat.
 *
 * main:      base → squash(feature)          (der Squash ist KEIN Vorfahre der Branch-Commits)
 * feature:   base → f1 → f2 → f3            (f1/f2 gepusht & gesquasht, f3 kam danach dazu)
 */
function scenario(name: string): { worktree: string; mergedHead: string } {
  const remote = join(base, `${name}.git`);
  const worktree = join(base, name);
  const gh = join(base, `${name}-gh`); // steht für die GitHub-Seite, die den Squash ausführt
  mkdirSync(worktree, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", worktree]);
  git(worktree, "config", "user.email", "t@e");
  git(worktree, "config", "user.name", "t");
  write(worktree, "shared.txt", "Zeile A\nZeile B\nZeile C\n");
  git(worktree, "add", "-A");
  git(worktree, "commit", "-q", "-m", "base");
  git(worktree, "remote", "add", "origin", remote);
  git(worktree, "push", "-q", "-u", "origin", "main");

  // Sub-Stream: zwei Commits in derselben Datei, beide gepusht.
  git(worktree, "checkout", "-q", "-b", "mads/feature");
  write(worktree, "shared.txt", "Zeile A\nZeile B — vom Stream\nZeile C\n");
  git(worktree, "add", "-A");
  git(worktree, "commit", "-q", "-m", "f1");
  write(worktree, "shared.txt", "Zeile A\nZeile B — vom Stream\nZeile C — vom Stream\n");
  git(worktree, "add", "-A");
  git(worktree, "commit", "-q", "-m", "f2");
  git(worktree, "push", "-q", "-u", "origin", "mads/feature");
  const mergedHead = git(worktree, "rev-parse", "origin/mads/feature").trim();

  // GitHub squasht den Branch nach main (ein einzelner, neuer Commit — keine Vorfahrenschaft).
  execFileSync("git", ["clone", "-q", remote, gh]);
  git(gh, "config", "user.email", "t@e");
  git(gh, "config", "user.name", "t");
  git(gh, "merge", "--squash", "-q", "origin/mads/feature");
  git(gh, "commit", "-q", "-m", "Feature (#725)");
  git(gh, "push", "-q", "origin", "main");

  // Der Autopilot committet NACH dem Push noch lokal — das ist der Auslöser des Vorfalls.
  write(worktree, "shared.txt", "Zeile A\nZeile B — vom Stream\nZeile C — vom Stream\nZeile D — nach dem Merge\n");
  git(worktree, "add", "-A");
  git(worktree, "commit", "-q", "-m", "f3 (nach dem Merge)");
  git(worktree, "fetch", "-q", "origin");
  return { worktree, mergedHead };
}

async function main(): Promise<void> {
  const { resyncWorktreeAfterMerge } = await import("./git.js");

  // ── Fall 1: der Vorfall selbst ────────────────────────────────────────────
  const { worktree, mergedHead } = scenario("incident");
  const before = git(worktree, "rev-parse", "HEAD").trim();

  // 1a) Altes Verhalten (kein mergedHead): rebase origin/main spielt f1/f2 erneut ab → Konflikt.
  const old = await resyncWorktreeAfterMerge(worktree, "main");
  check("ohne mergedHead → Konflikt (das alte, fehlerhafte Verhalten)", !old.ok && old.reason === "conflict");
  check("gescheiterter Resync lässt den Branch unangetastet", git(worktree, "rev-parse", "HEAD").trim() === before);

  // 1b) Neues Verhalten: nur f3 wird umgehängt, f1/f2 bleiben (als Squash) in main.
  const fixed = await resyncWorktreeAfterMerge(worktree, "main", mergedHead);
  check("mit mergedHead → sauberer Resync", fixed.ok === true);
  check("nur der Commit NACH dem Merge wird umgehängt", fixed.ok === true && fixed.mode === "rebase" && fixed.replayed === 1);
  const text = readFileSync(join(worktree, "shared.txt"), "utf-8");
  check("gemergte Arbeit bleibt erhalten", text.includes("Zeile C — vom Stream"));
  check("Arbeit nach dem Merge bleibt erhalten", text.includes("Zeile D — nach dem Merge"));
  check(
    "Branch sitzt jetzt auf origin/main + 1",
    git(worktree, "rev-list", "--count", "origin/main..HEAD").trim() === "1" &&
      git(worktree, "rev-list", "--count", "HEAD..origin/main").trim() === "0",
  );

  // ── Fall 2: nichts kam nach dem Merge dazu → Reset auf main ────────────────
  const clean = scenario("clean");
  git(clean.worktree, "reset", "-q", "--hard", clean.mergedHead); // f3 zurücknehmen
  const reset = await resyncWorktreeAfterMerge(clean.worktree, "main", clean.mergedHead);
  check("inhaltsgleich mit main → Reset statt Rebase", reset.ok === true && reset.mode === "reset");
  check(
    "Branch steht exakt auf origin/main",
    git(clean.worktree, "rev-parse", "HEAD").trim() === git(clean.worktree, "rev-parse", "origin/main").trim(),
  );

  // ── Fall 3: unbekannter/fremder mergedHead → fail-safe auf altes Verhalten ─
  const stale = scenario("stale");
  const foreign = git(stale.worktree, "rev-parse", "origin/main").trim(); // kein Vorfahre von HEAD
  const fallback = await resyncWorktreeAfterMerge(stale.worktree, "main", foreign);
  check("mergedHead kein Vorfahre von HEAD → kein --onto, Konflikt statt Arbeitsverlust", !fallback.ok);

  // ── Fall 4: ungesicherte Arbeit wird nie angefasst ────────────────────────
  const dirtyCase = scenario("dirty");
  write(dirtyCase.worktree, "shared.txt", "ungesichert\n");
  const dirty = await resyncWorktreeAfterMerge(dirtyCase.worktree, "main", dirtyCase.mergedHead);
  check("dirty → reason 'dirty' (nichts zurückgesetzt)", !dirty.ok && dirty.reason === "dirty");
  check("dirty → Datei unverändert", readFileSync(join(dirtyCase.worktree, "shared.txt"), "utf-8") === "ungesichert\n");

  console.log(`\n${passed} passed, ${failed} failed`);
  rmSync(base, { recursive: true, force: true });
  if (failed > 0) process.exit(1);
}

void main();
