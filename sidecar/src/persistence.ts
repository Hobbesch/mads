/**
 * P7: Agenten-Registry für Resume nach App-Neustart.
 * Liegt unter <repoRoot>/.mads/agents.json (via .mads/.gitignore selbst-ignoriert),
 * atomar geschrieben.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { ResumableAgent } from "../../shared/protocol.js";

export interface RegistryEntry extends ResumableAgent {
  updatedAt: number;
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
