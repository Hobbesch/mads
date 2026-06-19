import { useState } from "react";
import { useStore } from "../store";
import type { AgentRole } from "../store";

export function NewStreamDialog({ onClose }: { onClose: () => void }) {
  const createAgent = useStore((s) => s.createAgent);
  const sdkAvailable = useStore((s) => s.sidecar.sdkAvailable);
  const project = useStore((s) => s.project);
  const hasIntegrator = useStore((s) => Object.values(s.agents).some((a) => a.role === "integrator"));

  const [label, setLabel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [role, setRole] = useState<AgentRole>(hasIntegrator ? "sub" : "integrator");
  const [model, setModel] = useState(role === "integrator" ? "claude-opus-4-8" : "claude-sonnet-4-6");
  const [branch, setBranch] = useState("");
  const [mock, setMock] = useState(!sdkAvailable || !project);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const l = label.trim() || (role === "integrator" ? "Main-Agent" : "Sub-Agent");
    const p = prompt.trim() || "Beschreibe deine Aufgabe…";
    void createAgent({ label: l, prompt: p, role, mock, model, branch: branch.trim() || undefined });
    onClose();
  };

  const realSubNeedsProject = role === "sub" && !mock && !project;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-title">Neuer Entwicklungs-Stream</div>

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

        <div className="field-row">
          <label className="field">
            <span>Rolle</span>
            <select
              value={role}
              onChange={(e) => {
                const r = e.target.value as AgentRole;
                setRole(r);
                setModel(r === "integrator" ? "claude-opus-4-8" : "claude-sonnet-4-6");
              }}
            >
              <option value="integrator" disabled={hasIntegrator}>
                Integrator (Main){hasIntegrator ? " — existiert" : ""}
              </option>
              <option value="sub">Sub-Agent</option>
            </select>
          </label>

          <label className="field">
            <span>Modell</span>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="claude-opus-4-8">Opus 4.8</option>
              <option value="claude-sonnet-4-6">Sonnet 4.6</option>
              <option value="claude-haiku-4-5">Haiku 4.5</option>
            </select>
          </label>
        </div>

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
