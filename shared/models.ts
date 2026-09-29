/**
 * Modell-Katalog — SINGLE SOURCE für Frontend UND Sidecar.
 *
 * WARUM DIESE DATEI EXISTIERT: Der Katalog stand als handgepflegte Liste im Frontend
 * (`src/modelCatalog.ts`). Jede neue Anthropic-Generation musste also von Hand nachgetragen
 * werden — tat das niemand, blieb mads auf der alten Riege stehen (real passiert: Opus 5.5 und
 * Sonnet 5.5 fehlten in der Auswahl, obwohl längst verfügbar). Seitdem gilt:
 *
 *   eingebaute Liste (Fallback, kuratierte Texte)  +  LIVE-Befund beim Start  =  Auswahl
 *
 * Der Live-Befund kommt aus zwei unabhängigen Quellen (`sidecar/src/modelDiscovery.ts`):
 *
 *  1. **Anthropic Models-API** (`GET /v1/models`) — was Anthropic für DIESES Konto anbietet,
 *     inklusive Kontextfenster und unterstützter Effort-Stufen (`capabilities`).
 *  2. **Der lokal gebündelte Claude-Code-Katalog** — was die mitgelieferte CLI kennt. Das ist
 *     KEINE Formalie: die API weist ein zu neues Modell aktiv ab
 *     („Claude Code 2.1.278 does not support this model; version 2.1.280 or newer is required").
 *     Ein Modell, das nur Quelle 1 kennt, ist also anwählbar, aber tot — mads markiert es als
 *     „Update nötig", statt den Stream ins Leere laufen zu lassen.
 *
 * Alles hier ist REIN (keine I/O, kein Netz) — damit es beide Schichten importieren können und
 * `shared/models.test.ts` es ohne Netz prüfen kann.
 */
import type { EffortMode } from "./protocol.js";

/** Modell-Familien, die mads kennt. `unknown` = neue Familie, die nach mads' Release kam. */
export type ModelFamily = "fable" | "mythos" | "opus" | "sonnet" | "haiku" | "unknown";

/** Anzeige-Reihenfolge der Familien (fähigste/teuerste zuerst) — wie bisher im Dropdown. */
const FAMILY_ORDER: ModelFamily[] = ["fable", "mythos", "opus", "sonnet", "haiku", "unknown"];

/** Ein wählbarer Eintrag im Modell-Dropdown. */
export interface ModelInfo {
  /** Exakte Model-ID (`claude-opus-5-5`) oder Claude-Code-Alias (`opus`, `opusplan`). */
  id: string;
  label: string;
  /** Kurzbeschreibung fürs Tooltip. */
  hint: string;
  /** Effort-Stufen, die dieses Modell unterstützt (leer = kein Effort-Regler). */
  effort: EffortMode[];
  family: ModelFamily;
  /** Generationsrang für die Sortierung: `claude-opus-5-5` → 5.5, `claude-sonnet-4-6` → 4.6. */
  generation: number;
  /** `alias` = Claude-Code-Kurzname, der IMMER auf das neuste Modell seiner Familie zeigt. */
  kind: "model" | "alias";
  /** Kontextfenster in Tokens, falls die Models-API es gemeldet hat. */
  contextWindow?: number;
  /** Die lokal gebündelte Claude-Code-Version kennt dieses Modell. `false` ⇒ die API weist es ab. */
  cliKnown?: boolean;
  /** Anthropic listet es in der Models-API für das geprüfte Konto. */
  apiListed?: boolean;
}

/** Woher die Auswahl stammt, die gerade angezeigt wird — bewusst unterscheidbar, damit „ein
 *  Modell fehlt" nicht mit „mads konnte gar nicht nachfragen" verwechselt wird. */
export type CatalogStatus =
  /** Anthropic hat gerade geantwortet (Models-API) */
  | "live"
  /** kein Anthropic-Abgleich, aber der Katalog der gebündelten Claude-Code-Version gilt */
  | "local"
  /** nichts frisch erhoben — der letzte Befund aus `~/.mads/models.json` */
  | "cache"
  /** nur die eingebaute Liste (noch nie geprüft / kein Zugang) */
  | "builtin";

