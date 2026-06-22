import { useCallback } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { useStore } from "../store";
import { codeExtensions } from "../editorLang";
import type { OpenFile } from "../store";

/**
 * In-App-Editor (docs/design/07-file-explorer.md §2.2) — CodeMirror 6 für Code UND
 * Markdown (eine Engine, kein Monaco). Buffer-Verwaltung über den Store; Cmd+S →
 * saveFile (Core-Write, in den AKTIVEN Root — main ODER Sub-Agent-Worktree, OE-35).
 * Schreibt NIE direkt auf die Platte — nur über die Store-Action.
 *
 * Der volle MD-WYSIWYG-Editor aus doc 08 ist Post-MVP; hier der Code-/Text-Editor.
 */
export function FileEditor({ file }: { file: OpenFile }) {
  const buffer = useStore((s) => s.editorBuffers[file.path]);
  const setEditorBuffer = useStore((s) => s.setEditorBuffer);
  const saveFile = useStore((s) => s.saveFile);

  const value = buffer ?? file.loadedText ?? "";

  const onChange = useCallback(
    (val: string) => setEditorBuffer(file.path, val),
    [file.path, setEditorBuffer],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        e.stopPropagation();
        void saveFile(file.path);
      }
    },
    [file.path, saveFile],
  );

  return (
    <div className="file-editor" onKeyDown={onKeyDown}>
      <CodeMirror
        value={value}
        extensions={codeExtensions(file.path)}
        onChange={onChange}
        basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: true }}
      />
    </div>
  );
}
