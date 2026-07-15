import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { SearchQuery, SearchCursor, setSearchQuery, findNext, findPrevious } from "@codemirror/search";
import { useStore } from "../store";
import type { OpenFile, ViewMode } from "../store";
import { MarkdownPreview } from "./MarkdownPreview";
import { MarkdownSource } from "./MarkdownSource";
import { MarkdownSearchBar } from "./MarkdownSearchBar";
import { MarkdownToolbar } from "./MarkdownToolbar";
import { openMarkdownWindow } from "../detachWindow";
import { openExternalLink } from "../openExternal";
import { loadUiPrefs, saveUiPrefs, clampMdZoom } from "../uiPrefs";

/** Hat der Link ein URI-Schema (http:, https:, mailto:, …)? Dann extern; sonst interner Pfad. */
const isExternalHref = (href: string) => /^[a-z][a-z0-9+.-]*:/i.test(href);

// ── Suche (Feature: Text im Dokument finden) ──
// Preview-Treffer werden über die CSS Custom Highlight API markiert — KEIN DOM-/HTML-Eingriff,
// die Sanitize-/XSS-Invariante von mdPipeline bleibt unangetastet. Die API ist nicht in jeder
// TS-lib-/Engine-Version vorhanden → defensiv zugreifen (fällt sonst sauber auf No-Op zurück).
type HighlightRegistry = Map<string, unknown>;
type HighlightCtor = new (...ranges: Range[]) => unknown;
const highlightRegistry = (): HighlightRegistry | null =>
  (CSS as unknown as { highlights?: HighlightRegistry }).highlights ?? null;
const highlightCtor = (): HighlightCtor | null =>
  (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight ?? null;

/** 1-basierter Index des aktuell selektierten Treffers (CM hat keine Count-/Index-API). */
function cmMatchIndex(v: EditorView, query: string): number {
  if (!query) return 0;
  const selFrom = v.state.selection.main.from;
  let idx = 0;
  const cur = new SearchCursor(v.state.doc, query, 0, v.state.doc.length, (s) => s.toLowerCase());
  while (!cur.next().done) {
    idx++;
    if (cur.value.from >= selFrom) break;
  }
  return idx;
}

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
  { id: "wysiwyg", label: "WYSIWYG" },
  { id: "edit", label: "Bearbeiten" },
  { id: "split", label: "Split" },
];

