import { useMemo, useState } from "react";
import { useStore } from "../store";
import { toolDescription, toolCommand } from "../toolText";
import type { PermissionRequestMsg } from "../../shared/protocol";

function ToolApproval({ req }: { req: PermissionRequestMsg }) {
  const answer = useStore((s) => s.answerPermission);
  const agent = useStore((s) => s.agents[req.agentId]);
  const description = toolDescription(req.toolName, req.input);
  const command = toolCommand(req.input);

  return (
    <div className="perm-body">
      <div className="perm-tool">
        Tool: <code>{req.toolName}</code>
      </div>
      <div className="perm-desc">{description}</div>
      {command && <pre className="perm-cmd">{command}</pre>}
      {req.decisionReason && <div className="perm-reason">{req.decisionReason}</div>}
      {req.blockedPath && <div className="perm-reason">Pfad: {req.blockedPath}</div>}
      <div className="perm-actions">
        <button className="deny" onClick={() => void answer(req, { behavior: "deny", message: "Vom Nutzer abgelehnt" })}>
          Ablehnen
        </button>
        {req.suggestions && req.suggestions.length > 0 && (
          <button
            className="allow-always"
            title="Diese Art von Aktion für diese Sitzung merken (keine erneute Nachfrage)"
            onClick={() => void answer(req, { behavior: "allow", remember: true })}
          >
            Immer erlauben
          </button>
        )}
        <button className="allow" onClick={() => void answer(req, { behavior: "allow" })}>
          Erlauben{agent ? ` (${agent.label})` : ""}
        </button>
      </div>
    </div>
  );
}

function QuestionForm({ req }: { req: PermissionRequestMsg }) {
  const answer = useStore((s) => s.answerPermission);
  const requestParallel = useStore((s) => s.requestParallelAssessment);
  const agent = useStore((s) => s.agents[req.agentId]);
  const project = useStore((s) => s.project);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const questions = req.questions ?? [];
  const optionCount = questions.reduce((n, q) => n + (q.options?.length ?? 0), 0);
  const canParallel = !!project && agent?.role === "integrator" && optionCount >= 2;

  const submit = () => {
    void answer(req, { behavior: "answer_questions", answers: picks });
  };

  return (
    <div className="perm-body">
      {questions.map((q, i) => (
        <div key={i} className="perm-question">
          <div className="perm-q">{q.question}</div>
          <div className="perm-options">
            {q.options.map((o, j) => {
              const chosen = picks[q.question] === o.label;
              return (
                <button
                  key={j}
                  className={`perm-opt${chosen ? " chosen" : ""}`}
                  onClick={() => setPicks((p) => ({ ...p, [q.question]: o.label }))}
                >
                  <span className="opt-label">{o.label}</span>
                  <span className="opt-desc">{o.description}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div className="perm-actions">
        {canParallel && (
          <button
            className="parallel-btn"
            title="Den Integrator prüfen lassen, welche Optionen unabhängig sind, und sie als eigene Streams starten"
            onClick={() => void requestParallel(req)}
          >
            Parallel-Streams…
          </button>
        )}
        <button className="allow" disabled={Object.keys(picks).length < questions.length} onClick={submit}>
          Antwort senden
        </button>
      </div>
    </div>
  );
}

export function PermissionDialog() {
  const permissions = useStore((s) => s.permissions);
  const agents = useStore((s) => s.agents);
  const req = useMemo(() => permissions[0], [permissions]);
  if (!req) return null;
  const agent = agents[req.agentId];

  return (
    <div className="perm-overlay">
      <div className="perm-card">
        <div className="perm-head">
          <span className="perm-dot" />
          <div>
            <div className="perm-title">{agent?.label ?? req.agentId} braucht eine Entscheidung</div>
            <div className="perm-subtitle">
              {req.kind === "ask_user_question" ? "Rückfrage" : "Tool-Erlaubnis"} · {permissions.length} in der Warteschlange
            </div>
          </div>
        </div>
        {req.kind === "ask_user_question" ? <QuestionForm req={req} /> : <ToolApproval req={req} />}
      </div>
    </div>
  );
}
