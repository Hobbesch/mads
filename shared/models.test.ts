/**
 * Tests für den Modell-Katalog. Via `npm run test:models`.
 *
 * Kern der Regression, die diese Datei absichert: die Auswahl war eine handgepflegte Liste im
 * Frontend und blieb deshalb auf der Riege stehen, die beim letzten Edit aktuell war (Opus 5.5 und
 * Sonnet 5.5 fehlten, obwohl längst verfügbar). Der Katalog wird jetzt beim Start erhoben — diese
 * Tests prüfen die REGELN, nach denen aus den Rohbefunden die Auswahl wird:
 *
 *  1. Eine künftige Generation muss OHNE Code-Änderung sauber auftauchen (Label, Effort-Ladder).
 *  2. Alte Generationen dürfen verschwinden — aber NIE die gerade benutzte.
 *  3. Was die lokale Claude-Code-Version nicht kennt, muss als solches markiert sein: die API
 *     weist es ab, ein stiller Eintrag im Dropdown wäre eine Falle.
 */
import {
  BUILTIN_MODELS,
  buildCatalog,
  builtinCatalog,
  effortFromCapabilities,
  effortLevelsFor,
  labelFor,
  parseModelId,
  type ApiModel,
  type ModelCatalog,
} from "./models";

const results: string[] = [];
let failed = 0;
function check(name: string, cond: boolean): void {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
}

// ── ID-Zerlegung ──────────────────────────────────────────────────────────────
{
  check("Minor-Generation wird gelesen", parseModelId("claude-opus-5-5")?.generation === 5.5);
  check("Label wird abgeleitet", parseModelId("claude-opus-5-5")?.label === "Opus 5.5");
  check("Familie wird gelesen", parseModelId("claude-sonnet-4-6")?.family === "sonnet");
  check("Datums-Suffix zählt nicht als Minor", parseModelId("claude-haiku-4-5-20251001")?.label === "Haiku 4.5");
  check("Provider-Präfix stört nicht", parseModelId("us.anthropic.claude-opus-4-8")?.label === "Opus 4.8");
  check("Nicht-Modell ergibt undefined", parseModelId("gpt-4o") === undefined);
  // Die Kern-Eigenschaft: eine Generation, die es zur Release-Zeit von mads nicht gab.
  check("künftige Generation bekommt ein Label", parseModelId("claude-opus-7-2")?.label === "Opus 7.2");
}

// ── Effort-Ladder aus den capabilities der Models-API ──────────────────────────
{
  const caps = (extra: Record<string, unknown> = {}) => ({
    effort: {
      supported: true,
      low: { supported: true },
      medium: { supported: true },
      high: { supported: true },
      ...extra,
    },
  });
  check(
    "xhigh schaltet auch Ultracode frei",
    JSON.stringify(effortFromCapabilities(caps({ xhigh: { supported: true } }))) ===
      JSON.stringify(["low", "medium", "high", "xhigh", "ultracode"]),
  );
  check(
    "ohne xhigh gibt es kein Ultracode",
    JSON.stringify(effortFromCapabilities(caps())) === JSON.stringify(["low", "medium", "high"]),
  );
  check("Modell ohne Effort liefert leere Ladder", effortFromCapabilities({ effort: { supported: false } })?.length === 0);
  check("fehlende capabilities lassen die Ladder offen", effortFromCapabilities({}) === undefined);
}

// ── Katalogbau: neue Generation, ohne dass mads sie kennt ──────────────────────
{
  const api: ApiModel[] = [
    { id: "claude-opus-6", max_input_tokens: 2_000_000, capabilities: { effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true } } } },
    { id: "claude-opus-5-5" },
  ];
  const models = buildCatalog(api, ["claude-opus-6", "claude-opus-5-5"]);
  const six = models.find((m) => m.id === "claude-opus-6");
  check("unbekannte neue Generation ist wählbar", !!six);
  check("…mit abgeleitetem Label", six?.label === "Opus 6");
  check("…mit Effort-Ladder aus der API", six?.effort.includes("ultracode") === true);
  check("…und gemeldetem Kontextfenster", six?.contextWindow === 2_000_000);
  check("Alias erbt die Effort-Ladder der neusten Generation", models.find((m) => m.id === "opus")?.effort.includes("ultracode") === true);
  check("Alias-Tooltip nennt das aufgelöste Modell", models.find((m) => m.id === "opus")?.hint.includes("Opus 6") === true);
}

// ── Alte Generationen fallen raus — ausser der gerade benutzten ────────────────
{
  const api: ApiModel[] = ["claude-opus-6", "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"].map((id) => ({ id }));
  const models = buildCatalog(api, []);
  check("überholte Generation verschwindet", !models.some((m) => m.id === "claude-opus-4-8"));
  check("Vorgänger-Generation bleibt", models.some((m) => m.id === "claude-opus-5-5"));
  const kept = buildCatalog(api, [], ["claude-opus-4-8"]);
  check("…aber nie das gerade benutzte Modell", kept.some((m) => m.id === "claude-opus-4-8"));
}

