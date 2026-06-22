import { useStore } from "../store";
import { SettingsPanel } from "./SettingsPanel";

/**
 * Switch über `activeView` → rendert das aktivitäts-spezifische Primary-Panel
 * (docs/design/10-navigation-toolbar.md §2.2 / LAYOUT-CONTRACT (f)).
 *
 * Bei `activeView === "streams"` (Default) rendert es `null` — KEIN Mittel-Panel
 * (§1a.5): der Content (AgentGrid + Inspector) steht direkt neben der Rail.
 *
 * NB: „Änderungen" ist KEIN Primary-Panel — es ist ein position:fixed-Overlay
 * (<ChangeOverlay/>), gesteuert von changeOverviewOn, NICHT von activeView (§2.3).
 *
 * TODO(Part B / doc 07): "files" → <FileExplorer/> (lazy-mounted) — der File-Explorer
 * wird mit Feature 07 eingehängt.
 */
export function PrimaryPanel() {
  const view = useStore((s) => s.activeView);
  const hasProject = useStore((s) => !!s.project);

  switch (view) {
    case "settings":
      return <SettingsPanel />;
    case "files":
      // Fallback (§7): "files" ohne Projekt zeigt kein Panel. Echter Explorer folgt in Part B.
      if (!hasProject) return null;
      return null;
    case "streams":
    default:
      return null; // KEIN Panel: Rail steht direkt neben .main
  }
}
