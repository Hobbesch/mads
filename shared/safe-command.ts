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

/** Kategorie einer Rückfrage — steuert das projektweite „Immer erlauben". `danger` (destruktiv:
 *  rm/sudo/dd/kill/…) ist BEWUSST NICHT merkbar und fragt IMMER. Alle anderen kann der Nutzer per
 *  „Immer erlauben" für das Projekt freischalten (näher an Claude Code). */
export type CommandKind = "danger" | "network" | "pkg" | "secret" | "git" | "write";

/** Kategorien, die „Immer erlauben" merken darf (alles außer dem destruktiven `danger`). */
export const REMEMBERABLE_KINDS: readonly CommandKind[] = ["network", "pkg", "secret", "git", "write"];
/** Menschliche Labels (Dialog-Knopf „Immer erlauben (…)" + Persistenz-Anzeige). */
export const COMMAND_KIND_LABELS: Record<CommandKind, string> = {
  danger: "destruktive Befehle",
  network: "Netzwerkzugriff nach außen",
  pkg: "Paket-/Dienst-Verwaltung",
  secret: "Zugriff auf Secrets/Config",
  git: "Git-Fernaktionen",
  write: "Schreiben außerhalb des Projekts",
};

export type AutoDecision = { decision: "allow" | "ask"; reason?: string; kind?: CommandKind };

