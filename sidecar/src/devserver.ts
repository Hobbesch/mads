/**
 * Stream-Dev-Server-Runner (P: „Front-/Backend eines Streams lokal testen").
 *
 * Startet die lokalen Dev-Server eines Projekts IM Worktree eines Streams, damit noch nicht
 * gemergte Änderungen live getestet werden können — main bleibt unberührt (mads-Invariante:
 * getestet & stabil ⇒ erst dann Merge). Es läuft immer nur EIN Stream-Dev-Server gleichzeitig
 * (Standard-Ports, kein Konflikt) — der Orchestrator stoppt einen laufenden vor dem nächsten Start.
 *
 * PROJEKT-AGNOSTISCH: WIE die App läuft, steht NICHT im mads-Code, sondern in
 * `<repoRoot>/.mads/run.json` (Services: cwd, install, command, env, url, ready). mads ist nur die
 * generische Ausführungs-Engine. Beim ersten Öffnen wird eine Vorlage aus erkannten
 * Scripts/Projekten erzeugt (generate-if-absent), die der Nutzer verfeinert.
 *
 * Prozess-Modell: `spawn("/bin/sh", ["-lc", command], { detached:true })` → jeder Service ist
 * Gruppen-Leader; Kill via `process.kill(-pid, …)` beendet auch geforkte Kinder (Vite→esbuild,
 * `dotnet run`→Host). Ausgabe wird zeilenweise (readline) als NDJSON an die UI weitergereicht.
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import readline from "node:readline";
import { send, envelope, log } from "./io.js";

export interface ServiceSpec {
  name: string;
  cwd?: string; // relativ zum Worktree-Root; Default "."
  install?: string; // einmaliger Vorbereitungs-Befehl (z. B. "npm install")
  installIfMissing?: string; // install NUR ausführen, wenn dieser Pfad (in cwd) fehlt (z. B. "node_modules")
  command: string; // langlebiger Start-Befehl (z. B. "npm run dev", "dotnet run")
  env?: Record<string, string>; // zusätzliche Env; Werte dürfen ${VAR} referenzieren (aus process.env)
  url?: string; // URL, unter der der Service erreichbar ist
  open?: boolean; // true = dies ist die „im Browser öffnen"-URL (i. d. R. das Frontend)
  ready?: string; // Teilstring in der Ausgabe, der „bereit" signalisiert (sonst: sofort nach Spawn)
  /**
   * Externe Abhängigkeiten, die erreichbar sein MÜSSEN, damit der Dienst funktioniert —
   * als "host:port" oder nur "port" (z. B. "5433" für Postgres aus docker-compose).
   * Grund: ein Backend LAUSCHT auch dann, wenn seine Datenbank fehlt — es meldet dann fleissig
   * "läuft" und liefert bei jedem Login "Passwort falsch". Ohne diese Angabe kann mads den
   * Unterschied nicht sehen und zeigt gruen, obwohl nichts geht.
   */
  requires?: (string | ServiceDep)[];
}
/** Eine externe Abhängigkeit eines Dienstes (Datenbank, Cache, Queue …). */
export interface ServiceDep {
  /** "5433" oder "host:5433" — was erreichbar sein muss. */
  port: string | number;
  host?: string;
  /** Anzeigename für den Indikator (Default: der Port). */
  name?: string;
  /** Optionaler Befehl, der die Abhängigkeit hochfährt, wenn sie fehlt (z. B. `docker compose up -d`).
   *  Wird im Repo-Root ausgeführt. Ohne diesen Eintrag meldet mads nur, dass etwas fehlt. */
  start?: string;
  /** Zeitbudget für `start` in Sekunden (Default 180). Grosszügig, weil der Befehl eine ganze
   *  Laufzeitumgebung hochfahren darf (Docker Desktop braucht kalt leicht eine Minute). */
  startTimeoutSec?: number;
}

/** requires-Eintrag normalisieren (String-Kurzform ODER Objekt). */
export function normalizeDep(
  d: string | ServiceDep,
): { host: string; port: number; name: string; start?: string; startTimeoutSec?: number } | null {
  if (typeof d === "string") {
    const m = /^(?:([^\s:]+):)?(\d{2,5})$/.exec(d.trim());
    if (!m) return null;
    return { host: m[1] || "127.0.0.1", port: parseInt(m[2], 10), name: m[1] ? d.trim() : `:${m[2]}` };
  }
  const port = typeof d.port === "number" ? d.port : parseInt(String(d.port ?? ""), 10);
  if (!Number.isInteger(port) || port <= 0) return null;
  return {
    host: d.host || "127.0.0.1",
    port,
    name: d.name || `:${port}`,
    start: typeof d.start === "string" ? d.start : undefined,
    startTimeoutSec: typeof d.startTimeoutSec === "number" ? d.startTimeoutSec : undefined,
  };
}
export interface RunManifest {
  services: ServiceSpec[];
}

type DevState = "installing" | "starting" | "running" | "stopped" | "error";

/** ${VAR}-Referenzen aus process.env auflösen (z. B. "${HOME}/.dotnet:${PATH}"). */
function expandEnv(v: string): string {
  return v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, k: string) => process.env[k] ?? "");
}

