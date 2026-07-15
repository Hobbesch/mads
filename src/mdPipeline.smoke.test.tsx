/**
 * Render-Smoke-Test der Markdown-Pipeline (src/mdPipeline.tsx). Via `npm run test:md`.
 *
 * Fängt genau die Crash-Klasse, die im Release auftrat: ein ASYNC rehype-Plugin in
 * react-markdowns synchronem `processSync` → unified wirft „runSync finished async. Use
 * run instead" → Render-Crash (ErrorBoundary). `renderToStaticMarkup` rendert die Komponente
 * synchron in Node (kein jsdom nötig); wirft der Render, schlägt der Test fehl. Prüft
 * zusätzlich: Syntax-Highlighting aktiv, Sanitize (kein Script/onerror), Wikilinks/Links.
 */
import ReactDOMServer from "react-dom/server";
import { MarkdownView } from "./mdPipeline";

// Default-Import (robust für CJS wie ESM): react-dom/server ist CJS, named-imports daraus
// sind in node-ESM nicht garantiert.
const { renderToStaticMarkup } = ReactDOMServer;

const results: string[] = [];
let failed = 0;
function check(name: string, cond: boolean): void {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
}

const SAMPLE = [
  "# Überschrift",
  "",
  "Absatz mit `inline code`, [[Wikilink]] und [Link](https://example.com).",
  "",
  "```ts",
  "const x: number = 1;",
  "function f(): number { return x; }",
  "```",
  "",
  "- a",
  "- b",
].join("\n");

let html = "";
let threw: unknown = null;
try {
  html = renderToStaticMarkup(<MarkdownView source={SAMPLE} className="markdown-body" />);
} catch (e) {
  threw = e;
}

check("rendert ohne Throw (kein 'runSync finished async')", threw === null);
if (threw) console.error("  →", String(threw));
check("Heading gerendert", /<h1/.test(html));
check("Codeblock gerendert", /<pre/.test(html) && /<code/.test(html));
check("Syntax-Highlighting aktiv (hljs-Klassen)", /hljs/.test(html));
check("Inline-Code gerendert", /<code/.test(html));
// Die `a`-Komponente KONSUMIERT data-wikilink (für Routing) und rendert class="wikilink";
// dass die Klasse erscheint, beweist: data-wikilink hat die Sanitize überlebt + erreicht die Komponente.
check("Wikilink erkannt (class=wikilink, ./Wikilink.md)", /class="wikilink"/.test(html) && /href="\.\/Wikilink\.md"/.test(html));
check("externer Link gerendert", /href="https:\/\/example\.com"/.test(html));

// Sanitize: untrusted/agent-Markdown darf kein Script/Event-Handler durchlassen (§5.2).
const XSS = "ok <script>alert(1)</script> <img src=x onerror=alert(1)>";
let xss = "";
try {
  xss = renderToStaticMarkup(<MarkdownView source={XSS} className="markdown-body" />);
} catch {
  /* Throw hier wäre ein eigener Bug — der erste check oben deckt das ab. */
}
check("Sanitize: kein <script>", !/<script/i.test(xss));
check("Sanitize: kein onerror=", !/onerror=/i.test(xss));

for (const r of results) console.log(r);
console.log(`\n${results.length - failed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} mdPipeline smoke test(s) failed`);
