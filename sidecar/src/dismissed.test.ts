/**
 * Tests für „Stop schließt einen Stream nachhaltig". Via `npm run test:dismissed`.
 *
 * Zwei Regressionen, die zusammengehören:
 *  1. Tombstones (persistence.ts) — „Stop" merkte sich die Absicht nur flüchtig, die
 *     Entdeckungs-Quellen beim Öffnen (Worktree-Discovery, Branch-Adoption) kannten sie nicht
 *     → die Kacheln kamen nach jedem Neustart zurück.
 *  2. Der Aufräum-Doppelcheck (git.ts) — vor dem Entfernen eines Worktrees muss BEIDES gelten:
 *     nichts geht verloren (worktreeResidue) UND die Arbeit ist in <default> angekommen
 *     (branchMergedIntoDefault). Vorher wurde nur Ersteres geprüft, auf dem Session-Pfad
 *     sogar gar nichts.
 */
import { addDismissed, clearDismissed, isDismissed, loadDismissed, saveDismissed } from "./persistence";
import type { DismissedEntry } from "./persistence";
import { branchMergedIntoDefault, worktreeBranch, worktreeResidue } from "./git";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const results: string[] = [];
let failed = 0;
function check(name: string, cond: boolean): void {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
}

const peaks: DismissedEntry = { agentId: "adopted-mads-peaks-5b08c9e0", branch: "mads/peaks", label: "peaks", closedAt: 10 };

// KERN: ein gestoppter Stream wird per agentId UND per Branch erkannt — die Worktree-Discovery
// kennt nur den agentId (Verzeichnisname), die Branch-Adoption nur den Branch-Namen.
{
  const list = addDismissed([], peaks);
  check("Tombstone greift per agentId (Worktree-Discovery)", isDismissed(list, peaks.agentId));
  check("Tombstone greift per Branch (Branch-Adoption)", isDismissed(list, "anderer-id", "mads/peaks"));
  check("fremder Stream bleibt unberührt", !isDismissed(list, "sub-x", "mads/andere"));
}

// idempotent: zweimal schließen erzeugt keinen zweiten Eintrag
{
  const list = addDismissed(addDismissed([], peaks), { ...peaks, closedAt: 20 });
  check("zweimal schließen → ein Eintrag", list.length === 1 && list[0]?.closedAt === 20);
}

// Ein gleicher Branch unter NEUER agentId ersetzt den alten Tombstone (kein Zombie-Eintrag).
{
  const list = addDismissed([peaks], { agentId: "neue-id", branch: "mads/peaks", closedAt: 30 });
  check("selber Branch, neue id → ersetzt statt dupliziert", list.length === 1 && list[0]?.agentId === "neue-id");
}

// Wiederaufnahme: ein ausdrücklicher Start hebt den Tombstone per agentId ODER Branch auf.
{
  check("clear per agentId", !isDismissed(clearDismissed([peaks], peaks.agentId), peaks.agentId));
  check("clear per Branch", !isDismissed(clearDismissed([peaks], "andere-id", "mads/peaks"), peaks.agentId, "mads/peaks"));
  check("clear trifft nur den gemeinten Eintrag", clearDismissed([peaks], "sub-x", "mads/andere").length === 1);
}

