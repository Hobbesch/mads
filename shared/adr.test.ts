/**
 * Tests für die reine ADR-Nummern-Logik (shared/adr.ts). Via `npm run test:adr`.
 * Stellt sicher, dass der Kollisions-Backstop nur vom Branch HINZUGEFÜGTE, mit der Basis
 * KOLLIDIERENDE Nummern umnummeriert — geerbte ADRs und DRAFT-Dateien bleiben unberührt.
 */
import { adrNumbersIn, planAdrCollisionRenames } from "./adr";

const results: string[] = [];
let failed = 0;
function check(name: string, cond: boolean): void {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
}

const D = "docs/decisions/";

// adrNumbersIn: führende Nummern, DRAFT zählt nicht
check(
  "adrNumbersIn liest führende Nummern, ignoriert DRAFT",
  JSON.stringify(adrNumbersIn([`${D}ADR-0073-x.md`, `${D}ADR-DRAFT-foo.md`, `${D}ADR-0074-y.md`]).sort((a, b) => a - b)) ===
    JSON.stringify([73, 74]),
);

// keine Kollision: 0074 ist auf der Basis NICHT vergeben
check(
  "keine Kollision → leerer Plan",
  planAdrCollisionRenames([`${D}ADR-0073-x.md`], [`${D}ADR-0073-x.md`, `${D}ADR-0074-deployment.md`]).length === 0,
);

// echte Cross-Branch-Kollision: main hat 0074 (unified), Branch fügt eigene 0074 (deployment) hinzu
{
  const base = [`${D}ADR-0073-x.md`, `${D}ADR-0074-unified.md`];
  const own = [`${D}ADR-0073-x.md`, `${D}ADR-0074-unified.md`, `${D}ADR-0074-deployment.md`];
  const plan = planAdrCollisionRenames(base, own);
  check("Kollision erkannt (genau 1 Umbenennung)", plan.length === 1);
  check("nur die hinzugefügte Datei wird umbenannt", plan[0]?.from === `${D}ADR-0074-deployment.md`);
  check("nächste freie Nummer = 0075", plan[0]?.num === "0075");
  check("Zielpfad korrekt", plan[0]?.to === `${D}ADR-0075-deployment.md`);
  check("oldStem/newStem slug-qualifiziert", plan[0]?.oldStem === "ADR-0074-deployment" && plan[0]?.newStem === "ADR-0075-deployment");
}

// geerbte (unveränderte) ADR mit gleicher Nummer wird NIE umnummeriert
check(
  "geerbte ADR (gleicher Pfad wie Basis) bleibt unberührt",
  planAdrCollisionRenames([`${D}ADR-0074-unified.md`], [`${D}ADR-0074-unified.md`]).length === 0,
);

// DRAFT-Dateien werden vom Backstop ignoriert (die behandelt finalizeAdrDrafts)
check(
  "DRAFT-Datei wird vom Kollisions-Backstop ignoriert",
  planAdrCollisionRenames([`${D}ADR-0074-unified.md`], [`${D}ADR-0074-unified.md`, `${D}ADR-DRAFT-neu.md`]).length === 0,
);

// zwei hinzugefügte Kollisionen → fortlaufend, deterministisch pfad-sortiert
{
  const base = [`${D}ADR-0074-unified.md`];
  const own = [`${D}ADR-0074-unified.md`, `${D}ADR-0074-bbb.md`, `${D}ADR-0074-aaa.md`];
  const plan = planAdrCollisionRenames(base, own);
  check("zwei Kollisionen → zwei Umbenennungen", plan.length === 2);
  check("deterministisch: aaa→0075 vor bbb→0076", plan[0]?.from.endsWith("aaa.md") && plan[0]?.num === "0075" && plan[1]?.num === "0076");
}

// eslint-disable-next-line no-console
console.log(results.join("\n"));
if (failed > 0) {
  // eslint-disable-next-line no-console
  console.error(`\n${failed} ADR-Test(s) fehlgeschlagen.`);
  process.exit(1);
}
