import { useEffect, useRef } from "react";
import { useStore } from "../store";

/**
 * Recent-/Projekt-Switcher (docs/design/10-navigation-toolbar.md §1.3).
 * Übernimmt `.recent-box` + `.project-box` aus der aufgelösten `Sidebar.tsx`:
 * Kopf = aktiver owner/repo; oberster Eintrag „Projekt öffnen…" → openProject();
 * darunter die gefilterte Recent-Liste (recent.ts bleibt SSOT) je mit
 * openRecentProject / forgetRecentProject. KEINE neue Persistenz-Logik.
 */
export function RecentProjectsPopover({ open, onClose }: { open: boolean; onClose: () => void }) {
  const project = useStore((s) => s.project);
  const projectStatus = useStore((s) => s.projectStatus);
  const openProject = useStore((s) => s.openProject);
  const recentProjects = useStore((s) => s.recentProjects);
  const openRecentProject = useStore((s) => s.openRecentProject);
  const forgetRecentProject = useStore((s) => s.forgetRecentProject);
  const ref = useRef<HTMLDivElement>(null);

  // Klick außerhalb / Esc schließt das Popover.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  const recent = recentProjects.filter((r) => r.repoRoot !== project?.repoRoot);

  return (
    <div className="recent-popover" ref={ref} role="dialog" aria-label="Projekt wählen">
      <div className="recent-popover-head" title={project?.repoRoot}>
        {projectStatus === "opening" ? "öffne…" : project ? `${project.owner}/${project.repo}` : "kein Projekt gewählt"}
      </div>

      <button
        className="recent-open-new"
        onClick={() => {
          void openProject();
          onClose();
        }}
      >
        + Projekt öffnen…
      </button>

      {recent.length > 0 && (
        <div className="recent-box">
          <div className="recent-title">Zuletzt geöffnet</div>
          {recent.map((r) => (
            <div key={r.repoRoot} className="recent-item">
              <button
                className="recent-open"
                title={r.repoRoot}
                disabled={projectStatus === "opening"}
                onClick={() => {
                  void openRecentProject(r.repoRoot);
                  onClose();
                }}
              >
                <span className="recent-name">
                  {r.owner && r.repo ? `${r.owner}/${r.repo}` : r.repoRoot.split("/").pop()}
                </span>
                <span className="recent-path">{r.repoRoot}</span>
              </button>
              <button className="recent-forget" title="Aus Liste entfernen" onClick={() => forgetRecentProject(r.repoRoot)}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
