/**
 * P7: Agenten-Registry für Resume nach App-Neustart.
 * Liegt unter <repoRoot>/.mads/agents.json (via .mads/.gitignore selbst-ignoriert),
 * atomar geschrieben.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { ResumableAgent, SavedPrompt } from "../../shared/protocol.js";

export interface RegistryEntry extends ResumableAgent {
  updatedAt: number;
  /**
   * „Mergen & weiterarbeiten": dieser bereits gemergte PR wird im Poll unterdrückt, damit der Stream
   * nicht als „erledigt" aus dem aktiven Grid fällt — der Mensch hat ja bewusst WEITERARBEITEN gewählt.
   * MUSS persistent sein: die Absicht lag früher nur in einer In-Memory-Map, also war sie nach einem
   * App-Neustart weg → der Poll meldete den PR wieder MERGED, und weil der Branch nach dem Merge exakt
   * auf main sitzt (ahead 0) und der Worktree sauber ist, griff isMergedDone → der Stream verschwand.
   */
  suppressedPr?: number;
}

function regPath(repoRoot: string): string {
  return join(repoRoot, ".mads", "agents.json");
}

/**
 * `<repoRoot>/.mads/` anlegen und SELBST-ignorieren (`.gitignore` = `*`). Wichtig:
 *  - mads schreibt Laufzeit-/Resume-State in das NUTZER-Repo. Ohne dieses .gitignore
 *    taucht `.mads/` als untracked in `git status` auf → (a) Gefahr, dass
 *    agents.json/Session-IDs versehentlich committet werden, (b) der Haupt-Checkout
 *    gilt als „dirty", was den Auto-fast-forward von main blockierte (siehe git.ts).
 *  `*` matcht auch die `.gitignore` selbst → der ganze Ordner ist für git unsichtbar.
 *  Idempotent: schreibt nur, wenn die Datei fehlt.
 */
export function ensureMadsDir(repoRoot: string): void {
  const dir = join(repoRoot, ".mads");
  mkdirSync(dir, { recursive: true });
  const gi = join(dir, ".gitignore");
  if (!existsSync(gi)) writeFileSync(gi, "*\n", "utf8");
}

// ─── Multi-Instanz-Projekt-Lock ──────────────────────────────────────────────
// Jede mads-Instanz startet einen EIGENEN Sidecar. Öffneten zwei Instanzen dasselbe Projekt,
// würden beide parallel `<repoRoot>/.mads/agents.json` + dieselben Worktrees schreiben → Korruption.
// Ein pid-basierter Lock in `<repoRoot>/.mads/instance.lock` verhindert das. Crash-sicher: stirbt
// eine Instanz, bleibt die Lock-Datei liegen, aber ihre pid ist tot → die nächste Instanz übernimmt.
interface LockInfo {
  pid: number;
  startedAt: string;
  host: string;
}

function lockPath(repoRoot: string): string {
  return join(repoRoot, ".mads", "instance.lock");
}

/** Läuft der Prozess mit dieser pid noch? (EPERM = lebt, gehört nur anderem User; ESRCH = tot.) */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Projekt-Lock übernehmen. Erfolg, wenn frei / von uns / verwaist (tote pid). Andernfalls
 * `{ ok:false, byPid }` — das Projekt ist in einer anderen, lebenden Instanz offen.
 */
export function acquireProjectLock(repoRoot: string, force = false): { ok: true } | { ok: false; byPid: number } {
  ensureMadsDir(repoRoot);
  const p = lockPath(repoRoot);
  const mine = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), host: hostname() } satisfies LockInfo);
  if (force) {
    // Nutzer-Override: Lock ignorieren und übernehmen (haltende Instanz hängt/pid recycelt).
    try {
      writeFileSync(p, mine, "utf8");
    } catch {
      /* best effort */
    }
    return { ok: true };
  }
  // Der atomare O_EXCL-Create ("wx") ist der Schiedsrichter: existiert die Datei bereits, prüfen
  // wir, ob eine ANDERE lebende Instanz auf DIESEM Host sie hält → ablehnen. Sonst (verwaist/uns/
  // kaputt) wegräumen und atomar neu versuchen. So gewinnt bei zwei gleichzeitig öffnenden
  // Instanzen genau EINE (statt dass beide eine nicht-atomare Überschreibung „gewinnen").
  for (let i = 0; i < 8; i++) {
    try {
      writeFileSync(p, mine, { flag: "wx" });
      return { ok: true };
    } catch {
      /* existiert bereits → prüfen */
    }
    let prev: LockInfo | null = null;
    try {
      prev = JSON.parse(readFileSync(p, "utf8")) as LockInfo;
    } catch {
      prev = null;
    }
    // Nur eine andere, lebende Instanz AUF DIESEM HOST hält gültig — pids sind host-lokal; eine
    // fremder-Host- oder recycelte pid darf nicht dauerhaft aussperren (Notausgang: force).
    if (prev && prev.pid !== process.pid && prev.host === hostname() && pidAlive(prev.pid)) {
      return { ok: false, byPid: prev.pid };
    }
    try {
      rmSync(p, { force: true }); // verwaist/uns → entfernen, dann atomar neu versuchen (Schleife)
    } catch {
      /* schon weg */
    }
  }
  return { ok: true }; // nach mehreren Versuchen: best effort
}

