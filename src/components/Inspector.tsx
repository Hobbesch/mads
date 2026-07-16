import { useLayoutEffect, useRef, useState } from "react";
import { Mic } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useStore } from "../store";
import type { AttachedFile, DevLogLine } from "../store";
import { STATUS_META } from "../status";
import { StatusDot } from "./StatusDot";
import { agentBadges, nextStep, unsavedWork, gateDisabledReason, syncDisabledReason } from "../derive";
import { ConfirmDialog } from "./ConfirmDialog";
import { agentColor } from "../agentColor";
import { MessageTimeline } from "./MessageTimeline";
import { ModelEffortPicker } from "./ModelEffortPicker";
import { Elapsed } from "./Elapsed";
import { fmtTokens } from "../format";
import { blobToBase64, makeThumbnail } from "../blob";
import { loadUiPrefs, saveUiPrefs } from "../uiPrefs";
import type { PermissionMode, ImageInput, AutopilotLevel } from "../../shared/protocol";

// Stabile Leer-Referenz: ein zustand-Selektor darf NICHT bei jedem Render ein neues []
// zurückgeben (sonst Endlos-Render-Schleife → App-Crash / graues Fenster).
const NO_IMAGES: ImageInput[] = [];
const NO_FILES: AttachedFile[] = [];
const NO_DEVLOG: DevLogLine[] = [];

