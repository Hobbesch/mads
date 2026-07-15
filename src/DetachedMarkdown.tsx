import { useEffect } from "react";
import { useStore } from "./store";
import { MarkdownEditor } from "./components/MarkdownEditor";

/**
 * Eigenständiges Markdown-Fenster (Wunsch: Vorschau/Editor „vom Hauptfenster loslösen").
 * Wird von main.tsx gerendert, wenn `?detach=md&path=…` gesetzt ist — KEIN App-Init
 * (kein Sidecar). Liest/schreibt über die geteilte Core-FsScope, die das Hauptfenster
 * bereits registriert hat.
 */
export function DetachedMarkdown({ path }: { path: string }) {
  const openFile = useStore((s) => s.openFile);

  useEffect(() => {
    void useStore.getState().openFilePath(path);
  }, [path]);

  if (!openFile || openFile.path !== path) {
    return <div className="detached-status">Lade {path.split("/").pop() ?? path}…</div>;
  }
  if (openFile.kind !== "markdown") {
    return <div className="detached-status">Nur Markdown-Dateien können in einem eigenen Fenster geöffnet werden.</div>;
  }

  return (
    <div className="detached-md">
      <MarkdownEditor file={openFile} detached />
    </div>
  );
}
