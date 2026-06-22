/**
 * CodeMirror-6-Spracherweiterungen je Datei-Endung (docs/design/07-file-explorer.md §2.2).
 * Eine Engine für 07/08/09 (kein Monaco). Bewusst schlank: Markdown + JS/TS-Familie
 * abgedeckt; alle anderen Endungen erhalten Plaintext-Highlight (kein Crash).
 */
import type { Extension } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { javascript } from "@codemirror/lang-javascript";

export function codeExtensions(path: string): Extension[] {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "md" || ext === "markdown") {
    return [markdown({ base: markdownLanguage, codeLanguages: languages })];
  }
  if (ext === "ts" || ext === "tsx") return [javascript({ jsx: ext === "tsx", typescript: true })];
  if (ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs") return [javascript({ jsx: true })];
  // Sonstige: Plaintext (kein Sprach-Plugin) — read/edit funktioniert trotzdem.
  // TODO(Post-MVP, doc 07): weitere Sprachen via @codemirror/language-data nachziehen.
  return [];
}
