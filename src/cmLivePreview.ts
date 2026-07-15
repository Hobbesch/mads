/**
 * Live-Preview-Dekorationen für den WYSIWYG-Modus des Markdown-Editors (docs/design/08).
 *
 * Rein VIEW-seitig: der Markdown-Quelltext bleibt die einzige Quelle der Wahrheit und wird nie
 * transformiert (kein markdown→rich→markdown-Round-trip → kein Datenverlust). Formatierungs-
 * Marker (`** _ ` `` ` `` ~~ #` sowie `[ ]( )`) werden nur VERBORGEN und der Inhalt gestylt;
 * auf der aktiven Zeile (Cursor/Selektion) werden die Marker wieder eingeblendet, damit das
 * Editieren natürlich bleibt. Verborgene Bereiche sind `atomicRanges` → der Cursor springt sauber
 * darüber. KEINE Widget-DOM-Injektion, nur `Decoration.replace`/`.mark`/`.line` (CSS-Klassen) →
 * die Sanitize-/XSS-Invariante von mdPipeline ist strukturell nicht berührt.
 */
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { type EditorState, type Extension, type Range, RangeSet } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

const strong = Decoration.mark({ class: "cm-md-strong" });
const em = Decoration.mark({ class: "cm-md-em" });
const codeMark = Decoration.mark({ class: "cm-md-code" });
const strike = Decoration.mark({ class: "cm-md-strike" });
const linkMark = Decoration.mark({ class: "cm-md-link" });
const conceal = Decoration.replace({});
const headingLine = [1, 2, 3, 4, 5, 6].map((l) => Decoration.line({ class: `cm-md-h${l}` }));

/** Baut die Live-Preview-Dekorationen aus State + (Viewport-)Bereichen. Rein (kein DOM/View) →
 *  ohne `EditorView` per `EditorState` testbar. */
export function computeLivePreview(
  state: EditorState,
  ranges: readonly { from: number; to: number }[],
): { deco: DecorationSet; atomic: RangeSet<Decoration> } {
  const styleRanges: Range<Decoration>[] = [];
  const hideRanges: Range<Decoration>[] = [];

  // Aktive Zeilen (Cursor/Selektion) → dort NICHT verbergen (bleibt roh editierbar).
  const activeLines = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) activeLines.add(n);
  }
  const hide = (from: number, to: number) => {
    if (to > from && !activeLines.has(state.doc.lineAt(from).number)) hideRanges.push(conceal.range(from, to));
  };

  for (const { from, to } of ranges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        if (name === "StrongEmphasis") styleRanges.push(strong.range(node.from, node.to));
        else if (name === "Emphasis") styleRanges.push(em.range(node.from, node.to));
        else if (name === "InlineCode") styleRanges.push(codeMark.range(node.from, node.to));
        else if (name === "Strikethrough") styleRanges.push(strike.range(node.from, node.to));
        else if (name === "EmphasisMark" || name === "CodeMark" || name === "StrikethroughMark") {
          hide(node.from, node.to);
        } else if (name === "HeaderMark") {
          // NUR den ATX-Marker (`#…`) + folgende Leerzeichen verbergen. Die Setext-Unterstreichung
          // (`===`/`---`) ist ebenfalls ein HeaderMark — die würde sonst spurlos verschwinden.
          if (state.doc.sliceString(node.from, node.from + 1) === "#") {
            const after = state.doc.sliceString(node.to, node.to + 6);
            const sp = /^ */.exec(after)?.[0].length ?? 0;
            hide(node.from, node.to + sp);
          }
        } else if (name.length === 11 && name.startsWith("ATXHeading")) {
          const level = Number(name.charAt(10));
          if (level >= 1 && level <= 6) styleRanges.push(headingLine[level - 1].range(state.doc.lineAt(node.from).from));
        } else if (name === "Link") {
          styleRanges.push(linkMark.range(node.from, node.to));
          const marks = node.node.getChildren("LinkMark");
          // NUR echte Inline-Links `[label](url)` konzelieren: `[` und `](url)` verbergen → nur Label
          // bleibt. Referenz-/Shortcut-Links (`[a][b]`, `[x]`) haben KEINEN URL-Knoten → unangetastet
          // lassen, sonst würde das Ziel verschluckt.
          if (marks.length >= 2 && node.node.getChildren("URL").length > 0) {
            hide(marks[0].from, marks[0].to);
            hide(marks[1].from, node.to);
          }
        }
      },
    });
  }
  return {
    deco: Decoration.set([...hideRanges, ...styleRanges], true),
    atomic: RangeSet.of(hideRanges, true),
  };
}

/** Der Live-Preview-ViewPlugin: baut die Dekorationen bei Doc-/Viewport-/Selektions-Änderung neu
 *  und stellt die verborgenen Bereiche als `atomicRanges` bereit (Cursor springt sauber darüber). */
export function mdLivePreview(): Extension {
  return ViewPlugin.fromClass(
    class {
      deco: DecorationSet;
      atomic: RangeSet<Decoration>;
      constructor(view: EditorView) {
        const b = computeLivePreview(view.state, view.visibleRanges);
        this.deco = b.deco;
        this.atomic = b.atomic;
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet) {
          const b = computeLivePreview(u.view.state, u.view.visibleRanges);
          this.deco = b.deco;
          this.atomic = b.atomic;
        }
      }
    },
    {
      decorations: (v) => v.deco,
      provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? RangeSet.empty),
    },
  );
}
