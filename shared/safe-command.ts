/**
 * Auto-Freigabe-Klassifizierer für den "Auto"-Permission-Modus (Policy: „Trusted-Local-Dev").
 * Entscheidet im mads-`canUseTool`, ob ein Tool-Aufruf ohne Rückfrage erlaubt wird oder dem
 * Nutzer vorgelegt werden muss.
 *
 * Leitlinie: LOKALE Ausführung ist erlaubt und läuft still — Skripte, Interpreter (`python
 * -c`, `-m`, node …), Dev-Server, Build/Test, unbekannte lokale Tools, Lesen (auch ausserhalb
 * des Projekts) und Datei-Änderungen im Arbeitsbaum. Gefragt wird NUR bei echtem Risiko:
 *   • Netz nach AUSSEN (curl/wget zu Nicht-Loopback, ssh/scp/nc/rsync/ftp),
 *   • git push/pull/fetch/clone + gh/PR (außen-sichtbar), Config-Exec-Keys,
 *   • sudo, Paketmanager/Installer (npm install, pip, brew, docker …),
 *   • destruktiv/System (rm/dd/mkfs/chmod/kill), macOS-Systemfunktionen,
 *   • Zugriff auf Secrets (.ssh/.env/.aws/…) und Schreiben AUSSERHALB von Projekt/Temp.
 * Im Zweifel: fragen.
 *
 * Sicherheitskritisch — siehe safe-command.test.ts. Der DANGER-Scan läuft QUOTE-NEUTRALISIERT,
 * sodass in Code-Strings versteckte riskante Tokens (rm/sudo/ssh/git push) trotzdem greifen.
 */

import { findSecrets } from "./secrets.js";

export type AutoDecision = { decision: "allow" | "ask"; reason?: string };

const ASK = (reason: string): AutoDecision => ({ decision: "ask", reason });
const ALLOW: AutoDecision = { decision: "allow" };

// Tools, die nur lesen → immer auto-erlaubt.
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead", "TodoWrite"]);
// Tools, die Dateien (im Worktree) ändern → auto-erlaubt, sofern Pfad sicher.
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

