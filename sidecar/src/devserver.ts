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
      });
    }
  }
  return services.length ? { services } : null;
}

/**
 * Erzeugt beim ERSTEN Öffnen eine Starter-`.mads/run.json` aus erkannten Scripts/Projekten
 * (generate-if-absent → überschreibt nie eine editierte Datei). Best effort/heuristisch — der
 * Nutzer prüft Ports/Runtime. Gibt zurück, ob generiert wurde + Service-Anzahl.
 */
export function ensureRunManifest(repoRoot: string): { generated: boolean; services: number } {
  const p = RUN_PATH(repoRoot);
  if (existsSync(p)) return { generated: false, services: 0 };
  const services: ServiceSpec[] = [];

  // Frontend: erstes package.json mit dev/start-Script (root oder gängige UI-Unterordner).
  for (const dir of ["", "client", "frontend", "web", "app", "ui", "packages/web"]) {
    try {
      const pkg = JSON.parse(readFileSync(join(repoRoot, dir, "package.json"), "utf8")) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      const script = scripts.dev ? "dev" : scripts.start ? "start" : null;
      if (script) {
        services.push({
          name: dir ? dir.split("/").pop()! : "frontend",
          cwd: dir || ".",
          install: "npm install",
          installIfMissing: "node_modules",
          command: `npm run ${script}`,
          url: "http://localhost:5173",
          open: true,
          ready: "ready",
        });
        break;
      }
    } catch {
      /* kein package.json hier */
    }
  }

  // Backend: einfache Heuristik nach Runtime — Nutzer trägt Ports/Env nach.
  const globAny = (dir: string, re: RegExp): boolean => {
    try {
      return readdirSync(join(repoRoot, dir)).some((f) => re.test(f));
    } catch {
      return false;
    }
  };
  for (const dir of ["server", "backend", "api", "src", "."]) {
    if (globAny(dir, /\.csproj$/i)) {
      services.push({
        name: "backend",
        cwd: dir,
        command: "dotnet run",
        env: { ASPNETCORE_URLS: "http://localhost:5000" },
        url: "http://localhost:5000",
        ready: "Now listening on",
      });
      break;
    }
    if (existsSync(join(repoRoot, dir, "Cargo.toml"))) {
      services.push({ name: "backend", cwd: dir, command: "cargo run", ready: "Running" });
      break;
    }
    if (existsSync(join(repoRoot, dir, "manage.py"))) {
      services.push({ name: "backend", cwd: dir, command: "python manage.py runserver", url: "http://localhost:8000", ready: "Starting development server" });
      break;
    }
  }

  const doc = {
    _readme:
      "mads Stream-Dev-Server. Jeder Service wird im WORKTREE des Streams gestartet (nicht in main). " +
      "Felder: name, cwd (rel. zum Worktree), install (+installIfMissing = nur wenn Pfad fehlt), command, " +
      "env (Werte dürfen ${VAR} nutzen), url, open:true (=im-Browser-öffnen-URL), ready (Teilstring der " +
      "Ausgabe = 'bereit'). Es läuft immer nur EIN Stream-Dev-Server gleichzeitig. Diese Datei ist eine " +
      "automatisch erzeugte Vorlage — Ports/Runtime bitte prüfen.",
    services,
  };
  try {
    writeFileSync(p, JSON.stringify(doc, null, 2) + "\n", "utf8");
    return { generated: true, services: services.length };
  } catch (e) {
    log(`[devserver] run.json konnte nicht geschrieben werden: ${String(e)}`);
    return { generated: false, services: 0 };
  }
}

interface ServiceProc {
  spec: ServiceSpec;
  child?: ChildProcess;
  ready: boolean;
  url?: string;
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
  private readonly recentLogs = new Map<string, string[]>(); // pro Service, für die Crash-Diagnose

  constructor(agentId: string, worktree: string, manifest: RunManifest, onCrash?: DevCrashHandler) {
    this.agentId = agentId;
    this.worktree = worktree;
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

  private primaryUrl(): string | undefined {
    const openable = this.procs.filter((p) => p.spec.open && p.url);
    const pool = openable.length ? openable : this.procs.filter((p) => p.url);
    return (pool.find((p) => p.ready) ?? pool[0])?.url;
  }

  private emitStatus(message?: string): void {
    send({
      ...envelope(),
      type: "devserver_status",
      agentId: this.agentId,
      state: this.state,
      services: this.procs.map((p) => ({ name: p.spec.name, ready: p.ready, url: p.url })),
      url: this.primaryUrl(),
      message,
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
        if (this.state !== "running" && this.allUp()) {
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
      // Unerwarteter Tod eines Service (z. B. Port belegt, Build-Fehler) → alles stoppen + melden.
      this.emitLog(p.spec.name, "stderr", `⚠ Prozess beendet (exit ${code ?? "?"}${signal ? `, ${signal}` : ""}).`);
      this.state = "error";
      this.emitStatus(`Service „${p.spec.name}" unerwartet beendet — siehe Log.`);
      const crashLog = [...(this.recentLogs.get(p.spec.name) ?? [])];
      const firstCrash = !this.crashReported; // nur EINMAL heilen (Kaskaden nicht doppelt anstoßen)
      this.crashReported = true;
      void this.stop();
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
    // „running", sobald alle Services mit Ready-Marker bereit sind (die ohne gelten sofort).
    // (Ein früher gestorbener Service hätte via seinen Exit-Handler `stopping` gesetzt → oben return.)
    this.state = this.allUp() ? "running" : "starting";
    this.emitStatus();
    // Fallback: greift ein Ready-Marker nach 15 s nicht (z. B. Serilog formatiert die Kestrel-Zeile
    // anders), Bereitschaft annehmen — die Server laufen, nur die Erkennung schlug fehl.
    if (this.state === "starting") {
      this.readyTimer = setTimeout(() => {
        if (this.stopping || this.state !== "starting") return;
        for (const p of this.procs) p.ready = true;
        this.state = "running";
        this.emitStatus("Bereitschaft angenommen (Ready-Marker nicht erkannt) — siehe Log.");
      }, 15_000);
      this.readyTimer.unref?.();
    }
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
