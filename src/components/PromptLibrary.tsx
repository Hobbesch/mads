import { useEffect, useMemo, useRef, useState } from "react";
import { BookMarked } from "lucide-react";
import { useStore } from "../store";
import type { AgentRole } from "../store";
import type { SavedPrompt } from "../../shared/protocol";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * Prompt-Bibliothek fürs Composer (kuratierte, wiederverwendbare Anweisungen je Projekt,
 * shared/protocol.ts „Prompt-Verwaltung"). Sicherheits-Eigenschaften by design:
 * ein Prompt wird beim Auswählen NUR in den Composer-ENTWURF eingefügt (Review vor Senden,
 * nie Auto-Send); `role` bindet ihn an die Stream-Rolle; `{{name}}`-Platzhalter werden
 * beim Einfügen per Inline-Formular abgefragt.
 */

/** Eindeutige `{{name}}`-Platzhalter im Prompt-Text (in Reihenfolge des Auftretens). */
export function promptPlaceholders(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** Alle `{{name}}`-Tokens durch die eingegebenen Werte ersetzen (unbekannte bleiben stehen). */
function fillPlaceholders(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (all, name: string) => values[name] || all);
}

const ROLE_LABEL: Record<SavedPrompt["role"], string> = {
  integrator: "Integrator",
  sub: "Sub",
  any: "Überall",
};

/**
 * Unauffälliger Prompt-Knopf im Composer (links neben „+"/Mikro) + Popover mit den nach
 * Stream-Rolle gefilterten Prompts. Lebt INNERHALB des Composer-<form> — deshalb hier
 * bewusst KEINE verschachtelten <form>-Elemente und Enter in den Platzhalter-Feldern
 * explizit abgefangen (sonst würde Enter die Composer-Nachricht ABSENDEN).
 */
export function PromptButton({
  role,
  onInsert,
  onManage,
}: {
  role: AgentRole;
  onInsert: (text: string) => void;
  /** „Verwalten…" — der Dialog wird vom Aufrufer AUSSERHALB des Composer-Formulars gerendert. */
  onManage: () => void;
}) {
  const prompts = useStore((s) => s.prompts);
  const [open, setOpen] = useState(false);
  // Platzhalter-Abfrage: gewählter Prompt + bisher eingegebene Werte (Inline-Formular im Popover).
  const [fill, setFill] = useState<null | { prompt: SavedPrompt; values: Record<string, string> }>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);

  const close = () => {
    setOpen(false);
    setFill(null);
  };

  // Klick außerhalb / Esc schließt das Popover (Muster: RecentProjectsPopover).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Im Platzhalter-Formular geht Esc erst eine Ebene ZURÜCK zur Liste — sonst verwirft
      // ein reflexhaftes Esc alle bereits eingetippten Platzhalter-Werte mitsamt Popover.
      if (fill) setFill(null);
      else close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, fill]);

  // Rollen-Filter: Integrator sieht integrator|any, Subs sehen sub|any.
  const visible = useMemo(() => prompts.filter((p) => p.role === "any" || p.role === role), [prompts, role]);

  const pick = (p: SavedPrompt) => {
    const names = promptPlaceholders(p.text);
    if (names.length === 0) {
      onInsert(p.text); // ohne Platzhalter direkt in den Entwurf (NIE senden)
      close();
      return;
    }
    setFill({ prompt: p, values: Object.fromEntries(names.map((n) => [n, ""])) });
  };

  const insertFilled = () => {
    if (!fill) return;
    onInsert(fillPlaceholders(fill.prompt.text, fill.values));
    close();
  };

  return (
    <span className="prompt-btn-wrap" ref={wrapRef}>
      <button
        type="button"
        className="composer-btn prompts"
        title="Gespeicherte Prompts einfügen"
        aria-label="Gespeicherte Prompts"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <BookMarked size={16} aria-hidden="true" />
      </button>

      {open && (
        <div className="prompt-popover" role="dialog" aria-label="Gespeicherte Prompts">
          {fill ? (
            // Inline-Formular: ein Textfeld je eindeutigem {{name}}-Platzhalter. Kein <form>
            // (wir stecken im Composer-<form>) — Enter wird abgefangen und fügt ein.
            <div className="prompt-fill">
              <div className="prompt-fill-title">{fill.prompt.title}</div>
              {promptPlaceholders(fill.prompt.text).map((name, i) => (
                <label key={name} className="field">
                  <span>{name}</span>
                  <input
                    value={fill.values[name] ?? ""}
                    autoFocus={i === 0}
                    onChange={(e) =>
                      setFill((f) => (f ? { ...f, values: { ...f.values, [name]: e.target.value } } : f))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        // Sonst implizite Submission des Composer-Formulars (= Nachricht senden)!
                        e.preventDefault();
                        insertFilled();
                      }
                    }}
                  />
                </label>
              ))}
              <div className="prompt-fill-actions">
                <button type="button" onClick={() => setFill(null)}>
                  Zurück
                </button>
                <button type="button" className="primary" onClick={insertFilled}>
                  Einfügen
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="prompt-pop-list">
                {visible.length === 0 ? (
                  <div className="prompt-pop-empty">Noch keine gespeicherten Prompts.</div>
                ) : (
                  visible.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="prompt-pop-item"
                      title={p.description || p.title}
                      onClick={() => pick(p)}
                    >
                      <span className="prompt-pop-title">{p.title}</span>
                      {p.description && <span className="prompt-pop-desc">{p.description}</span>}
                    </button>
                  ))
                )}
              </div>
              <div className="prompt-pop-foot">
                <button
                  type="button"
                  className="prompt-pop-manage"
                  onClick={() => {
                    close();
                    onManage();
                  }}
                >
                  Verwalten…
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </span>
  );
}

