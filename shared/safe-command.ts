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

import { findSecrets } from "./secrets.js";

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
  // weitere nur-lesende / harmlose Textwerkzeuge (Ausgabe nur auf stdout)
  "xargs", "seq", "yes", "nl", "tac", "rev", "paste", "fold", "join", "look", "strings",
  "cmp", "xxd", "od", "hexdump", "base64", "zcat", "less", "more", "expand", "unexpand",
  "bc", "dc", // Rechner (lesen stdin, schreiben nur stdout)
  // Transparente Wrapper: führen das NÄCHSTE Token als Befehl aus. Sicher NUR, weil DANGER
  // (rm/sudo/curl/Shell/Interpreter-Inline …) ZUERST über die Rohzeile läuft — also vor der
  // Kopfprüfung greift und die gefährliche Innen-Aktion fängt. Reihenfolge nicht umstellen!
  "timeout", "nice", "stdbuf", "nohup",
  // Hashing/Checksums (lesen, schreiben nichts)
  "shasum", "md5", "md5sum", "sha1sum", "sha256sum", "sha512sum", "cksum",
  // Shell-Builtins in Kommando-Position (harmlos; gefährliche Args fängt DANGER)
  ":", "read", "continue", "break", "shift", "return", "let", "select", "getopts",
  "function", "pushd", "popd", "dirs", "trap", "wait", "alias", "unalias", "shopt",
  // Shell-Builtins zur Variablen-/Existenz-Prüfung (harmlos; gefährliche Args fängt DANGER)
  "command", "export", "local", "declare", "readonly", "typeset", "unset",
  // Projekt-Python-Dev/Test-Tooling (vom Nutzer als vertrauenswürdig gewählt; rm/Netz/
  // sudo im selben Befehl fängt weiterhin DANGER). Siehe auch isUvRunner + .venv/bin.
  "python", "python3", "pytest", "ruff", "mypy", "pyright", "black", "isort", "flake8", "pylint", "coverage",
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
  { re: /(^|[\s;&|(])(eval|exec)(\s|$)/, why: "führt dynamisch Code aus (eval/exec)" },
  // Shell starten (auch mit Pfad: /bin/sh) — `sh -c '…'` ist arbiträrer Code.
  { re: /(^|[\s;&|(])(?:[^\s|;&]*\/)?(sh|bash|zsh|ksh|dash|fish)(\s|$)/, why: "startet eine Shell (arbiträrer Code, z. B. sh -c)" },
  // Interpreter mit Inline-Code (-c/-e/-r): führt beliebigen Code aus, dessen Inhalt der
  // Token-Scan NICHT sieht (z. B. python3 -c 'import os; os.system("rm -rf …")'). python &
  // Co. sind sonst auto-erlaubt (vom Nutzer als Dev-Tooling freigegeben) — aber NICHT als
  // Inline-Code-Runner. Greift VOR der SAFE_CMDS-Kopfprüfung (DANGER läuft zuerst).
  { re: /(^|[\s;&|(])(?:[^\s|;&]*\/)?(python3?|ipython|ruby|perl|php|node|deno)\s+(?:-[A-Za-z]\S*\s+)*-(c|e|E|r|x)\b/, why: "führt Inline-Code aus (-c/-e)" },
  { re: /(^|[\s;&|(])(osascript|defaults|open|pbcopy|pbpaste)(\s|$)/, why: "greift auf macOS-Systemfunktionen zu" },
  { re: /(^|[\s;&|(])gh(\s|$)/, why: "GitHub-CLI (außen-sichtbar: PR/Issue/API)" },
  { re: /:\s*\(\s*\)\s*\{/, why: "verdächtiges Shell-Muster (Fork-Bomb)" },
  // awk/gawk mit system(): der Programmkörper steht in Quotes und wird von segmentCommands
  // ENTFERNT, bevor die Kopf-/Token-Prüfung greift — die Innen-Aktion (system("rm …")) bliebe
  // sonst unsichtbar. Deshalb hier über die ROHZEILE.
  { re: /(^|[\s;&|(])(?:[^\s|;&]*\/)?(awk|gawk|mawk|nawk)\b[\s\S]*?\bsystem\s*\(/, why: "awk system() führt Befehle aus" },
  // Code-ausführende Umgebungsvariablen (Env-Injection: laden Bibliotheken/führen
  // Hilfsprogramme aus). Fängt u. a. `GIT_EXTERNAL_DIFF=evil git diff`, `LD_PRELOAD=evil.so …`
  // und die macOS-dylib-Hijack-Varianten (DYLD_*) — die segmentCommands sonst als harmlose
  // Zuweisung wegwirft.
  {
    re: /(^|[\s;&|(])(LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|DYLD_FRAMEWORK_PATH|DYLD_FALLBACK_LIBRARY_PATH|DYLD_FALLBACK_FRAMEWORK_PATH|DYLD_VERSIONED_LIBRARY_PATH|GIT_EXTERNAL_DIFF|GIT_SSH|GIT_SSH_COMMAND|GIT_PAGER|GIT_EDITOR|GIT_PROXY_COMMAND|GIT_CONFIG|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_ALTERNATE_OBJECT_DIRECTORIES|BASH_ENV|PERL5OPT|PYTHONSTARTUP|NODE_OPTIONS|RUBYOPT)=/,
    why: "setzt eine Code-ausführende Umgebungsvariable",
  },
];

// git-Subcommands, die destruktiv/außen-sichtbar/netzwerkend sind → IMMER fragen.
const GIT_RISKY_SUB = new Set([
  "push", "rm", "reset", "clean", "checkout", "restore", "switch", "merge", "rebase",
  "cherry-pick", "revert", "filter-branch", "filter-repo", "update-ref", "gc", "fetch",
  "pull", "am", "apply", "format-patch", "send-email", "request-pull", "daemon",
  "fast-import", "p4", "svn", "instaweb", "clone", "ls-remote", "archive",
]);
// Subcommands, die nur lesen bzw. lokal/harmlos sind. ALLES andere → default-deny (ASK),
// damit ein unbekanntes/neues Subcommand nicht versehentlich auto-erlaubt wird.
const GIT_SAFE_SUB = new Set([
  "status", "log", "diff", "show", "add", "commit", "branch", "stash", "tag", "worktree",
  "remote", "submodule", "config", "rev-parse", "ls-files", "ls-tree", "cat-file", "blame",
  "describe", "shortlog", "reflog", "for-each-ref", "rev-list", "name-rev", "symbolic-ref",
  "cherry", "grep", "merge-base", "show-ref", "show-branch", "var", "help", "version",
  "count-objects", "fsck", "check-ignore", "check-attr", "diff-tree", "diff-index",
  "diff-files", "whatchanged", "range-diff", "verify-commit", "verify-tag", "annotate", "init",
]);
// git-Config-Keys / globale Optionen, die beliebigen Code ausführen können (GIT-2).
const GIT_CODE_EXEC_CONFIG =
  /^(core\.(fsmonitor|sshcommand|pager|editor|hookspath|askpass)|sequence\.editor|gpg\.program|ssh\.variant|http\.proxy|.*\.(textconv|external)|diff\.external|alias\.|filter\.)/i;

function hasWriteRedirect(cmd: string): boolean {
  // Quotes zuerst maskieren — ein > in 'text' oder "code" ist KEIN Redirect.
  // erlaubt: >/dev/null, 2>/dev/null, 2>&1, >&2 — alles andere ist ein Schreib-Redirect.
  const cleaned = cmd
    .replace(/\\./g, " ") // maskierte Zeichen (z.B. \> ) sind kein Redirect
    .replace(/'[^']*'/g, " ")
    .replace(/"[^"]*"/g, " ")
    .replace(/\d?>>?\s*\/dev\/null/g, " ")
    .replace(/\d?>&\d/g, " ")
    .replace(/&>\s*\/dev\/null/g, " ");
  return /(^|[^\d&])>>?/.test(cleaned);
}

/**
 * Argv-bewusste git-Einstufung (GIT-1/GIT-2): segmentiert die Zeile, überspringt globale
 * Optionen TOKEN-WEISE (inkl. solcher mit eigenem Argument wie `-C <dir>`, `-c k=v`) und
 * bewertet das ERSTE Nicht-Flag-Token als Subcommand. So lässt sich `git -c k=v push` oder
 * `git -C dir push` nicht mehr an der Subcommand-Prüfung vorbeischmuggeln; Code-ausführende
 * `-c`-Keys (diff.external, alias.*, core.pager …) und `--exec-path` werden abgefangen.
 */
function classifyGit(cmd: string): AutoDecision | null {
  if (!/\bgit\b/.test(cmd)) return null;
  for (const toks of segmentCommands(cmd)) {
    const base = (toks[0].split("/").pop() ?? toks[0]).toLowerCase();
    if (base !== "git") continue;
    let i = 1;
    while (i < toks.length) {
      const t = toks[i];
      if (t === "-c" || t === "--config-env") {
        if (GIT_CODE_EXEC_CONFIG.test(toks[i + 1] ?? "")) return ASK("git -c mit Code-ausführendem Config-Key");
        i += 2;
        continue;
      }
      if (t === "--exec-path" || t.startsWith("--exec-path=")) return ASK("git --exec-path (Pfad-Override)");
      if (t === "-C" || t === "--git-dir" || t === "--work-tree" || t === "--namespace") {
        i += 2;
        continue;
      }
      if (t.startsWith("-")) {
        i += 1;
        continue;
      }
      break;
    }
    const sub = (toks[i] ?? "").toLowerCase();
    if (!sub) continue;
    if (GIT_RISKY_SUB.has(sub)) return ASK(`git-Operation „${sub}“ — außen-sichtbar/verändernd`);
    const a1 = (toks[i + 1] ?? "").toLowerCase();
    if (sub === "remote" && /^(add|remove|rm|set-url|rename|prune)$/.test(a1)) return ASK("git remote ändern");
    if (sub === "submodule" && /^(add|update|deinit|sync|set-url|set-branch)$/.test(a1)) return ASK("git submodule ändern");
    if (sub === "worktree" && /^(add|remove|move|prune)$/.test(a1)) return ASK("git worktree ändern");
    if (sub === "branch" && toks.slice(i + 1).some((x) => /^-(D|d|M|m|-delete|-move|-force)$/.test(x)))
      return ASK("git branch löschen/umbenennen");
    if (sub === "stash" && /^(drop|clear|pop|apply|push|store)$/.test(a1)) return ASK("git stash verändern");
    if (sub === "tag" && toks.length > i + 1 && !toks.slice(i + 1).some((x) => x === "-l" || x === "--list" || x === "-n"))
      return ASK("git tag erstellen/löschen");
    if (sub === "config") {
      if (toks.slice(i + 1).some((x) => x === "--global" || x === "--system")) return ASK("git config --global/--system");
      const key = toks.slice(i + 1).find((x) => !x.startsWith("-"));
      if (key && GIT_CODE_EXEC_CONFIG.test(key) && toks.indexOf(key) >= 0 && toks.length > toks.indexOf(key) + 1)
        return ASK("git config setzt Code-ausführenden Key");
    }
    if (!GIT_SAFE_SUB.has(sub)) return ASK(`git-Subcommand „${sub}“ nicht als sicher eingestuft`);
  }
  return null;
}

// Führende Shell-Keywords, die KEINE Kommandos sind (das eigentliche Kommando folgt).
const LEADING_SKIP = new Set([
  "do", "then", "else", "elif", "time", "!", "{", "}", "(", ")", "while", "until",
  "if", "done", "fi", "esac",
]);
// Segment-Köpfe ohne ausführbares Kommando (Loop-/case-Header; Body steht in `do`-Segmenten).
const SEGMENT_HEAD_NOCMD = new Set(["for", "select", "case", "in"]);

/**
 * Pro Segment einer (ggf. zusammengesetzten) Bash-Zeile die Kommando-Tokens liefern
 * (führende Keywords/Zuweisungen übersprungen). [0] = Kommando, [1..] = dessen Argumente.
 */
function segmentCommands(cmd: string): string[][] {
  // 0) Zeilen-Fortsetzungen (\ + Newline) ZUERST zusammenführen — sonst werden die
  //    Folgezeilen (z.B. Dateilisten in `for … in \`, Pattern-Listen, lange Befehle)
  //    fälschlich als eigene Kommandos behandelt → die häufigste Ursache überflüssiger
  //    Rückfragen bei mehrzeiligen Skripten.
  // 1) Quoted-Strings entfernen (enthalten ggf. Operatoren wie | die keine sind).
  // 2) Kommando-Substitution öffnen, damit innere Kommandos mitgeprüft werden.
  const s = cmd
    .replace(/\\\r?\n/g, " ")
    // Heredoc-Inhalte (<<'TAG' … TAG) sind Eingabedaten (z.B. python3 - <<PY …), keine Befehle.
    .replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n[ \t]*\2\b/g, " ")
    .replace(/\$'(?:[^'\\]|\\.)*'/g, " ") // ANSI-C-Quotes $'…\n…' (können \ enthalten)
    .replace(/'[^']*'/g, " ")
    .replace(/"(?:[^"\\]|\\.)*"/g, " ")
    .replace(/`/g, " ")
    .replace(/<<</g, " ") // Here-String-Operator
    .replace(/\$\(/g, " ")
    .replace(/[()]/g, " ; ");
  // NICHT auf einzelnem & splitten — das gehört meist zu Redirects (2>&1, >&2, &>).
  const segments = s.split(/(?:\|\||&&|\||;|\n)+/);
  const out: string[][] = [];
  for (const seg of segments) {
    // Zeilen-Kommentare (# …) abschneiden — kein Kommando.
    const noComment = seg.replace(/(^|\s)#.*$/, "");
    const toks = noComment.trim().split(/\s+/).filter(Boolean);
    if (toks.length === 0) continue;
    if (SEGMENT_HEAD_NOCMD.has(toks[0])) continue; // z.B. `for n in 0063 0064` → kein Kommando
    let i = 0;
    while (i < toks.length && (LEADING_SKIP.has(toks[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]))) i++;
    if (i >= toks.length) continue;
    // Reine Shell-Operatoren/Punktuation als „Kommando"-Kopf (z.B. übrig gebliebenes
    // `\`, `<`, `}` aus Fortsetzungen/Prozess-Substitution) sind KEIN Befehl → nicht fragen.
    if (!/[A-Za-z0-9]/.test(toks[i])) continue;
    out.push(toks.slice(i));
  }
  return out;
}

/** uv-Runner gilt als sicher (vom Nutzer freigegeben): `uv run …`, `uv tool run …`, `uvx …`
 * — auch mit vollem Pfad (`~/.local/bin/uv run …`). `uv add/sync/pip …` (Netz/Deps) NICHT. */
function isUvRunner(toks: string[]): boolean {
  const base = (toks[0].split("/").pop() ?? toks[0]).toLowerCase();
  if (base === "uvx") return true;
  if (base === "uv") return toks[1] === "run" || (toks[1] === "tool" && toks[2] === "run");
  return false;
}

/**
 * Erkennt einen echten `git commit`-Aufruf in einer (ggf. zusammengesetzten) Bash-Zeile.
 * Robust via segmentCommands (Quotes/Heredocs/Compound entfernt) und gegen Fehltreffer wie
 * `git log --grep commit` (commit muss das Subcommand sein, nicht ein Argument). Globale
 * git-Flags (-C <dir>, -c k=v, --git-dir …) werden übersprungen.
 * Genutzt fürs Main-Commit-Gate: der Integrator (Worktree = main-Checkout) soll nicht still
 * auf main committen.
 */
export function isGitCommit(command: string): boolean {
  for (const toks of segmentCommands(command)) {
    const base = (toks[0].split("/").pop() ?? toks[0]).toLowerCase();
    if (base !== "git") continue;
    let i = 1;
    while (i < toks.length) {
      const t = toks[i];
      if (t === "-C" || t === "-c" || t === "--git-dir" || t === "--work-tree" || t === "--namespace") {
        i += 2; // diese Flags tragen ein Argument
        continue;
      }
      if (t.startsWith("-")) {
        i += 1;
        continue;
      }
      break;
    }
    if (toks[i] === "commit") return true;
  }
  return false;
}

// Interpreter, die Inline-Code/Module ausführen können. python/python3 sind als Dev-Tooling
// auto-erlaubt — daher hier argv-bewusst prüfen (der DANGER-Regex übersah z. B. `python3 -W
// ignore -c '…'`, weil `-W ignore` ein Options-Argument trägt). Die übrigen sind ohnehin
// nicht in SAFE_CMDS und werden gefragt; der Check schadet dort nicht.
const INTERPRETERS = new Set(["python", "python3", "ipython", "ruby", "perl", "php", "node", "deno", "bun"]);
// Module, die `python -m X` harmlos machen (Test/Lint/Format) — alles andere (pip,
// http.server, venv, …) ist Code-/Netz-Fläche → fragen.
const SAFE_PY_MODULES = new Set([
  "pytest", "unittest", "mypy", "ruff", "black", "isort", "flake8", "pylint", "coverage",
  "json.tool", "timeit", "py_compile", "compileall", "this",
]);

function interpreterRisk(toks: string[]): string | null {
  // KOPF-basiert: nur wenn der Interpreter das ausgeführte Kommando IST (toks[0]) — NICHT wenn
  // er bloß als Argument vorkommt (`ls .venv/bin/python`). Wrapper (`timeout 5 python3 …`) werden
  // vom Aufrufer per unwrapWrappers abgeschält, sodass der Interpreter dann an toks[0] steht.
  const base = (toks[0].split("/").pop() ?? toks[0]).toLowerCase();
  if (!INTERPRETERS.has(base)) return null;
  for (let i = 1; i < toks.length; i++) {
    const t = toks[i];
    if (/[<>&|]/.test(t)) continue; // Redirect/Operator (2>/dev/null, 2>&1, &) — kein Skript
    if (/^-(c|e|E|r|x)$/.test(t)) return "Interpreter führt Inline-Code aus (-c/-e)";
    if (/^--(eval|command)$/.test(t)) return "Interpreter führt Inline-Code aus (--eval)";
    if (t === "-m" || /^-m[A-Za-z]/.test(t)) {
      const mod = (t === "-m" ? toks[i + 1] ?? "" : t.slice(2)).toLowerCase();
      if (!SAFE_PY_MODULES.has(mod)) return `Modul-Ausführung „${mod || "?"}“ (-m, Code-/Netz-Fläche)`;
      return null; // sicheres Modul → alle Folge-Tokens sind Modul-Argumente, kein Skript
    }
    if (/^-[WXQIRS]$/.test(t)) {
      i += 1; // Option mit eigenem Wert-Argument (der Wert ist KEIN Skript)
      continue;
    }
    // Erstes Nicht-Options-Token — oder `-` (= Skript von stdin) — ist ein SKRIPT/Programm →
    // arbiträre Code-Ausführung → fragen. (Deckt `python3 x.py`, `node evil.js`, `python3 - <<PY`.)
    if (t === "-" || !t.startsWith("-")) return "Interpreter führt ein Skript/Programm aus (arbiträrer Code)";
  }
  return null;
}

// Transparente Wrapper: führen das NÄCHSTE (Nicht-Options-)Token als Befehl aus. Der Kopf-Token
// ist harmlos, ABER das ausgeführte Programm muss selbst eingestuft werden — sonst ist
// `timeout 5 /tmp/evil` / `env /tmp/evil` / `xargs /tmp/evil` auto-erlaubt. `unwrapWrappers`
// schält die Wrapper (auch verkettet) ab und liefert das INNERSTE Kommando zurück.
const WRAPPERS = new Set(["timeout", "nice", "nohup", "stdbuf", "env", "xargs"]);
function unwrapWrappers(toks: string[]): string[] {
  let cur = toks;
  for (let depth = 0; depth < 6; depth++) {
    const base = (cur[0].split("/").pop() ?? cur[0]).toLowerCase();
    if (!WRAPPERS.has(base)) break;
    let i = 1;
    while (i < cur.length) {
      const t = cur[i];
      if (t.startsWith("-")) {
        // Optionen mit eigenem Wert-Argument → das Argument mit überspringen.
        i += /^-(n|s|k|P|I|E|u|d|L|-signal|-kill-after|-max-procs|-max-args|-replace)$/.test(t) ? 2 : 1;
        continue;
      }
      if (base === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
        i += 1; // NAME=VAL-Zuweisung (DANGER fängt Code-ausführende Vars separat)
        continue;
      }
      if ((base === "timeout" || base === "nice") && /^-?\d+(\.\d+)?[smhd]?$/.test(t)) {
        i += 1; // Dauer (timeout) / Priorität (nice)
        continue;
      }
      break;
    }
    if (i >= cur.length) break; // kein inneres Kommando
    cur = cur.slice(i);
  }
  return cur;
}

/** Befehle, deren Programm-KÖRPER an der Token-/DANGER-Prüfung vorbeiläuft (z. B. `find -exec`
 *  führt beliebige Kommandos aus; awk-`system()` fängt bereits DANGER über die Rohzeile). */
function specialExecRisk(toks: string[]): string | null {
  const base = (toks[0].split("/").pop() ?? toks[0]).toLowerCase();
  if (base === "find" && toks.some((t) => /^-(exec|execdir|ok|okdir)$/.test(t)))
    return "find -exec führt einen Befehl aus";
  if (/^(awk|gawk|mawk|nawk)$/.test(base) && toks.includes("-f")) return "awk -f führt eine Programmdatei aus";
  if (base === "sed" && toks.includes("-f")) return "sed -f führt eine Programmdatei aus";
  return null;
}

export function classifyBashCommand(command: string): AutoDecision {
  const cmd = command.trim();
  if (!cmd) return ASK("leerer Befehl");

  for (const d of DANGER) if (d.re.test(cmd)) return ASK(d.why);
  if (hasWriteRedirect(cmd)) return ASK("schreibt per Umleitung (>) in eine Datei");

  const git = classifyGit(cmd);
  if (git) return git;

  const segs = segmentCommands(cmd);
  if (segs.length === 0) return ASK("Befehl nicht eindeutig");
  for (const rawToks of segs) {
    // Programm-Körper, die an Token-/DANGER-Prüfung vorbeilaufen (find -exec, awk/sed -f).
    const special = specialExecRisk(rawToks);
    if (special) return ASK(special);
    // Transparente Wrapper (timeout/nice/env/xargs …) abschälen → das TATSÄCHLICH ausgeführte Kommando.
    const toks = unwrapWrappers(rawToks);
    const headBase = (toks[0].split("/").pop() ?? toks[0]).toLowerCase();
    // xargs speist stdin als zusätzliche ARGV → ein Interpreter dahinter bekommt so ein Skript.
    if (INTERPRETERS.has(headBase) && rawToks.some((t) => (t.split("/").pop() ?? t).toLowerCase() === "xargs"))
      return ASK("xargs speist ein Skript an einen Interpreter");
    // Interpreter (Inline-Code ODER Skript) in Kommando-Position → prüfen.
    const interp = interpreterRisk(toks);
    if (interp) return ASK(interp);
    const c = toks[0];
    if (SAFE_CMDS.has(c)) continue;
    if (isUvRunner(toks)) continue;
    if (/(^|\/)\.venv\/bin\//.test(c)) continue; // Projekt-venv-Tool (z.B. .venv/bin/ruff)
    if ((c === "source" || c === ".") && /(^|\/)activate$/.test(toks[1] ?? "")) continue; // venv aktivieren
    return ASK(`enthält nicht-eingestuften Befehl „${c}“`);
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

// Vertrauenswürdige Doku-/Registry-/Referenz-Hosts (Suffix-Match inkl. Subdomains) — WebFetch
// dorthin läuft still. Ein Exfiltrations-Ziel des Angreifers steht hier NICHT drauf → wird gefragt.
const TRUSTED_FETCH_SUFFIXES = [
  "github.com", "githubusercontent.com", "githubassets.com",
  "npmjs.com", "npmjs.org", "pypi.org", "pythonhosted.org", "crates.io", "docs.rs", "rubygems.org", "pkg.go.dev",
  "developer.mozilla.org", "mozilla.org", "readthedocs.io", "readthedocs.org", "rtfd.io",
  "stackoverflow.com", "stackexchange.com", "serverfault.com", "superuser.com", "askubuntu.com",
  "huggingface.co", "wikipedia.org", "w3.org", "json-schema.org", "tauri.app", "codemirror.net",
  "reactjs.org", "react.dev", "nodejs.org", "typescriptlang.org", "rust-lang.org", "go.dev",
  "developer.apple.com", "developer.android.com", "kubernetes.io", "docker.com",
  "anthropic.com", "claude.ai",
];
/** Host aus einer http(s)-URL (ohne userinfo/Port, klein). */
function fetchHost(url: string): string | null {
  const m = /^https?:\/\/([^/?#]+)/i.exec(url.trim());
  if (!m) return null;
  return (m[1].split("@").pop() ?? m[1]).split(":")[0].toLowerCase();
}
function isTrustedFetchHost(host: string): boolean {
  return TRUSTED_FETCH_SUFFIXES.some((s) => host === s || host.endsWith("." + s));
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
  if (READ_TOOLS.has(toolName)) {
    if (toolName === "TodoWrite") return ALLOW; // keine Datei
    const p = (input?.file_path ?? input?.notebook_path ?? input?.path) as string | undefined;
    // Glob/Grep/LS ohne expliziten Pfad → Arbeitsverzeichnis (sicher). Nur prüfen, wenn
    // ein Pfad angegeben ist: Lesen von ~/.ssh/.aws/.env oder außerhalb des Worktrees
    // (Exfiltrations-Primitive, INJ-3) → Rückfrage statt stiller Freigabe.
    if (p === undefined || p === "") return ALLOW;
    const bad = pathUnsafe(p, ctx.cwd);
    return bad ? ASK(`Lesezugriff: ${bad}`) : ALLOW;
  }

  if (EDIT_TOOLS.has(toolName)) {
    const p = (input?.file_path ?? input?.notebook_path ?? input?.path) as string | undefined;
    const bad = pathUnsafe(p, ctx.cwd);
    return bad ? ASK(`Datei-Schreibzugriff: ${bad}`) : ALLOW;
  }

  if (toolName === "Bash") {
    const c = (input?.command ?? "") as string;
    return classifyBashCommand(c);
  }

  // Erstanbieter-Orchestrierungs-Tools des In-Process-MCP-Servers „mads". spawn_substreams
  // erzeugt N Sub-Agenten mit einem vom Agenten formulierten „brief" als Prompt — injizierter
  // Repo-/CLAUDE.md-Inhalt könnte darüber (via Autopilot der Subs) ungenehmigt pushen/PRen.
  // Daher: EINMAL bewusst bestätigen (nicht pro URL). Übrige mads-Tools bleiben erlaubt.
  if (toolName === "mcp__mads__spawn_substreams")
    return ASK("startet neue Sub-Streams (eigener Worktree/Branch, Autopilot) — bewusst bestätigen");
  if (toolName.startsWith("mcp__mads__")) return ALLOW;

  // WebFetch: GET + Zusammenfassung. Sanktionierter Netz-Kanal (Bash-curl/wget fragt ohnehin) —
  // damit ist er die Umgehung, über die ein injizierter Agent Repo-Daten (base64/hex in der
  // URL) an einen ANGREIFER-Host exfiltrieren könnte. Zwei Gates: (1) Secret-Muster in der URL,
  // (2) Host-Allowlist — bekannte Doku-/Registry-Hosts laufen still, ALLES andere fragt.
  if (toolName === "WebSearch") return ALLOW; // Suche → fester Provider, kein wählbarer Ziel-Host
  if (toolName === "WebFetch") {
    const url = String(input?.url ?? "");
    const hits = findSecrets(url);
    if (hits.length) return ASK(`WebFetch-URL enthält ein mögliches Secret (${hits[0].kind}) — Exfiltration verhindern`);
    const host = fetchHost(url);
    if (host && isTrustedFetchHost(host)) return ALLOW;
    return ASK(`WebFetch auf nicht gelistete Domain „${host || "?"}“ — mögliche Datenexfiltration bestätigen`);
  }

  // Drittanbieter-MCP-Tools, Task, Unbekanntes → fragen.
  return ASK(`Tool „${toolName}“ nicht als auto-sicher eingestuft`);
}
