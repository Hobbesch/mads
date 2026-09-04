import { useEffect, useState } from "react";
import { useStore } from "../store";
import type { AutopilotLevel, ContractCompat, ProjectLinkConfig } from "../../shared/protocol";

/**
 * Einstellungen → Projekt-Verbund (docs/design/12-project-link.md §9).
 *
 * Hier richtet der Mensch die Kopplung mit dem zweiten Repo ein: Gegenseite wählen, den eigenen
 * Contract deklarieren (die Dateien, auf die sich die Gegenseite verlässt), Kompatibilitätsregel
 * und Dispatch-Stufe. Der Sidecar ist die Wahrheit (`.mads/link.json`, gespiegelt als
 * `link_status`) — hier wird nur ein Entwurf bearbeitet und als Ganzes gespeichert.
 *
 * Wichtig für das Verständnis des Zustands: ein Verbund wird erst `active`, wenn BEIDE Seiten
 * einander nennen (§5.3). Solange nur eine Seite eingerichtet ist, steht hier, was drüben fehlt.
 */
export function LinkSettings() {
  const project = useStore((s) => s.project);
  const link = useStore((s) => s.link);
  const recentProjects = useStore((s) => s.recentProjects);
  const configureLink = useStore((s) => s.configureLink);
  const removeLink = useStore((s) => s.removeLink);
  const pickPeerRepo = useStore((s) => s.pickPeerRepo);

  const [peerRoot, setPeerRoot] = useState("");
  const [patterns, setPatterns] = useState<string[]>([]);
  const [compat, setCompat] = useState<ContractCompat>("additive");
  const [autopilot, setAutopilot] = useState<AutopilotLevel>("assisted");
  const [dirty, setDirty] = useState(false);

  // Sidecar-Spiegel übernehmen, solange lokal nichts Ungespeichertes liegt (SSOT bleibt der Sidecar).
  useEffect(() => {
    if (dirty) return;
    setPeerRoot(link?.config?.peer.repoRoot ?? "");
    setPatterns(link?.config?.provides.patterns ?? []);
    setCompat(link?.config?.provides.compat ?? "additive");
    setAutopilot(link?.config?.autopilot ?? "assisted");
  }, [link?.config, dirty]);

  if (!project) {
    return (
      <div className="settings-group">
        <div className="settings-group-title">Projekt-Verbund</div>
        <div className="settings-hint">Erst ein Projekt öffnen — der Verbund gilt pro Repo.</div>
      </div>
    );
  }

  const others = recentProjects.filter((r) => r.repoRoot !== project.repoRoot);
  const suggestions = (link?.suggestions ?? []).filter((s) => !patterns.includes(s));
  const configured = !!link?.config;

  const save = () => {
    const config: ProjectLinkConfig = {
      v: 1,
      peer: { repoRoot: peerRoot.trim() },
      provides: { patterns: patterns.map((p) => p.trim()).filter(Boolean), compat },
      autopilot,
    };
    void configureLink(config);
    setDirty(false);
  };

  return (
    <div className="settings-group">
      <div className="settings-group-title">Projekt-Verbund</div>
      <div className="settings-hint">
        Koppelt dieses Repo mit einem zweiten, das in seiner <strong>eigenen mads-Instanz</strong> offen ist
        (z. B. Server ⇄ App). Ändert sich hier die gemeinsame Schnittstelle, erfährt die Gegenseite es
        automatisch und kann nachziehen — beide <code>main</code>-Stände bleiben zueinander kompatibel.
      </div>

      {link && link.state !== "none" && (
        <div className={`link-state ${link.state}`}>
          <strong>
            {link.state === "active"
              ? "verbunden"
              : link.state === "peer_offline"
                ? "Gegenseite offline"
                : "wartet auf die Gegenseite"}
          </strong>
          {link.hint && <span> — {link.hint}</span>}
          {link.state === "peer_offline" && link.queued > 0 && <span> — {link.queued} Nachricht(en) warten dort.</span>}
        </div>
      )}

      {/* ── Gegenseite ── */}
      <label className="settings-sub-label">Gegenseite (Haupt-Checkout des zweiten Repos)</label>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="text"
          value={peerRoot}
          placeholder="/Users/…/coding/shop-app"
          style={{ flex: 1 }}
          onChange={(e) => {
            setPeerRoot(e.target.value);
            setDirty(true);
          }}
        />
        <button
          onClick={() => {
            void pickPeerRepo().then((p) => {
              if (p) {
                setPeerRoot(p);
                setDirty(true);
              }
            });
          }}
        >
          Wählen…
        </button>
      </div>
      {others.length > 0 && (
        <div className="link-chips">
          {others.slice(0, 5).map((r) => (
            <button
              key={r.repoRoot}
              className="link-chip"
              title={r.repoRoot}
              onClick={() => {
                setPeerRoot(r.repoRoot);
                setDirty(true);
              }}
            >
              {r.repo || r.repoRoot.split("/").pop()}
            </button>
          ))}
        </div>
      )}

      {/* ── Contract ── */}
      <label className="settings-sub-label">
        Contract dieses Repos — die committeten Dateien, auf die sich die Gegenseite verlässt
      </label>
      <div className="settings-hint">
        Glob-Muster wie bei Ownership-Regeln (<code>src/api/routes/**</code>). Leer lassen, wenn dieses Repo
        die Schnittstelle nur <em>konsumiert</em> — dann ist es reiner Consumer und meldet nichts.
      </div>
      {patterns.map((p, i) => (
        <div key={i} style={{ display: "flex", gap: 8, marginTop: 6 }}>
          <input
            type="text"
            value={p}
            placeholder="openapi.yaml"
            style={{ flex: 1 }}
            onChange={(e) => {
              setPatterns((d) => d.map((x, j) => (j === i ? e.target.value : x)));
              setDirty(true);
            }}
          />
          <button
            title="Muster entfernen"
            onClick={() => {
              setPatterns((d) => d.filter((_, j) => j !== i));
              setDirty(true);
            }}
          >
            ✕
          </button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
        <button
          onClick={() => {
            setPatterns((d) => [...d, ""]);
            setDirty(true);
          }}
        >
          + Muster hinzufügen
        </button>
      </div>
      {suggestions.length > 0 && (
        <>
          <div className="settings-hint" style={{ marginTop: 8 }}>
            In diesem Repo gefunden — anklicken zum Übernehmen:
          </div>
          <div className="link-chips">
            {suggestions.map((sg) => (
              <button
                key={sg}
                className="link-chip"
                onClick={() => {
                  setPatterns((d) => [...d.filter(Boolean), sg]);
                  setDirty(true);
                }}
              >
                + {sg}
              </button>
            ))}
          </div>
        </>
      )}

      {/* ── Regeln ── */}
      <label className="settings-sub-label">Kompatibilität bei Contract-Änderungen</label>
      <select
        value={compat}
        onChange={(e) => {
          setCompat(e.target.value as ContractCompat);
          setDirty(true);
        }}
      >
        <option value="additive">additiv — Neues ergänzen, Altes bleibt, bis die Gegenseite nachgezogen hat</option>
        <option value="lockstep">lockstep — Brüche erlaubt, dafür muss diese Seite zuerst landen</option>
      </select>

      <label className="settings-sub-label">Umgang mit Anfragen der Gegenseite</label>
      <select
        value={autopilot}
        onChange={(e) => {
          setAutopilot(e.target.value as AutopilotLevel);
          setDirty(true);
        }}
      >
        <option value="manual">manuell — nur Karte, Auftrag und Start schreibst du selbst</option>
        <option value="assisted">assistiert — der Integrator entwirft den Auftrag, du startest per Klick</option>
        <option value="autopilot">Autopilot — der Abgleich-Stream startet selbst (Merge bleibt menschlich)</option>
      </select>

      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <button className="primary" disabled={!peerRoot.trim() || !dirty} onClick={save}>
          {configured ? "Verbund aktualisieren" : "Verbund einrichten"}
        </button>
        {configured && (
          <button
            title="Kopplung lösen. Die bisherigen Abgleich-Threads bleiben als Protokoll erhalten."
            onClick={() => {
              void removeLink();
              setDirty(false);
            }}
          >
            Verbund lösen
          </button>
        )}
      </div>
      {configured && (
        <div className="settings-hint" style={{ marginTop: 8 }}>
          Damit der Verbund <strong>aktiv</strong> wird, muss die Gegenseite dieses Repo ebenfalls als
          Verbund-Partner eintragen — sonst kann ein beliebiges Repo einem anderen Arbeit unterschieben.
        </div>
      )}
    </div>
  );
}
