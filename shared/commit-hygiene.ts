/**
 * Commit-Hygiene (REIN — kein git/fs) — testbar und vom Sidecar genutzt.
 *
 * Welche Pfade darf der **Autopilot** NIE automatisch committen? Env-/Build-/Cache-Artefakte.
 * Wichtig: per **Name** matchen (nicht per .gitignore), denn .gitignore verfehlt Sonderformen —
 * z.B. matcht das Muster `.venv/` (Verzeichnis) einen **Symlink** `.venv` NICHT, und genau so ist
 * ein `.venv`-Symlink über `git add -A` in einen Autopilot-Commit gerutscht und hat später jeden
 * Rebase blockiert („would lose untracked files in .venv"). Die Liste ist bewusst KONSERVATIV
 * (nur eindeutig wegwerfbare Namen — kein `dist`/`build`/`target`, die auch Quellordner sein können)
 * und GENERISCH (projekt-agnostisch).
 */

/** Verzeichnis-/Eintrags-Namen, die nie auto-committet werden (an jeder Pfad-Tiefe). */
export const NEVER_COMMIT_NAMES: ReadonlySet<string> = new Set([
  ".venv",
  "venv",
  "node_modules",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".ipynb_checkpoints",
  ".DS_Store",
]);

/** Datei-Endungen, die nie auto-committet werden. */
export const NEVER_COMMIT_SUFFIXES: readonly string[] = [".pyc", ".pyo"];

/** Pfad-Muster (worktree-relativ), die nie auto-committet werden. */
export const NEVER_COMMIT_PATTERNS: readonly RegExp[] = [/(^|\/)[^/]+\.egg-info(\/|$)/];

/**
 * True, wenn ein worktree-relativer Pfad ein nie-zu-committendes Artefakt ist (irgendein
 * Pfad-Segment ist ein Artefakt-Name, oder Endung/Muster passt).
 */
export function isArtifactPath(rel: string): boolean {
  const parts = rel.split("/").filter(Boolean);
  if (parts.some((seg) => NEVER_COMMIT_NAMES.has(seg))) return true;
  const base = parts[parts.length - 1] ?? "";
  if (NEVER_COMMIT_SUFFIXES.some((s) => base.endsWith(s))) return true;
  if (NEVER_COMMIT_PATTERNS.some((re) => re.test(rel))) return true;
  return false;
}
