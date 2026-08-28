import { useLayoutEffect, useRef, useState } from "react";
import { Mic } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useStore } from "../store";
import type { AttachedFile, DevLogLine } from "../store";
import { STATUS_META } from "../status";
import { StatusDot } from "./StatusDot";
import { agentBadges, nextStep, unsavedWork, gateDisabledReason, syncDisabledReason } from "../derive";
import { ConfirmDialog } from "./ConfirmDialog";
import { saveNewStreamDraft, loadNewStreamDraft, draftHasContent } from "../newStreamDraft";
import { agentColor } from "../agentColor";
import { MessageTimeline } from "./MessageTimeline";
import { ModelEffortPicker } from "./ModelEffortPicker";
import { UsageMeter } from "./UsageMeter";
import { modelLabel } from "../modelCatalog";
import { PromptButton, PromptManagerDialog } from "./PromptLibrary";
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
  const outsourceMain = useStore((s) => s.outsourceMain);
  const commitMainRelease = useStore((s) => s.commitMainRelease);
  const updateMain = useStore((s) => s.updateMain);
  const resetMain = useStore((s) => s.resetMain);
  const pushMain = useStore((s) => s.pushMain);
  const continueStream = useStore((s) => s.continueStream);
  const integratePr = useStore((s) => s.integratePr);
  const runGate = useStore((s) => s.runGate);
  const startDevServer = useStore((s) => s.startDevServer);
  const stopDevServer = useStore((s) => s.stopDevServer);
  const configureDevServer = useStore((s) => s.configureDevServer);
  const mergeReview = useStore((s) => s.mergeReview);
  const closeReview = useStore((s) => s.closeReview);
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
  const setStreamAccount = useStore((s) => s.setStreamAccount);
  const accounts = useStore((s) => s.accounts);
  const accountUsage = useStore((s) => s.accountUsage);
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
  const [integratorGuard, setIntegratorGuard] = useState(false); // Rückfrage vor dem Senden an den Integrator (main)
  // Prompt-Verwaltungs-Dialog: HIER (außerhalb des Composer-<form>) gerendert, damit sein
  // Bearbeiten-Formular kein verschachteltes <form> im Composer wird.
  const [managePrompts, setManagePrompts] = useState(false);

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

  // Der eigentliche Versand (nach evtl. Guard). Datei-Anhänge (Nicht-Bilder) als lesbare Referenzen in
  // den Prompt hängen — der Agent liest sie über den Pfad (in `.mads/attachments/`, im cwd → keine Rückfrage).
  const doSend = () => {
    let text = draft.trim();
    if (attachedFiles.length) {
      const list = attachedFiles.map((f) => `- ${f.relPath}`).join("\n");
      text = `${text ? text + "\n\n" : ""}📎 Angehängte Dateien (bitte lesen):\n${list}`;
    }
    void sendInput(selectedId, text || "(siehe Anhang)", attached.length ? attached : undefined);
    setDraft(selectedId, "");
    setDraftImages(selectedId, []);
    setDraftFiles(selectedId, []);
  };

  // Integrator-Guard „Als Sub-Stream starten": den getippten Text in einen frischen Sub-Stream-Entwurf
  // legen und den „Neuer Stream"-Dialog vorbefüllt öffnen — so beginnt die Arbeit gleich im richtigen
  // Sub-Stream statt (versehentlich) auf main. VERLUSTFREI: liegt bereits ein (nicht gespeicherter)
  // „Neuer Stream"-Entwurf vor, wird er NICHT überschrieben — dann öffnet nur der Dialog, und der
  // Integrator-Text bleibt im Composer. Bild-/Datei-Anhänge bleiben ohnehin im Composer (der Dialog
  // kann sie nicht übernehmen). So geht in keinem Fall Text verloren.
  const redirectToSubStream = () => {
    const s = useStore.getState();
    const existing = loadNewStreamDraft();
    const hasPending = !!existing && draftHasContent({ label: existing.label ?? "", prompt: existing.prompt ?? "", branch: existing.branch ?? "" });
    if (!hasPending) {
      saveNewStreamDraft({ label: "", prompt: draft.trim(), role: "sub", model: s.defaultModel, effort: s.defaultEffort, branch: "", mode: "auto" });
      setDraft(selectedId, ""); // Text lebt jetzt im persistenten Entwurf → übersteht Abbrechen des Dialogs
    }
    s.requestNewStream();
  };

  const submit = (e?: { preventDefault: () => void }) => {
    e?.preventDefault();
    if (!draft.trim() && attached.length === 0 && attachedFiles.length === 0) return;
    // Guard gegen versehentliches Arbeiten im INTEGRATOR (main): er soll nur integrieren, nicht direkt
    // umsetzen — Umsetzungen gehören in einen Sub-Stream. Greift bei jedem TEXT an den Integrator
    // (nur-Anhänge ohne Text → direkt senden, ein Redirect wäre sinnlos). Der Integrator wartet
    // Rückfragen NICHT im Composer ab (das läuft über den Permission-/Frage-Dialog), daher keine
    // Status-Ausnahme. Beide Guard-Aktionen sind verlustfrei.
    if (agent.role === "integrator" && !!draft.trim()) {
      setIntegratorGuard(true);
      return;
    }
    doSend();
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
    else if (step.kind === "commit_release") askCommitRelease(); // Deploy-Fall: Release-Commit ist primär
    else if (step.kind === "cleanup") void stopAgent(selectedId, true); // bereits gemergt → sicher
  };

  // Gespeicherten Prompt in den Composer-ENTWURF einfügen (nie automatisch senden — der
  // Mensch liest und schickt selbst ab): leer → Text, sonst Entwurf + Leerzeile + Text.
  const insertPromptText = (text: string) => {
    const cur = draft;
    setDraft(selectedId, cur.trim() ? `${cur.replace(/\s+$/, "")}\n\n${text}` : text);
    composerRef.current?.focus();
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
          {/* Claude-Konto dieses Streams. Nur sichtbar, wenn überhaupt mehrere Konten eingerichtet
              sind — wer nur eines nutzt, soll keine sinnlose Auswahl sehen. Der Wechsel startet den
              Claude-Prozess im Zielkonto neu und setzt dieselbe Session per Resume fort. */}
          {live && !agent.mock && accounts && accounts.profiles.length > 1 && (
            <div
              className="insp-me"
              title="Claude-Konto NUR für diesen Stream. Beim Wechsel wird der Prozess im anderen Konto neu gestartet und dasselbe Gespräch fortgesetzt."
            >
              <span className="insp-me-label">Konto</span>
              {/* KEIN Fallback auf `accounts.activeId`: das ist das Standardkonto für NEUE Streams
                  und sagt nichts darüber, unter welchem Konto DIESER Prozess gestartet wurde. Der
                  Fallback behauptete ein Konto, das der Stream gar nicht benutzte — samt dessen
                  beruhigendem Verbrauchsbalken, während das echte Konto an sein Limit lief.
                  Unbekannt heißt jetzt unbekannt; der Sidecar bestätigt das reale Konto mit dem
                  nächsten status_update, dann steht es hier von selbst richtig. */}
              <select
                className="mode-select"
                value={agent.accountId ?? ""}
                onChange={(e) => void setStreamAccount(selectedId, e.target.value)}
              >
                {agent.accountId === undefined && (
                  <option value="" disabled>
                    — noch unbekannt
                  </option>
                )}
                {accounts.profiles.map((p) => {
                  const cd = accounts.cooldowns[p.id];
                  const blocked = !!cd && cd.rejected && cd.until > Date.now();
                  const until = cd ? new Date(cd.until).toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" }) : "";
                  // Laufender Verbrauch, sobald das SDK ihn für dieses Konto gemeldet hat. Erst damit
                  // sieht man das Limit KOMMEN statt es erst beim Anschlag zu bemerken.
                  const use = accountUsage[p.id];
                  // Im Menü das ENGSTE Fenster zeigen — das ist es, was zuerst blockiert.
                  const pct = [use?.fiveHour?.utilization, use?.sevenDay?.utilization].filter(
                    (v): v is number => v !== undefined,
                  );
                  const worst = pct.length ? Math.round(Math.max(...pct)) : undefined;
                  const suffix = blocked
                    ? ` — Limit bis ${until}`
                    : worst !== undefined
                      ? ` — ${worst}% verbraucht`
                      : "";
                  return (
                    <option key={p.id} value={p.id} title={p.email ?? p.configDir}>
                      {p.label}
                      {suffix}
                    </option>
                  );
                })}
              </select>
              {/* Plan-Nutzungslimits des gewählten Kontos — 5-Stunden- und Wochenfenster als Balken. */}
              <UsageMeter usage={agent.accountId ? accountUsage[agent.accountId] : undefined} />
            </div>
          )}
          {/* Doppel-Check: läuft der Stream real auf einem ANDEREN Modell als angefordert (stiller
              SDK-Default), das laut + sichtbar machen — der Picker allein spiegelt nur den Wunsch. */}
          {agent.modelMismatch && agent.activeModel && (
            <div
              className="insp-model-warn"
              title="Der SDK lief auf einem anderen Modell als angefordert. mads zieht automatisch nach — bei Bedarf im Picker erneut umstellen."
            >
              ⚠ läuft real auf {modelLabel(agent.activeModel)}
            </div>
          )}
          </div>
          {/* Cluster 2 — Aktions-Buttons (kontextabhängig). Bricht als eigene Einheit um. */}
          <div className="insp-ops">
          {/* Review-Stream (fremder PR, read-only): PR annehmen ODER verwerfen — KEIN „Fortsetzen"
              (es ist keine KI-Session). Dev-Server-Knopf steht separat weiter unten. */}
          {agent.reviewPr && (
            <>
              <button
                className="step-primary"
                title={`PR #${agent.reviewPr} squash-mergen und Review-Stream schließen`}
                onClick={() =>
                  setConfirm({
                    title: `PR #${agent.reviewPr} nach main mergen?`,
                    body: (
                      <p>
                        Squash-merged den fremden PR nach <code>main</code> und schließt den Review-Stream. Außen-sichtbar.
                        <br />
                        <small>Kein automatischer CI-Check — deine Prüfung (Dev-Server/Diff) entscheidet.</small>
                      </p>
                    ),
                    confirmLabel: "PR mergen",
                    onConfirm: () => void mergeReview(selectedId),
                  })
                }
              >
                ✓ PR #{agent.reviewPr} mergen
              </button>
              <button
                className="step-primary cleanup"
                title="Review verwerfen (Worktree entfernen) — der fremde PR bleibt unberührt"
                onClick={() => void closeReview(selectedId)}
              >
                ✕ Verwerfen
              </button>
            </>
          )}
          {/* Passiv wiederhergestellt → erst reaktivieren, bevor Git-Aktionen möglich sind.
              Beim INTEGRATOR (Leitstelle) erst rückfragen: reaktivieren kann sofort Aktionen
              auslösen (versehentliches „Fortsetzen" hat genau das getan). */}
          {!live && !agent.reviewPr && (
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
          {/* Deploy-Fall (main_deploy_dirty): „Als Release committen" ist die Primäraktion (oben) —
              das Auslagern in einen Sub-Stream bleibt als sekundäre Alternative erreichbar. */}
          {live && step.kind === "commit_release" && (
            <button
              title="Deine uncommitteten main-Änderungen stattdessen in einen neuen Sub-Stream verschieben (main bleibt sauber; normaler Commit→PR→Integrate-Fluss)."
              onClick={askOutsource}
            >
              In Sub-Stream auslagern
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
              // „unconfigured" gilt als AUS (nicht laufend) — sonst würde der Knopf fälschlich „stoppen".
              const on = !!ds && ds.state !== "stopped" && ds.state !== "error" && ds.state !== "unconfigured";
              // TEILWEISE: mindestens ein konfigurierter Dienst ist tot. Der Knopf darf dann NICHT
              // grün „läuft" behaupten — sonst sucht man den Fehler im eigenen Code, während in
              // Wahrheit z. B. das Frontend weg ist (und der Link auf die API zeigte).
              const degraded = ds?.state === "running" && ds.degraded;
              const label =
                ds?.state === "running"
                  ? degraded
                    ? `■ Dev-Server (teilweise${ds.deadServices?.length ? ` — ${ds.deadServices.join(", ")} aus` : ""})`
                    : "■ Dev-Server (läuft)"
                  : ds?.state === "installing"
                    ? "■ Dev-Server (install…)"
                    : ds?.state === "starting"
                      ? "■ Dev-Server (startet…)"
                      : "▶ Dev-Server";
              return (
                <>
                  <button
                    className={`devserver-btn${on ? " on" : ""}${degraded ? " degraded" : ""}`}
                    onClick={() => (on ? void stopDevServer(selectedId) : void startDevServer(selectedId))}
                    title={
                      degraded
                        ? `Nur teilweise gestartet — nicht (mehr) aktiv: ${ds?.deadServices?.join(", ")}. ` +
                          "Zum Neustarten hier stoppen und erneut starten."
                        : on
                          ? "Dev-Server dieses Streams stoppen"
                          : "Front-/Backend dieses Streams lokal starten (aus dem Worktree — main bleibt unberührt). Konfig: .mads/run.json"
                    }
                  >
                    {label}
                  </button>
                  {/* „Konfigurieren": öffnet .mads/run.json im Editor (mit erkannter Vorlage) — hier
                      konstruiert der Nutzer projekt-spezifisch, WAS beim Start passiert. Prominent bei
                      „unconfigured", sonst als dezenter Zahnrad-Knopf immer erreichbar. */}
                  <button
                    className={`devserver-config${ds?.state === "unconfigured" ? " prominent" : ""}`}
                    onClick={() => void configureDevServer(selectedId)}
                    title="Dev-Server einrichten/anpassen — .mads/run.json im Editor öffnen"
                  >
                    {ds?.state === "unconfigured" ? "⚙ Konfigurieren" : "⚙"}
                  </button>
                </>
              );
            })()
          )}
          {/* PRO DIENST ein eigener Indikator (frontend/backend). Der Sammel-Knopf allein log:
              „läuft" konnte heißen „Frontend oben, Backend kompiliert noch" — und das Login lief
              gegen ein Backend, das es noch nicht gab. Grün = am Port bestätigt, gelb = startet
              bzw. nur angenommen, rot = Prozess weg. */}
          {agent.role === "sub" &&
            ((agent.devServer?.services?.length ?? 0) > 1 || (agent.devServer?.dependencies?.length ?? 0) > 0) && (
              <span className="devsvc-row">
                {(agent.devServer?.services ?? []).map((sv) => {
                  // Eine fehlende Abhängigkeit schlägt alles andere: der Dienst lauscht zwar, kann aber
                  // nichts beantworten — das darf nie grün aussehen.
                  const cls = sv.depMissing ? "dead" : !sv.alive ? "dead" : sv.ready ? (sv.assumed ? "assumed" : "ok") : "starting";
                  const what = sv.depMissing
                    ? `läuft, aber Abhängigkeit fehlt: ${sv.depMissing}`
                    : !sv.alive
                      ? "läuft nicht (mehr)"
                      : sv.ready
                        ? sv.assumed
                          ? "vermutlich bereit (kein Port prüfbar)"
                          : "bereit — antwortet"
                        : "startet noch …";
                  return (
                    <span key={sv.name} className={`devsvc ${cls}`} title={`${sv.name}: ${what}${sv.url ? ` · ${sv.url}` : ""}`}>
                      <span className="devsvc-dot" />
                      {sv.name}
                    </span>
                  );
                })}
                {/* Dritter Indikator: externe Abhängigkeiten (DB/Cache aus docker-compose). Gestrichelt,
                    weil sie nicht mads gehören — aber ohne sie ist das Backend funktional tot. */}
                {(agent.devServer?.dependencies ?? []).map((d) => (
                  <span
                    key={d.target}
                    className={`devsvc dep ${d.ok ? "ok" : "dead"}`}
                    title={`${d.name} (${d.target}): ${d.ok ? "erreichbar" : "NICHT erreichbar — läuft Docker bzw. der Dienst?"}`}
                  >
                    <span className="devsvc-dot" />
                    {d.name}
                  </span>
                ))}
              </span>
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
          {/* Kein per-Stream-„Konflikt lösen" mehr: ein Sub-Stream sieht aus seiner Sandbox nur den
              eigenen Worktree und kann eine Lage ZWISCHEN Streams nicht beurteilen (er rebaset
              blind, während die anderen weiterarbeiten). Das übernimmt jetzt der übergreifende
              Knopf in der Activity-Rail, der alle Streams anhält und den Integrator beauftragt.
              Sub: rebase onto origin/<default> + force-with-lease. NIE für den Integrator —
              dessen „behind" betrifft den main-Checkout, der per fast-forward (nicht rebase!)
              nachgezogen wird. */}
          {live && agent.role === "sub" && (agent.behind > 0 || agent.syncBlocked) && (
            <button
              disabled={!!syncDisabledReason(agent)}
              onClick={() => void syncBranch(selectedId)}
              title={
                syncDisabledReason(agent) ??
                (agent.syncBlocked
                  ? "Auto-Sync ist wegen eines Konflikts pausiert. Über „Konflikt lösen“ in der Seitenleiste auflösen, dann erneut Sync."
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
          {live && agent.role === "integrator" && agent.ahead > 0 && (
            <button
              onClick={() => void pushMain(selectedId)}
              title={`Deine ${agent.ahead} lokale(n) Commit(s) auf main (z. B. Release-Version-Bumps) nach origin/main pushen — Fast-Forward, behält sie. Danach ist main in Sync.`}
            >
              nach main pushen ({agent.ahead})
            </button>
          )}
          {live && agent.role === "integrator" && agent.ahead > 0 && (
            <button
              className="danger"
              onClick={() =>
                setConfirm({
                  title: `${agent.ahead} lokale Commit(s) verwerfen?`,
                  body: (
                    <>
                      <p>
                        Dein <code>main</code>-Checkout ist <strong>{agent.ahead}</strong> lokale(n), nicht
                        gepushte(n) Commit(s) VORAUS. Diese werden <strong>verworfen</strong>, und <code>main</code>{" "}
                        wird hart auf <code>origin/main</code> gesetzt.
                      </p>
                      <p>
                        Ein Backup-Branch (<code>mads-backup/main-…</code>) wird vorher automatisch gesichert — die
                        Commits bleiben verlustfrei rückholbar.
                      </p>
                    </>
                  ),
                  confirmLabel: `${agent.ahead} verwerfen & auf origin setzen`,
                  danger: true,
                  onConfirm: () => void resetMain(selectedId),
                })
              }
              title={`Dein main-Checkout ist ${agent.ahead} lokale(n), nicht gepushte(n) Commit(s) VORAUS (die ein fast-forward nicht auflöst — z. B. Release-/Versions-Bumps). Hart auf origin zurücksetzen; ein Backup-Branch wird vorher gesichert.`}
            >
              main auf origin zurücksetzen ({agent.ahead})
            </button>
          )}
          {agent.pr && (
            <button onClick={() => void openUrl(agent.pr!.url)} title="PR auf GitHub öffnen">
              PR #{agent.pr.number} ↗
            </button>
          )}
          {agent.reviewPr ? (
            // Review-Stream: die generische „Stop" (pool-only stop_agent) greift hier NICHT und würde
            // den Worktree lecken + den PR dauerhaft ausblenden. Stattdessen der PR-Link; Verwerfen/Mergen
            // stehen unten als eigene Aktionen.
            agent.reviewUrl && (
              <button onClick={() => void openUrl(agent.reviewUrl!)} title="PR auf GitHub öffnen">
                PR #{agent.reviewPr} ↗
              </button>
            )
          ) : (
            <button
              className="danger"
              onClick={askStop}
              title="Stoppen + aufräumen (Worktree/Branch entfernen bei Sub)"
            >
              Stop
            </button>
          )}
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
            <span className={`devserver-dot ${agent.devServer?.degraded ? "degraded" : (agent.devServer?.state ?? "stopped")}`} />
            Dev-Server
            {agent.devServer?.state ? ` — ${agent.devServer.degraded ? "teilweise" : agent.devServer.state}` : ""}
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

      {Object.keys(agent.subAgents ?? {}).length > 0 && (
        <div className="subagents-panel">
          <div className="subagents-title">▶ Teil-Agenten · {Object.keys(agent.subAgents ?? {}).length} aktiv</div>
          {Object.values(agent.subAgents ?? {})
            .sort((a, b) => a.startedAt - b.startedAt)
            .map((sa) => (
              <div key={sa.id} className="subagent-row">
                <span className="subagent-dot" title="läuft" />
                <span className="subagent-label">{sa.label}</span>
                {sa.currentStep && <span className="subagent-step">{sa.currentStep}</span>}
              </div>
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
          {/* Prompt-Bibliothek: fügt kuratierte Prompts in den ENTWURF ein (nie Auto-Send). */}
          <PromptButton role={agent.role} onInsert={insertPromptText} onManage={() => setManagePrompts(true)} />
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
      {managePrompts && <PromptManagerDialog onClose={() => setManagePrompts(false)} />}
      {integratorGuard && (
        <ConfirmDialog
          title="Im Integrator (main) arbeiten?"
          confirmLabel="Als Sub-Stream starten"
          cancelLabel="Abbrechen"
          secondary={{ label: "An Integrator senden", onClick: doSend }}
          body={
            <>
              <p>
                Das ist der <b>Integrator</b> (main) — er soll nur <b>integrieren</b>, nicht direkt umsetzen.
                Umsetzungen gehören in einen Sub-Stream (main bleibt nur über grün-getestete PR-Merges aktuell).
              </p>
              <p>Deinen Text als neuen <b>Sub-Stream</b> starten — oder trotzdem an den Integrator senden?</p>
            </>
          }
          onConfirm={redirectToSubStream}
          onClose={() => setIntegratorGuard(false)}
        />
      )}
    </section>
  );
}
