/**
 * Auto-Freigabe-Klassifizierer für den "Auto"-Permission-Modus (Policy: "Lesen +
 * Datei-Änderungen"). Entscheidet im mads-`canUseTool`, ob ein Tool-Aufruf ohne
 * Rückfrage erlaubt wird oder dem Nutzer vorgelegt werden muss.
 *
 * Leitlinie (mads-Invariante 4): nur-lesende UND datei-ändernde Aktionen im Arbeits-
 * baum laufen ohne Nachfrage; alles **außen-sichtbare oder destruktive** (push, PR,
 * löschen, installieren, Netzwerk, sudo, …) wird IMMER gefragt. Im Zweifel: fragen.
 *
 * Sicherheitskritisch — siehe safe-command.test.ts. Default ist "ask"; "allow" nur,
 * wenn die Aktion eindeutig als harmlos erkannt wurde.
 */

export type AutoDecision = { decision: "allow" | "ask"; reason?: string };

const ASK = (reason: string): AutoDecision => ({ decision: "ask", reason });
const ALLOW: AutoDecision = { decision: "allow" };

// Tools, die nur lesen → immer auto-erlaubt.
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead", "TodoWrite"]);
// Tools, die Dateien (im Worktree) ändern → auto-erlaubt, sofern Pfad sicher.
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

// Befehle in Kommando-Position, die als harmlos gelten (lesen ODER lokale Datei-Op).
const SAFE_CMDS = new Set([
  // lesen / inspizieren
  "ls", "cat", "bat", "head", "tail", "grep", "egrep", "fgrep", "rg", "find", "fd",
  "wc", "echo", "printf", "pwd", "cd", "which", "type", "file", "tree", "sort", "uniq",
  "cut", "tr", "column", "awk", "sed", "jq", "yq", "diff", "comm", "stat", "du", "df",
  "date", "env", "printenv", "basename", "dirname", "realpath", "readlink", "hostname",
  "whoami", "uname", "true", "false", "test", "[", "[[", "tldr", "man",
  // Shell-Builtins zur Variablen-/Existenz-Prüfung (harmlos; gefährliche Args fängt DANGER)
  "command", "export", "local", "declare", "readonly", "typeset", "unset",
  // lokale Datei-Op (Policy erlaubt Datei-Änderungen)
  "mkdir", "touch", "mv", "cp",
  // git: nur erlaubt zusammen mit erlaubtem Subcommand (siehe classifyGit)
  "git",
  // Shell-Konstrukte (Kommando-Position, harmlos)
  "for", "do", "done", "in", "if", "then", "else", "elif", "fi", "while", "until",
  "case", "esac", "time", "set",
]);

