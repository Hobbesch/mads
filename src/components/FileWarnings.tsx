import { useStore } from "../store";

/**
 * Kontext-Info vs. Koordinations-Warnung (docs/design/07-file-explorer.md §5.3).
 * Reine Store-Ableitungen — KEIN neuer Protokoll-Typ.
 *
 *  - In-Worktree-Kontext (INFORMATIV, kein Blocker): activeRoot.kind === "worktree"
 *    → blaue Info-Leiste „Stream X · noch nicht auf main" (Normalfall beim Review, OE-35).
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
  const streamLabel = inWorktree ? agents[activeRoot.agentId]?.label ?? "Stream" : "";
  const hit = collisions.find((c) => c.path && path.endsWith(c.path));
  const ext = externalChanged[path];

  if (!inWorktree && !hit && !ext) return null;

  return (
    <div className="file-warnings" aria-live="polite">
      {ext && (
        <div className="warn-bar external">
          <span>⟳ Datei wurde auf Disk geändert.</span>
          <button onClick={() => void reloadFile(path)}>Neu laden</button>
        </div>
      )}
      {inWorktree && (
        <div className="warn-bar info">
          ◐ Du editierst in Stream „{streamLabel}" · diese Änderung ist noch nicht auf <code>main</code> und landet
          erst, wenn dessen PR vom Integrator gemergt wird.
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
