/**
 * Git-Worktree- + GitHub-Operationen für den Sidecar (P3/P4).
 *
 * Worktrees AUSSERHALB des Repos unter ~/mads-worktrees/<repo-slug>/<agentId>
 * (paix-konform). GitHub via `gh` CLI (erbt die Keychain-Auth des Nutzers).
 * Befehle werfen NICHT bei non-zero — wir klassifizieren die Ausgabe selbst,
 * um Eskalationen (push rejected, conflict, …) zu erkennen.
 *
 * Siehe docs/research/github-multiagent.md und docs/design/04-sub-agents.md.
 */
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { EscalationKind, PullRequestInfo, PrChecksState } from "../../shared/protocol.js";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(cmd: string, args: string[], cwd?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
    });
  });
}
const git = (args: string[], cwd?: string) => run("git", args, cwd);
const gh = (args: string[], cwd?: string) => run("gh", args, cwd);

export function repoSlug(repoRoot: string): string {
  return basename(repoRoot);
}
export function worktreePathFor(repoRoot: string, agentId: string): string {
  return join(homedir(), "mads-worktrees", repoSlug(repoRoot), agentId);
}

/**
 * Alle mads-Worktrees dieses Repos auflisten (unter ~/mads-worktrees/<slug>/<agentId>).
 * Liefert agentId (= Verzeichnisname), Pfad und Branch — Basis fürs Wieder-Anbieten
 * verwaister Branches beim Projekt-Öffnen.
 */
export async function discoverWorktrees(
  repoRoot: string,
): Promise<{ agentId: string; path: string; branch: string }[]> {
  const base = join(homedir(), "mads-worktrees", repoSlug(repoRoot));
  const r = await git(["-C", repoRoot, "worktree", "list", "--porcelain"], repoRoot);
  if (r.code !== 0) return [];
  const out: { agentId: string; path: string; branch: string }[] = [];
  let curPath = "";
  let curBranch = "";
  const flush = () => {
    if (curPath && (curPath === base || curPath.startsWith(base + "/"))) {
      out.push({ agentId: basename(curPath), path: curPath, branch: curBranch.replace(/^refs\/heads\//, "") });
    }
    curPath = "";
    curBranch = "";
  };
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      curPath = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ")) {
      curBranch = line.slice("branch ".length).trim();
    }
  }
  flush();
  return out;
}

export async function getRepoInfo(
  repoRoot: string,
): Promise<{ owner: string; repo: string; defaultBranch: string } | null> {
  const remote = await git(["-C", repoRoot, "remote", "get-url", "origin"], repoRoot);
  if (remote.code !== 0) return null;
  // https://github.com/owner/repo.git  ODER  git@github.com:owner/repo.git
  const m = remote.stdout.trim().match(/[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) return null;
  let defaultBranch = "main";
  const head = await git(["-C", repoRoot, "symbolic-ref", "refs/remotes/origin/HEAD"], repoRoot);
  if (head.code === 0) {
    const hm = head.stdout.trim().match(/origin\/(.+)$/);
    if (hm) defaultBranch = hm[1];
  }
  return { owner: m[1], repo: m[2], defaultBranch };
}

export function classifyGitError(text: string): EscalationKind | undefined {
  const t = text.toLowerCase();
  if (/\[rejected\]|non-fast-forward|updates were rejected|failed to push/.test(t)) return "push_rejected";
  if (/conflict|could not apply|needs merge/.test(t)) return "merge_conflict";
  if (/protected branch|protection|not allowed to push/.test(t)) return "protection_blocked";
  if (/authentication|could not read username|permission denied/.test(t)) return "auth_broken";
  return undefined;
}

export async function createWorktree(
  repoRoot: string,
  agentId: string,
  branch: string,
  baseRef: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  await git(["-C", repoRoot, "fetch", "origin"], repoRoot);
  const path = worktreePathFor(repoRoot, agentId);
  const r = await git(["-C", repoRoot, "worktree", "add", "-b", branch, path, baseRef], repoRoot);
  if (r.code !== 0) return { ok: false, error: r.stderr || r.stdout };
  return { ok: true, path };
}

export async function removeWorktree(repoRoot: string, path: string, branch?: string): Promise<void> {
  await git(["-C", repoRoot, "worktree", "remove", "--force", path], repoRoot);
  if (branch) await git(["-C", repoRoot, "branch", "-D", branch], repoRoot);
  await git(["-C", repoRoot, "worktree", "prune"], repoRoot);
}

export async function gitStatus(
  repoRoot: string,
  worktree: string,
  branch: string,
  defaultBranch: string,
  skipFetch = false,
): Promise<{ behind: number; ahead: number; dirty: boolean }> {
  if (!skipFetch) await git(["-C", repoRoot, "fetch", "origin"], repoRoot);
  const base = `origin/${defaultBranch}`;
  const behindR = await git(["-C", worktree, "rev-list", "--count", `${branch}..${base}`], worktree);
  const aheadR = await git(["-C", worktree, "rev-list", "--count", `${base}..${branch}`], worktree);
  const dirtyR = await git(["-C", worktree, "status", "--porcelain"], worktree);
  return {
    behind: parseInt(behindR.stdout.trim() || "0", 10),
    ahead: parseInt(aheadR.stdout.trim() || "0", 10),
    dirty: dirtyR.stdout.trim().length > 0,
  };
}

/** rebase onto origin/<default> + force-with-lease — der stale-base-Killer. */
export async function syncBranch(
  worktree: string,
  branch: string,
  defaultBranch: string,
): Promise<{ ok: true } | { ok: false; kind: EscalationKind; error: string }> {
  await run("git", ["-C", worktree, "fetch", "origin"], worktree);
  const rebase = await git(["-C", worktree, "rebase", `origin/${defaultBranch}`], worktree);
  if (rebase.code !== 0) {
    await git(["-C", worktree, "rebase", "--abort"], worktree);
    return { ok: false, kind: "merge_conflict", error: rebase.stderr || rebase.stdout };
  }
  const push = await git(["-C", worktree, "push", "--force-with-lease", "origin", branch], worktree);
  if (push.code !== 0) {
    return { ok: false, kind: classifyGitError(push.stderr) ?? "push_rejected", error: push.stderr };
  }
  return { ok: true };
}

export async function pushBranch(
  worktree: string,
  branch: string,
): Promise<{ ok: true } | { ok: false; kind: EscalationKind; error: string }> {
  const push = await git(["-C", worktree, "push", "-u", "origin", branch], worktree);
  if (push.code !== 0) return { ok: false, kind: classifyGitError(push.stderr) ?? "push_rejected", error: push.stderr };
  return { ok: true };
}

export async function createPr(
  worktree: string,
  repoRoot: string,
  branch: string,
  base: string,
  title: string,
  body: string,
  draft: boolean,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const pushed = await pushBranch(worktree, branch);
  if (!pushed.ok) return { ok: false, error: pushed.error };
  const args = ["pr", "create", "--head", branch, "--base", base, "--title", title, "--body", body];
  if (draft) args.push("--draft");
  const r = await gh(args, repoRoot);
  if (r.code !== 0) return { ok: false, error: r.stderr || r.stdout };
  return { ok: true, url: r.stdout.trim().split("\n").pop() ?? "" };
}

/** Integrator-Merge: gh pr merge --squash --delete-branch (lineare main). */
export async function mergePr(
  repoRoot: string,
  branch: string,
  method: "squash" | "merge" | "rebase" = "squash",
): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
  const flag = method === "merge" ? "--merge" : method === "rebase" ? "--rebase" : "--squash";
  const r = await gh(["pr", "merge", branch, flag, "--delete-branch"], repoRoot);
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).trim() };
  return { ok: true, output: r.stdout.trim() };
}

