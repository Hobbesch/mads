/**
 * Regression für die „Zombie-Branches" auf origin (git.ts). Via `npm run test:zombie`.
 *
 * Befund (Boba, 2026-09-10, GitHub Hobbesch/Boba): 28 Branches unter origin/mads/*, deren Inhalt
 * vollständig in main lag. Ihre Spitzen waren keine Feature-Commits, sondern Commits aus main
 * selbst — zwei verschiedene Branches zeigten auf denselben main-Commit.
 *
 * Mechanismus: Nach „Mergen & weiterarbeiten" (doIntegrate mit keepBranch) setzt
 * resyncWorktreeAfterMerge() den Branch auf origin/<default> zurück. GitHub hat den Head-Branch
 * beim Merge im selben Moment selbst gelöscht (Repo-Option „delete_branch_on_merge"). Der nächste
 * Auto-Sync rebasete und pushte per force-with-lease — und legte den gelöschten Branch damit NEU
 * an, jetzt mit reinem main als Inhalt. Wurde der Stream danach nicht mehr benutzt, blieb diese
 * leere Hülle für immer auf origin liegen; jeder weitere Merge im selben Stream erzeugte die
 * nächste.
 *
 * Geprüft wird beides:
 *  1. der Fix — ein Branch ohne eigene Commits wird NICHT gepusht (syncBranch/pushBranch), und
 *     sobald er wieder etwas Eigenes trägt, läuft der Push wie gehabt;
 *  2. das Aufräum-Angebot für die bereits entstandenen Leichen (findMergedRemoteBranches /
 *     deleteRemoteBranches) — inklusive der Schranken: nur `mads/`-Branches, nichts mit eigener
 *     Arbeit, und eine erneute Prüfung unmittelbar vor dem Löschen.
 *
 * Hermetisch: git-Config auf /dev/null, echte git-Repos im Temp-Verzeichnis mit lokalem „origin".
 * Braucht `git` im PATH.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { branchHasOwnCommits, deleteRemoteBranches, findMergedRemoteBranches, gitStatus, pushBranch, resyncWorktreeAfterMerge, syncBranch } from "./git";

const results: string[] = [];
let failed = 0;
function check(name: string, cond: boolean): void {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
}

const root = mkdtempSync(join(tmpdir(), "mads-zombie-"));
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_TERMINAL_PROMPT = "0";

const BRANCH = "mads/stream";

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env } }).toString();
}
function commit(repo: string, file: string, text: string, msg: string): void {
  writeFileSync(join(repo, file), text);
  git(["-C", repo, "add", "-A"]);
  git(["-C", repo, "commit", "-qm", msg]);
}
/** Zeigt origin diesen Branch (dann sein SHA), oder ist er dort weg (dann "")? */
function remoteSha(repo: string, branch: string): string {
  return (git(["-C", repo, "ls-remote", "--heads", "origin", branch]).split(/\s+/)[0] ?? "").trim();
}

/**
 * Baut den Feld-Fall auf: ein Stream, dessen Arbeit gesquasht in main liegt, dessen Remote-Branch
 * GitHub beim Merge gelöscht hat und dessen Worktree per resyncWorktreeAfterMerge() auf main
 * zurückgesetzt wurde. Danach läuft main weiter (ein zweiter Merge) — der Stream ist „behind",
 * genau die Lage, in der der Auto-Sync greift.
 */
function scenario(): { repo: string; origin: string; gh: string } {
  const origin = join(root, "origin.git");
  const repo = join(root, "repo"); // der Stream-Worktree
  const gh = join(root, "gh"); // steht für die GitHub-Seite (Squash-Merge, Branch-Löschung)
  mkdirSync(origin, { recursive: true });

  git(["-c", "init.defaultBranch=main", "init", "-q", "--bare", origin]);
  git(["-c", "init.defaultBranch=main", "init", "-q", repo]);
  git(["-C", repo, "config", "user.email", "t@mads.local"]);
  git(["-C", repo, "config", "user.name", "mads test"]);
  commit(repo, "file.txt", "base\n", "init");
  git(["-C", repo, "branch", "-M", "main"]);
  git(["-C", repo, "remote", "add", "origin", origin]);
  git(["-C", repo, "push", "-qu", "origin", "main"]);

  // Stream: eigene Arbeit committen und pushen (PR-Stand).
  git(["-C", repo, "checkout", "-qb", BRANCH]);
  commit(repo, "stream.txt", "arbeit\n", "feat: arbeit");
  git(["-C", repo, "push", "-qu", "origin", BRANCH]);

  // GitHub: Squash-Merge nach main + Head-Branch löschen (delete_branch_on_merge=true).
  git(["clone", "-q", origin, gh]);
  git(["-C", gh, "config", "user.email", "t@mads.local"]);
  git(["-C", gh, "config", "user.name", "mads test"]);
  git(["-C", gh, "merge", "--squash", "-q", `origin/${BRANCH}`]);
  git(["-C", gh, "commit", "-qm", "mads: stream (#1)"]);
  git(["-C", gh, "push", "-q", "origin", "main"]);
  git(["-C", gh, "push", "-q", "origin", "--delete", BRANCH]);
  return { repo, origin, gh };
}

