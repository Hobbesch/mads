// Test für die Cross-Machine-Übernahme aktiver origin-Branches (git.ts):
// agentIdForBranch, looksLikeBotAuthor, discoverAdoptableBranches, adoptRemoteBranch.
//
// Szenario: ein Stream wurde auf einem ZWEITEN Mac angelegt und gepusht. Hier existiert weder
// Registry-Eintrag noch Worktree — nur der Branch auf origin. Er soll gefunden und als lokaler
// Worktree ausgecheckt werden, Bot- und Fremd-Branches dagegen NICHT.
//
// Hermetisch: echtes git in einem temp-Verzeichnis (bare „remote" + Clone), HOME auf temp umgebogen
// (damit worktreePathFor nicht ins echte ~/mads-worktrees schreibt) und `gh` durch ein Stub-Skript
// im PATH ersetzt — kein Netz, kein echtes GitHub-Konto. Braucht `git` im PATH.
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync, chmodSync } from "node:fs";
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

const base = mkdtempSync(join(tmpdir(), "mads-adopt-"));
process.env.HOME = base;
process.env.USERPROFILE = base;

// ── gh-Stub: wird per PATH vor das echte gh gehängt, damit der Test nie ans Netz geht. ──
const binDir = join(base, "bin");
mkdirSync(binDir, { recursive: true });
const ghPath = join(binDir, "gh");
process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;

/** gh-Verhalten umschalten: `null` = gh schlägt fehl (offline), sonst Login + Autor-Antwort. */
function setGh(mode: null | { login: string; author: string; type: string }): void {
  const body =
    mode === null
      ? "#!/bin/sh\nexit 1\n"
      : `#!/bin/sh\ncase "$2" in\n  user) printf '%s\\n' '${mode.login}' ;;\n  *commits/*) printf '%s\\t%s\\n' '${mode.author}' '${mode.type}' ;;\n  *) exit 1 ;;\nesac\n`;
  writeFileSync(ghPath, body, "utf8");
  chmodSync(ghPath, 0o755);
}