export function Inspector() {
  const selectedId = useStore((s) => s.selectedId);
  const agent = useStore((s) => (s.selectedId ? s.agents[s.selectedId] : undefined));
  const sendInput = useStore((s) => s.sendInput);
  const interruptAgent = useStore((s) => s.interruptAgent);
  const stopAgent = useStore((s) => s.stopAgent);
  const commitAgent = useStore((s) => s.commitAgent);
  const createPr = useStore((s) => s.createPr);
  const syncBranch = useStore((s) => s.syncBranch);
  const resolveConflict = useStore((s) => s.resolveConflict);
  const outsourceMain = useStore((s) => s.outsourceMain);
  const commitMainRelease = useStore((s) => s.commitMainRelease);
  const updateMain = useStore((s) => s.updateMain);
  const continueStream = useStore((s) => s.continueStream);
  const integratePr = useStore((s) => s.integratePr);
  const runGate = useStore((s) => s.runGate);
  const startDevServer = useStore((s) => s.startDevServer);
  const stopDevServer = useStore((s) => s.stopDevServer);
  const devLog = useStore((s) => (s.selectedId ? s.devLog[s.selectedId] ?? NO_DEVLOG : NO_DEVLOG));
  const devLogRef = useRef<HTMLDivElement>(null);
  const devLogStickRef = useRef(true); // an den unteren Rand „geklebt"? (nur dann folgen)
  // Auf-/Zu-Zustand des Dev-Server-Logs: FOLGT der Nutzer-Einstellung (persistent in uiPrefs) und
  // klappt NICHT bei jeder neuen Log-Zeile selbständig auf. Vorher war <details open> statisch → React
  // erzwang bei jedem Re-Render (jedes devserver_log-Event) wieder „auf", was den Chat verdrängte.
  const [devLogOpen, setDevLogOpen] = useState(() => loadUiPrefs().devLogOpen);
  useLayoutEffect(() => {
    const el = devLogRef.current;
    if (el && devLogStickRef.current) el.scrollTop = el.scrollHeight; // nur, wenn User schon unten steht
  }, [devLog]);
  const setPermissionMode = useStore((s) => s.setPermissionMode);
  const setAutopilot = useStore((s) => s.setAutopilot);
  const setStreamModel = useStore((s) => s.setStreamModel);
  const setStreamEffort = useStore((s) => s.setStreamEffort);
  const defaultModel = useStore((s) => s.defaultModel);
  // Composer-Entwürfe je Agent (im Store) — beim Umschalten bleibt jeder Entwurf erhalten.
  const draft = useStore((s) => (s.selectedId ? s.drafts[s.selectedId] ?? "" : ""));
  const attached = useStore((s) => (s.selectedId ? s.draftImages[s.selectedId] ?? NO_IMAGES : NO_IMAGES));
  const attachedFiles = useStore((s) => (s.selectedId ? s.draftFiles[s.selectedId] ?? NO_FILES : NO_FILES));
  const setDraft = useStore((s) => s.setDraft);
  const setDraftImages = useStore((s) => s.setDraftImages);
  const setDraftFiles = useStore((s) => s.setDraftFiles);
  const attachToDraft = useStore((s) => s.attachToDraft);
  // Spracheingabe (lokales Whisper)
  const whisper = useStore((s) => s.whisper);
  const dictation = useStore((s) => s.dictation);
  const startDictation = useStore((s) => s.startDictation);
  const stopDictation = useStore((s) => s.stopDictation);
  // Bestätigungs-Dialog vor irreversiblen Aktionen (Merge / Stop-mit-Resten). Hook MUSS
  // vor dem early-return stehen (Rules of Hooks).
  const [confirm, setConfirm] = useState<
    null | { title: string; body: React.ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void }
  >(null);
  const [dragging, setDragging] = useState(false); // Bild per Drag&Drop in den Composer

  // Auto-wachsende Composer-Höhe (Textarea): bei jeder Entwurfs-Änderung neu messen.
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null); // verstecktes Input für den „+"-Button
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
    let text = draft.trim();
    if (!text && attached.length === 0 && attachedFiles.length === 0) return;
    // Datei-Anhänge (Nicht-Bilder) als lesbare Referenzen in den Prompt hängen — der Agent
    // liest sie über den Pfad (liegen in `.mads/attachments/`, im cwd → keine Rückfrage).
    if (attachedFiles.length) {
      const list = attachedFiles.map((f) => `- ${f.relPath}`).join("\n");
      text = `${text ? text + "\n\n" : ""}📎 Angehängte Dateien (bitte lesen):\n${list}`;
    }
    void sendInput(selectedId, text || "(siehe Anhang)", attached.length ? attached : undefined);
    setDraft(selectedId, "");
    setDraftImages(selectedId, []);
    setDraftFiles(selectedId, []);
  };

  // Bild-Dateien (aus Paste ODER Drag&Drop) als Anhänge übernehmen (base64, ImageInput).
  const attachImageFiles = async (files: File[]) => {
    const imgs: ImageInput[] = [];
    for (const f of files) {
      if (!f.type.startsWith("image/")) continue;
      // Thumbnail gleich hier erzeugen (Canvas gibt's nur im Frontend) → es reist im user_text-Event
      // mit, damit Mac UND Remote das echte Bild statt eines Zählers zeigen.
      const thumb = await makeThumbnail(f);
      imgs.push({ mediaType: f.type || "image/png", dataBase64: await blobToBase64(f), ...thumb });
    }
    if (imgs.length) setDraftImages(selectedId, [...attached, ...imgs]);
    return imgs.length;
  };

  const onPaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = Array.from(items)
      .filter((it) => it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f);
    if (files.length) {
      e.preventDefault();
      await attachImageFiles(files);
    }
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = e.dataTransfer?.files;
    if (files && files.length) await attachToDraft(selectedId, Array.from(files));
  };

  // „+"-Button → Datei-Auswahl (Bilder + beliebige Dateien).
  const onPickFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length) await attachToDraft(selectedId, Array.from(files));
    e.target.value = ""; // dieselbe Datei später erneut wählbar
  };

  const badges = agentBadges(agent);
  const step = nextStep(agent);
  const busy = agent.status === "running" || agent.status === "starting";
  const color = agentColor(agent.branch ?? agent.id);
  // Passiv wiederhergestellt (nicht im Pool): nur Verlauf ansehen; Git-Aktionen erst nach
  // „Fortsetzen" (oder durch Senden einer Nachricht, das den Stream lazy aktiviert).
  const live = agent.live !== false;
  // Merge ist irreversibel & außen-wirksam (landet auf dem geteilten main) → bestätigen.
  const askMerge = (keep: boolean) =>
    setConfirm({
      title: keep ? "Mergen & weiterarbeiten?" : "Integrieren & Stream beenden?",
      danger: !keep, // das endgültige Integrieren räumt den Stream ab → als riskant markieren
      body: (
        <>
          <p>
            Der PR von <strong>{agent.label}</strong> wird nach <code>main</code> gemergt — eine außen-sichtbare,
            nicht umkehrbare Aktion auf dem geteilten Branch.
          </p>
          <p>
            {keep
              ? "Branch + Stream bleiben erhalten (auf main zurückgesetzt) — du arbeitest direkt weiter."
              : "Danach werden Worktree + Branch aufgeräumt und der Stream beendet — für diesen Stream ist dann Schluss."}
          </p>
        </>
      ),
      confirmLabel: keep ? "Mergen & weiterarbeiten" : "Integrieren & beenden",
      onConfirm: () => void integratePr(selectedId, keep),
    });

  // Stop entfernt Worktree + Branch → bei ungesicherter Arbeit erst warnen (sonst Verlust).
  const askStop = () => {
    if (!unsavedWork(agent)) {
      void stopAgent(selectedId, agent.role === "sub");
      return;
    }
    setConfirm({
      title: "Stream stoppen — ungesicherte Arbeit",
      danger: true,
      body: (
        <>
          <p>
            <strong>{agent.label}</strong> hat ungesicherte Arbeit{" "}
            {agent.dirty ? "(uncommittete/untracked Änderungen)" : `(${agent.ahead} Commit(s) ohne PR)`}.
          </p>
          <p>
            Stoppen entfernt Worktree + Branch — diese Arbeit geht dann <strong>verloren</strong>. Besser erst
            „Committen" bzw. „PR erstellen".
          </p>
        </>
      ),
      confirmLabel: "Trotzdem stoppen & verwerfen",
      onConfirm: () => void stopAgent(selectedId, agent.role === "sub"),
    });
  };

  // Main-Edits in einen neuen Sub-Stream auslagern (main bleibt sauber; direkter Commit auf main
  // ist bewusst nicht vorgesehen).
  const askOutsource = () =>
    setConfirm({
      title: "Main-Änderungen auslagern?",
      body: (
        <>
          <p>
            Direkte Änderungen an <code>main</code> sind nicht vorgesehen (<code>main</code> ändert sich nur über einen
            grün-getesteten PR-Merge).
          </p>
          <p>
            mads verschiebt deine uncommitteten Änderungen verlustsicher in einen <strong>neuen Sub-Stream</strong>{" "}
            (eigener Branch ab <code>main</code>) — dort laufen sie über den normalen Commit→PR→Integrate-Fluss. Der
            Main-Checkout wird wieder sauber.
          </p>
        </>
      ),
      confirmLabel: "In Sub-Stream auslagern",
      onConfirm: () => void outsourceMain(selectedId),
    });

  // Deploy-Fall: den aktuellen main-Stand als Release-Commit festhalten (typischer Versions-Bump).
  const askCommitRelease = () =>
    setConfirm({
      title: "Als Release committen?",
      body: (
        <>
          <p>
            Der aktuelle Stand des <code>main</code>-Checkouts wird als Release-Commit festgehalten (
            <code>chore(release): &lt;version&gt;</code> — die Version wird aus dem Diff abgeleitet).
          </p>
          <p>
            Nur <strong>lokal</strong> auf <code>main</code> — <strong>kein Push</strong>. Das Pushen bleibt eine
            bewusste, separate Aktion. Gedacht für den Versions-Bump nach einem Deploy.
          </p>
        </>
      ),
      confirmLabel: "Als Release committen",
      onConfirm: () => void commitMainRelease(selectedId),
    });

  const runStep = () => {
    if (step.kind === "commit") void commitAgent(selectedId);
    else if (step.kind === "pr") void createPr(selectedId);
    else if (step.kind === "integrate") askMerge(true); // Default = mergen + Stream BEHALTEN
    else if (step.kind === "outsource") askOutsource();
    else if (step.kind === "cleanup") void stopAgent(selectedId, true); // bereits gemergt → sicher
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
          {/* Cluster 1 — Einstellungen (Dropdowns): Permission · Autopilot · Modell/Effort. */}
          <div className="insp-config">
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
          {agent.role === "sub" && (
            <select
              className="mode-select"
              value={agent.autopilot ?? "assisted"}
              onChange={(e) => void setAutopilot(selectedId, e.target.value as AutopilotLevel)}
              title="Autopilot automatisiert die reversible Seite (committen, pushen, PR) — Merge bleibt dein Klick."
            >
              <option value="manual">🤖 Manuell</option>
              <option value="assisted">🤖 Assisted — auto commit/push/PR</option>
              <option value="autopilot">🤖 Autopilot</option>
            </select>
          )}
          {/* Modell + Effort DIESES Streams live umstellen (Modell via setModel, Effort/Ultracode
              via applyFlagSettings — ohne Neustart). Kleines „Stream"-Label als Gegenstück zum
              „· DEFAULT" der linken Leiste, damit klar ist: das gilt nur für diesen Stream. */}
          {live && !agent.mock && (
            <div
              className="insp-me"
              title="Modell & Effort NUR für diesen Stream (live umgestellt). Der Regler in der linken Leiste ist der Default für neue Streams."
            >
              <span className="insp-me-label">Stream</span>
              <ModelEffortPicker
                model={agent.model ?? defaultModel}
                effort={agent.effort}
                onModel={(m) => void setStreamModel(selectedId, m)}
                onEffort={(e) => void setStreamEffort(selectedId, e)}
                variant="inspector"
              />
            </div>
          )}
          </div>
          {/* Cluster 2 — Aktions-Buttons (kontextabhängig). Bricht als eigene Einheit um. */}
          <div className="insp-ops">
          {/* Passiv wiederhergestellt → erst reaktivieren, bevor Git-Aktionen möglich sind.
              Beim INTEGRATOR (Leitstelle) erst rückfragen: reaktivieren kann sofort Aktionen
              auslösen (versehentliches „Fortsetzen" hat genau das getan). */}
          {!live && (
            <button
              className="step-primary"
              title="Stream fortsetzen (Session reaktivieren, dann weiterarbeiten)"
              onClick={() => {
                if (agent.role === "integrator") {
                  setConfirm({
                    title: "Main-Stream fortsetzen?",
                    body: (
                      <p>
                        Der <strong>Main-Stream</strong> ist die Leitstelle und ändert main nicht direkt.
                        „Fortsetzen" reaktiviert seine Session — er kann dann sofort weiter-agieren.
                      </p>
                    ),
                    confirmLabel: "Fortsetzen",
                    onConfirm: () => void continueStream(selectedId),
                  });
                } else {
                  void continueStream(selectedId);
                }
              }}
            >
              ▶ Fortsetzen
            </button>
          )}
          {/* Hängende „startet"-Kachel (Session nie hochgekommen, z.B. fehlgeschlagene Auslagerung)
              soll immer entfernbar sein — entfernt den Stream lokal, auch ohne Backing-Session. */}
          {agent.status === "starting" && agent.numTurns === 0 && (
            <button
              className="step-primary cleanup"
              title="Diesen (hängenden) Stream entfernen"
              onClick={() => void stopAgent(selectedId, agent.role === "sub")}
            >
              ✕ Abbrechen
            </button>
          )}
          {/* Geführter „nächster Schritt": Committen → PR erstellen → Integrieren */}
          {/* Auch bei einem PASSIV wiederhergestellten Stream (nach App-Neustart, live=false) den Schritt
              ZEIGEN — nur deaktiviert und mit Grund. Vorher war der Knopf komplett ausgeblendet: der
              „Mergen & weiterarbeiten"-Knopf fehlte nach jedem Neustart spurlos, obwohl ein offener PR
              da war, und niemand konnte sehen warum. Handeln kann mads erst, wenn der Stream wieder im
              Pool ist → „Fortsetzen". */}
          {step.kind !== "none" && (
            <button
              className={`step-primary${step.kind === "cleanup" ? " cleanup" : ""}`}
              disabled={step.disabled || !live}
              title={live ? step.hint : `${step.label}: erst „Fortsetzen“ — der Stream ist nach dem App-Neustart noch nicht aktiv.`}
              onClick={runStep}
            >
              {step.label}
            </button>
          )}
          {/* Sekundär (bewusst nicht der Default): endgültiges Integrieren — mergt nach main
              UND räumt danach Worktree + Branch auf und beendet den Stream. Nur wählen, wenn an
              diesem Stream nicht mehr weitergearbeitet wird. Der Default-Button oben („Mergen &
              weiterarbeiten") behält den Stream. */}
          {live && step.kind === "integrate" && (
            <button
              className="danger"
              disabled={step.disabled}
              title="Mergt den PR nach main und beendet danach den Stream (Worktree + Branch werden aufgeräumt). Nur wählen, wenn du an diesem Stream nicht mehr weiterarbeitest."
              onClick={() => askMerge(false)}
            >
              Integrieren &amp; beenden
            </button>
          )}
          {/* Integrator hat uncommittete main-Änderungen: Alternative zum Auslagern — den (Deploy-)Stand
              als Release-Commit festhalten (chore(release): …). Nur lokal, Push bleibt separat. */}
          {live && step.kind === "outsource" && (
            <button
              title="Den aktuellen (Deploy-)Stand von main als Release-Commit festhalten (chore(release): <version>). Nur lokal — Push bleibt separat."
              onClick={askCommitRelease}
            >
              Als Release committen
            </button>
          )}
          {live && agent.role === "sub" && agent.worktreePath && (
            <button
              disabled={!!gateDisabledReason(agent)}
              onClick={() => void runGate(selectedId)}
              title={gateDisabledReason(agent) ?? "Clean-Code-Gate: lint/type/test + Secret-Scan (läuft beim PR automatisch)"}
            >
              Gate{agent.gate ? (agent.gate.ok ? " ✓" : " ✖") : ""}
            </button>
          )}
          {/* Dev-Server: Front-/Backend dieses Streams IM Worktree starten (main bleibt unberührt).
              Auch für PASSIVE („fertige") Streams — der Server hängt am Worktree, nicht an einer
              aktiven KI-Session. Es läuft immer nur einer gleichzeitig; Konfig in .mads/run.json. */}
          {agent.role === "sub" && agent.worktreePath && (
            (() => {
              const ds = agent.devServer;
              const on = !!ds && ds.state !== "stopped" && ds.state !== "error";
              const label =
                ds?.state === "running"
                  ? "■ Dev-Server (läuft)"
                  : ds?.state === "installing"
                    ? "■ Dev-Server (install…)"
                    : ds?.state === "starting"
                      ? "■ Dev-Server (startet…)"
                      : "▶ Dev-Server";
              return (
                <button
                  className={`devserver-btn${on ? " on" : ""}`}
                  onClick={() => (on ? void stopDevServer(selectedId) : void startDevServer(selectedId))}
                  title={
                    on
                      ? "Dev-Server dieses Streams stoppen"
                      : "Front-/Backend dieses Streams lokal starten (aus dem Worktree — main bleibt unberührt). Konfig: .mads/run.json"
                  }
                >
                  {label}
                </button>
              );
            })()
          )}
          {agent.role === "sub" && agent.devServer?.state === "running" && agent.devServer.url && (
            <button
              className="devserver-open"
              onClick={() => void openUrl(agent.devServer!.url!)}
              title="Dev-Server im Browser öffnen"
            >
              {agent.devServer.url.replace(/^https?:\/\//, "")} ↗
            </button>
          )}
          {/* Sub: rebase onto origin/<default> + force-with-lease. NIE für den Integrator —
              dessen „behind" betrifft den main-Checkout, der per fast-forward (nicht rebase!)
              nachgezogen wird. */}
          {live && agent.role === "sub" && agent.syncBlocked && (
            <button
              className="step-primary"
              title="Den Agenten den Rebase-Konflikt in seinem Worktree lösen lassen (git rebase + Konflikte beheben, kein Push/PR)."
              onClick={() => void resolveConflict(selectedId)}
            >
              ⚠ Konflikt lösen
            </button>
          )}
          {live && agent.role === "sub" && (agent.behind > 0 || agent.syncBlocked) && (
            <button
              disabled={!!syncDisabledReason(agent)}
              onClick={() => void syncBranch(selectedId)}
              title={
                syncDisabledReason(agent) ??
                (agent.syncBlocked
                  ? "Auto-Sync ist wegen eines Konflikts pausiert. Konflikt im Worktree lösen, dann erneut Sync."
                  : "Manuell auf origin/main rebasen (läuft sonst automatisch)")
              }
            >
              Sync{agent.behind > 0 ? ` (${agent.behind})` : ""}
              {agent.syncBlocked ? " ⚠︎" : ""}
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
            onClick={askStop}
            title="Stoppen + aufräumen (Worktree/Branch entfernen bei Sub)"
          >
            Stop
          </button>
          </div>
        </div>
      </header>

      {agent.role === "sub" && (agent.devServer || devLog.length > 0) && (
        <details
          className="devserver-log"
          open={devLogOpen}
          onToggle={(e) => {
            const v = e.currentTarget.open;
            if (v === devLogOpen) return; // nur echte Zustandswechsel persistieren (kein Render-Loop)
            setDevLogOpen(v);
            saveUiPrefs({ devLogOpen: v });
          }}
        >
          <summary>
            <span className={`devserver-dot ${agent.devServer?.state ?? "stopped"}`} />
            Dev-Server
            {agent.devServer?.state ? ` — ${agent.devServer.state}` : ""}
            {agent.devServer?.message ? ` · ${agent.devServer.message}` : ""}
          </summary>
          <div
            className="devserver-log-body"
            ref={devLogRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              devLogStickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
          >
            {devLog.length === 0 ? (
              <div className="devserver-log-empty">Noch keine Ausgabe.</div>
            ) : (
              devLog.map((l) => (
                <div key={l.id} className={`devserver-log-line${l.stream === "stderr" ? " err" : ""}`}>
                  <span className="devserver-log-svc">{l.service}</span>
                  <span className="devserver-log-text">{l.line}</span>
                </div>
              ))
            )}
          </div>
        </details>
      )}

      {agent.role === "integrator" && (
        <div className="inspector-rolehint">
          <strong>🎛 Leitstelle.</strong> Hier wird <em>aufgeteilt</em> (neue Sub-Streams), <em>reviewt</em> und{" "}
          <em>integriert</em> — direktes Committen auf <code>main</code> ist bewusst nicht vorgesehen. Änderungen laufen
          über Sub-Streams; eigene Edits in <code>main</code> kannst du mit „In Sub-Stream auslagern" verschieben.
        </div>
      )}

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

      <div
        className={`composer-wrap${dragging ? " dragover" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!dragging) setDragging(true);
        }}
        onDragLeave={(e) => {
          // nur zurücksetzen, wenn der Cursor den Composer wirklich verlässt (nicht bei Kind-Elementen)
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(e) => void onDrop(e)}
      >
        {dragging && <div className="composer-drophint">Dateien &amp; Bilder hier ablegen zum Anhängen</div>}
        {(attached.length > 0 || attachedFiles.length > 0) && (
          <div className="composer-attachments">
            {attached.map((im, i) => (
              <div key={`img-${i}`} className="thumb">
                <img src={`data:${im.mediaType};base64,${im.dataBase64}`} alt="Anhang" />
                <button type="button" onClick={() => setDraftImages(selectedId, attached.filter((_, j) => j !== i))}>
                  ×
                </button>
              </div>
            ))}
            {attachedFiles.map((f, i) => (
              <div key={`file-${i}`} className="file-chip" title={f.relPath}>
                <span className="file-chip-name">📄 {f.name}</span>
                <button
                  type="button"
                  aria-label={`Anhang ${f.name} entfernen`}
                  onClick={() => setDraftFiles(selectedId, attachedFiles.filter((_, j) => j !== i))}
                >
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
        {dictation.transcribing && (
          <div className="composer-note transcribing" aria-live="polite">
            <span className="tl-spinner" /> Transkribiere…
            <span className="cn-dim"> der erkannte Text erscheint gleich (bei langem Text etwas Geduld)</span>
          </div>
        )}
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
            placeholder={
              dictation.transcribing
                ? "⌛ Transkribiere… der erkannte Text erscheint gleich hier"
                : `Nachricht an ${agent.label}…  (Enter senden · ⇧↵ Zeilenumbruch · + oder Drag&Drop für Dateien)`
            }
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="composer-file-input"
            onChange={(e) => void onPickFiles(e)}
            aria-hidden="true"
            tabIndex={-1}
          />
          <button
            type="button"
            className="composer-btn attach"
            title="Dateien & Bilder anhängen"
            aria-label="Dateien anhängen"
            onClick={() => fileInputRef.current?.click()}
          >
            +
          </button>
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
              disabled={!draft.trim() && attached.length === 0 && attachedFiles.length === 0}
              title="Senden"
              aria-label="Senden"
            >
              ↑
            </button>
          )}
        </form>
      </div>
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.confirmLabel}
          danger={confirm.danger}
          onConfirm={confirm.onConfirm}
          onClose={() => setConfirm(null)}
        />
      )}
    </section>
  );
}