// Eindeutig riskante Tokens irgendwo im Befehl → immer fragen.
const DANGER = [
  { re: /(^|[\s;&|(])sudo(\s|$)/, why: "läuft mit sudo" },
  { re: /(^|[\s;&|(])(rm|rmdir|shred|unlink)(\s|$)/, why: "löscht Dateien (rm)" },
  { re: /(^|[\s;&|(])(chmod|chown|chgrp)(\s|$)/, why: "ändert Dateirechte" },
  { re: /(^|[\s;&|(])(kill|killall|pkill|shutdown|reboot|halt)(\s|$)/, why: "beendet Prozesse / fährt herunter" },
  { re: /(^|[\s;&|(])(dd|mkfs|diskutil|fdisk)(\s|$)/, why: "Datenträger-/Low-Level-Operation" },
  { re: /(^|[\s;&|(])(curl|wget|nc|ncat|telnet|ssh|scp|sftp|rsync|ftp)(\s|$)/, why: "Netzwerkzugriff" },
  { re: /(^|[\s;&|(])(brew|apt|apt-get|yum|dnf|port|docker|podman|launchctl|crontab|systemctl)(\s|$)/, why: "System-/Paket-/Dienst-Verwaltung" },
  { re: /(^|[\s;&|(])(npm|pnpm|yarn|bun|npx|pip|pip3|gem|cargo|go)(\s|$)/, why: "Paketmanager/Build (kann Skripte ausführen oder ins Netz gehen)" },
  { re: /(^|[\s;&|(])(eval|exec|source|\.)(\s|$)/, why: "führt dynamisch Code aus (eval/exec/source)" },
  { re: /(^|[\s;&|(])(osascript|defaults|open|pbcopy|pbpaste)(\s|$)/, why: "greift auf macOS-Systemfunktionen zu" },
  { re: /(^|[\s;&|(])gh(\s|$)/, why: "GitHub-CLI (außen-sichtbar: PR/Issue/API)" },
  { re: /:\s*\(\s*\)\s*\{/, why: "verdächtiges Shell-Muster (Fork-Bomb)" },
];

// git-Subcommands, die destruktiv/außen-sichtbar sind → fragen. Lese-Subcommands
// (z.B. `worktree list`, `remote -v`, `submodule status`) sind NICHT riskant.
const GIT_RISKY =
  /\bgit\s+(?:-[^\s]+\s+)*(push|rm|reset|clean|checkout|restore|merge|rebase|cherry-pick|revert|filter-branch|update-ref|gc|fetch|pull|remote\s+(?:add|remove|rm|set-url|rename|prune)|submodule\s+(?:add|update|deinit|sync|set-url|set-branch)|worktree\s+(?:add|remove|move|prune)|tag\b(?!\s+-l)|config\s+--global)/;

function hasWriteRedirect(cmd: string): boolean {
  // Quotes zuerst maskieren — ein > in 'text' oder "code" ist KEIN Redirect.
  // erlaubt: >/dev/null, 2>/dev/null, 2>&1, >&2 — alles andere ist ein Schreib-Redirect.
  const cleaned = cmd
    .replace(/'[^']*'/g, " ")
    .replace(/"[^"]*"/g, " ")
    .replace(/\d?>>?\s*\/dev\/null/g, " ")
    .replace(/\d?>&\d/g, " ")
    .replace(/&>\s*\/dev\/null/g, " ");
  return /(^|[^\d&])>>?/.test(cleaned);
}

function classifyGit(cmd: string): AutoDecision | null {
  if (!/\bgit\b/.test(cmd)) return null;
  if (GIT_RISKY.test(cmd)) {
    const m = cmd.match(GIT_RISKY);
    return ASK(`git-Operation „${m?.[1] ?? "?"}“ — außen-sichtbar oder verändernd`);
  }
  return null; // git mit harmlosem Subcommand (log/status/diff/add/commit/…) → weiter prüfen
}

// Führende Shell-Keywords, die KEINE Kommandos sind (das eigentliche Kommando folgt).
const LEADING_SKIP = new Set([
  "do", "then", "else", "elif", "time", "!", "{", "}", "(", ")", "while", "until",
  "if", "done", "fi", "esac",
]);
// Segment-Köpfe ohne ausführbares Kommando (Loop-/case-Header; Body steht in `do`-Segmenten).
const SEGMENT_HEAD_NOCMD = new Set(["for", "select", "case", "in"]);

/** Kommando-Wörter aus einer (ggf. zusammengesetzten) Bash-Zeile extrahieren. */
function commandWords(cmd: string): string[] {
  // 1) Quoted-Strings entfernen (enthalten ggf. Operatoren wie | die keine sind).
  // 2) Kommando-Substitution öffnen, damit innere Kommandos mitgeprüft werden.
  const s = cmd
    .replace(/'[^']*'/g, " ")
    .replace(/"[^"]*"/g, " ")
    .replace(/`/g, " ")
    .replace(/\$\(/g, " ")
    .replace(/[()]/g, " ; ");
  const segments = s.split(/(?:\|\||&&|\||;|\n)+/);
  const words: string[] = [];
  for (const seg of segments) {
    const toks = seg.trim().split(/\s+/).filter(Boolean);
    if (toks.length === 0) continue;
    if (SEGMENT_HEAD_NOCMD.has(toks[0])) continue; // z.B. `for n in 0063 0064` → kein Kommando
    let i = 0;
    while (i < toks.length && (LEADING_SKIP.has(toks[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]))) i++;
    if (i < toks.length) words.push(toks[i]);
  }
  return words;
}

export function classifyBashCommand(command: string): AutoDecision {
  const cmd = command.trim();
  if (!cmd) return ASK("leerer Befehl");

  for (const d of DANGER) if (d.re.test(cmd)) return ASK(d.why);
  if (hasWriteRedirect(cmd)) return ASK("schreibt per Umleitung (>) in eine Datei");

  const git = classifyGit(cmd);
  if (git) return git;

  const words = commandWords(cmd);
  if (words.length === 0) return ASK("Befehl nicht eindeutig");
  for (const w of words) {
    if (!SAFE_CMDS.has(w)) return ASK(`enthält nicht-eingestuften Befehl „${w}“`);
  }
  return ALLOW;
}

function pathUnsafe(p: string | undefined, cwd?: string): string | null {
  if (typeof p !== "string" || !p) return "kein Pfad angegeben";
  if (/(^|\/)\.(git|ssh|aws|gnupg)(\/|$)/.test(p)) return "geschützter Ordner";
  if (/(^|\/)(\.env(\.|$)|\.npmrc$|\.mcp\.json$|\.netrc$|id_rsa)/.test(p)) return "geschützte Datei";
  if (p.startsWith("/")) {
    if (cwd && (p === cwd || p.startsWith(cwd.endsWith("/") ? cwd : cwd + "/"))) return null;
    return "Pfad außerhalb des Arbeitsverzeichnisses";
  }
  if (p.split("/").includes("..")) return "Pfad verlässt das Arbeitsverzeichnis (..)";
  return null;
}

/**
 * Zentrale Policy: darf dieser Tool-Aufruf im "Auto"-Modus ohne Rückfrage laufen?
 */
export function classifyToolCall(
  toolName: string,
  input: Record<string, unknown> | undefined,
  ctx: { cwd?: string } = {},
): AutoDecision {
  if (toolName === "AskUserQuestion") return ASK("Rückfrage des Agenten");
  if (READ_TOOLS.has(toolName)) return ALLOW;

  if (EDIT_TOOLS.has(toolName)) {
    const p = (input?.file_path ?? input?.notebook_path ?? input?.path) as string | undefined;
    const bad = pathUnsafe(p, ctx.cwd);
    return bad ? ASK(`Datei-Schreibzugriff: ${bad}`) : ALLOW;
  }

  if (toolName === "Bash") {
    const c = (input?.command ?? "") as string;
    return classifyBashCommand(c);
  }

  // MCP-Tools, WebFetch/WebSearch, Task, Unbekanntes → fragen.
  if (toolName === "WebFetch" || toolName === "WebSearch") return ASK("Netzwerkzugriff");
  return ASK(`Tool „${toolName}“ nicht als auto-sicher eingestuft`);
}
