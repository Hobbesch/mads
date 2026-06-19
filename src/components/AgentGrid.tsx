import { useStore } from "../store";
import { STATUS_META } from "../status";
import { StatusDot } from "./StatusDot";
import { agentBadges, hasGitEscalation } from "../derive";
import type { AgentVM } from "../store";

function AgentCard({ agent }: { agent: AgentVM }) {
  const select = useStore((s) => s.selectAgent);
  const selectedId = useStore((s) => s.selectedId);
  const permissions = useStore((s) => s.permissions);
  const needsInput = agent.status === "waiting_input";
  const escalated = agent.status === "escalation" || agent.status === "error" || hasGitEscalation(agent);
  const pending = permissions.filter((p) => p.agentId === agent.id).length;
  const badges = agentBadges(agent);

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
      {agent.branch && <div className="card-branch">⎇ {agent.branch}</div>}
      <div className="card-step">{agent.currentStep ?? STATUS_META[agent.status].label}</div>
      {badges.length > 0 && (
        <div className="badges">
          {badges.map((b, i) => (
            <span key={i} className={`badge ${b.tone}`}>
              {b.label}
            </span>
          ))}
        </div>
      )}
      <div className="card-meta">
        <span>{STATUS_META[agent.status].label}</span>
        <span className="card-cost">
          {agent.numTurns} turns · ${agent.costUsd.toFixed(4)}
        </span>
      </div>
      {needsInput && <div className="card-flag yellow">● braucht Input{pending ? ` (${pending})` : ""}</div>}
    </button>
  );
}

export function AgentGrid() {
  const agents = useStore((s) => s.agents);
  const order = useStore((s) => s.order);
  const project = useStore((s) => s.project);
  const list = order.map((id) => agents[id]).filter(Boolean);

  if (list.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-title">Keine aktiven Agenten</div>
        <div className="empty-sub">
          {project ? (
            <>
              Projekt <b>{project.owner}/{project.repo}</b> ist geöffnet. Lege mit „+ Neuer Stream" einen Integrator
              (Haupt-Checkout) oder Sub-Agent (eigener Worktree/Branch) an.
            </>
          ) : (
            <>
              Öffne zuerst ein Projekt-Repo (oben „Projekt öffnen") — dann laufen echte Agenten je in eigenem
              git-Worktree. Ohne Projekt/Login kannst du den <b>Mock-Modus</b> nutzen.
            </>
          )}
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
