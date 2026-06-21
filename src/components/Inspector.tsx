import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useStore } from "../store";
import { STATUS_META } from "../status";
import { StatusDot } from "./StatusDot";
import { agentBadges, mergeReadiness } from "../derive";
import { MessageTimeline } from "./MessageTimeline";
import { Elapsed } from "./Elapsed";
import type { PermissionMode, ImageInput } from "../../shared/protocol";

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
  const createPr = useStore((s) => s.createPr);
  const syncBranch = useStore((s) => s.syncBranch);
  const integratePr = useStore((s) => s.integratePr);
  const runGate = useStore((s) => s.runGate);
  const setPermissionMode = useStore((s) => s.setPermissionMode);
  const [draft, setDraft] = useState("");
  const [attached, setAttached] = useState<ImageInput[]>([]);

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
    setDraft("");
    setAttached([]);
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
      setAttached((a) => [...a, ...imgs]);
    }
  };

  const badges = agentBadges(agent);
  const canPr = !!agent.branch && !agent.pr;
  const canIntegrate = agent.role === "sub" && !!agent.pr && agent.pr.state === "OPEN";
  const readiness = mergeReadiness(agent);

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
            )}{" "}
            · {agent.numTurns} turns · ${agent.costUsd.toFixed(4)}
          </span>
        </div>
        <div className="inspector-actions">
          <select
            className="mode-select"
            value={agent.permissionMode}
            onChange={(e) => void setPermissionMode(selectedId, e.target.value as PermissionMode)}
            title="Permission-Modus dieses Agenten (steuert, wann gefragt wird)"
          >
            <option value="default">Standard</option>
            <option value="acceptEdits">Auto-Edits</option>
            <option value="plan">Plan</option>
            <option value="auto">Auto</option>
            <option value="bypassPermissions">Bypass</option>
          </select>
          {agent.role === "sub" && agent.worktreePath && (
            <button onClick={() => void runGate(selectedId)} title="Clean-Code-Gate: lint/type/test + Secret-Scan">
              Gate{agent.gate ? (agent.gate.ok ? " ✓" : " ✖") : ""}
            </button>
          )}
          {agent.behind > 0 && (
            <button onClick={() => void syncBranch(selectedId)} title="Rebase onto origin/main">
              Sync ({agent.behind})
            </button>
          )}
          {canPr && (
            <button onClick={() => void createPr(selectedId)} title="Pull Request erstellen">
              PR erstellen
            </button>
          )}
          {agent.pr && (
            <button onClick={() => void openUrl(agent.pr!.url)} title="PR auf GitHub öffnen">
              PR #{agent.pr.number}
            </button>
          )}
          {canIntegrate && (
            <button
              className="integrate"
              disabled={!readiness.ok}
              title={readiness.ok ? "PR nach main mergen (Integrator-Aktion)" : `Blockiert: ${readiness.reasons.join(" · ")}`}
              onClick={() => void integratePr(selectedId)}
            >
              Integrieren
            </button>
          )}
          <button onClick={() => void interruptAgent(selectedId)} title="Unterbrechen">
            Pause
          </button>
          <button
            className="danger"
            onClick={() => void stopAgent(selectedId, agent.role === "sub")}
            title="Stoppen (+ Worktree entfernen bei Sub)"
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
                <button type="button" onClick={() => setAttached((a) => a.filter((_, j) => j !== i))}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <form className="composer" onSubmit={submit}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => void onPaste(e)}
            placeholder={`Nachricht an ${agent.label}…  (Screenshot mit ⌘V einfügen)`}
          />
          <button type="submit" disabled={!draft.trim() && attached.length === 0}>
            Senden
          </button>
        </form>
      </div>
    </section>
  );
}
