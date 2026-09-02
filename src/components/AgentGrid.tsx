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
  const subCount = Object.keys(agent.subAgents ?? {}).length; // aktive Teil-Agenten (Sub-Agenten dieses Streams)
  const startDevServer = useStore((s) => s.startDevServer);
  const stopDevServer = useStore((s) => s.stopDevServer);
  const ds = agent.devServer;
  // Dev-Server nur in Sub-Streams mit eigenem Worktree (spiegelt die Inspector-Gate-Logik).
  const canDev = agent.role === "sub" && !!agent.worktreePath;
  // „läuft/startet" (nicht: gestoppt/Fehler/unkonfiguriert) → diese Kachel hält den (einzigen) Dev-Server.
  const devOn = !!ds && ds.state !== "stopped" && ds.state !== "error" && ds.state !== "unconfigured";

  return (
    // Wrapper trägt den Dev-Server-Schalter als GESCHWISTER der Karten-Button (nicht verschachtelt →
    // kein „nested interactive"); `has-dev` reserviert im Kopf Platz für den überlagernden Schalter.
    <div className={`card-wrap${canDev ? " has-dev" : ""}`} style={{ "--agent-color": color } as CSSProperties}>
      <button
        className={`card${selectedId === agent.id ? " selected" : ""}${needsInput ? " needs-input" : ""}${escalated ? " escalated" : ""}`}
        onClick={() => select(agent.id)}
      >
      <div className="card-head">
        {active ? <span className="card-spin" title="läuft" /> : <StatusDot status={agent.status} />}
        <span className="card-label">{agent.label}</span>
        {agent.reviewPr ? (
          <span className="role-badge review" title={`Read-only Review von PR #${agent.reviewPr}`}>🔍 Review</span>
        ) : (
          <span className={`role-badge ${agent.role}`}>{agent.role === "integrator" ? "Integrator" : "Sub"}</span>
        )}
        {/* Gelockerte Sandbox UNÜBERSEHBAR machen — „temporär offen" darf nie unbemerkt bleiben. */}
        {agent.role === "sub" && agent.sandboxMode === "off" && (
          <span className="sandbox-badge off" title="Sandbox AUS (Freigang) — freier Zugriff auf externe Systeme; fällt nach 15 Min. Inaktivität automatisch zurück.">🔓 Sandbox aus</span>
        )}
        {agent.role === "sub" && agent.sandboxMode === "targets" && (
          <span className="sandbox-badge targets" title="Untersuchungs-Modus — Sandbox aktiv, Projekt-Untersuchungsziele im Egress erlaubt.">🔎 Untersuchung</span>
        )}
      </div>
      {agent.branch && <div className="card-branch">⎇ {agent.branch}</div>}
      <div className="card-step">{agent.currentStep ?? STATUS_META[agent.status].label}</div>
      {subCount > 0 && (
        <div className="card-subagents" title="Aktive Teil-Agenten (Sub-Agenten, die dieser Stream gerade laufen hat)">
          ▶ {subCount} Teil-Agent{subCount === 1 ? "" : "en"} aktiv
        </div>
      )}
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
      {agent.syncBlocked && <div className="card-flag red" title="Auto-Sync wegen Rebase-Konflikt pausiert — über „Konflikt lösen“ in der Seitenleiste auflösen, dann Sync">⚠︎ Sync blockiert (Konflikt)</div>}
      {showPrompt && (
        <div className="card-prompt">
          <div className="card-prompt-label">Auftrag</div>
          <div className="card-prompt-body">{agent.lastPrompt}</div>
        </div>
      )}
      </button>
      {canDev && (
        <button
          type="button"
          className={`card-dev${devOn ? " on" : ""}${ds?.degraded ? " degraded" : ""}`}
          aria-label={devOn ? "Dev-Server stoppen" : "Dev-Server starten"}
          title={
            devOn
              ? ds?.degraded
                ? `Dev-Server nur TEILWEISE gestartet — nicht (mehr) aktiv: ${ds.deadServices?.join(", ")}. Stoppen und neu starten.`
                : `Dev-Server dieses Streams stoppen${ds && ds.state !== "running" ? ` (${ds.state}…)` : " (läuft)"}`
              : "Dev-Server dieses Streams starten — ein anderer laufender wird zuerst gestoppt (nur einer gleichzeitig)"
          }
          onClick={(e) => {
            e.stopPropagation(); // Klick trifft den überlagernden Knopf, nicht die Karte darunter
            if (devOn) void stopDevServer(agent.id);
            else void startDevServer(agent.id);
          }}
        >
          {devOn ? "■" : "▶"}
        </button>
      )}
    </div>
  );
}

/** Eingehende fremde PRs (Bots gefiltert) → read-only Review-Stream öffnen. */
function IncomingPrsBanner() {
  const incomingPrs = useStore((s) => s.incomingPrs);
  const openReviewStream = useStore((s) => s.openReviewStream);
  if (incomingPrs.length === 0) return null;
  return (
    <div className="incoming-prs">
      <div className="incoming-prs-title">📥 Eingehende PRs · {incomingPrs.length}</div>
      {incomingPrs.map((pr) => (
        <div key={pr.number} className="incoming-pr">
          <span className="incoming-pr-info">
            <b>#{pr.number}</b> {pr.title} <span className="incoming-pr-author">@{pr.author}{pr.isFork ? " · Fork" : ""}{pr.isDraft ? " · Entwurf" : ""}</span>
          </span>
          <button className="incoming-pr-open" onClick={() => void openReviewStream(pr)} title="Als read-only Review-Stream öffnen (isolierter Worktree, Dev-Server, dann mergen)">
            🔍 Review öffnen
          </button>
        </div>
      ))}
    </div>
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
      <>
        <IncomingPrsBanner />
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
      </>
    );
  }

  return (
    <>
      <IncomingPrsBanner />
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