export interface ModelCatalog {
  models: ModelInfo[];
  status: CatalogStatus;
  /** ms-Zeitstempel der letzten ERFOLGREICHEN Prüfung. */
  checkedAt?: number;
  /** Warum es nicht „live" ist bzw. was geprüft wurde — wird im Einstellungs-Panel gezeigt. */
  note?: string;
  /** Version der gebündelten Claude-Code-CLI, gegen die geprüft wurde. */
  cliVersion?: string;
}

export const FULL_EFFORT: EffortMode[] = ["low", "medium", "high", "xhigh", "ultracode"];
/** Ohne xhigh gibt es auch kein Ultracode (Ultracode = xhigh + stehende Workflow-Orchestrierung). */
export const BASE_EFFORT: EffortMode[] = ["low", "medium", "high"];

/**
 * Eingebaute Liste — Fallback UND Textquelle. Sie muss nicht vollständig sein: was Anthropic
 * zusätzlich anbietet, kommt beim Start dazu. Sie liefert vor allem das, was keine API weiss:
 * Preis und Einsatzempfehlung im Tooltip.
 *
 * Preise pro Mio. Tokens (Ein-/Ausgabe), Stand 2026-09-29.
 */
export const BUILTIN_MODELS: ModelInfo[] = [
  entry("claude-fable-5-1", "Anthropics fähigstes Modell — anspruchsvollste, lang laufende Agenten-Arbeit (teuerste Stufe: $10/$50 pro Mio.)", FULL_EFFORT),
  entry("claude-fable-5", "Vorgänger-Fable (gleicher Preis wie Fable 5.1: $10/$50)", FULL_EFFORT),
  entry("claude-opus-5-5", "Aktueller Opus — stärkster fürs agentische Coding und Standard für den Integrator; günstiger als Opus 5 ($4/$20)", FULL_EFFORT),
  entry("claude-opus-5", "Vorgänger-Opus ($5/$25)", FULL_EFFORT),
  entry("claude-opus-4-8", "Ältere Opus-Generation ($5/$25)", FULL_EFFORT),
  entry("claude-sonnet-5-5", "Aktueller Sonnet — nahe Opus bei Coding/Agentik, deutlich günstiger ($2/$10); bestes Preis/Leistung für Sub-Agents", FULL_EFFORT),
  entry("claude-sonnet-5", "Vorgänger-Sonnet ($2/$10)", FULL_EFFORT),
  entry("claude-sonnet-4-6", "Ältere Sonnet-Generation ($3/$15) — kein xhigh/Ultracode", BASE_EFFORT),
  entry("claude-haiku-4-5", "Schnell & günstig ($1/$5) — kein Effort-Regler; für Explore/Hilfsarbeit", []),
];

/**
 * Claude-Code-Aliase. Sie lösen die CLI-SEITIG auf das jeweils NEUSTE Modell ihrer Familie auf
 * (`--model opus` → aktuell `claude-opus-5-5`) und sind damit die einzige Wahl, die auch dann
 * aktuell bleibt, wenn mads gar keine Prüfung durchführen konnte. Preis und Effort-Ladder erbt der
 * Alias vom aufgelösten Modell — deshalb steht hier bewusst keine Preisangabe.
 */
export const ALIAS_MODELS: ModelInfo[] = [
  alias("fable", "fable", "Fable · neustes", "Immer die neuste Fable-Generation — Claude Code löst den Alias beim Start des Streams selbst auf."),
  alias("opus", "opus", "Opus · neustes", "Immer die neuste Opus-Generation — bleibt aktuell, ohne dass mads den Katalog kennt."),
  alias("sonnet", "sonnet", "Sonnet · neustes", "Immer die neuste Sonnet-Generation — günstige Standardwahl für Sub-Streams."),
  alias("haiku", "haiku", "Haiku · neustes", "Immer die neuste Haiku-Generation — schnell und günstig für Hilfsarbeit."),
  {
    id: "opusplan",
    label: "Opus+Plan",
    hint:
      "Offizieller Claude-Code-Alias: Opus fürs Planen, automatischer Wechsel zu Sonnet für die Ausführung — " +
      "kostet wie Opus während des Planens, wie Sonnet während des Umsetzens. Der Opus-Anteil greift nur, " +
      "wenn die Session tatsächlich in Plan Mode läuft (Permission-Modus „Plan\" oder wenn der Agent selbst " +
      "planend vorgeht) — bei durchgehend direkter Ausführung entspricht es schlicht Sonnet.",
    effort: FULL_EFFORT,
    family: "opus",
    generation: 0,
    kind: "alias",
  },
];

