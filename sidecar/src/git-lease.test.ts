/**
 * Integration-Regression für den force-with-lease-Push (git.ts). Via `npm run test:lease`.
 *
 * Schützt gegen den „stale info"-Deadlock: Löscht das REMOTE den Branch — bei mads der Normalfall,
 * weil die GitHub-Repo-Option „automatically delete head branches" den Head-Branch beim Merge
 * wegräumt —, dann bleibt refs/remotes/origin/<branch> ohne `--prune` ewig auf dem alten Commit
 * stehen. git vergleicht diesen Leichnam als Lease-Erwartung mit „existiert nicht" und lehnt
 * DAUERHAFT mit „stale info" ab. Der eingebaute Retry lief bis dahin ins exakt gleiche Messer,
 * weil er ohne prune fetchte → „Auto-Sync gestoppt (manuell „Sync" nötig)", und der manuelle Sync
 * scheiterte identisch. Der Stream saß fest, obwohl lokal alles sauber war.
 *
 * Hermetisch: git-Config auf /dev/null, echtes git in Temp-Repos. Der Remote-Branch wird aus einem
 * ZWEITEN Klon gelöscht — nur so bleibt der Tracking-Ref im Test-Repo garantiert stale (ein
 * `push --delete` aus dem Repo selbst würde ihn lokal gleich mit aufräumen).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBranch } from "./git";

const results: string[] = [];
let failed = 0;
function check(name: string, cond: boolean): void {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
}

const root = mkdtempSync(join(tmpdir(), "mads-lease-"));
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_TERMINAL_PROMPT = "0";

const BRANCH = "mads/stream";

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env } }).toString();
}
/** git, das scheitern DARF — für die Vorbedingung (der nackte Lease-Push muss abgelehnt werden). */
function gitTry(args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: git(args) };
  } catch (e) {
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string };
    return { ok: false, out: `${String(err.stdout ?? "")}\n${String(err.stderr ?? "")}` };
  }
}
function commit(repo: string, file: string, text: string, msg: string): void {
  writeFileSync(join(repo, file), text);
  git(["-C", repo, "add", "-A"]);
  git(["-C", repo, "commit", "-qm", msg]);
}

async function main(): Promise<void> {
  const originDir = join(root, "origin.git");
  const repo = join(root, "repo");
  const other = join(root, "other");
  mkdirSync(originDir, { recursive: true });

  git(["-c", "init.defaultBranch=main", "init", "-q", "--bare", originDir]);
  git(["-c", "init.defaultBranch=main", "init", "-q", repo]);
  git(["-C", repo, "config", "user.email", "test@mads.local"]);
  git(["-C", repo, "config", "user.name", "mads test"]);
  commit(repo, "file.txt", "base\n", "init");
  git(["-C", repo, "branch", "-M", "main"]); // robust gegen master-Default
  git(["-C", repo, "remote", "add", "origin", originDir]);
  git(["-C", repo, "push", "-qu", "origin", "main"]);

  // Stream-Branch wie mads ihn anlegt: Arbeit committen und pushen (PR-Stand).
  git(["-C", repo, "checkout", "-qb", BRANCH]);
  commit(repo, "stream.txt", "erste arbeit\n", "feat: erste arbeit");
  git(["-C", repo, "push", "-qu", "origin", BRANCH]);

  // GitHub spielt Integration: PR gemergt → main bewegt sich, Head-Branch wird remote GELÖSCHT.
  git(["clone", "-q", originDir, other]);
  git(["-C", other, "config", "user.email", "test@mads.local"]);
  git(["-C", other, "config", "user.name", "mads test"]);
  git(["-C", other, "push", "-q", "origin", "--delete", BRANCH]);
  commit(other, "file.txt", "base\nvom merge\n", "merge nach main");
  git(["-C", other, "push", "-q", "origin", "main"]);

  // Der Stream arbeitet weiter (genau der Feld-Fall: „Arbeit nicht gesichert").
  commit(repo, "stream.txt", "erste arbeit\nzweite arbeit\n", "feat: zweite arbeit");

  // VORBEDINGUNG: der nackte Lease-Push MUSS hier scheitern — sonst prüft der Test nichts.
  const naked = gitTry(["-C", repo, "push", "--force-with-lease", "origin", BRANCH]);
  check("Vorbedingung: nackter force-with-lease-Push wird als stale info abgelehnt", !naked.ok && /stale info/i.test(naked.out));
  // Und auch ein Fetch OHNE prune räumt den Leichnam nicht weg (die alte Retry-Strategie).
  git(["-C", repo, "fetch", "origin"]);
  const stillStale = gitTry(["-C", repo, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${BRANCH}`]);
  check("Vorbedingung: fetch OHNE prune lässt den toten Tracking-Ref stehen", stillStale.ok);

  // DER FIX: syncBranch prunt, rebaset onto origin/main und pusht den Branch neu an.
  const res = await syncBranch(repo, BRANCH, "main");
  check("syncBranch meldet ok (kein push_rejected mehr)", res.ok === true);
  if (!res.ok) results.push(`  ↳ Fehler war: ${res.kind}: ${res.error.slice(0, 200)}`);

  const remoteSha = git(["-C", repo, "ls-remote", "--heads", "origin", BRANCH]).split(/\s+/)[0] ?? "";
  const localSha = git(["-C", repo, "rev-parse", BRANCH]).trim();
  check("Remote-Branch ist wieder da", remoteSha.length === 40);
  check("Remote zeigt exakt auf den lokalen (rebasten) Stand", remoteSha === localSha);

  // Inhaltlich: BEIDE Commits des Streams liegen auf dem Remote, der Merge-Stand von main ist drunter.
  const remoteFile = git(["-C", repo, "show", `${localSha}:stream.txt`]);
  check("die ungesicherte Arbeit ist jetzt auf dem Remote", remoteFile.includes("zweite arbeit"));
  const onMain = git(["-C", repo, "show", `${localSha}:file.txt`]);
  check("der Branch sitzt auf dem neuen main auf", onMain.includes("vom merge"));
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
      console.error(`\n${failed} lease-Test(s) fehlgeschlagen.`);
      process.exit(1);
    }
  });
