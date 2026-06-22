/**
 * App-weite UI-Vorlieben (Activity-Rail) — im localStorage des WebViews.
 *
 * Wie `src/recent.ts` (und bewusst NICHT in den autoritativen State-Stores
 * Sidecar-Pool/`agents.json`/SQLite, docs/design/10-navigation-toolbar.md §3.1):
 * `activeView` (welches Primary-Panel aktiv ist) und `railCollapsed` (Rail nur-Icon
 * vs. Icon+Text) sind reine UI-Projektion, kein Agenten-State. Sie überleben
 * App-Updates, solange der Bundle-Identifier (com.hobbesch.mads) gleich bleibt.
 */

/** Welcher Rail-View aktiv ist. "streams" (Default) ⇒ KEIN Primary-Panel —
 *  nur Content (AgentGrid + Inspector); "files"/"settings" ⇒ Mittel-Panel.
 *  "changes" ist KEIN ViewId — die Change-Overview ist ein Overlay
 *  (`changeOverviewOn`, docs/design/09-change-overview.md / §2.3 von Doc 10). */
export type ViewId = "streams" | "files" | "settings";

export interface UiPrefs {
  activeView: ViewId;
  railCollapsed: boolean;
}

const KEY = "mads.uiPrefs";

const DEFAULTS: UiPrefs = { activeView: "streams", railCollapsed: false };

const VALID_VIEWS: ViewId[] = ["streams", "files", "settings"];

export function loadUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return { ...DEFAULTS };
    const activeView: ViewId = VALID_VIEWS.includes(obj.activeView) ? obj.activeView : DEFAULTS.activeView;
    const railCollapsed = typeof obj.railCollapsed === "boolean" ? obj.railCollapsed : DEFAULTS.railCollapsed;
    return { activeView, railCollapsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveUiPrefs(p: UiPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* localStorage nicht verfügbar — Präferenz bleibt nur in-memory für diese Session */
  }
}