/** Alle Alias-IDs (inkl. `opusplan`) — der Mismatch-Check im Sidecar darf sie nicht als Abweichung werten. */
export const ALIAS_IDS: readonly string[] = ALIAS_MODELS.map((m) => m.id);

function entry(id: string, hint: string, effort: EffortMode[]): ModelInfo {
  const parsed = parseModelId(id);
  return {
    id,
    label: parsed?.label ?? id,
    hint,
    effort,
    family: parsed?.family ?? "unknown",
    generation: parsed?.generation ?? 0,
    kind: "model",
  };
}

function alias(id: string, family: ModelFamily, label: string, hint: string): ModelInfo {
  return { id, label, hint, effort: FULL_EFFORT, family, generation: 0, kind: "alias" };
}

/**
 * Model-ID zerlegen: `claude-opus-5-5` → Opus, Generation 5.5. Erkennt Datums-Suffixe
 * (`claude-haiku-4-5-20251001`) und Regional-/Provider-Präfixe (`us.anthropic.claude-opus-4-8`),
 * damit dieselbe Generation nicht zweimal im Dropdown landet.
 *
 * BEWUSST regelbasiert statt Tabelle: eine künftige `claude-opus-6` soll ohne Code-Änderung ein
 * sauberes Label „Opus 6" und die volle Effort-Ladder bekommen.
 */
export function parseModelId(id: string): { family: ModelFamily; generation: number; label: string } | undefined {
  // Minor bewusst EINSTELLIG (`\d`, nicht `\d+`): Anthropic zählt einstellig (5.5, 4.8, 4.6), und
  // `major + minor/10` kippt sonst bei einem mehrstelligen Treffer — „claude-haiku-3-55" (ein
  // Artefakt aus dem CLI-Scan) landete so bei Generation 8.5 und galt als neuer als Haiku 4.5.
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d{1,2})(?:-(\d)(?!\d))?/i.exec(normalizeModelId(id));
  if (!m) return undefined;
  const family = m[1].toLowerCase() as ModelFamily;
  const major = Number(m[2]);
  const minor = m[3] ? Number(m[3]) : 0;
  const pretty = family.charAt(0).toUpperCase() + family.slice(1);
  return {
    family,
    generation: major + minor / 10,
    label: m[3] ? `${pretty} ${major}.${minor}` : `${pretty} ${major}`,
  };
}

/** Provider-Präfixe und Datums-Suffixe abstreifen (gleiche Regel wie der Mismatch-Check im Sidecar). */
export function normalizeModelId(id: string): string {
  return id.replace(/^(?:(?:us|eu|apac|anthropic)\.)+/, "").replace(/-\d{8}$/, "");
}

/**
 * Effort-Ladder aus den `capabilities` der Models-API ableiten. Die API kennt low/medium/high/
 * xhigh/max; mads kennt kein `max`, dafür `ultracode` (= xhigh + stehende Workflow-Orchestrierung)
 * — es wird genau dann angeboten, wenn das Modell xhigh kann. Fehlen die Angaben (ältere
 * API-Antwort), gibt die Funktion `undefined` zurück: dann gilt die eingebaute/abgeleitete Ladder.
 */
export function effortFromCapabilities(caps: unknown): EffortMode[] | undefined {
  if (!caps || typeof caps !== "object") return undefined;
  const eff = (caps as Record<string, unknown>).effort;
  if (!eff || typeof eff !== "object") return undefined;
  const e = eff as Record<string, unknown>;
  if (e.supported === false) return [];
  const can = (lvl: string): boolean => {
    const leaf = e[lvl];
    return !!leaf && typeof leaf === "object" && (leaf as Record<string, unknown>).supported === true;
  };
  const levels: EffortMode[] = [];
  for (const lvl of ["low", "medium", "high"] as const) if (can(lvl)) levels.push(lvl);
  if (can("xhigh")) levels.push("xhigh", "ultracode");
  return levels.length ? levels : [];
}

/** Ein roher Models-API-Eintrag, so weit mads ihn braucht. */
export interface ApiModel {
  id: string;
  display_name?: string;
  max_input_tokens?: number;
  capabilities?: unknown;
}

/**
 * Wie viele Generationen je Familie die Auswahl zeigt. 2 = aktuelle + eine Vorgänger-Generation:
 * genug, um bei einem Regressionsverdacht zurückzuschalten, ohne dass das Dropdown zur
 * Modell-Historie wird. Ältere bleiben nur sichtbar, wenn sie gerade GEWÄHLT sind (siehe `keep`).
 */
