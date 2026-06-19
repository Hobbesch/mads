/**
 * P7: Agenten-Registry für Resume nach App-Neustart.
 * Liegt unter <repoRoot>/.mads/agents.json (gitignored), atomar geschrieben.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ResumableAgent } from "../../shared/protocol.js";

export interface RegistryEntry extends ResumableAgent {
  updatedAt: number;
}

function regPath(repoRoot: string): string {
  return join(repoRoot, ".mads", "agents.json");
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
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: 1, agents }, null, 2), "utf8");
  renameSync(tmp, p); // atomar (write-temp + rename)
}
