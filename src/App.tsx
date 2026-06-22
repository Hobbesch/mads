import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useStore } from "./store";
import { Sidebar } from "./components/Sidebar";
import { AgentGrid } from "./components/AgentGrid";
import { Inspector } from "./components/Inspector";
import { PermissionDialog } from "./components/PermissionDialog";
import { NewStreamDialog } from "./components/NewStreamDialog";
import { AboutDialog } from "./components/AboutDialog";
import { ParallelDialog } from "./components/ParallelDialog";
import { RELEASE, buildDateLocal } from "./version";
import "./App.css";

export default function App() {
  const init = useStore((s) => s.init);
  const escalations = useStore((s) => s.escalations);
  const sidecar = useStore((s) => s.sidecar);
  const project = useStore((s) => s.project);
  const pollProject = useStore((s) => s.pollProject);
  const resumables = useStore((s) => s.resumables);
  const resumeAgent = useStore((s) => s.resumeAgent);
  const collisions = useStore((s) => s.collisions);
  const autonomy = useStore((s) => s.autonomy);
  const setAutonomy = useStore((s) => s.setAutonomy);
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
            <button
              className={`pill version${RELEASE.isPreRelease ? " prerelease" : ""}`}
              onClick={() => setShowAbout(true)}
              title={`${RELEASE.label} · Commit ${RELEASE.commit}${RELEASE.dirty ? "* (uncommittete Änderungen)" : ""} · Branch ${RELEASE.branch} · gebaut ${buildDateLocal()}`}
            >
              v{RELEASE.version} · {RELEASE.commit}
              {RELEASE.dirty ? "*" : ""}
            </button>
            {project && <span className="pill repo">{project.owner}/{project.repo}</span>}
            <span className={`pill ${sidecar.status}`}>
              {sidecar.status === "ready"
                ? sidecar.sdkAvailable
                  ? "Claude SDK bereit"
                  : "Mock-Modus"
                : sidecar.status}
            </span>
            {project && (
              <>
                <button
                  className={`toggle ${autonomy.autoSync ? "on" : ""}`}
                  onClick={() => void setAutonomy({ ...autonomy, autoSync: !autonomy.autoSync })}
                  title="Sub-Branches automatisch onto origin/main rebasen"
                >
                  Auto-Sync {autonomy.autoSync ? "an" : "aus"}
                </button>
                <button
                  className={`toggle ${autonomy.collisionScan ? "on" : ""}`}
                  onClick={() => void setAutonomy({ ...autonomy, collisionScan: !autonomy.collisionScan })}
                  title="Code-Kollisionen zwischen aktiven Agenten erkennen"
                >
                  Kollisions-Scan {autonomy.collisionScan ? "an" : "aus"}
                </button>
                <button onClick={() => void pollProject()} title="Git-/PR-Status jetzt aktualisieren">
                  ↻
                </button>
              </>
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

        {collisions.length > 0 && (
          <div className="collision-banner">
            <span className="collision-label">⚠︎ {collisions.length} mögliche Code-Kollision(en):</span>
            {collisions.map((c, i) => (
              <span key={i} className="collision-item">
                {c.labelA} ⟷ {c.labelB} · {c.path}
                {c.symbols?.length ? `:${c.symbols.join(",")}` : c.severity === "file" ? " (gleiche Datei)" : ""}
              </span>
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
      <ParallelDialog />
    </div>
  );
}
