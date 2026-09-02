/**
 * Auto-gespeicherter Entwurf des „Neuer Stream"-Dialogs. Grund: der Dialog hielt seine Felder nur
 * in flüchtigem React-State — ein Fehlklick auf den Backdrop (oder Escape / App-Neustart) baute die
 * Komponente ab und ein langer, mühsam getippter Prompt war unwiederbringlich weg. Der Entwurf lebt
 * jetzt in localStorage: er überlebt JEDES Schließen und wird beim erneuten Öffnen wiederhergestellt.
 * Erst ein erfolgreicher „Stream starten"-Submit räumt ihn ab (dann ist er ja verbraucht).
 */
import type { AgentRole } from "./store";
import type { PermissionMode, EffortMode } from "../shared/protocol";

export interface NewStreamDraft {
  label: string;
  prompt: string;
  role: AgentRole;
  model: string;
  effort?: EffortMode;
  branch: string;
  mode: PermissionMode;
}

const KEY = "mads.newStreamDraft.v1";

/** Hat der Entwurf echten Inhalt? (leere Text-Felder → nicht speichern, sonst „klebt" ein Leerdraft.) */
export function draftHasContent(d: Pick<NewStreamDraft, "label" | "prompt" | "branch">): boolean {
  return !!(d.prompt.trim() || d.label.trim() || d.branch.trim());
}

export function loadNewStreamDraft(): Partial<NewStreamDraft> | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as unknown;
    return d && typeof d === "object" ? (d as Partial<NewStreamDraft>) : null;
  } catch {
    return null;
  }
}

export function saveNewStreamDraft(d: NewStreamDraft): void {
  try {
    if (!draftHasContent(d)) {
      clearNewStreamDraft();
      return;
    }
    localStorage.setItem(KEY, JSON.stringify(d));
  } catch {
    /* best effort — localStorage voll/blockiert ist kein Grund, den Dialog zu stören */
  }
}

export function clearNewStreamDraft(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* noop */
  }
}
