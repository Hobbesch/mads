import { parseCwdPids, isSafeCleanupRoot } from "./worktree-procs.js";

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

const WT = "/Users/x/mads-worktrees/Repo/agent-1";
// Reales lsof-Format: p<pid> / fcwd / n<pfad>
const OUT = [
  "p100", "fcwd", "n/",
  "p200", "fcwd", `n${WT}`,
  "p201", "fcwd", `n${WT}/client`,
  "p202", "fcwd", `n${WT}/server/BoBaAppBe`,
  "p300", "fcwd", "n/Users/x/mads-worktrees/Repo/agent-10", // Geschwister mit gleichem Präfix!
  "p301", "fcwd", "n/Users/x/coding/Repo",
  "p302", "fcwd", "n/Users/x",
].join("\n");

const pids = parseCwdPids(OUT, WT);
check("findet Prozesse IM Worktree (inkl. Unterordner)", pids.includes(200) && pids.includes(201) && pids.includes(202));
check(
  "PRÄFIX-FALLE: agent-10 wird NICHT mitgenommen, wenn agent-1 gemeint ist",
  !pids.includes(300),
);
check("Haupt-Repo bleibt unangetastet", !pids.includes(301));
check("Home bleibt unangetastet", !pids.includes(302));
check("Wurzel / bleibt unangetastet", !pids.includes(100));
check("exakt 3 Treffer", pids.length === 3);
check("Trailing-Slash im Worktree-Pfad ändert nichts", parseCwdPids(OUT, WT + "/").length === 3);
check("leere Ausgabe → keine PIDs", parseCwdPids("", WT).length === 0);
check("kaputte Ausgabe → keine PIDs", parseCwdPids("pXYZ\nnfoo", WT).length === 0);
check("Dublette wird entfernt", parseCwdPids(`p200\nfcwd\nn${WT}\np200\nfcwd\nn${WT}/x`, WT).length === 1);

// --- Schutzgitter gegen zu breite Aufräum-Wurzeln --------------------------
check("gültiger Worktree-Pfad ist erlaubt", isSafeCleanupRoot(WT));
check("Wurzel / abgelehnt", !isSafeCleanupRoot("/"));
check("Home (/Users/x) abgelehnt — zu breit", !isSafeCleanupRoot("/Users/x"));
check("/etc abgelehnt", !isSafeCleanupRoot("/etc"));
check("/tmp abgelehnt", !isSafeCleanupRoot("/tmp"));
check("relativer Pfad abgelehnt", !isSafeCleanupRoot("mads-worktrees/Repo/a"));
check("leer/undefined abgelehnt", !isSafeCleanupRoot("") && !isSafeCleanupRoot(undefined));

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} worktree-procs test(s) failed`);
