/**
 * Diff-Driver für den Region-/Kollisions-Scan.
 *
 * WARUM (Vorfall 2026-08-28, Boba): `git diff --unified=0` schreibt hinter das zweite `@@` den
 * "Funktions-Kontext" eines Hunks. Welche Zeile das ist, entscheidet ein sprachabhängiger
 * Diff-Driver (`xfuncname`). Ohne Driver greift Gits Default-Heuristik — "die letzte Zeile, die
 * nicht mit Whitespace beginnt". In C#/Java ist das die `namespace`- bzw. `package`-Zeile, weil
 * darunter alles eingerückt ist. Ergebnis: JEDER Hunk JEDER Datei bekam denselben Kontext,
 * `shared/collision.ts` machte daraus ein Pseudo-Symbol, und zwei Streams "kollidierten"
 * zwangsläufig — auch wenn ihre Änderungen hunderte Zeilen auseinanderlagen. Drei Streams wurden
 * so mit `ownership_trespass` blockiert, obwohl git exakt zwei triviale Konflikte hatte.
 *
 * Git bringt für die gängigen Sprachen fertige Driver mit; sie müssen den Dateien nur zugewiesen
 * werden. Das geschieht normalerweise über `.gitattributes` IM REPO — den Weg meiden wir bewusst:
 * mads würde sonst fremde Projekte verändern. Stattdessen eine eigene Attributes-Datei plus
 * `git -c core.attributesFile=<pfad>` (siehe `attributesArgs()`); das Projekt-Repo bleibt unberührt.
 *
 * An echten Boba-Daten verifiziert:
 *   ohne:  @@ -224 +225,15 @@ namespace BoBaAppBe.Services
 *   mit:   @@ -224 +225,15 @@ public ImportCSVResponse ImportCSV(string csvStr, …
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "./io.js";

/**
 * Zuweisung Dateiendung → eingebauter Git-Driver. Bewusst NUR Sprachen, für die git einen Driver
 * mitbringt (`git help attributes`, Abschnitt "Defining a custom hunk-header") — ein Name ohne
 * hinterlegten Driver wäre ein stiller No-op.
 */
const ATTRIBUTES = [
  "*.cs diff=csharp",
  "*.java diff=java",
  "*.py diff=python",
  "*.rb diff=ruby",
  "*.php diff=php",
  "*.rs diff=rust",
  "*.go diff=golang",
  "*.ts diff=typescript",
  "*.tsx diff=typescript",
  "*.js diff=javascript",
  "*.jsx diff=javascript",
  "*.kt diff=kotlin",
  "*.scala diff=scala",
  "*.swift diff=swift",
  "*.m diff=objc",
  "*.pl diff=perl",
  "*.pm diff=perl",
  "*.ex diff=elixir",
  "*.exs diff=elixir",
  "*.dts diff=dts",
  "*.tex diff=tex",
  "*.html diff=html",
  "*.css diff=css",
  "*.md diff=markdown",
  "",
].join("\n");

let cached: string | undefined;
let failed = false;

/**
 * Pfad zur Attributes-Datei; legt sie beim ersten Aufruf an (idempotent, prozessweit gecacht).
 * `undefined`, wenn sie sich nicht schreiben lässt — dann läuft der Scan ohne Driver weiter
 * (schlechtere Symbole, aber `CONTAINER_CONTEXT` in `shared/collision.ts` fängt den
 * `namespace`-Fall weiterhin ab; die Kollision fällt dann auf die mildere Stufe "file").
 */
export function attributesFile(): string | undefined {
  if (cached || failed) return cached;
  try {
    const dir = join(tmpdir(), "mads");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "diff-drivers.gitattributes");
    writeFileSync(path, ATTRIBUTES, "utf8"); // bei jedem Start neu schreiben → Liste bleibt aktuell
    cached = path;
    return cached;
  } catch (e) {
    failed = true; // einmal melden, nicht bei jedem Kollisions-Pass erneut
    log(`[gitAttributes] Attributes-Datei nicht schreibbar (${String(e)}) — Region-Scan ohne Diff-Driver`);
    return undefined;
  }
}

/**
 * Die `-c`-Argumente, die VOR das git-Unterkommando gehören. Leeres Array, wenn keine
 * Attributes-Datei verfügbar ist — der Aufruf bleibt dann gültig, nur ohne Driver.
 */
export function attributesArgs(): string[] {
  const path = attributesFile();
  return path ? ["-c", `core.attributesFile=${path}`] : [];
}
