/**
 * Backpressure-sicheres NDJSON-Schreiben auf stdout + Logging auf stderr.
 * WICHTIG: stdout ist NUR für Protokoll-NDJSON. Jedes versehentliche console.log
 * auf stdout würde den Stream zerstören → immer log() (stderr) verwenden.
 */
import { randomUUID } from "node:crypto";

let writeChain: Promise<void> = Promise.resolve();

export function send(obj: unknown): Promise<void> {
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
