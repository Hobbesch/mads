import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useStore } from "./store";
import { ensureNotificationPermission } from "./osNotify";
import { ActivityRail } from "./components/ActivityRail";
import { PrimaryPanel } from "./components/PrimaryPanel";
import { ChangeOverlay } from "./components/ChangeOverlay";
import { AgentGrid } from "./components/AgentGrid";
import { IntegrationPanel } from "./components/IntegrationPanel";
import { Inspector } from "./components/Inspector";
import { PermissionDialog } from "./components/PermissionDialog";
import { NewStreamDialog } from "./components/NewStreamDialog";
import { AboutDialog } from "./components/AboutDialog";
import { ParallelDialog } from "./components/ParallelDialog";
import { SaveToast } from "./components/SaveToast";
import { StalenessBanner } from "./components/StalenessBanner";
import { ConfirmDialog } from "./components/ConfirmDialog";
import "./App.css";

/** Status, die einen aktiven Stream markieren — vor dem Schließen des Hauptfensters wird davor gewarnt. */
const ACTIVE_ON_CLOSE = new Set(["starting", "running", "waiting_input", "escalation"]);

export default function App() {
  const init = useStore((s) => s.init);
  const escalations = useStore((s) => s.escalations);
  const sidecar = useStore((s) => s.sidecar);
  const project = useStore((s) => s.project);
  const projectLocked = useStore((s) => s.projectLocked);
  const pollProject = useStore((s) => s.pollProject);
  const resumables = useStore((s) => s.resumables);
  const resumeAgent = useStore((s) => s.resumeAgent);
  const resumeAll = useStore((s) => s.resumeAll);
  const cleanupResumable = useStore((s) => s.cleanupResumable);
  const reconcileSummary = useStore((s) => s.reconcileSummary);
  const dismissReconcile = useStore((s) => s.dismissReconcile);
  const collisions = useStore((s) => s.collisions);
  const autonomy = useStore((s) => s.autonomy);
  const setAutonomy = useStore((s) => s.setAutonomy);
  const exportHandoff = useStore((s) => s.exportHandoff);
  const importHandoff = useStore((s) => s.importHandoff);
  const handoff = useStore((s) => s.handoff);
  const dismissHandoff = useStore((s) => s.dismissHandoff);
  const openRecentProject = useStore((s) => s.openRecentProject);
  const newStreamRequested = useStore((s) => s.newStreamRequested);
  const [showNew, setShowNew] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  // Sicherheits-Rückfrage vor dem Schließen des Hauptfensters (aktive Streams / ungesendeter Entwurf).
  const [closeGuard, setCloseGuard] = useState<{ activeCount: number; hasDraft: boolean } | null>(null);

  useEffect(() => {
    void init();
  }, [init]);

  // Globaler Drag&Drop-Schutz: bei `dragDropEnabled:false` würde der Browser eine ausserhalb des
  // Composers fallengelassene Datei ÖFFNEN (Webview navigiert weg → App weg). Fenster-weit
  // preventDefault; der Composer-Drop fängt seinen Drop vorher selbst (Element vor Window im Bubble).
  useEffect(() => {
    const stop = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragover", stop);
      window.removeEventListener("drop", stop);
    };
  }, []);

  useEffect(() => {
    const unlisten = listen("show-about", () => setShowAbout(true));
    return () => {
      void unlisten.then((un) => un());
    };
  }, []);

  // Sicherheits-Warnung vor dem Schließen des HAUPTFENSTERS: laufen noch Streams ODER steht
  // ungesendeter Text/Anhang im Composer, erst rückfragen — sonst geht der (nur im Fenster gehaltene)
  // Composer-Entwurf verloren. Nur das Hauptfenster rendert <App/>, der Handler greift also
  // ausschließlich hier; losgelöste Markdown-Fenster (md-*) sind unberührt. preventDefault MUSS synchron
  // vor jedem await passieren (sonst schließt das Fenster trotzdem) → State erst danach setzen.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        const s = useStore.getState();
        const activeCount = s.order.reduce((n, id) => {
          const a = s.agents[id];
          return a && ACTIVE_ON_CLOSE.has(a.status) ? n + 1 : n;
        }, 0);
        const hasDraft =
          Object.values(s.drafts).some((t) => (t ?? "").trim().length > 0) ||
          Object.values(s.draftImages).some((imgs) => (imgs?.length ?? 0) > 0) ||
          Object.values(s.draftFiles).some((f) => (f?.length ?? 0) > 0);
        if (activeCount === 0 && !hasDraft) return; // nichts zu verlieren → normal schließen
        event.preventDefault(); // Schließen abfangen; erst nach Bestätigung wirklich zerstören
        setCloseGuard({ activeCount, hasDraft });
      })
      .then((un) => {
        if (disposed) un();
        else unlisten = un;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Activity-Rail-Shortcuts (doc 10 §8) — MVP rein im Frontend (keine Core-Änderung):
  // ⌘1 Streams · ⌘2 Dateien · ⌘, Einstellungen · ⌃⌘B Rail ein/aus · ⇧⌘D Änderungen-Toggle.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if (e.metaKey && e.ctrlKey && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        s.toggleRailCollapsed();
      } else if (e.metaKey && e.shiftKey && (e.key === "d" || e.key === "D")) {
        if (!s.project) return;
        e.preventDefault();
        s.toggleChangeOverview();
      } else if (e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key === "1") {
          e.preventDefault();
          s.setActiveView("streams");
        } else if (e.key === "2") {
          if (!s.project) return; // "Dateien" ohne Projekt deaktiviert
          e.preventDefault();
          s.setActiveView("files");
        } else if (e.key === ",") {
          e.preventDefault();
          s.setActiveView("settings");
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Beim Start die macOS-Benachrichtigungs-Erlaubnis einholen → Rückfragen können mit Ton gemeldet
  // werden, wenn das mads-Fenster nicht im Vordergrund ist.
  useEffect(() => {
    void ensureNotificationPermission();
  }, []);

  // Spracheingabe-Hotkey: ⇧Leertaste = Push-to-talk (halten). Im Composer-Textarea wird
  // die Leertaste abgefangen (kein Leerzeichen); in ANDEREN Editierfeldern (CodeMirror,
  // Datei-Filter …) NICHT gekapert, damit dort normal getippt werden kann.
  const pttActive = useRef(false); // eine PTT-Aufnahme läuft (Backend nimmt auf)
  const pttHeld = useRef(false); // Shift+Space als Hotkey erkannt UND Leertaste noch gehalten
  const pttArmTimer = useRef<number | null>(null); // Timer bis zur Aufnahme-Armierung (Tipp-Schutz)
  useEffect(() => {
    // Shift+Space nimmt erst nach dieser Halte-Schwelle auf. Ein flüchtiges Shift+Space beim schnellen
    // Tippen (Shift für den nächsten Großbuchstaben überlappt mit dem Space des vorigen Worts) ist
    // kürzer → löst KEINE Aufnahme aus. Sonst nahm Whisper Mini-/Leer-Audio auf und halluzinierte
    // YouTube-Floskeln wie „Thank you" in den Composer (+ kurz die rote „Aufnahme läuft"-Anzeige).
    const PTT_ARM_MS = 250;
    const editable = (el: Element | null): boolean => {
      if (!el) return false;
      const h = el as HTMLElement;
      if (h.isContentEditable) return true; // CodeMirror (cm-content)
      const tag = h.tagName;
      return tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT";
    };
    const shouldHandle = (): boolean => {
      const s = useStore.getState();
      if (!s.selectedId) return false;
      const ae = document.activeElement;
      if (ae && (ae as HTMLElement).classList?.contains("composer-input")) return true; // Composer → diktieren
      return !editable(ae); // anderes Eingabefeld → nicht kapern; sonst (Body etc.) → ja
    };
    // PTT-Latch zurücksetzen (Fokusverlust): sonst bleibt `pttHeld`/`pttActive` hängen,
    // weil das Space-keyup an die andere App/Spotlight geht und nie bei uns ankommt —
    // dann würde JEDES spätere Leerzeichen für immer geschluckt. visibilitychange(hidden)
    // statt `blur`, damit der erstmalige Mikrofon-TCC-Dialog (App bleibt sichtbar) die
    // laufende Aufnahme nicht abwürgt.
    const resetLatch = () => {
      if (pttArmTimer.current !== null) {
        clearTimeout(pttArmTimer.current);
        pttArmTimer.current = null;
      }
      const wasRecording = pttActive.current;
      pttActive.current = false;
      pttHeld.current = false;
      if (wasRecording) void useStore.getState().stopDictation();
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      if (e.isComposing || e.keyCode === 229) return; // IME-Komposition: Space gehört dem Editor
      // Hotkey erkannt & Leertaste wird gehalten (auch nach Shift-Loslassen / während
      // Download/Transkription): JEDES Space-keydown schlucken, inkl. OS-Auto-Repeats.
      if (pttActive.current || pttHeld.current) {
        e.preventDefault();
        return;
      }
      // Hotkey nur im Composer / außerhalb anderer Eingabefelder kapern.
      if (!e.shiftKey || !shouldHandle()) return;
      pttHeld.current = true; // ab jetzt schluckt der Guard oben alle Repeats, egal ob Shift noch hält
      // Das ERSTE Space im Composer durchlassen: erweist sich das Shift+Space als bloßes Tippen (vor
      // der Armierung losgelassen), hat der Nutzer sein Leerzeichen an der richtigen Stelle. Außerhalb
      // des Composers (Body) preventDefault, sonst scrollt Space die Seite. Auto-Repeats fängt der
      // Guard oben (pttHeld) ab, sobald die Aufnahme läuft.
      const inComposer = (document.activeElement as HTMLElement | null)?.classList?.contains("composer-input");
      if (!inComposer) e.preventDefault();
      if (e.repeat) return;
      const s = useStore.getState();
      if (s.dictation.recording || s.dictation.transcribing || s.whisper.downloading) return; // busy: nur schlucken
      // Erst nach der Halte-Schwelle wirklich aufnehmen (Tipp-Schutz, siehe PTT_ARM_MS).
      pttArmTimer.current = window.setTimeout(() => {
        pttArmTimer.current = null;
        pttActive.current = true;
        void useStore.getState().startDictation();
      }, PTT_ARM_MS);
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code !== "Space" || (!pttActive.current && !pttHeld.current)) return;
      const wasRecording = pttActive.current;
      pttActive.current = false;
      pttHeld.current = false;
      e.preventDefault();
      if (pttArmTimer.current !== null) {
        // Vor der Armierung losgelassen = flüchtiges Shift+Space (Tippen), keine PTT-Absicht:
        // Aufnahme nie starten. Das Leerzeichen ging im Composer bereits durch.
        clearTimeout(pttArmTimer.current);
        pttArmTimer.current = null;
        return;
      }
      if (wasRecording) void useStore.getState().stopDictation();
    };
    const onVisibility = () => {
      if (document.hidden) resetLatch();
    };
    // Capture-Phase, damit ein upstream stopPropagation (React/CodeMirror) den Hotkey
    // nicht aushebeln kann.
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const lastEscalation = escalations[escalations.length - 1];
  const defaultBranch = project?.defaultBranch ?? "main";
  // Echt fortsetzbare Streams vs. erledigte (gemergte) mit lokalen Resten → getrennt anbieten.
  const liveResumables = resumables.filter((r) => !r.merged);
  const doneResumables = resumables.filter((r) => r.merged);
  const wasRunning = (r: { status: string }) => r.status === "running" || r.status === "starting";
  // Beim Shutdown unterbrochene (laufende) Streams — nur die werden gesammelt fortgesetzt.
  const interrupted = liveResumables.filter(wasRunning);

  return (
    <div className="app">
      <ActivityRail onNewStream={() => setShowNew(true)} onAbout={() => setShowAbout(true)} />
      <PrimaryPanel />

      <div className="main">
        <div className="titlebar" data-tauri-drag-region>
          <div className="titlebar-title" data-tauri-drag-region>
            Dashboard
          </div>
          <div className="titlebar-right">
            {/* Versions-Pille entfernt (redundant — Version/Commit stehen in „Über mads"). */}
            {project && <span className="pill repo">{project.owner}/{project.repo}</span>}
            <span className={`pill ${sidecar.status}`}>
              {sidecar.status === "ready"
                ? sidecar.sdkAvailable
                  ? "Claude SDK bereit"
                  : "Mock-Modus"
                : sidecar.status}
            </span>
            {project && (
              <>
                <button
                  className={`toggle ${autonomy.autoSync ? "on" : ""}`}
                  onClick={() => void setAutonomy({ ...autonomy, autoSync: !autonomy.autoSync })}
                  title="Sub-Branches automatisch onto origin/main rebasen"
                >
                  Auto-Sync {autonomy.autoSync ? "an" : "aus"}
                </button>
                <button
                  className={`toggle ${autonomy.collisionScan ? "on" : ""}`}
                  onClick={() => void setAutonomy({ ...autonomy, collisionScan: !autonomy.collisionScan })}
                  title="Code-Kollisionen zwischen aktiven Agenten erkennen"
                >
                  Kollisions-Scan {autonomy.collisionScan ? "an" : "aus"}
                </button>
                <button onClick={() => void pollProject()} title="Git-/PR-Status jetzt aktualisieren">
                  ↻
                </button>
              </>
            )}
            <button
              onClick={() => void importHandoff()}
              title="Stand von einem anderen Rechner importieren (Handoff-Datei .tar.gz)"
            >
              ⤒ Import
            </button>
            {project && (
              <button
                onClick={() => void exportHandoff()}
                title="Kompletten Stand (alle Streams: Code, Verlauf, Sessions) als Datei exportieren"
              >
                ⤓ Export
              </button>
            )}
            <button className="primary" onClick={() => setShowNew(true)}>
              + Neuer Stream
            </button>
          </div>
        </div>

        {projectLocked && (
          <div className="escalation-banner">
            <span className="escalation-text">
              ⚠ „{projectLocked.repoRoot.split("/").filter(Boolean).pop()}" ist bereits in einem anderen
              mads-Fenster geöffnet — ein Projekt kann nur in einem Fenster gleichzeitig offen sein.
              {project ? " Du arbeitest weiter im aktuellen Projekt." : " Wähle über den Projekt-Knopf ein anderes."}
            </span>
            <button
              className="banner-action"
              title="Lock ignorieren und hier öffnen — nur, wenn das andere Fenster hängt/geschlossen ist (kann Doppel-Öffnen erzwingen)."
              onClick={() => void useStore.getState().openRecentProject(projectLocked.repoRoot, true)}
            >
              Trotzdem hier öffnen
            </button>
            <button
              className="banner-close"
              title="Hinweis schließen"
              aria-label="Hinweis schließen"
              onClick={() => useStore.setState({ projectLocked: undefined })}
            >
              ✕
            </button>
          </div>
        )}

        {lastEscalation && (
          <div className="escalation-banner">
            <span className="escalation-text">
              ▲ Eskalation ({lastEscalation.code}): {lastEscalation.message}
            </span>
            <button
              className="banner-close"
              title="Eskalationen schließen"
              aria-label="Eskalationen schließen"
              onClick={() => useStore.getState().dismissEscalations()}
            >
              ✕
            </button>
          </div>
        )}

        <StalenessBanner />

        {reconcileSummary &&
          (() => {
            const rc = reconcileSummary;
            const hasGit = rc.mainFastForwarded > 0 || rc.cleaned.length > 0 || rc.residue.length > 0 || rc.mainBehind > 0;
            const seed = rc.seedGenerated ?? 0;
            return (
              <div className={`reconcile-banner${rc.mainBehind > 0 ? " warn" : ""}`}>
                <span className="reconcile-text">
                  {hasGit && (
                    <>
                      ↻ GitHub-Abgleich:
                      {rc.mainFastForwarded > 0 && ` ${defaultBranch} +${rc.mainFastForwarded} aktualisiert`}
                      {rc.cleaned.length > 0 &&
                        `${rc.mainFastForwarded > 0 ? " · " : " "}${rc.cleaned.length} erledigte aufgeräumt (${rc.cleaned.join(", ")})`}
                      {rc.residue.length > 0 && ` · ${rc.residue.length} gemergt mit lokalen Resten — bitte prüfen`}
                      {rc.mainBehind > 0 &&
                        ` ⚠ ${defaultBranch} ist ${rc.mainBehind} Commits hinter origin/${defaultBranch} und konnte nicht automatisch nachgezogen werden (${
                          rc.mainBlocked === "dirty"
                            ? "uncommittete Änderungen"
                            : rc.mainBlocked === "diverged"
                              ? "lokale Commits / divergiert"
                              : rc.mainBlocked === "detached"
                                ? "detached HEAD"
                                : "Grund unbekannt"
                        }) — im Integrator-Stream „main aktualisieren"`}
                    </>
                  )}
                  {seed > 0 &&
                    `${hasGit ? " · " : ""}📦 ${seed} lokale Config-Datei(en) erkannt → werden in neue Streams kopiert (.mads/worktree-seed)`}
                </span>
                <button
                  className="banner-close"
                  title="Hinweis schließen"
                  aria-label="Hinweis schließen"
                  onClick={() => dismissReconcile()}
                >
                  ✕
                </button>
              </div>
            );
          })()}

        {liveResumables.length > 0 && (
          <div className="resume-banner">
            <span className="resume-label">↩︎ {liveResumables.length} Stream(s) fortsetzbar:</span>
            {liveResumables.map((r) => {
              const running = wasRunning(r);
              return (
                <button
                  key={r.agentId}
                  className={running ? "was-running" : ""}
                  onClick={() => void resumeAgent(r)}
                  title={
                    running
                      ? "Lief beim Beenden — Arbeit fortsetzen"
                      : r.sessionId
                        ? "War pausiert/wartend — Session fortsetzen"
                        : "Frischer Start im bestehenden Worktree"
                  }
                >
                  {running ? "● " : ""}
                  {r.label}
                  {r.branch ? ` · ${r.branch}` : ""}
                  {!r.sessionId ? " ⟲" : ""}
                </button>
              );
            })}
            {interrupted.length > 0 && (
              <button
                className="resume-all"
                onClick={() => void resumeAll()}
                title="Nur die beim Beenden laufenden (unterbrochenen) Streams fortsetzen"
              >
                Unterbrochene fortsetzen ({interrupted.length})
              </button>
            )}
          </div>
        )}

        {handoff && (
          <div className="reconcile-banner">
            <span className="reconcile-text">
              {handoff.action === "export" ? "📦 Export" : "📥 Import"}
              {handoff.ok ? " ✓ " : " ⚠ "}
              {handoff.message}
              {handoff.ok && handoff.action === "export" && handoff.path ? ` → ${handoff.path}` : ""}
            </span>
            {handoff.ok && handoff.action === "import" && handoff.repoRoot && (
              <button
                className="banner-action"
                onClick={() => {
                  const r = handoff.repoRoot!;
                  dismissHandoff();
                  void openRecentProject(r);
                }}
              >
                Projekt öffnen
              </button>
            )}
            {handoff.ok && handoff.action === "export" && handoff.path && (
              <button className="banner-action" onClick={() => void revealItemInDir(handoff.path!)}>
                Im Finder zeigen
              </button>
            )}
            <button className="banner-action" onClick={() => dismissHandoff()}>
              ✕
            </button>
          </div>
        )}

        {doneResumables.length > 0 && (
          <div className="resume-banner done">
            <span className="resume-label">✔ {doneResumables.length} erledigt (gemergt) — mit lokalen Resten:</span>
            {doneResumables.map((r) => (
              <button
                key={r.agentId}
                className="resume-cleanup"
                title="PR ist gemergt, aber der lokale Worktree hat ungespeicherte/ungepushte Änderungen. Aufräumen verwirft diese Reste (Worktree + lokaler Branch werden entfernt)."
                onClick={() => {
                  if (
                    window.confirm(
                      `„${r.label}" ist auf GitHub gemergt${r.prNumber ? ` (PR #${r.prNumber})` : ""}, hat aber lokale Reste (ungespeicherte/ungepushte Änderungen).\n\nAufräumen entfernt Worktree + lokalen Branch und verwirft diese Reste. Fortfahren?`,
                    )
                  )
                    void cleanupResumable(r);
                }}
              >
                Aufräumen: {r.label}
                {r.branch ? ` · ${r.branch}` : ""}
              </button>
            ))}
          </div>
        )}

        {collisions.length > 0 && (
          <div className="collision-banner">
            <span className="collision-label">⚠︎ {collisions.length} mögliche Code-Kollision(en):</span>
            {collisions.map((c, i) => (
              <span key={i} className="collision-item">
                {c.labelA} ⟷ {c.labelB} · {c.path}
                {c.symbols?.length ? `:${c.symbols.join(",")}` : c.severity === "file" ? " (gleiche Datei)" : ""}
              </span>
            ))}
          </div>
        )}

        <div className="body">
          <div className="center">
            <IntegrationPanel />
            <div className="center-title">Aktive Agenten</div>
            <AgentGrid />
          </div>
          <Inspector />
        </div>
      </div>

      {(showNew || newStreamRequested) && (
        <NewStreamDialog
          onClose={() => {
            setShowNew(false);
            if (newStreamRequested) useStore.setState({ newStreamRequested: false });
          }}
        />
      )}
      {showAbout && <AboutDialog onClose={() => setShowAbout(false)} />}
      {closeGuard && (
        <ConfirmDialog
          title="mads-Hauptfenster schließen?"
          danger
          confirmLabel="Trotzdem schließen"
          cancelLabel="Offen lassen"
          body={
            <>
              {closeGuard.hasDraft && (
                <p>Im Composer steht ungesendeter Text/Anhang — beim Schließen geht er verloren.</p>
              )}
              {closeGuard.activeCount > 0 && (
                <p>
                  {closeGuard.activeCount === 1
                    ? "1 Stream ist noch aktiv"
                    : `${closeGuard.activeCount} Streams sind noch aktiv`}{" "}
                  — läuft im Hintergrund weiter, aber das Fenster verschwindet.
                </p>
              )}
              <p>Zurückholen später über „Fenster → Hauptfenster" (⌘0) oder das Dock-Icon.</p>
            </>
          }
          onConfirm={() => void getCurrentWindow().destroy()}
          onClose={() => setCloseGuard(null)}
        />
      )}
      <PermissionDialog />
      <ParallelDialog />
      <ChangeOverlay />
      <SaveToast />
    </div>
  );
}
