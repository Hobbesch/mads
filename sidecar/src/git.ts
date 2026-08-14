/**
 * Git-Worktree- + GitHub-Operationen für den Sidecar (P3/P4).
 *
 * Worktrees AUSSERHALB des Repos unter ~/mads-worktrees/<repo-slug>/<agentId>
 * (paix-konform). GitHub via `gh` CLI (erbt die Keychain-Auth des Nutzers).
 * Befehle werfen NICHT bei non-zero — wir klassifizieren die Ausgabe selbst,
 * um Eskalationen (push rejected, conflict, …) zu erkennen.
 *
 * Siehe docs/research/github-multiagent.md und docs/design/04-sub-agents.md.
 */
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { ensureMadsDir } from "./persistence.js";
import type { EscalationKind, PullRequestInfo, PrChecksState } from "../../shared/protocol.js";
import { scanSecrets, type SecretHit } from "../../shared/secrets.js";
import { log } from "./io.js";
import { planAdrCollisionRenames } from "../../shared/adr.js";
import { isArtifactPath } from "../../shared/commit-hygiene.js";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(cmd: string, args: string[], cwd?: string, timeoutMs?: number): Promise<RunResult> {
  // git/gh dürfen NIE unbegrenzt hängen. GIT_TERMINAL_PROMPT=0 lässt git bei fehlenden
  // Credentials SOFORT scheitern statt interaktiv (ohne Terminal) auf stdin zu warten —
  // genau dieser Credential-Prompt-Hang verkeilte den open_project/Reconcile-Fetch auf einem
  // divergierten Repo. Der Credential-Helper (osxkeychain) liefert gespeicherte Logins
  // weiterhin. Plus Default-Timeout für git/gh, damit auch ein Netz-Stall nie ewig blockiert.
  const isVcs = cmd === "git" || cmd === "gh";
  return new Promise((resolve) => {
    // timeout > 0 → execFile killt den Prozess nach Ablauf (err.killed) → code != 0.
    execFile(
      cmd,
      args,
      {
        cwd,
        maxBuffer: 16 * 1024 * 1024,
        // Immer ein Wall-Clock-Limit: git/gh 60 s; sonstige (z. B. Repo-Build/Test-Skripte im
        // Clean-Code-Gate) 10 min — ein hängendes Skript darf den Gate/Sidecar nicht deadlocken
        // (err.killed → code != 0 → wird als Fehlschlag behandelt).
        timeout: timeoutMs ?? (isVcs ? 60_000 : 600_000),
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
        resolve({ code, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
      },
    );
  });
}
const git = (args: string[], cwd?: string) => run("git", args, cwd);
const gh = (args: string[], cwd?: string, timeoutMs?: number) => run("gh", args, cwd, timeoutMs);
/** GitHub-Aufrufe können bei Netzproblemen hängen — der Reconcile darf nie blockieren. */
const GH_TIMEOUT_MS = 15_000;

/**
 * Fingerprint des UNCOMMITTETEN Worktree-Zustands (Fremd-Edit-Schutz): kombiniert Datei-Status,
 * den Inhalt getrackter Änderungen (`diff HEAD`) und den Inhalt untrackter (nicht-ignorierter)
 * Dateien zu einem Hash. Ändert etwas den Worktree, während der Agent RUHT (Fremd-Edit durch einen
 * Menschen/anderen Prozess), weicht dieser Fingerprint vom zuletzt beim Turn-Ende erfassten ab —
 * dann committet der Autopilot NICHT blind mit `git add -A`, sondern hält an. `.git`-Änderungen
 * (Index/HEAD) zählen bewusst NICHT rein; nur Arbeitsbaum-Inhalt.
 */
export async function worktreeFingerprint(wt: string): Promise<string> {
  const status = (await run("git", ["-C", wt, "status", "--porcelain"], wt)).stdout;
  const diff = (await run("git", ["-C", wt, "diff", "HEAD"], wt)).stdout;
  const untracked = (await run("git", ["-C", wt, "ls-files", "--others", "--exclude-standard"], wt)).stdout
    .split("\n")
    .filter(Boolean);
  const h = createHash("sha256").update(status).update("\0").update(diff);
  // Große untrackte Dateien (Dumps/Datasets/Logs, die NICHT gitignored sind) nicht voll in den Hash
  // lesen — synchroner Read würde den Event-Loop blockieren + Speicher spiken. Ab dem Cap genügt
  // size+mtime als Änderungssignal (ändert sich der Inhalt, ändert sich i. d. R. beides).
  const UNTRACKED_HASH_CAP = 2 * 1024 * 1024;
  for (const f of untracked) {
    h.update("\0").update(f).update("\0");
    try {
      const st = statSync(join(wt, f));
      if (st.size > UNTRACKED_HASH_CAP) h.update(`__big__:${st.size}:${st.mtimeMs}`);
      else h.update(readFileSync(join(wt, f)));
    } catch {
      /* Datei verschwand zwischen ls-files und read — egal, der Status-Teil deckt das ab */
    }
  }
  return h.digest("hex");
}

export function repoSlug(repoRoot: string): string {
  return basename(repoRoot);
}
export function worktreePathFor(repoRoot: string, agentId: string): string {
  return join(homedir(), "mads-worktrees", repoSlug(repoRoot), agentId);
}

/**
 * Alle mads-Worktrees dieses Repos auflisten (unter ~/mads-worktrees/<slug>/<agentId>).
 * Liefert agentId (= Verzeichnisname), Pfad und Branch — Basis fürs Wieder-Anbieten
 * verwaister Branches beim Projekt-Öffnen.
 */
export async function discoverWorktrees(
  repoRoot: string,
): Promise<{ agentId: string; path: string; branch: string }[]> {
  const base = join(homedir(), "mads-worktrees", repoSlug(repoRoot));
  const r = await git(["-C", repoRoot, "worktree", "list", "--porcelain"], repoRoot);
  if (r.code !== 0) return [];
  const out: { agentId: string; path: string; branch: string }[] = [];
  let curPath = "";
  let curBranch = "";
  const flush = () => {
    if (curPath && (curPath === base || curPath.startsWith(base + "/"))) {
      out.push({ agentId: basename(curPath), path: curPath, branch: curBranch.replace(/^refs\/heads\//, "") });
    }
    curPath = "";
    curBranch = "";
  };
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      curPath = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ")) {
      curBranch = line.slice("branch ".length).trim();
    }
  }
  flush();
  return out;
}

/**
 * Erkennt einen mads-Worktree-Pfad, der zur kanonischen Struktur `…/mads-worktrees/<slug>/<agentId>`
 * gehört, aber NICHT dem lokalen Kanon-Pfad (`worktreePathFor`) entspricht — der klassische
 * Cross-Machine-Fall: das Repo wurde von einem Mac (`/Users/amedici/…`) auf einen anderen mit anderem
 * Home (`/Users/alessandromedici/…`) kopiert. Der eingebackene absolute `worktreePath` (Registry +
 * `.git/worktrees/<id>/gitdir`) zeigt dann ins Leere, obwohl Branch (`mads/<name>`) und Transcripts
 * (per agentId) intakt mitkopiert wurden. Separator-sicher über die letzten drei Pfad-Segmente
 * statt String-Präfixen — der lokale Worktree lässt sich vollständig aus repoRoot+agentId ableiten.
 */
export function isForeignMadsWorktree(worktreePath: string, repoRoot: string, agentId: string): boolean {
  if (!worktreePath || worktreePath === worktreePathFor(repoRoot, agentId)) return false; // schon lokal-kanonisch
  const p = worktreePath.replace(/[/\\]+$/, "");
  return (
    basename(p) === agentId &&
    basename(dirname(p)) === repoSlug(repoRoot) &&
    basename(dirname(dirname(p))) === "mads-worktrees"
  );
}

/**
 * Cross-Machine-Reparatur eines Sub-/Review-Streams: den unter einem fremden Home verwaisten Worktree
 * auf den LOKALEN Kanon-Pfad (`worktreePathFor`) umziehen. Branch + Transcripts sind kopiert und
 * intakt — nur das Arbeitsverzeichnis fehlt lokal. Vorgehen:
 *   • Existiert der lokale Pfad bereits (z. B. `~/mads-worktrees` wurde mitkopiert) → nur den
 *     git-Admin-Link reparieren (`worktree repair`) und den lokalen Pfad zurückgeben.
 *   • Sonst: verwaiste (fremde) Worktree-Admin-Einträge prunen — das gibt den Branch frei, sonst
 *     scheitert `worktree add` an „already used by worktree at …fremder Pfad" — und den lokalen
 *     Worktree aus dem BESTEHENDEN Branch neu auschecken (`worktree add`, KEIN `-b`).
 * Fehlt der Branch lokal, ist nichts wiederherstellbar → `{ ok:false }`. Best-effort git; wirft nie.
 */
export async function relocateWorktree(
  repoRoot: string,
  agentId: string,
  branch: string,
): Promise<{ ok: true; path: string; recreated: boolean } | { ok: false; error: string }> {
  const local = worktreePathFor(repoRoot, agentId);
  if (existsSync(local)) {
    // Lokaler Worktree ist vorhanden (mitkopiert) — nur der Admin-Link kann noch aufs fremde Home zeigen.
    // `worktree repair` richtet die Zwei-Wege-Verknüpfung (repo ↔ Worktree) wieder ein; No-Op, wenn heil.
    await git(["-C", repoRoot, "worktree", "repair", local], repoRoot);
    return { ok: true, path: local, recreated: false };
  }
  // Fremde gitdir-Zeiger (…/amedici/… existiert lokal nicht) → prune entfernt die Admin-Einträge und
  // gibt den Branch frei. Ohne prune: „fatal: '<branch>' is already used by worktree at …".
  await git(["-C", repoRoot, "worktree", "prune"], repoRoot);
  const hasBranch = await git(["-C", repoRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot);
  if (hasBranch.code !== 0) return { ok: false, error: `Branch ${branch} existiert lokal nicht` };
  const add = await git(["-C", repoRoot, "worktree", "add", local, branch], repoRoot);
  if (add.code !== 0) return { ok: false, error: add.stderr || add.stdout };
  try {
    ensureMadsDir(local); // mads' eigenes .mads/ im neuen Worktree sofort git-unsichtbar machen (wie createWorktree)
  } catch (e) {
    log(`[git] relocate: .mads-Schutz im Worktree ${local} fehlgeschlagen: ${String(e)}`);
  }
  return { ok: true, path: local, recreated: true };
}

export async function getRepoInfo(
  repoRoot: string,
): Promise<{ owner: string; repo: string; defaultBranch: string } | null> {
  const remote = await git(["-C", repoRoot, "remote", "get-url", "origin"], repoRoot);
  if (remote.code !== 0) return null;
  // https://github.com/owner/repo.git  ODER  git@github.com:owner/repo.git
  const m = remote.stdout.trim().match(/[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) return null;
  let defaultBranch = "main";
  const head = await git(["-C", repoRoot, "symbolic-ref", "refs/remotes/origin/HEAD"], repoRoot);
  if (head.code === 0) {
    const hm = head.stdout.trim().match(/origin\/(.+)$/);
    if (hm) defaultBranch = hm[1];
  }
  return { owner: m[1], repo: m[2], defaultBranch };
}

export function classifyGitError(text: string): EscalationKind | undefined {
  const t = text.toLowerCase();
  if (/\[rejected\]|non-fast-forward|updates were rejected|failed to push|cannot lock ref|stale info|but expected/.test(t)) return "push_rejected";
  if (/conflict|could not apply|needs merge/.test(t)) return "merge_conflict";
  if (/protected branch|protection|not allowed to push/.test(t)) return "protection_blocked";
  if (/authentication|could not read username|permission denied/.test(t)) return "auth_broken";
  return undefined;
}

// ─── Lokale Dev-Config seeden ────────────────────────────────────────────────
// Ein frischer Worktree enthält NUR getrackte Dateien. Die lokale Config, die eine App zum
// Laufen braucht (Secrets/Keys: appsettings.json, client/.env …), liegt per .gitignore NICHT
// im Repo → fehlt dem Stream. Wir ziehen sie aus dem Haupt-Checkout nach.
//
// „Was ist lokale Config?" ermitteln wir NICHT per hartkodierter Namensliste, sondern aus git
// selbst: `git ls-files -o -i --exclude-standard --directory` listet exakt die *vorhandenen,
// aber gitignorierten* Dateien (die projekt-spezifische Wahrheit). `--directory` fasst voll-
// ignorierte Ordner zu EINER Zeile zusammen (Boba: 21 statt 37991 Einträge) → nie node_modules
// durchlaufen. Wir klassifizieren die Treffer per Basename in confident/uncertain/junk und
// kopieren nur „confident". So werden weder Daten-Dumps (data/*.sql) noch in einem ignorierten
// Ordner vergrabene Prod-Snapshots (backups/*/config/.env) je kopiert.

const SEED_MAX_BYTES = 5 * 1024 * 1024; // Config ist klein; schützt vor versehentlichem Riesen-Match

// „confident": mit hoher Sicherheit lokale App-Config, die zum Laufen gebraucht wird.
const CONFIG_CONFIDENT_RE: RegExp[] = [
  /^\.env(\..+)?$/i, //          .env, .env.local, .env.production
  /^appsettings(\..+)?\.json$/i, // .NET
  /^local\.settings\.json$/i, //  Azure Functions
  /^secrets\.json$/i,
  /^.+\.secrets?\.json$/i, //     db.secrets.json / x.secret.json
  /^config\.local\.[^.]+$/i, //   config.local.js/json/…
  /^.+\.local\.(json|ya?ml|toml)$/i, // settings.local.json, x.local.yaml
  /^google-services\.json$/i,
  /^GoogleService-Info\.plist$/i,
  /^firebase.*\.json$/i,
  /^serviceAccount.*\.json$/i,
  /^credentials\.json$/i,
];
// Getrackte Vorlagen (…example…/…sample…) sind ohnehin schon im Worktree — nie als „confident".
const CONFIG_TEMPLATE_RE = /(^|[.\-_])(example|sample|template|dist)([.\-_]|$)/i;
// „uncertain": evtl. sensibel (Schlüssel/Zert.) oder generisch → nur als Vorschlag anbieten.
const CONFIG_UNCERTAIN_RE: RegExp[] = [
  /\.(pem|key|crt|cer|pfx|p12|jks|keystore|kdbx)$/i, // Schlüssel/Zertifikate
  /^.+\.(ini|toml|conf)$/i,
  /^.+\.ya?ml$/i,
  /^config\.json$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /.*credentials.*\.json$/i,
];
// Reiner Müll / Daten-Dumps / Kompilate → nie kopieren.
const SEED_JUNK_RE: RegExp[] = [
  /^\.DS_Store$/, /^Thumbs\.db$/i, /^desktop\.ini$/i, /~$/,
  /\.(log|swp|swo|pyc|pyo|class|o|obj)$/i,
  /\.(sql|dump|bak|db|sqlite\d?|mdb)$/i,
  /\.(gz|tgz|zip|tar|7z|rar)$/i,
  /\.(gguf|safetensors|bin|onnx|pt|pth|ckpt)$/i,
];
// Ordnernamen, die (an BELIEBIGER Pfad-Stelle) den ganzen Pfad als Artefakt/Junk markieren.
const SEED_SKIP_SEGMENTS = new Set([
  ".git", ".mads", ".svn", ".hg",
  "node_modules", "bower_components", "vendor",
  "dist", "build", "out", "bin", "obj", "target",
  ".venv", "venv", "virtualenv",
  ".next", ".nuxt", ".svelte-kit", ".angular", ".parcel-cache", ".turbo", ".cache",
  "coverage", "htmlcov", ".pytest_cache", ".mypy_cache", ".ruff_cache", "__pycache__",
  ".idea", ".vscode", ".vs", ".claude", ".fleet", ".zed",
  "logs", "tmp", "temp",
  "backups", "backup", "Pods", "DerivedData",
]);
// Ignorierte ORDNER mit diesen Namen als Hinweis anbieten (nicht auto-kopieren — Vergraben-Gefahr).
const CONFIG_DIR_HINT = new Set([
  "config", "configs", ".config", "secrets", "secret", "certs", "certificates", "credentials", "keys",
]);

function classifyIgnoredFile(relPath: string): "confident" | "uncertain" | "skip" {
  if (relPath.split("/").some((s) => SEED_SKIP_SEGMENTS.has(s))) return "skip";
  const base = relPath.split("/").pop() ?? "";
  if (SEED_JUNK_RE.some((re) => re.test(base))) return "skip";
  if (CONFIG_CONFIDENT_RE.some((re) => re.test(base)) && !CONFIG_TEMPLATE_RE.test(base)) return "confident";
  if (CONFIG_UNCERTAIN_RE.some((re) => re.test(base))) return "uncertain";
  return "skip";
}

/**
 * Ermittelt aus git die vorhandenen, gitignorierten Dateien des Haupt-Checkouts und klassifiziert
 * sie: `confident` (lokale App-Config → wird kopiert), `uncertain` (Schlüssel/generisch → Vorschlag)
 * und `dirHints` (ignorierte Ordner mit Config-Namen → Hinweis, nicht auto-kopiert). Read-only.
 */
function detectIgnoredConfig(repoRoot: string): { confident: string[]; uncertain: string[]; dirHints: string[] } {
  const confident: string[] = [];
  const uncertain: string[] = [];
  const dirHints: string[] = [];
  let out = "";
  try {
    // --directory: voll-ignorierte Ordner zu EINER Zeile (Perf!). -z: NUL-getrennt, kein Quoting.
    out = execFileSync(
      "git",
      ["-C", repoRoot, "ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z"],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return { confident, uncertain, dirHints }; // kein git / Fehler → leer
  }
  for (const entry of out.split("\0")) {
    const p = entry.trim();
    if (!p) continue;
    if (p.endsWith("/")) {
      // Voll-ignorierter Ordner: NIE automatisch expandieren (in backups/*/config/.env stecken
      // z. B. Prod-Secrets). Nur als Hinweis anbieten, wenn der Name nach Config aussieht.
      const segs = p.split("/").filter(Boolean);
      if (!segs.some((s) => SEED_SKIP_SEGMENTS.has(s)) && CONFIG_DIR_HINT.has((segs.at(-1) ?? "").toLowerCase())) {
        dirHints.push(p);
      }
      continue;
    }
    const cls = classifyIgnoredFile(p);
    if (cls === "confident") confident.push(p);
    else if (cls === "uncertain") uncertain.push(p);
  }
  confident.sort();
  uncertain.sort();
  dirHints.sort();
  return { confident, uncertain, dirHints };
}

/**
 * Legt `<repoRoot>/.mads/worktree-seed` beim ERSTEN Öffnen an (generate-if-absent → self-healing,
 * überschreibt nie eine vom Nutzer editierte Liste). Inhalt = automatisch erkannte lokale Config:
 * confident-Treffer aktiv, uncertain/Ordner auskommentiert (`# ? …`) zum Opt-in. Voraussetzung:
 * `.mads/` existiert bereits (ensureMadsDir lief). Gibt zurück, ob generiert wurde + Zähler.
 */
export function ensureWorktreeSeedFile(repoRoot: string): { generated: boolean; confident: number; uncertain: number } {
  const seedPath = join(repoRoot, ".mads", "worktree-seed");
  if (existsSync(seedPath)) return { generated: false, confident: 0, uncertain: 0 };
  const det = detectIgnoredConfig(repoRoot);
  const lines: string[] = [
    "# mads worktree-seed — lokale, gitignorte Dev-Config, die in JEDEN neuen Stream kopiert wird,",
    "# damit er sofort front-/backend-lauffähig ist. Automatisch beim ersten Öffnen ermittelt",
    "# (git-ignorierte, projekt-lokale Dateien). Ein Pfad pro Zeile, relativ zum Repo-Root.",
    "#   • aktive (nicht auskommentierte) Zeile → wird kopiert",
    "#   • '#'-Zeile = aus; '# ? pfad' = Vorschlag → zum Aktivieren '# ? ' entfernen",
    "# Bereits im Stream vorhandene (getrackte) Dateien werden NIE überschrieben.",
    "",
  ];
  if (det.confident.length) {
    lines.push("# — erkannte lokale Config (wird kopiert) —");
    for (const p of det.confident) lines.push(p);
  } else {
    lines.push("# (keine eindeutige lokale Config erkannt — bei Bedarf Pfade unten eintragen)");
  }
  if (det.uncertain.length) {
    lines.push("", "# — unsicher: Schlüssel/Zertifikate/generische Config — bei Bedarf aktivieren —");
    for (const p of det.uncertain) lines.push(`# ? ${p}`);
  }
  if (det.dirHints.length) {
    lines.push("", "# — ignorierte Ordner mit möglicher Config (nicht auto-kopiert; einzelne Dateien eintragen) —");
    for (const d of det.dirHints) lines.push(`# ? ${d}`);
  }
  lines.push("");
  try {
    writeFileSync(seedPath, lines.join("\n"), "utf8");
    return { generated: true, confident: det.confident.length, uncertain: det.uncertain.length };
  } catch {
    return { generated: false, confident: 0, uncertain: 0 };
  }
}

/**
 * Kopiert lokale, gitignorte Dev-Config aus dem HAUPT-Checkout in einen frisch erzeugten Worktree —
 * damit ein Stream sofort front-/backend-lauffähig ist. Quelle:
 *   1) `.mads/worktree-seed` (beim ersten Öffnen auto-generiert, vom Nutzer kuratierbar) — aktive Zeilen,
 *   2) zusätzlich live per git erkannte confident-Config, sofern in (1) NICHT erwähnt (respektiert
 *      bewusste Opt-outs / auskommentierte Zeilen und zieht neu hinzugekommene Dateien nach).
 * Sicher & projekt-agnostisch: überschreibt NIE eine im Worktree vorhandene (getrackte) Datei,
 * kopiert nur reguläre Dateien ≤ 5 MB, keine Symlinks/Ordner, keine absoluten/`..`-Pfade.
 * Gibt die kopierten Relativpfade zurück. Best effort — Fehler einzelner Dateien werden ignoriert.
 */
export function seedLocalDevFiles(repoRoot: string, worktree: string): string[] {
  const copied: string[] = [];
  const seen = new Set<string>();
  const tryCopy = (rel: string): void => {
    if (!rel || seen.has(rel) || isAbsolute(rel) || rel.split(sep).includes("..")) return;
    seen.add(rel);
    try {
      const dst = join(worktree, rel);
      if (existsSync(dst)) return; // im Worktree schon vorhanden (getrackt) → nie überschreiben
      const src = join(repoRoot, rel);
      const st = lstatSync(src);
      if (!st.isFile() || st.size > SEED_MAX_BYTES) return; // keine Symlinks/Ordner/Riesen
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      copied.push(rel);
    } catch {
      /* einzelne Datei nicht kopierbar → überspringen */
    }
  };

  // 1) Projekt-Liste `.mads/worktree-seed` parsen: aktive Pfade + „erwähnte" (auch auskommentierte).
  const activePaths: string[] = [];
  const mentioned = new Set<string>();
  try {
    for (const raw of readFileSync(join(repoRoot, ".mads", "worktree-seed"), "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("#")) {
        const m = line.match(/^#\s*\??\s*(\S+)/); // '# ? pfad' → Pfad als „erwähnt" (bewusstes Opt-out)
        if (m) mentioned.add(m[1]);
        continue;
      }
      const token = line.split(/\s+/)[0]; // aktive Zeile: Pfad (evtl. mit Inline-Notiz dahinter)
      activePaths.push(token);
      mentioned.add(token);
    }
  } catch {
    /* keine Liste → nur Live-Erkennung unten */
  }
  for (const rel of activePaths) tryCopy(rel);

  // 2) Live per git erkannte confident-Config zusätzlich — aber nur, was in der Liste NICHT erwähnt
  //    ist (respektiert Opt-outs; zieht nach dem ersten Öffnen neu entstandene Config automatisch nach).
  try {
    for (const rel of detectIgnoredConfig(repoRoot).confident) {
      if (!mentioned.has(rel)) tryCopy(rel);
    }
  } catch (e) {
    log(`[git] seed: git-Erkennung fehlgeschlagen: ${String(e)}`);
  }

  return copied;
}

export async function createWorktree(
  repoRoot: string,
  agentId: string,
  branch: string,
  baseRef: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  await git(["-C", repoRoot, "fetch", "origin"], repoRoot);
  const path = worktreePathFor(repoRoot, agentId);
  const r = await git(["-C", repoRoot, "worktree", "add", "-b", branch, path, baseRef], repoRoot);
  if (r.code !== 0) return { ok: false, error: r.stderr || r.stdout };
  // mads' eigenes `.mads/` im NEUEN Worktree sofort git-unsichtbar machen (legt `.mads/.gitignore` = `*`).
  // Das geschah bisher NUR im Haupt-Checkout — in Worktrees waren Anhänge dadurch weder ignoriert noch
  // gefiltert, und der Autopilot committete sie per `git add -A` bis nach main (echte xlsx-Anhänge sind
  // so in einem Projekt gelandet). Idempotent; muss VOR dem ersten Anhang passieren.
  try {
    ensureMadsDir(path);
  } catch (e) {
    log(`[git] .mads-Schutz im Worktree fehlgeschlagen: ${String(e)}`);
  }
  // Lokale, gitignorte Dev-Config aus dem Haupt-Checkout nachziehen → Stream sofort lauffähig.
  try {
    const seeded = seedLocalDevFiles(repoRoot, path);
    if (seeded.length)
      log(`[git] worktree ${branch}: ${seeded.length} lokale Dev-Datei(en) geseedet (${seeded.slice(0, 6).join(", ")}${seeded.length > 6 ? " …" : ""})`);
  } catch (e) {
    log(`[git] seedLocalDevFiles fehlgeschlagen: ${String(e)}`);
  }
  return { ok: true, path };
}

function sameFileContent(a: string, b: string): boolean {
  try {
    if (lstatSync(a).size !== lstatSync(b).size) return false;
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

export interface ReclaimResult {
  /** Dateien, die es im Haupt-Checkout NICHT gab → dorthin kopiert (der eigentliche Verlust-Fix). */
  restored: string[];
  /** Dateien, die im Haupt abweichen → nach `.mads/reclaimed/<agentId>/…` gesichert (nicht überschrieben). */
  reclaimed: string[];
}

/**
 * Umkehrung von `seedLocalDevFiles` beim Cleanup: BEVOR ein Worktree (force-)entfernt wird, die lokale,
 * gitignorte Dev-Config (Secrets/Keys) RETTEN — sie war nie in git (gitignored) und `worktree remove
 * --force` löscht sie sonst spurlos (genau der Fall: ein im Stream angelegter API-Key verschwindet
 * beim Aufräumen). Symmetrisch & konservativ:
 *   • Kandidaten = aktive `.mads/worktree-seed`-Pfade + im STREAM live erkannte „confident"-Config
 *     (fängt eine ERST im Stream erzeugte Datei wie appsettings.json, die der Haupt-Checkout nie hatte);
 *     bewusste Opt-outs (auskommentierte Zeilen) werden respektiert.
 *   • Gleiche Guards wie beim Seeden: keine Symlinks/Ordner/`..`/absoluten Pfade, ≤ 5 MB, nie Junk/Dumps.
 *   • Fehlt die Datei im Haupt → kopieren (`restored`). Existiert sie & weicht ab → NICHT überschreiben,
 *     sondern nach `.mads/reclaimed/<agentId>/…` sichern (`reclaimed`) → es geht nichts verloren, der
 *     Mensch entscheidet, ob er die Stream-Version übernimmt. Best effort.
 */
export function reclaimSeedFiles(repoRoot: string, worktree: string): ReclaimResult {
  const restored: string[] = [];
  const reclaimed: string[] = [];
  const agentId = basename(worktree) || "stream";
  const seen = new Set<string>();
  const candidates: string[] = [];
  const mentioned = new Set<string>();

  // Kuratierte Liste: aktive Pfade = Kandidat, '#'/'# ?' = bewusstes Opt-out (nicht zurückspiegeln).
  try {
    for (const raw of readFileSync(join(repoRoot, ".mads", "worktree-seed"), "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("#")) {
        const m = line.match(/^#\s*\??\s*(\S+)/);
        if (m) mentioned.add(m[1]);
        continue;
      }
      const token = line.split(/\s+/)[0];
      candidates.push(token);
      mentioned.add(token);
    }
  } catch {
    /* keine Liste → nur Live-Erkennung unten */
  }
  try {
    for (const rel of detectIgnoredConfig(worktree).confident) if (!mentioned.has(rel)) candidates.push(rel);
  } catch {
    /* keine git-Erkennung → nur kuratierte Liste */
  }

  for (const rel of candidates) {
    if (!rel || seen.has(rel) || isAbsolute(rel) || rel.split(sep).includes("..")) continue;
    seen.add(rel);
    try {
      const src = join(worktree, rel);
      const st = lstatSync(src);
      if (!st.isFile() || st.size > SEED_MAX_BYTES) continue; // kein Symlink/Ordner/Riese
      const dst = join(repoRoot, rel);
      if (!existsSync(dst)) {
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(src, dst);
        restored.push(rel);
      } else if (!sameFileContent(src, dst)) {
        const bak = join(repoRoot, ".mads", "reclaimed", agentId, rel);
        mkdirSync(dirname(bak), { recursive: true });
        copyFileSync(src, bak);
        reclaimed.push(rel);
      }
    } catch {
      /* einzelne Datei nicht rettbar → überspringen */
    }
  }
  restored.sort();
  reclaimed.sort();
  return { restored, reclaimed };
}

export async function removeWorktree(repoRoot: string, path: string, branch?: string): Promise<ReclaimResult> {
  // VOR dem force-Entfernen die gitignorte Dev-Config retten (Secrets/Keys gehen sonst verloren).
  // Best effort — blockiert das Cleanup nie.
  let salvage: ReclaimResult = { restored: [], reclaimed: [] };
  try {
    if (existsSync(path)) {
      salvage = reclaimSeedFiles(repoRoot, path);
      if (salvage.restored.length || salvage.reclaimed.length)
        log(
          `[git] Cleanup ${branch ?? basename(path)}: gitignorte Dev-Config bewahrt — ` +
            `${salvage.restored.length} gerettet` +
            (salvage.reclaimed.length ? `, ${salvage.reclaimed.length} nach .mads/reclaimed/ gesichert` : "") +
            ` (${[...salvage.restored, ...salvage.reclaimed].slice(0, 6).join(", ")})`,
        );
    }
  } catch (e) {
    log(`[git] reclaimSeedFiles fehlgeschlagen: ${String(e)}`);
  }
  await git(["-C", repoRoot, "worktree", "remove", "--force", path], repoRoot);
  if (branch) await git(["-C", repoRoot, "branch", "-D", branch], repoRoot);
  await git(["-C", repoRoot, "worktree", "prune"], repoRoot);
  return salvage;
}

/**
 * Lokale „Reste" eines Worktrees: ungespeicherte Änderungen ODER Commits, die
 * nicht im Remote-Branch liegen. Beides bedeutet: hier könnte Arbeit stecken, die
 * nirgends sonst existiert → ein gemergter Stream darf dann NICHT still gelöscht
 * werden. Fehlt origin/<branch> (nie gepusht), gilt alles als ungepusht (unsafe).
 */
export async function worktreeResidue(
  worktree: string,
  branch: string,
): Promise<{ dirty: boolean; unpushed: number }> {
  const dirtyR = await git(["-C", worktree, "status", "--porcelain"], worktree);
  const up = await git(["-C", worktree, "rev-list", "--count", `origin/${branch}..${branch}`], worktree);
  const unpushed = up.code === 0 ? parseInt(up.stdout.trim() || "0", 10) : Number.MAX_SAFE_INTEGER;
  return { dirty: dirtyR.stdout.trim().length > 0, unpushed };
}

export interface FastForwardResult {
  /** Anzahl vorgezogener Commits (>0 = main wurde aktualisiert). */
  ff: number;
  /** Wie viele Commits main hinter origin/<default> lag/liegt (auch wenn ff=0). */
  behind: number;
  /** Falls NICHT vorgezogen wurde: warum. ("unknown" = FF scheiterte unerwartet, z. B. Remote-Race.) */
  blocked: "diverged" | "dirty" | "detached" | "unknown" | null;
}

/**
 * Haupt-Checkout (main) per fast-forward auf origin/<default> ziehen — damit der
 * lokale Stand nach Merges auf einem anderen Rechner aktuell ist.
 *
 * Sicher, aber NICHT übervorsichtig: ein fast-forward ändert nur getrackte Dateien
 * und kann keine Konflikte erzeugen (HEAD muss Vorfahr von origin/<default> sein).
 * Deshalb blockieren **untracked** Dateien (z. B. mads' eigenes `.mads/`) den FF
 * NICHT mehr — nur echte uncommittete Änderungen an getrackten Dateien (`-uno`) tun
 * das, weil die ein FF zu Recht ablehnen würde. Liefert behind/blocked auch dann,
 * wenn nicht vorgezogen werden konnte (→ der Aufrufer kann warnen statt still
 * gegen einen veralteten Stand weiterzuarbeiten).
 */
export async function fastForwardMain(repoRoot: string, defaultBranch: string): Promise<FastForwardResult> {
  const cur = (await git(["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"], repoRoot)).stdout.trim();
  const base = `origin/${defaultBranch}`;
  const behind = parseInt((await git(["-C", repoRoot, "rev-list", "--count", `HEAD..${base}`], repoRoot)).stdout.trim() || "0", 10);
  const ahead = parseInt((await git(["-C", repoRoot, "rev-list", "--count", `${base}..HEAD`], repoRoot)).stdout.trim() || "0", 10);
  if (cur === "HEAD") return { ff: 0, behind, blocked: "detached" }; // detached blockiert FF immer
  if (cur !== defaultBranch) return { ff: 0, behind: 0, blocked: null }; // nicht auf main → nicht anfassen
  if (behind === 0) return { ff: 0, behind: 0, blocked: null };
  if (ahead > 0) return { ff: 0, behind, blocked: "diverged" }; // braucht echten Merge/Rebase → Mensch
  // Nur getrackte uncommittete Änderungen blockieren einen FF (untracked ist egal).
  const trackedDirty = (await git(["-C", repoRoot, "status", "--porcelain", "-uno"], repoRoot)).stdout.trim();
  if (trackedDirty.length > 0) return { ff: 0, behind, blocked: "dirty" };
  // Ab hier MUSS der FF gelingen (Tree sauber, HEAD Vorfahr von base). Scheitert er
  // dennoch (z. B. Remote-Ref-Race), ehrlich als "unknown" melden — nicht "dirty".
  const ff = await git(["-C", repoRoot, "merge", "--ff-only", base], repoRoot);
  return ff.code === 0 ? { ff: behind, behind, blocked: null } : { ff: 0, behind, blocked: "unknown" };
}

/**
 * Feature A: main HART auf origin/<base> setzen — verwirft lokale, nicht gepushte ahead-Commits
 * (z. B. Release-/Versions-Bumps, die ein fast-forward nicht auflöst). VORHER wird die aktuelle
 * main-Spitze als Backup-Branch gesichert (verlustfrei rückholbar). Getrackte uncommittete
 * Änderungen blockieren den Reset (sie würden sonst verloren gehen); untracked bleibt unangetastet.
 */
export async function resetMainToOrigin(
  repoRoot: string,
  defaultBranch: string,
): Promise<{ ok: true; discarded: number; backup: string } | { ok: false; error: string }> {
  await git(["-C", repoRoot, "fetch", "origin", defaultBranch], repoRoot);
  const base = `origin/${defaultBranch}`;
  const cur = (await git(["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"], repoRoot)).stdout.trim();
  if (cur === "HEAD") return { ok: false, error: "detached HEAD — bitte zuerst main auschecken." };
  if (cur !== defaultBranch) return { ok: false, error: `Checkout steht auf ${cur}, nicht ${defaultBranch}.` };
  const trackedDirty = (await git(["-C", repoRoot, "status", "--porcelain", "-uno"], repoRoot)).stdout.trim();
  if (trackedDirty.length > 0)
    return { ok: false, error: "uncommittete Änderungen an getrackten Dateien — erst committen/verwerfen." };
  const ahead = parseInt((await git(["-C", repoRoot, "rev-list", "--count", `${base}..HEAD`], repoRoot)).stdout.trim() || "0", 10);
  if (ahead === 0) return { ok: true, discarded: 0, backup: "" }; // nichts voraus → nichts zu tun
  const sha = (await git(["-C", repoRoot, "rev-parse", "--short", "HEAD"], repoRoot)).stdout.trim();
  const backup = `mads-backup/main-${sha}`;
  await git(["-C", repoRoot, "branch", "-f", backup, defaultBranch], repoRoot);
  const reset = await git(["-C", repoRoot, "reset", "--hard", base], repoRoot);
  if (reset.code !== 0) return { ok: false, error: reset.stderr.trim() || reset.stdout.trim() || "reset --hard fehlgeschlagen" };
  return { ok: true, discarded: ahead, backup };
}

/**
 * Integrator-Aktion: lokale main-Commits (die main „ahead" machen — z. B. Release-/Versions-Bumps
 * aus einem Deploy, die man BEHALTEN will) nach origin/<base> pushen. NUR Fast-Forward — main wird
 * nie zwangsweise (force) überschrieben; ist origin voraus, ehrlicher Fehler → erst „main aktualisieren".
 * Secret-Gate wie bei jedem Push (mads-Remote ist öffentlich).
 */
export async function pushMainToOrigin(
  repoRoot: string,
  defaultBranch: string,
): Promise<{ ok: true; pushed: number } | { ok: false; kind: EscalationKind; error: string }> {
  const cur = (await git(["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"], repoRoot)).stdout.trim();
  if (cur !== defaultBranch) return { ok: false, kind: "push_rejected", error: `Checkout steht auf ${cur}, nicht ${defaultBranch}.` };
  const ahead = parseInt((await git(["-C", repoRoot, "rev-list", "--count", `origin/${defaultBranch}..HEAD`], repoRoot)).stdout.trim() || "0", 10);
  const gate = await secretGateBeforePush(repoRoot, defaultBranch);
  if (!gate.ok) return gate;
  const push = await git(["-C", repoRoot, "push", "origin", defaultBranch], repoRoot);
  if (push.code !== 0) return { ok: false, kind: classifyGitError(push.stderr) ?? "push_rejected", error: push.stderr.trim() || push.stdout.trim() };
  return { ok: true, pushed: ahead };
}

export interface GitStatusResult {
  behind: number;
  ahead: number;
  dirty: boolean;
  /**
   * true, wenn eines der drei git-Subkommandos (behind/ahead/dirty) mit code!==0 endete —
   * z. B. Worktree gerade entfernt, Branch/Base-Ref weg, Timeout. Ein git-FEHLER darf nie wie
   * „echte 0 / clean" aussehen: Konsumenten dürfen einen unreliable-Status weder als frischen
   * Stand cachen noch daraus Eskalationen („Keine Commits") ableiten.
   */
  unreliable?: boolean;
}

export async function gitStatus(
  repoRoot: string,
  worktree: string,
  branch: string,
  defaultBranch: string,
  skipFetch = false,
): Promise<GitStatusResult> {
  if (!skipFetch) await git(["-C", repoRoot, "fetch", "origin"], repoRoot);
  const base = `origin/${defaultBranch}`;
  const behindR = await git(["-C", worktree, "rev-list", "--count", `${branch}..${base}`], worktree);
  const aheadR = await git(["-C", worktree, "rev-list", "--count", `${base}..${branch}`], worktree);
  const dirtyR = await git(["-C", worktree, "status", "--porcelain"], worktree);
  const unreliable = behindR.code !== 0 || aheadR.code !== 0 || dirtyR.code !== 0;
  return {
    behind: parseInt(behindR.stdout.trim() || "0", 10),
    ahead: parseInt(aheadR.stdout.trim() || "0", 10),
    dirty: dirtyR.stdout.trim().length > 0,
    ...(unreliable ? { unreliable: true } : {}),
  };
}

/**
 * LEAK-1: Fail-closed Secret-Scan VOR jedem Push zu origin. Verhindert, dass ein (ggf. von
 * untrusted Repo-Inhalt geschriebenes) Secret ins — bei mads öffentliche — Remote gelangt.
 * Scannt den Diff der Branch-Commits gegen origin/<base>. Treffer → Push wird verweigert.
 * Einziger Egress-Gate für manuellen Sync, 25 s-Auto-Sync und createPr.
 */
async function secretGateBeforePush(
  worktree: string,
  base: string,
): Promise<{ ok: true } | { ok: false; kind: EscalationKind; error: string }> {
  await run("git", ["-C", worktree, "fetch", "origin", base], worktree);
  const baseRef = `origin/${base}`;
  const exists = await git(["-C", worktree, "rev-parse", "--verify", "--quiet", baseRef], worktree);
  if (exists.code !== 0) return { ok: true }; // Basis remote unbekannt → Scan nicht möglich (selten)
  // JEDEN gepushten Commit prüfen (nicht nur den Netto-Diff): ein in Commit A eingeführtes und in
  // Commit B wieder entferntes Secret verschwindet aus dem Netto-Diff, bleibt aber in der Historie,
  // die gepusht wird. `git log -p <base>..HEAD` liefert die Patches ALLER dieser Commits.
  const diff = await git(["-C", worktree, "log", "-p", "--no-color", "--no-merges", `${baseRef}..HEAD`], worktree);
  if (diff.code !== 0) return { ok: true };
  const hits = scanSecrets(diff.stdout);
  if (hits.length === 0) return { ok: true };
  const kinds = [...new Set(hits.map((h) => h.kind))].join(", ");
  return {
    ok: false,
    kind: "secret_detected",
    error:
      `🔒 Push blockiert: mögliche Secrets in den zu pushenden Änderungen (${kinds}; ${hits.length} Treffer). ` +
      `Entferne sie aus den Commits (und rotiere den Wert), bevor erneut gepusht wird.`,
  };
}

/**
 * Autopilot-Commit: alle Änderungen stagen, auf Secrets prüfen, dann committen. Fail-closed:
 * bei Secret-Treffer wird NICHT committet (Treffer zurückgegeben → eskalieren). `nothing`,
 * wenn es nichts zu committen gab.
 */
export async function autoCommit(
  worktree: string,
  message: string,
): Promise<{ ok: boolean; secrets?: SecretHit[]; nothing?: boolean; skipped?: string[] }> {
  await git(["-C", worktree, "add", "-A"], worktree);
  // Hygiene: nie-zu-committende Artefakte (.venv/node_modules/__pycache__/…) und Symlinks, die
  // AUS dem Worktree hinauszeigen, wieder aus dem Index nehmen. Das ist der Fix gegen den
  // eingecheckten `.venv`-Symlink, der danach jeden Rebase blockierte (.gitignore `.venv/`
  // erfasst den Symlink nicht). Reversibel: `git reset -- <pfad>` un-staged nur, Datei bleibt.
  const skipped = await unstageUncommittable(worktree);
  const diff = await git(["-C", worktree, "diff", "--cached"], worktree);
  if (!diff.stdout.trim()) {
    await git(["-C", worktree, "reset", "-q"], worktree);
    return { ok: false, nothing: true, skipped: skipped.length ? skipped : undefined };
  }
  const hits = scanSecrets(diff.stdout);
  if (hits.length) {
    await git(["-C", worktree, "reset", "-q"], worktree); // nicht im Staged-Zustand hängen lassen
    return { ok: false, secrets: hits, skipped: skipped.length ? skipped : undefined };
  }
  const c = await git(["-C", worktree, "commit", "-m", message], worktree);
  return { ok: c.code === 0, skipped: skipped.length ? skipped : undefined };
}

/**
 * Nimmt nie-zu-committende Pfade wieder aus dem Index: (a) Env/Build/Cache-Artefakte
 * (isArtifactPath — symlink-sicher per Name), (b) Symlinks, die aus dem Worktree hinauszeigen.
 * Gibt die übersprungenen Pfade zurück (Datei bleibt liegen, nur un-staged).
 */
async function unstageUncommittable(worktree: string): Promise<string[]> {
  const staged = (await git(["-C", worktree, "diff", "--cached", "--name-only"], worktree)).stdout
    .split("\n").map((s) => s.trim()).filter(Boolean);
  if (staged.length === 0) return [];
  const wtRoot = resolve(worktree);
  const skip: string[] = [];
  for (const rel of staged) {
    if (isArtifactPath(rel)) {
      skip.push(rel);
      continue;
    }
    try {
      const full = join(worktree, rel);
      if (lstatSync(full).isSymbolicLink()) {
        const target = resolve(dirname(full), readlinkSync(full));
        if (target !== wtRoot && !target.startsWith(wtRoot + sep)) skip.push(rel); // zeigt nach außen
      }
    } catch {
      /* gelöschter/unlesbarer Pfad — ignorieren */
    }
  }
  if (skip.length) await git(["-C", worktree, "reset", "-q", "--", ...skip], worktree);
  return skip;
}

const adrNums = (text: string): number[] =>
  (text.match(/ADR-0*(\d+)/g) ?? []).map((m) => parseInt(m.replace(/\D/g, ""), 10));

/**
 * A (automatische ADR-Nummern): benennt alle `ADR-DRAFT-<slug>.md` im Branch auf die nächste
 * freie `ADR-NNNN` um — Nummer = max(origin/<base>, Branch-eigene ADRs, `alreadyUsed` aus anderen
 * Streams) + 1, fortlaufend. Schreibt Verweise (`ADR-DRAFT-<slug>` → `ADR-NNNN-<slug>`) in allen
 * getrackten Dateien um und committet. GENERISCH & opt-in: ohne Draft-Dateien ein No-Op
 * (Nicht-ADR-Projekte unberührt). Reines git+fs — KEIN Repo-Code-Exec.
 */
export async function finalizeAdrDrafts(
  worktree: string,
  base: string,
  alreadyUsed: number[] = [],
): Promise<{ renamed: { num: string; to: string }[]; error?: string }> {
  const lsr = await git(["-C", worktree, "ls-files", "*ADR-DRAFT-*.md"], worktree);
  const drafts = lsr.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (drafts.length === 0) return { renamed: [] };
  await git(["-C", worktree, "fetch", "origin", base], worktree);
  const baseList = await git(["-C", worktree, "ls-tree", "-r", "--name-only", `origin/${base}`], worktree);
  const ownList = await git(["-C", worktree, "ls-files", "*ADR-*.md"], worktree);
  let next = Math.max(0, ...adrNums(baseList.stdout), ...adrNums(ownList.stdout), ...alreadyUsed) + 1;
  const renamed: { num: string; to: string }[] = [];
  for (const from of drafts.sort()) {
    const num = String(next).padStart(4, "0");
    const slug = (from.split("/").pop() ?? "").replace(/^ADR-DRAFT-/, "").replace(/\.md$/, "");
    const to = from.replace(/ADR-DRAFT-[^/]*\.md$/, `ADR-${num}-${slug}.md`);
    const mv = await git(["-C", worktree, "mv", from, to], worktree);
    if (mv.code !== 0) return { renamed, error: `git mv ${from} → ${to}: ${mv.stderr || mv.stdout}` };
    const draftRef = `ADR-DRAFT-${slug}`;
    const numRef = `ADR-${num}-${slug}`;
    const refFiles = (await git(["-C", worktree, "grep", "-l", "-F", draftRef], worktree)).stdout
      .split("\n").map((s) => s.trim()).filter(Boolean);
    for (const rf of refFiles) {
      try {
        const p = join(worktree, rf);
        const txt = readFileSync(p, "utf8");
        if (txt.includes(draftRef)) writeFileSync(p, txt.split(draftRef).join(numRef));
      } catch {
        /* nicht lesbare/binäre Datei überspringen */
      }
    }
    renamed.push({ num, to });
    next++;
  }
  await git(["-C", worktree, "add", "-A"], worktree);
  const c = await git(
    ["-C", worktree, "commit", "-m", `chore(adr): assign numbers (${renamed.map((r) => "ADR-" + r.num).join(", ")})`],
    worktree,
  );
  if (c.code !== 0) return { renamed, error: `ADR-Commit: ${c.stderr || c.stdout}` };
  return { renamed };
}

/**
 * Robuster Kollisions-Backstop (UNABHÄNGIG von der ADR-DRAFT-Convention). Benennt ADRs, die
 * DIESER Branch NEU hinzugefügt hat und deren Nummer auf origin/<base> bereits für eine ANDERE
 * Datei vergeben ist, auf die nächste freie Nummer um (Datei + Verweise + bare Eigen-Nummer im
 * Titel). An den SERIALISIERTEN Rebase-auf-main-Stellen aufgerufen → deterministisch, kein
 * wechselseitiges Hochzählen. Reines git+fs, KEIN Repo-Code-Exec. No-Op ohne Kollision.
 */
export async function reconcileAdrCollisions(
  worktree: string,
  base: string,
): Promise<{ renamed: { num: string; to: string }[]; error?: string }> {
  await git(["-C", worktree, "fetch", "origin", base], worktree);
  const baseList = await git(["-C", worktree, "ls-tree", "-r", "--name-only", `origin/${base}`], worktree);
  const ownList = await git(["-C", worktree, "ls-files", "*ADR-*.md"], worktree);
  const baseFiles = baseList.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const ownFiles = ownList.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const plan = planAdrCollisionRenames(baseFiles, ownFiles);
  if (plan.length === 0) return { renamed: [] };

  const renamed: { num: string; to: string }[] = [];
  for (const r of plan) {
    const mv = await git(["-C", worktree, "mv", r.from, r.to], worktree);
    if (mv.code !== 0) return { renamed, error: `git mv ${r.from} → ${r.to}: ${mv.stderr || mv.stdout}` };
    // Verweise NUR slug-qualifiziert umschreiben (`ADR-0074-slug` → `ADR-0075-slug`) — eindeutig.
    // Bare `ADR-0074` in fremden Dateien bleibt unangetastet (könnte die ANDERE gleichnummerige
    // ADR meinen).
    const refFiles = (await git(["-C", worktree, "grep", "-l", "-F", r.oldStem], worktree)).stdout
      .split("\n").map((s) => s.trim()).filter(Boolean);
    for (const rf of refFiles) {
      try {
        const p = join(worktree, rf);
        const txt = readFileSync(p, "utf8");
        if (txt.includes(r.oldStem)) writeFileSync(p, txt.split(r.oldStem).join(r.newStem));
      } catch {
        /* nicht lesbare/binäre Datei überspringen */
      }
    }
    // In der umbenannten Datei ZUSÄTZLICH die bare Eigen-Nummer (H1/Titel) angleichen — nur
    // `ADR-<old>` NICHT gefolgt von `-`/Ziffer (sonst würde ein slug-qualifizierter Verweis auf
    // eine andere gleichnummerige ADR fälschlich getroffen).
    try {
      const p = join(worktree, r.to);
      const txt = readFileSync(p, "utf8");
      const bare = new RegExp(`ADR-0*${r.oldNum}(?![-\\d])`, "g");
      const fixed = txt.replace(bare, `ADR-${r.num}`);
      if (fixed !== txt) writeFileSync(p, fixed);
    } catch {
      /* überspringen */
    }
    renamed.push({ num: r.num, to: r.to });
  }
  await git(["-C", worktree, "add", "-A"], worktree);
  const c = await git(
    ["-C", worktree, "commit", "-m", `chore(adr): resolve number collision (${renamed.map((x) => "ADR-" + x.num).join(", ")})`],
    worktree,
  );
  if (c.code !== 0) return { renamed, error: `ADR-Kollisions-Commit: ${c.stderr || c.stdout}` };
  return { renamed };
}

/**
 * Uncommittete Änderungen im Main-Checkout in einen NEUEN Sub-Worktree auslagern (main bleibt
 * sauber, bekommt NIE einen Commit — Inv. 1/2). Verlustsicher: erst stashen (tracked+untracked),
 * dann main per FF nachziehen, frischen Worktree ab origin/<base> anlegen, den Stash dort ANWENDEN
 * (apply, nicht pop) und nur bei sauberem Erfolg droppen — bei Fehler/Konflikt bleibt der Stash
 * als Sicherheitsnetz erhalten.
 */
export async function outsourceMainChanges(
  repoRoot: string,
  defaultBranch: string,
  agentId: string,
  branch: string,
): Promise<{ ok: true; conflicted: boolean; worktreePath: string } | { ok: false; error: string }> {
  const dirty = await git(["-C", repoRoot, "status", "--porcelain"], repoRoot);
  if (!dirty.stdout.trim()) return { ok: false, error: "Keine uncommitteten Änderungen im Main-Checkout." };
  const stash = await git(["-C", repoRoot, "stash", "push", "-u", "-m", `mads:outsource ${branch}`], repoRoot);
  if (stash.code !== 0) return { ok: false, error: `git stash fehlgeschlagen: ${stash.stderr || stash.stdout}` };
  const stashSha = (await git(["-C", repoRoot, "rev-parse", "stash@{0}"], repoRoot)).stdout.trim();
  await fastForwardMain(repoRoot, defaultBranch); // jetzt möglich (main clean); best effort
  // createWorktree joint agentId→Pfad (worktreePathFor) und liefert ihn zurück — das ist die EINZIGE
  // Quelle der Wahrheit für den Worktree-Pfad. Nur diesen zurückgegebenen Pfad fürs `stash apply` unten
  // nutzen; einen selbst vorbereiteten Pfad hier durchzureichen würde von createWorktree ein zweites Mal
  // gejoint (~/mads-worktrees/<slug>/<pfad>) → git legte am einen, das apply am anderen Verzeichnis an.
  // createWorktree wirft NICHT, sondern liefert {ok:false} — deshalb hier explizit prüfen (kein try/catch).
  const wt = await createWorktree(repoRoot, agentId, branch, `origin/${defaultBranch}`);
  if (!wt.ok) {
    await git(["-C", repoRoot, "stash", "pop"], repoRoot); // Worktree fehlgeschlagen → Stash zurück nach main
    return { ok: false, error: `Worktree konnte nicht erstellt werden (Änderungen sind zurück im Main-Checkout): ${wt.error}` };
  }
  const worktreePath = wt.path;
  const apply = await git(["-C", worktreePath, "stash", "apply", stashSha], worktreePath);
  const conflicted = apply.code !== 0 || /CONFLICT|Merge conflict/i.test(`${apply.stdout}\n${apply.stderr}`);
  if (!conflicted) await git(["-C", repoRoot, "stash", "drop", "stash@{0}"], repoRoot); // sauber → Stash weg
  // bei Konflikt: Stash BEWUSST behalten (Sicherheitsnetz), Konflikt wird auf dem Sub eskaliert
  return { ok: true, conflicted, worktreePath };
}

/** Aus dem gestageten Diff die neue Release-Version ableiten (typischer Deploy-Versions-Bump).
 *  Bevorzugt eine hinzugefügte Version, die eine ANDERE ersetzt (echter Bump); sonst die erste +Version. */
export function deriveReleaseVersion(diff: string): string | undefined {
  const SEMVER = /\b(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?)\b/;
  const VERSION_KEY = /(^|[^a-z])(version|__version__)\b/i; // Zeile deklariert eine Version (nicht irgendeine Zahl)
  const LOCKFILE = /(^|\/)([^/]*\.lock|package-lock\.json|pnpm-lock\.yaml)$/i; // Dependency-Versionen ignorieren
  let inLockfile = false;
  const keyAdd: string[] = [];
  const keyRem = new Set<string>();
  const anyAdd: string[] = [];
  const anyRem = new Set<string>();
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      const m = line.match(/^[+-]{3}\s+[ab]\/(.+)$/); // Datei-Header → Kontext (Lockfile?) setzen
      if (m) inLockfile = LOCKFILE.test(m[1]);
      continue;
    }
    if (line.startsWith("@@") || inLockfile) continue;
    const m = line.match(SEMVER);
    if (!m) continue;
    const isKey = VERSION_KEY.test(line);
    if (line.startsWith("+")) {
      anyAdd.push(m[1]);
      if (isKey) keyAdd.push(m[1]);
    } else if (line.startsWith("-")) {
      anyRem.add(m[1]);
      if (isKey) keyRem.add(m[1]);
    }
  }
  // Bevorzugt: Version aus einer Deklarationszeile, die eine alte ersetzt (echter Bump); dann irgendeine.
  const keyBump = keyAdd.find((v) => keyRem.size > 0 && !keyRem.has(v));
  const anyBump = anyAdd.find((v) => anyRem.size > 0 && !anyRem.has(v));
  return keyBump ?? keyAdd[0] ?? anyBump ?? anyAdd[0];
}

/** Den aktuellen (Deploy-)Stand des Main-Checkouts als Release-Commit festhalten: `git add -A` +
 *  `chore(release): <version>` (Version aus dem Diff abgeleitet). NUR lokal, NUR auf dem Default-Branch;
 *  Push bleibt bewusst separat/explizit (außen-sichtbare Aktion). Gitignorte Secrets werden von
 *  `git add -A` nicht erfasst. */
export async function commitMainRelease(
  repoRoot: string,
  defaultBranch: string,
): Promise<{ ok: true; message: string; skipped?: string[] } | { ok: false; error: string; secrets?: SecretHit[] }> {
  // NUR auf dem Default-Branch (der Integrator sitzt dort; nie auf Detached/Anderem) — vor jedem Staging prüfen.
  const branch = (await git(["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"], repoRoot)).stdout.trim();
  if (branch !== defaultBranch) return { ok: false, error: `Nicht auf ${defaultBranch} (aktuell „${branch}“) — Release-Commit abgebrochen.` };
  await git(["-C", repoRoot, "add", "-A"], repoRoot);
  // Hygiene wie autoCommit: nie-zu-committende Artefakte/Symlinks wieder aus dem Index (schützt u. a.
  // vor dem eingecheckten .venv-Symlink, der jeden Rebase blockiert).
  const skipped = await unstageUncommittable(repoRoot);
  const diff = (await git(["-C", repoRoot, "diff", "--cached"], repoRoot)).stdout;
  if (!diff.trim()) {
    await git(["-C", repoRoot, "reset", "-q"], repoRoot);
    return { ok: false, error: "Nichts zu committen — main ist sauber (nach Hygiene-Filter)." };
  }
  // Secret-Gate (mads ist PUBLIC — NIE Secrets committen), fail-closed wie autoCommit. Ein nicht-gitignortes
  // Secret (z. B. eine getrackte config.env) würde sonst in die lokale main-Historie gebacken.
  const hits = scanSecrets(diff);
  if (hits.length) {
    await git(["-C", repoRoot, "reset", "-q"], repoRoot);
    return { ok: false, error: `Secret im Diff erkannt (${hits.length}) — Release-Commit blockiert.`, secrets: hits };
  }
  const version = deriveReleaseVersion(diff);
  const message = version ? `chore(release): ${version}` : "chore(release)";
  const commit = await git(["-C", repoRoot, "commit", "-m", message], repoRoot);
  if (commit.code !== 0) {
    await git(["-C", repoRoot, "reset", "-q"], repoRoot); // Index nicht gestaged hängen lassen
    return { ok: false, error: `git commit fehlgeschlagen: ${commit.stderr || commit.stdout}` };
  }
  return { ok: true, message, skipped: skipped.length ? skipped : undefined };
}

/** Sieht die aktuelle main-Dirt nach einem (Deploy-)Versions-Bump aus? Liefert die abgeleitete Version,
 *  sonst undefined. Projekt-agnostisch: fängt jeden Versions-Bump (npm version, make deploy, push.ps1 …),
 *  unabhängig vom Befehlsnamen — der Poll nutzt das für die „Als Release committen"-Rahmung. */
export async function detectMainVersionBump(repoRoot: string): Promise<string | undefined> {
  const diff = (await git(["-C", repoRoot, "diff", "HEAD"], repoRoot)).stdout; // getrackte Änderungen ggü. HEAD
  return diff.trim() ? deriveReleaseVersion(diff) : undefined;
}

/**
 * Divergierten main auflösen, OHNE etwas wegzuwerfen: die lokalen Commits per Rebase auf
 * origin/<base> heben. Genau der Fall, in dem `fastForwardMain` „diverged" meldet — bisher eine
 * Sackgasse in der UI („braucht echten Merge/Rebase → Mensch"), obwohl er im Alltag ständig
 * auftritt: jeder Deploy-Versions-Bump / Release-Commit liegt als lokaler Commit auf main, und
 * sobald ein PR gemergt wird, ist main divergiert.
 * Sicherheit: nur auf dem Default-Branch, nur bei sauberem Tree; Konflikt → `rebase --abort`,
 * Zustand bleibt exakt wie vorher (nichts geht verloren).
 */
export async function rebaseMainOntoOrigin(
  repoRoot: string,
  defaultBranch: string,
): Promise<{ ok: true; rebased: number } | { ok: false; error: string }> {
  const cur = (await git(["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"], repoRoot)).stdout.trim();
  if (cur !== defaultBranch) return { ok: false, error: `Nicht auf ${defaultBranch} (aktuell „${cur}“) — Rebase abgebrochen.` };
  const trackedDirty = (await git(["-C", repoRoot, "status", "--porcelain", "-uno"], repoRoot)).stdout.trim();
  if (trackedDirty) return { ok: false, error: "Uncommittete Änderungen im Main-Checkout — erst committen oder auslagern." };
  const base = `origin/${defaultBranch}`;
  const ahead = parseInt((await git(["-C", repoRoot, "rev-list", "--count", `${base}..HEAD`], repoRoot)).stdout.trim() || "0", 10);
  const rb = await git(["-C", repoRoot, "rebase", base], repoRoot);
  if (rb.code !== 0) {
    await git(["-C", repoRoot, "rebase", "--abort"], repoRoot); // Zustand unverändert lassen
    return { ok: false, error: `Rebase-Konflikt — main wurde NICHT verändert: ${(rb.stderr || rb.stdout).trim().slice(0, 200)}` };
  }
  return { ok: true, rebased: ahead };
}

/** Lokale Commits, die noch nicht auf origin/<branch> liegen (für „PR aktuell halten"). */
export async function unpushedCount(worktree: string, branch: string): Promise<number> {
  const r = await git(["-C", worktree, "rev-list", "--count", `origin/${branch}..HEAD`], worktree);
  return r.code === 0 ? parseInt(r.stdout.trim() || "0", 10) : 0;
}

/** rebase onto origin/<default> + force-with-lease — der stale-base-Killer. */
/** Steckt der Worktree mitten in einem Rebase? (rebase-merge/ oder rebase-apply/ vorhanden). */
async function isRebaseInProgress(worktree: string): Promise<boolean> {
  for (const which of ["rebase-merge", "rebase-apply"]) {
    const r = await git(["-C", worktree, "rev-parse", "--git-path", which], worktree);
    const p = r.stdout.trim();
    if (!p) continue;
    const abs = p.startsWith("/") ? p : join(worktree, p);
    try {
      if (lstatSync(abs).isDirectory()) return true;
    } catch {
      /* nicht vorhanden */
    }
  }
  return false;
}

/** Bestmöglich die blockierenden (nicht-versionierten) Pfade aus der git-Fehlermeldung ziehen. */
function parseUntrackedObstacles(text: string): string {
  const cand = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[^\s:]+$/.test(l) && !/^(error|hint|warning|aborting|use)\b/i.test(l));
  return [...new Set(cand)].slice(0, 5).join(", ");
}

/**
 * force-with-lease-Push mit EINEM Retry. Scheitert der Lease, weil sich das Remote zwischen fetch
 * und push bewegt hat („cannot lock ref … is at X but expected Y", „stale info", „[rejected]"),
 * frisch fetchen (remote-tracking-Ref auffrischen → Lease wird korrekt) und EINMAL neu versuchen.
 * mads-Branches sind single-owner → der lokale (neueste) Rebase überschreibt sicher. Fängt die
 * Autopilot-Push-Race ab, falls sich doch zwei Zyklen ins Gehege kommen.
 */
async function pushForceWithLease(worktree: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let push = await git(["-C", worktree, "push", "--force-with-lease", ...args], worktree);
  const leaseFailed = (p: { stdout: string; stderr: string }) =>
    /cannot lock ref|stale info|\[rejected\]|is at [0-9a-f]+ but expected|force[- ]with[- ]lease/i.test(`${p.stderr}\n${p.stdout}`);
  if (push.code !== 0 && leaseFailed(push)) {
    await run("git", ["-C", worktree, "fetch", "origin"], worktree);
    push = await git(["-C", worktree, "push", "--force-with-lease", ...args], worktree);
  }
  return push;
}

export async function syncBranch(
  worktree: string,
  branch: string,
  defaultBranch: string,
): Promise<{ ok: true; renamedAdrs?: { num: string; to: string }[] } | { ok: false; kind: EscalationKind; error: string }> {
  await run("git", ["-C", worktree, "fetch", "origin"], worktree);
  // Der Worktree MUSS auf seinem Branch stehen, bevor rebased wird. Ein detached HEAD (der Zustand, den
  // mads nach einer sauberen Integration hinterlässt) würde sonst den LOSEN Commit rebasen (No-Op) statt
  // den Branch — der Branch-Ref bliebe „behind", und Auto-Sync liefe endlos. Reattach, verlustfrei:
  //  - Branch ist Vorfahre des (detached) HEAD → Branch per `checkout -B` auf HEAD ziehen (KEINE
  //    Working-Tree-Bewegung, keine eigenen Commits vorhanden); der folgende Rebase ist dann No-Op/FF.
  //  - sonst (Branch hat eigene Commits) → Branch auschecken; der Rebase spielt seine Commits auf origin/<default>.
  const headRef = await git(["-C", worktree, "symbolic-ref", "-q", "HEAD"], worktree);
  if (headRef.code !== 0 || headRef.stdout.trim() !== `refs/heads/${branch}`) {
    const branchIsAncestor = await git(["-C", worktree, "merge-base", "--is-ancestor", branch, "HEAD"], worktree);
    const reattach =
      branchIsAncestor.code === 0
        ? await git(["-C", worktree, "checkout", "-B", branch, "HEAD"], worktree)
        : await git(["-C", worktree, "checkout", branch], worktree);
    if (reattach.code !== 0) {
      return {
        ok: false,
        kind: "merge_conflict",
        error: `Worktree ließ sich nicht auf ${branch} setzen (HEAD steht nicht auf dem Branch — z. B. detached HEAD, kollidierende Working-Tree-Änderungen oder Branch in einem anderen Worktree aktiv): ${(reattach.stderr || reattach.stdout).trim()}`,
      };
    }
  }
  const rebase = await git(["-C", worktree, "rebase", `origin/${defaultBranch}`], worktree);
  if (rebase.code !== 0) {
    const errText = rebase.stderr || rebase.stdout;
    // Konfliktdateien ERFASSEN, bevor `rebase --abort` sie wegräumt → klare, handlungsweisende
    // Meldung statt git-Rohtext („Failed to merge … git am --show-current-patch").
    const confl = await git(["-C", worktree, "diff", "--name-only", "--diff-filter=U"], worktree);
    const conflictFiles = confl.code === 0 ? confl.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [];
    await git(["-C", worktree, "rebase", "--abort"], worktree);
    const stuck = await isRebaseInProgress(worktree); // der Abbruch selbst gescheitert?
    const stuckNote = stuck
      ? " ⚠ Der Worktree steckt noch im Rebase — `git rebase --abort` gelang nicht (Reparatur nötig)."
      : "";
    // „would lose untracked files" / „untracked working tree files would be overwritten" ist KEIN
    // echter Merge-Konflikt, sondern eine nicht-versionierte Datei im Weg (meist ein eingechecktes
    // Build-Artefakt wie .venv). Klar und handlungsweisend melden statt „manuell Sync".
    if (/would lose untracked files|untracked working tree files would be overwritten/i.test(errText)) {
      const paths = parseUntrackedObstacles(errText);
      return {
        ok: false,
        kind: "merge_conflict",
        error:
          `Auto-Sync blockiert durch nicht-versionierte Datei(en) im Weg${paths ? ` (${paths})` : ""} — KEIN echter ` +
          `Merge-Konflikt. Meist ein eingechecktes Build-Artefakt (.venv/node_modules). Lösung: aus der ` +
          `Versionierung nehmen (git rm --cached <pfad>) und in .gitignore aufnehmen.${stuckNote}`,
      };
    }
    // Echter Rebase-Konflikt: die betroffenen Dateien nennen + auf „Konflikt lösen" verweisen
    // (statt git-Rohtext). mads rebaset/pusht nach der Auflösung selbst.
    if (conflictFiles.length > 0) {
      const shown = conflictFiles.slice(0, 8).join(", ");
      const more = conflictFiles.length > 8 ? ` … (+${conflictFiles.length - 8})` : "";
      return {
        ok: false,
        kind: "merge_conflict",
        error:
          `Rebase-Konflikt mit origin/${defaultBranch} in ${conflictFiles.length} Datei(en): ${shown}${more}. ` +
          `Über „Konflikt lösen" im Worktree beheben — mads rebaset/pusht danach.${stuckNote}`,
      };
    }
    return { ok: false, kind: "merge_conflict", error: errText + stuckNote };
  }
  // Robuster ADR-Kollisions-Backstop: nach dem Rebase trägt der Branch jetzt main + eigene
  // Änderungen — eine vom Branch gewählte ADR-Nummer, die main inzwischen vergeben hat, wird
  // hier (serialisiert sicher) auf die nächste freie Nummer umgeschrieben, BEVOR gepusht wird.
  const adr = await reconcileAdrCollisions(worktree, defaultBranch);
  if (adr.error) return { ok: false, kind: "push_rejected", error: `ADR-Kollisionsauflösung: ${adr.error}` };
  const gate = await secretGateBeforePush(worktree, defaultBranch);
  if (!gate.ok) return gate;
  const push = await pushForceWithLease(worktree, ["origin", branch]);
  if (push.code !== 0) {
    return { ok: false, kind: classifyGitError(push.stderr) ?? "push_rejected", error: push.stderr };
  }
  return { ok: true, renamedAdrs: adr.renamed.length ? adr.renamed : undefined };
}

export async function pushBranch(
  worktree: string,
  branch: string,
  base: string,
): Promise<{ ok: true } | { ok: false; kind: EscalationKind; error: string }> {
  const gate = await secretGateBeforePush(worktree, base);
  if (!gate.ok) return gate;
  let push = await git(["-C", worktree, "push", "-u", "origin", branch], worktree);
  // Wurde der Branch lokal umgeschrieben (z.B. Rebase onto origin/main), lehnt ein
  // normaler Push als „non-fast-forward" ab. mads-Branches sind single-owner → sicher
  // per --force-with-lease nachziehen (clobbert nur, wenn das Remote unverändert ist).
  if (push.code !== 0 && /\[rejected\]|non-fast-forward|fetch first|tip of your current branch is behind/i.test(`${push.stderr}\n${push.stdout}`)) {
    push = await pushForceWithLease(worktree, ["-u", "origin", branch]);
  }
  if (push.code !== 0) return { ok: false, kind: classifyGitError(push.stderr) ?? "push_rejected", error: push.stderr };
  return { ok: true };
}

export async function createPr(
  worktree: string,
  repoRoot: string,
  branch: string,
  base: string,
  title: string,
  body: string,
  draft: boolean,
): Promise<{ ok: true; url: string } | { ok: false; error: string; transient?: boolean; noCommits?: boolean }> {
  const pushed = await pushBranch(worktree, branch, base);
  if (!pushed.ok) return { ok: false, error: pushed.error };
  // Idempotent: existiert für den Branch bereits ein OFFENER PR, hat der Push oben ihn
  // aktualisiert → diesen PR melden. Sonst würde `gh pr create` mit „a pull request … already
  // exists" scheitern und mads fälschlich `push_rejected` eskalieren, obwohl alles i.O. ist.
  // (Ein GEMERGTER/GESCHLOSSENER Alt-PR blockiert `gh pr create` nicht → dann neuen PR erstellen.)
  const existing = await prStatus(repoRoot, branch);
  if (existing && existing.state === "OPEN") return { ok: true, url: existing.url };
  const args = ["pr", "create", "--head", branch, "--base", base, "--title", title, "--body", body];
  if (draft) args.push("--draft");
  // GitHub liefert bei internen Störungen einen TRANSIENTEN GraphQL/5xx-Fehler („Something went wrong
  // while executing your query" mit Referenz-ID, 502/503/504, Timeouts, sekundäre Rate-Limits). Das ist
  // KEIN Push-/Code-Problem — GitHub empfiehlt Wiederholung. Ohne Retry eskalierte mads schon beim ersten
  // Schluckauf. Darum: bis zu 3 Versuche mit Backoff; nur wenn es bestehen bleibt, Fehler zurückgeben.
  let lastErr = "";
  let transient = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await gh(args, repoRoot);
    if (r.code === 0) return { ok: true, url: r.stdout.trim().split("\n").pop() ?? "" };
    const err = (r.stderr || r.stdout).trim();
    // Race zwischen Check und create (oder ein PR, den prStatus nicht sah): „already exists" ist
    // KEIN Fehler — den vorhandenen PR (URL aus der Meldung, sonst Nachpoll) übernehmen.
    if (/already exists/i.test(err)) {
      const urlInErr = /(https?:\/\/\S+\/pull\/\d+)/i.exec(err)?.[1];
      const again = urlInErr ? null : await prStatus(repoRoot, branch);
      return { ok: true, url: urlInErr ?? again?.url ?? existing?.url ?? "" };
    }
    // GitHub sagt selbst „nichts zu PRen": Head == Base bzw. der Branch-Inhalt liegt schon in `base`
    // (typisch nach Squash-Merge: voraus nach Commit-SHA, aber leer nach Inhalt; oder Branch bereits
    // auf `base` zurückgesetzt). Das ist KEINE Ablehnung — nicht rot eskalieren, Retry ist zwecklos.
    // Der Aufrufer meldet es als harmlosen „bereits gemergt"-Hinweis.
    if (/No commits between|Head sha can't be blank|Base sha can't be blank/i.test(err)) {
      return { ok: false, error: err, noCommits: true };
    }
    lastErr = err;
    transient = isTransientGhError(err);
    if (transient && attempt < 2) {
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1))); // 1,5 s / 3 s Backoff
      continue;
    }
    break;
  }
  return { ok: false, error: lastErr, transient };
}

/** Offene PRs des Repos (roh) — für die „eingehende PRs"-Erkennung. Bot-/mads-Filter macht der Aufrufer. */
export async function listOpenPrs(
  repoRoot: string,
): Promise<Array<{ number: number; title: string; author: string; headRefName: string; url: string; isFork: boolean; isDraft: boolean }>> {
  const r = await gh(
    ["pr", "list", "--state", "open", "--limit", "50", "--json", "number,title,author,headRefName,isCrossRepository,url,isDraft"],
    repoRoot,
    GH_TIMEOUT_MS,
  );
  if (r.code !== 0) return [];
  try {
    const arr = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
    return arr.map((p) => ({
      number: Number(p.number),
      title: String(p.title ?? ""),
      author: String((p.author as { login?: string })?.login ?? ""),
      headRefName: String(p.headRefName ?? ""),
      url: String(p.url ?? ""),
      isFork: p.isCrossRepository === true,
      isDraft: p.isDraft === true,
    }));
  } catch {
    return [];
  }
}

/** Isolierten READ-ONLY Worktree auf dem Stand eines PRs anlegen — fork-sicher über den `pull/<#>/head`-
 *  Ref (existiert für JEDEN PR). Lokaler Review-Branch `mads-review/pr-<#>`; kein Remote-Tracking, damit
 *  nie versehentlich auf den fremden Branch gepusht wird. Merge läuft später über die PR-Nummer. */
export async function createReviewWorktree(
  repoRoot: string,
  agentId: string,
  prNumber: number,
): Promise<{ ok: true; path: string; branch: string } | { ok: false; error: string }> {
  const branch = `mads-review/pr-${prNumber}`;
  const path = worktreePathFor(repoRoot, agentId);
  // Idempotent: einen Rest aus einer früheren Sitzung (Worktree/Branch liegen noch da) forciert wegräumen,
  // damit ein erneutes Öffnen desselben PR-Reviews sauber startet.
  if (existsSync(path)) await git(["-C", repoRoot, "worktree", "remove", "--force", path], repoRoot);
  await git(["-C", repoRoot, "worktree", "prune"], repoRoot); // verwaiste Registrierung (Pfad manuell gelöscht) lösen
  await git(["-C", repoRoot, "branch", "-D", branch], repoRoot); // egal ob vorhanden
  const f = await git(["-C", repoRoot, "fetch", "origin", "--force", `pull/${prNumber}/head:${branch}`], repoRoot);
  if (f.code !== 0) return { ok: false, error: (f.stderr || f.stdout).trim() };
  const w = await git(["-C", repoRoot, "worktree", "add", path, branch], repoRoot);
  if (w.code !== 0) {
    await git(["-C", repoRoot, "branch", "-D", branch], repoRoot); // Branch angelegt, Worktree nicht → kein Müll
    return { ok: false, error: (w.stderr || w.stdout).trim() };
  }
  try {
    ensureMadsDir(path);
  } catch {
    /* best effort */
  }
  // BEWUSST KEIN seedLocalDevFiles: ein Review-Worktree hält FREMDEN (bei Forks beliebigen) PR-Code.
  // Würde man die lokalen Secrets (.env/appsettings/credentials …) hineinseeden, könnten die vom PR-Autor
  // kontrollierten Dev-/Postinstall-Skripte sie lesen/exfiltrieren. Read-only Review bleibt secret-frei.
  return { ok: true, path, branch };
}

/** Transiente GitHub-Server-Fehler (GraphQL-500 „Something went wrong", 5xx, Timeouts, sekundäres
 *  Rate-Limit) — GitHub empfiehlt Wiederholung. NICHT für echte Ablehnungen (Permission, Protection). */
export function isTransientGhError(err: string): boolean {
  return /Something went wrong while executing your query|GraphQL:\s*Something went wrong|\b50[234]\b|Bad Gateway|Service Unavailable|Gateway Time-?out|timed? ?out|ETIMEDOUT|EAI_AGAIN|ECONNRESET|ECONNREFUSED|temporarily unavailable|was submitted too quickly|secondary rate limit|abuse detection|try again/i.test(
    err,
  );
}

/** Integrator-Merge: gh pr merge --squash --delete-branch (lineare main). */
export async function mergePr(
  repoRoot: string,
  branch: string,
  method: "squash" | "merge" | "rebase" = "squash",
): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
  const flag = method === "merge" ? "--merge" : method === "rebase" ? "--rebase" : "--squash";
  // KEIN --delete-branch: der lokale Branch ist im Worktree ausgecheckt → gh würde beim
  // Löschen scheitern und den (bereits erfolgten) Merge fälschlich als Fehler melden.
  // Worktree + lokalen + Remote-Branch räumt der Orchestrator danach auf (Worktree zuerst).
  // Transiente GitHub-Server-Fehler (GraphQL-500 o. Ä.) wiederholen — wie bei createPr (dieselbe
  // Störung trifft `gh pr merge`, und nur der Integrator merged → ein Fehlschlag ist teuer).
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await gh(["pr", "merge", branch, flag], repoRoot);
    if (r.code === 0) return { ok: true, output: r.stdout.trim() };
    lastErr = (r.stderr || r.stdout).trim();
    if (isTransientGhError(lastErr) && attempt < 2) {
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
      continue;
    }
    break;
  }
  return { ok: false, error: lastErr };
}

function rollupState(rollup: unknown): PrChecksState {
  if (!Array.isArray(rollup) || rollup.length === 0) return null;
  let fail = 0;
  let pending = 0;
  for (const c of rollup as Array<Record<string, unknown>>) {
    const s = String(c.conclusion ?? c.state ?? c.status ?? "").toUpperCase();
    if (/(FAILURE|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED|STARTUP_FAILURE)/.test(s)) fail++;
    else if (/(PENDING|IN_PROGRESS|QUEUED|WAITING|REQUESTED|EXPECTED)/.test(s)) pending++;
  }
  if (fail > 0) return "FAILURE";
  if (pending > 0) return "PENDING";
  return "SUCCESS";
}

/** PR-Status der Branch via gh; null wenn (noch) kein PR existiert. */
export async function prStatus(
  repoRoot: string,
  branch: string,
): Promise<PullRequestInfo | null> {
  const fields = "number,url,state,isDraft,headRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup";
  const r = await gh(["pr", "view", branch, "--json", fields], repoRoot, GH_TIMEOUT_MS);
  if (r.code !== 0) return null; // kein PR / nicht gefunden / Timeout (fail-open)
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
  return {
    number: Number(j.number ?? 0),
    url: String(j.url ?? ""),
    state: (j.state as PullRequestInfo["state"]) ?? "OPEN",
    isDraft: Boolean(j.isDraft),
    headRefName: String(j.headRefName ?? branch),
    mergeable: (j.mergeable as PullRequestInfo["mergeable"]) ?? "UNKNOWN",
    mergeStateStatus: (j.mergeStateStatus as PullRequestInfo["mergeStateStatus"]) ?? "UNKNOWN",
    reviewDecision: (j.reviewDecision as PullRequestInfo["reviewDecision"]) ?? null,
    checksState: rollupState(j.statusCheckRollup),
  };
}

/** Leitet aus git-Status + PR-Status die anstehenden Eskalationen ab. */
export function escalationsFor(
  status: { behind: number } | null,
  pr: PullRequestInfo | null,
): EscalationKind[] {
  const out: EscalationKind[] = [];
  if (status && status.behind > 0) out.push("stale_base");
  if (pr) {
    if (pr.checksState === "FAILURE") out.push("ci_red");
    if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") out.push("merge_conflict");
    if (pr.mergeStateStatus === "BEHIND" && !out.includes("stale_base")) out.push("stale_base");
    if (pr.mergeStateStatus === "BLOCKED") out.push("protection_blocked");
    if (pr.reviewDecision === "CHANGES_REQUESTED" || pr.reviewDecision === "REVIEW_REQUIRED") out.push("review_required");
  }
  return out;
}