/** Den TCP-Port eines Service ableiten — aus `url` (http://host:PORT) oder `ASPNETCORE_URLS`. */
function portOf(spec: ServiceSpec): number | undefined {
  const candidates = [spec.url, spec.env?.ASPNETCORE_URLS].filter((s): s is string => !!s);
  for (const c of candidates) {
    const m = /:(\d{2,5})(?:\/|$)/.exec(expandEnv(c));
    if (m) return parseInt(m[1], 10);
  }
  return undefined;
}

/** PIDs, die auf `port` lauschen (macOS `lsof`). Leer, wenn frei / lsof fehlt. */
function pidsOnPort(port: number): Promise<number[]> {
  return new Promise((resolve) => {
    execFile("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { timeout: 3000 }, (_err, stdout) => {
      const pids = String(stdout)
        .split(/\s+/)
        .map((s) => parseInt(s, 10))
        .filter((n) => Number.isInteger(n) && n > 0);
      resolve([...new Set(pids)]);
    });
  });
}

const RUN_PATH = (repoRoot: string): string => join(repoRoot, ".mads", "run.json");

/** `.mads/run.json` lesen + validieren (nur wohlgeformte Services). null = fehlt/ungültig/leer. */
export function loadRunManifest(repoRoot: string): RunManifest | null {
  let raw: string;
  try {
    raw = readFileSync(RUN_PATH(repoRoot), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    log(`[devserver] .mads/run.json ist kein gültiges JSON: ${String(e)}`);
    return null;
  }
  const rawServices = (parsed as { services?: unknown })?.services;
  if (!Array.isArray(rawServices)) return null;
  const services: ServiceSpec[] = [];
  for (const s of rawServices as Record<string, unknown>[]) {
    if (s && typeof s.name === "string" && typeof s.command === "string") {
      services.push({
        name: s.name,
        command: s.command,
        cwd: typeof s.cwd === "string" ? s.cwd : undefined,
        install: typeof s.install === "string" ? s.install : undefined,
        installIfMissing: typeof s.installIfMissing === "string" ? s.installIfMissing : undefined,
        env: s.env && typeof s.env === "object" ? (s.env as Record<string, string>) : undefined,
        url: typeof s.url === "string" ? s.url : undefined,
        open: s.open === true,
        ready: typeof s.ready === "string" ? s.ready : undefined,
        requires: Array.isArray(s.requires)
          ? (s.requires as unknown[]).filter((x): x is string | ServiceDep => typeof x === "string" || (!!x && typeof x === "object"))
          : undefined,
      });
    }
  }
  return services.length ? { services } : null;
}

/** Pfad der Projekt-Dev-Server-Konfig (`<repoRoot>/.mads/run.json`) — für den Konfig-Editor. */
export function runManifestPath(repoRoot: string): string {
  return RUN_PATH(repoRoot);
}

function readFileSafe(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}
function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Erstes projekt-eigenes Dev-Skript (am zuverlässigsten): `scripts/*dev*.sh` (aber NICHT setup/
 *  install/build/test/deploy), sonst `just dev` / `make <dev|run|serve|start|up>`. undefined = keins. */
function pickDevScript(repoRoot: string): string | undefined {
  const shs = listDir(join(repoRoot, "scripts"))
    .filter(
      (f) =>
        /\.sh$/i.test(f) &&
        /(^|[-_.])(dev|serve|run|start)([-_.]|$)/i.test(f) &&
        !/(setup|install|build|clean|test|deploy|lint|format|migrate|seed)/i.test(f),
    )
    .sort();
  if (shs.length) return `bash scripts/${shs[0]}`;
  if (existsSync(join(repoRoot, "justfile")) || existsSync(join(repoRoot, "Justfile"))) return "just dev";
  const mk = readFileSafe(join(repoRoot, "Makefile"));
  const t = ["dev", "run", "serve", "start", "up"].find((x) => new RegExp(`^${x}:`, "m").test(mk));
  if (t) return `make ${t}`;
  return undefined;
}

/**
 * Erkennt lauffähige Services aus dem Projekt — PROJEKT-AGNOSTISCH, best effort. Reihenfolge:
 * Node-Frontend → Backend nach Runtime (.NET / Rust / Python: Django/FastAPI-uvicorn/Flask) →
 * als Fallback die EIGENEN Dev-Skripte (scripts/*dev*.sh, `just dev`, `make dev`) — die sind am
 * ehesten „was der Projekt-Autor meint". Für Python nutzt es `.venv/bin/python`, wenn ein `.venv`
 * existiert, sonst schlägt es ein Venv-Setup als install-Schritt vor. Alles nur eine Startvorlage —
 * der Nutzer verfeinert im Konfig-Editor (`.mads/run.json`).
 */
export function detectServices(repoRoot: string): ServiceSpec[] {
  const services: ServiceSpec[] = [];
  const at = (dir: string, f: string): boolean => existsSync(join(repoRoot, dir, f));
  const globAny = (dir: string, re: RegExp): boolean => listDir(join(repoRoot, dir)).some((f) => re.test(f));

  // 1) Frontend: erstes package.json mit dev/start-Script (root oder gängige UI-Unterordner).
  for (const dir of ["", "client", "frontend", "web", "app", "ui", "packages/web"]) {
    try {
      const pkg = JSON.parse(readFileSync(join(repoRoot, dir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
      const script = pkg.scripts?.dev ? "dev" : pkg.scripts?.start ? "start" : null;
      if (script) {
        services.push({ name: dir ? dir.split("/").pop()! : "frontend", cwd: dir || ".", install: "npm install", installIfMissing: "node_modules", command: `npm run ${script}`, url: "http://localhost:5173", open: true, ready: "ready" });
        break;
      }
    } catch {
      /* kein package.json hier */
    }
  }

  // 2) Backend/Dev: ZUERST ein eigenes Dev-Skript (am zuverlässigsten „was der Autor meint" — deckt
  //    z. B. Python-Setups mit venv/uvicorn ab, die man kaum raten kann), sonst Runtime-Heuristik.
  const devCmd = pickDevScript(repoRoot);
  if (devCmd) {
    services.push({ name: services.length ? "backend" : "dev", cwd: ".", command: devCmd });
    return services;
  }

  for (const dir of ["server", "backend", "api", "src", "."]) {
    if (globAny(dir, /\.csproj$/i)) {
      services.push({ name: "backend", cwd: dir, command: "dotnet run", env: { ASPNETCORE_URLS: "http://localhost:5000" }, url: "http://localhost:5000", ready: "Now listening on" });
      break;
    }
    if (at(dir, "Cargo.toml")) {
      services.push({ name: "backend", cwd: dir, command: "cargo run", ready: "Running" });
      break;
    }
    // Python: Django / FastAPI(uvicorn) / Flask — mit venv-Interpreter, wenn `.venv` da ist.
    const isPy = at(dir, "manage.py") || at(dir, "pyproject.toml") || at(dir, "requirements.txt") || at(dir, "setup.py");
    if (isPy) {
      const pyText = (readFileSafe(join(repoRoot, dir, "pyproject.toml")) + readFileSafe(join(repoRoot, dir, "requirements.txt"))).toLowerCase();
      const hasVenv = at(dir, ".venv");
      const py = hasVenv ? ".venv/bin/python" : "python3";
      // Venv-Setup als install-Schritt vorschlagen, wenn keins da ist (nur wenn `.venv` fehlt).
      const dep = at(dir, "requirements.txt") ? "-r requirements.txt" : "-e .";
      const install = hasVenv ? undefined : `python3 -m venv .venv && .venv/bin/pip install ${dep}`;
      const installIfMissing = hasVenv ? undefined : ".venv";
      if (at(dir, "manage.py")) {
        services.push({ name: "backend", cwd: dir, install, installIfMissing, command: `${py} manage.py runserver`, url: "http://localhost:8000", ready: "Starting development server" });
        break;
      }
      if (/uvicorn|fastapi/.test(pyText)) {
        services.push({ name: "backend", cwd: dir, install, installIfMissing, command: `${py} -m uvicorn app.main:app --reload --port 8000`, url: "http://localhost:8000", ready: "Uvicorn running" });
        break;
      }
      if (/\bflask\b/.test(pyText)) {
        services.push({ name: "backend", cwd: dir, install, installIfMissing, env: { FLASK_APP: "app" }, command: `${py} -m flask run --debug --port 8000`, url: "http://localhost:8000", ready: "Running on" });
        break;
      }
    }
  }

  return services;
}

const RUN_README =
  "mads Stream-Dev-Server. Jeder Service wird im WORKTREE des Streams gestartet (nicht in main). " +
  "Felder: name, cwd (rel. zum Worktree), install (+installIfMissing = nur wenn Pfad fehlt), command, " +
  "env (Werte dürfen ${VAR} nutzen), url, open:true (=im-Browser-öffnen-URL), ready (Teilstring der "
  + "Ausgabe, der Bereitschaft signalisiert), requires (externe Abhängigkeiten wie Datenbanken — "
  + "\"5433\" bzw. {port, name, start, startTimeoutSec}; mads prüft sie, zeigt einen eigenen "
  + "Indikator und fährt sie per `start` im Repo-Root hoch). " +
  "Ausgabe = 'bereit'). Es läuft immer nur EIN Stream-Dev-Server gleichzeitig. Automatisch erzeugte " +
  "Vorlage — Befehle/Ports/Runtime bitte prüfen und anpassen.";

/**
 * Stellt `.mads/run.json` sicher: existiert es MIT Services → unangetastet lassen (Nutzer-Konfig).
 * Fehlt es ODER ist es leer (`services: []`, z. B. altes Auto-Scaffold, das nichts erkannte) →
 * frische Vorlage aus {@link detectServices} schreiben. Gibt generiert/Service-Anzahl + Pfad zurück.
 */
export function ensureRunManifest(repoRoot: string): { generated: boolean; services: number; path: string } {
  const p = RUN_PATH(repoRoot);
  const existing = loadRunManifest(repoRoot); // null bei fehlend/ungültig/LEER (services: [])
  if (existing && existing.services.length > 0) {
    return { generated: false, services: existing.services.length, path: p };
  }
  const services = detectServices(repoRoot);
  try {
    writeFileSync(p, JSON.stringify({ _readme: RUN_README, services }, null, 2) + "\n", "utf8");
    return { generated: true, services: services.length, path: p };
  } catch (e) {
    log(`[devserver] run.json konnte nicht geschrieben werden: ${String(e)}`);
    return { generated: false, services: 0, path: p };
  }
}

interface ServiceProc {
  spec: ServiceSpec;
  child?: ChildProcess;
  ready: boolean;
  url?: string;
  /** Bereitschaft wurde ANGENOMMEN (kein Ready-Marker, kein Port zum Prüfen) statt bestätigt.
   *  Die UI zeigt das gelb — „vermutlich bereit" ist nicht dasselbe wie „antwortet". */
  assumed?: boolean;
  /** Nicht erreichbare Abhängigkeit (z. B. "5433") — der Dienst lauscht, kann aber nicht arbeiten. */
  depMissing?: string;
}

/** Antwortet auf diesem lokalen Port jemand? Das ist der einzige BEWEIS für „Dienst ist oben" —
 *  ein Ready-Marker im Log kann fehlen (Serilog formatiert Kestrel anders) oder zu früh kommen. */
function probePort(port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, host: "127.0.0.1" });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
  });
}

