import { useState } from "react";
import { useStore } from "../store";
import { STATUS_META } from "../status";
import { StatusDot } from "./StatusDot";
import type { AgentVM } from "../store";

function StreamItem({ agent }: { agent: AgentVM }) {
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.selectAgent);
  const active = selectedId === agent.id;
  return (
    <button className={`stream-item${active ? " active" : ""}`} onClick={() => select(agent.id)}>
      <StatusDot status={agent.status} />
      <span className="stream-label">{agent.label}</span>
      <span className="stream-sub">{agent.currentStep ?? STATUS_META[agent.status].label}</span>
    </button>
  );
}

export function Sidebar({ onNewStream, onAbout }: { onNewStream: () => void; onAbout: () => void }) {
  const agents = useStore((s) => s.agents);
  const order = useStore((s) => s.order);
  const sidecar = useStore((s) => s.sidecar);
  const permissions = useStore((s) => s.permissions);
  const escalations = useStore((s) => s.escalations);
  const project = useStore((s) => s.project);
  const projectStatus = useStore((s) => s.projectStatus);
  const openProject = useStore((s) => s.openProject);
  const recentProjects = useStore((s) => s.recentProjects);
  const openRecentProject = useStore((s) => s.openRecentProject);
  const forgetRecentProject = useStore((s) => s.forgetRecentProject);

  const recent = recentProjects.filter((r) => r.repoRoot !== project?.repoRoot);

  const list = order.map((id) => agents[id]).filter(Boolean);
  const integrators = list.filter((a) => a.role === "integrator");
  const subs = list.filter((a) => a.role === "sub" && a.pr?.state !== "MERGED");
  const doneSubs = list.filter((a) => a.role === "sub" && a.pr?.state === "MERGED");
  const [showDone, setShowDone] = useState(false);

  const sidecarLabel =
    sidecar.status === "ready"
      ? sidecar.sdkAvailable
        ? "bereit · SDK ok"
        : "bereit · SDK fehlt (Mock)"
      : sidecar.status === "starting"
        ? "startet…"
        : sidecar.status === "error"
          ? "Fehler"
          : "offline";

  return (
    <aside className="sidebar" data-tauri-drag-region>
      <div className="brand" onClick={onAbout} title="Über mads" role="button">
        <img className="brand-logo" src="/mads-logo.png" alt="mads" />
        <div className="brand-text">
          <div className="brand-name">mads</div>
          <div className="brand-tag">multi-agent surface</div>
        </div>
      </div>

      <div className="project-box">
        <div className="project-line">
          <span className="project-label">Projekt</span>
          <button className="link-btn" onClick={() => void openProject()}>
            {project ? "wechseln" : "öffnen"}
          </button>
        </div>
        <div className="project-name" title={project?.repoRoot}>
          {projectStatus === "opening"
            ? "öffne…"
            : project
              ? `${project.owner}/${project.repo}`
              : "kein Projekt gewählt"}
        </div>
        {project && <div className="project-branch">default: {project.defaultBranch}</div>}
      </div>

      {recent.length > 0 && (
        <div className="recent-box">
          <div className="recent-title">Zuletzt geöffnet</div>
          {recent.map((r) => (
            <div key={r.repoRoot} className="recent-item">
              <button
                className="recent-open"
                title={r.repoRoot}
                disabled={projectStatus === "opening"}
                onClick={() => void openRecentProject(r.repoRoot)}
              >
                <span className="recent-name">{r.owner && r.repo ? `${r.owner}/${r.repo}` : r.repoRoot.split("/").pop()}</span>
                <span className="recent-path">{r.repoRoot}</span>
              </button>
              <button
                className="recent-forget"
                title="Aus Liste entfernen"
                onClick={() => forgetRecentProject(r.repoRoot)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <button className="new-stream" onClick={onNewStream}>
        + Neuer Stream
      </button>

      {integrators.length > 0 && (
        <div className="stream-group">
          <div className="group-title">Integrator</div>
          {integrators.map((a) => (
            <StreamItem key={a.id} agent={a} />
          ))}
        </div>
      )}

      <div className="stream-group">
        <div className="group-title">Sub-Agents · {subs.length}</div>
        {subs.length === 0 && <div className="group-empty">Noch keine aktiven Sub-Streams.</div>}
        {subs.map((a) => (
          <StreamItem key={a.id} agent={a} />
        ))}
      </div>

      {doneSubs.length > 0 && (
        <div className="stream-group">
          <button className="group-title done-toggle" onClick={() => setShowDone((v) => !v)} title="Gemergte Streams ein-/ausblenden">
            {showDone ? "▾" : "▸"} Erledigt · {doneSubs.length}
          </button>
          {showDone && doneSubs.map((a) => <StreamItem key={a.id} agent={a} />)}
        </div>
      )}

      <div className="sidebar-foot">
        {permissions.length > 0 && <div className="foot-badge yellow">{permissions.length} Rückfrage(n)</div>}
        {escalations.length > 0 && <div className="foot-badge red">{escalations.length} Eskalation(en)</div>}
        <div className={`sidecar-state ${sidecar.status}`}>
          <span className="mini-dot" /> Sidecar: {sidecarLabel}
        </div>
      </div>
    </aside>
  );
}
