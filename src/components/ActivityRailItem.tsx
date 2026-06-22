import type { ToolbarItem } from "../toolbarItems";
import { badgeDisplay } from "../toolbarItems";

/**
 * Ein einzelner Activity-Rail-Eintrag (docs/design/10-navigation-toolbar.md §2.1).
 * Reines UI: Icon (+ Label wenn nicht kollabiert), Tooltip wenn kollabiert, Badge,
 * `aria-current`, `disabled`. Farbe ist NIE alleiniger Träger des Aktiv-Zustands
 * (linker Akzent-Balken via CSS + `aria-current`).
 */
export function ActivityRailItem({
  item,
  active,
  collapsed,
  badge,
  disabled,
  onActivate,
}: {
  item: ToolbarItem;
  active: boolean;
  collapsed: boolean;
  badge?: number | "dot";
  disabled?: boolean;
  onActivate: () => void;
}) {
  const Icon = item.icon;
  const badgeText = badgeDisplay(badge);
  const hasCountBadge = badge !== undefined && badge !== "dot";

  // aria-label: Badge eingebettet, damit VoiceOver es auch kollabiert ansagt (§8).
  const labelWithBadge = hasCountBadge
    ? `${item.label} (${badge} ${item.id === "streams" ? "Eskalationen" : "Kollisionen"})`
    : item.label;
  const title = disabled
    ? "Erst ein Projekt öffnen"
    : collapsed
      ? labelWithBadge + (item.shortcut ? ` · ${item.shortcut}` : "")
      : undefined;

  return (
    <button
      type="button"
      className={`rail-item${active ? " active" : ""}${collapsed ? " collapsed" : ""}`}
      aria-current={active ? "true" : undefined}
      aria-label={labelWithBadge}
      disabled={disabled}
      title={title}
      onClick={onActivate}
    >
      <span className="rail-icon" aria-hidden="true">
        <Icon size={18} strokeWidth={1.75} />
        {badge !== undefined && (
          <span className={`rail-badge${badge === "dot" ? " dot" : ""}${item.id === "streams" ? " red" : ""}`}>
            {badgeText}
          </span>
        )}
      </span>
      {!collapsed && <span className="rail-label">{item.label}</span>}
      {!collapsed && item.shortcut && <span className="rail-shortcut">{item.shortcut}</span>}
    </button>
  );
}
