/**
 * Vor-Merge-Gate (Single Source of Truth) — die harte, beweisbare Bedingung, unter der
 * der Integrator nach `main` mergen darf. Pur & testbar; genutzt vom Sidecar
 * (autoritativ) UND vom Frontend (Button-Gating).
 *
 * Operationalisiert docs/design/03-main-agent.md + _paix-multi-agent-reference §7:
 * nie rote-CI, nie stale-base, nie mit Konflikt, nie Draft/blockiert mergen.
 */
import type { PullRequestInfo } from "./protocol";

export interface MergeGate {
  ok: boolean;
  reasons: string[];
}

export function preMergeGate(pr: PullRequestInfo | undefined, behind: number): MergeGate {
  if (!pr) return { ok: false, reasons: ["kein Pull Request"] };

  const reasons: string[] = [];
  if (pr.state !== "OPEN") reasons.push("PR ist nicht offen");
  if (pr.isDraft) reasons.push("PR ist ein Entwurf (Draft)");
  if (behind > 0 || pr.mergeStateStatus === "BEHIND") reasons.push('stale base — erst „Sync" (rebase onto main)');
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") reasons.push("Merge-Konflikt");
  if (pr.checksState === "FAILURE") reasons.push("CI ist rot");
  if (pr.checksState === "PENDING") reasons.push("CI läuft noch");
  if (pr.reviewDecision === "CHANGES_REQUESTED") reasons.push("Review fordert Änderungen");
  if (pr.mergeStateStatus === "BLOCKED") reasons.push("durch Branch-Protection blockiert (Review/Checks fehlen)");
  if (pr.mergeStateStatus === "UNKNOWN") reasons.push("Merge-Status wird noch berechnet — kurz warten");

  return { ok: reasons.length === 0, reasons };
}
