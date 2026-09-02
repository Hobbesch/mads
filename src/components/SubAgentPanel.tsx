import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentVM } from "../store";
import { activeCount, type SubAgentEntry } from "../subAgents";
import { Elapsed, formatDuration } from "./Elapsed";

/**
 * Einblick-Panel für Teil-Agenten (SDK-Sub-Agenten via Task/Agent-Tool) eines Streams.
 *
 * Zweck ist Nachvollziehbarkeit, nicht Steuerung: Teil-Agenten laufen innerhalb der Session
 * ihres Streams, man kann sie von hier aus weder anhalten noch anweisen. Aufklappen zeigt
 * ihren Mitschnitt — welche Werkzeuge sie mit welchen Argumenten benutzen, was sie denken
 * und sagen. Bis dahin war nur ihre Anzahl sichtbar, ihre Werkzeug-Aufrufe standen
 * ununterscheidbar zwischen denen des Streams.
 */
export function SubAgentPanel({ agent }: { agent: AgentVM }) {
  const subAgents = agent.subAgents ?? {};
  // Laufende zuerst (in Startreihenfolge), erledigte darunter — die jüngst beendeten oben.
  // Nach reiner Startzeit sortiert standen die längst fertigen ganz oben, also genau das,
  // was gerade nicht mehr passiert.
  const rows = Object.values(subAgents).sort((a, b) => {
    if (!a.done !== !b.done) return a.done ? 1 : -1;
    return a.done ? (b.endedAt ?? b.lastAt) - (a.endedAt ?? a.lastAt) : a.startedAt - b.startedAt;
  });
  const [open, setOpen] = useState<Record<string, boolean>>({});

  if (rows.length === 0) return null;
  const active = activeCount(subAgents);
  const finished = rows.length - active;
  const anyOpen = rows.some((r) => open[r.id]);

  return (
    <div className="subagents-panel">
      <div className="subagents-head">
        <span className="subagents-title">
          ▶ Teil-Agenten · {active} aktiv
          {finished > 0 && <span className="subagents-finished"> · {finished} erledigt</span>}
        </span>
        <button
          type="button"
          className="subagents-toggle-all"
          onClick={() => setOpen(anyOpen ? {} : Object.fromEntries(rows.map((r) => [r.id, true])))}
        >
          {anyOpen ? "alle zuklappen" : "alle aufklappen"}
        </button>
      </div>
      {rows.map((sa) => (
        <SubAgentRow
          key={sa.id}
          sa={sa}
          open={!!open[sa.id]}
          onToggle={() => setOpen((o) => ({ ...o, [sa.id]: !o[sa.id] }))}
        />
      ))}
    </div>
  );
}

function SubAgentRow({ sa, open, onToggle }: { sa: SubAgentEntry; open: boolean; onToggle: () => void }) {
  const running = !sa.done;
  const state = running ? "running" : sa.ok === false ? "failed" : "done";
  return (
    <div className={`subagent${open ? " open" : ""}`}>
      <button
        type="button"
        className="subagent-row"
        onClick={onToggle}
        aria-expanded={open}
        title={open ? "Mitschnitt zuklappen" : "Mitschnitt aufklappen — was dieser Teil-Agent tut"}
      >
        <span className={`subagent-caret${open ? " open" : ""}`} aria-hidden="true">
          ▸
        </span>
        <span className={`subagent-dot ${state}`} />
        <span className="subagent-label">{sa.label}</span>
        {sa.type && <span className="subagent-type">{sa.type}</span>}
        {sa.model && <span className="subagent-model">{sa.model}</span>}
        {running && sa.currentStep && <span className="subagent-step">{sa.currentStep}</span>}
        <span className="subagent-meta">
          {sa.toolCount > 0 && `${sa.toolCount}×`}
          {sa.toolCount > 0 && " · "}
          {running ? <Elapsed since={sa.startedAt} /> : formatDuration((sa.endedAt ?? sa.lastAt) - sa.startedAt)}
        </span>
      </button>
      {open && <SubAgentFeed sa={sa} />}
    </div>
  );
}

function SubAgentFeed({ sa }: { sa: SubAgentEntry }) {
  const ref = useRef<HTMLDivElement>(null);
  // Am unteren Rand kleben, solange der Mensch nicht selbst hochgescrollt hat (gleiches
  // Verhalten wie das Dev-Server-Log — sonst reisst jede neue Zeile die Ansicht weg).
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [sa.feed.length]);
  useEffect(() => {
    stick.current = true; // beim Aufklappen wieder ans Ende
  }, []);

  if (sa.feed.length === 0) {
    return (
      <div className="subagent-feed empty">
        {sa.done ? "Kein Mitschnitt vorhanden." : "Noch keine Aktivität — der Teil-Agent startet gerade."}
      </div>
    );
  }
  return (
    <div
      className="subagent-feed"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {sa.feed.map((f) => (
        <div key={f.id} className={`subagent-feed-line ${f.kind}`}>
          {f.kind === "tool" ? (
            <>
              <span className="sf-name">{f.name}</span>
              {f.detail && <span className="sf-detail">{f.detail}</span>}
              <span className={`sf-mark${f.ok === false ? " err" : ""}`}>
                {f.ok === undefined ? "…" : f.ok ? "✓" : "✗"}
              </span>
            </>
          ) : (
            <>
              <span className="sf-kind">{f.kind === "thinking" ? "denkt" : "sagt"}</span>
              <span className="sf-text">{f.detail}</span>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
