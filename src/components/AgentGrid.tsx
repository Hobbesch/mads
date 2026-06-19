import { useStore } from "../store";
import { STATUS_META } from "../status";
import { StatusDot } from "./StatusDot";
import type { AgentVM } from "../store";

function AgentCard({ agent }: { agent: AgentVM }) {
  const select = useStore((s) => s.selectAgent);
  const selectedId = useStore((s) => s.selectedId);
  const permissions = useStore((s) => s.permissions);
  const needsInput = agent.status === "waiting_input";
  const escalated = agent.status === "escalation" || agent.status === "error";
  const pending = permissions.filter((p) => p.agentId === agent.id).length;

  return (
    <button
      className={`card${selectedId === agent.id ? " selected" : ""}${needsInput ? " needs-input" : ""}${escalated ? " escalated" : ""}`}
      onClick={() => select(agent.id)}
    >
      <div className="card-head">
        <StatusDot status={agent.status} />
        <span className="card-label">{agent.label}</span>
        <span className={`role-badge ${agent.role}`}>{agent.role === "integrator" ? "Integrator" : "Sub"}</span>
      </div>
      <div className="card-step">{agent.currentStep ?? STATUS_META[agent.status].label}</div>
      <div className="card-meta">
        <span>{STATUS_META[agent.status].label}</span>
        <span className="card-cost">
          {agent.numTurns} turns · ${agent.costUsd.toFixed(4)}
        </span>
      </div>
      {needsInput && <div className="card-flag yellow">● braucht Input{pending ? ` (${pending})` : ""}</div>}
      {escalated && <div className="card-flag red">▲ Eskalation</div>}
    </button>
  );
}

export function AgentGrid() {
  const agents = useStore((s) => s.agents);
  const order = useStore((s) => s.order);
  const list = order.map((id) => agents[id]).filter(Boolean);

  if (list.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-title">Keine aktiven Agenten</div>
        <div className="empty-sub">
          Lege mit „+ Neuer Stream" einen Main-Agent (Integrator) oder Sub-Agent an. Ohne Claude-Login kannst du den
          <b> Mock-Modus</b> aktivieren, um das Dashboard inkl. Permission-Loop zu sehen.
        </div>
      </div>
    );
  }

  return (
    <div className="grid">
      {list.map((a) => (
        <AgentCard key={a.id} agent={a} />
      ))}
    </div>
  );
}
