import { forwardRef } from "react";
import { MarkdownView } from "../mdPipeline";
import { openExternalLink } from "../openExternal";

/**
 * Render-Modus (docs/design/08-markdown-editor.md §2.1) — GitHub-Style-Markdown über
 * die GETEILTE Pipeline (`mdPipeline`: remark-gfm + Wikilink + starry-night + sanitize).
 * Externe Links über die gemeinsame Bestätigungs-Policy (§5.4); `[[wikilinks]]` routen
 * in-App (Callback). Scroll-Container ist nach außen referenzierbar (Split-Sync, §6).
 */
export interface MarkdownPreviewProps {
  source: string;
  /** Klick auf `[[name]]` → in-App-Navigation (Aufrufer öffnet `./<name>.md`). */
  onWikiLink(name: string): void;
  onScrollRatio?(ratio: number): void;
}

export const MarkdownPreview = forwardRef<HTMLDivElement, MarkdownPreviewProps>(
  function MarkdownPreview({ source, onWikiLink, onScrollRatio }, ref) {
    let raf: number | null = null;
    const onScroll = (e: React.UIEvent) => {
      if (!onScrollRatio) return;
      const el = e.currentTarget as HTMLElement;
      if (raf !== null) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        const max = el.scrollHeight - el.clientHeight;
        onScrollRatio(max > 0 ? el.scrollTop / max : 0);
      });
    };
    return (
      <div className="md-preview-pane" ref={ref} onScroll={onScroll}>
        <MarkdownView source={source} onLink={openExternalLink} onWikiLink={onWikiLink} />
      </div>
    );
  },
);
