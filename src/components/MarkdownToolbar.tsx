import type { EditorView } from "@codemirror/view";
import {
  cmdBold,
  cmdItalic,
  cmdCode,
  cmdHeading,
  cmdBulletList,
  cmdOrderedList,
  cmdLink,
  cmdTable,
} from "../cmMarkdown";

/**
 * Formatierungs-Toolbar (docs/design/08-markdown-editor.md §1.4/§2.1) — ruft die
 * CodeMirror-Format-Commands auf der AKTIVEN `EditorView` auf. Reine UI: kein State,
 * keine I/O; deaktiviert, solange noch keine `EditorView` existiert. `aria-label`/`title`
 * an jedem Button (§8, analog Composer-Buttons in Inspector.tsx).
 */
const ITEMS: { key: string; label: string; title: string; run: (v: EditorView) => boolean }[] = [
  { key: "b", label: "B", title: "Fett (⌘B)", run: cmdBold },
  { key: "i", label: "I", title: "Kursiv (⌘I)", run: cmdItalic },
  { key: "h", label: "H", title: "Überschrift (⌘1)", run: cmdHeading(1) },
  { key: "ul", label: "•", title: "Aufzählung", run: cmdBulletList },
  { key: "ol", label: "1.", title: "Nummerierte Liste", run: cmdOrderedList },
  { key: "link", label: "🔗", title: "Link einfügen (⌘K)", run: cmdLink },
  { key: "table", label: "⊞", title: "Tabelle einfügen", run: cmdTable },
  { key: "code", label: "</>", title: "Code", run: cmdCode },
];

export function MarkdownToolbar({ view }: { view: EditorView | null }) {
  return (
    <div className="md-toolbar" role="toolbar" aria-label="Markdown-Formatierung">
      {ITEMS.map((it) => (
        <button
          key={it.key}
          type="button"
          className="md-tb-btn"
          title={it.title}
          aria-label={it.title}
          disabled={!view}
          // Fokus im Editor halten: mousedown-Default unterdrücken, dann ausführen.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => view && it.run(view)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
