/**
 * Tests für das Vor-Merge-Gate (shared/merge.ts). Dependency-frei, via
 * `npm run test:merge` (esbuild + node).
 */
import { preMergeGate } from "./merge";
import type { PullRequestInfo } from "./protocol";

function pr(overrides: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    number: 1,
    url: "https://github.com/o/r/pull/1",
    state: "OPEN",
    isDraft: false,
    headRefName: "feat/x",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    checksState: "SUCCESS",
    ...overrides,
  };
}

const results: string[] = [];
let failed = 0;
function check(name: string, cond: boolean): void {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) failed++;
}

// grünes PR, nicht behind → mergebar
check("clean + CI green → ok", preMergeGate(pr(), 0).ok);
// kein PR → blockiert
check("no PR → blocked", !preMergeGate(undefined, 0).ok);
// stale base (behind) → blockiert
check("behind > 0 → blocked", !preMergeGate(pr(), 2).ok);
check("mergeStateStatus BEHIND → blocked", !preMergeGate(pr({ mergeStateStatus: "BEHIND" }), 0).ok);
// CI
check("CI FAILURE → blocked", !preMergeGate(pr({ checksState: "FAILURE" }), 0).ok);
check("CI PENDING → blocked", !preMergeGate(pr({ checksState: "PENDING" }), 0).ok);
check("CI null (kein CI) → ok", preMergeGate(pr({ checksState: null }), 0).ok);
// Konflikt / Draft / Review / Block
check("CONFLICTING → blocked", !preMergeGate(pr({ mergeable: "CONFLICTING" }), 0).ok);
check("draft → blocked", !preMergeGate(pr({ isDraft: true }), 0).ok);
check("changes requested → blocked", !preMergeGate(pr({ reviewDecision: "CHANGES_REQUESTED" }), 0).ok);
check("BLOCKED (protection) → blocked", !preMergeGate(pr({ mergeStateStatus: "BLOCKED" }), 0).ok);
check("not OPEN → blocked", !preMergeGate(pr({ state: "MERGED" }), 0).ok);
// Solo-Maintainer: REVIEW_REQUIRED ist KEIN Blocker (der Klick ist die Freigabe)
check("review_required not a blocker", preMergeGate(pr({ reviewDecision: "REVIEW_REQUIRED" }), 0).ok);
// UNSTABLE (mergebar, nicht-required checks) → ok, solange checksState nicht FAILURE
check("UNSTABLE + green → ok", preMergeGate(pr({ mergeStateStatus: "UNSTABLE" }), 0).ok);
// Gründe werden gesammelt
check("collects multiple reasons", preMergeGate(pr({ isDraft: true, checksState: "FAILURE" }), 3).reasons.length >= 3);

for (const r of results) console.log(r);
console.log(`\n${results.length - failed} passed, ${failed} failed`);
if (failed > 0) throw new Error(`${failed} merge-gate test(s) failed`);
