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
  const BADGE_NOUN: Record<string, string> = { streams: "Eskalationen", changes: "Kollisionen", panic: "Streams in Konflikt" };
  const labelWithBadge = hasCountBadge
    ? `${item.label} (${badge} ${BADGE_NOUN[item.id] ?? "Hinweise"})`
    : item.label;
  // `tooltip` gewinnt und greift IMMER — auch ausgeklappt. Für Einträge wie „Don't Panic", deren
  // Label bewusst nicht beschreibt, was passiert. Im eingeklappten Zustand wird der Name
  // vorangestellt, weil dort nur das Icon zu sehen ist.
  const title = disabled
    ? "Erst ein Projekt öffnen"
    : item.tooltip
      ? collapsed
        ? `${labelWithBadge}\n\n${item.tooltip}`
        : item.tooltip
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
          <span
            className={`rail-badge${badge === "dot" ? " dot" : ""}${item.id === "streams" || item.id === "panic" ? " red" : ""}`}
          >
            {badgeText}
          </span>
        )}
      </span>
      {!collapsed && <span className="rail-label">{item.label}</span>}
      {!collapsed && item.shortcut && <span className="rail-shortcut">{item.shortcut}</span>}
    </button>
  );
}
