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

export function Sidebar({ onNewStream }: { onNewStream: () => void }) {
  const agents = useStore((s) => s.agents);
  const order = useStore((s) => s.order);
  const sidecar = useStore((s) => s.sidecar);
  const permissions = useStore((s) => s.permissions);
  const escalations = useStore((s) => s.escalations);

  const list = order.map((id) => agents[id]).filter(Boolean);
  const integrators = list.filter((a) => a.role === "integrator");
  const subs = list.filter((a) => a.role === "sub");

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
      <div className="brand">
        <div className="brand-mark">m</div>
        <div className="brand-text">
          <div className="brand-name">mads</div>
          <div className="brand-tag">multi-agent surface</div>
        </div>
      </div>

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
        {subs.length === 0 && <div className="group-empty">Noch keine Sub-Streams.</div>}
        {subs.map((a) => (
          <StreamItem key={a.id} agent={a} />
        ))}
      </div>

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
