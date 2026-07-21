/**
 * Zentrale Modell-/Effort-Katalog (Single Source of Truth fürs UI): welche Modelle wählbar sind
 * und welche Effort-Stufen jedes Modell unterstützt. Genutzt von der linken Navigation (globaler
 * Default), dem New-Stream-Dialog und dem Inspector (pro-Stream-Umschaltung).
 *
 * Effort-Fakten (Stand claude-api-Skill): `xhigh` gibt es erst ab Fable 5 / Opus 4.7+ / Sonnet 5;
 * Haiku 4.5 kennt KEINEN Effort-Parameter; Sonnet 4.6 kann bis `high` (kein xhigh → kein Ultracode).
 * „Ultracode" = xhigh-Effort + stehende Workflow-Orchestrierung (SDK-Session-Flag `ultracode`).
 */
import type { EffortMode } from "../shared/protocol";
import { DEFAULT_MODEL as SHARED_DEFAULT_MODEL } from "../shared/protocol";

export interface ModelOption {
  id: string;
  label: string;
  /** Kurzbeschreibung fürs Tooltip. */
  hint: string;
  /** Effort-Stufen, die dieses Modell unterstützt (leer = kein Effort-Regler). */
  effort: EffortMode[];
}

const FULL: EffortMode[] = ["low", "medium", "high", "xhigh", "ultracode"];

// Aktuelle Modell-Riege. Reihenfolge = Anzeige im Dropdown.
export const MODELS: ModelOption[] = [
  { id: "claude-fable-5", label: "Fable 5", hint: "Anthropics fähigstes Modell — anspruchsvollste, lang laufende Agenten-Arbeit", effort: FULL },
  { id: "claude-opus-4-8", label: "Opus 4.8", hint: "Sehr fähig, autonom — Standard für den Integrator", effort: FULL },
  { id: "claude-sonnet-5", label: "Sonnet 5", hint: "Nahe Opus bei Coding/Agentik, günstiger", effort: FULL },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", hint: "Vorgänger-Sonnet (kein xhigh/Ultracode)", effort: ["low", "medium", "high"] },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", hint: "Schnell & günstig — kein Effort-Regler", effort: [] },
];

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
  if (!id) return "?";
  return MODELS.find((m) => m.id === id)?.label ?? id;
}

/** Vom Modell unterstützte Effort-Stufen (leer = Modell kennt keinen Effort). */
export function effortLevelsFor(modelId: string | undefined): EffortMode[] {
  return MODELS.find((m) => m.id === modelId)?.effort ?? [];
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
