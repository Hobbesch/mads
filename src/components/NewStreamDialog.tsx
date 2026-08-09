import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { AgentRole } from "../store";
import type { PermissionMode, EffortMode } from "../../shared/protocol";
import { ModelEffortPicker } from "./ModelEffortPicker";
import { clampEffort } from "../modelCatalog";
import { loadNewStreamDraft, saveNewStreamDraft, clearNewStreamDraft, draftHasContent } from "../newStreamDraft";

export function NewStreamDialog({ onClose }: { onClose: () => void }) {
  const createAgent = useStore((s) => s.createAgent);
  const sdkAvailable = useStore((s) => s.sidecar.sdkAvailable);
  const project = useStore((s) => s.project);
  const hasIntegrator = useStore((s) => Object.values(s.agents).some((a) => a.role === "integrator"));
  const defaultModel = useStore((s) => s.defaultModel);
  const defaultEffort = useStore((s) => s.defaultEffort);

  // Beim Öffnen einen zuvor auto-gespeicherten Entwurf wiederherstellen (überlebt Fehlklick/Neustart).
  const draft = useRef(loadNewStreamDraft()).current;
  const [label, setLabel] = useState(draft?.label ?? "");
  const [prompt, setPrompt] = useState(draft?.prompt ?? "");
  const [role, setRole] = useState<AgentRole>(draft?.role ?? (hasIntegrator ? "sub" : "integrator"));
  // Modell + Effort werden aus dem globalen Default (linke Navigation) vorbelegt, hier überschreibbar.
  const [model, setModel] = useState(draft?.model ?? defaultModel);
  const [effort, setEffort] = useState<EffortMode | undefined>(
    draft?.effort ?? clampEffort(defaultModel, defaultEffort),
  );
  const [branch, setBranch] = useState(draft?.branch ?? "");
  const [mode, setMode] = useState<PermissionMode>(draft?.mode ?? "auto");
  const [mock, setMock] = useState(!sdkAvailable || !project);
  // Wurde beim Öffnen ein Entwurf mit Inhalt wiederhergestellt? → sichtbarer Hinweis + „Verwerfen".
  const [showRestored, setShowRestored] = useState(
    !!draft && draftHasContent({ label: draft.label ?? "", prompt: draft.prompt ?? "", branch: draft.branch ?? "" }),
  );

  const discardDraft = () => {
    setLabel("");
    setPrompt("");
    setBranch("");
    setRole(hasIntegrator ? "sub" : "integrator");
    setModel(defaultModel);
    setEffort(clampEffort(defaultModel, defaultEffort));
    setMode("auto");
    clearNewStreamDraft();
    setShowRestored(false);
  };

  // Auto-Speichern: jede Feldänderung sichert den Entwurf sofort in localStorage. So kostet KEIN
  // Schließweg (Backdrop, Escape, Abbrechen, App-Neustart) den Text — erst der Submit räumt ihn ab.
  useEffect(() => {
    saveNewStreamDraft({ label, prompt, role, model, effort, branch, mode });
  }, [label, prompt, role, model, effort, branch, mode]);

  const dirty = draftHasContent({ label, prompt, branch });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const l = label.trim() || (role === "integrator" ? "Main-Agent" : "Sub-Agent");
    const p = prompt.trim() || "Beschreibe deine Aufgabe…";
    void createAgent({ label: l, prompt: p, role, mock, model, effort, branch: branch.trim() || undefined, permissionMode: mode });
    clearNewStreamDraft(); // Entwurf verbraucht → aufräumen
    onClose();
  };

  // Escape schließt den Dialog — der Entwurf bleibt gespeichert und ist beim nächsten Öffnen wieder da.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const realSubNeedsProject = role === "sub" && !mock && !project;

  // Backdrop-Klick schließt — ABER nur, wenn Maus-Druck UND -Loslassen beide auf dem Overlay
  // waren. Sonst beendet eine Textmarkierung im Prompt (Drag, der auf dem Overlay endet) den
  // Dialog ungewollt: das `click`-Event zielt dann auf den gemeinsamen Vorfahren (= Overlay),
  // läuft also am `stopPropagation` des Formulars vorbei.
  const downOnOverlay = useRef(false);

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        downOnOverlay.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // Ein echter Backdrop-Klick schließt NUR, wenn nichts eingetippt ist. Sobald der Nutzer Inhalt
        // hat, ignorieren wir den Klick (der gemeldete Datenverlust): der Dialog bleibt offen, statt
        // spurlos zu verschwinden. Bewusstes Verlassen geht weiter über „Abbrechen" oder Escape (der
        // Entwurf bleibt dabei gespeichert und kehrt beim nächsten Öffnen zurück).
        if (downOnOverlay.current && e.target === e.currentTarget && !dirty) onClose();
      }}
    >
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-title">Neuer Entwicklungs-Stream</div>

        {showRestored && (
          <div className="modal-hint draft-restored">
            ↩ Wiederhergestellter Entwurf.{" "}
            <button type="button" className="linklike" onClick={discardDraft}>
              Verwerfen
            </button>
          </div>
        )}

        {!project && (
          <div className="modal-hint">
            Kein Projekt geöffnet — echte Agenten brauchen ein Repo (links „Projekt öffnen"). Ohne Projekt nur Mock.
          </div>
        )}

        <label className="field">
          <span>Bezeichnung</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="z. B. Login-Formular" autoFocus />
        </label>

        <label className="field">
          <span>Aufgabe (initialer Prompt)</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            placeholder="Was soll dieser Agent tun?"
          />
        </label>

        <label className="field">
          <span>Rolle</span>
          <select value={role} onChange={(e) => setRole(e.target.value as AgentRole)}>
            <option value="integrator" disabled={hasIntegrator}>
              Integrator (Main){hasIntegrator ? " — existiert" : ""}
            </option>
            <option value="sub">Sub-Agent</option>
          </select>
        </label>

        <label className="field">
          <span>Modell &amp; Effort</span>
          <ModelEffortPicker
            model={model}
            effort={effort}
            onModel={(m) => {
              setModel(m);
              setEffort(clampEffort(m, effort));
            }}
            onEffort={setEffort}
            variant="dialog"
          />
        </label>

        <label className="field">
          <span>Permission-Modus</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as PermissionMode)}>
            <option value="default">Standard — fragt vor jeder Aktion</option>
            <option value="acceptEdits">Auto-Edits — Datei-Edits ohne Nachfrage</option>
            <option value="plan">Plan — nur lesen/planen</option>
            <option value="auto">Auto — liest & ändert selbst, fragt nur bei Push/PR/Löschen/Netz</option>
            <option value="bypassPermissions">Bypass — alles ohne Nachfrage</option>
          </select>
        </label>

        {role === "sub" && !mock && (
          <label className="field">
            <span>Branch (leer = automatisch aus Bezeichnung)</span>
            <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="mads/login-formular" />
          </label>
        )}

        <label className="checkbox">
          <input type="checkbox" checked={mock} onChange={(e) => setMock(e.target.checked)} />
          <span>
            Mock-Modus {sdkAvailable && project ? "" : "(empfohlen — kein Projekt/Login)"} — scripted Demo-Stream ohne
            echten Claude-Aufruf & ohne Worktree
          </span>
        </label>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Abbrechen
          </button>
          <button type="submit" className="primary" disabled={realSubNeedsProject}>
            {realSubNeedsProject ? "Projekt nötig" : "Stream starten"}
          </button>
        </div>
      </form>
    </div>
  );
}
