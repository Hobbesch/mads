import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { Elapsed } from "./Elapsed";
import { MarkdownView } from "../mdPipeline";
import { openExternalLink } from "../openExternal";
import type { TimelineEvent, TodoItem } from "../store";

// Stabile Leer-Referenz (kein neues [] pro Render im Selektor → keine Render-Schleife).
const NO_EVENTS: TimelineEvent[] = [];

// Chat-Markdown nutzt jetzt dieselbe (sanitisierte, gehighlightete) Pipeline wie die
// Editor-Preview (docs/design/08-markdown-editor.md §2.3). Externe Links über die
// gemeinsame Bestätigungs-Policy (§5.4); Wikilinks gibt es im Chat-Kontext nicht.
function Md({ text }: { text: string }) {
  return (
    <div className="md">
      <MarkdownView source={text} onLink={openExternalLink} />
    </div>
  );
}

function ToolEvent({ ev }: { ev: Extract<TimelineEvent, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const long = (ev.output?.length ?? 0) > 400;
  return (
    <div className="tl-row">
      <span className={`tl-dot ${ev.running ? "running" : ev.ok === false ? "err" : "ok"}`} />
      <div className="tl-tool-body">
        <div className="tl-tool-head">
          <span className="tl-tool-name">{ev.name}</span>
          {ev.description && <span className="tl-tool-desc">{ev.description}</span>}
        </div>
        {ev.command && (
          <div className="tl-io">
            <span className="tl-io-label">IN</span>
            <pre className="tl-io-content">{ev.command}</pre>
          </div>
        )}
        {ev.output !== undefined && ev.output !== "" && (
          <div className="tl-io">
            <span className="tl-io-label">OUT</span>
            <pre className={`tl-io-content${long && !open ? " clamped" : ""}`}>{ev.output}</pre>
          </div>
        )}
        {long && (
          <button className="tl-expand" onClick={() => setOpen(!open)}>
            {open ? "weniger" : "mehr anzeigen"}
          </button>
        )}
      </div>
    </div>
  );
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tl-row">
      <span className="tl-dot dim" />
      <div className="tl-thinking-body">
        <button className="tl-thinking-toggle" onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"} Nachgedacht
        </button>
        {open && <div className="tl-thinking-text">{text}</div>}
      </div>
    </div>
  );
}

function Todos({ todos }: { todos: TodoItem[] }) {
  return (
    <div className="tl-row">
      <span className="tl-dot ok" />
      <div className="tl-tool-body">
        <div className="tl-tool-name">Todos</div>
        <ul className="tl-todos">
          {todos.map((t, i) => (
            <li key={i} className={`todo ${t.status}`}>
              <span className="todo-mark">
                {t.status === "completed" ? "✓" : t.status === "in_progress" ? "▸" : "☐"}
              </span>
              {t.content}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function renderEvent(ev: TimelineEvent) {
  switch (ev.kind) {
    case "user":
      return (
        <div key={ev.id} className="tl-user">
          {ev.text}
          {ev.images ? <span className="tl-img-chip">+{ev.images} Bild</span> : null}
        </div>
      );
    case "assistant":
      return (
        <div key={ev.id} className="tl-row">
          <span className="tl-dot dim" />
          <Md text={ev.text} />
        </div>
      );
    case "thinking":
      return <Thinking key={ev.id} text={ev.text} />;
    case "tool":
      return <ToolEvent key={ev.id} ev={ev} />;
    case "todos":
      return <Todos key={ev.id} todos={ev.todos} />;
    case "notice":
      return (
        <div key={ev.id} className="tl-row">
          <span className={`tl-dot ${ev.tone === "err" ? "err" : ev.tone === "ok" ? "ok" : "dim"}`} />
          <div className={`tl-notice ${ev.tone}`}>{ev.text}</div>
        </div>
      );
    default:
      return null;
  }
}

export function MessageTimeline({ agentId }: { agentId: string }) {
  const events = useStore((s) => s.events[agentId] ?? NO_EVENTS);
  const status = useStore((s) => s.agents[agentId]?.status);
  const currentStep = useStore((s) => s.agents[agentId]?.currentStep);
  const workStartedAt = useStore((s) => s.agents[agentId]?.workStartedAt);
  const endRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  // Den scrollenden Eltern-Container (.timeline-wrap) beobachten: sind wir am Ende?
  useEffect(() => {
    const el = rootRef.current?.parentElement;
    if (!el) return;
    const onScroll = () => setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Beim Wechsel des Agenten ans Ende springen.
  useEffect(() => {
    setAtBottom(true);
    endRef.current?.scrollIntoView({ block: "end" });
  }, [agentId]);

  // Auto-Scroll nur, wenn der Nutzer ohnehin am Ende ist (sonst Lese-Position halten).
  useEffect(() => {
    if (atBottom) endRef.current?.scrollIntoView({ block: "end" });
  }, [events.length, atBottom]);

  const scrollToEnd = () => {
    setAtBottom(true);
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  };

  const active = status === "running" || status === "starting";
  const stepLabel =
    status === "starting" || !currentStep || currentStep === "starting up"
      ? "startet…"
      : currentStep;

  return (
    <div className="timeline" ref={rootRef}>
      {events.length === 0 && !active && <div className="tl-empty">Noch keine Ausgabe.</div>}
      {events.map(renderEvent)}
      {active && (
        <div className="tl-row">
          <span className="tl-spinner" />
          <div className="tl-working">
            <span className="tl-working-label">{stepLabel}</span>
            {workStartedAt !== undefined && <Elapsed since={workStartedAt} className="tl-working-time" />}
          </div>
        </div>
      )}
      <div ref={endRef} />
      {!atBottom && (
        <button className="tl-jump" onClick={scrollToEnd} title="Zum Ende springen" aria-label="Zum Ende springen">
          ↓
        </button>
      )}
    </div>
  );
}
