import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import type { AgentRole } from "../store";
import type { PermissionMode, EffortMode, ImageInput } from "../../shared/protocol";
import { ModelEffortPicker } from "./ModelEffortPicker";
import { clampEffort, defaultEffortForModel } from "../modelCatalog";
import { loadNewStreamDraft, saveNewStreamDraft, clearNewStreamDraft, draftHasContent } from "../newStreamDraft";
import { blobToBase64, makeThumbnail } from "../blob";

export function NewStreamDialog({ onClose }: { onClose: () => void }) {
  const createAgent = useStore((s) => s.createAgent);
  const sdkAvailable = useStore((s) => s.sidecar.sdkAvailable);
  const project = useStore((s) => s.project);
  const hasIntegrator = useStore((s) => Object.values(s.agents).some((a) => a.role === "integrator"));
  const defaultModel = useStore((s) => s.defaultModel);
  const defaultEffort = useStore((s) => s.defaultEffort);
  const accounts = useStore((s) => s.accounts);
  const accountUsage = useStore((s) => s.accountUsage);

  // Beim Öffnen einen zuvor auto-gespeicherten Entwurf wiederherstellen (überlebt Fehlklick/Neustart).
  const draft = useRef(loadNewStreamDraft()).current;
  const [label, setLabel] = useState(draft?.label ?? "");
  const [prompt, setPrompt] = useState(draft?.prompt ?? "");
  const initialRole = draft?.role ?? (hasIntegrator ? "sub" : "integrator");
  const [role, setRole] = useState<AgentRole>(initialRole);
  // Modell + Effort kommen aus dem globalen Default der linken Navigation — für JEDE Rolle gleich
  // (keine stille Sonderbehandlung für Sub-Agents mehr, die den Rail-Regler überschrieb). Nur ein
  // Vorschlag: im Picker direkt darunter frei änderbar.
  const initialModel = draft?.model ?? defaultModel;
  const [model, setModel] = useState(initialModel);
  const [effort, setEffort] = useState<EffortMode | undefined>(
    draft?.effort ?? defaultEffortForModel(initialModel, defaultEffort),
  );
  const [branch, setBranch] = useState(draft?.branch ?? "");
  const [mode, setMode] = useState<PermissionMode>(draft?.mode ?? "auto");
  const [mock, setMock] = useState(!sdkAvailable || !project);
  // Screenshots zum initialen Prompt — bewusst NICHT im (localStorage-)Entwurf persistiert (Base64
  // würde die Quota sprengen); überlebt also nur, solange der Dialog offen bleibt.
  const [images, setImages] = useState<ImageInput[]>([]);
  const [dragging, setDragging] = useState(false);
  // Konto für diesen Stream — vorbelegt mit dem globalen Default, hier überschreibbar.
  const [account, setAccount] = useState(accounts?.activeId ?? "");
  // Wurde beim Öffnen ein Entwurf mit Inhalt wiederhergestellt? → sichtbarer Hinweis + „Verwerfen".
  const [showRestored, setShowRestored] = useState(
    !!draft && draftHasContent({ label: draft.label ?? "", prompt: draft.prompt ?? "", branch: draft.branch ?? "" }),
  );

  const discardDraft = () => {
    setLabel("");
    setPrompt("");
    setBranch("");
    setImages([]);
    const r = hasIntegrator ? "sub" : "integrator";
    setRole(r);
    setModel(defaultModel);
    setEffort(defaultEffortForModel(defaultModel, defaultEffort));
    setMode("auto");
    clearNewStreamDraft();
    setShowRestored(false);
  };

  // Auto-Speichern: jede Feldänderung sichert den Entwurf sofort in localStorage. So kostet KEIN
  // Schließweg (Backdrop, Escape, Abbrechen, App-Neustart) den Text — erst der Submit räumt ihn ab.
  useEffect(() => {
    saveNewStreamDraft({ label, prompt, role, model, effort, branch, mode });
  }, [label, prompt, role, model, effort, branch, mode]);

  const dirty = draftHasContent({ label, prompt, branch }) || images.length > 0;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const l = label.trim() || (role === "integrator" ? "Main-Agent" : "Sub-Agent");
    // Leere Aufgabe (kein Text, kein Bild) NICHT mehr durch einen Platzhalter ersetzen — der Stream
    // entsteht dann still (Worktree/Session), ohne dass Claude sofort losarbeitet. Die eigentliche
    // Aufgabe kommt in diesem Fall als erste Nachricht im normalen Chat-Input (leistungsfähiger, u.a.
    // Bild-Paste geht dort ohnehin schon).
    void createAgent({
      label: l,
      prompt: prompt.trim(),
      role,
      mock,
      model,
      effort,
      branch: branch.trim() || undefined,
      permissionMode: mode,
      images: images.length ? images : undefined,
      // Dasselbe wie im Auswahlfeld angezeigt (dort `account || accounts.activeId`) — nicht
      // `account || undefined`: das überliess die Wahl still dem Sidecar, obwohl das Feld bereits
      // ein konkretes Konto behauptete.
      accountId: account || accounts?.activeId,
    });
    clearNewStreamDraft(); // Entwurf verbraucht → aufräumen
    onClose();
  };

  // Bild-Dateien (Paste ODER Drag&Drop) übernehmen — dieselbe Umwandlung wie im Composer (Inspector.tsx),
  // hier aber in lokalen State statt in den (noch nicht existierenden) Agent-Draft.
  const attachImageFiles = async (files: File[]) => {
    const imgs: ImageInput[] = [];
    for (const f of files) {
      if (!f.type.startsWith("image/")) continue;
      const thumb = await makeThumbnail(f);
      imgs.push({ mediaType: f.type || "image/png", dataBase64: await blobToBase64(f), ...thumb });
    }
    if (imgs.length) setImages((prev) => [...prev, ...imgs]);
  };

  const onPromptPaste = async (e: React.ClipboardEvent) => {
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

  const onPromptDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = e.dataTransfer?.files;
    if (files && files.length) await attachImageFiles(Array.from(files));
  };

  // Escape schließt den Dialog — der Entwurf bleibt gespeichert und ist beim nächsten Öffnen wieder da.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const realSubNeedsProject = role === "sub" && !mock && !project;

  // Backdrop-Klick schließt — ABER nur, wenn Maus-Druck UND -Loslassen beide auf dem Overlay
  // waren. Sonst beendet eine Textmarkierung im Prompt (Drag, der auf dem Overlay endet) den
  // Dialog ungewollt: das `click`-Event zielt dann auf den gemeinsamen Vorfahren (= Overlay),
  // läuft also am `stopPropagation` des Formulars vorbei.
  const downOnOverlay = useRef(false);

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        downOnOverlay.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // Ein echter Backdrop-Klick schließt NUR, wenn nichts eingetippt ist. Sobald der Nutzer Inhalt
        // hat, ignorieren wir den Klick (der gemeldete Datenverlust): der Dialog bleibt offen, statt
        // spurlos zu verschwinden. Bewusstes Verlassen geht weiter über „Abbrechen" oder Escape (der
        // Entwurf bleibt dabei gespeichert und kehrt beim nächsten Öffnen zurück).
        if (downOnOverlay.current && e.target === e.currentTarget && !dirty) onClose();
      }}
    >
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="modal-title">Neuer Entwicklungs-Stream</div>

        {showRestored && (
          <div className="modal-hint draft-restored">
            ↩ Wiederhergestellter Entwurf.{" "}
            <button type="button" className="linklike" onClick={discardDraft}>
              Verwerfen
            </button>
          </div>
        )}

        {!project && (
          <div className="modal-hint">
            Kein Projekt geöffnet — echte Agenten brauchen ein Repo (links „Projekt öffnen"). Ohne Projekt nur Mock.
          </div>
        )}

        <label className="field">
          <span>Bezeichnung</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="z. B. Login-Formular" autoFocus />
        </label>

        <label className="field">
          <span>Aufgabe (initialer Prompt)</span>
          <div
            className={`composer-wrap${dragging ? " dragover" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              if (!dragging) setDragging(true);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
            }}
            onDrop={(e) => void onPromptDrop(e)}
          >
            {dragging && <div className="composer-drophint">Screenshot hier ablegen zum Anhängen</div>}
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onPaste={(e) => void onPromptPaste(e)}
              rows={3}
              placeholder="Was soll dieser Agent tun? Leer lassen = Stream wird angelegt, aber wartet auf deine erste Nachricht im Chat. Screenshots per Einfügen/Ziehen anhängen."
            />
            {images.length > 0 && (
              <div className="composer-attachments">
                {images.map((im, i) => (
                  <div key={`img-${i}`} className="thumb">
                    <img src={`data:${im.mediaType};base64,${im.dataBase64}`} alt="Anhang" />
                    <button type="button" onClick={() => setImages(images.filter((_, j) => j !== i))}>
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </label>

        {/* Konto für DIESEN Stream. Vorbelegt mit dem globalen Default (linke Leiste), hier
            überschreibbar — so muss man den Default nicht umstellen, nur weil ein einzelner Stream
            auf dem anderen Konto laufen soll. */}
        {accounts && accounts.profiles.length > 1 && (
          <label className="field">
            <span>Claude-Konto</span>
            {/* `account` bleibt leer, wenn die Registry beim Öffnen noch nicht geladen war — dann
                gilt der aktuelle Default. Wichtig: GENAU dieser Wert geht auch ab (siehe
                handleSubmit). Anzeige und gesendeter Wert dürfen nie auseinanderlaufen, sonst
                behauptet der Dialog ein Konto und der Stream startet auf einem anderen. */}
            <select value={account || accounts.activeId} onChange={(e) => setAccount(e.target.value)}>
              {accounts.profiles.map((p) => {
                const cd = accounts.cooldowns[p.id];
                const blocked = !!cd && cd.rejected && cd.until > Date.now();
                const use = accountUsage[p.id];
                const vals = [use?.fiveHour?.utilization, use?.sevenDay?.utilization].filter(
                  (v): v is number => v !== undefined,
                );
                const worst = vals.length ? Math.round(Math.max(...vals)) : undefined;
                return (
                  <option key={p.id} value={p.id} title={p.email ?? p.configDir}>
                    {p.label}
                    {blocked
                      ? ` — Limit erreicht${cd ? ` bis ${new Date(cd.until).toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" })}` : ""}`
                      : worst !== undefined
                        ? ` — ${worst}% verbraucht`
                        : ""}
                  </option>
                );
              })}
            </select>
          </label>
        )}

        <label className="field">
          <span>Rolle</span>
          <select
            value={role}
            onChange={(e) => {
              // Modell/Effort bleiben unangetastet: sie hängen nicht mehr an der Rolle, und ein
              // Rollenwechsel darf eine bereits getroffene Picker-Wahl nicht wieder wegwerfen.
              setRole(e.target.value as AgentRole);
            }}
          >
            <option value="integrator" disabled={hasIntegrator}>
              Integrator (Main){hasIntegrator ? " — existiert" : ""}
            </option>
            <option value="sub">Sub-Agent</option>
          </select>
        </label>

        <label className="field">
          <span>Modell &amp; Effort</span>
          <ModelEffortPicker
            model={model}
            effort={effort}
            onModel={(m) => {
              setModel(m);
              setEffort(clampEffort(m, effort));
            }}
            onEffort={setEffort}
            variant="dialog"
          />
        </label>

        <label className="field">
          <span>Permission-Modus</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as PermissionMode)}>
            <option value="default">Standard — fragt vor jeder Aktion</option>
            <option value="acceptEdits">Auto-Edits — Datei-Edits ohne Nachfrage</option>
            <option value="plan">Plan — nur lesen/planen</option>
            <option value="auto">Auto — liest & ändert selbst, fragt nur bei Push/PR/Löschen/Netz</option>
            <option value="bypassPermissions">Bypass — alles ohne Nachfrage</option>
          </select>
        </label>

        {role === "sub" && !mock && (
          <label className="field">
            <span>Branch (leer = automatisch aus Bezeichnung)</span>
            <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="mads/login-formular" />
          </label>
        )}

        <label className="checkbox">
          <input type="checkbox" checked={mock} onChange={(e) => setMock(e.target.checked)} />
          <span>
            Mock-Modus {sdkAvailable && project ? "" : "(empfohlen — kein Projekt/Login)"} — scripted Demo-Stream ohne
            echten Claude-Aufruf & ohne Worktree
          </span>
        </label>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Abbrechen
          </button>
          <button type="submit" className="primary" disabled={realSubNeedsProject}>
            {realSubNeedsProject ? "Projekt nötig" : "Stream starten"}
          </button>
        </div>
      </form>
    </div>
  );
}