export function MarkdownEditor({ file, detached = false }: { file: OpenFile; detached?: boolean }) {
  const path = file.path;
  const [fullscreen, setFullscreen] = useState(false);
  // Zoom der Markdown-Ansicht (persistiert; wirkt auf Vorschau UND Editor via CSS-`zoom`).
  const [zoom, setZoom] = useState(() => loadUiPrefs().mdZoom);
  const changeZoom = useCallback((next: number) => {
    const v = clampMdZoom(next);
    setZoom(v);
    saveUiPrefs({ mdZoom: v });
  }, []);
  const buffer = useStore((s) => s.editorBuffers[path]);
  const viewMode = useStore((s) => s.editorViewMode);
  const saving = useStore((s) => !!s.editorSaving[path]);
  const setEditorViewMode = useStore((s) => s.setEditorViewMode);
  const setEditorBuffer = useStore((s) => s.setEditorBuffer);
  const enterEditMode = useStore((s) => s.enterEditMode);
  const saveFile = useStore((s) => s.saveFile);
  const insertImageFromBlob = useStore((s) => s.insertImageFromBlob);
  const openWikiLink = useStore((s) => s.openWikiLink);
  const openMdReference = useStore((s) => s.openMdReference);

  const [view, setView] = useState<EditorView | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  // Suche: rein ephemerer UI-State pro Editor (wie view/fullscreen/zoom — NICHT im Store).
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQueryStr] = useState("");
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchCurrent, setSearchCurrent] = useState(0); // 1-basiert, 0 = kein Treffer
  const searchInputRef = useRef<HTMLInputElement>(null);
  const previewMatchesRef = useRef<Range[]>([]); // Preview-Treffer (für ↑/↓)
  const previewIdxRef = useRef(0);

  // Über Cap → schreibgeschützt: kein Edit/Split (§6/§7).
  const readOnly = file.truncated;
  const value = buffer ?? file.loadedText ?? "";
  const dirty = buffer !== undefined && buffer !== file.loadedText;

  // Beim Umschalten in einen Schreib-Modus (edit/split/wysiwyg) den Buffer materialisieren.
  useEffect(() => {
    if (viewMode !== "preview" && !readOnly && buffer === undefined) {
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
  // Normaler Link: externe per Policy, interne `.md`-Verweise relativ zur Datei in eigenem Fenster.
  const onLink = useCallback(
    (href: string) => (isExternalHref(href) ? openExternalLink(href) : void openMdReference(path, href)),
    [path, openMdReference],
  );
  // „Loslösen": eigenes OS-Fenster; klappt das nicht (Capability), Fallback = Vollbild im Fenster.
  const onDetach = useCallback(async () => {
    const ok = await openMarkdownWindow(path);
    if (!ok) setFullscreen(true);
  }, [path]);

  // ── Suche ──
  const openSearch = useCallback(() => {
    setSearchOpen(true);
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, []);
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQueryStr(""); // löscht CM-Dekorationen UND Preview-Highlights (über die Effects)
    view?.focus();
  }, [view]);
  // Preview-„aktueller Treffer" weiterschalten (nur Hervorheben + Hinscrollen, ohne Zähler —
  // den setzt der Aufrufer, da er je Modus aus CM oder Preview kommt).
  const advancePreviewCurrent = useCallback((dir: 1 | -1) => {
    const ranges = previewMatchesRef.current;
    const reg = highlightRegistry();
    const HL = highlightCtor();
    if (!ranges.length || !reg || !HL) return;
    const n = ranges.length;
    const idx = (previewIdxRef.current + dir + n) % n;
    previewIdxRef.current = idx;
    reg.set("md-find-current", new HL(ranges[idx]));
    ranges[idx].startContainer.parentElement?.scrollIntoView({ block: "nearest" });
  }, []);
  const onSearchNext = useCallback(() => {
    if (!searchQuery) return;
    if (viewMode === "preview") {
      advancePreviewCurrent(1);
      setSearchCurrent(previewIdxRef.current + 1);
    } else if (view) {
      findNext(view);
      setSearchCurrent(cmMatchIndex(view, searchQuery));
      if (viewMode === "split") advancePreviewCurrent(1); // Preview-Highlight mitziehen
    }
  }, [searchQuery, viewMode, view, advancePreviewCurrent]);
  const onSearchPrev = useCallback(() => {
    if (!searchQuery) return;
    if (viewMode === "preview") {
      advancePreviewCurrent(-1);
      setSearchCurrent(previewIdxRef.current + 1);
    } else if (view) {
      findPrevious(view);
      setSearchCurrent(cmMatchIndex(view, searchQuery));
      if (viewMode === "split") advancePreviewCurrent(-1);
    }
  }, [searchQuery, viewMode, view, advancePreviewCurrent]);

  // ⌘⏎: Edit ⇄ Preview umschalten (§8). Auf Container-Ebene, damit es auch außerhalb
  // der EditorView greift (Preview-Modus).
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // ⌘/Ctrl+F: Suchleiste öffnen — hier auf Section-Ebene, damit es auch im Preview-Modus
      // greift (dort existiert keine EditorView, die den Hotkey abfangen könnte).
      if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        openSearch();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (readOnly) return;
        setEditorViewMode(viewMode === "preview" ? "edit" : "preview");
      }
    },
    [viewMode, readOnly, setEditorViewMode, openSearch],
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

  // Treffer in CodeMirror (Edit/Split): Query setzen (malt `.cm-searchMatch`), zählen, ersten
  // Treffer anspringen. Im reinen Preview übernimmt das der DOM-Effect darunter.
  useEffect(() => {
    if (viewMode === "preview" || !view) return;
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: searchQuery, caseSensitive: false })) });
    if (!searchQuery) {
      setSearchTotal(0);
      setSearchCurrent(0);
      return;
    }
    let n = 0;
    const cur = new SearchCursor(view.state.doc, searchQuery, 0, view.state.doc.length, (s) => s.toLowerCase());
    while (!cur.next().done) n++;
    setSearchTotal(n);
    if (n) {
      findNext(view);
      setSearchCurrent(cmMatchIndex(view, searchQuery));
    } else {
      setSearchCurrent(0);
    }
  }, [searchQuery, view, viewMode]);

  // Treffer in der gerenderten Vorschau (Preview/Split) via CSS Custom Highlight API — KEIN
  // DOM-/HTML-Eingriff. In Split zählt CodeMirror oben; hier wird nur markiert. Im reinen
  // Preview liefert dieser Effect die Trefferzahl.
  useEffect(() => {
    const reg = highlightRegistry();
    // Modi ohne Preview-Pane (edit + wysiwyg): Preview-Highlights entfernen (sonst bleiben tote
    // Ranges auf inzwischen ausgehängten Textknoten in der Registry).
    if (viewMode === "edit" || viewMode === "wysiwyg") {
      reg?.delete("md-find");
      reg?.delete("md-find-current");
      previewMatchesRef.current = [];
      return;
    }
    const root = previewRef.current;
    const HL = highlightCtor();
    if (!root || !reg || !HL) {
      previewMatchesRef.current = [];
      return;
    }
    reg.delete("md-find");
    reg.delete("md-find-current");
    if (!searchQuery) {
      previewMatchesRef.current = [];
      if (viewMode === "preview") {
        setSearchTotal(0);
        setSearchCurrent(0);
      }
      return;
    }
    const needle = searchQuery.toLowerCase();
    const ranges: Range[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.nodeValue ?? "").toLowerCase();
      let i = text.indexOf(needle);
      while (i !== -1) {
        const r = document.createRange();
        r.setStart(node, i);
        r.setEnd(node, i + needle.length);
        ranges.push(r);
        i = text.indexOf(needle, i + needle.length);
      }
    }
    previewMatchesRef.current = ranges;
    previewIdxRef.current = 0;
    if (ranges.length) {
      reg.set("md-find", new HL(...ranges));
      reg.set("md-find-current", new HL(ranges[0]));
      ranges[0].startContainer.parentElement?.scrollIntoView({ block: "nearest" });
    }
    if (viewMode === "preview") {
      setSearchTotal(ranges.length);
      setSearchCurrent(ranges.length ? 1 : 0);
    }
  }, [searchQuery, previewSource, viewMode]);

  // Dateiwechsel: Suche schließen/leeren + Highlights entfernen (kein Lecken über Dateien).
  useEffect(() => {
    setSearchOpen(false);
    setSearchQueryStr("");
    return () => {
      const reg = highlightRegistry();
      reg?.delete("md-find");
      reg?.delete("md-find-current");
    };
  }, [path]);

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
          <div className="md-zoom" role="group" aria-label="Zoom">
            <button className="md-iconbtn" onClick={() => changeZoom(zoom - 0.1)} title="Verkleinern" aria-label="Verkleinern">
              −
            </button>
            <button
              className="md-iconbtn md-zoom-val"
              onClick={() => changeZoom(1)}
              title="Zoom auf 100% zurücksetzen"
              aria-label={`Zoom ${Math.round(zoom * 100)} Prozent, klicken für 100%`}
            >
              {Math.round(zoom * 100)}%
            </button>
            <button className="md-iconbtn" onClick={() => changeZoom(zoom + 0.1)} title="Vergrößern" aria-label="Vergrößern">
              +
            </button>
          </div>
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
    [path, dirty, viewMode, readOnly, saving, setEditorViewMode, onSave, detached, fullscreen, onDetach, zoom, changeZoom],
  );

  return (
    <section
      className={`md-editor${fullscreen ? " md-editor-fullscreen" : ""}`}
      style={{ "--md-zoom": zoom } as React.CSSProperties}
      onKeyDown={onKeyDown}
    >
      {header}
      {searchOpen && (
        <MarkdownSearchBar
          query={searchQuery}
          onQueryChange={setSearchQueryStr}
          current={searchCurrent}
          total={searchTotal}
          onNext={onSearchNext}
          onPrev={onSearchPrev}
          onClose={closeSearch}
          inputRef={searchInputRef}
        />
      )}
      {readOnly && (
        <div className="md-readonly-banner">
          Datei zu groß zum Editieren — schreibgeschützt.
        </div>
      )}
      {viewMode !== "preview" && !readOnly && <MarkdownToolbar view={view} />}

      <div className={`md-body mode-${viewMode}`}>
        {viewMode !== "preview" && !readOnly && (
          <div className="md-pane md-pane-source">
            <MarkdownSource
              value={value}
              onChange={onChange}
              onView={setView}
              onPasteImage={onPasteImage}
              onSave={onSave}
              onOpenSearch={openSearch}
              livePreview={viewMode === "wysiwyg"}
              onScrollRatio={viewMode === "split" ? onEditorScroll : undefined}
            />
          </div>
        )}
        {(viewMode === "preview" || viewMode === "split") && (
          <div className="md-pane md-pane-preview">
            <MarkdownPreview ref={previewRef} source={previewSource} onWikiLink={onWikiLink} onLink={onLink} />
          </div>
        )}
      </div>
    </section>
  );
}
