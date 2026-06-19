import type { AgentStatus } from "../shared/protocol";

export const STATUS_META: Record<AgentStatus, { label: string; color: string; pulse: boolean }> = {
  starting: { label: "startet", color: "var(--s-blue)", pulse: true },
  running: { label: "läuft", color: "var(--s-green)", pulse: true },
  waiting_input: { label: "wartet auf Input", color: "var(--s-yellow)", pulse: true },
  paused: { label: "pausiert", color: "var(--s-gray)", pulse: false },
  escalation: { label: "Eskalation", color: "var(--s-red)", pulse: true },
  error: { label: "Fehler", color: "var(--s-red)", pulse: false },
  done: { label: "fertig", color: "var(--s-teal)", pulse: false },
  queued: { label: "Warteschlange", color: "var(--s-gray)", pulse: false },
};