type EditState = {
  id?: string; // undefined = neuer Prompt
  title: string;
  description: string;
  role: SavedPrompt["role"];
  text: string;
};

/**
 * Verwaltungs-Dialog (bestehendes .modal-Muster): Liste aller Projekt-Prompts,
 * Neu/Bearbeiten (Titel, Beschreibung, Rolle, monospace-Text), Löschen mit Bestätigung.
 * Persistenz macht der Sidecar (savePrompt/deletePrompt → prompts_update spiegelt zurück).
 */
export function PromptManagerDialog({ onClose }: { onClose: () => void }) {
  const prompts = useStore((s) => s.prompts);
  const savePrompt = useStore((s) => s.savePrompt);
  const deletePrompt = useStore((s) => s.deletePrompt);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SavedPrompt | null>(null);
  const downOnOverlay = useRef(false); // Backdrop-Klick-Schutz wie NewStreamDialog

  const submitEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!edit || !edit.title.trim() || !edit.text.trim()) return;
    void savePrompt({
      id: edit.id ?? crypto.randomUUID(),
      title: edit.title.trim(),
      description: edit.description.trim() || undefined,
      role: edit.role,
      text: edit.text,
      updatedAt: Date.now(),
    });
    setEdit(null);
  };

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        downOnOverlay.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (downOnOverlay.current && e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal prompt-manager" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-title">Gespeicherte Prompts</div>

        {edit ? (
          <form className="prompt-edit" onSubmit={submitEdit}>
            <label className="field">
              <span>Titel</span>
              <input
                value={edit.title}
                autoFocus
                onChange={(e) => setEdit({ ...edit, title: e.target.value })}
                placeholder="z. B. Release deployen"
              />
            </label>
            <label className="field">
              <span>Beschreibung (fürs Auswahlmenü)</span>
              <input
                value={edit.description}
                onChange={(e) => setEdit({ ...edit, description: e.target.value })}
                placeholder="z. B. Vorbedingungen, Versions-Hinweis"
              />
            </label>
            <label className="field">
              <span>Rolle (wo der Prompt erscheint)</span>
              <select value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value as SavedPrompt["role"] })}>
                <option value="integrator">Integrator</option>
                <option value="sub">Sub</option>
                <option value="any">Überall</option>
              </select>
            </label>
            <label className="field">
              <span>Text — {"{{name}}"}-Platzhalter werden beim Einfügen abgefragt</span>
              <textarea
                className="prompt-edit-text"
                rows={8}
                value={edit.text}
                onChange={(e) => setEdit({ ...edit, text: e.target.value })}
                placeholder={"Anweisungstext…\nz. B. Deploye Version {{version}} nach {{umgebung}}."}
              />
            </label>
            <div className="modal-actions">
              <button type="button" onClick={() => setEdit(null)}>
                Abbrechen
              </button>
              <button type="submit" className="primary" disabled={!edit.title.trim() || !edit.text.trim()}>
                Speichern
              </button>
            </div>
          </form>
        ) : (
          <>
            {prompts.length === 0 ? (
              <div className="prompt-manage-empty">Noch keine gespeicherten Prompts.</div>
            ) : (
              <div className="prompt-manage-list">
                {prompts.map((p) => (
                  <div key={p.id} className="prompt-manage-item">
                    <div className="prompt-manage-info">
                      <span className="prompt-manage-title">
                        {p.title} <span className="prompt-manage-role">{ROLE_LABEL[p.role]}</span>
                      </span>
                      {p.description && <span className="prompt-manage-desc">{p.description}</span>}
                    </div>
                    <div className="prompt-manage-ops">
                      <button
                        type="button"
                        onClick={() =>
                          setEdit({ id: p.id, title: p.title, description: p.description ?? "", role: p.role, text: p.text })
                        }
                      >
                        Bearbeiten
                      </button>
                      <button type="button" className="danger" onClick={() => setConfirmDelete(p)}>
                        Löschen
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="modal-actions">
              <button type="button" onClick={() => setEdit({ title: "", description: "", role: "any", text: "" })}>
                + Neu
              </button>
              <button type="button" className="primary" onClick={onClose}>
                Schließen
              </button>
            </div>
          </>
        )}
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title="Prompt löschen?"
          danger
          body={
            <p>
              „<strong>{confirmDelete.title}</strong>“ wird aus den gespeicherten Prompts des Projekts entfernt.
            </p>
          }
          confirmLabel="Löschen"
          onConfirm={() => void deletePrompt(confirmDelete.id)}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