const MAX_LINE = 2000; // eine Zeile deckeln (schützt die NDJSON-Pipe vor Riesen-Zeilen)

/**
 * Ein laufender Stream-Dev-Server (ein oder mehrere Services). Vom Orchestrator gehalten;
 * es existiert immer höchstens einer. Emittiert `devserver_status`/`devserver_log` an die UI.
 */
/** Callback bei UNERWARTETEM Absturz eines Service (für die Selbstheilung im Orchestrator). */
export type DevCrashHandler = (service: string, exitCode: number | null, recentLog: string[]) => void;

export class DevServerRun {
  readonly agentId: string;
  private readonly worktree: string;
  private readonly procs: ServiceProc[];
  private installChild?: ChildProcess;
  private state: DevState = "starting";
  private stopping = false;
  private readyTimer?: ReturnType<typeof setTimeout>;
  private readonly onCrash?: DevCrashHandler;
  private crashReported = false;
  private degraded = false; // true, sobald ein Service abstürzte, andere aber weiterlaufen (Survivor-Modus)
  private started = false; // true erst NACH der Spawn-Schleife — nie „running" melden, solange noch Services fehlen
  private readonly recentLogs = new Map<string, string[]>(); // pro Service, für die Crash-Diagnose
  /** Zustand je Abhängigkeit (host:port → erreichbar?) — speist den dritten Indikator. */
  private readonly depState = new Map<string, { host: string; port: number; name: string; ok: boolean }>();
  /** Abhängigkeiten, deren `start` bereits versucht wurde (nur EIN Versuch pro Lauf). */
  private readonly depStarted = new Set<string>();
  /** Repo-Root (NICHT der Worktree): Abhängigkeits-Startbefehle laufen hier, damit z. B.
   *  `docker compose` denselben Projektnamen wie sonst nutzt und keine Zweit-Container erzeugt. */
  private readonly repoRoot: string;

