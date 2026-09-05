import { useEffect, useState } from "react";
import { useStore } from "../store";

/**
 * „Konto neu verbinden" — führt durch `claude setup-token`, ohne Terminal.
 *
 * Der Browser-Schritt bleibt bewusst beim Menschen: er IST die Zustimmung zu einer Anmeldung.
 * Automatisiert ist alles drumherum — und vor allem die PRÜFUNG danach: mads misst, zu welchem
 * Konto der neue Zugang gehört, und vergleicht ihn mit den anderen Profilen. Ohne diese Prüfung
 * blieb genau der Fehler unsichtbar, der am 05.09.2026 beide Profile auf dasselbe Konto legte —
 * denn eine Anmeldung, die aufs falsche Konto führt, sieht wie eine gelungene Anmeldung aus.
 */
export function AccountRelinkDialog() {
  const relink = useStore((s) => s.relink);
  const accounts = useStore((s) => s.accounts);
  const submitCode = useStore((s) => s.submitAccountRelinkCode);
  const confirm = useStore((s) => s.confirmAccountRelink);
  const cancel = useStore((s) => s.cancelAccountRelink);
  const [code, setCode] = useState("");

  // Bei jedem neuen Flow das Feld leeren — ein stehengebliebener Code aus einem abgebrochenen
  // Versuch wäre längst abgelaufen und führte nur zu einer unerklärlichen Fehlermeldung.
  useEffect(() => setCode(""), [relink?.accountId, relink?.phase === "awaiting_code"]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") void cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel]);

  if (!relink) return null;
  const label = accounts?.profiles.find((p) => p.id === relink.accountId)?.label ?? relink.accountId;

  return (
    <div className="modal-overlay">
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Konto „{label}" neu verbinden</div>

        {relink.phase === "starting" && <div className="modal-hint">Starte „claude setup-token"…</div>}

        {relink.phase === "awaiting_code" && (
          <>
            <div className="modal-hint">
              Im Browser anmelden und den angezeigten Code hier einfügen.
              <br />
              <strong>Wichtig:</strong> Willst du ein <em>anderes</em> Konto als bisher, melde dich auf claude.ai
              vorher ab oder nimm ein privates Fenster — sonst übernimmt die Anmeldung stillschweigend das Konto,
              das dort gerade eingeloggt ist.
            </div>
            {relink.url && (
              <div className="modal-hint">
                <a href={relink.url} target="_blank" rel="noreferrer">
                  Anmeldeseite öffnen ↗
                </a>
              </div>
            )}
            <label className="field">
              <span>Code aus dem Browser</span>
              <input
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && code.trim()) void submitCode(code);
                }}
                placeholder="hier einfügen"
                spellCheck={false}
              />
            </label>
          </>
        )}

        {relink.phase === "verifying" && (
          <div className="modal-hint">
            Prüfe, zu welchem Konto der Zugang gehört… (ein minimaler Aufruf, der die
            Kontingent-Fenster ausliest)
          </div>
        )}

        {relink.phase === "duplicate" && <div className="modal-hint danger">⚠ {relink.message}</div>}
        {relink.phase === "error" && <div className="modal-hint danger">{relink.message}</div>}

        <div className="modal-actions">
          <button type="button" onClick={() => void cancel()}>
            {relink.phase === "error" ? "Schliessen" : "Abbrechen"}
          </button>
          {relink.phase === "awaiting_code" && (
            <button type="button" className="primary" disabled={!code.trim()} onClick={() => void submitCode(code)}>
              Code einreichen
            </button>
          )}
          {/* Die Warnung ist eine Warnung, kein Riegel: wer wirklich zwei Profile auf demselben
              Konto will, darf das — mads soll niemanden von seiner eigenen Konfiguration aussperren. */}
          {relink.phase === "duplicate" && (
            <button type="button" onClick={() => void confirm()}>
              Trotzdem speichern
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
