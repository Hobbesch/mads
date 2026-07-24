import { useState, type CSSProperties } from "react";
import { useStore } from "../store";
import { STATUS_META } from "../status";
import { StatusDot } from "./StatusDot";
import { Elapsed } from "./Elapsed";
import { fmtTokens } from "../format";
import { agentBadges, hasGitEscalation, unsavedWork, isMergedDone } from "../derive";
import { agentColor } from "../agentColor";
import type { AgentVM } from "../store";

function AgentCard({ agent }: { agent: AgentVM }) {
  const select = useStore((s) => s.selectAgent);
  const selectedId = useStore((s) => s.selectedId);
  const permissions = useStore((s) => s.permissions);
  const needsInput = agent.status === "waiting_input";
  const escalated =
    agent.status === "escalation" || agent.status === "error" || agent.syncBlocked === true || hasGitEscalation(agent);
  const unsaved = unsavedWork(agent);
  const pending = permissions.filter((p) => p.agentId === agent.id).length;
  const badges = agentBadges(agent);
  const active = agent.status === "running" || agent.status === "starting";
  const color = agentColor(agent.branch ?? agent.id);
  // Zuletzt abgesetzter Auftrag: sichtbar ab dem Absenden bis zum Merge. Danach (isMergedDone) und
  // bei passiv wiederhergestellten Streams ohne lastPrompt bleibt die Kachel prompt-frei.
  const showPrompt = agent.lastPrompt && !isMergedDone(agent);

  return (
    <button
      className={`card${selectedId === agent.id ? " selected" : ""}${needsInput ? " needs-input" : ""}${escalated ? " escalated" : ""}`}
      style={{ "--agent-color": color } as CSSProperties}
      onClick={() => select(agent.id)}
    >
      <div className="card-head">
        {active ? <span className="card-spin" title="läuft" /> : <StatusDot status={agent.status} />}
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
        <span>
          {STATUS_META[agent.status].label}
          {active && agent.workStartedAt !== undefined && (
            <>
              {" · "}
              <Elapsed since={agent.workStartedAt} />
            </>
          )}
        </span>
        <span
          className="card-cost"
          title={
            agent.costUsd > 0
              ? `≈ $${agent.costUsd.toFixed(4)} (API-Schätzung; bei Abo nicht abgerechnet)`
              : "Abo-Nutzung (Claude Code) — keine API-Kosten"
          }
        >
          {agent.numTurns} turns · {fmtTokens(agent.inputTokens + agent.outputTokens)} tok
        </span>
      </div>
      {needsInput && <div className="card-flag yellow">● braucht Input{pending ? ` (${pending})` : ""}</div>}
      {unsaved && <div className="card-flag red" title="Uncommittete/untrackte Arbeit oder Commits ohne PR — geht beim Aufräumen verloren">● Arbeit nicht gesichert</div>}
      {agent.syncBlocked && <div className="card-flag red" title="Auto-Sync wegen Rebase-Konflikt pausiert — Konflikt lösen, dann Sync">⚠︎ Sync blockiert (Konflikt)</div>}
      {showPrompt && (
        <div className="card-prompt">
          <div className="card-prompt-label">Auftrag</div>
          <div className="card-prompt-body">{agent.lastPrompt}</div>
        </div>
      )}
    </button>
  );
}

export function AgentGrid() {
  const agents = useStore((s) => s.agents);
  const order = useStore((s) => s.order);
  const project = useStore((s) => s.project);
  const [showDone, setShowDone] = useState(false);

  const all = order.map((id) => agents[id]).filter(Boolean);
  // „Erledigt" (kollabierte Sektion) NUR für wirklich fertige Streams: PR gemergt UND keine
  // ungemergte Arbeit mehr (isMergedDone). Sonst würde ein „Mergen & weiterarbeiten"-Stream mit
  // neuen Commits (alter PR bleibt MERGED) beim nächsten PR-Poll aus dem aktiven Grid
  // verschwinden — genau der Bug, dass die Kachel „manchmal weg" ist. Aktives Grid = alles andere.
  const list = all.filter((a) => !isMergedDone(a));
  const doneSubs = all.filter((a) => a.role === "sub" && isMergedDone(a));

  if (list.length === 0 && doneSubs.length === 0) {
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
    <>
      {list.length > 0 && (
        <div className="grid">
          {list.map((a) => (
            <AgentCard key={a.id} agent={a} />
          ))}
        </div>
      )}
      {doneSubs.length > 0 && (
        <div className="grid-done">
          <button
            className="group-title done-toggle"
            onClick={() => setShowDone((v) => !v)}
            title="Gemergte Streams ein-/ausblenden"
          >
            {showDone ? "▾" : "▸"} Erledigt · {doneSubs.length}
          </button>
          {showDone && (
            <div className="grid">
              {doneSubs.map((a) => (
                <AgentCard key={a.id} agent={a} />
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