  constructor(agentId: string, worktree: string, manifest: RunManifest, onCrash?: DevCrashHandler, repoRoot?: string) {
    this.agentId = agentId;
    this.worktree = worktree;
    this.repoRoot = repoRoot || worktree;
    this.procs = manifest.services.map((spec) => ({ spec, ready: false, url: spec.url }));
    this.onCrash = onCrash;
  }

  private emitLog(service: string, stream: "stdout" | "stderr", line: string): void {
    const capped = line.length > MAX_LINE ? line.slice(0, MAX_LINE) + "…" : line;
    // Kleiner Ringpuffer pro Service — die letzten Zeilen liefern der Selbstheilung den Kontext.
    const buf = this.recentLogs.get(service) ?? [];
    buf.push(`[${stream}] ${capped}`);
    if (buf.length > 40) buf.splice(0, buf.length - 40);
    this.recentLogs.set(service, buf);
    send({ ...envelope(), type: "devserver_log", agentId: this.agentId, service, stream, line: capped });
  }

  /** Alle NOCH lebenden (gespawnten, nicht abgestürzten) Services bereit? Nach einem Absturz das
   *  richtige „läuft"-Kriterium — {@link allUp} zählt den toten Prozess mit und wäre nie wieder true. */
  private liveAllReady(): boolean {
    const live = this.procs.filter((p) => p.child?.pid != null);
    return live.length > 0 && live.every((p) => p.ready);
  }

  private primaryUrl(): string | undefined {
    // Nur LEBENDE Services dürfen die „im Browser öffnen"-URL stellen — sonst würde nach einem Absturz
    // (Survivor-Modus) der tote Service (dessen `url` gesetzt bleibt) einen Connection-refused-Link liefern.
    const live = this.procs.filter((p) => p.child?.pid != null && p.url);
    const openable = live.filter((p) => p.spec.open);
    if (openable.length) return (openable.find((p) => p.ready) ?? openable[0]).url;
    // KEIN stiller Rückfall auf einen Nicht-`open`-Service, wenn das Projekt einen `open`-Service
    // KENNT, dieser aber tot ist: sonst verlinkt mads das überlebende Backend, der Nutzer landet auf
    // einem API-Endpunkt und sieht 404 — obwohl der Knopf grün „läuft" meldet. Lieber keine URL als
    // eine falsche. Ohne konfigurierten `open`-Service bleibt der bisherige Rückfall bestehen.
    if (this.procs.some((p) => p.spec.open)) return undefined;
    return (live.find((p) => p.ready) ?? live[0])?.url;
  }

  /** Konfigurierte, aber nicht (mehr) laufende Services — für eine ehrliche Statusmeldung. */
  private deadServiceNames(): string[] {
    return this.procs.filter((p) => p.child?.pid == null).map((p) => p.spec.name);
  }

