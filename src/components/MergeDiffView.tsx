import { useEffect, useRef } from "react";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { unifiedMergeView, goToNextChunk } from "@codemirror/merge";

/**
 * MergeDiffView (docs/design/09-change-overview.md §2.3) — der EINZIGE Ort, der CodeMirror
 * anfasst. Dünner React-Wrapper um GENAU EINE `@codemirror/merge`-`unifiedMergeView` für
 * genau ein old/new-Paar. Additions grün, Löschungen rot + Durchstreichung (out of the box:
 * `.cm-changedLine` / `.cm-deletedChunk`). Auto-Scroll zum (neuesten) Chunk via `goToNextChunk`
 * — `prefers-reduced-motion`-fest (CodeMirror scrollt ohne Smooth-Behavior).
 *
 * Read-only Anzeige (CLAUDE.md: src/ ist reines UI) — kein Editieren, kein FS-Zugriff.
 */
export function MergeDiffView({ oldDoc, newDoc }: { oldDoc: string; newDoc: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      doc: newDoc,
      extensions: [
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
        EditorView.lineWrapping,
        unifiedMergeView({ original: oldDoc, mergeControls: false }),
      ],
      parent: host.current,
    });
    view.current = v;
    goToNextChunk(v); // initial an den ersten/neuesten geänderten Chunk scrollen
    return () => {
      v.destroy();
      view.current = null;
    };
    // Bei Doc-Wechsel die Instanz neu aufbauen: unifiedMergeView's `original` ist eine
    // Konfig-Facet — ein sauberer Remount ist robuster als ein in-place reconfigure.
  }, [oldDoc, newDoc]);

  return <div ref={host} className="diff-pane-cm" />;
}