async function main(): Promise<void> {
  const { agentIdForBranch, looksLikeBotAuthor, discoverAdoptableBranches, adoptRemoteBranch, worktreePathFor } =
    await import("./git.js");

  // ── reine Funktionen ──────────────────────────────────────────────────────
  check("agentIdForBranch ist stabil", agentIdForBranch("feat/x") === agentIdForBranch("feat/x"));
  check("agentIdForBranch trennt Slug-Kollisionen", agentIdForBranch("a/b_c") !== agentIdForBranch("a/b-c"));
  check("agentIdForBranch ist pfadsicher", /^adopted-[a-z0-9-]+$/.test(agentIdForBranch("feat/Grosse Sache!")));
  check("bot: [bot] im Namen", looksLikeBotAuthor("dependabot[bot]", "x@y", "feat/a") === true);
  check("bot: dependabot-Präfix", looksLikeBotAuthor("Mensch", "m@x", "dependabot/npm_and_yarn/foo") === true);
  check("bot: renovate-Präfix", looksLikeBotAuthor("Mensch", "m@x", "renovate/lodash") === true);
  check("kein bot: normaler Branch", looksLikeBotAuthor("Alessandro", "a@example.com", "chore/deps") === false);
  check("kein bot: 'robot' im Namen ist kein [bot]", looksLikeBotAuthor("Robot Roberts", "r@x", "feat/a") === false);

  // ── echtes Repo mit bare-„remote" aufbauen ────────────────────────────────
  const remote = join(base, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const seed = join(base, "seed");
  execFileSync("git", ["clone", "-q", remote, seed]);
  const sg = (...args: string[]): string => execFileSync("git", ["-C", seed, ...args], { encoding: "utf8" });
  sg("config", "user.email", "me@example.com");
  sg("config", "user.name", "Ich");
  sg("config", "commit.gpgsign", "false");

  const commitOn = (branch: string, file: string, author: string): void => {
    sg("checkout", "-q", "-B", branch, "main");
    writeFileSync(join(seed, file), `${file}\n`);
    sg("add", "-A");
    sg("commit", "-qm", `work on ${branch}`, `--author=${author}`);
  };

  writeFileSync(join(seed, "readme.md"), "hi\n");
  sg("add", "-A");
  sg("commit", "-qm", "init");
  sg("push", "-q", "origin", "main");

  const HUMAN = "Alessandro <alessandro.medici@power-blox.com>";
  commitOn("feat/mine", "mine.txt", HUMAN);
  commitOn("dependabot/npm_and_yarn/foo-1.2.3", "dep.txt", "dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>");
  commitOn("chore/bot-named", "bn.txt", "Helper [bot] <helper@x.y>");
  commitOn("mads-review/pr-7", "rev.txt", HUMAN);
  commitOn("feat/taken", "taken.txt", HUMAN);
  sg("checkout", "-q", "main");
  sg("branch", "-f", "feat/already-merged", "main"); // zeigt exakt auf main → ahead 0
  sg("push", "-q", "origin", "--all");

  const repo = join(base, "coding", "myrepo");
  mkdirSync(join(base, "coding"), { recursive: true });
  execFileSync("git", ["clone", "-q", remote, repo]);
  execFileSync("git", ["-C", repo, "fetch", "-q", "origin", "--prune"]);

  // ── discoverAdoptableBranches: offline (gh schlägt fehl) ───────────────────
  setGh(null);
  const found = await discoverAdoptableBranches(repo, "main", new Set(["feat/taken"]));
  const names = found.map((f) => f.branch).sort();
  check("offline: genau der eigene Branch wird gefunden", names.length === 1 && names[0] === "feat/mine");
  check("offline: ahead wird gezählt", found[0]?.ahead === 1);
  check("offline: Commit-Betreff wird mitgeliefert", found[0]?.subject === "work on feat/mine");
  check("dependabot-Branch ausgeschlossen", !names.includes("dependabot/npm_and_yarn/foo-1.2.3"));
  check("[bot]-Autor ausgeschlossen", !names.includes("chore/bot-named"));
  check("mads-review-Branch ausgeschlossen", !names.includes("mads-review/pr-7"));
  check("bereits bekannter Branch (taken) ausgeschlossen", !names.includes("feat/taken"));
  check("gemergter Branch (ahead 0) ausgeschlossen", !names.includes("feat/already-merged"));
  check("default-Branch ausgeschlossen", !names.includes("main"));

  // ── GitHub-Auflösung: fremder Account → nicht übernehmen ───────────────────
  setGh({ login: "myself", author: "someone-else", type: "User" });
  const foreign = await discoverAdoptableBranches(repo, "main", new Set());
  check("fremder GitHub-Account wird ausgeschlossen", foreign.length === 0);

  // ── GitHub-Auflösung: Bot ohne [bot] im Namen → type=Bot greift ────────────
  setGh({ login: "myself", author: "silentbot", type: "Bot" });
  const botty = await discoverAdoptableBranches(repo, "main", new Set());
  check("author.type=Bot wird ausgeschlossen", botty.length === 0);

  // ── GitHub-Auflösung: eigener Account → übernehmen ─────────────────────────
  setGh({ login: "myself", author: "myself", type: "User" });
  const mine = await discoverAdoptableBranches(repo, "main", new Set(["feat/taken"]));
  check("eigener GitHub-Account wird übernommen", mine.length === 1 && mine[0]?.branch === "feat/mine");

  // ── adoptRemoteBranch: Worktree anlegen ───────────────────────────────────
  const agentId = agentIdForBranch("feat/mine");
  const res = await adoptRemoteBranch(repo, agentId, "feat/mine");
  const wt = worktreePathFor(repo, agentId);
  check("adopt: ok", res.ok === true && res.path === wt);
  check("adopt: Worktree existiert", existsSync(wt));
  check("adopt: Branch-Inhalt ausgecheckt", existsSync(join(wt, "mine.txt")));
  check("adopt: .mads ist selbst-ignoriert", existsSync(join(wt, ".mads", ".gitignore")));
  const head = execFileSync("git", ["-C", wt, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  check("adopt: HEAD steht auf dem Branch", head === "feat/mine");
  const upstream = execFileSync("git", ["-C", wt, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
    encoding: "utf8",
  }).trim();
  check("adopt: Upstream trackt origin", upstream === "origin/feat/mine");

  // ── adoptRemoteBranch: idempotent ─────────────────────────────────────────
  const again = await adoptRemoteBranch(repo, agentId, "feat/mine");
  check("adopt: zweiter Aufruf ist ok (idempotent)", again.ok === true && again.path === wt);

  // ── übernommener Branch taucht nicht erneut als Kandidat auf ──────────────
  const after = await discoverAdoptableBranches(repo, "main", new Set(["feat/mine", "feat/taken"]));
  check("übernommener Branch wird nicht doppelt angeboten", after.length === 0);

  // ── nicht existierender Branch → sauberer Fehler statt Absturz ────────────
  const bad = await adoptRemoteBranch(repo, "adopted-nope", "feat/does-not-exist");
  check("adopt: unbekannter Branch → ok=false", bad.ok === false);

  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) throw new Error(`${failed} adopt test(s) failed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(base, { recursive: true, force: true });
  });
