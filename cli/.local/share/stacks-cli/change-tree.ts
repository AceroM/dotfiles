export type ChangedFile = {
  path: string;
  additions: number;
  deletions: number;
};

export type ChangeTreeRow = ChangedFile & {
  kind: "directory" | "file";
  label: string;
  depth: number;
};

type ChangeTreeDirectory = {
  additions: number;
  deletions: number;
  directories: Map<string, ChangeTreeDirectory>;
  files: ChangedFile[];
};

// Flatten a path hierarchy into terminal rows. Runs of single-child folders
// collapse into one label (src/components/ui/) so the summary stays useful in
// a narrow pane, while branch points retain the shape of the repository.
export function changeTreeRows(files: ChangedFile[]): ChangeTreeRow[] {
  const root: ChangeTreeDirectory = {
    additions: 0,
    deletions: 0,
    directories: new Map(),
    files: [],
  };

  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let directory = root;
    directory.additions += file.additions;
    directory.deletions += file.deletions;
    for (const part of parts.slice(0, -1)) {
      let child = directory.directories.get(part);
      if (!child) {
        child = {
          additions: 0,
          deletions: 0,
          directories: new Map(),
          files: [],
        };
        directory.directories.set(part, child);
      }
      child.additions += file.additions;
      child.deletions += file.deletions;
      directory = child;
    }
    directory.files.push(file);
  }

  const rows: ChangeTreeRow[] = [];
  const visit = (
    directory: ChangeTreeDirectory,
    depth: number,
    parentPath: string,
  ) => {
    const directories = [...directory.directories].sort(([a], [b]) =>
      a.localeCompare(b),
    );
    for (const [name, child] of directories) {
      let label = name;
      let path = parentPath ? `${parentPath}/${name}` : name;
      let shown = child;
      while (shown.files.length === 0 && shown.directories.size === 1) {
        const [nextName, next] = shown.directories.entries().next().value as [
          string,
          ChangeTreeDirectory,
        ];
        label += `/${nextName}`;
        path += `/${nextName}`;
        shown = next;
      }
      rows.push({
        kind: "directory",
        label: `${label}/`,
        path: `${path}/`,
        depth,
        additions: shown.additions,
        deletions: shown.deletions,
      });
      visit(shown, depth + 1, path);
    }
    for (const file of [...directory.files].sort((a, b) =>
      a.path.localeCompare(b.path),
    )) {
      rows.push({
        ...file,
        kind: "file",
        label: file.path.slice(file.path.lastIndexOf("/") + 1),
        depth,
      });
    }
  };
  visit(root, 0, "");
  return rows;
}
