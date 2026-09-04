import { useStore } from "../store";
import { pendingThreads } from "../../shared/link";

/**
 * Verbund-Pille in der Titelleiste (docs/design/12-project-link.md §9).
 *
 * Beantwortet auf einen Blick die drei Fragen, die beim Arbeiten mit zwei gekoppelten Repos
 * wirklich zählen: Ist die Gegenseite offen? Kennt sie meinen Stand (bzw. ich ihren)? Wartet
 * etwas auf mich? Klick öffnet die Einstellungen mit dem Verbund-Abschnitt.
 *
 * Reiner Spiegel von `link_status` — die Pille rechnet nichts selbst aus.
 */
export function LinkPill() {
  const link = useStore((s) => s.link);
  const setActiveView = useStore((s) => s.setActiveView);
  if (!link || link.state === "none") return null;

  const peerName = link.config?.peer.label?.trim() || link.peer?.slug || "Gegenseite";
  const waiting = pendingThreads(link.threads).length;
  const drift = link.contract.drift;

  let tone: "ok" | "warn" | "off" = "ok";
  let text = `${peerName} · Contract synchron`;
  let title = `Projekt-Verbund mit ${peerName}: beide Seiten kennen denselben Contract-Stand.`;

  if (link.state === "pending") {
    tone = "off";
    text = `${peerName} · wartet`;
    title = link.hint ?? "Die Gegenseite hat den Verbund noch nicht eingerichtet.";
  } else if (link.state === "peer_offline") {
    tone = "off";
    text = `${peerName} · offline${link.queued ? ` · ${link.queued} wartend` : ""}`;
    title = "Die Gegenseite ist gerade nicht geöffnet. Nachrichten warten in ihrem Eingang — es geht nichts verloren.";
  } else if (drift) {
    tone = "warn";
    text = `${peerName} · Contract-Drift`;
    title = "Die Gegenseite hat ihren Contract geändert, ohne dass hier ein Abgleich läuft. Im Verbund-Tab entscheiden.";
  }

  return (
    <button
      className={`pill link ${tone}`}
      title={title}
      onClick={() => setActiveView("settings")}
    >
      ⇄ {text}
      {waiting > 0 && <span className="pill-badge">{waiting}</span>}
    </button>
  );
}
