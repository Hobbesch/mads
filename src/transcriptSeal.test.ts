// Tests für das Transkript-Siegel — der Verlust-Fall vom 23.09.2026.
//
// Ausgangslage: Ein fertiger Stream („Reports - kWh pro kWp") wurde per Fehlklick gestoppt.
// `stopAgent` leert `events[agentId]` im Store, der Sidecar schickte danach aber noch sein
// Abschluss-Event („↻ Aufgeräumt: 1 Prozess beendet"). `pushEvent` legte den Verlauf mit dieser
// EINEN Zeile neu an und stieß den debounced Save an — der überschrieb `.mads/transcripts/
// <agentId>.json`. Von der gesamten Prompting- und Frage-Antwort-Arbeit blieben 164 Bytes.
//
// Kernaussage: Nach `seal` schreibt dieser Stream nicht mehr — weder über einen neu angestoßenen
// Save noch über einen Timer, der vor dem Stop schon lief. `unseal` (ausdrücklicher Neustart)
// macht ihn wieder schreibfähig.
import { createTranscriptWriter } from "./transcriptSeal";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log("PASS", name);
  } else {
    failed++;
    console.log("FAIL", name);
  }
}

/** Timer-Ersatz ohne echte Zeit: `run()` feuert alles Geplante, `cancel` nimmt es wieder raus. */
function harness() {
  const written: string[] = [];
  let seq = 0;
  const planned = new Map<number, () => void>();
  const writer = createTranscriptWriter<number>({
    schedule: (fn) => {
      const id = ++seq;
      planned.set(id, fn);
      return id;
    },
    cancel: (id) => {
      planned.delete(id);
    },
    write: (agentId) => {
      written.push(agentId);
    },
  });
  return {
    writer,
    written,
    /** Alle offenen Läufe feuern (auch die, die `cancel` NICHT erwischt hat — siehe "Race"). */
    run: () => {
      for (const fn of [...planned.values()]) fn();
      planned.clear();
    },
    /** Einen Lauf feuern, ohne ihn aus der Planung zu nehmen — simuliert den Timer, der
     *  bereits unterwegs ist, während `seal` läuft. */
    forceAll: () => {
      for (const fn of [...planned.values()]) fn();
    },
    pending: () => planned.size,
  };
}

// ── Normalbetrieb ───────────────────────────────────────────────────────────
{
  const h = harness();
  h.writer.save("a");
  h.run();
  check("ungesiegelt: der Verlauf wird geschrieben", h.written.join() === "a");
}

{
  const h = harness();
  h.writer.save("a");
  h.writer.save("a");
  h.writer.save("a");
  check("debounced: drei Events, nur ein offener Lauf", h.pending() === 1);
  h.run();
  check("debounced: genau einmal geschrieben", h.written.length === 1);
}

// ── Der gemeldete Fall ──────────────────────────────────────────────────────
{
  const h = harness();
  h.writer.save("a"); // Verlauf während der Arbeit
  h.writer.seal("a"); // Stop
  h.run();
  check("Stop verwirft den laufenden Save (nichts überschrieben)", h.written.length === 0);
}

{
  const h = harness();
  h.writer.seal("a");
  h.writer.save("a"); // Abschluss-Event des Sidecars NACH dem Stop
  h.run();
  check("Nach-Stop-Event schreibt nicht mehr — der 164-Byte-Fall", h.written.length === 0);
  check("Nach-Stop-Event plant gar nichts erst ein", h.pending() === 0);
}

{
  // Race: der Timer war schon unterwegs, `cancel` erwischt ihn nicht mehr. Die zweite Prüfung
  // INNERHALB des Laufs muss dichtmachen — sonst bliebe genau die Lücke offen, um die es geht.
  const h = harness();
  h.writer.save("a");
  h.writer.seal("a");
  h.forceAll();
  check("Race: ein bereits feuernder Timer schreibt trotzdem nicht", h.written.length === 0);
}

{
  const h = harness();
  h.writer.save("a");
  h.writer.seal("b"); // anderer Stream gestoppt
  h.run();
  check("Siegel wirkt nur auf seinen Stream", h.written.join() === "a");
}

// ── Wiederaufnahme ──────────────────────────────────────────────────────────
{
  const h = harness();
  h.writer.seal("a");
  check("isSealed meldet den geschlossenen Stream", h.writer.isSealed("a"));
  h.writer.unseal("a"); // ausdrücklicher (Neu-)Start unter derselben agentId
  check("isSealed nach unseal wieder offen", !h.writer.isSealed("a"));
  h.writer.save("a");
  h.run();
  check("nach unseal wird wieder geschrieben", h.written.join() === "a");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
