import { useEffect, useState } from "react";
import { useStore } from "./store";
import { Sidebar } from "./components/Sidebar";
import { AgentGrid } from "./components/AgentGrid";
import { Inspector } from "./components/Inspector";
import { PermissionDialog } from "./components/PermissionDialog";
import { NewStreamDialog } from "./components/NewStreamDialog";
import "./App.css";

export default function App() {
  const init = useStore((s) => s.init);
  const escalations = useStore((s) => s.escalations);
  const sidecar = useStore((s) => s.sidecar);
  const [showNew, setShowNew] = useState(false);

  useEffect(() => {
    void init();
  }, [init]);

  const lastEscalation = escalations[escalations.length - 1];

  return (
    <div className="app">
      <Sidebar onNewStream={() => setShowNew(true)} />

      <div className="main">
        <div className="titlebar" data-tauri-drag-region>
          <div className="titlebar-title" data-tauri-drag-region>
            Dashboard
          </div>
          <div className="titlebar-right">
            <span className={`pill ${sidecar.status}`}>
              {sidecar.status === "ready"
                ? sidecar.sdkAvailable
                  ? "Claude SDK bereit"
                  : "Mock-Modus"
                : sidecar.status}
            </span>
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

        <div className="body">
          <div className="center">
            <div className="center-title">Aktive Agenten</div>
            <AgentGrid />
          </div>
          <Inspector />
        </div>
      </div>

      {showNew && <NewStreamDialog onClose={() => setShowNew(false)} />}
      <PermissionDialog />
    </div>
  );
}
