/**
 * Markdown-Render-Pipeline (docs/design/08-markdown-editor.md §0/§4/§5).
 *
 * SINGLE SOURCE der remark/rehype-Plugins + Sanitize-Schema + Wikilink-Plugin.
 * Importiert von `MarkdownPreview` UND vom `Md` in `MessageTimeline.tsx` (Konsolidierung,
 * §2.3) — Chat-Markdown und Editor-Preview rendern identisch und gleich sicher.
 *
 * Sicherheit (§5.2): kein `rehype-raw` (kein roher HTML-Durchlass); `rehype-sanitize`
 * als LETZTES rehype-Plugin (nach starry-night) strippt Scripts/`onerror`/`javascript:`.
 * `react-markdown` ist per Default XSS-sicher (kein dangerouslySetInnerHTML).
 *
 * Reine UI: KEIN FS, KEIN Prozess. Externe Links/Wikilinks werden vom Aufrufer
 * (Callbacks) behandelt — diese Datei entscheidet nur über das Markup.
 */
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { visit } from "unist-util-visit";
import type { PluggableList } from "unified";
import type { Root, Text } from "mdast";

// ── Wikilink-Plugin (§1.2/§9) ──
// `[[name]]` → Link-Node auf `./<name>.md` (relativ zur aktuellen Datei). Mehrere
// Wikilinks pro Text-Node werden alle ersetzt; `[[name with space]]` bleibt als
// Label erhalten, der Slug wird 1:1 als Dateiname benutzt (keine Slugifizierung —
// Datei-Namen mit Leerzeichen sind gültig). Markiert via `data-wikilink` für das
// Klick-Routing in der Preview.
const WIKILINK = /\[\[([^\]]+?)\]\]/g;

export function remarkWikilink() {
  return (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (!parent || index === null || index === undefined) return;
      const value = node.value;
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
// Vom defaultSchema abgeleitet: lässt starry-night-`pl-*`/`line`-Span-Klassen,
// Heading-Anchor-`id`, Task-List-/Footnote-Attribute und das `data-wikilink`-Marker
// durch — sonst alles wie defaultSchema (href-Protokolle bleiben http/https/mailto).
export const mdSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.span ?? []), ["className", /^pl-/, "line"]],
    code: [...(defaultSchema.attributes?.code ?? []), ["className", /^language-/, /^pl-/]],
    a: [...(defaultSchema.attributes?.a ?? []), ["dataWikilink"], "dataWikilink"],
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "id", "className"],
  },
};

export const mdRemarkPlugins: PluggableList = [remarkGfm, remarkWikilink];

/**
 * Hook: lazy lädt `rehype-starry-night` (600+ Grammatiken, §6) und liefert die
 * rehype-Plugin-Liste. Vor dem Laden ohne Highlight (nur sanitize) — der Codeblock
 * erscheint sofort, wird beim Nachladen einmal re-gehighlightet. So belastet die
 * schwere Grammatik-Last den Default-View nicht.
 */
export function useRehypePlugins(): PluggableList {
  const [starryNight, setStarryNight] = useState<unknown | null>(null);
  useEffect(() => {
    let alive = true;
    void import("rehype-starry-night").then((m) => {
      if (alive) setStarryNight(() => m.default);
    });
    return () => {
      alive = false;
    };
  }, []);
  return useMemo<PluggableList>(() => {
    // sanitize MUSS das letzte rehype-Plugin sein (§5.2).
    return starryNight
      ? [[starryNight as never, { allowMissingScopes: true }], [rehypeSanitize, mdSchema]]
      : [[rehypeSanitize, mdSchema]];
  }, [starryNight]);
}

export interface MarkdownViewProps {
  source: string;
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
export function MarkdownView({ source, onLink, onWikiLink }: MarkdownViewProps) {
  const rehypePlugins = useRehypePlugins();
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={mdRemarkPlugins}
        rehypePlugins={rehypePlugins}
        components={{
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
