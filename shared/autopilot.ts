/**
 * Autopilot-Policy (Single Source of Truth) — entscheidet die NÄCHSTE automatische,
 * REVERSIBLE Aktion eines Sub-Streams. Pur & testbar; vom Sidecar (autoritativer Treiber)
 * und vom Frontend (Status „auto — läuft…") geteilt.
 *
 * Grenze (siehe docs / Parallel-Orchestrierungs-Plan): Automatisiert wird NUR Reversibles
 * (lokal committen, eigenen Branch pushen, PR erstellen/aktuell halten). Alles Irreversible /
 * außen-Wirksame (Merge nach main, Force-Discard, Aufräumen mit Resten, Konfliktlösung,
 * Secret-Treffer) bleibt menschlich — `autopilotDecision` gibt dafür NIE eine Aktion zurück.
 */
import type { AutopilotLevel } from "./protocol";

export interface AutopilotState {
  level: AutopilotLevel;
  role: "integrator" | "sub";
  status: string; // Agent-Status (running/waiting_input/done/…)
  dirty: boolean; // uncommitted/untracked Arbeit im Worktree
  ahead: number; // lokale Commits vor origin/<default>
  unpushed: number; // lokale Commits, die noch nicht auf origin/<branch> sind
  hasPr: boolean;
  prOpen: boolean;
  syncBlocked: boolean; // Auto-Sync wegen Konflikt pausiert
  busyPermission: boolean; // wartet auf eine Permission-Rückfrage
  secretBlocked: boolean; // letzter Auto-Commit wegen Secret-Treffer gestoppt
}

export type AutopilotAction = "commit" | "push" | "create_pr" | "none";

/** Die eine nächste auto-Aktion (oder „none"). Reihenfolge: sichern → pushen → PR. */
export function autopilotDecision(s: AutopilotState): { action: AutopilotAction; reason: string } {
  if (s.level === "manual") return { action: "none", reason: "manuell" };
  if (s.role !== "sub") return { action: "none", reason: "nur Sub-Streams" };
  if (s.status === "running" || s.status === "starting") return { action: "none", reason: "Agent arbeitet" };
  if (s.busyPermission) return { action: "none", reason: "wartet auf Permission" };
  if (s.syncBlocked) return { action: "none", reason: "Sync-Konflikt — manuell lösen" };
  if (s.dirty) {
    if (s.secretBlocked) return { action: "none", reason: "Secret erkannt — manuell prüfen" };
    return { action: "commit", reason: "uncommittete Arbeit sichern" };
  }
  if (s.prOpen && s.unpushed > 0) return { action: "push", reason: "neue Commits in den PR pushen" };
  if (!s.hasPr && s.ahead > 0) return { action: "create_pr", reason: "PR erstellen (Gate läuft)" };
  return { action: "none", reason: "nichts zu tun" };
}
