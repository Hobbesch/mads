// Test für isForeignMadsWorktree + relocateWorktree (git.ts) — die Cross-Machine-Härtung.
// Szenario: ein mads-Repo wird von einem Mac (Home /Users/amedici) auf einen anderen (anderes Home)
// kopiert. Die Worktrees unter ~/mads-worktrees werden dabei NICHT mitkopiert; die in
// .git/worktrees/*/gitdir eingebackenen absoluten Pfade zeigen danach auf das fremde Home ins Leere.
// relocateWorktree soll den Worktree auf den lokalen Kanon-Pfad (worktreePathFor) umziehen und aus
// dem — mitkopierten, intakten — Branch neu auschecken.
//
// Nutzt ein echtes git-Repo in einem temp-Verzeichnis und setzt HOME auf temp, damit worktreePathFor
// unter das temp-Home auflöst (statt ins echte ~/mads-worktrees zu schreiben). Braucht `git` im PATH.
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
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

const base = mkdtempSync(join(tmpdir(), "mads-relocate-"));
// HOME auf temp umbiegen, BEVOR git.ts (→ worktreePathFor/homedir) geladen/aufgerufen wird.
process.env.HOME = base;
process.env.USERPROFILE = base; // Windows-Fallback für os.homedir()

async function main(): Promise<void> {
  const { isForeignMadsWorktree, relocateWorktree, worktreePathFor, repoSlug } = await import("./git.js");
  const repo = join(base, "coding", "myrepo");
  mkdirSync(repo, { recursive: true });
  const g = (...args: string[]): string => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  execFileSync("git", ["init", "-q", repo]);
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  g("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "a.txt"), "hi\n");
  g("add", "-A");
  g("commit", "-qm", "init");

  const agentId = "agent-uuid-1";
  const branch = "mads/foo";
  g("branch", branch);
  const local = worktreePathFor(repo, agentId); // = <base>/mads-worktrees/myrepo/agent-uuid-1
  check("worktreePathFor löst unter temp-HOME auf", local.startsWith(base) && local.endsWith(join("mads-worktrees", "myrepo", agentId)));
  check("repoSlug = Verzeichnisname", repoSlug(repo) === "myrepo");

  // ── isForeignMadsWorktree: Klassifikation ─────────────────────────────────
  const foreignPath = `/Users/amedici/mads-worktrees/myrepo/${agentId}`;
  check("fremder Home-Pfad wird als foreign erkannt", isForeignMadsWorktree(foreignPath, repo, agentId) === true);
  check("lokaler Kanon-Pfad ist NICHT foreign", isForeignMadsWorktree(local, repo, agentId) === false);
  check("fremder Pfad mit falschem slug ist NICHT foreign", isForeignMadsWorktree(`/Users/amedici/mads-worktrees/anders/${agentId}`, repo, agentId) === false);
  check("fremder Pfad mit falscher agentId ist NICHT foreign", isForeignMadsWorktree(`/Users/amedici/mads-worktrees/myrepo/other`, repo, agentId) === false);
  check("Nicht-mads-Pfad ist NICHT foreign", isForeignMadsWorktree(`/Users/amedici/somewhere/else/${agentId}`, repo, agentId) === false);
  check("leerer Pfad ist NICHT foreign", isForeignMadsWorktree("", repo, agentId) === false);
  check("trailing slash stört die Erkennung nicht", isForeignMadsWorktree(foreignPath + "/", repo, agentId) === true);

  // ── relocateWorktree: Cross-Machine-Reparatur (Worktree lokal WEG) ─────────
  // Kanonischen Worktree anlegen, dann Cross-Machine-Copy simulieren: gitdir auf fremdes Home biegen
  // und das Arbeitsverzeichnis entfernen (auf dem neuen Mac existiert es nie).
  g("worktree", "add", "-q", local, branch);
  check("Setup: kanonischer Worktree angelegt", existsSync(local));
  const adminDir = join(repo, ".git", "worktrees", readdirSync(join(repo, ".git", "worktrees"))[0]);
  const gitdirFile = join(adminDir, "gitdir");
  writeFileSync(gitdirFile, `/Users/amedici/mads-worktrees/myrepo/${agentId}/.git\n`); // fremdes Home
  rmSync(local, { recursive: true, force: true }); // Worktree-Verzeichnis nicht mitkopiert
  check("Setup: lokaler Worktree entfernt (foreign)", !existsSync(local));

  const res1 = await relocateWorktree(repo, agentId, branch);
  check("relocate: ok", res1.ok === true);
  check("relocate: recreated=true (neu ausgecheckt)", res1.ok === true && res1.recreated === true);
  check("relocate: liefert lokalen Kanon-Pfad", res1.ok === true && res1.path === local);
  check("relocate: lokaler Worktree existiert jetzt wieder", existsSync(local));
  check("relocate: Branch ist im lokalen Worktree ausgecheckt", g("worktree", "list", "--porcelain").includes(local));
  check("relocate: .mads/ im neuen Worktree git-unsichtbar gemacht", existsSync(join(local, ".mads", ".gitignore")));
  check("relocate: kein fremder gitdir-Zeiger mehr", !readFileSync(gitdirFile, "utf8").includes("/Users/amedici/"));

  // ── relocateWorktree: lokaler Pfad EXISTIERT bereits (~/mads-worktrees mitkopiert) ─
  const res2 = await relocateWorktree(repo, agentId, branch);
  check("relocate (vorhanden): ok", res2.ok === true);
  check("relocate (vorhanden): recreated=false (nur Admin-Link repariert)", res2.ok === true && res2.recreated === false);
  check("relocate (vorhanden): liefert lokalen Pfad", res2.ok === true && res2.path === local);

  // ── relocateWorktree: Branch fehlt lokal → nicht wiederherstellbar ─────────
  rmSync(local, { recursive: true, force: true });
  g("worktree", "prune");
  const res3 = await relocateWorktree(repo, "agent-uuid-2", "mads/does-not-exist");
  check("relocate (Branch weg): ok=false", res3.ok === false);

  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) throw new Error(`${failed} relocate test(s) failed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(base, { recursive: true, force: true });
  });
