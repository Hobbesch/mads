import { useCallback, useRef, useState } from "react";
import { useStore } from "../store";
import { StreamContextSwitcher } from "./StreamContextSwitcher";
import { FileTree } from "./FileTree";
import { FileContent } from "./FileContent";
import { clampTreePaneWidth, loadUiPrefs, saveUiPrefs } from "../uiPrefs";

/**
 * Datei-Explorer (docs/design/07-file-explorer.md §2.1) — Mittel-Spalte (Primary-Panel)
 * bei activeView === "files". Orchestriert Stream-Kontext-Selector (PRIMÄR) + Baum +
 * Content. Reines UI: liest activeRoot/selectedFilePath; FS-Aufrufe nur über Store-Actions.
 *
 * Ersetzt NICHTS in .main — der Content (AgentGrid + Inspector) bleibt sichtbar
 * (LAYOUT-CONTRACT (a)/(f), doc 10).
 */
export function FileExplorer() {
  const project = useStore((s) => s.project);
  const activeRoot = useStore((s) => s.activeRoot);
  const selectedFilePath = useStore((s) => s.selectedFilePath);
  const treeFilter = useStore((s) => s.treeFilter);
  const setTreeFilter = useStore((s) => s.setTreeFilter);
  const fsError = useStore((s) => s.fsError);

  // Breite der Ordner-Spalte — vom Nutzer ziehbar (persistiert). Während des Drags
  // die Breite DIREKT am DOM setzen (kein Re-Render des Baums pro Pixel), erst beim
  // Loslassen State + Persistenz.
  const [treeWidth, setTreeWidth] = useState(() => loadUiPrefs().treePaneWidth);
  const asideRef = useRef<HTMLElement>(null);
  const latest = useRef(treeWidth);
  const onResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = asideRef.current?.offsetWidth ?? latest.current;
    const onMove = (ev: PointerEvent) => {
      const w = clampTreePaneWidth(startW + (ev.clientX - startX));
      latest.current = w;
      if (asideRef.current) asideRef.current.style.width = `${w}px`;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("col-resizing");
      setTreeWidth(latest.current);
      saveUiPrefs({ treePaneWidth: latest.current });
    };
    document.body.classList.add("col-resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  if (!project) {
    return (
      <section className="primary-panel file-explorer" aria-label="Dateien">
        <div className="primary-panel-head">Dateien</div>
        <div className="file-empty">Erst ein Projekt öffnen.</div>
      </section>
    );
  }

  return (
    <section className="primary-panel file-explorer" aria-label="Dateien">
      <StreamContextSwitcher />
      {fsError && <div className="file-error">⚠︎ {fsError}</div>}
      <div className="file-explorer-body">
        <aside className="file-tree-pane" ref={asideRef} style={{ width: treeWidth }}>
          <div className="file-filter">
            <input
              type="text"
              placeholder="Filter…"
              value={treeFilter}
              onChange={(e) => setTreeFilter(e.target.value)}
              aria-label="Dateibaum filtern"
            />
          </div>
          {activeRoot ? <FileTree root={activeRoot.path} /> : <div className="file-empty">Kein Kontext gewählt.</div>}
        </aside>
        <div
          className="tree-resizer"
          onPointerDown={onResizeStart}
          onDoubleClick={() => {
            setTreeWidth(200);
            saveUiPrefs({ treePaneWidth: 200 });
          }}
          role="separator"
          aria-orientation="vertical"
          title="Spaltenbreite ziehen (Doppelklick: zurücksetzen)"
        />
        <div className="file-detail">
          {selectedFilePath ? (
            <FileContent path={selectedFilePath} />
          ) : (
            <div className="file-empty">Datei auswählen, um sie anzuzeigen.</div>
          )}
        </div>
      </div>
    </section>
  );
}
