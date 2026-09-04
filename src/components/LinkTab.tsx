import { useState } from "react";
import { useStore } from "../store";
import { isOpenThread, linkRole } from "../../shared/link";
import { PeerCard } from "./PeerCard";

/**
 * Verbund-Bereich im Inspector des Integrators (docs/design/12-project-link.md §9).
 *
 * Er ist bewusst NUR beim Integrator sichtbar: laut L3 ist er der einzige Peer-Ansprechpartner —
 * Sub-Streams reden nie direkt mit der Gegenseite, sonst entstünde N×M-Chatter.
 *
 * Inhalt: Zustand der Gegenseite, offene Abgleich-Threads mit Aktionen, ein Composer für den
 * direkten Draht des Menschen, und das Protokoll erledigter Threads.
 */
export function LinkTab() {
  const link = useStore((s) => s.link);
  const peerSend = useStore((s) => s.peerSend);
  const setActiveView = useStore((s) => s.setActiveView);
  const [text, setText] = useState("");
  const [showClosed, setShowClosed] = useState(false);

  if (!link || link.state === "none") return null;

  const peerName = link.config?.peer.label?.trim() || link.peer?.slug || "Gegenseite";
  const role = linkRole(link.config?.provides.patterns ?? [], link.peer?.provides ?? []);
  const roleLabel = { provider: "Provider", consumer: "Consumer", bidirectional: "Provider + Consumer" }[role];
  const open = link.threads.filter(isOpenThread);
  const closed = link.threads.filter((t) => !isOpenThread(t));
  const devServers = (link.peer?.devServers ?? []).filter((d) => d.url);

  return (
    <section className="link-tab">
      <header className="link-tab-head">
        <span className="link-tab-title">Verbund mit {peerName}</span>
        <span className={`link-tab-state ${link.state}`}>
          {link.state === "active" ? "online" : link.state === "peer_offline" ? "offline" : "wartet"}
        </span>
        <button className="peer-card-link" onClick={() => setActiveView("settings")}>
          Einstellungen
        </button>
      </header>

      <div className="link-tab-facts">
        <div>
          Rolle dieser Seite: <strong>{roleLabel}</strong>
          {link.config?.provides.compat === "lockstep" ? " · lockstep" : " · additiv"}
        </div>
        <div>
          Contract hier:{" "}
          {link.config?.provides.patterns.length ? link.config.provides.patterns.join(", ") : "keiner deklariert"}
        </div>
        <div>Contract drüben: {link.peer?.provides?.length ? link.peer.provides.join(", ") : "keiner"}</div>
        <div>
          Stand drüben: {link.peer?.mainSha ? link.peer.mainSha.slice(0, 7) : "unbekannt"} ·{" "}
          {link.contract.drift ? (
            <strong className="link-drift">Drift — die Gegenseite hat etwas geändert, das hier fehlt</strong>
          ) : (
            "Contract synchron"
          )}
        </div>
        {link.queued > 0 && <div>{link.queued} Nachricht(en) warten im Eingang.</div>}
        {devServers.length > 0 && (
          <div>
            Dev-Server drüben:{" "}
            {devServers.map((d) => (
              <span key={d.url} className="link-devserver">
                {d.url}
                {d.ready ? "" : " (startet)"}
              </span>
            ))}
          </div>
        )}
        {link.hint && <div className="link-tab-hint">{link.hint}</div>}
      </div>

      <form
        className="link-tab-composer"
        onSubmit={(e) => {
          e.preventDefault();
          const t = text.trim();
          if (!t) return;
          void peerSend(t);
          setText("");
        }}
      >
        <input
          type="text"
          value={text}
          placeholder={`An ${peerName} schreiben — wird dort als Vorschlag angezeigt…`}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" disabled={!text.trim() || link.state === "pending"}>
          Senden
        </button>
      </form>

      {open.length === 0 ? (
        <div className="link-tab-empty">Kein offener Abgleich.</div>
      ) : (
        open.map((t) => <PeerCard key={t.id} thread={t} />)
      )}

      {closed.length > 0 && (
        <div className="link-tab-closed">
          <button className="peer-card-link" onClick={() => setShowClosed((v) => !v)}>
            {showClosed ? "Erledigte ausblenden" : `Erledigte anzeigen (${closed.length})`}
          </button>
          {showClosed && closed.map((t) => <PeerCard key={t.id} thread={t} />)}
        </div>
      )}
    </section>
  );
}
