/**
 * Markdown-Render-Pipeline (docs/design/08-markdown-editor.md §0/§4/§5).
 *
 * SINGLE SOURCE der remark/rehype-Plugins + Sanitize-Schema + Wikilink-Plugin.
 * Importiert von `MarkdownPreview` UND vom `Md` in `MessageTimeline.tsx` (Konsolidierung,
 * §2.3) — Chat-Markdown und Editor-Preview rendern identisch und gleich sicher.
 *
 * Sicherheit (§5.2): kein `rehype-raw` (kein roher HTML-Durchlass); `rehype-sanitize`
 * als LETZTES rehype-Plugin (nach `rehype-highlight`) strippt Scripts/`onerror`/`javascript:`.
 * `react-markdown` ist per Default XSS-sicher (kein dangerouslySetInnerHTML).
 *
 * Reine UI: KEIN FS, KEIN Prozess. Externe Links/Wikilinks werden vom Aufrufer
 * (Callbacks) behandelt — diese Datei entscheidet nur über das Markup.
 */
import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeHighlight from "rehype-highlight";
import { visit } from "unist-util-visit";
import type { PluggableList } from "unified";
import type { Root, Text } from "mdast";

// ── Wikilink-Plugin (§1.2/§9) ──
// `[[name]]` → Link-Node auf `./<name>.md` (relativ zur aktuellen Datei). Mehrere
// Wikilinks pro Text-Node werden alle ersetzt; `[[name with space]]` bleibt als
// Label erhalten, der Slug wird 1:1 als Dateiname benutzt (keine Slugifizierung —
// Datei-Namen mit Leerzeichen sind gültig). Markiert via `data-wikilink` für das
// Klick-Routing in der Preview.
// Label auf eine Zeile + max. 200 Zeichen BEGRENZT: die frühere unbeschränkte Lazy-Regex
// (`[^\]]+?`) war auf bösartigem Markdown quadratisch (ReDoS → UI-Freeze). Beschränkt scannt
// jeder Match-Versuch höchstens 200 Zeichen → linear.
const WIKILINK = /\[\[([^\]\n]{1,200})\]\]/g;

export function remarkWikilink() {
  return (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (!parent || index === null || index === undefined) return;
      const value = node.value;
      if (value.length > 100_000) return; // pathologisch großer Text-Node → nicht scannen
      if (!value.includes("[[")) return;
      WIKILINK.lastIndex = 0;
      const parts: Array<Text | LinkNode> = [];
      let last = 0;
      let m: RegExpExecArray | null;
      let matched = false;
      while ((m = WIKILINK.exec(value)) !== null) {
        matched = true;
        if (m.index > last) parts.push({ type: "text", value: value.slice(last, m.index) });
        const name = m[1].trim();
        parts.push({
          type: "link",
          url: `./${name}.md`,
          data: { hProperties: { "data-wikilink": name } },
          children: [{ type: "text", value: name }],
        });
        last = m.index + m[0].length;
      }
      if (!matched) return;
      if (last < value.length) parts.push({ type: "text", value: value.slice(last) });
      // Den Text-Node durch die Misch-Sequenz ersetzen.
      (parent.children as unknown[]).splice(index, 1, ...parts);
      return index + parts.length; // visit hinter den eingefügten Knoten fortsetzen
    });
  };
}

// Minimaler mdast-Link-Typ (nur was das Plugin erzeugt).
interface LinkNode {
  type: "link";
  url: string;
  data?: { hProperties?: Record<string, string> };
  children: Text[];
}

