/**
 * CodeMirror-6-Unterbau für den Markdown-Quell-Editor (docs/design/08-markdown-editor.md §2.1).
 *
 * SINGLE SOURCE der Markdown-Extensions + der geteilten Theme-Factory (an die
 * `:root`-CSS-Variablen gebunden, §1.4) + der Formatierungs-Commands, die die Toolbar
 * (§2.1 `MarkdownToolbar`) UND die Keymap (§8) auf der aktiven `EditorView` aufrufen.
 *
 * Reine UI: KEIN FS, KEIN Prozess. Speichern/Bild-Paste laufen über Store-Actions
 * (→ Core-Commands), nicht von hier.
 */
import { EditorView, keymap } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { search } from "@codemirror/search";
import { mdLivePreview } from "./cmLivePreview";

/**
 * Theme an die `:root`-Variablen gebunden (folgt OS-Light/Dark automatisch, §1.4) —
 * geteilt mit dem generischen Code-Editor (07). Transparent/`inherit`, damit die
 * `.fc-body`-Fläche durchscheint und kein zweiter Farb-Kontext entsteht.
 */
export const cmTheme: Extension = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    color: "var(--text)",
    height: "100%",
    fontSize: "13px",
  },
  ".cm-content": {
    fontFamily: "var(--mono)",
    caretColor: "var(--accent)",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--text-faint)",
    border: "none",
  },
  ".cm-activeLine": { backgroundColor: "var(--accent-weak)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
  // Such-Treffer (Feature: Suchleiste) — `search()` malt diese Klassen für die aktive Query.
  ".cm-searchMatch": { backgroundColor: "var(--accent-weak)", borderRadius: "2px" },
  ".cm-searchMatch-selected": { backgroundColor: "var(--accent)", color: "#fff" },
  // Live-Preview (WYSIWYG-Modus) — nur aktiv, wenn `mdLivePreview()` die Klassen setzt.
  ".cm-md-strong": { fontWeight: "700" },
  ".cm-md-em": { fontStyle: "italic" },
  ".cm-md-strike": { textDecoration: "line-through", opacity: "0.7" },
  ".cm-md-code": {
    fontFamily: "var(--mono)",
    backgroundColor: "var(--accent-weak)",
    borderRadius: "3px",
    padding: "0 3px",
  },
  ".cm-md-link": { color: "var(--accent)", textDecoration: "underline", cursor: "text" },
  ".cm-md-h1": { fontSize: "1.65em", fontWeight: "700", lineHeight: "1.3" },
  ".cm-md-h2": { fontSize: "1.4em", fontWeight: "700", lineHeight: "1.3" },
  ".cm-md-h3": { fontSize: "1.2em", fontWeight: "700" },
  ".cm-md-h4": { fontSize: "1.08em", fontWeight: "700" },
  ".cm-md-h5": { fontWeight: "700" },
  ".cm-md-h6": { fontWeight: "700", opacity: "0.75" },
});

/**
 * Markdown-Extensions (Sprache + Theme + Format-Keymap). `base: markdownLanguage`
 * aktiviert GFM-Syntax; `codeLanguages` lazy via `@codemirror/language-data` für
 * Fenced-Code-Highlight (kein Crash bei unbekannter Sprache).
 */
export function markdownExtensions(onOpenSearch?: () => void, livePreview = false): Extension[] {
  return [
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    // Soft-Wrap: lange Zeilen brechen NUR optisch um (kein horizontales Scrollen) — der Datei-
    // Inhalt bleibt unverändert. Prosa-Markdown will das immer.
    EditorView.lineWrapping,
    cmTheme,
    // `search()` verwaltet den Query-State + malt `.cm-searchMatch*` — wir nutzen die
    // Dekorationen, zeigen aber NIE CodeMirrors eigenes Panel (unsere Leiste steuert alles).
    search({ top: true }),
    searchOpenKeymap(onOpenSearch),
    // WYSIWYG-Modus: Formatierung inline rendern (Marker verbergen); nur wenn angefordert.
    ...(livePreview ? [mdLivePreview()] : []),
    formatKeymap,
  ];
}

/** Cmd/Ctrl+F: NICHT CodeMirrors eigenes Panel öffnen, sondern die mads-Suchleiste im
 *  Header fokussieren (die dann per setSearchQuery die Treffer steuert). Kommt vor der
 *  basicSetup-Keymap (User-Extensions haben Vorrang), schattet also deren Mod-f. */
