import { useStore } from "../store";

/**
 * Primary-Panel für activeView === "settings" (docs/design/10-navigation-toolbar.md §2.1).
 * Platzhalter: konsolidiert die Autonomie-Toggles aus der Titlebar (OE-52). Erweiterbar
 * um Permission-Defaults/Modelle (Post-MVP).
 */
export function SettingsPanel() {
  const project = useStore((s) => s.project);
  const autonomy = useStore((s) => s.autonomy);
  const setAutonomy = useStore((s) => s.setAutonomy);

  return (
    <section className="primary-panel settings-panel" aria-label="Einstellungen">
      <header className="primary-panel-head">Einstellungen</header>
      <div className="settings-body">
        <div className="settings-group">
          <div className="settings-group-title">Autonomie</div>
          {!project && <div className="settings-hint">Erst ein Projekt öffnen, um Autonomie-Optionen zu setzen.</div>}
          <label className="settings-row">
            <input
              type="checkbox"
              checked={autonomy.autoSync}
              disabled={!project}
              onChange={() => void setAutonomy({ ...autonomy, autoSync: !autonomy.autoSync })}
            />
            <span>
              <span className="settings-row-label">Auto-Sync</span>
              <span className="settings-row-sub">Sub-Branches automatisch onto origin/main rebasen</span>
            </span>
          </label>
          <label className="settings-row">
            <input
              type="checkbox"
              checked={autonomy.collisionScan}
              disabled={!project}
              onChange={() => void setAutonomy({ ...autonomy, collisionScan: !autonomy.collisionScan })}
            />
            <span>
              <span className="settings-row-label">Kollisions-Scan</span>
              <span className="settings-row-sub">Code-Kollisionen zwischen aktiven Agenten erkennen</span>
            </span>
          </label>
        </div>
        {/* TODO(Post-MVP): Permission-Defaults, Modell-Auswahl, Update-Kanal (doc 10 §10). */}
      </div>
    </section>
  );
}
