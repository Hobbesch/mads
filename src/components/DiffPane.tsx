import { StatusDot } from "./StatusDot";
import { MergeDiffView } from "./MergeDiffView";
import { opsToSubViews } from "../editOps";
import type { AgentVM, FileEditEntry } from "../store";
import type { Collision } from "../../shared/collision";

/** View-Projektion eines editsByFile-Eintrags (doc 09 §2.2/§3). */
export interface PaneVM {
  key: string; // `${agentId}::${path}`
  entry: FileEditEntry;
  agent?: AgentVM; // Stream-Identität (Farbe via StatusDot/STATUS_META)
  collision?: Collision; // Join auf path (§5, OE-43)
}

/** Pfad von links clippen (mono), Dateiname bleibt sichtbar. */
function shortPath(p: string): string {
  return p.length > 48 ? "…" + p.slice(p.length - 47) : p;
}

/**
 * DiffPane (docs/design/09-change-overview.md §2.2) — eine Datei eines Streams:
 * Titelzeile (StatusDot + Agent-Label + Pfad), Kollisions-Marker (§5), und der
 * `ops[]`→Sub-View-Stack (jede Sub-View bekommt eine eigene MergeDiffView, §2.4).
 */
export function DiffPane({ pane }: { pane: PaneVM }) {
  const { entry, agent, collision } = pane;
  const subViews = opsToSubViews(entry.ops, entry.contextDoc);
  const label = agent?.label ?? entry.agentId.slice(0, 8);
  const failed = entry.status === "failed";

  // Kollisions-Tönung (§5, OE-43): region/Trespass → rot, file → amber.
  const collTone = collision ? (collision.severity === "region" ? "region" : "file") : undefined;
  const rival =
    collision && agent
      ? collision.agentIdA === agent.id
        ? collision.labelB
        : collision.labelA
      : undefined;

  const status = entry.status === "applying" ? "wird angewandt" : entry.status === "applied" ? "angewandt" : "fehlgeschlagen";

  return (
    <div
      className={`diff-pane${collTone ? ` coll-${collTone}` : ""}${failed ? " failed" : ""}`}
      role="group"
      aria-label={`Diff ${entry.path}, Stream ${label}, Status ${status}`}
      tabIndex={0}
    >
      <div className="diff-pane-head">
        {agent ? <StatusDot status={agent.status} /> : <span className="dot" style={{ background: "var(--s-gray)" }} />}
        <span className="diff-pane-label">{label}</span>
        <span className="diff-pane-path" title={entry.path}>
          {shortPath(entry.path)}
        </span>
        {failed && <span className="diff-pane-badge err">Edit fehlgeschlagen</span>}
      </div>

      {collision && (
        <div className={`diff-pane-coll ${collTone}`}>
          ⚠{" "}
          {collision.severity === "region"
            ? `Region-Kollision mit „${rival}"${collision.symbols?.length ? `: ${collision.symbols.join(", ")}` : ""}`
            : `Möglicher Überlapp mit „${rival}" (gleiche Datei)`}
        </div>
      )}

      <div className="diff-pane-body">
        {subViews.map((sv) => (
          <div className="diff-subview" key={sv.key}>
            {sv.label && <div className="diff-subview-label">{sv.label}</div>}
            <MergeDiffView oldDoc={sv.oldDoc} newDoc={sv.newDoc} />
          </div>
        ))}
      </div>
    </div>
  );
}
