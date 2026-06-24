import { Suspense, lazy, useCallback, useRef, useState } from "react";
import { useStore } from "../store";
import { SettingsPanel } from "./SettingsPanel";
import { clampPanelWidth, loadUiPrefs, saveUiPrefs } from "../uiPrefs";

// Lazy-Mount (doc 10 §6): das schwere Dateien-Panel (CodeMirror + Baum) wird erst beim
// ersten Aktivieren von activeView==="files" geladen — der Default-Streams-View bleibt schlank.
const FileExplorer = lazy(() => import("./FileExplorer").then((m) => ({ default: m.FileExplorer })));

/**
 * Switch über `activeView` → rendert das aktivitäts-spezifische Primary-Panel
 * (docs/design/10-navigation-toolbar.md §2.2 / LAYOUT-CONTRACT (f)).
 *
 * Bei `activeView === "streams"` (Default) rendert es `null` — KEIN Mittel-Panel.
 * Sonst wird das Panel in einen breiten-ZIEHBAREN Wrapper gehüllt (persistiert), damit
 * z. B. die Markdown-Vorschau lesbar verbreitert werden kann.
 */
export function PrimaryPanel() {
  const view = useStore((s) => s.activeView);
  const hasProject = useStore((s) => !!s.project);
  const [width, setWidth] = useState(() => loadUiPrefs().primaryPanelWidth);
  const wrapRef = useRef<HTMLDivElement>(null);
  const latest = useRef(width);

  // Ziehen am rechten Rand: während des Drags die Breite DIREKT am DOM setzen (kein
  // Re-Render des schweren Panels pro Pixel); erst beim Loslassen State + Persistenz.
  const onResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = wrapRef.current?.offsetWidth ?? latest.current;
    const onMove = (ev: PointerEvent) => {
      const w = clampPanelWidth(startW + (ev.clientX - startX));
      latest.current = w;
      if (wrapRef.current) wrapRef.current.style.width = `${w}px`;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("col-resizing");
      setWidth(latest.current);
      saveUiPrefs({ primaryPanelWidth: latest.current });
    };
    document.body.classList.add("col-resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  let panel: React.ReactNode;
  if (view === "settings") {
    panel = <SettingsPanel />;
  } else if (view === "files") {
    if (!hasProject) return null; // §7: "files" ohne Projekt zeigt kein Panel
    panel = (
      <Suspense fallback={<div className="primary-panel file-explorer-loading">Dateien lädt…</div>}>
        <FileExplorer />
      </Suspense>
    );
  } else {
    return null; // streams: KEIN Panel — Rail steht direkt neben .main
  }

  return (
    <div className="primary-panel-wrap" ref={wrapRef} style={{ width }}>
      {panel}
      <div
        className="panel-resizer"
        onPointerDown={onResizeStart}
        onDoubleClick={() => {
          setWidth(320);
          saveUiPrefs({ primaryPanelWidth: 320 });
        }}
        role="separator"
        aria-orientation="vertical"
        title="Breite ziehen (Doppelklick: zurücksetzen)"
      />
    </div>
  );
}
