import { useMemo } from "react";
import { useStore } from "../store";
import { integrationPlan, type IntegrationState } from "../derive";

/**
 * Integrations-Panel (3.5): quer-über-alle-Streams-Übersicht zum Steuern der Richtung —
 * was ist merge-BEREIT (empfohlene Reihenfolge), was WARTET (mit Grund), welche aktiven
 * Streams überschneiden sich. Reine Ableitung; Klick fokussiert den Stream (dort die Aktionen).
 */
const STATE_LABEL: Record<IntegrationState, string> = {
  ready: "bereit",
  blocked: "blockiert",
  conflicting: "Konflikt",
  unsaved: "nicht gesichert",
  needs_pr: "kein PR",
  working: "arbeitet",
};

export function IntegrationPanel() {
  const agents = useStore((s) => s.agents);
  const order = useStore((s) => s.order);
  const collisions = useStore((s) => s.collisions);
  const select = useStore((s) => s.selectAgent);
  const selectedId = useStore((s) => s.selectedId);

  const plan = useMemo(
    () => integrationPlan(order.map((id) => agents[id]).filter(Boolean), collisions),
    [agents, order, collisions],
  );
  if (plan.ready.length === 0 && plan.waiting.length === 0) return null;

  const row = (i: { id: string; label: string; state: IntegrationState; detail: string; prNumber?: number }, n?: number) => (
    <button
      key={i.id}
      className={`intp-row${selectedId === i.id ? " sel" : ""}`}
      onClick={() => select(i.id)}
      title="Stream auswählen (Aktionen im Inspector)"
    >
      {n !== undefined && <span className="intp-num">{n}</span>}
      <span className={`intp-chip ${i.state}`}>{STATE_LABEL[i.state]}</span>
      <span className="intp-label">{i.label}</span>
      {i.prNumber ? <span className="intp-pr">#{i.prNumber}</span> : null}
      <span className="intp-detail">{i.detail}</span>
    </button>
  );

  return (
    <div className="integration-panel">
      <div className="intp-head">Integration</div>
      {plan.ready.length > 0 && (
        <div className="intp-group">
          <div className="intp-grouptitle">✓ Bereit zum Integrieren (empfohlene Reihenfolge)</div>
          {plan.ready.map((i, idx) => row(i, idx + 1))}
        </div>
      )}
      {plan.overlaps.length > 0 && (
        <div className="intp-overlaps">
          {plan.overlaps.map((o, k) => (
            <div key={k} className="intp-overlap">
              ⚠︎ Überschneidung: <strong>{o.a}</strong> ⟷ <strong>{o.b}</strong>
              {o.what ? <> · {o.what}</> : null} — nacheinander integrieren (mads rebaset den Rest automatisch).
            </div>
          ))}
        </div>
      )}
      {plan.waiting.length > 0 && (
        <div className="intp-group">
          <div className="intp-grouptitle">Wartet</div>
          {plan.waiting.map((i) => row(i))}
        </div>
      )}
    </div>
  );
}
