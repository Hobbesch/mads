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

export interface UiPrefs {
  activeView: ViewId;
  railCollapsed: boolean;
  /** Breite des Mittel-Panels (Dateien/Einstellungen) in px — vom Nutzer ziehbar. */
  primaryPanelWidth: number;
  /** Zoom-Faktor der Markdown-Ansicht (1 = 100%), vom Nutzer einstellbar. */
  mdZoom: number;
}

const KEY = "mads.uiPrefs";

export const PANEL_MIN = 240;
export const PANEL_MAX = 1200;
export const MD_ZOOM_MIN = 0.5;
export const MD_ZOOM_MAX = 2;
const DEFAULTS: UiPrefs = { activeView: "streams", railCollapsed: false, primaryPanelWidth: 320, mdZoom: 1 };

const VALID_VIEWS: ViewId[] = ["streams", "files", "settings"];

export function clampPanelWidth(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n)
    ? Math.min(PANEL_MAX, Math.max(PANEL_MIN, n))
    : DEFAULTS.primaryPanelWidth;
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
    return {
      activeView,
      railCollapsed,
      primaryPanelWidth: clampPanelWidth(obj.primaryPanelWidth),
      mdZoom: clampMdZoom(obj.mdZoom),
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
