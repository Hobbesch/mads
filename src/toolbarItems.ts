/**
 * ToolbarItem-Registry — Single Source of Truth der Activity-Rail-Einträge
 * (docs/design/10-navigation-toolbar.md §3.2).
 *
 * Deklarativ: ein künftiges Feature hängt EINE Zeile an (+ ggf. einen ViewId).
 * Kein Code in `ActivityRail` muss sich ändern, um einen Eintrag zu ergänzen.
 *
 * `LucideIcon`/`MadsState` sind `import type` (kein Runtime-Import → keine
 * Import-Cycle store↔toolbarItems, kein lucide-react im reinen Logik-Pfad — die
 * Icon-Werte unten sind echte Komponenten-Referenzen, die Logik-Tests nicht
 * auswerten müssen).
 */
import type { LucideIcon } from "lucide-react";
import { FolderOpen, Plus, Boxes, Files, GitCompare, Settings, Info } from "lucide-react";
import type { ViewId } from "./uiPrefs";
import type { MadsState } from "./store";

export interface ToolbarItem {
  id: string; // stabile id ("streams", "files", …)
  icon: LucideIcon; // lucide-react Icon-Komponente (OE-49)
  label: string; // deutscher Text (aufgeklappt sichtbar)
  order: number; // Sortierung in der Rail
  kind: "panel" | "action" | "popover";
  view?: ViewId; // nur bei kind === "panel"
  group?: "top" | "bottom"; // "bottom" = unten angedockt (Settings/About)
  separatorBefore?: boolean; // optischer Trenner über dem Eintrag
  shortcut?: string; // Anzeige-Hinweis, z.B. "⌘1"
  enabled?: (s: MadsState) => boolean; // z.B. (s) => !!s.project → disabled ohne Projekt
  badge?: (s: MadsState) => number | "dot" | undefined; // z.B. Eskalations-Count
}

export const TOOLBAR_ITEMS: ToolbarItem[] = [
  { id: "project", icon: FolderOpen, label: "Projekt", order: 0, kind: "popover", group: "top" },
  { id: "new", icon: Plus, label: "Neuer Stream", order: 1, kind: "action", group: "top", separatorBefore: true },
  {
    id: "streams",
    icon: Boxes,
    label: "Streams",
    order: 2,
    kind: "panel",
    view: "streams",
    group: "top",
    shortcut: "⌘1",
    // "streams" rendert KEIN Primary-Panel (§1a.5) — der Content (AgentGrid+Inspector) IST die View.
    // Das Badge ist der zentrale Off-Dashboard-Awareness-Anker (§1a.6).
    badge: (s) => s.escalations.length || undefined,
  },
  {
    id: "files",
    icon: Files,
    label: "Dateien",
    order: 3,
    kind: "panel",
    view: "files",
    group: "top",
    shortcut: "⌘2",
    enabled: (s) => !!s.project,
  },
  // „Änderungen" ist ein TOGGLE, kein Panel: es schaltet das ChangeOverlay (changeOverviewOn),
  // nicht activeView (docs/design/09-change-overview.md §1.4/§2.1). Daher kind:"action" + active=changeOverviewOn.
  {
    id: "changes",
    icon: GitCompare,
    label: "Änderungen",
    order: 4,
    kind: "action",
    group: "top",
    shortcut: "⇧⌘D",
    enabled: (s) => !!s.project,
    badge: (s) => s.collisions.length || undefined,
  },
  {
    id: "settings",
    icon: Settings,
    label: "Einstellungen",
    order: 90,
    kind: "panel",
    view: "settings",
    group: "bottom",
    shortcut: "⌘,",
  },
  { id: "about", icon: Info, label: "Über mads", order: 91, kind: "action", group: "bottom" },
];

/** Anzeige-Cap für Badge-Zahlen (>99 → "99+"), Wert bleibt im aria-label/Tooltip (§6). */
export function badgeDisplay(value: number | "dot" | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value === "dot") return "";
  return value > 99 ? "99+" : String(value);
}
