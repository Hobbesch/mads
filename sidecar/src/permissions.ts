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
  /** Pro Tool-NAME freigegebene Nicht-Bash-Tools (z. B. MCP-Doku-Server). Bewusst NICHT als
   *  Kategorie: „Immer erlauben" bei einem MCP-Tool darf nicht ALLE fremden Tools freischalten. */
  approvedTools?: string[];
}

function permPath(repoRoot: string): string {
  return join(repoRoot, ".mads", "permissions.json");
}

const REMEMBERABLE = new Set<CommandKind>(REMEMBERABLE_KINDS);
/** Plausible Tool-Namen (Claude-Code- und MCP-Konvention). Schützt die Datei davor, aus injiziertem
 *  Inhalt beliebige Strings aufzunehmen. */
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/;
/** Obergrenze — verhindert unbegrenztes Wachstum durch wiederholte Freigaben. */
const MAX_TOOLS = 100;

/** Datei roh lesen (fehlend/kaputt → leeres Objekt). Basis für Merge-Speichern: sonst würde das
 *  Schreiben der einen Freigabe-Art die andere aus der Datei löschen. */
function readPermFile(repoRoot: string): PermissionsFile {
  try {
    return JSON.parse(readFileSync(permPath(repoRoot), "utf8")) as PermissionsFile;
  } catch {
    return {};
  }
}

function writePermFile(repoRoot: string, body: PermissionsFile): void {
  try {
    const p = permPath(repoRoot);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(body, null, 2) + "\n", "utf8");
  } catch (e) {
    log(`[permissions] speichern fehlgeschlagen: ${String(e)}`);
  }
}

/** Pro Tool-Name freigegebene Tools laden (unplausible Namen werden verworfen). */
export function loadApprovedTools(repoRoot: string): Set<string> {
  const out = new Set<string>();
  for (const t of readPermFile(repoRoot).approvedTools ?? []) {
    if (typeof t === "string" && TOOL_NAME_RE.test(t)) out.add(t);
    if (out.size >= MAX_TOOLS) break;
  }
  return out;
}

/** Tool-Freigaben persistieren — merge-sicher (Kategorien bleiben erhalten). */
export function saveApprovedTools(repoRoot: string, tools: Set<string>): void {
  const body = readPermFile(repoRoot);
  body.approvedTools = [...tools].filter((t) => TOOL_NAME_RE.test(t)).sort().slice(0, MAX_TOOLS);
  writePermFile(repoRoot, body);
}

/** Projektweit freigegebene Kategorien laden (unbekannte / nicht-merkbare Werte werden verworfen). */
export function loadApprovedKinds(repoRoot: string): Set<CommandKind> {
  const out = new Set<CommandKind>();
  for (const k of readPermFile(repoRoot).approvedCommandKinds ?? []) {
    // Filtert auch ALTBESTAND: `outward` (Push/PR/Merge) war früher Teil der merkbaren Kategorie
    // `git`. Wer damals „Immer erlauben (git)" klickte, hat jetzt automatisch nur noch die
    // lesenden Fernaktionen frei — Push/Merge fragen wieder. Genau so gewollt.
    if (REMEMBERABLE.has(k as CommandKind)) out.add(k as CommandKind);
  }
  return out;
}

/** Aktuelle Freigaben persistieren (best effort — Fehler werden nur geloggt). Merge-sicher. */
export function saveApprovedKinds(repoRoot: string, kinds: Set<CommandKind>): void {
  const body = readPermFile(repoRoot);
  body.approvedCommandKinds = [...kinds].filter((k) => REMEMBERABLE.has(k)).sort();
  writePermFile(repoRoot, body);
}
