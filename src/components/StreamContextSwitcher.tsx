import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { STATUS_META } from "../status";
import { StatusDot } from "./StatusDot";
import type { ExplorerRoot } from "../store";

/**
 * Stream-Kontext-Selector — die PRIMÄRE, immer sichtbare Steuerung des Explorers
 * (docs/design/07-file-explorer.md §1.2/§1.3). Beantwortet „wessen Dateien sehe ich
 * gerade an?". Listet `main / Integrator` (→ project.repoRoot) PLUS jeden aktiven
 * Sub-Agent mit Worktree (StatusDot-Farbe + label). Wahl → setActiveRoot(...).
 *
 * Weil es keine persistente Stream-Liste mehr gibt (Sidebar aufgelöst, doc 10
 * LAYOUT-CONTRACT (c)), bringt der Explorer seinen EIGENEN Selector mit.
 */
export function StreamContextSwitcher() {
  const project = useStore((s) => s.project);
  const agents = useStore((s) => s.agents);
  const order = useStore((s) => s.order);
  const activeRoot = useStore((s) => s.activeRoot);
  const setActiveRoot = useStore((s) => s.setActiveRoot);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Sub-Agenten mit echtem Worktree (browse-/editierbar, OE-35).
  const worktreeAgents = order
    .map((id) => agents[id])
    .filter((a) => a && a.role === "sub" && !!a.worktreePath);

  const projectRoot: ExplorerRoot | null = project ? { kind: "project", path: project.repoRoot } : null;

  const currentLabel = (() => {
    if (!activeRoot) return "kein Kontext";
    if (activeRoot.kind === "project") return project ? `main · ${project.owner}/${project.repo}` : "main";
    const a = agents[activeRoot.agentId];
    return a ? a.label : "Stream";
  })();
  const currentAgent = activeRoot?.kind === "worktree" ? agents[activeRoot.agentId] : undefined;

  function choose(root: ExplorerRoot) {
    void setActiveRoot(root);
    setOpen(false);
  }

  return (
    <header className="file-context" ref={ref}>
      <button className="file-context-trigger" onClick={() => setOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={open}>
        {currentAgent ? (
          <StatusDot status={currentAgent.status} />
        ) : (
          <span className="ctx-dot ctx-main" title="main / Integrator" />
        )}
        <span className="file-context-label" title={activeRoot?.path}>
          Kontext: {currentLabel}
        </span>
        <span className="file-context-caret">▾</span>
      </button>

      {open && (
        <ul className="file-context-menu" role="listbox">
          {projectRoot && (
            <li>
              <button
                className={`ctx-item${activeRoot?.kind === "project" ? " active" : ""}`}
                onClick={() => choose(projectRoot)}
                role="option"
                aria-selected={activeRoot?.kind === "project"}
              >
                <span className="ctx-dot ctx-main" />
                <span className="ctx-name">main · {project?.owner}/{project?.repo}</span>
              </button>
            </li>
          )}
          {worktreeAgents.map((a) => (
            <li key={a.id}>
              <button
                className={`ctx-item${activeRoot?.kind === "worktree" && activeRoot.agentId === a.id ? " active" : ""}`}
                onClick={() => choose({ kind: "worktree", agentId: a.id, path: a.worktreePath! })}
                role="option"
                aria-selected={activeRoot?.kind === "worktree" && activeRoot.agentId === a.id}
                title={`${STATUS_META[a.status].label} · ${a.worktreePath}`}
              >
                <StatusDot status={a.status} />
                <span className="ctx-name">{a.label}</span>
              </button>
            </li>
          ))}
          {worktreeAgents.length === 0 && <li className="ctx-empty">Keine aktiven Sub-Agent-Worktrees</li>}
        </ul>
      )}
    </header>
  );
}
