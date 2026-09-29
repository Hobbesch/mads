import { useEffect, useState } from "react";
import { useStore } from "../store";
import { RemotePairing } from "./RemotePairing";
import { LinkSettings } from "./LinkSettings";
import type { InvestigationTarget } from "../../shared/protocol";

/**
 * Primary-Panel für activeView === "settings" (docs/design/10-navigation-toolbar.md §2.1).
 * Konsolidiert die Autonomie-Toggles (OE-52) + das Remote-Pairing (iOS-App). Erweiterbar
 * um Permission-Defaults/Modelle (Post-MVP).
 */
export function SettingsPanel() {
  const project = useStore((s) => s.project);
  const autonomy = useStore((s) => s.autonomy);
  const setAutonomy = useStore((s) => s.setAutonomy);
  const reloginClaude = useStore((s) => s.reloginClaude);
  const checkAuthStatus = useStore((s) => s.checkAuthStatus);
  const accounts = useStore((s) => s.accounts);
  const authReloginAccountId = useStore((s) => s.authReloginAccountId);
  const [authStatus, setAuthStatus] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  // Anmeldung ist PRO KONTO (eigener Schlüsselbund-Eintrag je `CLAUDE_CONFIG_DIR`). Vorbelegt
  // ist das Konto, dessen Auth gerade scheiterte, sonst das aktive — so trifft ein Klick ohne
  // weitere Auswahl das richtige Konto.
  const [pick, setPick] = useState<string>("");
  const profiles = accounts?.profiles ?? [];
  const targetId = pick || authReloginAccountId || accounts?.activeId || "";

  async function onCheckAuth() {
    setChecking(true);
    try {
      setAuthStatus(await checkAuthStatus(targetId || undefined));
    } catch (e) {
      setAuthStatus(`Status konnte nicht ermittelt werden: ${String(e)}`);
    } finally {
      setChecking(false);
    }
  }

  return (
    <section className="primary-panel settings-panel" aria-label="Einstellungen">
      <header className="primary-panel-head">Einstellungen</header>
      <div className="settings-body">
        <div className="settings-group">
          <div className="settings-group-title">Autonomie</div>
          {!project && <div className="settings-hint">Erst ein Projekt öffnen, um Autonomie-Optionen zu setzen.</div>}
          <label className="settings-row">
            <input
              type="checkbox"
              checked={autonomy.autoSync}
              disabled={!project}
              onChange={() => void setAutonomy({ ...autonomy, autoSync: !autonomy.autoSync })}
            />
            <span>
              <span className="settings-row-label">Auto-Sync</span>
              <span className="settings-row-sub">Sub-Branches automatisch onto origin/main rebasen</span>
            </span>
          </label>
          <label className="settings-row">
            <input
              type="checkbox"
              checked={autonomy.collisionScan}
              disabled={!project}
              onChange={() => void setAutonomy({ ...autonomy, collisionScan: !autonomy.collisionScan })}
            />
            <span>
              <span className="settings-row-label">Kollisions-Scan</span>
              <span className="settings-row-sub">Code-Kollisionen zwischen aktiven Agenten erkennen</span>
            </span>
          </label>
        </div>
        <ModelCatalogSettings />
        <div className="settings-group">
          <div className="settings-group-title">Anthropic-Login</div>
          <div className="settings-hint">
            mads nutzt deine bestehende Claude-Anmeldung (macOS-Schlüsselbund) und speichert selbst kein
            Token. Jedes Konto hat einen EIGENEN Anmelde-Eintrag (eigenes Config-Verzeichnis) — Anmeldung
            und Status gelten deshalb immer für das hier gewählte Konto. Auth-Fehler sind oft vorübergehend
            (erneut senden genügt); bei dauerhaftem „Authentifizierung fehlgeschlagen" hier neu anmelden —
            es öffnet sich ein Terminal mit dem Browser-Login. Danach den Stream erneut senden (kein
            Neustart nötig).
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
            {profiles.length > 1 && (
              <select
                value={targetId}
                onChange={(e) => setPick(e.target.value)}
                title="Konto, für das Anmeldung und Status gelten"
                aria-label="Claude-Konto"
              >
                {profiles.map((p) => (
                  <option key={p.id} value={p.id} title={p.email ?? p.configDir}>
                    {p.email ? `${p.label} · ${p.email}` : p.label}
                  </option>
                ))}
              </select>
            )}
            <button
              onClick={() => void reloginClaude(targetId || undefined)}
              title="Öffnet ein Terminal mit dem Browser-Login (claude auth login) für das gewählte Konto — mit dessen Config-Verzeichnis"
            >
              Bei Claude neu anmelden
            </button>
            <button onClick={() => void onCheckAuth()} disabled={checking}>
              {checking ? "Prüfe…" : "Status prüfen"}
            </button>
          </div>
          {authStatus !== null && (
            <pre
              style={{
                marginTop: 8,
                padding: "8px 10px",
                borderRadius: 6,
                fontSize: 12,
                lineHeight: 1.4,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                opacity: 0.85,
                background: "rgba(127,127,127,0.12)",
              }}
            >
              {authStatus}
            </pre>
          )}
        </div>
        <InvestigationTargetsEditor />
        <LinkSettings />
        <RemotePairing />
        {/* TODO(Post-MVP): Permission-Defaults, Update-Kanal (doc 10 §10). */}
      </div>
    </section>
  );
}

/**
 * Woher die Modell-Auswahl stammt — und ein Knopf, sie neu zu erheben.
 *
 * Sichtbar zu machen, WAS geprüft wurde, ist hier kein Beiwerk: die Auswahl kann aus drei sehr
 * unterschiedlichen Quellen kommen (frisch bei Anthropic geprüft / letzter bekannter Stand / nur
 * die eingebaute Liste). Ohne diese Zeile wäre für den Nutzer nicht unterscheidbar, ob ein Modell
 * fehlt, weil Anthropic es nicht anbietet, oder weil mads gar nicht nachfragen konnte.
 */
