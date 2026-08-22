/**
 * mads Sidecar — Einstiegspunkt.
 * Liest HostMessages als NDJSON von stdin (zeilengepuffert), schreibt
 * SidecarMessages als NDJSON auf stdout. Alle Logs gehen auf stderr.
 */
import readline from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { send, log, envelope } from "./io.js";
import { Orchestrator } from "./orchestrator.js";
import { run } from "./git.js";
import type { HostMessage } from "../../shared/protocol.js";

async function detectSdk(): Promise<{ available: boolean; version: string }> {
  try {
    // Nur Verfügbarkeit prüfen — kein Agent gestartet, keine Auth nötig.
    await import("@anthropic-ai/claude-agent-sdk");
    return { available: true, version: process.env.MADS_SDK_VERSION ?? "installed" };
  } catch {
    return { available: false, version: "missing" };
  }
}

/**
 * Erkennt, ob DIESER laufende Sidecar-Prozess älter ist als main — die installierte mads.app führt
 * dist/index.js direkt aus dem Repo-Checkout aus, ein reiner `git merge` auf main hat also OHNE
 * `npm run sidecar:build` + App-Neustart keine Wirkung (siehe git-lease.test.ts / Commit 9eae497:
 * genau diese Lücke ließ einen bereits gefixten "stale info"-Deadlock live weiterlaufen). Vergleicht
 * den beim Build eingestempelten Commit (__SIDECAR_GIT_COMMIT__, via scripts/build.mjs) mit dem
 * aktuellen Repo-HEAD.
 */
async function checkBuildDrift(): Promise<{ stale: boolean; buildCommit: string; currentCommit: string }> {
  const buildCommit = __SIDECAR_GIT_COMMIT__;
  const buildDirty = __SIDECAR_GIT_DIRTY__;
  // dist/index.js liegt bei <repoRoot>/sidecar/dist/index.js — zwei Verzeichnisse hoch ist die Repo-Root.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const head = await run("git", ["rev-parse", "--short", "HEAD"], repoRoot, 5_000);
  const currentCommit = head.code === 0 ? head.stdout.trim() : "unknown";
  // "unknown" (kein Git zur Build-Zeit) oder ein dirty Build (lokale Entwicklung) sind kein
  // verlässliches Signal — nur ein sauberer, bekannter Build-Commit ungleich dem aktuellen HEAD ist es.
  const stale = buildCommit !== "unknown" && !buildDirty && currentCommit !== "unknown" && currentCommit !== buildCommit;
  return { stale, buildCommit, currentCommit };
}

async function main(): Promise<void> {
  const orchestrator = new Orchestrator();

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: HostMessage;
    try {
      msg = JSON.parse(trimmed) as HostMessage;
    } catch {
      log("[sidecar] ungültiges JSON:", trimmed);
      return;
    }
    try {
      await orchestrator.dispatch(msg);
    } catch (e) {
      log("[sidecar] dispatch-Fehler:", String(e));
    }
  });

  rl.on("close", () => {
    // Über den Shutdown-Pfad beenden → laufender Dev-Server wird sauber gekillt (sonst verwaist
    // dessen Prozess-Gruppe). Der shutdown-Handler ruft am Ende selbst process.exit(0).
    log("[sidecar] stdin geschlossen — beende");
    orchestrator.dispatch({ ...envelope(), type: "shutdown" }).catch(() => process.exit(0));
  });

  const sdk = await detectSdk();
  const drift = await checkBuildDrift();
  if (drift.stale) {
    log(
      `[sidecar] ACHTUNG: Build veraltet — läuft auf Commit ${drift.buildCommit}, HEAD ist ${drift.currentCommit}. ` +
        `npm run sidecar:build ausführen und mads komplett neu starten, sonst wirken gemergte Sidecar-Fixes nicht.`,
    );
  }
  await send({
    ...envelope(),
    type: "sidecar_ready",
    pid: process.pid,
    sdkVersion: sdk.version,
    sdkAvailable: sdk.available,
    resumableAgents: [],
    buildCommit: drift.buildCommit,
    buildStale: drift.stale,
  });
  log(`[sidecar] bereit (pid ${process.pid}, build ${drift.buildCommit}, sdk ${sdk.available ? sdk.version : "fehlt"})`);
}

void main();
