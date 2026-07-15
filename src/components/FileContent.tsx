import { useState, useEffect } from "react";
import { useStore } from "../store";
import { FileWarnings } from "./FileWarnings";
import { FilePreview } from "./FilePreview";
import { FileEditor } from "./FileEditor";
import { MarkdownEditor } from "./MarkdownEditor";
import { ConflictSheet } from "./ConflictSheet";

/**
 * Content-Bereich des Explorers (docs/design/07-file-explorer.md §2.1):
 * Mode-Switch preview/edit, Header mit Datei-Name + Dirty-Marker + Mode-Toggle,
 * Warn-Leisten und das Conflict-Sheet. I/O nur über Store-Actions.
 *
 * `.md`-Dateien werden vom dedizierten `MarkdownEditor` (doc 08) bedient — eigener
 * Preview/Edit/Split-Header mit der GitHub-Style-Pipeline. Alle anderen Typen über
 * den generischen Preview/Edit-Pfad aus 07.
 */
export function FileContent({ path }: { path: string }) {
  const openFile = useStore((s) => s.openFile);
  const buffer = useStore((s) => s.editorBuffers[path]);
  const enterEditMode = useStore((s) => s.enterEditMode);
  const discardEdit = useStore((s) => s.discardEdit);
  const saveFile = useStore((s) => s.saveFile);
  const fileConflict = useStore((s) => s.fileConflict);
  const [mode, setMode] = useState<"preview" | "edit">("preview");

  // Beim Dateiwechsel zurück auf Vorschau.
  useEffect(() => setMode("preview"), [path]);

  if (!openFile || openFile.path !== path) {
    return <div className="file-content empty">Datei wird geladen…</div>;
  }

  // `.md` → dedizierter Markdown-Editor (doc 08); der eigene Header ersetzt den 07-Header.
  if (openFile.kind === "markdown") {
    return (
      <section className="file-content">
        <FileWarnings path={path} />
        {fileConflict === path && <ConflictSheet path={path} />}
        <MarkdownEditor file={openFile} />
      </section>
    );
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

      {conflicted && <ConflictSheet path={path} />}

      <div className="fc-body">
        {mode === "edit" && editable ? <FileEditor file={openFile} /> : <FilePreview file={openFile} />}
      </div>
    </section>
  );
}
