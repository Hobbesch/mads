/**
 * Menschlich lesbare Kurzbeschreibung eines Tool-Aufrufs — für den Permission-Dialog
 * (und wiederverwendbar in der Timeline). Bash & einige Tools liefern selbst eine
 * `description` mit (genau das, was Claude Code/VS Code anzeigen); für die übrigen
 * leiten wir aus Tool-Name + Schlüssel-Argument einen Satz ab.
 */

const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const firstLine = (s: string) => {
  const line = s.split("\n").find((l) => l.trim()) ?? s;
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
};

/** Der rohe Befehl/Pfad/Pattern eines Tool-Aufrufs (für die Code-Zeile). */
export function toolCommand(input: Record<string, unknown> | undefined): string | undefined {
  const i = input ?? {};
  const cmd = i.command ?? i.path ?? i.file_path ?? i.pattern;
  if (typeof cmd === "string") return cmd;
  const keys = Object.keys(i);
  return keys.length ? JSON.stringify(i).slice(0, 600) : undefined;
}

/** Ein Satz, der erklärt, was der Tool-Aufruf tut. */
export function toolDescription(toolName: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {};
  // Bash (und manche Tools) liefern eine eigene Klartext-Beschreibung mit.
  if (typeof i.description === "string" && i.description.trim()) return i.description.trim();

  const str = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : undefined);
  switch (toolName) {
    case "Bash": {
      const c = str("command");
      return c ? `Shell-Befehl ausführen: ${firstLine(c)}` : "Shell-Befehl ausführen";
    }
    case "Read":
      return str("file_path") ? `Datei lesen: ${base(str("file_path")!)}` : "Datei lesen";
    case "Edit":
    case "MultiEdit":
      return str("file_path") ? `Datei bearbeiten: ${base(str("file_path")!)}` : "Datei bearbeiten";
    case "Write":
      return str("file_path") ? `Datei schreiben: ${base(str("file_path")!)}` : "Datei schreiben";
    case "NotebookEdit":
      return str("notebook_path") ? `Notebook bearbeiten: ${base(str("notebook_path")!)}` : "Notebook bearbeiten";
    case "Glob":
      return str("pattern") ? `Dateien suchen: ${str("pattern")}` : "Dateien suchen";
    case "Grep":
      return str("pattern") ? `Im Code suchen: ${str("pattern")}` : "Im Code suchen";
    case "WebFetch":
      return str("url") ? `Webseite abrufen: ${str("url")}` : "Webseite abrufen";
    case "WebSearch":
      return str("query") ? `Web-Suche: ${str("query")}` : "Web-Suche";
    // Der SDK benennt „Task" intern in „Agent" um (Alias-Map) — real kommt „Agent" an. Ohne den
    // zweiten Fall landeten alle Subagenten im default-Zweig („Agent ausführen") und waren in der
    // Timeline praktisch unsichtbar.
    case "Task":
    case "Agent":
      return str("description") ? `Subagent starten: ${str("description")}` : "Subagent starten";
    case "TodoWrite":
      return "To-do-Liste aktualisieren";
    default:
      return `${toolName} ausführen`;
  }
}
