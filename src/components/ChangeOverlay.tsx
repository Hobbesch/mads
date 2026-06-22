import { useStore } from "../store";

/**
 * Change-Overview-Overlay (docs/design/09-change-overview.md §2.1) — Stub.
 *
 * position:fixed über `.app`, gesteuert vom `changeOverviewOn`-Toggle (NICHT activeView,
 * doc 10 §2.3 / LAYOUT-CONTRACT (g)). Self-hides bei !changeOverviewOn. Feature 09 füllt
 * die Diff-Panes; hier nur der Slot + Schließen, damit der Rail-Toggle „Änderungen" baut.
 */
export function ChangeOverlay() {
  const changeOverviewOn = useStore((s) => s.changeOverviewOn);
  const toggle = useStore((s) => s.toggleChangeOverview);

  if (!changeOverviewOn) return null;

  return (
    <div className="change-overlay" role="dialog" aria-label="Änderungen">
      <div className="change-overlay-head">
        <span>Änderungen</span>
        <button className="change-overlay-close" onClick={toggle} title="Schließen (⇧⌘D)" aria-label="Änderungen schließen">
          ✕
        </button>
      </div>
      <div className="change-overlay-body">
        {/* TODO(Post-MVP): Diff-Panes je Stream (docs/design/09-change-overview.md). */}
        Change-Overview folgt mit Feature 09.
      </div>
    </div>
  );
}
