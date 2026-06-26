import { useLayoutEffect, useRef } from "react";
import { Mic } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useStore } from "../store";
import { STATUS_META } from "../status";
import { StatusDot } from "./StatusDot";
import { agentBadges, nextStep } from "../derive";
import { agentColor } from "../agentColor";
import { MessageTimeline } from "./MessageTimeline";
import { Elapsed } from "./Elapsed";
import { fmtTokens } from "../format";
import { blobToBase64 } from "../blob";
import type { PermissionMode, ImageInput } from "../../shared/protocol";

// Stabile Leer-Referenz: ein zustand-Selektor darf NICHT bei jedem Render ein neues []
// zurückgeben (sonst Endlos-Render-Schleife → App-Crash / graues Fenster).
const NO_IMAGES: ImageInput[] = [];

export function Inspector() {
  const selectedId = useStore((s) => s.selectedId);
  const agent = useStore((s) => (s.selectedId ? s.agents[s.selectedId] : undefined));
  const sendInput = useStore((s) => s.sendInput);
  const interruptAgent = useStore((s) => s.interruptAgent);
  const stopAgent = useStore((s) => s.stopAgent);
  const commitAgent = useStore((s) => s.commitAgent);
  const createPr = useStore((s) => s.createPr);
  const syncBranch = useStore((s) => s.syncBranch);
  const updateMain = useStore((s) => s.updateMain);
  const continueStream = useStore((s) => s.continueStream);
  const integratePr = useStore((s) => s.integratePr);
  const runGate = useStore((s) => s.runGate);
  const setPermissionMode = useStore((s) => s.setPermissionMode);
  // Composer-Entwürfe je Agent (im Store) — beim Umschalten bleibt jeder Entwurf erhalten.
  const draft = useStore((s) => (s.selectedId ? s.drafts[s.selectedId] ?? "" : ""));
  const attached = useStore((s) => (s.selectedId ? s.draftImages[s.selectedId] ?? NO_IMAGES : NO_IMAGES));
  const setDraft = useStore((s) => s.setDraft);
  const setDraftImages = useStore((s) => s.setDraftImages);
  // Spracheingabe (lokales Whisper)
  const whisper = useStore((s) => s.whisper);
  const dictation = useStore((s) => s.dictation);
  const startDictation = useStore((s) => s.startDictation);
  const stopDictation = useStore((s) => s.stopDictation);

  // Auto-wachsende Composer-Höhe (Textarea): bei jeder Entwurfs-Änderung neu messen.
  const composerRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  if (!agent || !selectedId) {
    return (
      <section className="inspector empty">
        <div className="inspector-placeholder">Wähle einen Stream, um sein Live-Terminal zu sehen.</div>
      </section>
    );
  }

  const submit = (e?: { preventDefault: () => void }) => {
    e?.preventDefault();
    const text = draft.trim();
    if (!text && attached.length === 0) return;
    void sendInput(selectedId, text || "(siehe Screenshot)", attached.length ? attached : undefined);
    setDraft(selectedId, "");
    setDraftImages(selectedId, []);
  };

  const onPaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imgs: ImageInput[] = [];
    for (const it of Array.from(items)) {
      if (it.type.startsWith("image/")) {
        const file = it.getAsFile();
        if (file) imgs.push({ mediaType: file.type || "image/png", dataBase64: await blobToBase64(file) });
      }
    }
    if (imgs.length) {
      e.preventDefault();
      setDraftImages(selectedId, [...attached, ...imgs]);
    }
  };

  const badges = agentBadges(agent);
  const step = nextStep(agent);
  const busy = agent.status === "running" || agent.status === "starting";
  const color = agentColor(agent.branch ?? agent.id);
  // Passiv wiederhergestellt (nicht im Pool): nur Verlauf ansehen; Git-Aktionen erst nach
  // „Fortsetzen" (oder durch Senden einer Nachricht, das den Stream lazy aktiviert).
  const live = agent.live !== false;
  const runStep = () => {
    if (step.kind === "commit") void commitAgent(selectedId);
    else if (step.kind === "pr") void createPr(selectedId);
    else if (step.kind === "integrate") void integratePr(selectedId);
    else if (step.kind === "cleanup") void stopAgent(selectedId, true);
  };

  return (
    <section className="inspector" style={{ "--agent-color": color } as React.CSSProperties}>
      <header className="inspector-head agent-tinted">
        <StatusDot status={agent.status} />
        <div className="inspector-title">
          <span className="inspector-label">{agent.label}</span>
          <span className="inspector-sub">
            {STATUS_META[agent.status].label}
            {agent.currentStep ? ` · ${agent.currentStep}` : ""}
            {(agent.status === "running" || agent.status === "starting") && agent.workStartedAt !== undefined && (
              <>
                {" · "}
                <Elapsed since={agent.workStartedAt} />
              </>
            )}{" · "}
            {agent.numTurns} turns
            <span
              className="inspector-tokens"
              title={
                agent.costUsd > 0
                  ? `↑ ${agent.inputTokens.toLocaleString()} Input · ↓ ${agent.outputTokens.toLocaleString()} Output Tokens · ≈ $${agent.costUsd.toFixed(4)} (API-Schätzung; bei Abo nicht abgerechnet)`
                  : `↑ ${agent.inputTokens.toLocaleString()} Input · ↓ ${agent.outputTokens.toLocaleString()} Output Tokens · Abo-Nutzung (keine API-Kosten)`
              }
            >
              {" · "}↑ {fmtTokens(agent.inputTokens)} ↓ {fmtTokens(agent.outputTokens)} tok
            </span>
          </span>
        </div>
        <div className="inspector-actions">
          <select
            className="mode-select"
            value={agent.permissionMode}
            onChange={(e) => void setPermissionMode(selectedId, e.target.value as PermissionMode)}
            title="Permission-Modus dieses Agenten (steuert, wann gefragt wird)"
          >
            <option value="default">Standard — fragt immer</option>
            <option value="acceptEdits">Auto-Edits</option>
            <option value="plan">Plan</option>
            <option value="auto">Auto — nur Risiko fragen</option>
            <option value="bypassPermissions">Bypass — nie fragen</option>
          </select>
          {/* Passiv wiederhergestellt → erst reaktivieren, bevor Git-Aktionen möglich sind. */}
          {!live && (
            <button className="step-primary" title="Stream fortsetzen (Session reaktivieren, dann weiterarbeiten)" onClick={() => void continueStream(selectedId)}>
              ▶ Fortsetzen
            </button>
          )}
          {/* Geführter „nächster Schritt": Committen → PR erstellen → Integrieren */}
          {live && step.kind !== "none" && (
            <button
              className={`step-primary${step.kind === "cleanup" ? " cleanup" : ""}`}
              disabled={step.disabled}
              title={step.hint}
              onClick={runStep}
            >
              {step.label}
            </button>
          )}
          {live && agent.role === "sub" && agent.worktreePath && (
            <button onClick={() => void runGate(selectedId)} title="Clean-Code-Gate: lint/type/test + Secret-Scan (läuft beim PR automatisch)">
              Gate{agent.gate ? (agent.gate.ok ? " ✓" : " ✖") : ""}
            </button>
          )}
          {/* Sub: rebase onto origin/<default> + force-with-lease. NIE für den Integrator —
              dessen „behind" betrifft den main-Checkout, der per fast-forward (nicht rebase!)
              nachgezogen wird. */}
          {live && agent.role === "sub" && agent.behind > 0 && (
            <button onClick={() => void syncBranch(selectedId)} title="Manuell auf origin/main rebasen (läuft sonst automatisch)">
              Sync ({agent.behind})
            </button>
          )}
          {live && agent.role === "integrator" && agent.behind > 0 && (
            <button
              onClick={() => void updateMain(selectedId)}
              title={`Dein main-Checkout ist ${agent.behind} Commits hinter origin — per fast-forward nachziehen (kein rebase/force).`}
            >
              main aktualisieren ({agent.behind})
            </button>
          )}
          {agent.pr && (
            <button onClick={() => void openUrl(agent.pr!.url)} title="PR auf GitHub öffnen">
              PR #{agent.pr.number} ↗
            </button>
          )}
          <button
            className="danger"
            onClick={() => void stopAgent(selectedId, agent.role === "sub")}
            title="Stoppen + aufräumen (Worktree/Branch entfernen bei Sub)"
          >
            Stop
          </button>
        </div>
      </header>

      {(agent.branch || badges.length > 0) && (
        <div className="inspector-badges">
          {agent.branch && <span className="badge info">⎇ {agent.branch}</span>}
          {badges.map((b, i) => (
            <span key={i} className={`badge ${b.tone}`}>
              {b.label}
            </span>
          ))}
        </div>
      )}

      <div className="timeline-wrap">
        <MessageTimeline agentId={selectedId} />
      </div>

      <div className="composer-wrap">
        {attached.length > 0 && (
          <div className="composer-attachments">
            {attached.map((im, i) => (
              <div key={i} className="thumb">
                <img src={`data:${im.mediaType};base64,${im.dataBase64}`} alt="Anhang" />
                <button type="button" onClick={() => setDraftImages(selectedId, attached.filter((_, j) => j !== i))}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {whisper.downloading && (
          <div className="composer-note">⬇︎ Sprachmodell lädt… {Math.round(whisper.progress * 100)}% (einmalig, ~1,5 GB)</div>
        )}
        {dictation.recording && <div className="composer-note rec">● Aufnahme läuft — ⇧Leertaste loslassen oder Mikro klicken zum Stoppen</div>}
        {dictation.transcribing && <div className="composer-note">⌛ Transkribiere…</div>}
        {dictation.error && <div className="composer-note err">{dictation.error}</div>}
        <form className="composer" onSubmit={submit}>
          <textarea
            ref={composerRef}
            className="composer-input"
            rows={1}
            value={draft}
            onChange={(e) => setDraft(selectedId, e.target.value)}
            onPaste={(e) => void onPaste(e)}
            onKeyDown={(e) => {
              // Enter sendet; Shift+Enter (oder während IME-Komposition) → Zeilenumbruch.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={`Nachricht an ${agent.label}…  (Enter senden · ⇧↵ Zeilenumbruch · ⌘V Screenshot)`}
          />
          {whisper.downloading ? (
            <button type="button" className="composer-btn mic" disabled title={`Sprachmodell lädt… ${Math.round(whisper.progress * 100)}%`}>
              <span className="mic-pct">{Math.round(whisper.progress * 100)}%</span>
            </button>
          ) : dictation.transcribing ? (
            <button type="button" className="composer-btn mic" disabled title="Transkribiere…" aria-label="Transkribiere">
              <span className="tl-spinner" />
            </button>
          ) : dictation.recording ? (
            <>
              {/* „On air": rot/pulsierend; Klick stoppt ebenfalls. */}
              <button
                type="button"
                className="composer-btn mic recording"
                title="Aufnahme läuft — klicken oder Stopp-Knopf drücken"
                aria-label="Aufnahme läuft (klicken zum Stoppen)"
                onClick={() => void stopDictation()}
              >
                <Mic size={16} aria-hidden="true" />
              </button>
              {/* Expliziter Stopp-Knopf: beendet, transkribiert, fügt ein (sendet NICHT). */}
              <button
                type="button"
                className="composer-btn dict-stop"
                title="Aufnahme stoppen & Text einfügen (wird noch nicht gesendet)"
                aria-label="Aufnahme stoppen und einfügen"
                onClick={() => void stopDictation()}
              >
                <svg className="icon-stop" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                  <rect width="16" height="16" rx="2" fill="currentColor" />
                </svg>
              </button>
            </>
          ) : (
            <button
              type="button"
              className="composer-btn mic"
              title={
                !whisper.installed
                  ? "Sprachmodell (~1,5 GB) für Spracheingabe herunterladen"
                  : "Diktieren — klicken zum Starten (oder ⇧Leertaste halten)"
              }
              aria-label="Diktieren"
              onClick={() => void startDictation()}
            >
              <Mic size={16} aria-hidden="true" />
            </button>
          )}
          {busy ? (
            <button
              type="button"
              className="composer-btn stop"
              title="KI unterbrechen"
              aria-label="Unterbrechen"
              onClick={() => void interruptAgent(selectedId)}
            >
              <svg className="icon-stop" viewBox="0 0 16 16" width="17" height="17" aria-hidden="true">
                <rect width="16" height="16" fill="currentColor" />
              </svg>
            </button>
          ) : (
            <button
              type="submit"
              className="composer-btn send"
              disabled={!draft.trim() && attached.length === 0}
              title="Senden"
              aria-label="Senden"
            >
              ↑
            </button>
          )}
        </form>
      </div>
    </section>
  );
}
