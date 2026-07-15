import { useEffect, useMemo, useState } from "react";
import { useStore, editKey, MAX_VISIBLE_PANES, type FileEditEntry } from "../store";
import { DiffPane, type PaneVM } from "./DiffPane";
import type { Collision } from "../../shared/collision";

/**
 * Change-Overview-Overlay (docs/design/09-change-overview.md §1/§2).
 *
 * `position: fixed`-Overlay über `.app` (OE-41, ein Fenster — KEINE OS-Fenster), gesteuert vom
 * `changeOverviewOn`-Toggle (NICHT activeView, doc 10 §2.3). Auto-öffnet eine Diff-Pane pro Datei,
 * die ein Stream gerade editiert (aus `editsByFile`, rein Frontend-derived). Gruppiert nach Stream,
 * Farbcode via StatusDot/STATUS_META. Zweiter Toggle / ✕ / ⎋ schließt alle (Overlay unmounten).
 *
 * Read-only (CLAUDE.md: src/ ist reines UI — keine Prozesse/Secrets/git/fs).
 */
export function ChangeOverlay() {
  const changeOverviewOn = useStore((s) => s.changeOverviewOn);
  const toggle = useStore((s) => s.toggleChangeOverview);
  const editsByFile = useStore((s) => s.editsByFile);
  const agents = useStore((s) => s.agents);
  const order = useStore((s) => s.order);
  const collisions = useStore((s) => s.collisions);

  const [filter, setFilter] = useState("");
  const [showAll, setShowAll] = useState(false);

  // ⎋ schließt das Overlay (= Toggle aus, §8). ⇧⌘D bleibt der globale Toggle (App.tsx).
  useEffect(() => {
    if (!changeOverviewOn) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [changeOverviewOn, toggle]);

  // Panes ableiten: gruppiert nach Stream (in `order`-Reihenfolge — Single Source of Truth wie 07),
  // gefiltert nach Datei/Stream, Kollisions-Join auf `path`.
  const allPanes = useMemo<PaneVM[]>(() => {
    const f = filter.trim().toLowerCase();
    const entries = Object.values(editsByFile);
    // Stabile Stream-Gruppierung: erst nach order-Index des Agenten, dann firstEditAt.
    const orderIdx = new Map(order.map((id, i) => [id, i] as const));
    const sorted = entries.slice().sort((a, b) => {
      const ai = orderIdx.get(a.agentId) ?? Number.MAX_SAFE_INTEGER;
      const bi = orderIdx.get(b.agentId) ?? Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return a.firstEditAt - b.firstEditAt;
    });
    return sorted
      .filter((e: FileEditEntry) => {
        if (!f) return true;
        const label = agents[e.agentId]?.label.toLowerCase() ?? "";
        return e.path.toLowerCase().includes(f) || label.includes(f);
      })
      .map((entry) => ({
        key: editKey(entry.agentId, entry.path),
        entry,
        agent: agents[entry.agentId],
        collision: collisions.find((c: Collision) => c.path === entry.path),
      }));
  }, [editsByFile, agents, order, collisions, filter]);

  const visible = showAll ? allPanes : allPanes.slice(0, MAX_VISIBLE_PANES);
  const hidden = allPanes.length - visible.length;

  // Pane-Deckel zusätzlich in debugLog protokollieren (§6 — nie still abschneiden).
  useEffect(() => {
    if (changeOverviewOn && hidden > 0) {
      useStore.setState((s) => ({
        debugLog: [...s.debugLog.slice(-400), `change-overview: ${hidden} Pane(s) ausgeblendet (Deckel ${MAX_VISIBLE_PANES})`],
      }));
    }
  }, [changeOverviewOn, hidden]);

  if (!changeOverviewOn) return null;

  const streamCount = new Set(allPanes.map((p) => p.entry.agentId)).size;

  return (
    <div className="change-overlay" role="dialog" aria-label="Änderungen">
      <div className="change-overlay-head" data-tauri-drag-region>
        <span className="change-overlay-title">
          Änderungen · {allPanes.length} {allPanes.length === 1 ? "Datei" : "Dateien"} · {streamCount}{" "}
          {streamCount === 1 ? "Stream" : "Streams"}
        </span>
        <div className="change-overlay-tools">
          <input
            className="change-overlay-filter"
            type="search"
            placeholder="Filter (Datei/Stream)…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Panes filtern"
          />
          <button
            className="change-overlay-close"
            onClick={toggle}
            title="Schließen (⇧⌘D / ⎋)"
            aria-label="Änderungen schließen"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="change-overlay-aria" aria-live="polite">
        {allPanes.length > 0 ? `${allPanes.length} Datei(en) werden editiert` : ""}
      </div>

      <div className="change-overlay-body">
        {allPanes.length === 0 ? (
          <div className="change-overlay-empty">Keine laufenden Datei-Edits. Sobald ein Stream editiert, erscheint hier ein Live-Diff.</div>
        ) : (
          <>
            <div className="diff-pane-grid">
              {visible.map((pane) => (
                <DiffPane key={pane.key} pane={pane} />
              ))}
            </div>
            {hidden > 0 && (
              <div className="diff-pane-cap" role="status">
                … {hidden} weitere {hidden === 1 ? "Pane" : "Panes"} ausgeblendet (Deckel bei {MAX_VISIBLE_PANES}{" "}
                sichtbaren) —{" "}
                <button className="diff-pane-cap-btn" onClick={() => setShowAll(true)}>
                  Alle anzeigen
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