  /**
   * Kompakte Sicht für den Projekt-Verbund: welcher Stream, welche URL, wirklich bereit?
   * Die Gegenseite testet gegen diese URL, während der PR hier noch offen ist — deshalb zählt
   * `ready` (bewiesen), nicht bloß „Prozess läuft".
   */
  describe(): { agentId: string; url?: string; ready: boolean } {
    return { agentId: this.agentId, url: this.primaryUrl(), ready: this.liveAllReady() };
  }

  private emitStatus(message?: string): void {
    // Läuft nur noch ein TEIL der Services, das aber ungesagt, wirkt der grüne „läuft"-Zustand wie
    // „alles gut" — und der Nutzer sucht den Fehler in seinem Code statt am toten Service. Deshalb
    // die toten Dienste beim Namen nennen (nur solange überhaupt noch etwas läuft).
    const dead = this.deadServiceNames();
    const partial =
      dead.length && dead.length < this.procs.length
        ? `Nur teilweise gestartet — nicht (mehr) aktiv: ${dead.join(", ")}. „Dev-Server" neu starten, um sie wieder hochzufahren.`
        : undefined;
    send({
      ...envelope(),
      type: "devserver_status",
      agentId: this.agentId,
      state: this.state,
      services: this.procs.map((p) => ({
        name: p.spec.name,
        ready: p.ready,
        url: p.url,
        // `alive` trennt „startet noch" von „abgestürzt" — ohne das sähe beides gleich aus.
        alive: p.child?.pid != null,
        assumed: p.assumed,
        depMissing: p.depMissing,
      })),
      dependencies: [...this.depState.values()].map((d) => ({ name: d.name, target: `${d.host}:${d.port}`, ok: d.ok })),
      url: this.primaryUrl(),
      message: message ?? partial,
      // Nur melden, solange überhaupt noch etwas läuft — sind ALLE tot, ist das `state: "error"`
      // bzw. „stopped" und kein Teil-Zustand.
      degraded: !!partial,
      deadServices: partial ? dead : undefined,
    });
  }

