import { useStore } from "../store";

/**
 * Konflikt-Sheet (docs/design/08-markdown-editor.md §7 / 07 §7) — die Datei wurde auf
 * der Disk geändert, seit sie geladen wurde; der Core hat `WriteResult::Conflict`
 * geliefert (server-seitiger mtime/hash-Vergleich, KEIN silent clobber). Reine UI:
 * bietet Neu-laden ODER Überschreiben über Store-Actions. Geteilt von 07s generischem
 * Editor und 08s Markdown-Editor (eine Stelle, eine Policy).
 */
export function ConflictSheet({ path }: { path: string }) {
  const reloadFile = useStore((s) => s.reloadFile);

  function overwriteMine() {
    // Meine Version durchsetzen: openFile-Signatur auf Disk-Stand bringen (frische base-
    // mtime/hash), dann mit dem gemerkten Buffer erneut speichern.
    const buffer = useStore.getState().editorBuffers[path];
    void useStore
      .getState()
      .reloadFile(path)
      .then(() => {
        const cur = useStore.getState().openFile;
        if (cur && cur.path === path && buffer !== undefined) {
          useStore.getState().setEditorBuffer(path, buffer);
          void useStore.getState().saveFile(path);
        }
      });
  }

  return (
    <div className="file-conflict-sheet" role="alertdialog" aria-label="Auf Disk geändert">
      <span>Diese Datei wurde auf der Festplatte geändert.</span>
      <div className="conflict-actions">
        <button onClick={() => void reloadFile(path)}>Disk laden</button>
        <button className="danger" onClick={overwriteMine}>
          Meine Version überschreiben
        </button>
      </div>
    </div>
  );
}
