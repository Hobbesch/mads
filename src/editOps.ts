/**
 * Change-Overview — pure Hunk-/Op-Logik (docs/design/09-change-overview.md §2.4, §3).
 *
 * Diese Datei berührt KEIN CodeMirror und KEINEN State — sie ist rein & unit-testbar:
 *  - `toEditOp`      : tool_use-Input der vier Edit-Tools → normalisierte `EditOp` (§3.3)
 *  - `applyOps`      : Ops chronologisch auf echten Datei-Inhalt anwenden (Option C, §2.4)
 *  - `opsToSubViews` : `ops[]` → die old/new-Paare, die je eine `MergeDiffView` rendert (§2.4)
 *
 * Der Live-Diff ist OHNE Datei-/git-Zugriff renderbar: `Edit`/`MultiEdit` tragen
 * `old_string`/`new_string` self-contained, `Write`/`NotebookEdit` liefern den Vollinhalt.
 */

export type EditOp =
  | { tool: "Edit"; oldStr: string; newStr: string; replaceAll?: boolean }
  | { tool: "MultiEdit"; edits: Array<{ oldStr: string; newStr: string; replaceAll?: boolean }> }
  | { tool: "Write"; content: string }
  | { tool: "NotebookEdit"; cellId?: string; newSource: string; editMode?: string };

/** Welche tool_use-Namen Edit-Ops sind (treibt sowohl Store-Befüllung als auch Tests). */
export const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/**
 * tool_use-Input → `EditOp`. Fehlende Felder degradieren zu leeren Strings (nie Crash, §7).
 */
export function toEditOp(name: string, input: Record<string, unknown>): EditOp {
  switch (name) {
    case "Edit":
      return {
        tool: "Edit",
        oldStr: String(input.old_string ?? ""),
        newStr: String(input.new_string ?? ""),
        replaceAll: !!input.replace_all,
      };
    case "MultiEdit":
      return {
        tool: "MultiEdit",
        edits: (Array.isArray(input.edits) ? (input.edits as Array<Record<string, unknown>>) : []).map((e) => ({
          oldStr: String(e?.old_string ?? ""),
          newStr: String(e?.new_string ?? ""),
          replaceAll: !!e?.replace_all,
        })),
      };
    case "Write":
      return { tool: "Write", content: String(input.content ?? "") };
    default:
      return {
        tool: "NotebookEdit",
        cellId: typeof input.cell_id === "string" ? input.cell_id : undefined,
        newSource: String(input.new_source ?? ""),
        editMode: typeof input.edit_mode === "string" ? input.edit_mode : undefined,
      };
  }
}

/** Pfad aus dem tool_use-Input (file_path bzw. notebook_path). */
export function editPath(input: Record<string, unknown>): string | undefined {
  const p = input.file_path ?? input.notebook_path;
  return typeof p === "string" && p ? p : undefined;
}

/** Ein einzelnes String-Replace mit Claude-Code-Semantik (erste Fundstelle bzw. global). */
function replaceOnce(doc: string, oldStr: string, newStr: string, replaceAll?: boolean): string {
  if (oldStr === "") return doc; // kein Anker → keine Änderung (defensiv)
  if (replaceAll) return doc.split(oldStr).join(newStr);
  const i = doc.indexOf(oldStr);
  return i === -1 ? doc : doc.slice(0, i) + newStr + doc.slice(i + oldStr.length);
}

/**
 * Wendet die Ops chronologisch auf den echten Datei-Inhalt an (Option C, §2.4) —
 * spätere Ops sehen frühere bereits angewandt (exakt die Claude-Code-Reihenfolge).
 * `Write`/`NotebookEdit` ersetzen den Inhalt vollständig.
 */
export function applyOps(base: string, ops: EditOp[]): string {
  let doc = base;
  for (const op of ops) {
    switch (op.tool) {
      case "Edit":
        doc = replaceOnce(doc, op.oldStr, op.newStr, op.replaceAll);
        break;
      case "MultiEdit":
        for (const e of op.edits) doc = replaceOnce(doc, e.oldStr, e.newStr, e.replaceAll);
        break;
      case "Write":
        doc = op.content;
        break;
      case "NotebookEdit":
        doc = op.newSource;
        break;
    }
  }
  return doc;
}

/** Ein old/new-Paar, das genau eine `MergeDiffView` rendert (§2.3/§2.4). */
export interface DiffSubView {
  key: string;
  oldDoc: string;
  newDoc: string;
  label?: string;
}

/**
 * `ops[]` → die Sub-Views einer Pane (§2.4):
 *  - mit `contextDoc` (Option C): EIN echtes old/new-Paar über die ganze Datei.
 *  - ohne `contextDoc` (MVP zero-read): EINE Sub-View pro Hunk/Op — ehrlich gestapelt,
 *    kein erfundener Zeilenraum.
 */
export function opsToSubViews(ops: EditOp[], contextDoc?: string): DiffSubView[] {
  if (contextDoc !== undefined) {
    return [{ key: "full", oldDoc: contextDoc, newDoc: applyOps(contextDoc, ops) }];
  }
  return ops.flatMap((op, i) => {
    switch (op.tool) {
      case "Edit":
        return [{ key: `e${i}`, oldDoc: op.oldStr, newDoc: op.newStr }];
      case "MultiEdit":
        return op.edits.map((e, j) => ({ key: `m${i}.${j}`, oldDoc: e.oldStr, newDoc: e.newStr }));
      case "Write":
        return [{ key: `w${i}`, oldDoc: "", newDoc: op.content, label: "neue/überschriebene Datei" }];
      case "NotebookEdit":
        return [
          {
            key: `n${i}`,
            oldDoc: "",
            newDoc: op.newSource,
            label: op.editMode === "delete" ? `Zelle gelöscht${op.cellId ? ` · ${op.cellId}` : ""}` : op.cellId,
          },
        ];
    }
  });
}
