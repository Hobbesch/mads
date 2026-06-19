/**
 * P6 Clean-Code-Gate: führt projekt-erkannte Checks im Worktree aus
 * (lint / type-check / test) plus einen deterministischen Secret-Scan über den Diff.
 * Nicht-anwendbare Checks werden übersprungen (skip), nicht als Fehler gewertet.
 *
 * Siehe docs/design/01-architecture.md §8.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./git.js";
import { scanSecrets } from "../../shared/secrets.js";
import type { GateStep, GateStepStatus } from "../../shared/protocol.js";

async function hasCmd(name: string): Promise<boolean> {
  return (await run("which", [name])).code === 0;
}
function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
function lastLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 160) : "";
}

export async function runGate(
  worktree: string,
  defaultBranch: string,
): Promise<{ ok: boolean; steps: GateStep[] }> {
  const steps: GateStep[] = [];
  const add = (name: string, status: GateStepStatus, summary?: string) => steps.push({ name, status, summary });
  const exists = (f: string) => existsSync(join(worktree, f));

  async function step(name: string, cmd: string, args: string[]): Promise<void> {
    const r = await run(cmd, args, worktree);
    if (r.code === 0) add(name, "pass", `${cmd} ${args.join(" ")}`);
    else add(name, "fail", lastLine(r.stderr || r.stdout) || `${cmd} exited ${r.code}`);
  }

  // ---- JS / TS ----
  if (exists("package.json")) {
    let scripts: Record<string, string> = {};
    try {
      scripts = (JSON.parse(safeRead(join(worktree, "package.json"))).scripts as Record<string, string>) ?? {};
    } catch {
      scripts = {};
    }
    if (exists("package-lock.json")) await step("npm ci", "npm", ["ci"]);
    for (const s of ["lint", "typecheck", "type-check", "test"]) {
      if (scripts[s]) await step(`npm:${s}`, "npm", ["run", s, "--silent"]);
    }
  }

  // ---- Python (uv) ----
  if (exists("pyproject.toml")) {
    const py = safeRead(join(worktree, "pyproject.toml"));
    if (exists("uv.lock") && (await hasCmd("uv"))) {
      if (/ruff/.test(py)) await step("ruff", "uv", ["run", "ruff", "check", "."]);
      if (/mypy/.test(py)) await step("mypy", "uv", ["run", "mypy", "."]);
      if (/pytest/.test(py)) await step("pytest", "uv", ["run", "pytest", "-q"]);
    } else {
      add("python", "skip", "kein uv.lock / uv nicht gefunden");
    }
  }

  // ---- Rust ----
  if (exists("Cargo.toml")) {
    if (await hasCmd("cargo")) {
      await step("cargo check", "cargo", ["check", "--quiet"]);
      await step("cargo test", "cargo", ["test", "--quiet"]);
    } else {
      add("cargo", "skip", "cargo nicht gefunden");
    }
  }

  // ---- Secret-Scan (immer) ----
  await run("git", ["-C", worktree, "fetch", "origin"], worktree);
  const diff = await run("git", ["-C", worktree, "diff", "--merge-base", `origin/${defaultBranch}`], worktree);
  const hits = scanSecrets(diff.stdout);
  if (hits.length === 0) add("secret-scan", "pass", "keine Secrets im Diff");
  else add("secret-scan", "fail", `${hits.length} Treffer: ${hits.map((h) => `${h.kind} (${h.preview})`).join(" · ")}`);

  if (!steps.some((s) => s.status !== "skip")) {
    add("hinweis", "skip", "keine ausführbaren Checks erkannt (lint/type/test)");
  }
  const ok = !steps.some((s) => s.status === "fail");
  return { ok, steps };
}
