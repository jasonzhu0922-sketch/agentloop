export interface SkillFileTreeNode {
  readonly name: string;
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly children: readonly SkillFileTreeNode[];
  readonly fileCount: number;
}

interface MutableSkillFileTreeNode {
  readonly name: string;
  readonly path: string;
  readonly kind: "directory" | "file";
  readonly children: Map<string, MutableSkillFileTreeNode>;
}

/** Preserve the package-relative hierarchy returned by the Admin Skill API. */
export function buildSkillFileTree(files: readonly string[]): readonly SkillFileTreeNode[] {
  const root = new Map<string, MutableSkillFileTreeNode>();
  for (const file of files) {
    const segments = file.split("/");
    let children = root;
    let parentPath = "";
    segments.forEach((name, index) => {
      const path = parentPath === "" ? name : `${parentPath}/${name}`;
      const kind = index === segments.length - 1 ? "file" : "directory";
      const existing = children.get(name);
      if (existing !== undefined && existing.kind !== kind) {
        throw new Error(`Skill package path conflicts with another entry: ${path}`);
      }
      const node = existing ?? { name, path, kind, children: new Map<string, MutableSkillFileTreeNode>() };
      children.set(name, node);
      children = node.children;
      parentPath = path;
    });
  }
  return materialize(root);
}

function materialize(nodes: ReadonlyMap<string, MutableSkillFileTreeNode>): readonly SkillFileTreeNode[] {
  return [...nodes.values()]
    .sort((left, right) => left.kind === right.kind ? left.name.localeCompare(right.name, "en") : left.kind === "directory" ? -1 : 1)
    .map((node) => {
      const children = materialize(node.children);
      return {
        name: node.name,
        path: node.path,
        kind: node.kind,
        children,
        fileCount: node.kind === "file" ? 1 : children.reduce((total, child) => total + child.fileCount, 0),
      };
    });
}
