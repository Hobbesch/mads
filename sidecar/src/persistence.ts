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
