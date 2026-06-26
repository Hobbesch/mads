import { preMergeGate } from "../shared/merge";
import type { MergeGate } from "../shared/merge";
import type { AgentVM } from "./store";

export type BadgeTone = "ok" | "warn" | "err" | "info";
export interface Badge {
  label: string;
  tone: BadgeTone;
}

/** Leitet die git-/PR-Badges eines Agenten ab (Spiegel der gepollten Felder). */
export function agentBadges(a: AgentVM): Badge[] {
  const out: Badge[] = [];
  const merged = a.pr?.state === "MERGED";
  if (a.gate && !merged) out.push({ label: a.gate.ok ? "Gate grün" : "Gate rot", tone: a.gate.ok ? "ok" : "err" });
  if (a.behind > 0 && !merged) out.push({ label: `stale base · ${a.behind} behind`, tone: "warn" });
  if (a.dirty && !merged) out.push({ label: "uncommitted", tone: "info" });
  const pr = a.pr;
  if (pr) {
    if (merged) {
      out.push({ label: `PR #${pr.number} gemerged`, tone: "ok" });
    } else {
      out.push({ label: `PR #${pr.number}`, tone: "info" });
      if (pr.checksState === "FAILURE") out.push({ label: "CI rot", tone: "err" });
      else if (pr.checksState === "PENDING") out.push({ label: "CI läuft", tone: "warn" });
      else if (pr.checksState === "SUCCESS") out.push({ label: "CI grün", tone: "ok" });
      if (pr.mergeable === "CONFLICTING") out.push({ label: "Merge-Konflikt", tone: "err" });
      if (pr.reviewDecision === "REVIEW_REQUIRED") out.push({ label: "Review nötig", tone: "warn" });
      else if (pr.reviewDecision === "CHANGES_REQUESTED") out.push({ label: "Änderungen gefordert", tone: "warn" });
      else if (pr.reviewDecision === "APPROVED") out.push({ label: "approved", tone: "ok" });
    }
  }
  return out;
}

export function hasGitEscalation(a: AgentVM): boolean {
  if (a.pr?.state === "MERGED") return false;
  return a.behind > 0 || a.pr?.checksState === "FAILURE" || a.pr?.mergeable === "CONFLICTING";
}

/**
 * Ungesicherte Arbeit: uncommitted/untracked ODER committet-aber-kein-PR. Solche Arbeit
 * geht beim Stop/Aufräumen verloren → auf der Kachel laut markieren und vor Stop bestätigen.
 */
export function unsavedWork(a: AgentVM): boolean {
  if (a.role !== "sub" || a.pr?.state === "MERGED") return false;
  return a.dirty || (a.ahead > 0 && !a.pr);
}

/** Grund, warum „Gate" gerade nicht sinnvoll ist (sonst null = erlaubt). */
export function gateDisabledReason(a: AgentVM): string | null {
  return a.dirty ? "Erst committen — das Gate prüft den committeten Stand." : null;
}

/** Grund, warum „Sync" gerade gesperrt ist (sonst null = erlaubt). */
export function syncDisabledReason(a: AgentVM): string | null {
  return a.dirty ? "Erst committen — der Rebase braucht einen sauberen Arbeitsbaum." : null;
}

/** Ist der PR dieses Agenten merge-reif? (Gleiche Logik wie der Sidecar-Gate.) */
export function mergeReadiness(a: AgentVM): MergeGate {
  return preMergeGate(a.pr, a.behind);
}

export type NextStepKind = "commit" | "pr" | "integrate" | "cleanup" | "none";
export interface NextStep {
  kind: NextStepKind;
  label: string;
  disabled: boolean;
  /** Tooltip: was passiert bzw. warum (de)aktiviert. */
  hint: string;
}

/**
 * Der EINE nächste Schritt im Sub-Agent-Workflow — fürs geführte UI:
 * uncommitted → Committen, Commits aber kein PR → PR erstellen, PR offen → Integrieren.
 * Sync läuft automatisch im Hintergrund und ist hier bewusst kein eigener Schritt.
 */
export function nextStep(a: AgentVM): NextStep {
  const none: NextStep = { kind: "none", label: "", disabled: true, hint: "" };
  if (a.role !== "sub") return none; // Integrator merged nur via „Integrieren" der Subs
  if (a.pr?.state === "MERGED")
    return { kind: "cleanup", label: "Aufräumen ✓", disabled: false, hint: "Stream beenden, Worktree/Branch entfernen (Arbeit ist bereits in main)" };
  if (a.dirty) return { kind: "commit", label: "Committen", disabled: false, hint: "Der Agent committet seine Arbeit (Projektkonvention)" };
  if (a.pr && a.pr.state === "OPEN") {
    const r = mergeReadiness(a);
    return {
      kind: "integrate",
      label: "Integrieren",
      disabled: !r.ok,
      hint: r.ok ? "PR nach main mergen und Branch/Worktree aufräumen" : `Noch nicht bereit: ${r.reasons.join(" · ")}`,
    };
  }
  if (a.ahead > 0 && !a.pr) return { kind: "pr", label: "PR erstellen", disabled: false, hint: "Gate prüfen → auf main syncen → pushen → PR öffnen" };
  return none;
}