// „Trusted-Local-Dev": LOKALE Ausführung ist im Auto-Modus erlaubt (Skripte, Interpreter,
// `python -c`, `-m`, unbekannte lokale Tools). DANGER listet nur DIREKT riskante Aktionen —
// auswärts/destruktiv/System/Secrets — die IMMER fragen. Der Scan läuft QUOTE-NEUTRALISIERT
// (Anführungszeichen → Leerzeichen), damit z. B. `python -c 'os.system("rm -rf x")'` das `rm`
// trotzdem fängt. curl/wget (loopback-bewusst) und Paketmanager werden separat behandelt.
const DANGER = [
  { re: /(^|[\s;&|(])sudo(\s|$)/, why: "läuft mit sudo" },
  { re: /(^|[\s;&|(])(rm|rmdir|shred|unlink)(\s|$)/, why: "löscht Dateien (rm)" },
  { re: /(^|[\s;&|(])(chmod|chown|chgrp)(\s|$)/, why: "ändert Dateirechte" },
  { re: /(^|[\s;&|(])(kill|killall|pkill|shutdown|reboot|halt)(\s|$)/, why: "beendet Prozesse / fährt herunter" },
  { re: /(^|[\s;&|(])(dd|mkfs|diskutil|fdisk)(\s|$)/, why: "Datenträger-/Low-Level-Operation" },
  // Auswärts-Netz (Shell-Zugänge/Transfers). curl/wget sind NICHT hier — die sind loopback-bewusst.
  { re: /(^|[\s;&|(])(nc|ncat|telnet|ssh|scp|sftp|rsync|ftp)(\s|$)/, why: "Netzwerkzugriff nach aussen" },
  { re: /(^|[\s;&|(])(brew|apt|apt-get|yum|dnf|port|docker|podman|launchctl|crontab|systemctl)(\s|$)/, why: "System-/Paket-/Dienst-Verwaltung" },
  { re: /(^|[\s;&|(])(osascript|defaults|pbcopy|pbpaste)(\s|$)/, why: "macOS-Systemfunktionen/Zwischenablage" },
  { re: /(^|[\s;&|(])gh(\s|$)/, why: "GitHub-CLI (außen-sichtbar: PR/Issue/API)" },
  // git außen-sichtbar/destruktiv — auch code-versteckt (Scan ist quote-neutralisiert). Den
  // nuancierten Top-Level-Fall (`git remote -v` ok, `git remote add` fragt; Config-Exec-Keys)
  // deckt zusätzlich classifyGit ab; hier nur die eindeutig riskanten Subcommands.
  { re: /(^|[\s;&|(])git\s+(?:-\S+\s+)*(push|pull|fetch|clone|reset|clean)(\s|$)/, why: "git außen-sichtbar/verändernd" },
  { re: /:\s*\(\s*\)\s*\{/, why: "verdächtiges Shell-Muster (Fork-Bomb)" },
  // Hijack-/Egress-Umgebungsvariablen: laden fremde Libs bzw. übernehmen git/ssh nach aussen.
  {
    re: /(^|[\s;&|(])(LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|DYLD_FRAMEWORK_PATH|DYLD_FALLBACK_LIBRARY_PATH|DYLD_FALLBACK_FRAMEWORK_PATH|DYLD_VERSIONED_LIBRARY_PATH|GIT_EXTERNAL_DIFF|GIT_SSH|GIT_SSH_COMMAND|GIT_PROXY_COMMAND|GIT_CONFIG|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_ALTERNATE_OBJECT_DIRECTORIES)=/,
    why: "setzt eine Hijack-/Egress-Umgebungsvariable",
  },
];

// Loopback-Hosts: curl/wget dorthin ist ein lokaler Healthcheck, keine Exfiltration.
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?)(:\d+)?$/i;
// Temp-Ziele für Schreib-Umleitungen (so unkritisch wie /dev/null).
const TEMP_REDIRECT = /^(\/tmp\/|\/private\/tmp\/|\/var\/folders\/|\/private\/var\/folders\/)/;
// Paketmanager-Subcommands, die installieren/veröffentlichen/aus dem Netz ziehen → fragen.
// Alles andere (run/build/test/exec/<script>) ist lokale Ausführung → erlaubt.
const PKG_INSTALL_SUB =
  /^(install|i|ci|add|update|up|upgrade|uninstall|remove|create|init|publish|link|unlink|dlx|audit|dedupe|prune|get|sync|fetch|import|yank)$/i;

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

/** curl/wget: Loopback-Ziele (localhost/127.x/::1/0.0.0.0) sind lokale Healthchecks → erlaubt;
 *  jedes andere (oder kein erkennbares) http(s)-Ziel geht nach AUSSEN → fragen. Läuft auf der
 *  quote-neutralisierten Zeile, damit auch eingebettete URLs (python -c '…urlopen("http://x")')
 *  erfasst werden. ssh/scp/nc/rsync/ftp fängt bereits DANGER (immer fragen). */
function outwardNetworkRisk(neutralized: string): string | null {
  if (!/(^|[\s;&|(])(curl|wget)(\s|$)/.test(neutralized)) return null;
  const urls = neutralized.match(/\bhttps?:\/\/[^\s;&|()<>]+/gi) ?? [];
  if (urls.length === 0) return "Netzwerkzugriff (curl/wget) — Ziel nicht als lokal erkennbar";
  for (const u of urls) {
    const host = (u.replace(/^https?:\/\//i, "").split(/[/?#]/)[0].split("@").pop() ?? "").toLowerCase();
    if (!LOOPBACK.test(host)) return "Netzwerkzugriff nach aussen (curl/wget)";
  }
  return null; // alle Ziele Loopback → lokal
}

/** Paketmanager: lokal bauen/testen/ausführen (run/build/test/exec/<script>) ist erlaubt; alles,
 *  was installiert/veröffentlicht/aus dem Netz zieht → fragen. pip/pip3/gem/npx/pipx sind
 *  install-/fetch-zentriert → immer fragen. `uv run`/`uvx`/`uv tool run` (Projekt-Env) laufen still. */
function pkgManagerRisk(cmd: string): string | null {
  for (const toks of segmentCommands(cmd)) {
    const base = (toks[0].split("/").pop() ?? toks[0]).toLowerCase();
    if (base === "npx" || base === "pip" || base === "pip3" || base === "pipx" || base === "gem")
      return `${base} — installiert/lädt Pakete (Netz/Supply-Chain)`;
    // `python -m pip …` ist ein Installer (Dev-Server wie `-m http.server` bleibt aber erlaubt).
    if (base === "python" || base === "python3") {
      let mod = "";
      const mi = toks.indexOf("-m");
      if (mi > 0) mod = toks[mi + 1] ?? "";
      else {
        const glued = toks.find((t) => /^-m[A-Za-z]/.test(t));
        if (glued) mod = glued.slice(2);
      }
      if (/^pip3?$/i.test(mod)) return "python -m pip — installiert Pakete (Netz/Supply-Chain)";
      continue;
    }
    if (base === "uvx") continue; // uv tool run (lokal ausführen)
    if (base === "uv") {
      const s1 = (toks[1] ?? "").toLowerCase();
      if (s1 === "run" || s1 === "version" || s1 === "--version" || (s1 === "tool" && (toks[2] ?? "").toLowerCase() === "run"))
        continue;
      return `uv ${s1} — Abhängigkeiten/Netz`;
    }
    if (base === "npm" || base === "pnpm" || base === "yarn" || base === "bun" || base === "cargo" || base === "go") {
      const sub = (toks[1] ?? "").toLowerCase();
      if (base === "yarn" && !sub) return "yarn (ohne Subcommand = install) — Netz/Supply-Chain";
      if (PKG_INSTALL_SUB.test(sub)) return `${base} ${sub} — installiert/veröffentlicht (Netz/Supply-Chain)`;
    }
  }
  return null;
}

/** Schreib-Umleitung (>, >>) NUR fragen, wenn das Ziel absolut & AUSSERHALB von Projekt/Temp
 *  liegt (z. B. >/etc/hosts, >>~/.zshrc). Relative Ziele (im cwd), /dev/*, fd-Dups (2>&1) und
 *  Temp (/tmp, /var/folders …) sind erlaubt. */
function unsafeWriteRedirect(cmd: string): string | null {
  const cleaned = cmd
    .replace(/\\./g, " ") // maskierte Zeichen (\>) sind kein Redirect
    .replace(/'[^']*'/g, " ")
    .replace(/"(?:[^"\\]|\\.)*"/g, " ")
    .replace(/\d?>&\d/g, " ") // fd-Dup: 2>&1, >&2
    .replace(/\d?>>?\s*\/dev\/\w+/g, " "); // >/dev/null, 2>/dev/null, >/dev/stdout
  const re = /\d?>>?\s*([^\s;&|()<>]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const target = m[1];
    if (!/^[/~]/.test(target)) continue; // relativ → im Projekt (cwd) → ok
    if (TEMP_REDIRECT.test(target)) continue; // Temp → ok
    return "schreibt per Umleitung (>) ausserhalb von Projekt/Temp";
  }
  return null;
}

// Datei-Schreib-/Kopier-Tools OHNE > -Redirect: tee schreibt in alle Argumente, cp/mv/ln ins
// letzte (Ziel). Schreiben nach absolut & AUSSERHALB von Projekt/Temp (z. B. `tee /etc/hosts`,
// `cp x /usr/local/bin/y`) → fragen. Ziele im cwd (relativ) oder in Temp bleiben still.
const WRITE_DEST_CMDS = new Set(["cp", "mv", "ln"]);
function writesOutsideProject(cmd: string): string | null {
  for (const toks of segmentCommands(cmd)) {
    const base = (toks[0].split("/").pop() ?? toks[0]).toLowerCase();
    const args = toks.slice(1).filter((t) => !t.startsWith("-"));
    let targets: string[] = [];
    if (base === "tee") targets = args;
    else if (WRITE_DEST_CMDS.has(base) && args.length >= 1) targets = [args[args.length - 1]];
    else continue;
    for (const t of targets) {
      if (!/^[/~]/.test(t)) continue; // relativ → im Projekt → ok
      if (TEMP_REDIRECT.test(t)) continue; // Temp → ok
      return `${base} schreibt ausserhalb von Projekt/Temp`;
    }
  }
  return null;
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

/**
 * „Trusted-Local-Dev": lokale Ausführung läuft still; gefragt wird nur bei echtem Risiko.
 * Reihenfolge der Gates (jedes greift auch, wenn das Risiko in einem Code-String versteckt ist —
 * der DANGER-/Netz-Scan läuft QUOTE-NEUTRALISIERT):
 *   1) DANGER   — sudo/rm/chmod/kill/dd, ssh/scp/nc/rsync/ftp, brew/apt/docker/systemctl,
 *                 osascript/defaults/pbcopy, gh, git push/pull/fetch/clone/reset/clean,
 *                 Fork-Bomb, Hijack-/Egress-Env-Vars.
 *   2) Netz     — curl/wget nach AUSSEN (Loopback = lokaler Healthcheck → erlaubt).
 *   3) Pakete   — install/publish/add/… bzw. pip/gem/npx (Netz/Supply-Chain).
 *   4) git      — argv-bewusst (Config-Exec-Keys, remote add/set-url, branch -D …).
 *   5) Redirect — Schreiben per > AUSSERHALB von Projekt/Temp.
 *   6) Schreib-Tools — tee/cp/mv/ln mit Ziel AUSSERHALB von Projekt/Temp.
 * Fällt nichts davon → ALLOW (Skripte, `python -c`, `-m`, node, Dev-Server, unbekannte lokale Tools).
 */
export function classifyBashCommand(command: string): AutoDecision {
  const cmd = command.trim();
  if (!cmd) return ASK("leerer Befehl");

  // Anführungszeichen/Backticks → Leerzeichen: riskante Tokens INNERHALB von Code-Strings
  // (z. B. python -c 'os.system("rm -rf x")') behalten so ihre Wortgrenzen und werden gefangen.
  const neutralized = cmd.replace(/['"`]/g, " ");

  for (const d of DANGER) if (d.re.test(neutralized)) return ASK(d.why);

  const net = outwardNetworkRisk(neutralized);
  if (net) return ASK(net);

  const pkg = pkgManagerRisk(cmd);
  if (pkg) return ASK(pkg);

  const git = classifyGit(cmd);
  if (git) return git;

  const wr = unsafeWriteRedirect(cmd);
  if (wr) return ASK(wr);

  const wo = writesOutsideProject(cmd);
  if (wo) return ASK(wo);

  return ALLOW; // lokale Ausführung — im Trusted-Local-Dev-Modus erlaubt
}

// Für SCHREIB-Zugriffe (Edit/Write): innerhalb des Worktrees ok, ausserhalb bzw. auf geschützte
// Pfade → fragen. Trusted-Local-Dev lockert das Lesen (siehe sensitivePath), NICHT das Schreiben.
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

/** Für LESE-Zugriffe: Trusted-Local-Dev erlaubt Lesen auch AUSSERHALB des Projekts (Doku,
 *  Referenzen …). Nur echte Secrets-/Schlüssel-Ablagen bleiben tabu. Kein Pfad → LS/Glob im
 *  cwd → erlaubt. */
function sensitivePath(p: string | undefined): string | null {
  if (typeof p !== "string" || !p) return null;
  if (/(^|\/)\.(ssh|aws|gnupg|gpg|kube|docker)(\/|$)/.test(p)) return "geschützter Ordner (Secrets)";
  if (/(^|\/)(\.env(\.|$)|\.npmrc$|\.mcp\.json$|\.netrc$|\.pgpass$|\.git-credentials$|id_rsa|id_ed25519|id_ecdsa|id_dsa)/.test(p))
    return "geschützte Datei (Secret)";
  if (/\.(pem|p12|pfx|keychain)$/i.test(p)) return "geschützte Schlüssel-/Zertifikatsdatei";
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
    // Trusted-Local-Dev: Lesen ist erlaubt — auch ausserhalb des Projekts (Doku/Referenzen).
    // Nur echte Secrets/Schlüssel (~/.ssh, .env, *.pem …) → Rückfrage statt stiller Freigabe.
    const bad = sensitivePath(p);
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
