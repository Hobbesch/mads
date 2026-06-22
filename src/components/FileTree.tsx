import { useMemo, useRef, useState, useEffect } from "react";
import { Tree, type NodeRendererProps } from "react-arborist";
import { ChevronRight, ChevronDown, Folder, FolderOpen, File as FileIcon } from "lucide-react";
import { useStore } from "../store";
import type { DirNode } from "../store";

/** Tree-Datenknoten für react-arborist (id = absoluter Pfad). */
interface TreeNode {
  id: string;
  name: string;
  isDir: boolean;
  isSymlink: boolean;
  children?: TreeNode[]; // undefined ⇒ Leaf; Array ⇒ Folder (ggf. mit Loading-Platzhalter)
}

const LOADING_SUFFIX = "::__loading__";

function buildChildren(path: string, treeChildren: Record<string, DirNode[]>): TreeNode[] | undefined {
  const kids = treeChildren[path];
  if (!kids) {
    // Noch nicht geladen: ein Platzhalter macht den Folder aufklappbar (lazy).
    return [{ id: path + LOADING_SUFFIX, name: "lädt…", isDir: false, isSymlink: false }];
  }
  return kids.map((k) => ({
    id: k.path,
    name: k.name,
    isDir: k.isDir,
    isSymlink: k.isSymlink,
    children: k.isDir ? buildChildren(k.path, treeChildren) : undefined,
  }));
}

function Node({ node, style }: NodeRendererProps<TreeNode>) {
  const selectedFilePath = useStore((s) => s.selectedFilePath);
  const openFilePath = useStore((s) => s.openFilePath);
  const expandDir = useStore((s) => s.expandDir);
  const collapseDir = useStore((s) => s.collapseDir);

  const d = node.data;
  const isLoading = d.id.endsWith(LOADING_SUFFIX);
  const isFolder = d.isDir;
  const selected = selectedFilePath === d.id;

  if (isLoading) {
    return (
      <div style={style} className="tree-row loading">
        <span className="tree-indent" />
        <span className="tree-name dim">lädt…</span>
      </div>
    );
  }

  return (
    <div
      style={style}
      className={`tree-row${selected ? " selected" : ""}`}
      onClick={() => {
        if (isFolder) {
          if (node.isOpen) {
            node.close();
            collapseDir(d.id);
          } else {
            node.open();
            void expandDir(d.id);
          }
        } else {
          void openFilePath(d.id);
        }
      }}
    >
      <span className="tree-toggle">
        {isFolder ? node.isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : <span className="tree-indent" />}
      </span>
      <span className="tree-icon">
        {isFolder ? node.isOpen ? <FolderOpen size={14} /> : <Folder size={14} /> : <FileIcon size={14} />}
      </span>
      <span className="tree-name" title={d.name}>
        {d.name}
        {d.isSymlink ? " ↪" : ""}
      </span>
    </div>
  );
}

/**
 * Lazy, virtualisierter Verzeichnisbaum (docs/design/07-file-explorer.md §2.2/§6) über
 * react-arborist. Der Core walkt (eine Ebene je expandDir); `.git`/node_modules/target
 * sind server-seitig ausgeblendet. Reines UI — alle Reads laufen über Store-Actions.
 */
export function FileTree({ root }: { root: string }) {
  const treeChildren = useStore((s) => s.treeChildren);
  const treeFilter = useStore((s) => s.treeFilter);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 240, height: 400 });

  useEffect(() => {
    if (!wrapRef.current) return;
    const el = wrapRef.current;
    const ro = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const data = useMemo<TreeNode[]>(() => buildChildren(root, treeChildren) ?? [], [root, treeChildren]);

  return (
    <div className="file-tree" ref={wrapRef}>
      <Tree<TreeNode>
        data={data}
        openByDefault={false}
        width={size.width}
        height={size.height}
        rowHeight={24}
        indent={14}
        disableMultiSelection
        disableDrag
        disableDrop
        disableEdit
        searchTerm={treeFilter}
        searchMatch={(node, term) => node.data.name.toLowerCase().includes(term.toLowerCase())}
      >
        {Node}
      </Tree>
    </div>
  );
}