const ASK = (reason: string, kind?: CommandKind): AutoDecision => ({ decision: "ask", reason, kind });
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
// Jeder Eintrag trägt seine KATEGORIE (kind) fürs „Immer erlauben": die echt destruktiven/Exploit-
// Muster sind `danger` (NIE merkbar, fragen immer); Shell-Netz (ssh/scp/…) ist `network`, System-/
// Paketwerkzeuge sind `pkg`, gh/git-Fern sind `git` — die kann der Nutzer projektweit freischalten.
const DANGER: { re: RegExp; why: string; kind: CommandKind }[] = [
  { re: /(^|[\s;&|(])sudo(\s|$)/, why: "läuft mit sudo", kind: "danger" },
  { re: /(^|[\s;&|(])(rm|rmdir|shred|unlink)(\s|$)/, why: "löscht Dateien (rm)", kind: "danger" },
  { re: /(^|[\s;&|(])(chmod|chown|chgrp)(\s|$)/, why: "ändert Dateirechte", kind: "danger" },
  { re: /(^|[\s;&|(])(kill|killall|pkill|shutdown|reboot|halt)(\s|$)/, why: "beendet Prozesse / fährt herunter", kind: "danger" },
  { re: /(^|[\s;&|(])(dd|mkfs|diskutil|fdisk)(\s|$)/, why: "Datenträger-/Low-Level-Operation", kind: "danger" },
  // Auswärts-Netz (Shell-Zugänge/Transfers). curl/wget sind NICHT hier — die sind loopback-bewusst.
  { re: /(^|[\s;&|(])(nc|ncat|telnet|ssh|scp|sftp|rsync|ftp)(\s|$)/, why: "Netzwerkzugriff nach aussen", kind: "network" },
  { re: /(^|[\s;&|(])(brew|apt|apt-get|yum|dnf|port|docker|podman|launchctl|crontab|systemctl)(\s|$)/, why: "System-/Paket-/Dienst-Verwaltung", kind: "pkg" },
  { re: /(^|[\s;&|(])(osascript|defaults|pbcopy|pbpaste)(\s|$)/, why: "macOS-Systemfunktionen/Zwischenablage", kind: "danger" },
  { re: /(^|[\s;&|(])gh(\s|$)/, why: "GitHub-CLI (außen-sichtbar: PR/Issue/API)", kind: "git" },
  // git außen-sichtbar/destruktiv — auch code-versteckt (Scan ist quote-neutralisiert). Den
  // nuancierten Top-Level-Fall (`git remote -v` ok, `git remote add` fragt; Config-Exec-Keys)
  // deckt zusätzlich classifyGit ab; hier nur die eindeutig riskanten Subcommands.
  { re: /(^|[\s;&|(])git\s+(?:-\S+\s+)*(push|pull|fetch|clone|reset|clean)(\s|$)/, why: "git außen-sichtbar/verändernd", kind: "git" },
  { re: /:\s*\(\s*\)\s*\{/, why: "verdächtiges Shell-Muster (Fork-Bomb)", kind: "danger" },
  // Hijack-/Egress-Umgebungsvariablen: laden fremde Libs bzw. übernehmen git/ssh nach aussen.
  {
    re: /(^|[\s;&|(])(LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|DYLD_FRAMEWORK_PATH|DYLD_FALLBACK_LIBRARY_PATH|DYLD_FALLBACK_FRAMEWORK_PATH|DYLD_VERSIONED_LIBRARY_PATH|GIT_EXTERNAL_DIFF|GIT_SSH|GIT_SSH_COMMAND|GIT_PROXY_COMMAND|GIT_CONFIG|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_ALTERNATE_OBJECT_DIRECTORIES)=/,
    why: "setzt eine Hijack-/Egress-Umgebungsvariable",
    kind: "danger",
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
 * Grobe, projekt-agnostische Erkennung eines Deploy-/Publish-Befehls. Zweck: die main-Dirt, die ein
 * Deploy-Skript nebenbei erzeugt (typisch ein Versions-Bump), NICHT als versehentlichen main-Edit
 * melden, sondern „Als Release committen" anbieten. Bewusst tolerant — eine Fehlklassifikation ist in
 * BEIDE Richtungen mild (nur anderes Framing/Action; beide zeigen dieselbe main-Dirt an, und die
 * „Als Release committen"-Aktion ist ohnehin immer verfügbar, wenn main dirty ist).
 * Fängt: Skripte/Programme mit Deploy-Verb im Namen (deploy-test.sh, push.ps1, publish.sh, deploy),
 * sowie gängige Infra-/Package-Tools mit Deploy-Subcommand (docker push, kubectl apply, helm upgrade,
 * terraform apply, serverless/sls/fly/vercel/netlify deploy, npm/yarn/pnpm publish|run deploy, gh release).
 */
export function isDeployCommand(command: string): boolean {
  const INTERP = /^(pwsh|powershell|bash|sh|zsh|python3?|node|deno|ruby|perl|npx|env|sudo|command)$/i;
  const VERB_IN_NAME = /(^|[-_./:])(deploy|publish|release)([-_./:0-9]|$)/i; // wort-begrenzt (inkl. „:" für npm-Scripts) → kein „relationship"
  const PUSH_SCRIPT = /(^|\/)push\.(ps1|sh|bat|cmd)$/i; // push.ps1/push.sh als klassisches Deploy-Skript
  const TOOL_SUB: Record<string, RegExp> = {
    docker: /^push$/, "docker-compose": /^push$/, // NUR push ist ein Publish; compose up/down/logs NICHT
    kubectl: /^(apply|rollout)$/, helm: /^(upgrade|install)$/,
    terraform: /^apply$/, pulumi: /^up$/,
    serverless: /^deploy$/, sls: /^deploy$/, netlify: /^deploy$/,
    fly: /^deploy$/, flyctl: /^deploy$/, eb: /^deploy$/, cap: /^deploy$/,
    npm: /^(publish|run)$/, pnpm: /^(publish|run)$/, yarn: /^(publish|deploy|run)$/, bun: /^(publish|run)$/,
    cargo: /^publish$/, gh: /^release$/, heroku: /^(deploy|releases)$/,
  };
  const NEEDS_VERB_ARG = new Set(["vercel", "gcloud", "aws", "ansible-playbook", "ansible"]); // nur mit deploy-Arg
  for (const toks of segmentCommands(command)) {
    if (!toks.length) continue;
    if (toks.some((t) => /^(--dry-run|--dryrun)$/i.test(t))) continue; // Probelauf → kein echter Deploy
    let i = 0;
    while (i < toks.length && INTERP.test(toks[i].split("/").pop() ?? toks[i])) i += 1; // Interpreter überspringen
    const first = toks[i] ?? "";
    if (!first) continue;
    const base = (first.split("/").pop() ?? first).toLowerCase();
    const rest = toks.slice(i + 1);
    // 1) Skript/Programm mit Deploy-Verb im NAMEN (Basename, nicht Pfad → ein Ordner „deploy/" triggert nicht)
    if (VERB_IN_NAME.test(base) || PUSH_SCRIPT.test(base)) return true;
    // 2) Bekanntes Infra-/Package-Tool + Deploy-Subcommand
    const arg1 = (rest.find((t) => !t.startsWith("-")) ?? "").toLowerCase();
    if (TOOL_SUB[base]?.test(arg1)) {
      if (arg1 === "run") return rest.some((t) => VERB_IN_NAME.test(t)); // npm run deploy/publish/release
      return true;
    }
    // 3) Tools, bei denen erst ein deploy-Argument den Ausschlag gibt (vercel --prod, gcloud … deploy)
    if (NEEDS_VERB_ARG.has(base) && rest.some((t) => /^(deploy|--prod)$/i.test(t))) return true;
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
/**
 * SEC-2: Liest der Befehl die Umgebung oder eine Secret-Datei? Bash umgeht den `sensitivePath`-
 * Schutz, der nur für die strukturierten Read/Glob-Tools greift. Konservativ (im Zweifel: fragen);
 * die String-Ebene kann diese Klasse nicht abschließend lösen (echte Grenze = OS-Sandbox).
 */
function envOrSecretRead(s: string): string | null {
  // (a) Ganze Umgebung dumpen (enthält ANTHROPIC_*/GH_TOKEN/AWS_*): `printenv` immer; `env` außer,
  // wenn DIREKT eine Zuweisung folgt (`env NAME=val cmd` setzt Vars, dumpt nicht). Ein NACH-
  // gestelltes bloßes `env` (wie in `env A=b env`) wird weiterhin gefangen (jedes Vorkommen zählt).
  if (/(^|[\s;&|(])printenv(\s|$)/.test(s)) return "liest Umgebungsvariablen (Secrets) — printenv";
  if (/(^|[\s;&|(])env(\s+(?![A-Za-z_][A-Za-z0-9_]*=)|\s*$)/.test(s))
    return "liest die Umgebung (Secrets) — env";
  // (a2) bash-native Voll-Dumps mit Werten: `export -p`, `declare -x|-p`, `typeset -x|-p` — dieselbe
  // Klasse wie printenv/env, nur ein anderes Wort (ein injizierter Agent umginge sonst trivial).
  if (/(^|[\s;&|(])(?:export\s+-p|declare\s+-\w*[xp]|typeset\s+-\w*[xp])(\s|$)/.test(s))
    return "dumpt die exportierte Umgebung (Secrets) — export -p/declare";
  // (b) Interpreter, der die Umgebung dumpt (os.environ / process.env / Ruby|Perl ENV) — der SDK-
  // erbte Env liegt auch im Agenten-Shell-Prozess, den ein `python3 -c`/`node -e` erreicht.
  if (/\bos\.environ\b|\bprocess\.env\b|%ENV\b|\$ENV\{|\bENV\.to_h\b/.test(s))
    return "liest die Umgebung über einen Interpreter (Secrets)";
  // (b2) Interpreter liest gezielt eine SECRET-benannte Variable (getenv/environ.get/ENV[…]) — fängt
  // `os.getenv("ANTHROPIC_API_KEY")`, das weder os.environ (b) noch das $VAR-Muster (c) trifft. Der
  // Var-Name muss ein Secret-Muster tragen, sonst nicht (getenv("PORT") bleibt erlaubt).
  if (/(?:getenv|environ(?:\.get)?|ENV)\s*[([]\s*['"]?[A-Za-z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_KEY|ANTHROPIC|OPENAI|GH_TOKEN|GITHUB_TOKEN|AWS_)/i.test(s))
    return "liest eine Secret-Umgebungsvariable über einen Interpreter";
  // (c) Explizit eine Secret-Umgebungsvariable lesen (echo/printf $KEY …). AWS_ACCESS_KEY_ID,
  // *_KEY_ID und DATABASE_URL mitnehmen.
  if (/\$\{?\s*(?:[A-Za-z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z_]*|[A-Za-z_]+_KEY(?:_ID)?|ANTHROPIC[A-Za-z_]*|OPENAI[A-Za-z_]*|GH_TOKEN|GITHUB_TOKEN|DATABASE_URL|AWS_(?:SECRET|SESSION|ACCESS)[A-Za-z_]*)\b/i.test(s))
    return "liest eine Secret-Umgebungsvariable";
  // (d) Zugriff auf eine Secret-DATEI — LEADING-COMMAND-AGNOSTISCH statt einer Reader-Whitelist
  // (die awk/sed/base64/`< .env`/Interpreter-`open(".env")` durchließ = Whack-a-Mole). Konventionell
  // secret-freie, committte Templates (.env.example/.sample/.template/.dist) vorher rausschneiden,
  // damit `cat .env.example` nicht fragt — ein VERBLIEBENES bare `.env` (z. B. `cp .env.example .env`)
  // löst weiterhin aus.
  const withoutTemplates = s.replace(/\.env\.(?:example|sample|template|dist)\b/gi, " ");
  if (/(?:\.env(?:\.[A-Za-z0-9_]+)?\b|\.envrc\b|\.netrc\b|\.npmrc\b|\.pgpass\b|\.git-credentials\b|\.aws\/|\.ssh\/|\.kube\/|\.gnupg\/|\.config\/(?:gh|gcloud)\/|\.docker\/config\.json\b|\bid_rsa\b|\bid_ed25519\b|\bid_ecdsa\b|\.pem\b)/.test(withoutTemplates))
    return "greift auf eine Secret-Datei zu (.env/.ssh/…)";
  return null;
}

export function classifyBashCommand(command: string): AutoDecision {
  const cmd = command.trim();
  if (!cmd) return ASK("leerer Befehl");

  // ZWEI neutralisierte Sichten, gegen mehrere Umgehungsklassen (CMD-1):
  //  • `neutralized` (Quotes → Leerzeichen): riskante Tokens INNERHALB von Code-Strings
  //    (python -c 'os.system("rm -rf x")') behalten ihre Wortgrenzen und werden gefangen.
  //  • `collapsed` (Quotes UND Backslashes ENTFERNT): zieht per Word-Splitting zerlegte Tokens
  //    wieder zusammen — sonst umgehen `\rm`, `\git push`, `c""url`, `r""m` die Grenzzeichen-Muster
  //    (der Neutralizer strippte bisher keine Backslashes), obwohl die Shell den Token korrekt baut.
  // Beide Sichten expandieren zusätzlich JEDE `${IFS…}`/`$IFS`-Parameter-Expansion zu Leerzeichen:
  // das ist der klassische Klassifizierer-Bypass, der SONST die ganze DANGER-/Secret-Liste entschärft
  // (`rm${IFS}-rf`, `cat${IFS}.env`, `${IFS}printenv`, auch die Modifier-Form `${IFS%??}gh`) — die
  // Shell splittet dort trotzdem in echte Tokens. `[^}]*` deckt Modifier wie `%??`/`:0:1` ab.
  const ifs = /\$\{IFS[^}]*\}|\$IFS\b/g;
  const neutralized = cmd.replace(/['"`]/g, " ").replace(ifs, " ");
  const collapsed = cmd.replace(/[\\'"`]/g, "").replace(ifs, " ");

  for (const d of DANGER) if (d.re.test(neutralized) || d.re.test(collapsed)) return ASK(d.why, d.kind);

  const net = outwardNetworkRisk(neutralized) ?? outwardNetworkRisk(collapsed);
  if (net) return ASK(net, "network");

  // SEC-2: Umgebungs-/Secret-Lesen im Auto-Modus gaten (Bash umgeht den sensitivePath-Schutz der
  // Read-Tools). Der Sidecar erbt ANTHROPIC_*/GH_TOKEN/AWS_* — `env`/`cat .env`/`echo $KEY` würden
  // sie sonst still in den (jetzt redigierten, aber weiterhin sichtbaren) Stream schreiben. Der
  // leading-command-agnostische Datei-Gate fragt bewusst FAIL-SAFE auch, wenn ein Befehl einen
  // Secret-Dateinamen nur ERWÄHNT (z. B. `git commit -m '… .env …'`) — String-Ebene kann „nennt"
  // und „liest" nicht sicher trennen; ein Skip per führendem git/gh übersähe `git commit && cat .env`.
  const secretRead = envOrSecretRead(neutralized) ?? envOrSecretRead(collapsed);
  if (secretRead) return ASK(secretRead, "secret");

  const pkg = pkgManagerRisk(cmd);
  if (pkg) return ASK(pkg, "pkg");

  const git = classifyGit(cmd);
  if (git) return git.decision === "ask" ? { ...git, kind: git.kind ?? "git" } : git;

  const wr = unsafeWriteRedirect(cmd);
  if (wr) return ASK(wr, "write");

  const wo = writesOutsideProject(cmd);
  if (wo) return ASK(wo, "write");

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
function isTrustedFetchHost(host: string): boolean {
  return TRUSTED_FETCH_SUFFIXES.some((s) => host === s || host.endsWith("." + s));
}

/** http(s)-URL robust zerlegen. null = nicht interpretierbar. Host klein, ohne IPv6-Klammern. */
function parseFetchUrl(url: string): { host: string; scheme: string; hasCreds: boolean; pathname: string; search: string } | null {
  try {
    const u = new URL(url.trim());
    return {
      host: u.hostname.toLowerCase().replace(/^\[|\]$/g, ""),
      scheme: u.protocol.replace(/:$/, "").toLowerCase(),
      hasCreds: u.username !== "" || u.password !== "",
      pathname: u.pathname,
      search: u.search,
    };
  } catch {
    return null;
  }
}

/**
 * SSRF-Ziel? — internes/privates/Loopback/Cloud-Metadaten-Ziel. Solche Aufrufe MÜSSEN immer bestätigt
 * werden (nie stillschweigend, nie domänenweit merkbar): sie können lokale Dienste oder Cloud-Metadaten
 * (z. B. 169.254.169.254 → temporäre Cloud-Credentials) treffen. Deckt IPv4/IPv6-Literale + Namensmuster.
 */
function isPrivateOrSsrfHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, ""); // FQDN-Wurzel-Punkt (localhost.) normalisieren
  if (!h) return true; // kein Host → verdächtig
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".intranet") || h.endsWith(".lan") || h.endsWith(".home.arpa")) return true;
  if (h === "metadata.google.internal") return true;
  // IP-Obfuskationen, die curl/der Resolver trotzdem auflöst → als SSRF-Verdacht behandeln:
  //  • Dezimal-Ganzzahl (2130706433 = 127.0.0.1), • Hex (0x7f000001) — kein legitimer Hostname ist so.
  if (/^0x[0-9a-f]+$/.test(h) || /^\d+$/.test(h)) return true;
  if (/^[0-9.]+$/.test(h)) {
    // Nur ein SAUBERES öffentliches dotted-quad ist erlaubt; alles andere (Oktal-Leading-Zero wie
    // 0177.0.0.1, Oktett > 255, ≠ 4 Oktette) ist obfuskiert/ungültig → Verdacht.
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    if (!v4) return true;
    const oct = [v4[1], v4[2], v4[3], v4[4]];
    if (oct.some((o) => +o > 255 || (o.length > 1 && o.startsWith("0")))) return true; // ungültig/oktal
    const a = +oct[0], b = +oct[1];
    if (a === 0 || a === 127 || a === 10) return true; // this-host, loopback, RFC1918 10/8
    if (a === 169 && b === 254) return true; //           link-local INKL. 169.254.169.254 (Cloud-Metadata)
    if (a === 192 && b === 168) return true; //           RFC1918 192.168/16
    if (a === 172 && b >= 16 && b <= 31) return true; //  RFC1918 172.16/12
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    return false; // sonst öffentliches IPv4
  }
  if (h.includes(":")) {
    // IPv6-Literal
    if (h === "::1" || h === "::" || h === "0:0:0:0:0:0:0:1") return true; // loopback/unspecified
    if (h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true; // link-local, ULA
    const mapped = /::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h); // IPv4-mapped
    if (mapped) return isPrivateOrSsrfHost(mapped[1]);
    return false;
  }
  return false;
}

/** Sieht wie kodierte Daten aus (base64/hex/url-safe, ≥24, hohe Entropie, keine reine ID)? → Exfil-Verdacht. */
function looksEncodedBlob(s: string): boolean {
  if (s.length < 24) return false;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(s)) return false; // base64/hex/url-safe-Zeichensatz
  if (/^[0-9]+$/.test(s)) return false; //             reine Ziffern = ID/Nummer, keine kodierten Daten
  const freq: Record<string, number> = {};
  for (const c of s) freq[c] = (freq[c] ?? 0) + 1;
  let entropy = 0;
  for (const c in freq) {
    const p = freq[c] / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy >= 3.5; // hohe Zeichen-Entropie → wirkt zufällig/kodiert (nicht ein strukturierter Slug)
}
function pathHasEncodedBlob(pathname: string): boolean {
  return pathname.split("/").some((seg) => looksEncodedBlob(seg));
}

// Mehrteilige Public-Suffixe, bei denen die registrierbare Domain 3 Labels braucht.
const MULTIPART_TLDS = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk",
  "com.au", "net.au", "org.au", "gov.au", "edu.au", "co.nz", "org.nz", "govt.nz",
  "co.jp", "or.jp", "ne.jp", "go.jp", "com.br", "com.cn", "co.in", "co.za",
]);
/** „Registrierbare" Domain (eTLD+1, Heuristik) — Basis für domänenweites „Immer erlauben". */
export function registrableDomain(host: string): string {
  const parts = host.toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const lastTwo = parts.slice(-2).join(".");
  if (MULTIPART_TLDS.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join(".");
  return lastTwo;
}
/**
 * Für „Immer erlauben" bei WebFetch: die registrierbare Domain, die domänenweit gemerkt werden darf —
 * ODER null, wenn die URL NICHT merk-fähig ist (SSRF/privat, Zugangsdaten, unlesbar, nicht-http). Solche
 * dürfen nie domänenweit freigegeben werden (defense in depth zusätzlich zur Prüfung in classifyToolCall).
 */
export function rememberableFetchDomain(url: string): string | null {
  const u = parseFetchUrl(url);
  if (!u || u.hasCreds || (u.scheme !== "https" && u.scheme !== "http")) return null;
  if (isPrivateOrSsrfHost(u.host)) return null;
  return registrableDomain(u.host) || null;
}

/**
 * Zentrale Policy: darf dieser Tool-Aufruf im "Auto"-Modus ohne Rückfrage laufen?
 * `ctx.isFetchHostApproved` (optional): der Nutzer hat diese Domain per „Immer erlauben" freigegeben.
 */
export function classifyToolCall(
  toolName: string,
  input: Record<string, unknown> | undefined,
  ctx: {
    cwd?: string;
    isFetchHostApproved?: (host: string) => boolean;
    isKindApproved?: (kind: CommandKind) => boolean;
  } = {},
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
    const d = classifyBashCommand(c);
    // Projektweit per „Immer erlauben" gemerkte Kategorie → still erlauben. `danger` (rm/sudo/dd/…)
    // ist NIE merkbar und fragt weiterhin. Kombi-Befehle: klassifiziert wird der ERSTE Treffer, und
    // die DANGER-Prüfung läuft zuerst → ein destruktiver Teil bleibt trotz erlaubtem network/pkg gegated.
    if (d.decision === "ask" && d.kind && d.kind !== "danger" && ctx.isKindApproved?.(d.kind)) return ALLOW;
    return d;
  }

  // Erstanbieter-Orchestrierungs-Tools des In-Process-MCP-Servers „mads". spawn_substreams
  // erzeugt N Sub-Agenten mit einem vom Agenten formulierten „brief" als Prompt — injizierter
  // Repo-/CLAUDE.md-Inhalt könnte darüber (via Autopilot der Subs) ungenehmigt pushen/PRen.
  // Daher: EINMAL bewusst bestätigen (nicht pro URL). Übrige mads-Tools bleiben erlaubt.
  if (toolName === "mcp__mads__spawn_substreams")
    return ASK("startet neue Sub-Streams (eigener Worktree/Branch, Autopilot) — bewusst bestätigen");
  if (toolName.startsWith("mcp__mads__")) return ALLOW;

  // WebFetch: GET + Zusammenfassung. Sanktionierter Netz-Kanal — die zwei realen Gefahren sind
  // EXFILTRATION (Daten IN der URL an einen Angreifer-Host) und SSRF (internes/Metadaten-Ziel).
  // Ein reiner Lese-Aufruf trägt praktisch keine Daten nach aussen → wird erlaubt (kein nerviges
  // per-URL-Nachfragen). Gefragt wird nur bei echtem Risiko-Signal; „Immer erlauben" merkt die
  // ganze DOMAIN (nicht die einzelne URL). SSRF wird IMMER gefragt, nie gemerkt.
  if (toolName === "WebSearch") return ALLOW; // Suche → fester Provider, kein wählbarer Ziel-Host
  if (toolName === "WebFetch") {
    const url = String(input?.url ?? "");
    const u = parseFetchUrl(url);
    if (!u) return ASK("WebFetch: URL nicht interpretierbar — bewusst bestätigen");
    if (u.scheme !== "https" && u.scheme !== "http") return ASK(`WebFetch: ungewöhnliches Schema „${u.scheme}“ — bewusst bestätigen`);
    if (u.hasCreds) return ASK("WebFetch-URL enthält Zugangsdaten (user:pass@) — bewusst bestätigen");
    if (isPrivateOrSsrfHost(u.host)) return ASK(`WebFetch auf internes/privates Ziel „${u.host}“ (SSRF) — bewusst bestätigen`);
    const hits = findSecrets(url);
    if (hits.length) return ASK(`WebFetch-URL enthält ein mögliches Secret (${hits[0].kind}) — Exfiltration verhindern`);
    // Kuratierte ODER vom Nutzer per „Immer erlauben" freigegebene Domain → still (auch mit Query).
    if (isTrustedFetchHost(u.host) || ctx.isFetchHostApproved?.(u.host)) return ALLOW;
    // Unbekannter öffentlicher Host: datentragende URL = möglicher Exfil-Kanal → einmal je Domain
    // bestätigen. Reiner Lese-Aufruf (keine Query, kein kodierter Pfad-Blob) → erlauben.
    if (u.search && u.search !== "?")
      return ASK(`WebFetch auf „${u.host}“ mit Query-Parametern — mögliche Exfiltration; „Immer erlauben“ merkt die ganze Domain`);
    if (pathHasEncodedBlob(u.pathname))
      return ASK(`WebFetch auf „${u.host}“ mit kodiert wirkendem Pfad-Segment — mögliche Exfiltration bestätigen`);
    return ALLOW;
  }

  // Drittanbieter-MCP-Tools, Task, Unbekanntes → fragen.
  return ASK(`Tool „${toolName}“ nicht als auto-sicher eingestuft`);
}
