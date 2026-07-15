/**
 * mads Sidecar — Einstiegspunkt.
 * Liest HostMessages als NDJSON von stdin (zeilengepuffert), schreibt
 * SidecarMessages als NDJSON auf stdout. Alle Logs gehen auf stderr.
 */
import readline from "node:readline";
import { send, log, envelope } from "./io.js";
import { Orchestrator } from "./orchestrator.js";
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
  await send({
    ...envelope(),
    type: "sidecar_ready",
    pid: process.pid,
    sdkVersion: sdk.version,
    sdkAvailable: sdk.available,
    resumableAgents: [],
  });
  log(`[sidecar] bereit (pid ${process.pid}, sdk ${sdk.available ? sdk.version : "fehlt"})`);
}

void main();
