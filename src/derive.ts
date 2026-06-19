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

/** Ist der PR dieses Agenten merge-reif? (Gleiche Logik wie der Sidecar-Gate.) */
export function mergeReadiness(a: AgentVM): MergeGate {
  return preMergeGate(a.pr, a.behind);
}