  private buildEnv(spec: ServiceSpec): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // RCE-1-Härtung: mads-/Agenten-eigene Secrets NICHT an den (aus `.mads/run.json` stammenden,
    // un-sandboxed) Dev-Server vererben — der braucht sie nie; ein manipuliertes run.json könnte sie
    // sonst exfiltrieren. Projekt-eigene Env (appsettings/VITE_*/DB) bleibt bewusst erhalten.
    for (const k of Object.keys(env)) {
      if (k.startsWith("ANTHROPIC_") || k.startsWith("CLAUDE_") || k === "GH_TOKEN" || k === "GITHUB_TOKEN" || k === "GH_ENTERPRISE_TOKEN") {
        delete env[k];
      }
    }
    for (const [k, v] of Object.entries(spec.env ?? {})) env[k] = expandEnv(v);
    // Denselben node/npm wie der Sidecar erzwingen (dessen bin-Verzeichnis GANZ vorne im PATH).
    // Sonst nimmt die Sub-Shell evtl. ein node anderer Architektur (macOS: /usr/local x64 vs.
    // /opt/homebrew arm64) als das, mit dem node_modules installiert wurde → native Binaries wie
    // esbuild passen nicht („You installed esbuild for another platform", darwin-arm64 vs -x64).
    // process.execPath ist exakt das node, unter dem der Sidecar läuft; dessen bin hat auch npm/npx.
    const nodeDir = dirname(process.execPath);
    env.PATH = `${nodeDir}:${env.PATH ?? ""}`;
    return env;
  }

  private runOnce(spec: ServiceSpec, command: string): Promise<number> {
    return new Promise((resolve) => {
      const cwd = join(this.worktree, spec.cwd ?? ".");
      // detached → eigene Prozess-Gruppe, damit stop() auch von npm/dotnet geforkte Install-Kinder
      // (Lifecycle-Scripts, node-gyp …) per Gruppen-Kill erwischt und nichts verwaist.
      // KEIN Login-Shell (`-c`, nicht `-lc`): sonst würde macOS' path_helper den PATH neu aufbauen
      // und unser vorangestelltes node-Verzeichnis wieder nach hinten schieben (arm64→x64-Mismatch).
      const child = spawn("/bin/sh", ["-c", command], { cwd, env: this.buildEnv(spec), detached: true, stdio: ["ignore", "pipe", "pipe"] });
      this.installChild = child;
      if (child.stdout) readline.createInterface({ input: child.stdout }).on("line", (l) => this.emitLog(spec.name, "stdout", l));
      if (child.stderr) readline.createInterface({ input: child.stderr }).on("line", (l) => this.emitLog(spec.name, "stderr", l));
      child.on("error", (e) => {
        this.emitLog(spec.name, "stderr", `Fehler beim Ausführen von "${command}": ${String(e)}`);
        resolve(-1);
      });
      child.on("exit", (code) => {
        if (this.installChild === child) this.installChild = undefined;
        resolve(code ?? -1);
      });
    });
  }

  /**
   * PRE-FLIGHT: den Service-Port freiräumen, falls ihn ein VERWAISTER Vorgänger hält (typisch nach
   * Force-Quit/Crash von mads oder einem manuell im Terminal gestarteten Server) — sonst bricht z. B.
   * Kestrel/.NET mit „address already in use" ab (exit 134/SIGABRT beim ERSTEN Start). mads besitzt
   * die Stream-Dev-Server-Ports (run.json), darf den Blockierer also beenden. Transparent geloggt.
   */
  private async freePort(spec: ServiceSpec): Promise<void> {
    const port = portOf(spec);
    if (!port) return;
    let pids = (await pidsOnPort(port)).filter((pid) => pid !== process.pid);
    if (!pids.length) return;
    this.emitLog(spec.name, "stderr", `Port ${port} noch belegt (pid ${pids.join(", ")}) — beende verwaisten Vorgänger.`);
    for (const pid of pids) {
      try { process.kill(pid, "SIGTERM"); } catch { /* schon weg */ }
    }
    await new Promise((r) => setTimeout(r, 600));
    pids = (await pidsOnPort(port)).filter((pid) => pid !== process.pid);
    for (const pid of pids) {
      try { process.kill(pid, "SIGKILL"); } catch { /* schon weg */ }
    }
    if (pids.length) await new Promise((r) => setTimeout(r, 300)); // kurz aufs Freigeben warten
  }

  private spawnService(p: ServiceProc): void {
    const cwd = join(this.worktree, p.spec.cwd ?? ".");
    const child = spawn("/bin/sh", ["-c", p.spec.command], {
      cwd,
      env: this.buildEnv(p.spec),
      detached: true, // eigene Prozess-GRUPPE → Gruppen-Kill erwischt geforkte Kinder
      stdio: ["ignore", "pipe", "pipe"],
    });
    p.child = child;
    if (!p.spec.ready) p.ready = true; // ohne Ready-Marker: direkt als bereit werten

    const onLine = (stream: "stdout" | "stderr") => (line: string) => {
      this.emitLog(p.spec.name, stream, line);
      if (!p.ready && p.spec.ready && line.includes(p.spec.ready)) {
        p.ready = true;
        // Normalstart: ALLE Services müssen leben+bereit sein (allUp verhindert ein verfrühtes „running",
        // solange spätere Services noch nicht gespawnt sind). Im Survivor-Modus (degraded, nach einem
        // Absturz) zählt allUp den toten Prozess mit und würde nie mehr true — dann reicht: alle LEBENDEN
        // bereit, ABER erst wenn die Spawn-Schleife durch ist (`started`), sonst würde ein noch nicht
        // gestarteter Service übersehen und verfrüht „running" gemeldet.
        const promotable = this.degraded ? this.started && this.liveAllReady() : this.allUp();
        if (this.state !== "running" && promotable) {
          this.state = "running";
          if (this.readyTimer) clearTimeout(this.readyTimer);
        }
        this.emitStatus();
      }
    };
    if (child.stdout) readline.createInterface({ input: child.stdout }).on("line", onLine("stdout"));
    if (child.stderr) readline.createInterface({ input: child.stderr }).on("line", onLine("stderr"));
    child.on("error", (e) => {
      // Spawn schlug fehl (z. B. cwd existiert nicht, /bin/sh fehlt) → NUR 'error', nie 'exit',
      // pid ist undefined. Nicht fälschlich als „läuft" melden — als Fehler behandeln.
      this.emitLog(p.spec.name, "stderr", `spawn-Fehler: ${String(e)}`);
      p.child = undefined;
      p.ready = false;
      if (this.stopping) return;
      this.state = "error";
      this.emitStatus(`Service „${p.spec.name}" konnte nicht gestartet werden — siehe Log.`);
      void this.stop();
    });
    child.on("exit", (code, signal) => {
      p.child = undefined;
      p.ready = false;
      if (this.stopping) return; // erwartetes Beenden (wir stoppen gerade)
      this.emitLog(p.spec.name, "stderr", `⚠ Prozess beendet (exit ${code ?? "?"}${signal ? `, ${signal}` : ""}).`);
      const crashLog = [...(this.recentLogs.get(p.spec.name) ?? [])];
      const firstCrash = !this.crashReported; // nur EINMAL heilen (Kaskaden nicht doppelt anstoßen)
      this.crashReported = true;
      // Ein EINZELNER Service-Absturz reißt NICHT den ganzen Dev-Server ab: laufen noch andere Dienste
      // (typisch das Frontend), bleiben sie am Leben. Sonst ließe sich z. B. ein reiner Frontend-PR nicht
      // ansehen, nur weil das Backend scheitert — im Review-Worktree passiert das systematisch, weil dort
      // bewusst KEINE lokalen Secrets geseedet werden (DB/Mail-Config fehlt). Erst wenn NICHTS mehr
      // läuft → Fehler + Stop. onCrash feuert weiterhin (Selbstheilung/Meldung entscheidet der Aufrufer).
      const survivors = this.procs.filter((x) => x.child?.pid != null);
      if (survivors.length > 0) {
        this.degraded = true; // ab jetzt zählt für „running" nur noch, ob alle LEBENDEN Dienste bereit sind
        // „running", sobald alle NOCH laufenden Dienste bereit sind; sonst „starting" lassen, damit der
        // Ready-Marker (degraded-Pfad in onLine) bzw. der Fallback-Timer sie hochstuft (readyTimer NICHT abbrechen).
        this.state = this.liveAllReady() ? "running" : "starting";
        this.emitStatus(`Service „${p.spec.name}" beendet (exit ${code ?? "?"}) — die übrigen Dienste laufen weiter, siehe Log.`);
      } else {
        this.state = "error";
        this.emitStatus(`Service „${p.spec.name}" unerwartet beendet — siehe Log.`);
        void this.stop();
      }
      if (firstCrash) this.onCrash?.(p.spec.name, code, crashLog);
    });
  }

  /** Alle Services bereit UND tatsächlich gespawnt (pid gesetzt)? Ein fehlgeschlagener Spawn hat
   *  pid=undefined → zählt NICHT als „läuft" (sonst kurzzeitig falsches „running" vor dem error-Event). */
  private allUp(): boolean {
    return this.procs.every((p) => p.ready && p.child?.pid != null);
  }

  async start(): Promise<void> {
    this.state = "starting";
    this.crashReported = false; // frischer Start → Selbstheilung wieder scharf
    this.degraded = false; // frischer Start → wieder Normalstart-Semantik (allUp), kein Survivor-Modus
    this.started = false; // Spawn-Schleife läuft noch → „running" frühestens nach der Schleife
    this.depStarted.clear();
    this.emitStatus();
    // ZUERST die Abhängigkeiten (DB/Cache/…): fehlt eine und ist ein `start` deklariert, wird sie
    // hochgefahren. Sonst startet z. B. das Backend zwar, kann aber keine Anfrage beantworten —
    // und der Nutzer sucht den Fehler in seinem Code statt bei einem nicht laufenden Docker.
    await this.checkDeps(true);
    this.emitStatus();
    for (const p of this.procs) {
      if (this.stopping) return;
      if (p.spec.install) {
        const cwd = join(this.worktree, p.spec.cwd ?? ".");
        const need = !p.spec.installIfMissing || !existsSync(join(cwd, p.spec.installIfMissing));
        if (need) {
          this.state = "installing";
          this.emitStatus(`${p.spec.name}: ${p.spec.install} …`);
          const code = await this.runOnce(p.spec, p.spec.install);
          if (this.stopping) return;
          if (code !== 0) {
            this.state = "error";
            this.emitStatus(`${p.spec.name}: „${p.spec.install}" fehlgeschlagen (exit ${code}) — siehe Log.`);
            return;
          }
        }
      }
      if (this.stopping) return;
      await this.freePort(p.spec); // verwaisten Vorgänger auf dem Service-Port freiräumen
      if (this.stopping) return;
      this.spawnService(p);
    }
    // Spawn-Schleife durch → ab jetzt darf „running" gemeldet werden (kein noch fehlender Service).
    this.started = true;
    // „running", sobald alle Services mit Ready-Marker bereit sind (die ohne gelten sofort). Ist während
    // des Startens schon ein Service abgestürzt (degraded, aber andere leben weiter), zählen nur die
    // LEBENDEN — sonst bliebe es wegen des toten Prozesses fälschlich in „starting".
    this.state = (this.degraded ? this.liveAllReady() : this.allUp()) ? "running" : "starting";
    this.emitStatus();
    // Greift ein Ready-Marker nicht (z. B. Serilog formatiert die Kestrel-Zeile anders), wurde früher
    // nach 15 s einfach BEHAUPTET, alles sei bereit. Das log bei langsamen Diensten: `dotnet run`
    // kompiliert beim ersten Start deutlich länger, mads meldete trotzdem grün — und das Login gegen
    // ein noch nicht gestartetes Backend schlug fehl. Jetzt wird am PORT nachgewiesen statt geraten,
    // und so lange weiter geprüft, wie der Dienst noch startet.
    if (this.state === "starting") this.scheduleReadyProbe(3_000);
  }

  /**
   * Bereitschaft am Port BEWEISEN statt annehmen. Wiederholt sich, solange noch etwas startet.
   * Nur Dienste OHNE ermittelbaren Port fallen nach einer Karenzzeit auf „angenommen" zurück —
   * die werden in der UI gelb (nicht grün) dargestellt, damit der Unterschied sichtbar bleibt.
   */
  private scheduleReadyProbe(delayMs: number, elapsedMs = 0): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = setTimeout(() => void this.probeReadiness(elapsedMs + delayMs), delayMs);
    this.readyTimer.unref?.();
  }

  /** Alle deklarierten Abhängigkeiten über alle Services, dedupliziert (host:port ist der Schlüssel). */
  private deps(): NonNullable<ReturnType<typeof normalizeDep>>[] {
    const byKey = new Map<string, NonNullable<ReturnType<typeof normalizeDep>>>();
    for (const p of this.procs) {
      for (const raw of p.spec.requires ?? []) {
        const d = normalizeDep(raw);
        if (d && !byKey.has(`${d.host}:${d.port}`)) byKey.set(`${d.host}:${d.port}`, d);
      }
    }
    return [...byKey.values()];
  }

  /**
   * Abhängigkeiten prüfen — und fehlende, für die ein `start` deklariert ist, EINMAL hochfahren.
   * Ohne das meldet ein Backend fröhlich „läuft", obwohl seine Datenbank fehlt: es lauscht ja, kann
   * aber keine Anfrage beantworten (real: jeder Login schlug mit „Passwort falsch" fehl, weil Docker
   * und damit Postgres nicht lief — und NICHTS in der UI wies darauf hin).
   */
  private async checkDeps(autoStart: boolean): Promise<void> {
    const deps = this.deps();
    if (!deps.length) return;
    for (const d of deps) {
      let ok = await probePort(d.port, 600);
      if (!ok && autoStart && d.start && !this.depStarted.has(`${d.host}:${d.port}`)) {
        this.depStarted.add(`${d.host}:${d.port}`);
        this.emitLog("dependencies", "stderr", `${d.name} nicht erreichbar — starte: ${d.start}`);
        // Grosszuegiges Budget: Ein Startbefehl darf eine ganze Laufzeitumgebung hochfahren (Docker
        // Desktop braucht auf einem kalten Mac gut und gerne eine Minute). Zu knapp bemessen sah es
        // vorher so aus, als haette der Auto-Start "nicht funktioniert".
        const budgetMs = Math.max(30_000, (d.startTimeoutSec ?? 180) * 1000);
        await new Promise<void>((resolve) => {
          const c = spawn("/bin/sh", ["-lc", d.start!], { cwd: this.repoRoot, detached: false, stdio: ["ignore", "pipe", "pipe"] });
          c.stdout?.on("data", (b: Buffer) => this.emitLog("dependencies", "stdout", String(b).trimEnd()));
          c.stderr?.on("data", (b: Buffer) => this.emitLog("dependencies", "stderr", String(b).trimEnd()));
          const t = setTimeout(() => {
            this.emitLog("dependencies", "stderr", `Startbefehl fuer ${d.name} laeuft laenger als ${Math.round(budgetMs / 1000)} s — abgebrochen.`);
            try { c.kill("SIGTERM"); } catch { /* schon weg */ }
            resolve();
          }, budgetMs);
          const done = () => { clearTimeout(t); resolve(); };
          c.on("exit", done);
          c.on("error", done);
        });
        // Nach dem Startbefehl braucht der Dienst selbst noch Zeit (Container-Boot). Mit sichtbarem
        // Fortschritt, damit "es passiert nichts" nicht wie ein Fehlschlag aussieht.
        for (let i = 0; i < 60 && !ok; i++) {
          await new Promise((r) => setTimeout(r, 1_000));
          ok = await probePort(d.port, 600);
          if (!ok && i > 0 && i % 15 === 0) this.emitLog("dependencies", "stderr", `warte weiter auf ${d.name} (${i} s)…`);
        }
        this.emitLog("dependencies", "stderr", ok ? `${d.name} ist jetzt erreichbar.` : `${d.name} weiterhin NICHT erreichbar.`);
      }
      this.depState.set(`${d.host}:${d.port}`, { ...d, ok });
    }
    // Dienste, deren Abhängigkeit fehlt, tragen den Grund — damit der Indikator nicht grün lügt.
    for (const p of this.procs) {
      const missing = (p.spec.requires ?? [])
        .map((r) => normalizeDep(r))
        .filter((d): d is NonNullable<typeof d> => !!d)
        .filter((d) => this.depState.get(`${d.host}:${d.port}`)?.ok === false)
        .map((d) => d.name);
      p.depMissing = missing.length ? missing.join(", ") : undefined;
    }
  }

  private async probeReadiness(elapsedMs: number): Promise<void> {
    if (this.stopping || this.state === "stopped" || this.state === "error") return;
    await this.checkDeps(false); // laufend nachprüfen — eine DB kann auch SPÄTER wegfallen
    let changed = false;
    for (const p of this.procs) {
      if (p.ready || p.child?.pid == null) continue;
      const port = portOf(p.spec);
      if (port) {
        if (await probePort(port)) {
          p.ready = true;
          changed = true;
          this.emitLog(p.spec.name, "stderr", `Bereit bestätigt (Port ${port} antwortet).`);
        }
      } else if (elapsedMs >= 15_000) {
        // Kein Port ableitbar → nach Karenzzeit annehmen, aber als „angenommen" markieren.
        p.ready = true;
        p.assumed = true;
        changed = true;
      }
    }
    const allReady = this.degraded ? this.liveAllReady() : this.allUp();
    if (allReady && this.state !== "running") {
      this.state = "running";
      changed = true;
    }
    if (changed) this.emitStatus();
    // Weiter prüfen, solange etwas Lebendes noch nicht bereit ist. Nach 5 Minuten aufgeben (der
    // Dienst kommt dann nicht mehr; das Log zeigt warum) — sonst liefe der Timer endlos.
    const pending = this.procs.some((p) => p.child?.pid != null && !p.ready);
    if (pending && elapsedMs < 300_000) this.scheduleReadyProbe(elapsedMs < 30_000 ? 2_000 : 5_000, elapsedMs);
  }

  /** Signal an die ganze Prozess-Gruppe (detached → -pid); Fallback auf den Einzel-PID. */
  private signal(pid: number, sig: NodeJS.Signals): void {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        /* schon tot */
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    const children: ChildProcess[] = [];
    if (this.installChild) children.push(this.installChild);
    for (const p of this.procs) {
      if (p.child) children.push(p.child);
      p.ready = false;
    }
    // 1) SIGTERM an alle Gruppen. 2) Kurz auf sauberes Beenden warten. 3) Verbliebene SYNCHRON
    //    hart killen — synchron, damit ein direkt folgendes process.exit(0) (Shutdown) den
    //    SIGKILL nicht verschluckt (ein setTimeout würde vom Exit verworfen).
    for (const c of children) if (c.pid) this.signal(c.pid, "SIGTERM");
    await Promise.race([
      Promise.all(children.map((c) => (c.exitCode !== null || c.signalCode !== null ? Promise.resolve() : new Promise<void>((r) => c.once("exit", () => r()))))),
      new Promise<void>((r) => setTimeout(r, 2000).unref?.()),
    ]);
    for (const c of children) if (c.pid && c.exitCode === null && c.signalCode === null) this.signal(c.pid, "SIGKILL");
    this.state = "stopped";
    this.emitStatus();
  }
}