// ── Was die lokale CLI nicht kennt, ist markiert (die API weist es ab) ─────────
{
  const models = buildCatalog([{ id: "claude-opus-6" }, { id: "claude-opus-5-5" }], ["claude-opus-5-5"]);
  check("zu neues Modell ist als nicht-unterstützt markiert", models.find((m) => m.id === "claude-opus-6")?.cliKnown === false);
  check("unterstütztes Modell ist als solches markiert", models.find((m) => m.id === "claude-opus-5-5")?.cliKnown === true);
  // Ohne CLI-Befund darf NICHTS markiert werden — „unbekannt" ist nicht „nicht unterstützt".
  const blind = buildCatalog([{ id: "claude-opus-6" }], []);
  check("ohne CLI-Scan bleibt die Markierung offen", blind.find((m) => m.id === "claude-opus-6")?.cliKnown === undefined);
}

// ── Der CLI-Katalog ist Filter, nicht Wühltisch ───────────────────────────────
{
  // So sieht ein echter Scan aus: alles, was die CLI je kannte — Altlasten, eingeschränkte
  // Reihen (Mythos nur für Project Glasswing) und ein Artefakt aus aneinanderstossenden Strings.
  const scanned = ["claude-opus-5-5", "claude-opus-6", "claude-mythos-5-1", "claude-haiku-3", "claude-sonnet-4-5"];
  const models = buildCatalog([{ id: "claude-opus-5-5" }], scanned);
  check("echter Zuwachs kommt allein aus dem CLI-Katalog dazu", models.some((m) => m.id === "claude-opus-6"));
  check("eingeschränkte Reihe bleibt draussen, solange die API sie nicht listet", !models.some((m) => m.family === "mythos"));
  check("Altlast bleibt draussen", !models.some((m) => m.id === "claude-haiku-3"));
  check("überholte Generation bleibt draussen", !models.some((m) => m.id === "claude-sonnet-4-5"));
  // Listet die API sie, ist es eine bewusste Freigabe des Kontos — dann gehört sie in die Auswahl.
  const glasswing = buildCatalog([{ id: "claude-mythos-5-1" }], scanned);
  check("…von der API gelistet, ist sie wählbar", glasswing.some((m) => m.id === "claude-mythos-5-1"));
}

// ── Anzeigename aus der API ───────────────────────────────────────────────────
{
  const models = buildCatalog([{ id: "claude-opus-6", display_name: "Claude Opus 6" }], []);
  check("Praefix Claude wird im Label nicht doppelt gefuehrt", models.find((m) => m.id === "claude-opus-6")?.label === "Opus 6");
}

// ── Kuratierte Texte überleben die Live-Prüfung ────────────────────────────────
{
  const builtinHint = BUILTIN_MODELS.find((m) => m.id === "claude-opus-5-5")?.hint ?? "";
  const models = buildCatalog([{ id: "claude-opus-5-5" }], []);
  check("Preis-/Empfehlungstext bleibt erhalten", models.find((m) => m.id === "claude-opus-5-5")?.hint === builtinHint);
  check("API-Bestätigung wird vermerkt", models.find((m) => m.id === "claude-opus-5-5")?.apiListed === true);
}

// ── Fallback ohne jede Prüfung ─────────────────────────────────────────────────
{
  const cat = builtinCatalog();
  check("eingebauter Katalog ist nicht leer", cat.models.length >= BUILTIN_MODELS.length);
  check("…enthält die aktuelle Riege", cat.models.some((m) => m.id === "claude-opus-5-5") && cat.models.some((m) => m.id === "claude-sonnet-5-5"));
  check("…und die Aliase", cat.models.some((m) => m.id === "opus" && m.kind === "alias"));
  check("Status ist ehrlich", cat.status === "builtin");
}

// ── Lese-Helfer für die UI ─────────────────────────────────────────────────────
{
  const cat: ModelCatalog = { models: buildCatalog([{ id: "claude-haiku-4-5", capabilities: { effort: { supported: false } } }], []), status: "live" };
  check("Haiku zeigt keinen Effort-Regler", effortLevelsFor(cat, "claude-haiku-4-5").length === 0);
  check("unbekannte ID bekommt trotzdem ein lesbares Label", labelFor(cat, "claude-opus-9-9") === "Opus 9.9");
  check("opusplan behält seine eigene Ladder — der Alias IST das Verhalten", effortLevelsFor(cat, "opusplan").length === 5);
}

console.log(results.join("\n"));
if (failed > 0) {
  console.error(`\n${failed} Test(s) fehlgeschlagen.`);
  process.exit(1);
}
console.log(`\n${results.length} Test(s) ok.`);
