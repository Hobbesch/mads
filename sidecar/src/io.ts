/**
 * Backpressure-sicheres NDJSON-Schreiben auf stdout + Logging auf stderr.
 * WICHTIG: stdout ist NUR für Protokoll-NDJSON. Jedes versehentliche console.log
 * auf stdout würde den Stream zerstören → immer log() (stderr) verwenden.
 */
import { randomUUID } from "node:crypto";
import { redactSecrets } from "../../shared/secrets.js";

let writeChain: Promise<void> = Promise.resolve();

// SEC-1 / RB-LEAK-1: der NDJSON-Stream (→ Frontend, Transcript, Snapshot-Puffer UND der Bridge-Tee
// an gekoppelte Remote-Geräte) trug bisher Secrets UNREDIGIERT — Tool-Call-Inputs (ganze Shell-
// Kommandozeilen), Tool-Outputs (z. B. `cat .env`), Assistant/Thinking. Hier am ZENTRALEN Egress
// redigieren → alle Downstream-Sinks erben es. Identitätsschonend: unveränderte Objekte bleiben
// dieselbe Referenz (kein Clone-Overhead pro Nachricht, wenn kein Secret drin ist).
function redactValue(v: unknown): unknown {
  if (typeof v === "string") return redactSecrets(v);
  if (Array.isArray(v)) {
    let changed = false;
    const r = v.map((x) => {
      const y = redactValue(x);
      if (y !== x) changed = true;
      return y;
    });
    return changed ? r : v;
  }
  if (v && typeof v === "object") {
    let changed = false;
    const r: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      const y = redactValue(val);
      if (y !== val) changed = true;
      r[k] = y;
    }
    return changed ? r : v;
  }
  return v;
}
// Den GESAMTEN Envelope generisch durchlaufen statt eine Typ-Allowlist zu pflegen: ein adversarialer
// Review zeigte, dass eine Per-Typ-Liste die geheimnis-dichten Pfade permission_request (ROHER
// Bash-/Write-Input!), devserver_log (Dev-Server-stdout mit DB-URL/Keys), needs_input, gate_result,
// handoff_result … übersieht — sie alle gehen an denselben Tee (UI/Transcript/Bridge-an-Remote) und
// permission_request wird bei jedem `request_snapshot` erneut ausgespielt. redactValue ist
// identitätsschonend: ohne Treffer bleibt dieselbe Referenz (kein Clone/Alloc pro Nachricht).
// Strukturfelder (type/agentId/requestId = UUIDs, SHAs, Enums) matchen KEINES der Secret-PATTERNS
// (alle Prefix-verankert: AKIA/gh*_/sk-/eyJ.…) → Routing/Korrelation bleibt unangetastet; nur
// tatsächlich matchende String-Blätter werden ersetzt.
export function redactForEgress(obj: unknown): unknown {
  return redactValue(obj);
}

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
  const red = redactForEgress(obj); // vor Puffer UND stdout redigieren → alle Sinks erben es
  recordTimeline(red);
  writeChain = writeChain.then(
    () =>
      new Promise<void>((resolve) => {
        const ok = process.stdout.write(JSON.stringify(red) + "\n");
        if (ok) resolve();
        else process.stdout.once("drain", () => resolve());
      }),
  );
  return writeChain;
}

export function log(...parts: unknown[]): void {
  // Auch stderr (→ Rust → Frontend-debugLog) redigieren: SDK-stderr/Diagnose kann Secrets tragen (SEC-1).
  const line = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
  process.stderr.write(redactSecrets(line) + "\n");
}

/** Gemeinsamer Nachrichten-Umschlag (v/id/ts). */
export function envelope() {
  return { v: 1 as const, id: randomUUID(), ts: Date.now() };
}

export { randomUUID };
