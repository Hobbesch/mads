import { useStore } from "../store";
import { StreamContextSwitcher } from "./StreamContextSwitcher";
import { FileTree } from "./FileTree";
import { FileContent } from "./FileContent";

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
        <aside className="file-tree-pane">
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
