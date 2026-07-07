/**
 * Zuletzt geöffnete Projekte — global (NICHT pro-Repo), im localStorage des WebViews.
 *
 * Anders als die pro-Repo-Persistenz (`<repoRoot>/.mads/agents.json`, siehe
 * sidecar/src/persistence.ts) merkt sich diese Liste app-weit, WELCHE Projekte je
 * geöffnet wurden — damit man sie nach App-Neustart/Release nicht neu suchen muss.
 *
 * Warum localStorage: die WKWebView-DataStore liegt unter
 * `~/Library/WebKit/<bundle-id>/` — also AUSSERHALB des .app-Bundles. Ein neues Release
 * (Austausch der .app) löscht sie nicht; solange der Bundle-Identifier (com.hobbesch.mads)
 * gleich bleibt, überlebt die Liste Updates und Neuinstallationen.
 */
import type { ProjectInfo } from "../shared/protocol";

export interface RecentProject {
  repoRoot: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  lastOpenedAt: number;
}

const KEY = "mads.recentProjects";
const MAX = 8;

export function loadRecentProjects(): RecentProject[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((e) => e && typeof e.repoRoot === "string")
      .map((e) => ({
        repoRoot: e.repoRoot as string,
        owner: typeof e.owner === "string" ? e.owner : "",
        repo: typeof e.repo === "string" ? e.repo : "",
        defaultBranch: typeof e.defaultBranch === "string" ? e.defaultBranch : "main",
        lastOpenedAt: typeof e.lastOpenedAt === "number" ? e.lastOpenedAt : 0,
      }))
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
      .slice(0, MAX);
  } catch {
    return [];
  }
}

function save(list: RecentProject[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* localStorage nicht verfügbar — Liste bleibt nur in-memory für diese Session */
  }
}

/**
 * Projekt vorne einreihen (dedupliziert nach repoRoot), persistieren, neue Liste zurückgeben.
 * Liest FRISCH von der Platte (statt den `list`-Snapshot des Aufrufers), damit gleichzeitige
 * mads-Instanzen (geteilter localStorage per Bundle-ID) sich nicht gegenseitig überschreiben.
 */
export function rememberProject(_list: RecentProject[], project: ProjectInfo, now: number): RecentProject[] {
  const entry: RecentProject = {
    repoRoot: project.repoRoot,
    owner: project.owner,
    repo: project.repo,
    defaultBranch: project.defaultBranch,
    lastOpenedAt: now,
  };
  const current = loadRecentProjects(); // on-disk-Stand (kann von anderer Instanz aktualisiert sein)
  const next = [entry, ...current.filter((e) => e.repoRoot !== project.repoRoot)].slice(0, MAX);
  save(next);
  return next;
}

/** Einen Eintrag entfernen, persistieren, neue Liste zurückgeben. Liest ebenfalls frisch von Platte. */
export function forgetProject(_list: RecentProject[], repoRoot: string): RecentProject[] {
  const next = loadRecentProjects().filter((e) => e.repoRoot !== repoRoot);
  save(next);
  return next;
}
