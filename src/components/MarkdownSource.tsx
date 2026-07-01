import { useCallback, useMemo, useRef } from "react";
import CodeMirror from "@uiw/react-codemirror";
import type { EditorView } from "@codemirror/view";
import { markdownExtensions } from "../cmMarkdown";

/**
 * Markdown-Quell-Editor (docs/design/08-markdown-editor.md §2.1) — dünner React-Wrapper
 * um eine CodeMirror-6-`EditorView` mit `@codemirror/lang-markdown` (DERSELBE Unterbau
 * wie der Code-Editor in 07). Hält keinen eigenen Text-State (Buffer im Store, §3).
 *
 * Reicht die `EditorView` per `onView` nach oben (Toolbar-Commands), behandelt Bild-Paste
 * (§1.2 — schreibt über die Store-Action ins Repo + fügt den relativen Link ein) und
 * emittiert das Scroll-Verhältnis für den Split-Scroll-Sync (§6).
 */
export interface MarkdownSourceProps {
  value: string;
  onChange(v: string): void;
  /** Erhält die `EditorView` bei Erstellung (für Toolbar/Keymap). */
  onView(view: EditorView | null): void;
  /** Bild aus dem Clipboard an `cursor` einfügen → neue Cursor-Position. */
  onPasteImage(blob: Blob, cursor: number): Promise<number>;
  /** Save-Intent (⌘S) — der Wrapper kennt den Store nicht, der Aufrufer speichert. */
  onSave(): void;
  /** ⌘/Ctrl+F: mads-Suchleiste im Header öffnen (UI-Sache, nicht CodeMirrors eigenes Panel). */
  onOpenSearch?(): void;
  /** WYSIWYG-Modus: Formatierung inline rendern (Marker verbergen). */
  livePreview?: boolean;
  /** Scroll-Verhältnis 0..1 für den Split-Sync (§6). */
  onScrollRatio?(ratio: number): void;
}

export function MarkdownSource({
  value,
  onChange,
  onView,
  onPasteImage,
  onSave,
  onOpenSearch,
  livePreview = false,
  onScrollRatio,
}: MarkdownSourceProps) {
  const viewRef = useRef<EditorView | null>(null);
  const rafRef = useRef<number | null>(null);

  const onCreateEditor = useCallback(
    (view: EditorView) => {
      viewRef.current = view;
      onView(view);
    },
    [onView],
  );

  // Bild-Paste (§1.2): Clipboard-Bild abfangen, ins Repo schreiben, rel. Link an Cursor.
  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const blob = item.getAsFile();
          if (!blob) continue;
          e.preventDefault();
          const view = viewRef.current;
          const cursor = view ? view.state.selection.main.from : value.length;
          void onPasteImage(blob, cursor).then((next) => {
            // Cursor hinter den eingefügten Link setzen (best-effort).
            const v = viewRef.current;
            if (v && next >= 0 && next <= v.state.doc.length) {
              v.dispatch({ selection: { anchor: next } });
            }
          });
          return;
        }
      }
    },
    [onPasteImage, value.length],
  );

  // Extensions memoisieren (sonst baut CodeMirror sie pro Render neu); Live-Preview je Modus.
  const extensions = useMemo(() => markdownExtensions(onOpenSearch, livePreview), [onOpenSearch, livePreview]);

  // ⌘S (Save) und ⌘F (Suchleiste) abfangen, BEVOR CodeMirror sie konsumiert — beides
  // ist UI/Store-Sache, nicht CodeMirrors eigener Handler.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        e.stopPropagation();
        onSave();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        e.stopPropagation();
        onOpenSearch?.();
      }
    },
    [onSave, onOpenSearch],
  );

  // Scroll-Sync-Emitter (§6): über requestAnimationFrame coalesct.
  const onScroll = useCallback(
    (e: React.UIEvent) => {
      if (!onScrollRatio) return;
      const el = e.currentTarget as HTMLElement;
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const max = el.scrollHeight - el.clientHeight;
        onScrollRatio(max > 0 ? el.scrollTop / max : 0);
      });
    },
    [onScrollRatio],
  );

  return (
    <div className="md-source" onPaste={onPaste} onKeyDown={onKeyDown} onScroll={onScroll}>
      <CodeMirror
        value={value}
        extensions={extensions}
        onChange={onChange}
        onCreateEditor={onCreateEditor}
        // searchKeymap: false → CodeMirrors eigenes ⌘F-Panel abschalten; die mads-Suchleiste
        // (via searchOpenKeymap + Wrapper-onKeyDown) ist die einzige Such-UI.
        basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: true, searchKeymap: false }}
      />
    </div>
  );
}