export const KEEP_GENERATIONS = 2;

/**
 * Den anzeigbaren Katalog aus den Rohbefunden bauen.
 *
 * @param apiModels  Antwort der Models-API (leer, wenn keine Prüfung möglich war).
 * @param cliIds     Model-IDs, die die gebündelte Claude-Code-CLI kennt (leer = unbekannt).
 * @param keep       IDs, die IMMER enthalten sein müssen (gerade gewählte Modelle) — sonst
 *                   verschwände die aktuelle Wahl des Nutzers aus seinem eigenen Dropdown.
 */
export function buildCatalog(apiModels: ApiModel[], cliIds: string[], keep: string[] = []): ModelInfo[] {
  const byId = new Map<string, ModelInfo>();
  const builtinById = new Map(BUILTIN_MODELS.map((m) => [m.id, m]));
  const cliSet = new Set(cliIds.map(normalizeModelId));

  // Später Hinzugefügtes gewinnt — die kuratierten Texte der eingebauten Liste gehen dabei NICHT
  // verloren: der API-Zweig unten setzt sie selbst wieder ein (`known?.hint ?? …`).
  const add = (info: ModelInfo): void => {
    const prev = byId.get(info.id);
    byId.set(info.id, prev ? { ...prev, ...info } : info);
  };

  for (const m of BUILTIN_MODELS) add({ ...m });

  for (const raw of apiModels) {
    const id = normalizeModelId(raw.id);
    const parsed = parseModelId(id);
    if (!parsed) continue; // kein Claude-Coding-Modell (oder eine Namensform, die mads nicht deuten kann)
    const known = builtinById.get(id);
    const effort = effortFromCapabilities(raw.capabilities) ?? known?.effort ?? FULL_EFFORT;
    add({
      id,
      // Anthropics eigener Anzeigename gewinnt („Claude Opus 5.5" → „Opus 5.5"): er bleibt auch
      // dann richtig, wenn eine Generation aus der ID-Form ausbricht.
      label: displayName(raw.display_name) ?? known?.label ?? parsed.label,
      hint: known?.hint ?? describeNew(parsed.label, raw.max_input_tokens),
      effort,
      family: parsed.family,
      generation: parsed.generation,
      kind: "model",
      contextWindow: raw.max_input_tokens,
      apiListed: true,
    });
  }

  // Der CLI-Katalog ist in erster Linie ein FILTER (`cliKnown`): er sagt, was die gebündelte
  // Claude-Code-Version überhaupt akzeptiert. Als QUELLE zählt er nur für echten Zuwachs —
  // ein Modell, das neuer ist als alles, was mads in dieser Familie schon kennt. So erscheint
  // eine künftige Generation allein durch ein SDK-Update, ohne mads-Release; gleichzeitig bleiben
  // zwei Sorten Müll draussen, die im Binär-Scan zwangsläufig mitkommen:
  //   • Altlasten (jede je unterstützte ID, bis hinunter zu Claude 3),
  //   • eingeschränkte Reihen wie Mythos (nur für Project Glasswing) — die stehen im CLI-Katalog,
  //     sind für ein normales Konto aber nicht buchbar. Listet die API sie, kommen sie über den
  //     Zweig oben ohnehin herein.
  const knownFamilies = new Set(BUILTIN_MODELS.map((m) => m.family));
  const highest = new Map<ModelFamily, number>();
  for (const m of byId.values()) highest.set(m.family, Math.max(highest.get(m.family) ?? 0, m.generation));
  for (const rawId of cliSet) {
    const parsed = parseModelId(rawId);
    if (!parsed || byId.has(rawId)) continue;
    if (!knownFamilies.has(parsed.family)) continue;
    if (parsed.generation <= (highest.get(parsed.family) ?? 0)) continue;
    add({
      id: rawId,
      label: parsed.label,
      hint: describeNew(parsed.label),
      effort: FULL_EFFORT,
      family: parsed.family,
      generation: parsed.generation,
      kind: "model",
    });
  }
  if (cliSet.size > 0) for (const info of byId.values()) info.cliKnown = cliSet.has(info.id);

  const models = [...byId.values()];
  // Je Familie die NEUSTEN `KEEP_GENERATIONS` *Generationen* behalten — nicht „alles ab
  // Nummer X". Der Unterschied ist nicht akademisch: zwischen Opus 4.8 und Opus 6 liegen keine
  // zwei Zähler, aber drei Generationen; eine Abstandsregel hätte die alte Riege stehen lassen.
  const generations = new Map<ModelFamily, number[]>();
  for (const m of models) {
    const list = generations.get(m.family) ?? [];
    if (!list.includes(m.generation)) list.push(m.generation);
    generations.set(m.family, list);
  }
  const current = new Map<ModelFamily, Set<number>>();
  for (const [fam, list] of generations) {
    current.set(fam, new Set([...list].sort((a, b) => b - a).slice(0, KEEP_GENERATIONS)));
  }

  const keepSet = new Set(keep.map(normalizeModelId));
  const shown = models.filter((m) => keepSet.has(m.id) || current.get(m.family)?.has(m.generation));
  return [...ALIAS_MODELS.map((a) => resolveAlias(a, shown)), ...sortModels(shown)];
}

