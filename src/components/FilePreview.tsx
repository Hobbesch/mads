import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import CodeMirror from "@uiw/react-codemirror";
import { codeExtensions } from "../editorLang";
import type { OpenFile } from "../store";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Vorschau je Typ (docs/design/07-file-explorer.md §2.2):
 *  - markdown → react-markdown + remark-gfm (Links extern via openUrl). Volle
 *    GitHub-Style-Pipeline (rehype-sanitize/starry-night) ist Post-MVP (doc 08).
 *  - code → CodeMirror read-only Highlight.
 *  - image → <img> aus Data-URL (Core-base64, Image-Cap §6).
 *  - binary (oder Bild über Cap) → Fallback-Karte.
 */
export function FilePreview({ file }: { file: OpenFile }) {
  if (file.kind === "image") {
    if (file.dataUrl) {
      return (
        <div className="file-preview image">
          <img src={file.dataUrl} alt={file.path.split("/").pop() ?? "Bild"} />
        </div>
      );
    }
    // Bild über Cap → Binär-Fallback (§6).
    return <BinaryFallback file={file} reason="Bild zu groß für Vorschau" />;
  }

  if (file.coreKind === "binary") {
    return <BinaryFallback file={file} />;
  }

  if (file.kind === "markdown") {
    return (
      <div className="file-preview md-preview">
        {file.truncated && <div className="preview-cap">Datei gekürzt ({fmtBytes(file.diskSize)}).</div>}
        <div className="md">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children }) => (
                <a
                  href={href}
                  onClick={(e) => {
                    e.preventDefault();
                    if (href) void openUrl(href);
                  }}
                >
                  {children}
                </a>
              ),
            }}
          >
            {file.loadedText ?? ""}
          </ReactMarkdown>
        </div>
      </div>
    );
  }

  // code (Plaintext eingeschlossen) → read-only Highlight.
  return (
    <div className="file-preview code-preview">
      {file.truncated && <div className="preview-cap">Datei gekürzt ({fmtBytes(file.diskSize)}).</div>}
      <CodeMirror
        value={file.loadedText ?? ""}
        editable={false}
        readOnly
        extensions={codeExtensions(file.path)}
        basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: false }}
      />
    </div>
  );
}

function BinaryFallback({ file, reason }: { file: OpenFile; reason?: string }) {
  const name = file.path.split("/").pop() ?? file.path;
  return (
    <div className="file-preview binary-fallback">
      <div className="binary-card">
        <div className="binary-name">{name}</div>
        <div className="binary-meta">
          {reason ?? "Binärdatei"} · {fmtBytes(file.diskSize)}
        </div>
        {/* TODO(Post-MVP, doc 07 §7): „im Finder zeigen". */}
      </div>
    </div>
  );
}