// ── Sanitize-Schema (§5.2) ──
// Vom defaultSchema abgeleitet: lässt die highlight.js-Klassen (`hljs*`, `language-*`),
// Heading-Anchor-`id`, Task-List-/Footnote-Attribute und den `data-wikilink`-Marker durch
// — sonst alles wie defaultSchema (href-Protokolle bleiben http/https/mailto). Die
// per-Element-className-Regeln sind autoritativ (die `*`-className-Freigabe genügt NICHT —
// rehype-sanitize schneidet pro Element auf die gelisteten Werte zu).
export const mdSchema = {
  ...defaultSchema,
  // Bild-Quellen NUR lokal/`data:` — KEIN Remote-http(s). Sonst ist ein `![](https://tracker/x)`
  // in beliebigem Repo-Markdown ein Zero-Click-Tracking-Beacon (lädt beim Öffnen, verrät IP +
  // „Dokument geöffnet"). `href` bleibt http/https/mailto (Links öffnet der Nutzer bewusst extern).
  protocols: {
    ...defaultSchema.protocols,
    src: ["data"],
  },
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.span ?? []), ["className", /^pl-/, /^hljs/, "line"]],
    code: [...(defaultSchema.attributes?.code ?? []), ["className", /^language-/, /^pl-/, /^hljs/]],
    a: [...(defaultSchema.attributes?.a ?? []), "data-wikilink", "dataWikilink"],
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "id", "className"],
  },
};

export const mdRemarkPlugins: PluggableList = [remarkGfm, remarkWikilink];

/**
 * SYNCHRONE rehype-Plugin-Liste. WICHTIG: `react-markdown` rendert über `processSync` und
 * unterstützt KEINE async Plugins. `rehype-highlight` (lowlight/highlight.js) ist synchron
 * und damit kompatibel; `ignoreMissing` lässt unbekannte Sprachen unhighlightet statt zu
 * werfen. `rehype-sanitize` MUSS das LETZTE Plugin bleiben (§5.2) — `mdSchema` lässt die
 * `hljs*`-Klassen durch (`className` auf `*`). Token-Farben aus den highlight.js-Themes
 * (github / github-dark via `mdHighlight.css`, folgt OS-Light/Dark).
 * Hintergrund: das frühere async `rehype-starry-night` warf „runSync finished async" und
 * crashte den Render — abgesichert via `mdPipeline.smoke.test.tsx` (renderToStaticMarkup).
 */
export const mdRehypePlugins: PluggableList = [
  [rehypeHighlight, { ignoreMissing: true }],
  [rehypeSanitize, mdSchema],
];

export interface MarkdownViewProps {
  source: string;
  /** Wrapper-Klasse. Default `markdown-body` (voller github-markdown-css-Look, Editor-Preview).
   *  Der Chat übergibt `md-inner` → KEIN github-Chrome, die kompakten `.md`-Regeln greifen. */
  className?: string;
  /** Klick auf externen Link (http/https/mailto). */
  onLink?(href: string): void;
  /** Klick auf `[[wikilink]]` → name (ohne `.md`). */
  onWikiLink?(name: string): void;
}

/**
 * Gemeinsame Render-Komponente. `.markdown-body` trägt den github-markdown-css-Look
 * (global importiert in `main.tsx`). Links werden NICHT direkt geöffnet — der Aufrufer
 * entscheidet (Bestätigung bei non-https, §5.4), Wikilinks routen in-App.
 */
/** Code-Block mit Kopieren-Button (wie Claude Desktop / VS Code). Kopiert den exakten
 *  Quelltext (textContent des <pre>) in die Zwischenablage; Fallback ohne Clipboard-API. */
function CodeBlock(props: React.ComponentPropsWithoutRef<"pre">) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const text = ref.current?.textContent ?? "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* nichts zu tun */
      }
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="code-block">
      <button className="code-copy" onClick={copy} title="In die Zwischenablage kopieren" aria-label="Code kopieren">
        {copied ? "✓ Kopiert" : "⧉ Kopieren"}
      </button>
      <pre ref={ref} {...props} />
    </div>
  );
}

export function MarkdownView({ source, className = "markdown-body", onLink, onWikiLink }: MarkdownViewProps) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={mdRemarkPlugins}
        rehypePlugins={mdRehypePlugins}
        components={{
          pre: CodeBlock,
          a: ({ href, children, ...props }) => {
            const wikiName = (props as Record<string, unknown>)["data-wikilink"] as
              | string
              | undefined;
            return (
              <a
                href={href}
                className={wikiName !== undefined ? "wikilink" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  if (wikiName !== undefined) onWikiLink?.(wikiName);
                  else if (href) onLink?.(href);
                }}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
