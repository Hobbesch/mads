/**
 * Modell-/Effort-Katalog fürs UI: welche Modelle wählbar sind und welche Effort-Stufen jedes
 * Modell unterstützt. Genutzt von der linken Navigation (globaler Default), dem New-Stream-Dialog
 * und dem Inspector (pro-Stream-Umschaltung).
 *
 * WAS SICH GEÄNDERT HAT: Die Liste steht nicht mehr HIER, sondern in `shared/models.ts` (eingebaute
 * Grundliste) und wird beim Start vom Sidecar gegen Anthropic und die gebündelte Claude-Code-CLI
 * geprüft (`sidecar/src/modelDiscovery.ts` → `model_catalog`). Diese Datei ist nur noch der
 * UI-nahe Zugriff darauf:
 *
 *   • `setRuntimeCatalog()` nimmt den geprüften Katalog entgegen (aus dem Store-Handler) und legt
 *     ihn zusätzlich im localStorage ab — so zeigt schon der ERSTE Frame nach dem App-Start die
 *     zuletzt bekannte Auswahl statt der ältesten eingebauten Liste.
 *   • Alle Lese-Helfer (`availableModels`, `modelLabel`, `effortLevelsFor`, `clampEffort`) gehen
 *     über diesen Spiegel und fallen ohne ihn auf die eingebaute Liste zurück.
 *
 * Effort-Fakten: `xhigh` gibt es erst ab den neueren Generationen (Fable 5/5.1, Opus 4.7+,
 * Sonnet 5+); Haiku kennt KEINEN Effort-Parameter; Sonnet 4.6 kann bis `high` (kein xhigh → kein
 * Ultracode). Wo die Models-API `capabilities` liefert, kommt die Ladder von dort — dann muss
 * niemand mehr von Hand nachtragen. „Ultracode" = xhigh-Effort + stehende Workflow-Orchestrierung
 * (SDK-Session-Flag `ultracode`).
 */
import type { EffortMode } from "../shared/protocol";
import { DEFAULT_MODEL as SHARED_DEFAULT_MODEL } from "../shared/protocol";
import {
  builtinCatalog,
  effortLevelsFor as effortLevelsIn,
  labelFor,
  findModel,
  type ModelCatalog,
  type ModelInfo,
} from "../shared/models";

export type { ModelInfo, ModelCatalog };

const KEY = "mads.modelCatalog";

/** Zuletzt bekannter, geprüfter Katalog. `undefined` = noch nie geprüft → eingebaute Liste. */
let runtime: ModelCatalog | undefined = loadCached();

function loadCached(): ModelCatalog | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return undefined;
    const obj = JSON.parse(raw) as ModelCatalog;
    return obj && Array.isArray(obj.models) && obj.models.length ? obj : undefined;
  } catch {
    return undefined;
  }
}

/** Geprüften Katalog übernehmen (Store-Handler für `model_catalog`). */
export function setRuntimeCatalog(catalog: ModelCatalog): void {
  if (!catalog?.models?.length) return; // leere Antwort nie übernehmen — sonst stünde das Dropdown leer
  runtime = catalog;
  try {
    localStorage.setItem(KEY, JSON.stringify(catalog));
  } catch {
    /* localStorage nicht verfügbar — gilt dann nur für diese Sitzung */
  }
}

/** Der aktuell gültige Katalog (geprüft oder eingebaut). */
export function currentCatalog(): ModelCatalog {
  return runtime ?? builtinCatalog();
}

/** Wählbare Modelle in Anzeige-Reihenfolge. */
export function availableModels(): ModelInfo[] {
  return currentCatalog().models;
}

export const EFFORT_LABEL: Record<EffortMode, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Xhigh",
  ultracode: "Ultracode",
};

export const EFFORT_HINT: Record<EffortMode, string> = {
  low: "Minimales Nachdenken, schnellste Antworten",
  medium: "Moderates Nachdenken",
  high: "Tiefes Reasoning (Standard)",
  xhigh: "Tiefer als High — für Coding/Agentik",
  ultracode: "xhigh + stehende Workflow-Orchestrierung (oberstes Ende)",
};

/** Standard-Effort für neue Streams. */
export const DEFAULT_EFFORT: EffortMode = "high";
/** Standard-Modell für neue Streams (Integrator-Default nach CLAUDE.md). Single Source in
 *  shared/protocol.ts — dieselbe Konstante, die der Sidecar zur undefined-Coercion nutzt. */
export const DEFAULT_MODEL = SHARED_DEFAULT_MODEL;

export function modelLabel(id: string | undefined): string {
  return labelFor(currentCatalog(), id);
}

/** Ist diese Model-ID im aktuellen Katalog wählbar? */
export function isKnownModel(id: string | undefined): boolean {
  return !!findModel(currentCatalog(), id);
}

/** Vom Modell unterstützte Effort-Stufen (leer = Modell kennt keinen Effort). */
export function effortLevelsFor(modelId: string | undefined): EffortMode[] {
  return effortLevelsIn(currentCatalog(), modelId);
}

/** Effort auf das gewählte Modell begrenzen: nicht unterstützte Stufe → höchste unterstützte
 *  (bzw. undefined, wenn das Modell gar keinen Effort kennt, z. B. Haiku). */
export function clampEffort(modelId: string | undefined, effort: EffortMode | undefined): EffortMode | undefined {
  const levels = effortLevelsFor(modelId);
  if (levels.length === 0) return undefined;
  if (effort && levels.includes(effort)) return effort;
  if (effort && DEFAULT_EFFORT && levels.includes(DEFAULT_EFFORT)) return DEFAULT_EFFORT;
  return levels[levels.length - 1];
}

/**
 * Modell-/Effort-Vorbelegung für einen NEUEN Stream. BEWUSST rollen-UNABHÄNGIG: was der Nutzer in
 * der linken Navigation unter „Modell & Effort · Default" stehen hat, gilt für jeden neu eröffneten
 * Stream — Integrator wie Sub-Agent. Vorher überschrieb eine rollenbewusste Sonderbehandlung
 * (Sub-Agent → opusplan/low, Anthropics Subagent-Empfehlung) diese Wahl still: der Rail-Regler
 * versprach „gilt für NEU eröffnete Streams", ein neuer Sub-Stream startete aber trotzdem auf „low".
 * Vorhersagbarkeit schlägt hier die automatische Kostenbremse — wer Sub-Streams günstig will, stellt
 * den Rail-Default auf opusplan/low (oder ändert Modell/Effort im Dialog-Picker direkt darunter).
 *
 * Effort wird nur noch auf das gewählte Modell begrenzt (clampEffort) — Haiku z. B. kennt gar keinen
 * Effort-Regler, Sonnet 4.6 kein xhigh.
 */
export function defaultEffortForModel(
  modelId: string | undefined,
  fallback: EffortMode | undefined,
): EffortMode | undefined {
  return clampEffort(modelId, fallback);
}
