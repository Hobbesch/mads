import { openUrl } from "@tauri-apps/plugin-opener";
import { RELEASE, buildDateLocal } from "../version";

const REPO = "https://github.com/Hobbesch/mads";

export function AboutDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="about-card" onClick={(e) => e.stopPropagation()}>
        <div className="about-logo-wrap">
          <img className="about-logo" src="/mads-logo.png" alt="mads" />
        </div>
        <div className="about-name">mads</div>
        <div className="about-tagline">multi-agent development studio</div>
        <div className="about-version-row">
          <span className="about-version">Version {RELEASE.version}</span>
          {RELEASE.isPreRelease && <span className="badge prerelease">{RELEASE.channel}</span>}
        </div>
        <div className="about-build" title={`gebaut ${buildDateLocal()}`}>
          {RELEASE.commit}
          {RELEASE.dirty ? "*" : ""} · {RELEASE.branch} · {buildDateLocal()}
        </div>

        <p className="about-desc">
          Eine native macOS-App, um parallel mit vielen <b>Claude-Code-Agenten</b> zu entwickeln: ein Main-Agent
          (Integrator) plus Sub-Agents, jeder in eigenem git-Worktree &amp; Branch, mit voller GitHub-Nutzung — mit
          Live-Status, Rückfrage-/Eskalations-Übersicht und Terminal-Ausgabe pro Agent.
        </p>

        <ul className="about-invariants">
          <li>
            Nur der Integrator merged nach <code>main</code>
          </li>
          <li>
            <code>main</code> bleibt immer lauffähig
          </li>
          <li>Sub-Agents mergen nie selbst</li>
        </ul>

        <div className="about-tech">
          <span className="badge info">Tauri 2</span>
          <span className="badge info">React</span>
          <span className="badge info">Claude Agent SDK</span>
        </div>

        <div className="about-actions">
          <button onClick={() => void openUrl(REPO)}>GitHub ↗</button>
          <button className="primary" onClick={onClose}>
            Schließen
          </button>
        </div>

        <div className="about-footer">© 2026 Alessandro Medici · MIT-Lizenz</div>
      </div>
    </div>
  );
}
