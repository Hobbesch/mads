import { useState } from "react";
import { useStore } from "../store";
import { RemotePairing } from "./RemotePairing";

/**
 * Primary-Panel für activeView === "settings" (docs/design/10-navigation-toolbar.md §2.1).
 * Konsolidiert die Autonomie-Toggles (OE-52) + das Remote-Pairing (iOS-App). Erweiterbar
 * um Permission-Defaults/Modelle (Post-MVP).
 */
export function SettingsPanel() {
  const project = useStore((s) => s.project);
  const autonomy = useStore((s) => s.autonomy);
  const setAutonomy = useStore((s) => s.setAutonomy);
  const reloginClaude = useStore((s) => s.reloginClaude);
  const checkAuthStatus = useStore((s) => s.checkAuthStatus);
  const [authStatus, setAuthStatus] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function onCheckAuth() {
    setChecking(true);
    try {
      setAuthStatus(await checkAuthStatus());
    } catch (e) {
      setAuthStatus(`Status konnte nicht ermittelt werden: ${String(e)}`);
    } finally {
      setChecking(false);
    }
  }

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
        <div className="settings-group">
          <div className="settings-group-title">Anthropic-Login</div>
          <div className="settings-hint">
            mads nutzt deine bestehende Claude-Anmeldung (macOS-Schlüsselbund) und speichert selbst kein
            Token. Auth-Fehler sind oft vorübergehend (erneut senden genügt); bei dauerhaftem
            „Authentifizierung fehlgeschlagen" hier neu anmelden — es öffnet sich ein Terminal mit dem
            Browser-Login. Danach den Stream erneut senden (kein Neustart nötig).
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <button onClick={() => void reloginClaude()} title="Öffnet ein Terminal mit dem Befehl claude auth login (Browser-OAuth)">
              Bei Claude neu anmelden
            </button>
            <button onClick={() => void onCheckAuth()} disabled={checking}>
              {checking ? "Prüfe…" : "Status prüfen"}
            </button>
          </div>
          {authStatus !== null && (
            <pre
              style={{
                marginTop: 8,
                padding: "8px 10px",
                borderRadius: 6,
                fontSize: 12,
                lineHeight: 1.4,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                opacity: 0.85,
                background: "rgba(127,127,127,0.12)",
              }}
            >
              {authStatus}
            </pre>
          )}
        </div>
        <RemotePairing />
        {/* TODO(Post-MVP): Permission-Defaults, Modell-Auswahl, Update-Kanal (doc 10 §10). */}
      </div>
    </section>
  );
}