function rollupState(rollup: unknown): PrChecksState {
  if (!Array.isArray(rollup) || rollup.length === 0) return null;
  let fail = 0;
  let pending = 0;
  for (const c of rollup as Array<Record<string, unknown>>) {
    const s = String(c.conclusion ?? c.state ?? c.status ?? "").toUpperCase();
    if (/(FAILURE|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED|STARTUP_FAILURE)/.test(s)) fail++;
    else if (/(PENDING|IN_PROGRESS|QUEUED|WAITING|REQUESTED|EXPECTED)/.test(s)) pending++;
  }
  if (fail > 0) return "FAILURE";
  if (pending > 0) return "PENDING";
  return "SUCCESS";
}

/** PR-Status der Branch via gh; null wenn (noch) kein PR existiert. */
export async function prStatus(
  repoRoot: string,
  branch: string,
): Promise<PullRequestInfo | null> {
  const fields = "number,url,state,isDraft,headRefName,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup";
  const r = await gh(["pr", "view", branch, "--json", fields], repoRoot);
  if (r.code !== 0) return null; // kein PR / nicht gefunden
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
  return {
    number: Number(j.number ?? 0),
    url: String(j.url ?? ""),
    state: (j.state as PullRequestInfo["state"]) ?? "OPEN",
    isDraft: Boolean(j.isDraft),
    headRefName: String(j.headRefName ?? branch),
    mergeable: (j.mergeable as PullRequestInfo["mergeable"]) ?? "UNKNOWN",
    mergeStateStatus: (j.mergeStateStatus as PullRequestInfo["mergeStateStatus"]) ?? "UNKNOWN",
    reviewDecision: (j.reviewDecision as PullRequestInfo["reviewDecision"]) ?? null,
    checksState: rollupState(j.statusCheckRollup),
  };
}

/** Leitet aus git-Status + PR-Status die anstehenden Eskalationen ab. */
export function escalationsFor(
  status: { behind: number } | null,
  pr: PullRequestInfo | null,
): EscalationKind[] {
  const out: EscalationKind[] = [];
  if (status && status.behind > 0) out.push("stale_base");
  if (pr) {
    if (pr.checksState === "FAILURE") out.push("ci_red");
    if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") out.push("merge_conflict");
    if (pr.mergeStateStatus === "BEHIND" && !out.includes("stale_base")) out.push("stale_base");
    if (pr.mergeStateStatus === "BLOCKED") out.push("protection_blocked");
    if (pr.reviewDecision === "CHANGES_REQUESTED" || pr.reviewDecision === "REVIEW_REQUIRED") out.push("review_required");
  }
  return out;
}
