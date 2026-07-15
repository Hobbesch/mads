/**
 * macOS-System-Benachrichtigungen (mit Ton) über das Tauri-Notification-Plugin. Zeigt eine
 * Benachrichtigung, wenn eine Berechtigungsfrage/Rückfrage ansteht UND das mads-Fenster gerade NICHT
 * im Vordergrund ist — im Vordergrund reicht das prominente In-App-Overlay (PermissionDialog).
 *
 * Der Vordergrund-Check läuft über native Tauri-Fensterevents, NICHT über `document.hasFocus()`:
 * im WKWebView liefert hasFocus() oft `true`, obwohl das Fenster nicht die vorderste App ist → die
 * Benachrichtigung würde genau dann unterdrückt, wenn man sie braucht.
 */
import { isPermissionGranted, requestPermission, sendNotification, removeActive } from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { PermissionRequestMsg } from "../shared/protocol";

let granted: boolean | undefined;

// Fensterfokus nativ verfolgen. Startwert `true` (beim App-Start ist das Fenster vorne);
// Fokus-Events aktualisieren ihn danach.
let windowFocused = true;
let focusTracking = false;

async function startFocusTracking(): Promise<void> {
  if (focusTracking) return;
  focusTracking = true;
  try {
    const win = getCurrentWindow();
    // Erst den Listener anhängen, DANN den Startwert lesen — sonst könnte ein Fokuswechsel zwischen
    // Lesen und Anhängen verloren gehen.
    await win.onFocusChanged(({ payload }) => {
      windowFocused = payload;
    });
    windowFocused = await win.isFocused().catch(() => windowFocused);
  } catch {
    /* kein Tauri → windowFocused bleibt true (dann unterdrückt; In-App-Overlay reicht) */
  }
}

/** Stabile positive Ganzzahl aus der requestId (UUID) → dient als Notification-`id`, damit sich die
 *  Meldung später gezielt zurückziehen lässt, wenn die Anfrage woanders beantwortet/abgebrochen wird. */
function notifId(requestId: string): number {
  let h = 5381;
  for (let i = 0; i < requestId.length; i++) h = ((h << 5) + h + requestId.charCodeAt(i)) | 0;
  // Auf garantiert positive 31-bit-Zahl maskieren (Math.abs(INT_MIN) bliebe negativ / überliefe den
  // vom Plugin geforderten 32-bit-Bereich).
  return (h & 0x7fffffff) || 1;
}

/** Beim App-Start: Fokus-Tracking anwerfen + einmal die Benachrichtigungs-Erlaubnis einholen. */
export async function ensureNotificationPermission(): Promise<void> {
  void startFocusTracking();
  try {
    granted = (await isPermissionGranted()) || (await requestPermission()) === "granted";
    if (!granted) {
      console.warn("[mads] Benachrichtigungen nicht erlaubt — Systemeinstellungen › Mitteilungen › mads aktivieren.");
    }
  } catch {
    /* kein Tauri / Plugin nicht verfügbar → still ignorieren */
  }
}

/** Benachrichtigung (mit Ton) für eine NEUE Berechtigungsfrage/Rückfrage — nur wenn das Fenster
 *  nicht im Vordergrund ist. Best effort: Fehler werden verschluckt. */
export async function notifyOsPermission(msg: PermissionRequestMsg, streamLabel: string): Promise<void> {
  if (windowFocused) return; // Fenster vorne → Overlay reicht
  try {
    if (granted !== true) {
      granted = await isPermissionGranted();
      if (!granted) return;
    }
    const body =
      msg.kind === "ask_user_question"
        ? (msg.questions?.[0]?.question ?? "Rückfrage zur aktuellen Arbeit")
        : `${msg.toolName} braucht deine Erlaubnis`;
    sendNotification({ id: notifId(msg.requestId), title: `${streamLabel} braucht eine Entscheidung`, body, sound: "default" });
  } catch {
    /* best effort */
  }
}

/** Die Benachrichtigung zu einer erledigten Anfrage zurückziehen (woanders beantwortet oder
 *  abgebrochen) → kein toter „braucht eine Entscheidung"-Eintrag im Mitteilungszentrum. */
export async function dismissOsPermission(requestId: string): Promise<void> {
  try {
    await removeActive([{ id: notifId(requestId) }]);
  } catch {
    /* best effort */
  }
}
