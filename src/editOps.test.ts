/**
 * Tests für die pure Change-Overview-Hunk-Logik (src/editOps.ts), docs/design/09-change-overview.md §9.
 * Via `npm run test:editops`. Stil wie shared/collision.test.ts (eigenes check()-Harness, kein Framework).
 *
 * Deckt ab: toEditOp (alle vier Edit-Tools + fehlende Felder), applyOps (chronologisch, replace_all,
 * sequentielle MultiEdit-Hunks, Write/NotebookEdit-Vollersetzung) und opsToSubViews (zero-read: eine
 * Sub-View pro Hunk; mit contextDoc: ein echtes old/new-Paar).
 */
import { toEditOp, applyOps, opsToSubViews, editPath, EDIT_TOOLS, type EditOp } from "./editOps";

const results: string[] = [];
let failed = 0;
function check(name: string, cond: boolean): void {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
}

// ---- EDIT_TOOLS ----
check("EDIT_TOOLS hat genau die vier Edit-Tools", EDIT_TOOLS.size === 4 && EDIT_TOOLS.has("Edit") && EDIT_TOOLS.has("MultiEdit") && EDIT_TOOLS.has("Write") && EDIT_TOOLS.has("NotebookEdit"));
check("EDIT_TOOLS enthält kein Read/Bash", !EDIT_TOOLS.has("Read") && !EDIT_TOOLS.has("Bash"));

// ---- editPath ----
check("editPath liest file_path", editPath({ file_path: "src/a.ts" }) === "src/a.ts");
check("editPath fällt auf notebook_path zurück", editPath({ notebook_path: "n.ipynb" }) === "n.ipynb");
check("editPath ohne Pfad → undefined", editPath({}) === undefined);
check("editPath leerer Pfad → undefined", editPath({ file_path: "" }) === undefined);

// ---- toEditOp: Edit ----
const e1 = toEditOp("Edit", { file_path: "x", old_string: "a", new_string: "b", replace_all: true });
check("toEditOp Edit baut korrekten Op", e1.tool === "Edit" && (e1 as any).oldStr === "a" && (e1 as any).newStr === "b" && (e1 as any).replaceAll === true);
const e1b = toEditOp("Edit", {});
check("toEditOp Edit ohne Felder → leere Strings, kein Crash", e1b.tool === "Edit" && (e1b as any).oldStr === "" && (e1b as any).newStr === "" && (e1b as any).replaceAll === false);

