import { openUrl } from "@tauri-apps/plugin-opener";
import { useStore } from "../store";
import { STATUS_META } from "../status";
import { StatusDot } from "./StatusDot";
import { agentBadges, nextStep } from "../derive";
import { MessageTimeline } from "./MessageTimeline";
import { Elapsed } from "./Elapsed";
import { fmtTokens } from "../format";
import type { PermissionMode, ImageInput } from "../../shared/protocol";

// Stabile Leer-Referenz: ein zustand-Selektor darf NICHT bei jedem Render ein neues []
// zurückgeben (sonst Endlos-Render-Schleife → App-Crash / graues Fenster).
const NO_IMAGES: ImageInput[] = [];

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function Inspector() {
  const selectedId = useStore((s) => s.selectedId);
  const agent = useStore((s) => (s.selectedId ? s.agents[s.selectedId] : undefined));
  const sendInput = useStore((s) => s.sendInput);
  const interruptAgent = useStore((s) => s.interruptAgent);
  const stopAgent = useStore((s) => s.stopAgent);
  const commitAgent = useStore((s) => s.commitAgent);
  const createPr = useStore((s) => s.createPr);
  const syncBranch = useStore((s) => s.syncBranch);
  const integratePr = useStore((s) => s.integratePr);
  const runGate = useStore((s) => s.runGate);
  const setPermissionMode = useStore((s) => s.setPermissionMode);
  // Composer-Entwürfe je Agent (im Store) — beim Umschalten bleibt jeder Entwurf erhalten.
  const draft = useStore((s) => (s.selectedId ? s.drafts[s.selectedId] ?? "" : ""));
  const attached = useStore((s) => (s.selectedId ? s.draftImages[s.selectedId] ?? NO_IMAGES : NO_IMAGES));
  const setDraft = useStore((s) => s.setDraft);
  const setDraftImages = useStore((s) => s.setDraftImages);

  if (!agent || !selectedId) {
    return (
      <section className="inspector empty">
        <div className="inspector-placeholder">Wähle einen Stream, um sein Live-Terminal zu sehen.</div>
      </section>
    );
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
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
  const runStep = () => {
    if (step.kind === "commit") void commitAgent(selectedId);
    else if (step.kind === "pr") void createPr(selectedId);
    else if (step.kind === "integrate") void integratePr(selectedId);
    else if (step.kind === "cleanup") void stopAgent(selectedId, true);
  };

  return (
    <section className="inspector">
      <header className="inspector-head">
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
          {/* Geführter „nächster Schritt": Committen → PR erstellen → Integrieren */}
          {step.kind !== "none" && (
            <button
              className={`step-primary${step.kind === "cleanup" ? " cleanup" : ""}`}
              disabled={step.disabled}
              title={step.hint}
              onClick={runStep}
            >
              {step.label}
            </button>
          )}
          {agent.role === "sub" && agent.worktreePath && (
            <button onClick={() => void runGate(selectedId)} title="Clean-Code-Gate: lint/type/test + Secret-Scan (läuft beim PR automatisch)">
              Gate{agent.gate ? (agent.gate.ok ? " ✓" : " ✖") : ""}
            </button>
          )}
          {agent.behind > 0 && (
            <button onClick={() => void syncBranch(selectedId)} title="Manuell auf origin/main rebasen (läuft sonst automatisch)">
              Sync ({agent.behind})
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
        <form className="composer" onSubmit={submit}>
          <input
            value={draft}
            onChange={(e) => setDraft(selectedId, e.target.value)}
            onPaste={(e) => void onPaste(e)}
            placeholder={`Nachricht an ${agent.label}…  (Screenshot mit ⌘V einfügen)`}
          />
          {busy ? (
            <button
              type="button"
              className="composer-btn stop"
              title="KI unterbrechen"
              aria-label="Unterbrechen"
              onClick={() => void interruptAgent(selectedId)}
            >
              <span className="icon-square" />
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
