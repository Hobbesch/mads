import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useStore } from "./store";
import { Sidebar } from "./components/Sidebar";
import { AgentGrid } from "./components/AgentGrid";
import { Inspector } from "./components/Inspector";
import { PermissionDialog } from "./components/PermissionDialog";
import { NewStreamDialog } from "./components/NewStreamDialog";
import { AboutDialog } from "./components/AboutDialog";
import "./App.css";

export default function App() {
  const init = useStore((s) => s.init);
  const escalations = useStore((s) => s.escalations);
  const sidecar = useStore((s) => s.sidecar);
  const project = useStore((s) => s.project);
  const pollProject = useStore((s) => s.pollProject);
  const resumables = useStore((s) => s.resumables);
  const resumeAgent = useStore((s) => s.resumeAgent);
  const [showNew, setShowNew] = useState(false);
  const [showAbout, setShowAbout] = useState(false);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    const unlisten = listen("show-about", () => setShowAbout(true));
    return () => {
      void unlisten.then((un) => un());
    };
  }, []);

  const lastEscalation = escalations[escalations.length - 1];

  return (
    <div className="app">
      <Sidebar onNewStream={() => setShowNew(true)} onAbout={() => setShowAbout(true)} />

      <div className="main">
        <div className="titlebar" data-tauri-drag-region>
          <div className="titlebar-title" data-tauri-drag-region>
            Dashboard
          </div>
          <div className="titlebar-right">
            {project && <span className="pill repo">{project.owner}/{project.repo}</span>}
            <span className={`pill ${sidecar.status}`}>
              {sidecar.status === "ready"
                ? sidecar.sdkAvailable
                  ? "Claude SDK bereit"
                  : "Mock-Modus"
                : sidecar.status}
            </span>
            {project && (
              <button onClick={() => void pollProject()} title="Git-/PR-Status jetzt aktualisieren">
                ↻
              </button>
            )}
            <button className="primary" onClick={() => setShowNew(true)}>
              + Neuer Stream
            </button>
          </div>
        </div>

        {lastEscalation && (
          <div className="escalation-banner">
            ▲ Eskalation ({lastEscalation.code}): {lastEscalation.message}
          </div>
        )}

        {resumables.length > 0 && (
          <div className="resume-banner">
            <span className="resume-label">↩︎ {resumables.length} Agent(en) fortsetzbar:</span>
            {resumables.map((r) => (
              <button key={r.agentId} onClick={() => void resumeAgent(r)}>
                {r.label}
                {r.branch ? ` · ${r.branch}` : ""}
              </button>
            ))}
          </div>
        )}

        <div className="body">
          <div className="center">
            <div className="center-title">Aktive Agenten</div>
            <AgentGrid />
          </div>
          <Inspector />
        </div>
      </div>

      {showNew && <NewStreamDialog onClose={() => setShowNew(false)} />}
      {showAbout && <AboutDialog onClose={() => setShowAbout(false)} />}
      <PermissionDialog />
    </div>
  );
}
