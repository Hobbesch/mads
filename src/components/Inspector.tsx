import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { STATUS_META } from "../status";
import { StatusDot } from "./StatusDot";
import { mountTerminal, fitTerminal } from "../terminal";

export function Inspector() {
  const selectedId = useStore((s) => s.selectedId);
  const agent = useStore((s) => (s.selectedId ? s.agents[s.selectedId] : undefined));
  const sendInput = useStore((s) => s.sendInput);
  const interruptAgent = useStore((s) => s.interruptAgent);
  const stopAgent = useStore((s) => s.stopAgent);
  const termRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (selectedId && termRef.current) mountTerminal(selectedId, termRef.current);
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    const onResize = () => fitTerminal(selectedId);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [selectedId]);

  if (!agent || !selectedId) {
    return (
      <section className="inspector empty">
        <div className="inspector-placeholder">Wähle einen Stream, um sein Live-Terminal zu sehen.</div>
      </section>
    );
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    void sendInput(selectedId, text);
    setDraft("");
  };

  return (
    <section className="inspector">
      <header className="inspector-head">
        <StatusDot status={agent.status} />
        <div className="inspector-title">
          <span className="inspector-label">{agent.label}</span>
          <span className="inspector-sub">
            {STATUS_META[agent.status].label}
            {agent.currentStep ? ` · ${agent.currentStep}` : ""} · {agent.numTurns} turns · $
            {agent.costUsd.toFixed(4)}
          </span>
        </div>
        <div className="inspector-actions">
          <button onClick={() => void interruptAgent(selectedId)} title="Unterbrechen">
            Pause
          </button>
          <button className="danger" onClick={() => void stopAgent(selectedId)} title="Stoppen & schließen">
            Stop
          </button>
        </div>
      </header>

      <div className="terminal-wrap" ref={termRef} />

      <form className="composer" onSubmit={submit}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Nachricht an ${agent.label}…`}
        />
        <button type="submit" disabled={!draft.trim()}>
          Senden
        </button>
      </form>
    </section>
  );
}