/** Projekt-Lock freigeben — NUR, wenn er uns gehört (fremde/verwaiste nie löschen). */
export function releaseProjectLock(repoRoot: string): void {
  try {
    const prev = JSON.parse(readFileSync(lockPath(repoRoot), "utf8")) as LockInfo;
    if (prev.pid === process.pid) rmSync(lockPath(repoRoot), { force: true });
  } catch {
    /* keine/fremde Lock → nichts tun */
  }
}

export function loadRegistry(repoRoot: string): RegistryEntry[] {
  try {
    const j = JSON.parse(readFileSync(regPath(repoRoot), "utf8"));
    return Array.isArray(j?.agents) ? (j.agents as RegistryEntry[]) : [];
  } catch {
    return [];
  }
}

export function saveRegistry(repoRoot: string, agents: RegistryEntry[]): void {
  const p = regPath(repoRoot);
  ensureMadsDir(repoRoot); // legt .mads/ an + .gitignore (selbst-ignorierend)
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: 1, agents }, null, 2), "utf8");
  renameSync(tmp, p); // atomar (write-temp + rename)
}

// ─── Gespeicherte Prompts (Prompt-Verwaltung) ───────────────────────────────
// Kuratierte, wiederverwendbare Anweisungen je Projekt (shared/protocol.ts → SavedPrompt).
// Gleiche Mechanik wie die Agenten-Registry: <repoRoot>/.mads/prompts.json, atomar
// geschrieben (tmp + rename), defensiv gelesen (kaputte/fehlende Datei → leere Liste).

function promptsPath(repoRoot: string): string {
  return join(repoRoot, ".mads", "prompts.json");
}

export function loadPrompts(repoRoot: string): SavedPrompt[] {
  try {
    const j = JSON.parse(readFileSync(promptsPath(repoRoot), "utf8"));
    return Array.isArray(j?.prompts) ? (j.prompts as SavedPrompt[]) : [];
  } catch {
    return []; // fehlend/kaputt → leere Liste (nie werfen)
  }
}

export function savePrompts(repoRoot: string, prompts: SavedPrompt[]): void {
  const p = promptsPath(repoRoot);
  ensureMadsDir(repoRoot); // legt .mads/ an + .gitignore (selbst-ignorierend)
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: 1, prompts }, null, 2), "utf8");
  renameSync(tmp, p); // atomar (write-temp + rename)
}

/**
 * REIN: Registry-Merge fürs Persistieren. `persist()` darf die Registry NICHT mit dem
 * Live-Pool überschreiben — passiv wiederhergestellte Kacheln (v.a. der **Integrator**, der
 * beim Reopen `live:false` ist und damit NICHT im Sidecar-Pool sitzt) würden sonst beim
 * nächsten Speichern rausfliegen. Subs überleben das über Worktree-Discovery, der Integrator
 * (ohne Worktree) NICHT → „main verschwindet". Daher: bestehende Einträge bewahren, den Pool
 * drüberlegen (frischer Stand gewinnt), nur explizit entfernte (`removed`) oder mit
 * verschwundenem Worktree verwerfen.
 */
export function mergeRegistry(
  existing: RegistryEntry[],
  poolEntries: RegistryEntry[],
  removed: ReadonlySet<string>,
  worktreeExists: (path: string) => boolean,
): RegistryEntry[] {
  const byId = new Map<string, RegistryEntry>();
  for (const e of existing) {
    if (removed.has(e.agentId)) continue; // gestoppt/aufgeräumt → nicht wiederbeleben
    if (e.worktreePath && !worktreeExists(e.worktreePath)) continue; // verwaister Sub → raus
    byId.set(e.agentId, e); // Integrator (kein worktreePath) bleibt IMMER erhalten
  }
  for (const e of poolEntries) {
    if (removed.has(e.agentId)) continue;
    byId.set(e.agentId, e); // Live-Stand gewinnt
  }
  return [...byId.values()];
}