function searchOpenKeymap(onOpenSearch?: () => void): Extension {
  return keymap.of([
    {
      key: "Mod-f",
      preventDefault: true,
      run: () => {
        onOpenSearch?.();
        return true;
      },
    },
  ]);
}

// ── Formatierungs-Commands (§1.4/§8) ──
// Alle operieren auf der aktiven `EditorView`: lesen die Selektion, ersetzen sie
// (Inline-Wrap) oder mutieren den Zeilenanfang (Block-Präfix). Dispatchen genau eine
// Transaktion und behalten den Fokus — keine eigene State-Kopie.

type Cmd = (view: EditorView) => boolean;

function selectionText(view: EditorView): { from: number; to: number; text: string } {
  const { from, to } = view.state.selection.main;
  return { from, to, text: view.state.sliceDoc(from, to) };
}

/** Inline-Wrapper (bold/italic/code): Marker um die Selektion legen bzw. Platzhalter. */
function wrapInline(view: EditorView, marker: string, placeholder: string): boolean {
  const { from, to, text } = selectionText(view);
  const body = text || placeholder;
  const insert = `${marker}${body}${marker}`;
  // Cursor: bei leerer Selektion in die Mitte (auf den Platzhalter), sonst hinter den Block.
  const anchor = text ? from + insert.length : from + marker.length;
  const head = text ? from + insert.length : from + marker.length + body.length;
  view.dispatch({ changes: { from, to, insert }, selection: { anchor, head } });
  view.focus();
  return true;
}

/** Block-Präfix (heading/quote): am Anfang JEDER betroffenen Zeile setzen/ergänzen. */
function prefixLines(view: EditorView, prefix: string): boolean {
  const { from, to } = view.state.selection.main;
  const startLine = view.state.doc.lineAt(from);
  const endLine = view.state.doc.lineAt(to);
  const changes = [];
  for (let n = startLine.number; n <= endLine.number; n++) {
    const line = view.state.doc.line(n);
    changes.push({ from: line.from, to: line.from, insert: prefix });
  }
  view.dispatch({ changes });
  view.focus();
  return true;
}

export const cmdBold: Cmd = (v) => wrapInline(v, "**", "fett");
export const cmdItalic: Cmd = (v) => wrapInline(v, "_", "kursiv");
export const cmdCode: Cmd = (v) => wrapInline(v, "`", "code");
export const cmdHeading = (level: 1 | 2 | 3): Cmd => (v) => prefixLines(v, `${"#".repeat(level)} `);
export const cmdBulletList: Cmd = (v) => prefixLines(v, "- ");
export const cmdOrderedList: Cmd = (v) => prefixLines(v, "1. ");

/** Link: `[text](url)` um die Selektion; Cursor landet im URL-Platzhalter. */
export const cmdLink: Cmd = (v) => {
  const { from, to, text } = selectionText(v);
  const label = text || "Text";
  const insert = `[${label}](url)`;
  const urlStart = from + insert.length - 4; // Position von "url"
  v.dispatch({ changes: { from, to, insert }, selection: { anchor: urlStart, head: urlStart + 3 } });
  v.focus();
  return true;
};

/** Tabelle: ein GFM-2x2-Gerüst an der Cursor-Zeile einfügen. */
export const cmdTable: Cmd = (v) => {
  const { from } = v.state.selection.main;
  const line = v.state.doc.lineAt(from);
  const tpl =
    "\n| Spalte A | Spalte B |\n| --- | --- |\n|  |  |\n";
  v.dispatch({ changes: { from: line.to, to: line.to, insert: tpl } });
  v.focus();
  return true;
};

/** Keymap für die Editier-Shortcuts (§8). Save/View-Toggle liegen im React-Wrapper
 *  (sie brauchen Store-Zugriff), hier nur die rein-textuellen Formatierungen. */
const formatKeymap: Extension = keymap.of([
  { key: "Mod-b", run: cmdBold },
  { key: "Mod-i", run: cmdItalic },
  { key: "Mod-k", run: cmdLink },
  { key: "Mod-1", run: cmdHeading(1) },
  { key: "Mod-2", run: cmdHeading(2) },
  { key: "Mod-3", run: cmdHeading(3) },
]);
