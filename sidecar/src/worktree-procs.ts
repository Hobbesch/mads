/**
 * Aufräumen von Prozessen, die ein Agent in SEINEM Worktree gestartet hat.
 *
 * WARUM: mads beendet beim Stoppen eines Streams die SDK-Session und den von mads verwalteten
 * Dev-Server — aber NICHT, was der Agent selbst nebenbei gestartet hat (Repro-Server, Watcher,
 * Headless-Browser). Solche Prozesse überleben das Stream-Ende, belegen Ports und verwirren später
 * („warum antwortet da noch etwas?"). Real beobachtet: ein Vite-Repro lief 32 Minuten weiter,
 * nachdem sein Cleanup-Befehl an einer Berechtigungs-Rückfrage hängen geblieben war.
 *
 * ERKENNUNG über das Arbeitsverzeichnis: Ein Prozess, dessen `cwd` INNERHALB des Worktrees liegt,
 * gehört zu diesem Stream. Das ist präzise (fremde Streams haben eigene Worktrees) und braucht keine
 * Prozess-Namen-Heuristik, die man leicht falsch trifft.
 *
 * SICHERHEIT: Es werden ausschließlich Prozesse beendet, deren cwd unterhalb des ÜBERGEBENEN
 * Worktrees liegt. Der eigene Prozess und seine Vorfahren sind ausgenommen; unplausible Wurzeln
 * (`/`, Home, zu kurze Pfade) werden abgelehnt, damit ein fehlerhafter Aufruf nie breit killt.
 */
import { execFile } from "node:child_process";
import { log } from "./io.js";

/** lsof-Ausgabe (`-a -d cwd -F pn`) zu PIDs, deren cwd unter `dir` liegt.
 *  Format: Zeilen `p<pid>`, `fcwd`, `n<pfad>` — die `f`-Zeile wird übersprungen. */
export function parseCwdPids(lsofOutput: string, dir: string): number[] {
  const root = dir.replace(/\/+$/, "");
  if (!root) return [];
  const out: number[] = [];
  let pid: number | undefined;
  for (const line of lsofOutput.split("\n")) {
    if (line.startsWith("p")) {
      const n = Number(line.slice(1));
      pid = Number.isInteger(n) && n > 0 ? n : undefined;
    } else if (line.startsWith("n") && pid !== undefined) {
      const p = line.slice(1);
      // Exakt der Worktree oder ein Unterverzeichnis — NICHT ein Geschwisterpfad mit gleichem Präfix
      // (`…/agent-1` darf `…/agent-10` nicht mitnehmen).
      if (p === root || p.startsWith(root + "/")) out.push(pid);
      pid = undefined;
    }
  }
  return [...new Set(out)];
}

/**
 * Ist dieser Pfad als Aufräum-Wurzel plausibel? Schutz gegen einen leeren/kaputten Worktree-Pfad,
 * der sonst „alle Prozesse unter / " bedeuten würde. Verlangt absolut, ausreichend tief und keine
 * bekannte System-/Home-Wurzel.
 */
export function isSafeCleanupRoot(dir: string | undefined): boolean {
  if (!dir || !dir.startsWith("/")) return false;
  const parts = dir.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length < 3) return false; // /Users/x ist zu breit; /Users/x/mads-worktrees/… ist ok
  if (/^\/(?:|etc|usr|bin|sbin|var|tmp|opt|System|Library|Applications)$/.test(dir)) return false;
  return true;
}

/** Vorfahren-Kette des eigenen Prozesses (die darf nie beendet werden). */
async function ownAncestry(): Promise<Set<number>> {
  const out = new Set<number>([process.pid]);
  let cur = process.pid;
  for (let i = 0; i < 12; i++) {
    const ppid = await new Promise<number>((resolve) => {
      execFile("ps", ["-p", String(cur), "-o", "ppid="], { timeout: 2000 }, (_e, stdout) => {
        const n = Number((stdout || "").trim());
        resolve(Number.isInteger(n) && n > 0 ? n : 0);
      });
    });
    if (!ppid || ppid === 1 || out.has(ppid)) break;
    out.add(ppid);
    cur = ppid;
  }
  return out;
}

function lsofCwd(): Promise<string> {
  return new Promise((resolve) => {
    execFile("lsof", ["-a", "-d", "cwd", "-F", "pn"], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (_e, stdout) =>
      resolve(stdout || ""),
    );
  });
}

/**
 * Beendet alle Prozesse, deren Arbeitsverzeichnis im Worktree liegt (erst SIGTERM, dann SIGKILL für
 * Überlebende). Liefert die tatsächlich signalisierten PIDs — best effort, wirft nie.
 * MUSS aufgerufen werden, NACHDEM die SDK-Session beendet ist (deren CLI-Prozess läuft ebenfalls mit
 * cwd = Worktree) und BEVOR der Worktree entfernt wird (danach ist das cwd nicht mehr auflösbar).
 */
export async function killProcessesInWorktree(worktree: string | undefined): Promise<number[]> {
  if (!isSafeCleanupRoot(worktree)) return [];
  try {
    const pids = parseCwdPids(await lsofCwd(), worktree!);
    if (!pids.length) return [];
    const protectedPids = await ownAncestry();
    const targets = pids.filter((p) => p !== 1 && !protectedPids.has(p));
    if (!targets.length) return [];
    for (const pid of targets) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* schon weg */
      }
    }
    await new Promise((r) => setTimeout(r, 900));
    for (const pid of targets) {
      try {
        process.kill(pid, 0); // lebt noch?
        process.kill(pid, "SIGKILL");
      } catch {
        /* beendet */
      }
    }
    log(`[worktree-procs] ${targets.length} Agenten-Prozess(e) im Worktree beendet: ${targets.join(", ")}`);
    return targets;
  } catch (e) {
    log(`[worktree-procs] Aufräumen fehlgeschlagen: ${String(e)}`);
    return [];
  }
}