// Persistenz-Roundtrip: genau das muss den App-Neustart überleben.
{
  const dir = mkdtempSync(join(tmpdir(), "mads-dismissed-"));
  try {
    check("fehlende Datei → leere Liste (nie werfen)", loadDismissed(dir).length === 0);
    saveDismissed(dir, [peaks]);
    const back = loadDismissed(dir);
    check("Roundtrip: Tombstone überlebt den Neustart", isDismissed(back, peaks.agentId, peaks.branch));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── worktreeBranch: der Branch einer NUR entdeckten Kachel ───────────────────────────────
// Die Worktree-Discovery liefert bloß Verzeichnisname + Pfad; Session und Registry-Eintrag fehlen.
// Ohne diesen Lesepfad blieb `stopBranch` beim Stoppen `undefined` → die Reste-Prüfung wurde
// übersprungen, der restlose Worktree blieb liegen und die Discovery bot ihn erneut an.
// Hermetisch: git-Config auf /dev/null, echtes Repo im Temp-Verzeichnis. Braucht `git` im PATH.
{
  const base = mkdtempSync(join(tmpdir(), "mads-wtbranch-"));
  const env = {
    ...process.env,
    HOME: base,
    USERPROFILE: base,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const repo = join(base, "repo");
  const g = (args: string[], cwd = repo): string => execFileSync("git", args, { cwd, encoding: "utf8", env }).toString();
  try {
    execFileSync("git", ["init", "-q", "-b", "main", repo], { cwd: base, encoding: "utf8", env });
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "T"]);
    writeFileSync(join(repo, "a.txt"), "eins\n");
    g(["add", "-A"]);
    g(["commit", "-qm", "init"]);

    // Kachel-Fall: Worktree steht auf seinem Branch → Branch muss ablesbar sein.
    const wt = join(base, "adopted-mads-peaks-5b08c9e0");
    g(["worktree", "add", "-q", "-b", "mads/peaks", wt]);
    check("worktreeBranch liest den Branch einer entdeckten Kachel", (await worktreeBranch(wt)) === "mads/peaks");

    // Detached HEAD → kein Branch feststellbar. Muss `undefined` liefern, damit der Aufrufer
    // auf der sicheren Seite bleibt und den Worktree NICHT löscht.
    const det = join(base, "detached");
    g(["worktree", "add", "-q", "--detach", det]);
    check("detached HEAD → undefined (Aufrufer löscht nicht)", (await worktreeBranch(det)) === undefined);

    // Zusammenspiel: aus dem abgelesenen Branch entsteht ein Tombstone, der BEIDE Quellen
    // abdeckt — Worktree-Discovery (agentId) und Branch-Adoption (Branch).
    const br = await worktreeBranch(wt);
    const tomb = addDismissed([], { agentId: "adopted-mads-peaks-5b08c9e0", ...(br ? { branch: br } : {}), closedAt: 1 });
    check("abgelesener Branch landet im Tombstone", isDismissed(tomb, "irgendwas", "mads/peaks"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// ── Aufräum-Doppelcheck: darf der Worktree beim Stop weg? ────────────────────────────────
// Echtes Repo mit echtem „origin", damit origin/main und die drei Merge-Zustände real sind.
{
  const base = mkdtempSync(join(tmpdir(), "mads-retire-"));
  const env = {
    ...process.env,
    HOME: base,
    USERPROFILE: base,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const origin = join(base, "origin.git");
  const repo = join(base, "repo");
  const g = (args: string[], cwd = repo): string => execFileSync("git", args, { cwd, encoding: "utf8", env }).toString();
  const commit = (file: string, body: string, msg: string): void => {
    writeFileSync(join(repo, file), body);
    g(["add", "-A"]);
    g(["commit", "-qm", msg]);
  };
  try {
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { cwd: base, encoding: "utf8", env });
    execFileSync("git", ["clone", "-q", origin, repo], { cwd: base, encoding: "utf8", env });
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "T"]);
    commit("a.txt", "eins\n", "init");
    g(["push", "-q", "-u", "origin", "main"]);

    // (a) klassisch gemergt: die Branch-Spitze steckt in der Historie von origin/main.
    g(["checkout", "-q", "-b", "mads/ff"]);
    commit("ff.txt", "ff\n", "feat: ff");
    g(["checkout", "-q", "main"]);
    g(["merge", "-q", "--ff-only", "mads/ff"]);
    g(["push", "-q", "origin", "main"]);
    check("gemergt (Historie) → ancestor", (await branchMergedIntoDefault(repo, "mads/ff", "main")) === "ancestor");

    // (b) squash-gemergt: NEUE Commit-ID in main, identischer Inhalt. Der häufigste Fall nach
    //     einem GitHub-Merge — und genau der, den eine reine Vorfahren-Prüfung verfehlt.
    g(["checkout", "-q", "-b", "mads/squash"]);
    commit("sq.txt", "squash\n", "feat: squash (Branch-Fassung)");
    g(["checkout", "-q", "main"]);
    writeFileSync(join(repo, "sq.txt"), "squash\n");
    g(["add", "-A"]);
    g(["commit", "-qm", "feat: squash (main-Fassung, andere ID)"]);
    g(["push", "-q", "origin", "main"]);
    check("squash-gemergt → content (nicht ancestor)", (await branchMergedIntoDefault(repo, "mads/squash", "main")) === "content");

    // (c) offen: echte eigene Arbeit, nirgends in main → NICHT löschen.
    g(["checkout", "-q", "-b", "mads/offen"]);
    commit("offen.txt", "offen\n", "feat: noch nicht gemergt");
    check("ungemergt → false (Worktree bleibt)", (await branchMergedIntoDefault(repo, "mads/offen", "main")) === false);

    // fail-closed: unbekannte Basis darf NIE „gemergt" behaupten.
    check("unbekannte Basis → false (fail-closed)", (await branchMergedIntoDefault(repo, "mads/ff", "gibtsnicht")) === false);

    // DER Fall aus der Praxis: GitHub löscht den Head-Branch beim Merge. `origin/mads/ff` existiert
    // also gar nicht — eine „ist alles gepusht?"-Prüfung meldete hier „liegt ausschließlich hier"
    // und hätte ausgerechnet den fertigen Worktree für immer blockiert.
    check("gemergt, Branch auf origin gelöscht → Reste-Messung ist unbrauchbar", (await worktreeResidue(repo, "mads/ff")).unpushed === Number.MAX_SAFE_INTEGER);
    check("…Tor 2 urteilt trotzdem korrekt: gemergt", (await branchMergedIntoDefault(repo, "mads/ff", "main")) !== false);

    // Ein gemergter Branch, der DANACH neue Arbeit bekommt, muss wieder blockieren: Tor 2 prüft
    // den lokalen Branch, der neue Commit steckt nicht in main.
    const wt = join(base, "adopted-mads-ff");
    g(["worktree", "add", "-q", wt, "mads/ff"]);
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: wt, encoding: "utf8", env });
    execFileSync("git", ["config", "user.name", "T"], { cwd: wt, encoding: "utf8", env });
    check("frisch gemergter Worktree → löschbar", (await branchMergedIntoDefault(repo, "mads/ff", "main")) !== false);
    writeFileSync(join(wt, "neu.txt"), "frisch\n");
    execFileSync("git", ["add", "-A"], { cwd: wt, encoding: "utf8", env });
    execFileSync("git", ["commit", "-qm", "frische Arbeit nach dem Merge"], { cwd: wt, encoding: "utf8", env });
    check("gemergt, dann neuer Commit → Tor 2 schließt wieder", (await branchMergedIntoDefault(repo, "mads/ff", "main")) === false);

    // Ungespeichertes steckt in keinem Commit — Tor 1 muss es sehen, auch wenn Tor 2 offen wäre.
    g(["checkout", "-q", "main"]);
    writeFileSync(join(repo, "a.txt"), "verändert, nie committet\n");
    check("ungespeicherte Änderung → Tor 1 schließt", (await worktreeResidue(repo, "main")).dirty);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

// eslint-disable-next-line no-console
console.log(results.join("\n"));
if (failed > 0) {
  // eslint-disable-next-line no-console
  console.error(`\n${failed} dismissed-Test(s) fehlgeschlagen.`);
  process.exit(1);
}
