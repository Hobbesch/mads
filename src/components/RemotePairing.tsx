import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Pairing-/Geräte-Verwaltung für die mads-Remote-App (iOS). Zeigt den Bridge-Status, gibt einen
 * einmaligen PIN + QR aus (60 s gültig) und listet gekoppelte Geräte mit Widerruf.
 * Die Rust-Bridge (src-tauri/src/bridge.rs, auth.rs) läuft nur mit MADS_REMOTE_BRIDGE=1.
 * Schnittstellen-Vertrag: mads-remote/docs/mads-bridge.md.
 */
type Device = { id: string; name: string; createdAt: number; lastSeen: number | null };
type Status = { running: boolean; port?: number; spkiFp?: string };
type Pairing = { pin: string; qrSvg: string };

export function RemotePairing() {
  const [status, setStatus] = useState<Status>({ running: false });
  const [devices, setDevices] = useState<Device[]>([]);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await invoke<Status>("remote_bridge_status"));
      setDevices(await invoke<Device[]>("remote_bridge_list_devices"));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
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

  return (
    <div className="settings-group">
      <div className="settings-group-title">Remote (iOS-App)</div>
      <div className="settings-hint">
        {status.running
          ? `Bridge aktiv (Port ${status.port}). Geräte im selben WLAN können koppeln.`
          : "Bridge nicht aktiv. Zum Aktivieren mads mit MADS_REMOTE_BRIDGE=1 starten."}
      </div>

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
