/**
 * macOS-System-Benachrichtigungen (mit Ton) über das Tauri-Notification-Plugin. Zeigt eine
 * Benachrichtigung, wenn eine Berechtigungsfrage/Rückfrage ansteht UND das mads-Fenster gerade NICHT
 * im Vordergrund ist — im Vordergrund reicht das prominente In-App-Overlay (PermissionDialog).
 */
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import type { PermissionRequestMsg } from "../shared/protocol";

let granted: boolean | undefined;

/** Beim App-Start einmal die Benachrichtigungs-Erlaubnis einholen (macOS-Systemdialog). */
export async function ensureNotificationPermission(): Promise<void> {
  try {
    granted = (await isPermissionGranted()) || (await requestPermission()) === "granted";
  } catch {
    /* kein Tauri / Plugin nicht verfügbar → still ignorieren */
  }
}

/** Benachrichtigung (mit Ton) für eine NEUE Berechtigungsfrage/Rückfrage — nur wenn das Fenster
 *  nicht im Vordergrund ist. Best effort: Fehler werden verschluckt. */
export async function notifyOsPermission(msg: PermissionRequestMsg, streamLabel: string): Promise<void> {
  if (typeof document !== "undefined" && document.hasFocus()) return; // im Fokus → Overlay reicht
  try {
    if (granted !== true) {
      granted = await isPermissionGranted();
      if (!granted) return;
    }
    const body =
      msg.kind === "ask_user_question"
        ? (msg.questions?.[0]?.question ?? "Rückfrage zur aktuellen Arbeit")
        : `${msg.toolName} braucht deine Erlaubnis`;
    sendNotification({ title: `${streamLabel} braucht eine Entscheidung`, body, sound: "default" });
  } catch {
    /* best effort */
  }
}
