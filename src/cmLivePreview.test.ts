/**
 * Tests für den Live-Preview-Decorator (cmLivePreview.ts). Via `npm run test:livepreview`.
 * Läuft OHNE DOM (reiner EditorState) — validiert, dass computeLivePreview über echtes Markdown
 * nicht wirft (Decoration-Ordering/atomicRanges korrekt) und dass die aktive Zeile eingeblendet
 * bleibt (weniger verborgene Bereiche, wenn der Cursor auf der Zeile steht).
 */
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { computeLivePreview } from "./cmLivePreview";

const results: string[] = [];
let failed = 0;
function check(name: string, cond: boolean): void {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
}

const doc = [
  "# Überschrift eins", // Zeile 1
  "", // 2
  "Ein **fetter** und _kursiver_ Text mit `code` und ~~weg~~.", // 3
  "Ein [Label](https://example.com) Link.", // 4
].join("\n");

function compute(cursor: number) {
  const state = EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: [markdown({ base: markdownLanguage })],
  });
  ensureSyntaxTree(state, doc.length, 5000);
  return computeLivePreview(state, [{ from: 0, to: doc.length }]);
}

// Cursor auf Zeile 1 → Zeile 1 (Überschrift) bleibt roh; Zeilen 3/4 werden verborgen/gestylt.
let threw = false;
let onL1;
try {
  onL1 = compute(0);
} catch (e) {
  threw = true;
  // eslint-disable-next-line no-console
  console.error(e);
}
check("computeLivePreview wirft nicht (echtes Markdown)", !threw);
check("erzeugt Dekorationen", !!onL1 && onL1.deco.size > 0);
check("erzeugt verborgene (atomic) Marker-Bereiche", !!onL1 && onL1.atomic.size >= 6);

// Cursor ans Ende (Zeile 4) → Zeile 4 (Link) bleibt roh, dafür wird die Überschrift (Zeile 1) verborgen.
const onEnd = compute(doc.length);
check("aktive Zeile ändert die Enthüllung (L1 vs. Ende verborgene Bereiche unterschiedlich)", onL1!.atomic.size !== onEnd.atomic.size);

// Cursor mitten in Zeile 3 (auf **fetter**) → die Marker DIESER Zeile werden NICHT verborgen.
const posL3 = doc.indexOf("**fetter");
const onL3 = compute(posL3 + 2);
check("Cursor auf Zeile 3 blendet deren Marker wieder ein (weniger verborgen als von L1 aus)", onL3.atomic.size < onL1!.atomic.size);

// Referenz-Links dürfen NICHT verschluckt und Setext-Überschriften NICHT verborgen werden.
{
  const doc2 = "[ref][id]\n\nTitel\n=====\n\n[id]: https://example.com";
  const state2 = EditorState.create({
    doc: doc2,
    selection: { anchor: doc2.length }, // Cursor auf letzter Zeile → Zeilen 1/4 sind NICHT aktiv
    extensions: [markdown({ base: markdownLanguage })],
  });
  ensureSyntaxTree(state2, doc2.length, 5000);
  const r2 = computeLivePreview(state2, [{ from: 0, to: doc2.length }]);
  const l1 = state2.doc.line(1); // [ref][id]
  let hideOnRefLink = false;
  r2.atomic.between(l1.from, l1.to, () => {
    hideOnRefLink = true;
    return false;
  });
  check("Referenz-Link [ref][id] wird NICHT verborgen (kein URL-Knoten)", !hideOnRefLink);
  const l4 = state2.doc.line(4); // =====
  let hideSetext = false;
  r2.atomic.between(l4.from, l4.to, () => {
    hideSetext = true;
    return false;
  });
  check("Setext-Unterstreichung (=====) wird NICHT verborgen", !hideSetext);
}

// eslint-disable-next-line no-console
console.log(results.join("\n"));
if (failed > 0) {
  // eslint-disable-next-line no-console
  console.error(`\n${failed} LivePreview-Test(s) fehlgeschlagen.`);
  process.exit(1);
}
