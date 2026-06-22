import { Suspense, lazy } from "react";
import { useStore } from "../store";
import { SettingsPanel } from "./SettingsPanel";

// Lazy-Mount (doc 10 §6): das schwere Dateien-Panel (react-arborist + CodeMirror) wird
// erst beim ersten Aktivieren von activeView==="files" geladen — der Default-Streams-View
// bleibt schlank.
const FileExplorer = lazy(() => import("./FileExplorer").then((m) => ({ default: m.FileExplorer })));

/**
 * Switch über `activeView` → rendert das aktivitäts-spezifische Primary-Panel
 * (docs/design/10-navigation-toolbar.md §2.2 / LAYOUT-CONTRACT (f)).
 *
 * Bei `activeView === "streams"` (Default) rendert es `null` — KEIN Mittel-Panel
 * (§1a.5): der Content (AgentGrid + Inspector) steht direkt neben der Rail.
 *
 * NB: „Änderungen" ist KEIN Primary-Panel — es ist ein position:fixed-Overlay
 * (<ChangeOverlay/>), gesteuert von changeOverviewOn, NICHT von activeView (§2.3).
 */
export function PrimaryPanel() {
  const view = useStore((s) => s.activeView);
  const hasProject = useStore((s) => !!s.project);

  switch (view) {
    case "settings":
      return <SettingsPanel />;
    case "files":
      // Fallback (§7): "files" ohne Projekt zeigt kein Panel (Rail-Eintrag ist disabled).
      if (!hasProject) return null;
      return (
        <Suspense fallback={<div className="primary-panel file-explorer-loading">Dateien lädt…</div>}>
          <FileExplorer />
        </Suspense>
      );
    case "streams":
    default:
      return null; // KEIN Panel: Rail steht direkt neben .main
  }
}