function ModelCatalogSettings() {
  const catalog = useStore((s) => s.modelCatalog);
  const busy = useStore((s) => s.modelCheckBusy);
  const refresh = useStore((s) => s.refreshModels);
  const stale = catalog.models.filter((m) => m.cliKnown === false);
  const label =
    catalog.status === "live"
      ? "bei Anthropic geprüft"
      : catalog.status === "local"
        ? "gegen die lokale Claude-Code-Version geprüft"
        : catalog.status === "cache"
          ? "zuletzt bekannter Stand"
          : "eingebaute Liste (noch nicht geprüft)";

  return (
    <div className="settings-group">
      <div className="settings-group-title">Modelle</div>
      <div className="settings-hint">
        mads prüft beim Start, welche Modelle Anthropic für dein Konto anbietet und welche die
        gebündelte Claude-Code-Version unterstützt. Die Einträge „· neustes" (Opus, Sonnet, …) lösen
        bei jedem Stream-Start selbst auf die neuste Generation auf und veralten nie.
      </div>
      <div className="settings-hint" style={{ marginTop: 6 }}>
        <strong>{catalog.models.length} wählbar</strong> · {label}
        {catalog.checkedAt ? ` · ${new Date(catalog.checkedAt).toLocaleString("de-CH")}` : ""}
        {catalog.note ? ` · ${catalog.note}` : ""}
      </div>
      {stale.length > 0 && (
        <div className="settings-hint" style={{ marginTop: 6 }}>
          Nicht nutzbar mit der gebündelten Claude-Code-Version {catalog.cliVersion ?? ""}:{" "}
          {stale.map((m) => m.label).join(", ")}. Die API weist sie ab — Agent-SDK aktualisieren
          (<code>npm --prefix sidecar install</code>), mads neu starten, dann erneut prüfen.
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button
          disabled={busy}
          title="Modell-Liste jetzt neu bei Anthropic und gegen die lokale Claude-Code-Version prüfen"
          onClick={() => refresh(true)}
        >
          {busy ? "Prüfe…" : "Jetzt prüfen"}
        </button>
      </div>
    </div>
  );
}

/**
 * Untersuchungsziele des Projekts (Sandbox-Stufe A): externe Hosts, die ein Sub-Stream im
 * Untersuchungs-Modus (🔎) zusätzlich zur normalen Egress-Allowlist erreichen darf. Der Sidecar
 * ist die Wahrheit (.mads/targets.json, targets_update) — hier wird nur ein Entwurf editiert und
 * als Ganzes gespeichert (der Sidecar validiert Host-Form/Limits und spiegelt zurück).
 */
function InvestigationTargetsEditor() {
  const project = useStore((s) => s.project);
  const targets = useStore((s) => s.investigationTargets);
  const saveTargets = useStore((s) => s.saveInvestigationTargets);
  const [draft, setDraft] = useState<InvestigationTarget[]>(targets);
  const [dirty, setDirty] = useState(false);
  // Sidecar-Spiegel übernehmen, solange lokal nichts Ungespeichertes liegt (SSOT bleibt der Sidecar).
  useEffect(() => {
    if (!dirty) setDraft(targets);
  }, [targets, dirty]);

  const patch = (i: number, p: Partial<InvestigationTarget>) => {
    setDraft((d) => d.map((t, j) => (j === i ? { ...t, ...p } : t)));
    setDirty(true);
  };

  return (
    <div className="settings-group">
      <div className="settings-group-title">Untersuchungsziele (Sandbox)</div>
      <div className="settings-hint">
        Externe Hosts (Test-/Prod-APIs), die ein Sub-Stream im <strong>Untersuchungs-Modus 🔎</strong> zusätzlich
        erreichen darf — die Sandbox bleibt dabei aktiv. Nur Host/Domain (Wildcards wie <code>*.example.ch</code>{" "}
        erlaubt), keine Pfade/Ports. Als „Prod" markierte Ziele verlangen beim Freischalten eine deutlichere
        Bestätigung.
      </div>
      {!project && <div className="settings-hint">Erst ein Projekt öffnen — die Ziele gelten pro Projekt.</div>}
      {draft.map((t, i) => (
        <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
          <input
            type="text"
            value={t.host}
            placeholder="api.test.example.ch"
            style={{ flex: 2 }}
            onChange={(e) => patch(i, { host: e.target.value })}
          />
          <input
            type="text"
            value={t.label ?? ""}
            placeholder="Label (optional)"
            style={{ flex: 1 }}
            onChange={(e) => patch(i, { label: e.target.value || undefined })}
          />
          <label style={{ display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }} title="Produktions-Ziel — verlangt beim Freischalten eine deutlichere Bestätigung">
            <input type="checkbox" checked={!!t.prod} onChange={(e) => patch(i, { prod: e.target.checked || undefined })} />
            Prod
          </label>
          <button
            title="Ziel entfernen"
            onClick={() => {
              setDraft((d) => d.filter((_, j) => j !== i));
              setDirty(true);
            }}
          >
            ✕
          </button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button
          disabled={!project}
          onClick={() => {
            setDraft((d) => [...d, { host: "" }]);
            setDirty(true);
          }}
        >
          + Ziel hinzufügen
        </button>
        <button
          disabled={!project || !dirty}
          title="Liste speichern — der Sidecar validiert die Host-Form und bestätigt den Stand"
          onClick={() => {
            void saveTargets(draft.filter((t) => t.host.trim().length > 0));
            setDirty(false);
          }}
        >
          Speichern
        </button>
      </div>
    </div>
  );
}
