import { useMemo, useState } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useStore } from "../store";
import { TOOLBAR_ITEMS, type ToolbarItem } from "../toolbarItems";
import { ActivityRailItem } from "./ActivityRailItem";
import { ConfirmDialog } from "./ConfirmDialog";
import { RecentProjectsPopover } from "./RecentProjectsPopover";
import { ModelEffortPicker } from "./ModelEffortPicker";
import { conflictCount } from "../derive";

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
  const defaultModel = useStore((s) => s.defaultModel);
  const defaultEffort = useStore((s) => s.defaultEffort);
  const setDefaultModel = useStore((s) => s.setDefaultModel);
  const setDefaultEffort = useStore((s) => s.setDefaultEffort);
  const accounts = useStore((s) => s.accounts);
  const accountUsage = useStore((s) => s.accountUsage);
  const setDefaultAccount = useStore((s) => s.setDefaultAccount);
  const [projectOpen, setProjectOpen] = useState(false);

  // Badges/Enabled lesen denselben Store-State über memoisierte Selektoren (§3.3).
  const escalationsLen = useStore((s) => s.escalations.length);
  const collisionsLen = useStore((s) => s.collisions.length);
  const hasProject = useStore((s) => !!s.project);

  // „Don't Panic": Zähler + Zustand für den übergreifenden Konflikt-Knopf.
  const agents = useStore((s) => s.agents);
  const order = useStore((s) => s.order);
  const escalations = useStore((s) => s.escalations);
  const panic = useStore((s) => s.panic);
  const panicResolve = useStore((s) => s.panicResolve);
  const panicRelease = useStore((s) => s.panicRelease);
  const [panicConfirm, setPanicConfirm] = useState<"resolve" | "release" | null>(null);
  const conflicts = useMemo(
    () => conflictCount(order.map((id) => agents[id]).filter(Boolean), escalations),
    [agents, order, escalations],
  );
  // Wie viele Sub-Streams würde das Anhalten treffen (für den Bestätigungstext).
  const subCount = useMemo(
    () => order.map((id) => agents[id]).filter((a) => a && a.role === "sub" && a.live !== false).length,
    [agents, order],
  );

  function badgeFor(item: ToolbarItem): number | "dot" | undefined {
    if (item.id === "streams") return escalationsLen || undefined;
    if (item.id === "changes") return collisionsLen || undefined;
    // Im Panic-Zustand zeigt der Eintrag die Freigabe — dann ist die Konfliktzahl irreführend,
    // stattdessen ein Punkt als „hier ist noch etwas offen"-Marker.
    if (item.id === "panic") return panic.active ? "dot" : conflicts || undefined;
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
      case "panic":
        // Beide Richtungen sind bestätigungspflichtig: Anhalten unterbricht laufende Arbeit,
        // Freigeben lässt Streams auf einer Basis weiterlaufen, die sich geändert hat.
        setPanicConfirm(panic.active ? "release" : "resolve");
        return;
      default:
        if (item.kind === "panel" && item.view) setActiveView(item.view);
    }
  }

  const sorted = [...TOOLBAR_ITEMS].sort((a, b) => a.order - b.order);
  const top = sorted.filter((i) => (i.group ?? "top") === "top");
  const bottom = sorted.filter((i) => i.group === "bottom");

  const renderItem = (item: ToolbarItem) => {
    // Der Panic-Eintrag wechselt im aktiven Zustand seine Bedeutung: aus „anhalten und lösen"
    // wird „wieder freigeben". Ein Eintrag statt zweier, damit die Rail nicht wächst und der
    // Zustand an genau einer Stelle ablesbar bleibt.
    const shown =
      item.id === "panic" && panic.active
        ? {
            ...item,
            label: "Streams fortsetzen",
            tooltip:
              `${panic.stoppedAgentIds.length === 1 ? "Ein Stream ist" : `${panic.stoppedAgentIds.length} Streams sind`} ` +
              "wegen einer Konfliktlösung angehalten.\n\n" +
              "Freigeben stellt den vorherigen Autopilot-Level wieder her und lässt sie weiterarbeiten.\n\n" +
              "Lies vorher den Bericht des Main-Agenten: hat sich die Basis geändert, arbeiten die Streams " +
              "sonst auf einem Stand weiter, den sie nicht mitbekommen haben.",
          }
        : item;
    return (
      <div key={item.id} className={`rail-item-wrap${item.id === "panic" ? " panic" : ""}`}>
        {item.separatorBefore && <div className="rail-sep" />}
        <ActivityRailItem
          item={shown}
          active={activeFor(item)}
          collapsed={railCollapsed}
          badge={badgeFor(item)}
          disabled={!enabledFor(item)}
          onActivate={() => activate(item)}
        />
      </div>
    );
  };

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
            <div className="brand-tag">Multi Agent Design Studio</div>
          </div>
        )}
      </div>

      <div className="rail-group rail-top">{top.map(renderItem)}</div>

      {/* Globaler Modell-/Effort-Default (gilt für NEU eröffnete Streams). Nur im
          ausgeklappten Zustand — im Icon-Modus fehlt die Breite für Dropdowns. */}
      {!railCollapsed && (
        <div className="rail-modeleffort">
          <div className="rail-me-label">Modell &amp; Effort · Default</div>
          <ModelEffortPicker
            model={defaultModel}
            effort={defaultEffort}
            onModel={setDefaultModel}
            onEffort={setDefaultEffort}
            variant="rail"
          />
        </div>
      )}

      {/* Globales Standard-Konto (gilt für NEU eröffnete Streams). Ohne diese Stelle liesse sich
          der Default gar nicht ändern — neue Streams landeten dann immer auf dem Konto, das gerade
          in der Registry stand, auch wenn dessen Kontingent längst erschöpft ist. */}
      {!railCollapsed && accounts && accounts.profiles.length > 1 && (
        <div className="rail-modeleffort">
          <div className="rail-me-label">Konto · Default</div>
          <select
            className="mode-select rail-account"
            value={accounts.activeId}
            onChange={(e) => void setDefaultAccount(e.target.value)}
            title="Claude-Konto für neu eröffnete Streams. Laufende Streams bleiben, wo sie sind."
          >
            {accounts.profiles.map((p) => {
              const cd = accounts.cooldowns[p.id];
              const blocked = !!cd && cd.rejected && cd.until > Date.now();
              const use = accountUsage[p.id];
              const vals = [use?.fiveHour?.utilization, use?.sevenDay?.utilization].filter(
                (v): v is number => v !== undefined,
              );
              const worst = vals.length ? Math.round(Math.max(...vals)) : undefined;
              return (
                <option key={p.id} value={p.id} title={p.email ?? p.configDir}>
                  {p.label}
                  {blocked ? " — Limit" : worst !== undefined ? ` — ${worst}%` : ""}
                </option>
              );
            })}
          </select>
        </div>
      )}

      <div className="rail-group rail-bottom">{bottom.map(renderItem)}</div>

      {/* Popover auf nav-Ebene rendern (NICHT in .rail-top — dessen overflow-y:auto klippt
          das absolut positionierte Popover weg → war unsichtbar). Vertikal beim Projekt-Eintrag. */}
      <RecentProjectsPopover open={projectOpen} onClose={() => setProjectOpen(false)} />

      {panicConfirm === "resolve" && (
        <ConfirmDialog
          title="Alle Streams anhalten und Konflikt lösen?"
          danger
          confirmLabel="Anhalten und lösen"
          body={
            <>
              <p>
                {subCount === 1 ? "Der Sub-Stream wird" : `Alle ${subCount} Sub-Streams werden`} angehalten und ihr
                Autopilot auf „manuell" gesetzt, damit sich während der Auflösung nichts mehr verschiebt.
                Angefangene Arbeit bleibt erhalten — nichts wird verworfen.
              </p>
              <p>
                Danach übernimmt der <strong>Main-Agent</strong>: er ist der einzige Stream, der alle Worktrees sieht
                und die Branches gegeneinander prüfen kann. Er misst zuerst, sichert jeden Branch und löst dann auf.
              </p>
              <p>
                <strong>Ohne Rückfrage wird nichts nach main gemergt.</strong> Die Streams startest du danach selbst
                wieder.
              </p>
            </>
          }
          onConfirm={() => {
            void panicResolve();
            setPanicConfirm(null);
          }}
          onClose={() => setPanicConfirm(null)}
        />
      )}

      {panicConfirm === "release" && (
        <ConfirmDialog
          title="Angehaltene Streams wieder freigeben?"
          confirmLabel="Freigeben"
          body={
            <>
              <p>
                {panic.stoppedAgentIds.length === 1
                  ? "Ein Stream bekommt"
                  : `${panic.stoppedAgentIds.length} Streams bekommen`}{" "}
                den vorherigen Autopilot-Level zurück und arbeiten weiter.
              </p>
              <p>
                Prüfe vorher den Bericht des Main-Agenten: hat sich die Basis geändert, arbeiten die Streams sonst auf
                einem Stand weiter, den sie nicht mitbekommen haben.
              </p>
            </>
          }
          onConfirm={() => {
            void panicRelease();
            setPanicConfirm(null);
          }}
          onClose={() => setPanicConfirm(null)}
        />
      )}

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