async function main(): Promise<void> {
  // ── Teil 1: der Mechanismus — nach „Mergen & weiterarbeiten" entsteht keine Leiche ────────
  const { repo, gh } = scenario();
  const mergedHead = git(["-C", repo, "rev-parse", `origin/${BRANCH}`]).trim(); // Stand vor dem Merge
  git(["-C", repo, "fetch", "-q", "--prune", "origin"]);

  const resync = await resyncWorktreeAfterMerge(repo, "main", mergedHead);
  check("Resync nach dem Merge setzt den Branch auf origin/main", resync.ok === true && resync.mode === "reset");
  check("Vorbedingung: origin hat den Branch beim Merge gelöscht", remoteSha(repo, BRANCH) === "");
  check("Vorbedingung: der Branch trägt jetzt nichts Eigenes", (await branchHasOwnCommits(repo, "main")) === false);
  const squashCommit = git(["-C", repo, "rev-parse", "HEAD"]).trim(); // main-Stand direkt nach dem Merge

  // main läuft weiter (ein anderer Stream landet) → dieser Stream ist behind, der Auto-Sync greift.
  commit(gh, "file.txt", "base\nvon woanders\n", "mads: anderer stream (#2)");
  git(["-C", gh, "push", "-q", "origin", "main"]);

  const sync = await syncBranch(repo, BRANCH, "main");
  check("Auto-Sync läuft durch (kein Fehler)", sync.ok === true);
  check("Auto-Sync meldet: NICHT gepusht", sync.ok === true && sync.pushed === false);
  check("DER FIX: origin hat den leeren Branch NICHT wiederbekommen", remoteSha(repo, BRANCH) === "");
  check(
    "der Worktree steht trotzdem auf frischem main",
    git(["-C", repo, "rev-parse", "HEAD"]).trim() === git(["-C", repo, "rev-parse", "origin/main"]).trim(),
  );

  // Auch der manuelle Push-Knopf legt keine leere Hülle an.
  const manual = await pushBranch(repo, BRANCH, "main");
  check("manueller Push wird übersprungen statt eine Hülle anzulegen", manual.ok === true && manual.skipped === "no_own_commits");
  check("origin bleibt nach dem manuellen Push leer", remoteSha(repo, BRANCH) === "");

  // Der unpushed-Zähler darf jetzt nicht zum Push auffordern (Grid-Badge „↑ n Commits nicht gepusht").
  const stEmpty = await gitStatus(repo, repo, BRANCH, "main");
  check("ohne Remote-Branch → unpushed undefined (kein Badge)", stEmpty.unpushed === undefined);
  check("Stream ohne eigene Commits → ahead 0, Status verlässlich", stEmpty.ahead === 0 && stEmpty.unreliable === undefined);

  // Alt-Bestand: in einem Repo, das VOR dem Fix lief, liegt die leere Hülle bereits auf origin und
  // hinkt inzwischen hinter main her. Der rohe Zähler `origin/<branch>..HEAD` wäre dann > 0 — das
  // Grid forderte mit „↑ 1 Commit nicht gepusht" auf, genau diese Hülle wieder aufzufrischen.
  git(["-C", repo, "push", "-q", "origin", `${squashCommit}:refs/heads/${BRANCH}`]);
  const stZombie = await gitStatus(repo, repo, BRANCH, "main");
  check(
    "Vorbedingung: die Hülle auf origin hinkt hinter main her",
    git(["-C", repo, "rev-list", "--count", `origin/${BRANCH}..HEAD`]).trim() === "1",
  );
  check("stehengebliebene Hülle → unpushed 0 statt Push-Aufforderung", stZombie.unpushed === 0);
  check("stehengebliebene Hülle → ahead bleibt 0", stZombie.ahead === 0);

  // ── Teil 2: sobald der Stream wieder etwas Eigenes hat, läuft der Push wie gehabt ─────────
  commit(repo, "stream.txt", "arbeit\nneue arbeit\n", "feat: neue arbeit");
  const sync2 = await syncBranch(repo, BRANCH, "main");
  check("mit eigener Arbeit → gepusht", sync2.ok === true && sync2.pushed === true);
  check("Remote-Branch ist wieder da und zeigt auf den lokalen Stand", remoteSha(repo, BRANCH) === git(["-C", repo, "rev-parse", BRANCH]).trim());
  check("die neue Arbeit liegt auf dem Remote", git(["-C", repo, "show", `${remoteSha(repo, BRANCH)}:stream.txt`]).includes("neue arbeit"));

  // ── Teil 3: Aufräum-Angebot für die bereits entstandenen Leichen ──────────────────────────
  // Drei Sorten Branch auf origin: die Leiche aus dem Vorfall (reine main-Kopie), ein
  // squash-gemergter Rest (eigene Commit-IDs, inhaltsgleich) und ein Branch mit echter Arbeit.
  git(["-C", gh, "fetch", "-q", "--prune", "origin"]);
  git(["-C", gh, "checkout", "-q", "main"]);
  git(["-C", gh, "reset", "-q", "--hard", "origin/main"]);
  git(["-C", gh, "push", "-q", "origin", "HEAD:refs/heads/mads/leiche"]); // exakt main → Zombie
  git(["-C", gh, "checkout", "-qb", "mads/gemergt"]);
  commit(gh, "extra.txt", "inhalt\n", "feat: extra");
  git(["-C", gh, "push", "-q", "origin", "mads/gemergt"]);
  git(["-C", gh, "checkout", "-q", "main"]);
  git(["-C", gh, "merge", "--squash", "-q", "mads/gemergt"]);
  git(["-C", gh, "commit", "-qm", "mads: extra (#3)"]); // Inhalt jetzt in main, Commit-IDs verschieden
  git(["-C", gh, "push", "-q", "origin", "main"]);
  git(["-C", gh, "checkout", "-qb", "mads/echt"]);
  commit(gh, "echt.txt", "ungemergt\n", "feat: echte arbeit");
  git(["-C", gh, "push", "-q", "origin", "mads/echt"]);
  git(["-C", gh, "checkout", "-q", "main"]);
  git(["-C", gh, "push", "-q", "origin", "HEAD:refs/heads/fremd/leiche"]); // NICHT von mads

  git(["-C", repo, "fetch", "-q", "--prune", "origin"]);
  const found = await findMergedRemoteBranches(repo, "main");
  const names = found.map((b) => b.branch);
  check("Angebot: die main-Kopie steht drin", names.includes("mads/leiche"));
  check("Angebot: der squash-gemergte Rest steht drin", names.includes("mads/gemergt"));
  check("Angebot: der Branch mit echter Arbeit NICHT", !names.includes("mads/echt"));
  check("Angebot: fremde (nicht-mads) Branches NICHT", !names.includes("fremd/leiche"));
  check("Angebot: der Default-Branch NICHT", !names.includes("main"));
  check(
    "Angebot: die main-Kopie ist als reiner Reset erkannt, der Squash-Rest nicht",
    found.find((b) => b.branch === "mads/leiche")?.emptyReset === true &&
      found.find((b) => b.branch === "mads/gemergt")?.emptyReset === false,
  );
  const skipped = await findMergedRemoteBranches(repo, "main", ["mads/leiche"]);
  check("Angebot: die skip-Liste (offene PRs) wird respektiert", !skipped.map((b) => b.branch).includes("mads/leiche"));

  // Löschen: erst NACH Bestätigung — und mit erneuter Prüfung unmittelbar davor. Zwischen Angebot
  // und Klick pusht der Stream hier noch Arbeit auf „mads/leiche"; die muss stehen bleiben.
  git(["-C", gh, "checkout", "-qB", "mads/leiche", "origin/mads/leiche"]);
  commit(gh, "spaet.txt", "nach dem angebot\n", "feat: kam nach dem Angebot");
  git(["-C", gh, "push", "-q", "origin", "mads/leiche"]);

  const del = await deleteRemoteBranches(repo, "main", ["mads/leiche", "mads/gemergt", "mads/echt", "fremd/leiche"]);
  check("Löschen: der squash-gemergte Rest ist weg", del.deleted.includes("mads/gemergt") && remoteSha(repo, "mads/gemergt") === "");
  check(
    "Löschen: der Branch, der zwischenzeitlich Arbeit bekam, bleibt stehen",
    !del.deleted.includes("mads/leiche") && remoteSha(repo, "mads/leiche") !== "",
  );
  check("Löschen: ungemergte Arbeit bleibt stehen", !del.deleted.includes("mads/echt") && remoteSha(repo, "mads/echt") !== "");
  check(
    "Löschen: fremde Branches werden gar nicht erst angefasst",
    !del.deleted.includes("fremd/leiche") &&
      remoteSha(repo, "fremd/leiche") !== "" &&
      del.kept.some((k) => k.branch === "fremd/leiche" && /kein mads-Branch/.test(k.reason)),
  );
  check("Löschen: jeder nicht gelöschte Branch trägt einen Grund", del.kept.every((k) => k.reason.length > 0));

  // ── Verwaiste .lock-Datei: die Remote-Sicht ist Phantom ────────────────────────────────────
  // Im Feld blockierte eine 0-Byte-Datei `refs/remotes/origin/<name>.lock` aus einem
  // abgebrochenen git-Lauf das Aufräumen der Tracking-Refs KOMPLETT: `fetch --prune` endet mit
  // Exit 1 und löscht KEINEN einzigen Ref. Das Aufräum-Angebot zählte daraufhin 38 Branches, die
  // auf GitHub längst weg waren — ein Klick lief in 38 × „remote ref does not exist".
  {
    const refExists = (r: string, ref: string): boolean => {
      try {
        return git(["-C", r, "rev-parse", "--verify", "-q", ref]).trim().length > 0;
      } catch {
        return false; // rev-parse -q endet bei fehlendem Ref mit Code 1 → execFileSync wirft
      }
    };

    // Phantom bauen: Branch auf origin anlegen, lokal holen, auf origin wieder löschen.
    git(["-C", gh, "checkout", "-qB", "mads/phantom", "main"]);
    git(["-C", gh, "push", "-q", "origin", "mads/phantom"]);
    git(["-C", repo, "fetch", "-q", "origin"]);
    git(["-C", gh, "push", "-q", "origin", "--delete", "mads/phantom"]);
    check("Aufbau: der Tracking-Ref überlebt die Löschung auf origin", refExists(repo, "origin/mads/phantom"));

    // Die verwaiste Lock-Datei, die den Prune killt.
    const lock = join(repo, ".git", "refs", "remotes", "origin", "mads", "phantom.lock");
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, "");

    // Beleg, WARUM das Angebot ein Tor braucht: die Suche liest nur lokale Refs und hält das
    // Phantom für einen Aufräum-Kandidaten. Deshalb gibt der Orchestrator das Angebot nur frei,
    // wenn der Prune davor gelungen ist.
    const phantomOffer = await findMergedRemoteBranches(repo, "main", []);
    check(
      "ohne frischen Prune gilt das Phantom als Aufräum-Kandidat (darum das Angebots-Tor)",
      phantomOffer.map((b) => b.branch).includes("mads/phantom"),
    );

    // Das Löschen selbst muss die veraltete Sicht erkennen und NICHTS anfassen.
    const blocked = await deleteRemoteBranches(repo, "main", ["mads/phantom"]);
    check("verwaiste .lock → es wird nichts gelöscht", blocked.deleted.length === 0);
    check(
      "…und jeder Branch kommt mit dem git-Fehler als Begründung zurück",
      blocked.kept.length === 1 && /nicht auffrischbar/.test(blocked.kept[0]?.reason ?? ""),
    );

    // Lock weg → Prune läuft → das Phantom ist als „auf origin nicht mehr vorhanden" erkannt,
    // ohne dass je ein `push --delete` versucht wurde.
    rmSync(lock, { force: true });
    const after = await deleteRemoteBranches(repo, "main", ["mads/phantom"]);
    check("ohne .lock: kein Löschversuch, sondern die Feststellung, dass er schon weg ist", after.deleted.length === 0 && /nicht mehr vorhanden/.test(after.kept[0]?.reason ?? ""));
    check("…und der veraltete Tracking-Ref ist jetzt weggeräumt", !refExists(repo, "origin/mads/phantom"));
  }
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
      console.error(`\n${failed} zombie-Test(s) fehlgeschlagen.`);
      process.exit(1);
    }
  });