/** Ein Alias erbt Effort-Ladder und CLI-Verfügbarkeit vom neusten Modell seiner Familie. */
function resolveAlias(a: ModelInfo, models: ModelInfo[]): ModelInfo {
  const target = models
    .filter((m) => m.kind === "model" && m.family === a.family)
    .sort((x, y) => y.generation - x.generation)[0];
  if (!target) return { ...a };
  return {
    ...a,
    // `opusplan` wechselt bewusst zwischen Opus und Sonnet — sein Tooltip bleibt, wie er ist.
    hint: a.id === "opusplan" ? a.hint : `${a.hint} Aktuell: ${target.label}.`,
    effort: a.id === "opusplan" ? a.effort : target.effort,
    cliKnown: target.cliKnown,
    apiListed: target.apiListed,
  };
}

/** Familien-Reihenfolge, innerhalb der Familie neuste Generation zuerst. */
export function sortModels(models: ModelInfo[]): ModelInfo[] {
  return [...models].sort((a, b) => {
    const fa = FAMILY_ORDER.indexOf(a.family);
    const fb = FAMILY_ORDER.indexOf(b.family);
    if (fa !== fb) return fa - fb;
    return b.generation - a.generation;
  });
}

/** „Claude Opus 5.5" → „Opus 5.5" (das „Claude" steht in mads schon überall drumherum). */
function displayName(raw: string | undefined): string | undefined {
  const t = raw?.trim().replace(/^Claude\s+/i, "");
  return t || undefined;
}

function describeNew(label: string, contextWindow?: number): string {
  const ctx = contextWindow ? ` · Kontextfenster ${Math.round(contextWindow / 1000)}k` : "";
  return `${label} — von Anthropic gemeldet, noch ohne kuratierte Empfehlung in mads${ctx}.`;
}

/** Der eingebaute Katalog als vollwertige `ModelCatalog` — gilt, solange nichts geprüft wurde. */
export function builtinCatalog(): ModelCatalog {
  return {
    models: [...ALIAS_MODELS.map((a) => resolveAlias(a, BUILTIN_MODELS)), ...sortModels(BUILTIN_MODELS)],
    status: "builtin",
    note: "Eingebaute Liste — noch nicht bei Anthropic geprüft.",
  };
}

/** Eintrag zu einer ID (auch Alias), oder `undefined`. */
export function findModel(catalog: ModelCatalog | undefined, id: string | undefined): ModelInfo | undefined {
  if (!id) return undefined;
  const list = catalog?.models?.length ? catalog.models : builtinCatalog().models;
  return list.find((m) => m.id === id) ?? list.find((m) => m.id === normalizeModelId(id));
}

/** Anzeigename einer Model-ID; unbekannte IDs werden abgeleitet statt roh gezeigt. */
export function labelFor(catalog: ModelCatalog | undefined, id: string | undefined): string {
  if (!id) return "?";
  return findModel(catalog, id)?.label ?? parseModelId(id)?.label ?? id;
}

/** Vom Modell unterstützte Effort-Stufen (leer = Modell kennt keinen Effort). */
export function effortLevelsFor(catalog: ModelCatalog | undefined, id: string | undefined): EffortMode[] {
  const hit = findModel(catalog, id);
  if (hit) return hit.effort;
  // Unbekanntes (z. B. per Hand gesetztes) Modell: lieber die volle Ladder anbieten als gar keine.
  return id ? FULL_EFFORT : [];
}
