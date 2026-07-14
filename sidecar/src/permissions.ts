/**
 * Projektweite „Immer erlauben"-Freigaben für Bash-Kategorien (näher an Claude Code).
 *
 * Klickt der Nutzer im Permission-Dialog „Immer erlauben", merkt mads die KATEGORIE des Befehls
 * (network/pkg/secret/git/write — NIE das destruktive `danger`) für das ganze Projekt. Persistent in
 * `<repoRoot>/.mads/permissions.json`, damit die Freigabe App-Neustarts überlebt. `.mads/` ist
 * git-invisible (`.mads/.gitignore` = `*`) → die Freigabe wird nie committet.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { REMEMBERABLE_KINDS, type CommandKind } from "../../shared/safe-command.js";
import { log } from "./io.js";

interface PermissionsFile {
  approvedCommandKinds?: string[];
}

function permPath(repoRoot: string): string {
  return join(repoRoot, ".mads", "permissions.json");
}

const REMEMBERABLE = new Set<CommandKind>(REMEMBERABLE_KINDS);

/** Projektweit freigegebene Kategorien laden (unbekannte / nicht-merkbare Werte werden verworfen). */
export function loadApprovedKinds(repoRoot: string): Set<CommandKind> {
  const out = new Set<CommandKind>();
  try {
    const obj = JSON.parse(readFileSync(permPath(repoRoot), "utf8")) as PermissionsFile;
    for (const k of obj.approvedCommandKinds ?? []) {
      if (REMEMBERABLE.has(k as CommandKind)) out.add(k as CommandKind);
    }
  } catch {
    /* keine/kaputte Datei → keine Freigaben */
  }
  return out;
}

/** Aktuelle Freigaben persistieren (best effort — Fehler werden nur geloggt). */
export function saveApprovedKinds(repoRoot: string, kinds: Set<CommandKind>): void {
  try {
    const p = permPath(repoRoot);
    mkdirSync(dirname(p), { recursive: true });
    const body: PermissionsFile = { approvedCommandKinds: [...kinds].filter((k) => REMEMBERABLE.has(k)).sort() };
    writeFileSync(p, JSON.stringify(body, null, 2) + "\n", "utf8");
  } catch (e) {
    log(`[permissions] speichern fehlgeschlagen: ${String(e)}`);
  }
}
