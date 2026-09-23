/**
 * Transkript-Schreiber mit Siegel.
 *
 * Der UI-Verlauf je Stream wird debounced nach `.mads/transcripts/<agentId>.json` geschrieben,
 * damit er einen Neustart überlebt. Beim Stop entfernt der Store den Agenten samt `events[id]` —
 * der Sidecar schickt danach aber noch Abschluss-Events („↻ Aufgeräumt: 1 Prozess beendet"). Die
 * legten den Verlauf mit EINER Zeile neu an, und der nächste Save schrieb genau diese eine Zeile
 * über die Datei: der gesamte Dialog war weg (Befund 23.09.2026, Stream „Reports - kWh pro kWp" —
 * 164 Bytes übrig). Seit den Tombstones ist Stop endgültig, also gibt es auch kein zweites
 * Fenster, in dem der Verlauf zurückkäme.
 *
 * Ein versiegelter Stream schreibt darum nicht mehr: die Datei auf Platte bleibt als Archiv des
 * Stands, den der Stream beim Schließen hatte. Das Siegel ist bewusst umkehrbar (`unseal`) —
 * ein ausdrücklicher (Neu-)Start unter derselben agentId darf wieder mitschreiben, analog zum
 * Tombstone im Sidecar, der beim Start ebenfalls fällt.
 *
 * Timer und Schreibweg sind injiziert, damit die Reihenfolge ohne echte Zeit testbar ist.
 */

export type TranscriptTimer = ReturnType<typeof setTimeout>;

export interface TranscriptWriterDeps<T = TranscriptTimer> {
  /** Verzögerten Lauf planen (Produktion: setTimeout). */
  schedule: (fn: () => void, ms: number) => T;
  /** Geplanten Lauf abbrechen (Produktion: clearTimeout). */
  cancel: (timer: T) => void;
  /** Tatsächlich auf Platte schreiben — wird nur für unversiegelte Streams gerufen. */
  write: (agentId: string) => void;
  /** Bündelungsfenster; häufige Events sollen nicht jeden Tastendruck schreiben. */
  delayMs?: number;
}

export interface TranscriptWriter {
  /** Speichern anstoßen (debounced). No-op, solange der Stream versiegelt ist. */
  save: (agentId: string) => void;
  /** Stream schließen: laufenden Timer verwerfen und weitere Schreibvorgänge sperren. */
  seal: (agentId: string) => void;
  /** Sperre aufheben (ausdrücklicher Neustart unter derselben agentId). */
  unseal: (agentId: string) => void;
  isSealed: (agentId: string) => boolean;
}

export const TRANSCRIPT_DEBOUNCE_MS = 1500;

export function createTranscriptWriter<T = TranscriptTimer>(deps: TranscriptWriterDeps<T>): TranscriptWriter {
  const timers = new Map<string, T>();
  const sealed = new Set<string>();
  const delay = deps.delayMs ?? TRANSCRIPT_DEBOUNCE_MS;

  return {
    save(agentId) {
      if (sealed.has(agentId)) return; // geschlossener Stream — die Datei ist ab jetzt Archiv
      const existing = timers.get(agentId);
      if (existing !== undefined) deps.cancel(existing);
      timers.set(
        agentId,
        deps.schedule(() => {
          timers.delete(agentId);
          // Zweite Prüfung: zwischen Planen und Feuern kann der Stream gestoppt worden sein.
          // `seal` bricht den Timer zwar ab, aber nur diese Prüfung macht das Siegel auch dann
          // dicht, wenn der Abbruch einen bereits laufenden Lauf nicht mehr erwischt.
          if (sealed.has(agentId)) return;
          deps.write(agentId);
        }, delay),
      );
    },

    seal(agentId) {
      sealed.add(agentId); // ZUERST sperren, dann abbrechen — sonst schlüpft ein feuernder Timer durch
      const pending = timers.get(agentId);
      if (pending !== undefined) deps.cancel(pending);
      timers.delete(agentId);
    },

    unseal(agentId) {
      sealed.delete(agentId);
    },

    isSealed(agentId) {
      return sealed.has(agentId);
    },
  };
}
