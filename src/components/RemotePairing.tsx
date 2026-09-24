import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Pairing-/Geräte-Verwaltung für die mads-Remote-App (iOS). Zeigt den Bridge-Status, gibt einen
 * einmaligen PIN + QR aus (60 s gültig) und listet gekoppelte Geräte mit Widerruf. Die Geräteliste
 * gehört dem HOST (globale Auth-DB), nicht dem offenen Projekt — eine Kopplung gilt überall.
 * Die Rust-Bridge (src-tauri/src/bridge.rs, auth.rs) folgt dem Schalter hier, der als Datei
 * persistiert wird; `MADS_REMOTE_BRIDGE=1` ist nur noch der Default, solange es die Datei
 * nicht gibt (lib.rs). Der Kommentar behauptete vorher, die Env-Var sei zwingend.
 * Schnittstellen-Vertrag: mads-remote/docs/mads-bridge.md.
 */
type Device = { id: string; name: string; createdAt: number; lastSeen: number | null };
type Status = {
  running: boolean;
  enabled?: boolean;
  port?: number;
  spkiFp?: string;
  project?: string;
  /** IP, über die der mDNS-Daemon zuletzt WIRKLICH annonciert hat (null = nur lokal sichtbar). */
  lanAnnouncedOn?: string | null;
  mdnsError?: string | null;
  mdnsRebuilds?: number;
};
type Pairing = { pin: string; qrSvg: string };

export function RemotePairing() {
  const [status, setStatus] = useState<Status>({ running: false });
  const [devices, setDevices] = useState<Device[]>([]);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Seit wann läuft die Bridge, ohne über die LAN-IP annonciert zu haben? Die erste Ankündigung
   * meldet der Daemon erst Augenblicke nach dem Start — ohne diese Schonfrist blitzte bei jedem
   * Start eine Warnung auf, die sofort wieder verschwindet.
   */
  const [lanSilentSince, setLanSilentSince] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await invoke<Status>("remote_bridge_status"));
      setDevices(await invoke<Device[]>("remote_bridge_list_devices"));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    if (status.running && !status.lanAnnouncedOn) {
      setLanSilentSince((since) => since ?? Date.now());
    } else {
      setLanSilentSince(null);
    }
  }, [status.running, status.lanAnnouncedOn]);

  const toggleEnabled = async (on: boolean) => {
    setError(null);
    try {
      await invoke<boolean>("remote_set_enabled", { on });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    void refresh();
    // Periodisch nachziehen: die Bridge startet/stoppt ASYNCHRON (Bridge-Thread) — so erscheint der
    // Koppeln-Knopf, sobald sie wirklich läuft, ohne dass man das Menü neu öffnen muss.
    const id = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(id);
  }, [refresh]);

  const issuePin = async () => {
    setError(null);
    try {
      setPairing(await invoke<Pairing>("remote_bridge_issue_pin"));
      // PIN läuft serverseitig nach 60 s ab → auch die Anzeige nach 60 s ausblenden.
      window.setTimeout(() => setPairing(null), 60_000);
    } catch (e) {
      setError(String(e));
    }
  };

  const revoke = async (id: string) => {
    setError(null);
    try {
      await invoke("remote_bridge_revoke_device", { id });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const lanSilentTooLong = lanSilentSince !== null && Date.now() - lanSilentSince > 20_000;
  const rebuilds = status.mdnsRebuilds ?? 0;
  const rebuiltSuffix =
    rebuilds > 0 ? ` — ${rebuilds === 1 ? "einmal" : `${rebuilds}-mal`} neu aufgebaut` : "";
  const lanReachHint = status.lanAnnouncedOn
    ? `Im WLAN auffindbar über ${status.lanAnnouncedOn}${rebuiltSuffix}.`
    : lanSilentTooLong
      ? `Läuft, ist im WLAN aber NICHT auffindbar — die Ankündigung erreicht nur diesen Mac. Sie wird automatisch neu aufgebaut${rebuiltSuffix}.`
      : "Ankündigung im WLAN wird geprüft …";
  const lanReachHintClass = `settings-hint${lanSilentTooLong ? " remote-pair-error" : ""}`;

  return (
    <div className="settings-group">
      <div className="settings-group-title">Remote (iOS-App)</div>

      <label className="settings-row" style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={status.enabled ?? false}
          onChange={(e) => void toggleEnabled(e.target.checked)}
        />
        <span>Remote aktivieren</span>
      </label>

      <div className="settings-hint">
        {!status.enabled
          ? "Aus. Aktivieren, damit die iOS-App dieses Projekt im WLAN spiegeln/fernsteuern kann."
          : status.running
            ? `Aktiv für ${status.project ?? "dieses Projekt"} (Port ${status.port}). Mehrere Projekte parallel möglich — eine Kopplung gilt für alle.`
            : status.project
              ? `Bridge startet für ${status.project} …`
              : "Aktiviert, aber noch kein Projekt offen. Öffne ein Projekt, dann läuft die Bridge dafür."}
      </div>

      {/*
        „Läuft" und „im WLAN auffindbar" sind NICHT dasselbe: der mDNS-Daemon kann die
        WLAN-Schnittstelle verlieren und dann nur noch auf Loopback annoncieren — die Bridge
        lauscht weiter, aber kein Gerät findet sie mehr (Befund 24.09.2026). Genau das stand
        vorher nirgends, also stand hier „Aktiv" und niemand wusste, warum nichts geht.
      */}
      {status.running && <div className={lanReachHintClass}>{lanReachHint}</div>}

      {status.mdnsError && (
        <div className="settings-hint remote-pair-error">mDNS meldete: {status.mdnsError}</div>
      )}

      {error && <div className="settings-hint remote-pair-error">{error}</div>}

      {status.running && (
        <button className="remote-pair-btn" onClick={() => void issuePin()}>
          Neues Gerät koppeln…
        </button>
      )}

      {pairing && (
        <div className="remote-pair-card">
          <div className="remote-pair-pin">{pairing.pin}</div>
          <div className="remote-pair-sub">PIN in der App eingeben oder QR scannen — 60 s gültig</div>
          {/* SVG stammt aus dem eigenen Rust-qrcode (kein Fremd-/User-Input) → kein XSS-Risiko. */}
          <div className="remote-pair-qr" dangerouslySetInnerHTML={{ __html: pairing.qrSvg }} />
        </div>
      )}

      {devices.length > 0 && (
        <div className="remote-devices">
          <div className="settings-row-sub">Gekoppelte Geräte</div>
          <div className="settings-hint">
            Gilt für diesen Mac, also für jedes Projekt, das du in mads öffnest. Widerruf wirkt
            sofort und überall.
          </div>
          {devices.map((d) => (
            <div className="remote-device-row" key={d.id}>
              <span className="remote-device-name">{d.name}</span>
              <button className="remote-pair-btn-sm" onClick={() => void revoke(d.id)}>
                Widerrufen
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
