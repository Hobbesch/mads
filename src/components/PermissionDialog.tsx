import { useMemo, useState } from "react";
import { useStore } from "../store";
import { toolDescription, toolCommand } from "../toolText";
import type { AskQuestion, PermissionRequestMsg } from "../../shared/protocol";
import { COMMAND_KIND_LABELS } from "../../shared/safe-command";

// Sentinel für die „Etwas anderes…"-Option (Freitext statt einer angebotenen Option).
const CUSTOM = "__custom__";

function ToolApproval({ req }: { req: PermissionRequestMsg }) {
  const answer = useStore((s) => s.answerPermission);
  const agent = useStore((s) => s.agents[req.agentId]);
  const description = toolDescription(req.toolName, req.input);
  const command = toolCommand(req.input);

  return (
    <div className="perm-body">
      <div className="perm-scroll">
        <div className="perm-tool">
          Tool: <code>{req.toolName}</code>
        </div>
        <div className="perm-desc">{description}</div>
        {command && <pre className="perm-cmd">{command}</pre>}
        {req.decisionReason && <div className="perm-reason">{req.decisionReason}</div>}
        {req.blockedPath && <div className="perm-reason">Pfad: {req.blockedPath}</div>}
      </div>
      <div className="perm-actions">
        <button className="deny" onClick={() => void answer(req, { behavior: "deny", message: "Vom Nutzer abgelehnt" })}>
          Ablehnen
        </button>
        {(() => {
          // „Immer erlauben" für eine merkbare Bash-Kategorie (projektweit, persistent) ODER — wie
          // bisher — für ein Tool mit Claude-Code-Regel-Vorschlägen (z. B. WebFetch-Domain). Das
          // destruktive `danger` (rm/sudo/dd/…) ist NIE merkbar → kein Knopf.
          const ck = req.commandKind;
          const kindRemember = ck && ck !== "danger";
          const suggestRemember = !!req.suggestions && req.suggestions.length > 0;
          if (!kindRemember && !suggestRemember) return null;
          const label = kindRemember ? `Immer erlauben (${COMMAND_KIND_LABELS[ck!]})` : "Immer erlauben";
          const title = kindRemember
            ? `„${COMMAND_KIND_LABELS[ck!]}" projektweit erlauben — diese Kategorie fragt danach nicht mehr, ` +
              `auch über App-Neustarts. Destruktive Befehle (rm/sudo/…) bleiben immer eine Rückfrage.`
            : "Diese Art von Aktion merken (keine erneute Nachfrage)";
          return (
            <button className="allow-always" title={title} onClick={() => void answer(req, { behavior: "allow", remember: true })}>
              {label}
            </button>
          );
        })()}
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
  // Gewählte Labels je Frage (Array): Einfachauswahl = 0/1 Element, Mehrfachauswahl (q.multiSelect) = beliebig viele.
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [customText, setCustomText] = useState<Record<string, string>>({});
  const questions = req.questions ?? [];
  const optionCount = questions.reduce((n, q) => n + (q.options?.length ?? 0), 0);
  const canParallel = !!project && agent?.role === "integrator" && optionCount >= 2;

  const isChosen = (q: AskQuestion, label: string) => (picks[q.question] ?? []).includes(label);
  // Auswahl togglen: bei Mehrfachauswahl echte Optionen an-/abwählen (Freitext „Etwas anderes…" bleibt
  // exklusiv → beim Wählen einer echten Option verdrängt); sonst (Einfachauswahl bzw. Freitext) exklusiv ersetzen.
  const toggle = (q: AskQuestion, label: string) =>
    setPicks((p) => {
      const cur = p[q.question] ?? [];
      if (q.multiSelect && label !== CUSTOM) {
        const next = cur.includes(label) ? cur.filter((x) => x !== label) : [...cur.filter((x) => x !== CUSTOM), label];
        return { ...p, [q.question]: next };
      }
      return { ...p, [q.question]: [label] };
    });
  // Effektive Antwort je Frage: „Etwas anderes…" → Freitext; Mehrfachauswahl → Labels zusammengefügt; sonst das eine Label.
  const effective = (q: AskQuestion) => {
    const sel = picks[q.question] ?? [];
    return sel.includes(CUSTOM) ? (customText[q.question] ?? "").trim() : sel.join("; ");
  };
  const allAnswered = questions.every((q) => {
    const sel = picks[q.question] ?? [];
    if (sel.length === 0) return false;
    return !sel.includes(CUSTOM) || (customText[q.question] ?? "").trim().length > 0;
  });

  const submit = () => {
    const answers: Record<string, string> = {};
    for (const q of questions) answers[q.question] = effective(q);
    void answer(req, { behavior: "answer_questions", answers });
  };

  return (
    <div className="perm-body">
      <div className="perm-scroll">
        {questions.map((q, i) => (
        <div key={i} className="perm-question">
          <div className="perm-q">
            {q.question}
            {q.multiSelect && <span className="perm-q-multi"> · mehrere wählbar</span>}
          </div>
          <div className="perm-options">
            {q.options.map((o, j) => (
              <button
                key={j}
                className={`perm-opt${isChosen(q, o.label) ? " chosen" : ""}`}
                aria-pressed={isChosen(q, o.label)}
                onClick={() => toggle(q, o.label)}
              >
                <span className="opt-label">{o.label}</span>
                <span className="opt-desc">{o.description}</span>
              </button>
            ))}
            {/* „Etwas anderes…": eigene Antwort/Anweisung, falls keine Option passt (immer exklusiv). */}
            <button
              className={`perm-opt perm-opt-custom${isChosen(q, CUSTOM) ? " chosen" : ""}`}
              aria-pressed={isChosen(q, CUSTOM)}
              onClick={() => toggle(q, CUSTOM)}
            >
              <span className="opt-label">Etwas anderes…</span>
              <span className="opt-desc">Eigene Antwort/Anweisung eingeben statt einer der Optionen.</span>
            </button>
            {isChosen(q, CUSTOM) && (
              <textarea
                className="perm-custom"
                autoFocus
                rows={2}
                placeholder="Deine Antwort oder Anweisung für diese Frage…"
                value={customText[q.question] ?? ""}
                onChange={(e) => setCustomText((c) => ({ ...c, [q.question]: e.target.value }))}
              />
            )}
          </div>
        </div>
        ))}
      </div>
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
        <button className="allow" disabled={!allAnswered} onClick={submit}>
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
