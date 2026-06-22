import { useState } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useStore } from "../store";
import { TOOLBAR_ITEMS, type ToolbarItem } from "../toolbarItems";
import { ActivityRailItem } from "./ActivityRailItem";
import { RecentProjectsPopover } from "./RecentProjectsPopover";

/**
 * Activity-Rail (Navigations-Toolbar) — die äußerste Leiste links
 * (docs/design/10-navigation-toolbar.md §2.1). Rendert die TOOLBAR_ITEMS-Registry;
 * mads-Logo-Kopf (→ About); Kollaps-Toggle. Mappt Klick auf
 * setActiveView / Aktion / Popover. Reines UI — kein IPC/FS.
 *
 * Absorbiert Brand/About/Neuer-Stream der aufgelösten `Sidebar.tsx` (§1a.3).
 */
export function ActivityRail({ onNewStream, onAbout }: { onNewStream: () => void; onAbout: () => void }) {
  const activeView = useStore((s) => s.activeView);
  const railCollapsed = useStore((s) => s.railCollapsed);
  const changeOverviewOn = useStore((s) => s.changeOverviewOn);
  const setActiveView = useStore((s) => s.setActiveView);
  const toggleRailCollapsed = useStore((s) => s.toggleRailCollapsed);
  const toggleChangeOverview = useStore((s) => s.toggleChangeOverview);
  const [projectOpen, setProjectOpen] = useState(false);

  // Badges/Enabled lesen denselben Store-State über memoisierte Selektoren (§3.3).
  const escalationsLen = useStore((s) => s.escalations.length);
  const collisionsLen = useStore((s) => s.collisions.length);
  const hasProject = useStore((s) => !!s.project);

  function badgeFor(item: ToolbarItem): number | "dot" | undefined {
    if (item.id === "streams") return escalationsLen || undefined;
    if (item.id === "changes") return collisionsLen || undefined;
    return undefined;
  }
  function enabledFor(item: ToolbarItem): boolean {
    if (item.id === "files" || item.id === "changes") return hasProject;
    return true;
  }
  function activeFor(item: ToolbarItem): boolean {
    if (item.kind === "panel") return activeView === item.view;
    if (item.id === "changes") return changeOverviewOn; // Toggle, an changeOverviewOn gebunden (§2.3)
    return false;
  }
  function activate(item: ToolbarItem) {
    switch (item.id) {
      case "project":
        setProjectOpen((v) => !v);
        return;
      case "new":
        onNewStream();
        return;
      case "about":
        onAbout();
        return;
      case "changes":
        toggleChangeOverview();
        return;
      default:
        if (item.kind === "panel" && item.view) setActiveView(item.view);
    }
  }

  const sorted = [...TOOLBAR_ITEMS].sort((a, b) => a.order - b.order);
  const top = sorted.filter((i) => (i.group ?? "top") === "top");
  const bottom = sorted.filter((i) => i.group === "bottom");

  const renderItem = (item: ToolbarItem) => (
    <div key={item.id} className="rail-item-wrap">
      {item.separatorBefore && <div className="rail-sep" />}
      <ActivityRailItem
        item={item}
        active={activeFor(item)}
        collapsed={railCollapsed}
        badge={badgeFor(item)}
        disabled={!enabledFor(item)}
        onActivate={() => activate(item)}
      />
      {item.id === "project" && <RecentProjectsPopover open={projectOpen} onClose={() => setProjectOpen(false)} />}
    </div>
  );

  return (
    <nav
      className={`activity-rail${railCollapsed ? " collapsed" : ""}`}
      aria-label="Hauptnavigation"
      data-tauri-drag-region
    >
      <div
        className="rail-brand"
        onClick={onAbout}
        title="Über mads"
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onAbout();
        }}
      >
        <img className="brand-logo" src="/mads-logo.png" alt="mads" />
        {!railCollapsed && (
          <div className="brand-text">
            <div className="brand-name">mads</div>
            <div className="brand-tag">multi-agent surface</div>
          </div>
        )}
      </div>

      <div className="rail-group rail-top">{top.map(renderItem)}</div>
      <div className="rail-group rail-bottom">{bottom.map(renderItem)}</div>

      <button
        type="button"
        className="rail-collapse"
        onClick={toggleRailCollapsed}
        title={railCollapsed ? "Navigation einblenden (⌃⌘B)" : "Navigation ausblenden (⌃⌘B)"}
        aria-label={railCollapsed ? "Navigation einblenden" : "Navigation ausblenden"}
      >
        {railCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        {!railCollapsed && <span className="rail-label">Einklappen</span>}
      </button>
    </nav>
  );
}
