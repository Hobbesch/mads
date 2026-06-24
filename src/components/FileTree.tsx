import { ChevronRight, ChevronDown, Folder, FolderOpen, File as FileIcon } from "lucide-react";
import { useStore } from "../store";

/**
 * Lazy Verzeichnisbaum (docs/design/07-file-explorer.md §2.2/§6) — bewusst ein einfacher,
 * KONTROLLIERTER Rekursiv-Baum direkt aus dem Store (`treeChildren` + `treeExpanded`):
 * jeder Klick auf einen Ordner ruft expandDir/collapseDir; der Core walkt eine Ebene.
 * (Ersetzt react-arborist, dessen unkontrollierter Open-State beim Nachladen der Kinder
 * zurückgesetzt wurde → Ordner ließen sich nicht zuverlässig aufklappen.)
 *
 * Reines UI — alle Reads laufen über Store-Actions. `.git`/node_modules/target sind
 * server-seitig ausgeblendet.
 */
function TreeNode({ path, name, isDir, isSymlink, depth, filter }: {
  path: string;
  name: string;
  isDir: boolean;
  isSymlink: boolean;
  depth: number;
  filter: string;
}) {
  const expanded = useStore((s) => !!s.treeExpanded[path]);
  const selected = useStore((s) => s.selectedFilePath === path);
  const loaded = useStore((s) => isDir && expanded && s.treeChildren[path] !== undefined);
  const expandDir = useStore((s) => s.expandDir);
  const collapseDir = useStore((s) => s.collapseDir);
  const openFilePath = useStore((s) => s.openFilePath);

  const onClick = () => {
    if (isDir) {
      if (expanded) collapseDir(path);
      else void expandDir(path);
    } else {
      void openFilePath(path);
    }
  };

  return (
    <>
      <div
        className={`tree-row${selected ? " selected" : ""}`}
        style={{ paddingLeft: depth * 14 + 4 }}
        onClick={onClick}
        title={path}
        role="treeitem"
        aria-expanded={isDir ? expanded : undefined}
      >
        <span className="tree-toggle">
          {isDir ? expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : <span className="tree-indent" />}
        </span>
        <span className="tree-icon">
          {isDir ? expanded ? <FolderOpen size={14} /> : <Folder size={14} /> : <FileIcon size={14} />}
        </span>
        <span className="tree-name">
          {name}
          {isSymlink ? " ↪" : ""}
        </span>
      </div>
      {isDir && expanded && (loaded ? <TreeChildren path={path} depth={depth + 1} filter={filter} /> : <LoadingRow depth={depth + 1} />)}
    </>
  );
}

function LoadingRow({ depth }: { depth: number }) {
  return (
    <div className="tree-row loading" style={{ paddingLeft: depth * 14 + 4 }}>
      <span className="tree-toggle" />
      <span className="tree-name dim">lädt…</span>
    </div>
  );
}

function TreeChildren({ path, depth, filter }: { path: string; depth: number; filter: string }) {
  const children = useStore((s) => s.treeChildren[path]);
  if (!children) return null;
  const f = filter.toLowerCase();
  return (
    <>
      {children
        // Filter (falls gesetzt): Dateien nach Namen filtern, Ordner immer zeigen,
        // damit man weiter hineinnavigieren kann. Cap-/Lade-Marker bleiben sichtbar.
        .filter((c) => !f || c.isDir || c.name.toLowerCase().includes(f))
        .map((c) => (
          <TreeNode
            key={c.path}
            path={c.path}
            name={c.name}
            isDir={c.isDir}
            isSymlink={c.isSymlink}
            depth={depth}
            filter={filter}
          />
        ))}
    </>
  );
}

export function FileTree({ root }: { root: string }) {
  const hasRoot = useStore((s) => s.treeChildren[root] !== undefined);
  const treeFilter = useStore((s) => s.treeFilter);

  return (
    <div className="file-tree" role="tree">
      {hasRoot ? (
        <TreeChildren path={root} depth={0} filter={treeFilter} />
      ) : (
        <LoadingRow depth={0} />
      )}
    </div>
  );
}
