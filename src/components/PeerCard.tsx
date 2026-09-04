import { useState } from "react";
import { useStore } from "../store";
import { describeDelta } from "../../shared/link";
import type { LinkThread } from "../../shared/protocol";

const STATE_LABEL: Record<LinkThread["state"], string> = {
  open: "offen",
  proposed: "Vorschlag liegt vor",
  in_progress: "in Arbeit",
  landed: "hier gelandet",
  done: "erledigt",
  declined: "abgelehnt",
  escalated: "wartet auf dich",
};

/**
 * Eine Karte je Abgleich-Thread (docs/design/12-project-link.md §9).
 *
 * Sie zeigt, was die Gegenseite will bzw. was diese Seite angekündigt hat, und bietet genau die
 * Aktionen, die dem Menschen zustehen: starten, ablehnen, als erledigt markieren, Drift bewusst
 * akzeptieren. Ein mitgelieferter Diff ist ANSICHT — er wird nie angewendet.
 */
export function PeerCard({ thread }: { thread: LinkThread }) {
  const startPeerThread = useStore((s) => s.startPeerThread);
  const peerThreadAction = useStore((s) => s.peerThreadAction);
  const peerSend = useStore((s) => s.peerSend);
  const drift = useStore((s) => s.link?.contract.drift ?? false);
  const [showDiff, setShowDiff] = useState(false);
  const [reply, setReply] = useState("");

  const closed = thread.state === "done" || thread.state === "declined";
  const brief = thread.proposal?.brief ?? thread.suggestedBrief;
  const canStart = !closed && !thread.ownerAgentId;

  return (
    <div className={`peer-card ${thread.state}${thread.breaking ? " breaking" : ""}`}>
      <div className="peer-card-head">
        <span className="peer-card-dir" title={thread.origin === "peer" ? "von der Gegenseite" : "von dieser Seite"}>
          {thread.origin === "peer" ? "←" : "→"}
        </span>
        <span className="peer-card-title">{thread.title}</span>
        <span className="peer-card-state">{STATE_LABEL[thread.state]}</span>
      </div>

      <div className="peer-card-meta">
        {thread.id}
        {thread.kind === "contract_change" ? " · Contract-Änderung" : " · Anfrage"}
        {thread.breaking ? " · BREAKING" : ""}
        {thread.branch ? ` · ${thread.branch}` : ""}
        {thread.ownerAgentId ? " · wird bearbeitet" : ""}
        {thread.hops > 0 ? ` · ${thread.hops} Runde(n)` : ""}
      </div>

      {thread.delta && <div className="peer-card-files">Betroffen: {describeDelta(thread.delta)}</div>}

      {thread.origin === "peer" && thread.kind === "contract_change" && !thread.peerLanded && (
        <div className="peer-card-warn">
          Die Gegenseite hat ihre Änderung noch nicht auf <code>main</code> — landet diese Seite zuerst, läuft sie
          gegen eine Schnittstelle, die es dort noch nicht gibt.
        </div>
      )}

      {brief && !closed && (
        <details className="peer-card-brief">
          <summary>Auftrag für den Abgleich-Stream</summary>
          <pre>{brief}</pre>
        </details>
      )}

      {thread.delta?.diff && (
        <div className="peer-card-diff">
          <button className="peer-card-link" onClick={() => setShowDiff((v) => !v)}>
            {showDiff ? "Diff verbergen" : "Diff ansehen"}
            {thread.delta.truncated ? " (gekürzt)" : ""}
          </button>
          {showDiff && <pre>{thread.delta.diff}</pre>}
        </div>
      )}

      {thread.log.length > 0 && (
        <ul className="peer-card-log">
          {thread.log.slice(-4).map((l, i) => (
            <li key={i} className={`who-${l.who}`}>
              <span className="peer-card-who">{l.who === "peer" ? "Gegenseite" : l.who === "human" ? "du" : "hier"}</span>
              {l.text}
            </li>
          ))}
        </ul>
      )}

      <div className="peer-card-actions">
        {canStart && (
          <button className="primary" onClick={() => void startPeerThread(thread.id)}>
            Abgleich-Stream starten
          </button>
        )}
        {!closed && (
          <>
            <button onClick={() => void peerThreadAction(thread.id, "decline", "Auf dieser Seite nicht nötig.")}>
              Ablehnen
            </button>
            <button onClick={() => void peerThreadAction(thread.id, "resolve")}>Erledigt</button>
          </>
        )}
        {drift && thread.origin === "peer" && !closed && (
          <button
            title="Den Stand der Gegenseite bewusst übernehmen, ohne hier etwas zu bauen. Wird im Protokoll festgehalten."
            onClick={() => void peerThreadAction(thread.id, "accept_drift", "Bewusst akzeptiert.")}
          >
            Drift akzeptieren
          </button>
        )}
      </div>

      {!closed && (
        <form
          className="peer-card-reply"
          onSubmit={(e) => {
            e.preventDefault();
            const text = reply.trim();
            if (!text) return;
            void peerSend(text, thread.id);
            setReply("");
          }}
        >
          <input
            type="text"
            value={reply}
            placeholder="Rückfrage an die Gegenseite…"
            onChange={(e) => setReply(e.target.value)}
          />
          <button type="submit" disabled={!reply.trim()}>
            Senden
          </button>
        </form>
      )}
    </div>
  );
}
