/**
 * Tests für die Modell-Prüfung beim Start. Via `npm run test:modeldiscovery`.
 *
 * Geprüft wird der Teil, der ohne Netz und ohne Zugangsdaten läuft: der Scan des Modell-Katalogs
 * aus der gebündelten Claude-Code-Binärdatei. Er ist die Quelle, die mads IMMER hat — und die
 * einzige, die beantwortet, ob ein Modell mit der lokal installierten CLI-Version überhaupt
 * benutzbar ist (die API weist ein zu neues Modell sonst mit 400 ab).
 *
 * Der Scan liest blockweise; ein Treffer auf einer Blockgrenze darf nicht verloren gehen. Genau
 * das prüft der zweite Block — mit einer echten Datei über der Blockgröße, nicht mit einem Mock.
 */
import { scanCliModelIds } from "./modelDiscovery";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const results: string[] = [];
let failed = 0;
function check(name: string, cond: boolean): void {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
}

const dir = mkdtempSync(join(tmpdir(), "mads-models-"));

async function main(): Promise<void> {
  // ── Modell-IDs aus binärem Umfeld herauslesen ──────────────────────────────
  {
    const f = join(dir, "fake-cli");
    writeFileSync(f, `\0\0binary\0claude-opus-5-5\0junk\u0001claude-sonnet-4-6\0claude-haiku-4-5-20251001\0`);
    const ids = await scanCliModelIds(f);
    check("findet Modelle zwischen Binärmüll", ids.includes("claude-opus-5-5") && ids.includes("claude-sonnet-4-6"));
    // Die datierte Form wird auf ihre Generation zurückgeschnitten — im Katalog ist
    // `claude-haiku-4-5-20251001` dasselbe Modell wie `claude-haiku-4-5` und darf nicht zweimal
    // im Dropdown stehen.
    check("datierte Form wird auf die Generation verkürzt", ids.includes("claude-haiku-4-5"));
    check("erfindet nichts dazu", ids.length === 3);
  }

  // ── Blockgrenze: eine ID, die genau über den Chunk-Rand läuft ──────────────
  {
    const f = join(dir, "big-cli");
    const CHUNK = 4 * 1024 * 1024; // muss zum highWaterMark in modelDiscovery.ts passen
    const id = "claude-opus-7-1";
    const head = "x".repeat(CHUNK - 5); // ID beginnt 5 Bytes vor der Grenze → sie zerfällt
    writeFileSync(f, `${head}${id}${"y".repeat(1024)}`);
    const ids = await scanCliModelIds(f);
    check("Treffer auf der Blockgrenze geht nicht verloren", ids.includes(id));
    check("…und wird nicht doppelt gezählt", ids.filter((x) => x === id).length === 1);
  }

  // ── Fehlertoleranz: der Scan darf nie die Auswahl sprengen ─────────────────
  {
    check("fehlende Datei ergibt leeren Befund", (await scanCliModelIds(join(dir, "gibt-es-nicht"))).length === 0);
    const empty = join(dir, "no-models");
    writeFileSync(empty, "nur text ohne modelle, auch claude-code-2.1.0 zaehlt nicht");
    check("Datei ohne Modelle ergibt leeren Befund", (await scanCliModelIds(empty)).length === 0);
  }

  rmSync(dir, { recursive: true, force: true });
  console.log(results.join("\n"));
  if (failed > 0) {
    console.error(`\n${failed} Test(s) fehlgeschlagen.`);
    process.exit(1);
  }
  console.log(`\n${results.length} Test(s) ok.`);
}

void main();
