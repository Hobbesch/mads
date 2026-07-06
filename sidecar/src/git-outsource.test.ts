/**
 * Integration-Regression für outsourceMainChanges (git.ts). Via `npm run test:outsource`.
 *
 * Schützt gegen den doppelt-gejointen Worktree-Pfad-Bug: outsourceMainChanges MUSS den von
 * createWorktree zurückgegebenen (genau EINMAL via worktreePathFor gejointen) Pfad fürs
 * `git stash apply` verwenden. Vorher wurde ein bereits absoluter Pfad an createWorktree
 * durchgereicht und dort ERNEUT gejoint → git legte den Worktree an
 * ~/mads-worktrees/<slug>/<absoluter-pfad> an, während das apply gegen den Originalpfad (der
 * gar kein Worktree ist) lief → apply schlug fehl → fälschlich {conflicted:true} + ein
 * verwaister, mangled Worktree blieb zurück.
 *
 * Hermetisch: HOME (das worktreePathFor via os.homedir() nutzt) und git-Config auf ein
 * Temp-Verzeichnis umgebogen, echtes git in Temp-Repos (bare origin + main-Checkout).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outsourceMainChanges, worktreePathFor } from "./git";

const results: string[] = [];
let failed = 0;
function check(name: string, cond: boolean): void {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
}

// HOME + git-Config isolieren (worktreePathFor liest os.homedir() → $HOME auf POSIX; git ohne
// globale/System-Config, damit z. B. commit.gpgsign/hooks den Test nicht stören).
const root = mkdtempSync(join(tmpdir(), "mads-outsource-"));
const home = join(root, "home");
mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_TERMINAL_PROMPT = "0";

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env } }).toString();
}

async function main(): Promise<void> {
  const originDir = join(root, "origin.git");
  const repoRoot = join(root, "repo");
  mkdirSync(originDir, { recursive: true });

  git(["-c", "init.defaultBranch=main", "init", "--bare", originDir]);
  git(["-c", "init.defaultBranch=main", "init", repoRoot]);
  git(["-C", repoRoot, "config", "user.email", "test@mads.local"]);
  git(["-C", repoRoot, "config", "user.name", "mads test"]);
  writeFileSync(join(repoRoot, "file.txt"), "base\n");
  git(["-C", repoRoot, "add", "-A"]);
  git(["-C", repoRoot, "commit", "-m", "init"]);
  git(["-C", repoRoot, "branch", "-M", "main"]); // robust gegen master-Default (init.defaultBranch greift nicht überall)
  git(["-C", repoRoot, "remote", "add", "origin", originDir]);
  git(["-C", repoRoot, "push", "-u", "origin", "main"]);

  // Uncommittete Änderungen im Main-Checkout: getrackte Modifikation + eine untracked Datei.
  writeFileSync(join(repoRoot, "file.txt"), "base\nlocal edit\n");
  writeFileSync(join(repoRoot, "new.txt"), "brand new\n");

  const agentId = "agent-outsrc";
  const branch = "sub/outsrc";
  const res = await outsourceMainChanges(repoRoot, "main", agentId, branch);

  check("outsource meldet ok", res.ok === true);
  if (!res.ok) {
    console.error(`outsource fehlgeschlagen: ${res.error}`);
    return; // finally berichtet + exit(1)
  }
  check("nicht fälschlich conflicted", res.conflicted === false);

  const expected = worktreePathFor(repoRoot, agentId);
  check("Worktree-Pfad = kanonischer (einmal gejointer) Pfad", res.worktreePath === expected);
  check("Pfad enthält 'mads-worktrees' genau einmal (kein Doppel-Join)", res.worktreePath.split("mads-worktrees").length === 2);
  check("Worktree existiert am gemeldeten Pfad", existsSync(res.worktreePath));

  // Der mangled Pfad-in-Pfad (worktreePathFor auf einen bereits absoluten Pfad) darf NICHT existieren.
  const mangled = worktreePathFor(repoRoot, expected);
  check("mangled Pfad-in-Pfad wurde NICHT angelegt", !existsSync(mangled));

  // Kernaussage: die Änderungen liegen wirklich IM Worktree (Stash sauber appliziert), nicht verloren.
  check(
    "getrackte Änderung ist im Worktree",
    existsSync(join(res.worktreePath, "file.txt")) && readFileSync(join(res.worktreePath, "file.txt"), "utf8").includes("local edit"),
  );
  check("untracked Datei ist im Worktree", existsSync(join(res.worktreePath, "new.txt")));

  // Main-Checkout bleibt sauber (Inv. 1/2); bei sauberem Apply wird der Stash gedroppt.
  check("Main-Checkout ist sauber", git(["-C", repoRoot, "status", "--porcelain"]).trim() === "");
  check("Stash nach sauberem Apply gedroppt", git(["-C", repoRoot, "stash", "list"]).trim() === "");
}

main()
  .catch((e) => {
    check("keine unerwartete Exception", false);
    console.error(String(e));
  })
  .finally(() => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* Temp-Aufräumen best effort */
    }
    // eslint-disable-next-line no-console
    console.log(results.join("\n"));
    if (failed > 0) {
      // eslint-disable-next-line no-console
      console.error(`\n${failed} outsource-Test(s) fehlgeschlagen.`);
      process.exit(1);
    }
  });
