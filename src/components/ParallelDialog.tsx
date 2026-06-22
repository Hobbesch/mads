import { useState } from "react";
import { useStore } from "../store";

/**
 * „Parallel starten"-Picker: erscheint, nachdem der Nutzer im Frage-Dialog „Parallel-
 * Streams…" gewählt hat. Der Integrator liefert seine Unabhängigkeits-Einschätzung in
 * die Timeline; hier hakt der Nutzer die unabhängigen Optionen an — jede wird zu einem
 * eigenen Sub-Agenten (eigener Worktree/Branch).
 */
export function ParallelDialog() {
  const picker = useStore((s) => s.parallelPicker);
  const spawn = useStore((s) => s.spawnParallelStreams);
  const cancel = useStore((s) => s.cancelParallelPicker);
  const [picks, setPicks] = useState<Record<number, boolean>>({});
  const [briefs, setBriefs] = useState<Record<number, string>>({});

  if (!picker) return null;
  const opts = picker.options;
  const briefFor = (i: number) => briefs[i] ?? opts[i].description;
  const chosen = opts.map((o, i) => ({ o, i })).filter(({ i }) => picks[i]);

  return (
    <div className="perm-overlay">
      <div className="perm-card parallel-card">
        <div className="perm-head">
          <span className="perm-dot" />
          <div>
            <div className="perm-title">Parallel-Streams starten</div>
            <div className="perm-subtitle">
              Lies die Unabhängigkeits-Einschätzung des Integrators in der Timeline und wähle die
              unabhängigen Optionen — jede startet als eigener Sub-Agent (Worktree/Branch).
            </div>
          </div>
        </div>
        <div className="perm-body">
          <div className="parallel-list">
            {opts.map((o, i) => (
              <div key={i} className={`parallel-item${picks[i] ? " on" : ""}`}>
                <label className="parallel-head">
                  <input
                    type="checkbox"
                    checked={!!picks[i]}
                    onChange={() => setPicks((p) => ({ ...p, [i]: !p[i] }))}
                  />
                  <span className="parallel-label">{o.label}</span>
                </label>
                {o.description && <div className="parallel-desc">{o.description}</div>}
                {picks[i] && (
                  <textarea
                    className="parallel-brief"
                    rows={3}
                    value={briefFor(i)}
                    onChange={(e) => setBriefs((b) => ({ ...b, [i]: e.target.value }))}
                    placeholder="Aufgabe für den Sub-Agenten…"
                  />
                )}
              </div>
            ))}
          </div>
          <div className="perm-actions">
            <button className="deny" onClick={cancel}>
              Abbrechen
            </button>
            <button
              className="allow"
              disabled={chosen.length === 0 || chosen.some(({ i }) => !briefFor(i).trim())}
              onClick={() => void spawn(chosen.map(({ o, i }) => ({ label: o.label, brief: briefFor(i).trim() })))}
            >
              {chosen.length} Stream(s) starten
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
