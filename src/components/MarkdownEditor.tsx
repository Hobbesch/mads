import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { useStore } from "../store";
import type { OpenFile, ViewMode } from "../store";
import { MarkdownPreview } from "./MarkdownPreview";
import { MarkdownSource } from "./MarkdownSource";
import { MarkdownToolbar } from "./MarkdownToolbar";
import { openMarkdownWindow } from "../detachWindow";

/**
 * Markdown-Editor-Orchestrator (docs/design/08-markdown-editor.md §2.1) — der `.md`-
 * Spezialfall des Datei-Editors aus 07. Header mit Segmented Control (Preview/Edit/Split),
 * Dirty-Punkt und Save; wählt zwischen `MarkdownPreview`/`MarkdownSource`/Split. Hält
 * KEINEN eigenen Text-State — Buffer/View-Modus/Save liegen im Store (§3).
 *
 * Reine UI: jeder FS-Zugriff über Store-Actions (→ Core-Commands). Speichern ≠ Commit (§0).
 */
const MODES: { id: ViewMode; label: string }[] = [
  { id: "preview", label: "Vorschau" },
  { id: "edit", label: "Bearbeiten" },
  { id: "split", label: "Split" },
];

export function MarkdownEditor({ file, detached = false }: { file: OpenFile; detached?: boolean }) {
  const path = file.path;
  const [fullscreen, setFullscreen] = useState(false);
  const buffer = useStore((s) => s.editorBuffers[path]);
  const viewMode = useStore((s) => s.editorViewMode);
  const saving = useStore((s) => !!s.editorSaving[path]);
  const setEditorViewMode = useStore((s) => s.setEditorViewMode);
  const setEditorBuffer = useStore((s) => s.setEditorBuffer);
  const enterEditMode = useStore((s) => s.enterEditMode);
  const saveFile = useStore((s) => s.saveFile);
  const insertImageFromBlob = useStore((s) => s.insertImageFromBlob);
  const openWikiLink = useStore((s) => s.openWikiLink);

  const [view, setView] = useState<EditorView | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  // Über Cap → schreibgeschützt: kein Edit/Split (§6/§7).
  const readOnly = file.truncated;
  const value = buffer ?? file.loadedText ?? "";
  const dirty = buffer !== undefined && buffer !== file.loadedText;

  // Beim Umschalten in einen Schreib-Modus den Buffer materialisieren (wie 07 enterEditMode).
  useEffect(() => {
    if ((viewMode === "edit" || viewMode === "split") && !readOnly && buffer === undefined) {
      enterEditMode(path);
    }
  }, [viewMode, readOnly, buffer, path, enterEditMode]);

  // Cap erzwingt Preview (Edit/Split deaktiviert).
  useEffect(() => {
    if (readOnly && viewMode !== "preview") setEditorViewMode("preview");
  }, [readOnly, viewMode, setEditorViewMode]);

  const onChange = useCallback((v: string) => setEditorBuffer(path, v), [path, setEditorBuffer]);
  const onSave = useCallback(() => void saveFile(path), [path, saveFile]);
  const onPasteImage = useCallback(
    (blob: Blob, cursor: number) => insertImageFromBlob(path, blob, cursor),
    [path, insertImageFromBlob],
  );
  const onWikiLink = useCallback((name: string) => void openWikiLink(path, name), [path, openWikiLink]);
  // „Loslösen": eigenes OS-Fenster; klappt das nicht (Capability), Fallback = Vollbild im Fenster.
  const onDetach = useCallback(async () => {
    const ok = await openMarkdownWindow(path);
    if (!ok) setFullscreen(true);
  }, [path]);

  // ⌘⏎: Edit ⇄ Preview umschalten (§8). Auf Container-Ebene, damit es auch außerhalb
  // der EditorView greift (Preview-Modus).
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (readOnly) return;
        setEditorViewMode(viewMode === "preview" ? "edit" : "preview");
      }
    },
    [viewMode, readOnly, setEditorViewMode],
  );

  // Split-Preview debounced (§6): nicht pro Keystroke den AST neu bauen.
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (viewMode !== "split") {
      setDebounced(value);
      return;
    }
    const t = setTimeout(() => setDebounced(value), 120);
    return () => clearTimeout(t);
  }, [value, viewMode]);
  const previewSource = viewMode === "split" ? debounced : value;

  // Scroll-Sync (§6): Editor-Scroll-Verhältnis → Preview-Container (nur Split).
  const onEditorScroll = useCallback((ratio: number) => {
    const el = previewRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    el.scrollTop = ratio * max;
  }, []);

  const header = useMemo(
    () => (
      <header className="md-editor-head">
        <div className="md-title" title={path}>
          <span className="md-name">{path.split("/").pop() ?? path}</span>
          {dirty && (
            <span className="md-dirty" title="Ungespeicherte Änderungen" aria-label="ungespeichert">
              {" "}
              ●
            </span>
          )}
        </div>
        <div className="md-head-actions">
          <div className="md-segmented" role="tablist" aria-label="Ansicht">
            {MODES.map((m) => (
              <button
                key={m.id}
                role="tab"
                aria-selected={viewMode === m.id}
                className={`md-seg${viewMode === m.id ? " active" : ""}`}
                disabled={readOnly && m.id !== "preview"}
                onClick={() => setEditorViewMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
          <button
            className="md-save"
            disabled={!dirty || saving}
            onClick={onSave}
            title="Speichern (⌘S)"
          >
            {saving ? "Speichert…" : "Speichern"}
          </button>
          {!detached && (
            <>
              <button
                className="md-iconbtn"
                onClick={() => setFullscreen((f) => !f)}
                title={fullscreen ? "Vollbild verlassen" : "Vollbild (ganzes Fenster nutzen)"}
                aria-label="Vollbild umschalten"
              >
                {fullscreen ? "⤡" : "⤢"}
              </button>
              <button
                className="md-iconbtn"
                onClick={() => void onDetach()}
                title="In eigenem Fenster öffnen (vom Hauptfenster loslösen)"
                aria-label="In eigenem Fenster öffnen"
              >
                ↗
              </button>
            </>
          )}
        </div>
      </header>
    ),
    [path, dirty, viewMode, readOnly, saving, setEditorViewMode, onSave, detached, fullscreen, onDetach],
  );

  return (
    <section className={`md-editor${fullscreen ? " md-editor-fullscreen" : ""}`} onKeyDown={onKeyDown}>
      {header}
      {readOnly && (
        <div className="md-readonly-banner">
          Datei zu groß zum Editieren — schreibgeschützt.
        </div>
      )}
      {(viewMode === "edit" || viewMode === "split") && !readOnly && (
        <MarkdownToolbar view={view} />
      )}

      <div className={`md-body mode-${viewMode}`}>
        {viewMode !== "preview" && !readOnly && (
          <div className="md-pane md-pane-source">
            <MarkdownSource
              value={value}
              onChange={onChange}
              onView={setView}
              onPasteImage={onPasteImage}
              onSave={onSave}
              onScrollRatio={viewMode === "split" ? onEditorScroll : undefined}
            />
          </div>
        )}
        {viewMode !== "edit" && (
          <div className="md-pane md-pane-preview">
            <MarkdownPreview ref={previewRef} source={previewSource} onWikiLink={onWikiLink} />
          </div>
        )}
      </div>
    </section>
  );
}
