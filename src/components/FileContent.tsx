import { useState, useEffect } from "react";
import { useStore } from "../store";
import { FileWarnings } from "./FileWarnings";
import { FilePreview } from "./FilePreview";
import { FileEditor } from "./FileEditor";

/**
 * Content-Bereich des Explorers (docs/design/07-file-explorer.md §2.1):
 * Mode-Switch preview/edit, Header mit Datei-Name + Dirty-Marker + Mode-Toggle,
 * Warn-Leisten und das Conflict-Sheet. I/O nur über Store-Actions.
 */
export function FileContent({ path }: { path: string }) {
  const openFile = useStore((s) => s.openFile);
  const buffer = useStore((s) => s.editorBuffers[path]);
  const enterEditMode = useStore((s) => s.enterEditMode);
  const discardEdit = useStore((s) => s.discardEdit);
  const saveFile = useStore((s) => s.saveFile);
  const reloadFile = useStore((s) => s.reloadFile);
  const fileConflict = useStore((s) => s.fileConflict);
  const [mode, setMode] = useState<"preview" | "edit">("preview");

  // Beim Dateiwechsel zurück auf Vorschau.
  useEffect(() => setMode("preview"), [path]);

  if (!openFile || openFile.path !== path) {
    return <div className="file-content empty">Datei wird geladen…</div>;
  }

  const editable = openFile.coreKind === "text";
  const dirty = buffer !== undefined && buffer !== openFile.loadedText;
  const name = path.split("/").pop() ?? path;
  const conflicted = fileConflict === path;

  function toggleEdit() {
    if (mode === "edit") {
      if (dirty && !confirm("Ungespeicherte Änderungen verwerfen?")) return;
      discardEdit(path);
      setMode("preview");
    } else {
      enterEditMode(path);
      setMode("edit");
    }
  }

  return (
    <section className="file-content">
      <header className="file-content-head">
        <span className="fc-name" title={path}>
          {name}
          {dirty && <span className="fc-dirty" title="Ungespeicherte Änderungen"> ●</span>}
        </span>
        <div className="fc-actions">
          {mode === "edit" && (
            <button className="fc-save" disabled={!dirty} onClick={() => void saveFile(path)} title="Speichern (⌘S)">
              Speichern
            </button>
          )}
          {editable && (
            <button className="fc-mode" onClick={toggleEdit}>
              {mode === "edit" ? "Vorschau" : "Bearbeiten"}
            </button>
          )}
        </div>
      </header>

      <FileWarnings path={path} />

      {conflicted && (
        <div className="file-conflict-sheet" role="alertdialog" aria-label="Auf Disk geändert">
          <span>Diese Datei wurde auf der Festplatte geändert.</span>
          <div className="conflict-actions">
            <button onClick={() => void reloadFile(path)}>Disk laden</button>
            <button
              className="danger"
              onClick={() => {
                // Meine Version durchsetzen: openFile-Signatur auf Disk-Stand bringen, dann save.
                void useStore.getState().reloadFile(path).then(() => {
                  const cur = useStore.getState().openFile;
                  if (cur && cur.path === path && buffer !== undefined) {
                    useStore.getState().setEditorBuffer(path, buffer);
                    void useStore.getState().saveFile(path);
                  }
                });
              }}
            >
              Meine Version überschreiben
            </button>
          </div>
        </div>
      )}

      <div className="fc-body">
        {mode === "edit" && editable ? <FileEditor file={openFile} /> : <FilePreview file={openFile} />}
      </div>
    </section>
  );
}
