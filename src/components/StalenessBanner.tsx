import { useStore } from "../store";

/**
 * Konsolidiertes „Hinter GitHub"-Banner. Erscheint, sobald der Projekt-Default-Branch
 * (reconcileSummary.mainBehind) und/oder offene Sub-Streams (agent.behind) lokal hinter
 * origin liegen — und bietet „Alle aktualisieren" (main fast-forward + Sub-Rebase onto
 * origin). So entspricht der lokale Stand aller offenen Branches wieder GitHub.
 * Reine UI: liest abgeleiteten State, ruft nur Store-Aktionen.
 */
export function StalenessBanner() {
  const agents = useStore((s) => s.agents);
  const order = useStore((s) => s.order);
  const reconcileSummary = useStore((s) => s.reconcileSummary);
  const project = useStore((s) => s.project);
  const syncAllBehind = useStore((s) => s.syncAllBehind);

  const list = order.map((id) => agents[id]).filter(Boolean);
  const behindSubs = list.filter((a) => a.role === "sub" && a.behind > 0 && a.live !== false);
  const mainBehind = (reconcileSummary?.mainBehind ?? 0) > 0;
  if (!mainBehind && behindSubs.length === 0) return null;

  const parts: string[] = [];
  if (mainBehind) parts.push(`${project?.defaultBranch ?? "main"} (${reconcileSummary?.mainBehind})`);
  if (behindSubs.length > 0) parts.push(`${behindSubs.length} Stream${behindSubs.length === 1 ? "" : "s"}`);

  return (
    <div className="staleness-banner">
      <span className="staleness-text">
        ⟳ Lokal hinter GitHub: {parts.join(" · ")} — nicht auf dem origin-Stand.
      </span>
      <button
        className="staleness-sync"
        title="Default-Branch per fast-forward nachziehen + hinterherhängende Sub-Streams onto origin rebasen"
        onClick={() => void syncAllBehind()}
      >
        Alle aktualisieren
      </button>
    </div>
  );
}
