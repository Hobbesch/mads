import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useStore } from "./store";
import { ActivityRail } from "./components/ActivityRail";
import { PrimaryPanel } from "./components/PrimaryPanel";
import { ChangeOverlay } from "./components/ChangeOverlay";
import { AgentGrid } from "./components/AgentGrid";
import { Inspector } from "./components/Inspector";
import { PermissionDialog } from "./components/PermissionDialog";
import { NewStreamDialog } from "./components/NewStreamDialog";
import { AboutDialog } from "./components/AboutDialog";
import { ParallelDialog } from "./components/ParallelDialog";
import { SaveToast } from "./components/SaveToast";
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
  const resumeAll = useStore((s) => s.resumeAll);
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

  // Activity-Rail-Shortcuts (doc 10 §8) — MVP rein im Frontend (keine Core-Änderung):
  // ⌘1 Streams · ⌘2 Dateien · ⌘, Einstellungen · ⌃⌘B Rail ein/aus · ⇧⌘D Änderungen-Toggle.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if (e.metaKey && e.ctrlKey && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        s.toggleRailCollapsed();
      } else if (e.metaKey && e.shiftKey && (e.key === "d" || e.key === "D")) {
        if (!s.project) return;
        e.preventDefault();
        s.toggleChangeOverview();
      } else if (e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key === "1") {
          e.preventDefault();
          s.setActiveView("streams");
        } else if (e.key === "2") {
          if (!s.project) return; // "Dateien" ohne Projekt deaktiviert
          e.preventDefault();
          s.setActiveView("files");
        } else if (e.key === ",") {
          e.preventDefault();
          s.setActiveView("settings");
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const lastEscalation = escalations[escalations.length - 1];

  return (
    <div className="app">
      <ActivityRail onNewStream={() => setShowNew(true)} onAbout={() => setShowAbout(true)} />
      <PrimaryPanel />

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
            <span className="escalation-text">
              ▲ Eskalation ({lastEscalation.code}): {lastEscalation.message}
            </span>
            <button
              className="banner-close"
              title="Eskalationen schließen"
              aria-label="Eskalationen schließen"
              onClick={() => useStore.getState().dismissEscalations()}
            >
              ✕
            </button>
          </div>
        )}

        {resumables.length > 0 && (
          <div className="resume-banner">
            <span className="resume-label">↩︎ {resumables.length} Stream(s) fortsetzbar:</span>
            {resumables.map((r) => (
              <button key={r.agentId} onClick={() => void resumeAgent(r)} title={r.sessionId ? "Session fortsetzen" : "Frischer Start im bestehenden Worktree"}>
                {r.label}
                {r.branch ? ` · ${r.branch}` : ""}
                {!r.sessionId ? " ⟲" : ""}
              </button>
            ))}
            {resumables.length > 1 && (
              <button className="resume-all" onClick={() => void resumeAll()}>
                Alle fortsetzen
              </button>
            )}
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
      <ChangeOverlay />
      <SaveToast />
    </div>
  );
}
