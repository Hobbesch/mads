import { useEffect, useState } from "react";
import { useStore } from "../store";

/**
 * Kontext-Info vs. Koordinations-Warnung (docs/design/07-file-explorer.md §5.3).
 * Reine Store-Ableitungen — KEIN neuer Protokoll-Typ.
 *
 *  - In-Worktree-Kontext (INFORMATIV, kein Blocker): activeRoot.kind === "worktree"
 *    → einklappbare Info-Zeile „Stream X · noch nicht auf main" (Normalfall beim
 *    Review, OE-35). Bewusst KEIN Modal: passive Dauer-Info, kein Alarm.
 *  - Live-Kollision: Pfad in collisions → rot (region) / amber (file).
 *  - External-change: Datei wurde auf Disk geändert → Banner „Neu laden".
 *
 * TODO(Post-MVP, doc 07 §5.3): Region-Trespass via detectTrespass(shared/ownership.ts)
 * gegen geladene OwnershipRule[] (rote Leiste bei FREMDER Region) — Ownership-Regeln
 * fließen heute noch nicht in den Store.
 */
export function FileWarnings({ path }: { path: string }) {
  const activeRoot = useStore((s) => s.activeRoot);
  const agents = useStore((s) => s.agents);
  const collisions = useStore((s) => s.collisions);
  const externalChanged = useStore((s) => s.externalChanged);
  const reloadFile = useStore((s) => s.reloadFile);

  const inWorktree = activeRoot?.kind === "worktree";
  const agentId = inWorktree ? activeRoot.agentId : "";
  const streamLabel = inWorktree ? agents[activeRoot.agentId]?.label ?? "Stream" : "";
  const hit = collisions.find((c) => c.path && path.endsWith(c.path));
  const ext = externalChanged[path];

  // Der Worktree-Hinweis ist für JEDE Datei im Stream identisch → pro Stream-Kontext
  // einmal ausblendbar (Reset beim Stream-Wechsel, damit er im neuen Kontext wieder kommt).
  const [infoDismissed, setInfoDismissed] = useState(false);
  useEffect(() => setInfoDismissed(false), [agentId]);

  if (!inWorktree && !hit && !ext) return null;

  return (
    <div className="file-warnings" aria-live="polite">
      {ext && (
        <div className="warn-bar external">
          <span>⟳ Datei wurde auf Disk geändert.</span>
          <button onClick={() => void reloadFile(path)}>Neu laden</button>
        </div>
      )}
      {inWorktree && !infoDismissed && (
        <div className="warn-bar info" role="note">
          <span className="warn-icon" aria-hidden="true">i</span>
          <span className="warn-text">
            Änderungen in Stream <strong>„{streamLabel}"</strong> sind noch nicht auf <code>main</code> — sie landen
            dort erst, wenn der zugehörige PR vom Integrator gemergt wird.
          </span>
          <button
            className="warn-dismiss"
            onClick={() => setInfoDismissed(true)}
            title="Hinweis ausblenden"
            aria-label="Hinweis ausblenden"
          >
            ×
          </button>
        </div>
      )}
      {hit && (
        <div className={`warn-bar ${hit.severity === "region" ? "trespass" : "amber"}`}>
          {hit.severity === "region" ? "🔴" : "⚠︎"} Mögliche Kollision: {hit.labelA} ⟷ {hit.labelB}
          {hit.symbols?.length ? ` · ${hit.symbols.join(", ")}` : hit.severity === "file" ? " (gleiche Datei)" : ""}
        </div>
      )}
    </div>
  );
}
