/**
 * Backpressure-sicheres NDJSON-Schreiben auf stdout + Logging auf stderr.
 * WICHTIG: stdout ist NUR für Protokoll-NDJSON. Jedes versehentliche console.log
 * auf stdout würde den Stream zerstören → immer log() (stderr) verwenden.
 */
import { randomUUID } from "node:crypto";

let writeChain: Promise<void> = Promise.resolve();

// Per-Agent-Timeline-Ringpuffer für Snapshot-Replay. Das mads-Frontend baut die Timeline aus dem
// Live-Strom; ein Client, der MITTEN in einen Lauf verbindet (iOS-Mirror), hat diese Historie nicht
// — `emitSnapshot` spielt sie aus diesem Puffer als `agent_timeline` zurück. Hier am zentralen
// send() befüllt, damit ALLE agent_event-Quellen (session + orchestrator) erfasst sind.
const TIMELINE_CAP = 500;
const timelineBuffers = new Map<string, unknown[]>();

function recordTimeline(obj: unknown): void {
  if (!obj || typeof obj !== "object") return;
  const m = obj as { type?: unknown; agentId?: unknown; event?: unknown };
  if (m.type !== "agent_event" || typeof m.agentId !== "string" || !m.event) return;
  let buf = timelineBuffers.get(m.agentId);
  if (!buf) {
    buf = [];
    timelineBuffers.set(m.agentId, buf);
  }
  buf.push(m.event);
  if (buf.length > TIMELINE_CAP) buf.splice(0, buf.length - TIMELINE_CAP);
}

/** Gepufferter agent_event-Verlauf eines Agenten (für den emitSnapshot-Replay). */
export function timelineSnapshot(agentId: string): unknown[] {
  return timelineBuffers.get(agentId) ?? [];
}

/** Timeline eines entfernten/beendeten Agenten freigeben (kein unbegrenztes Wachstum). */
export function forgetTimeline(agentId: string): void {
  timelineBuffers.delete(agentId);
}

export function send(obj: unknown): Promise<void> {
  recordTimeline(obj);
  writeChain = writeChain.then(
    () =>
      new Promise<void>((resolve) => {
        const ok = process.stdout.write(JSON.stringify(obj) + "\n");
        if (ok) resolve();
        else process.stdout.once("drain", () => resolve());
      }),
  );
  return writeChain;
}

export function log(...parts: unknown[]): void {
  process.stderr.write(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ") + "\n");
}

/** Gemeinsamer Nachrichten-Umschlag (v/id/ts). */
export function envelope() {
  return { v: 1 as const, id: randomUUID(), ts: Date.now() };
}

export { randomUUID };
