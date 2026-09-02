import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { Elapsed } from "./Elapsed";
import { MarkdownView } from "../mdPipeline";
import { openExternalLink } from "../openExternal";
import type { TimelineEvent, TodoItem } from "../store";
import type { TimelineAttachment } from "../../shared/protocol";

// Stabile Leer-Referenz (kein neues [] pro Render im Selektor → keine Render-Schleife).
const NO_EVENTS: TimelineEvent[] = [];

// Chat-Markdown nutzt jetzt dieselbe (sanitisierte, gehighlightete) Pipeline wie die
// Editor-Preview (docs/design/08-markdown-editor.md §2.3). Externe Links über die
// gemeinsame Bestätigungs-Policy (§5.4); Wikilinks gibt es im Chat-Kontext nicht.
function Md({ text }: { text: string }) {
  return (
    <div className="md">
      <MarkdownView source={text} onLink={openExternalLink} className="md-inner" />
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
          {ev.viaSubAgent && (
            <span className="tl-tool-via" title={`Aufgerufen vom Teil-Agenten „${ev.viaSubAgent}", nicht vom Stream selbst`}>
              ▸ {ev.viaSubAgent}
            </span>
          )}
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

/**
 * Bild-Anhänge einer User-Nachricht: das ECHTE Thumbnail (kam als kleines Bild inline im Event mit,
 * daher auch auf dem Remote sichtbar) + Klick → Vollbild. Das Vollbild wird ERST beim Klick von
 * Platte geladen — es reist bewusst nicht durch Protokoll/Ringpuffer/Bridge. Fehlt das Thumbnail
 * (z. B. SVG/nicht dekodierbar), bleibt ein neutraler Chip.
 */
function Attachments({ items }: { items: TimelineAttachment[] }) {
  const [open, setOpen] = useState<TimelineAttachment | null>(null);
  const [full, setFull] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Schließen gibt die (u. U. mehrere MB große) data:-URL wieder frei — sonst bliebe sie für die
  // Lebensdauer der Timeline-Zeile im Speicher hängen.
  const close = () => {
    setOpen(null);
    setFull(null);
    setError(null);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const show = async (a: TimelineAttachment) => {
    setOpen(a);
    setFull(null);
    setError(null);
    if (!a.path) {
      setError("Vollbild nicht verfügbar (ohne Projekt/Worktree gesendet).");
      return;
    }
    try {
      const res = (await invoke("mads_read_file", { path: a.path })) as
        | { kind: "binary"; bytesBase64: string; truncated: boolean }
        | { kind: "text"; truncated: boolean };
      // Der Core liefert Bilder über 5 MB bewusst als abgeschnittenen Binär-Fallback — das ist KEIN
      // Lesefehler, sondern eine Vorschau-Grenze. Ehrlich benennen statt „konnte nicht gelesen werden".
      if (res?.kind === "binary" && !res.truncated && res.bytesBase64) {
        setFull(`data:${a.mediaType};base64,${res.bytesBase64}`);
      } else if (res?.truncated) {
        setError("Bild zu groß für die Vorschau (über 5 MB) — das Thumbnail oben zeigt den Inhalt.");
      } else {
        setError("Bild konnte nicht gelesen werden.");
      }
    } catch (e) {
      setError(`Bild konnte nicht geladen werden: ${String(e)}`);
    }
  };

  return (
    <>
      <div className="tl-thumbs">
        {items.map((a) =>
          a.thumbBase64 ? (
            <button key={a.id} type="button" className="tl-thumb" onClick={() => void show(a)} title="Anhang groß anzeigen">
              <img src={`data:${a.thumbMediaType ?? "image/jpeg"};base64,${a.thumbBase64}`} alt="Angehängtes Bild" />
            </button>
          ) : (
            <span key={a.id} className="tl-img-chip">
              Bild
            </span>
          ),
        )}
      </div>
      {open &&
        createPortal(
          <div className="tl-lightbox" role="dialog" aria-modal="true" aria-label="Angehängtes Bild" onClick={close}>
            {full ? (
              <img src={full} alt="Angehängtes Bild in voller Größe" />
            ) : (
              <p className="tl-lightbox-msg">{error ?? "Lade …"}</p>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

function renderEvent(ev: TimelineEvent) {
  switch (ev.kind) {
    case "user":
      return (
        <div key={ev.id} className="tl-user">
          {ev.text}
          {ev.attachments?.length ? <Attachments items={ev.attachments} /> : null}
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

// memo: das Timeline-Rendering (Markdown pro Nachricht) ist die teuerste Stelle im Inspector.
// Ohne memo rendert es bei JEDEM Tastendruck im Composer neu (der Inspector re-rendert, weil er
// den Draft liest) → spürbarer Tipp-Lag. Einzige Prop ist die stabile `agentId`; eigene Daten
// (events/status) liest die Komponente selbst aus dem Store → memo blockt NUR fremde Re-Renders.
export const MessageTimeline = memo(function MessageTimeline({ agentId }: { agentId: string }) {
  const events = useStore((s) => s.events[agentId] ?? NO_EVENTS);
  const status = useStore((s) => s.agents[agentId]?.status);
  const currentStep = useStore((s) => s.agents[agentId]?.currentStep);
  const workStartedAt = useStore((s) => s.agents[agentId]?.workStartedAt);
  const rootRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const pinRef = useRef(true); // am Ende „kleben"? — überlebt Re-Layouts ohne Re-Render

  // Verlässlich ans Ende scrollen — DIREKT am scrollenden Eltern-Container (.timeline-wrap), statt
  // scrollIntoView (das rät den scrollbaren Ahnen und kann bei noch wachsendem Inhalt danebenliegen).
  const stickToEnd = () => {
    const el = rootRef.current?.parentElement;
    if (el) el.scrollTop = el.scrollHeight;
  };

  // Scroll-Position beobachten → „pin" an/aus (löst sich, sobald der Nutzer hochscrollt).
  useEffect(() => {
    const el = rootRef.current?.parentElement;
    if (!el) return;
    const onScroll = () => {
      const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      pinRef.current = bottom;
      setAtBottom(bottom);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Agentenwechsel → wieder ans Ende kleben und SOFORT (vor dem Paint) dorthin scrollen.
  useLayoutEffect(() => {
    pinRef.current = true;
    setAtBottom(true);
    stickToEnd();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  // Inhalts-/Größenänderungen folgen, solange gepinnt: Markdown/Bilder layouten ASYNC und das
  // Transcript eines wiederhergestellten Streams trifft erst NACH dem ersten Render ein → sonst
  // stünde die Ansicht am falschen Ende (leer / mittendrin). Ein ResizeObserver hält uns unten.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (pinRef.current) stickToEnd();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Zusätzlich bei neuen Events folgen (Doppelsicherung neben dem Observer).
  useLayoutEffect(() => {
    if (pinRef.current) stickToEnd();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.length]);

  const scrollToEnd = () => {
    pinRef.current = true;
    setAtBottom(true);
    const el = rootRef.current?.parentElement;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
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
      {!atBottom && (
        <button className="tl-jump" onClick={scrollToEnd} title="Zum Ende springen" aria-label="Zum Ende springen">
          ↓
        </button>
      )}
    </div>
  );
});