// ---- toEditOp: MultiEdit ----
const m1 = toEditOp("MultiEdit", { edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d", replace_all: true }] });
check("toEditOp MultiEdit mappt edits[]", m1.tool === "MultiEdit" && (m1 as any).edits.length === 2 && (m1 as any).edits[1].replaceAll === true);
const m1b = toEditOp("MultiEdit", {});
check("toEditOp MultiEdit ohne edits → leeres Array", m1b.tool === "MultiEdit" && (m1b as any).edits.length === 0);
const m1c = toEditOp("MultiEdit", { edits: "not-an-array" });
check("toEditOp MultiEdit mit nicht-Array edits → leeres Array", (m1c as any).edits.length === 0);

// ---- toEditOp: Write ----
const w1 = toEditOp("Write", { content: "hello" });
check("toEditOp Write trägt content", w1.tool === "Write" && (w1 as any).content === "hello");
check("toEditOp Write ohne content → leerer String", (toEditOp("Write", {}) as any).content === "");

// ---- toEditOp: NotebookEdit ----
const n1 = toEditOp("NotebookEdit", { cell_id: "c1", new_source: "print(1)", edit_mode: "replace" });
check("toEditOp NotebookEdit baut korrekten Op", n1.tool === "NotebookEdit" && (n1 as any).cellId === "c1" && (n1 as any).newSource === "print(1)" && (n1 as any).editMode === "replace");
const n1b = toEditOp("NotebookEdit", {});
check("toEditOp NotebookEdit ohne Felder → leerer newSource, undefined cellId", (n1b as any).newSource === "" && (n1b as any).cellId === undefined);

// ---- applyOps: Edit chronologisch (spätere sehen frühere) ----
const apply1 = applyOps("foo bar", [
  { tool: "Edit", oldStr: "foo", newStr: "baz" },
  { tool: "Edit", oldStr: "baz bar", newStr: "qux" },
]);
check("applyOps wendet Edits chronologisch an (spätere sehen frühere)", apply1 === "qux");

// ---- applyOps: replace_all ----
const apply2 = applyOps("a a a", [{ tool: "Edit", oldStr: "a", newStr: "b", replaceAll: true }]);
check("applyOps replace_all ersetzt alle Vorkommen", apply2 === "b b b");
const apply3 = applyOps("a a a", [{ tool: "Edit", oldStr: "a", newStr: "b" }]);
check("applyOps ohne replace_all ersetzt nur erstes Vorkommen", apply3 === "b a a");

// ---- applyOps: MultiEdit sequentiell ----
const apply4 = applyOps("one two", [{ tool: "MultiEdit", edits: [{ oldStr: "one", newStr: "1" }, { oldStr: "two", newStr: "2" }] }]);
check("applyOps MultiEdit wendet edits sequentiell an", apply4 === "1 2");

// ---- applyOps: Write/NotebookEdit volle Ersetzung ----
check("applyOps Write ersetzt Vollinhalt", applyOps("alt", [{ tool: "Write", content: "neu" }]) === "neu");
check("applyOps NotebookEdit ersetzt Vollinhalt", applyOps("alt", [{ tool: "NotebookEdit", newSource: "zelle" }]) === "zelle");

// ---- applyOps: nicht gefundener Anker degradiert sicher (kein Crash) ----
check("applyOps unbekannter Anker → unverändert", applyOps("foo", [{ tool: "Edit", oldStr: "xxx", newStr: "y" }]) === "foo");
check("applyOps leerer Anker → unverändert", applyOps("foo", [{ tool: "Edit", oldStr: "", newStr: "y" }]) === "foo");

// ---- opsToSubViews: zero-read (eine Sub-View pro Hunk) ----
const sv1 = opsToSubViews([{ tool: "Edit", oldStr: "a", newStr: "b" }]);
check("opsToSubViews Edit → eine Sub-View", sv1.length === 1 && sv1[0].oldDoc === "a" && sv1[0].newDoc === "b");

const sv2 = opsToSubViews([{ tool: "MultiEdit", edits: [{ oldStr: "a", newStr: "b" }, { oldStr: "c", newStr: "d" }, { oldStr: "e", newStr: "f" }] }]);
check("opsToSubViews MultiEdit mit 3 edits → 3 Sub-Views", sv2.length === 3 && sv2.map((s) => s.key).join(",") === "m0.0,m0.1,m0.2");

const sv3 = opsToSubViews([{ tool: "Write", content: "neu" }]);
check("opsToSubViews Write → eine Sub-View mit oldDoc=''", sv3.length === 1 && sv3[0].oldDoc === "" && sv3[0].newDoc === "neu" && !!sv3[0].label);

const sv4 = opsToSubViews([{ tool: "NotebookEdit", newSource: "x", editMode: "delete", cellId: "c9" }]);
check("opsToSubViews NotebookEdit delete → Lösch-Label", sv4.length === 1 && sv4[0].oldDoc === "" && (sv4[0].label ?? "").includes("gelöscht"));

const svMixed: EditOp[] = [
  { tool: "Edit", oldStr: "a", newStr: "b" },
  { tool: "MultiEdit", edits: [{ oldStr: "c", newStr: "d" }] },
];
check("opsToSubViews mehrere Ops → eindeutige Keys, chronologisch", opsToSubViews(svMixed).map((s) => s.key).join(",") === "e0,m1.0");

// ---- opsToSubViews: mit contextDoc (Option C) → EIN echtes old/new-Paar ----
const svCtx = opsToSubViews([{ tool: "Edit", oldStr: "foo", newStr: "bar" }], "line1\nfoo\nline3");
check("opsToSubViews mit contextDoc → genau eine Sub-View", svCtx.length === 1 && svCtx[0].key === "full");
check("opsToSubViews mit contextDoc → oldDoc=contextDoc, newDoc=applyOps", svCtx[0].oldDoc === "line1\nfoo\nline3" && svCtx[0].newDoc === "line1\nbar\nline3");

for (const r of results) console.log(r);
console.log(`\n${results.length - failed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} editOps test(s) failed`);
