/**
 * App-weite UI-Vorlieben (Activity-Rail, Panel-Breite) — im localStorage des WebViews.
 *
 * Wie `src/recent.ts` (und bewusst NICHT in den autoritativen State-Stores
 * Sidecar-Pool/`agents.json`/SQLite, docs/design/10-navigation-toolbar.md §3.1):
 * reine UI-Projektion, kein Agenten-State. Überlebt App-Updates, solange der
 * Bundle-Identifier (com.hobbesch.mads) gleich bleibt.
 */

/** Welcher Rail-View aktiv ist. "streams" (Default) ⇒ KEIN Primary-Panel —
 *  nur Content (AgentGrid + Inspector); "files"/"settings" ⇒ Mittel-Panel.
 *  "changes" ist KEIN ViewId — die Change-Overview ist ein Overlay
 *  (`changeOverviewOn`, docs/design/09-change-overview.md / §2.3 von Doc 10). */
export type ViewId = "streams" | "files" | "settings";

import type { EffortMode } from "../shared/protocol";
import { DEFAULT_MODEL, DEFAULT_EFFORT, MODELS, clampEffort } from "./modelCatalog";

export interface UiPrefs {
  activeView: ViewId;
  railCollapsed: boolean;
  /** Breite des Mittel-Panels (Dateien/Einstellungen) in px — vom Nutzer ziehbar. */
  primaryPanelWidth: number;
  /** Zoom-Faktor der Markdown-Ansicht (1 = 100%), vom Nutzer einstellbar. */
  mdZoom: number;
  /** Breite der Ordner-Spalte im Datei-Explorer in px — vom Nutzer ziehbar. */
  treePaneWidth: number;
  /** Globaler Default fürs Modell neuer Streams (linke Navigation). */
  defaultModel: string;
  /** Globaler Default für den Effort neuer Streams. */
  defaultEffort: EffortMode;
}

const KEY = "mads.uiPrefs";

export const PANEL_MIN = 240;
export const PANEL_MAX = 1200;
export const MD_ZOOM_MIN = 0.5;
export const MD_ZOOM_MAX = 2;
export const TREE_MIN = 140;
export const TREE_MAX = 700;
const DEFAULTS: UiPrefs = {
  activeView: "streams",
  railCollapsed: false,
  primaryPanelWidth: 320,
  mdZoom: 1,
  treePaneWidth: 200,
  defaultModel: DEFAULT_MODEL,
  defaultEffort: DEFAULT_EFFORT,
};

const VALID_VIEWS: ViewId[] = ["streams", "files", "settings"];

export function clampPanelWidth(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n)
    ? Math.min(PANEL_MAX, Math.max(PANEL_MIN, n))
    : DEFAULTS.primaryPanelWidth;
}

export function clampTreePaneWidth(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n)
    ? Math.min(TREE_MAX, Math.max(TREE_MIN, n))
    : DEFAULTS.treePaneWidth;
}

export function clampMdZoom(n: unknown): number {
  // auf 5%-Schritte runden, damit z.B. 0.7999999 → 0.8.
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULTS.mdZoom;
  const r = Math.round(n * 20) / 20;
  return Math.min(MD_ZOOM_MAX, Math.max(MD_ZOOM_MIN, r));
}

export function loadUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return { ...DEFAULTS };
    const activeView: ViewId = VALID_VIEWS.includes(obj.activeView) ? obj.activeView : DEFAULTS.activeView;
    const railCollapsed = typeof obj.railCollapsed === "boolean" ? obj.railCollapsed : DEFAULTS.railCollapsed;
    // Nur bekannte Modelle akzeptieren; Effort auf das Modell begrenzen.
    const defaultModel = MODELS.some((m) => m.id === obj.defaultModel) ? (obj.defaultModel as string) : DEFAULTS.defaultModel;
    const defaultEffort = clampEffort(defaultModel, obj.defaultEffort as EffortMode) ?? DEFAULTS.defaultEffort;
    return {
      activeView,
      railCollapsed,
      primaryPanelWidth: clampPanelWidth(obj.primaryPanelWidth),
      mdZoom: clampMdZoom(obj.mdZoom),
      treePaneWidth: clampTreePaneWidth(obj.treePaneWidth),
      defaultModel,
      defaultEffort,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Merge-Persistenz: speichert nur die übergebenen Felder, behält den Rest. */
export function saveUiPrefs(patch: Partial<UiPrefs>): void {
  try {
    const next = { ...loadUiPrefs(), ...patch };
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* localStorage nicht verfügbar — Präferenz bleibt nur in-memory für diese Session */
  }
}
