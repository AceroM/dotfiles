import { describe, expect, test } from "bun:test";
import { changeTreeRows } from "./change-tree";

describe("changeTreeRows", () => {
  test("groups paths, collapses single-child directories, and rolls up stats", () => {
    expect(
      changeTreeRows([
        { path: "README.md", additions: 2, deletions: 0 },
        { path: "src/components/Button.tsx", additions: 12, deletions: 3 },
        { path: "src/components/Input.tsx", additions: 4, deletions: 1 },
        { path: "src/lib/git.ts", additions: 8, deletions: 6 },
      ]),
    ).toEqual([
      {
        kind: "directory",
        label: "src/",
        path: "src/",
        depth: 0,
        additions: 24,
        deletions: 10,
      },
      {
        kind: "directory",
        label: "components/",
        path: "src/components/",
        depth: 1,
        additions: 16,
        deletions: 4,
      },
      {
        kind: "file",
        label: "Button.tsx",
        path: "src/components/Button.tsx",
        depth: 2,
        additions: 12,
        deletions: 3,
      },
      {
        kind: "file",
        label: "Input.tsx",
        path: "src/components/Input.tsx",
        depth: 2,
        additions: 4,
        deletions: 1,
      },
      {
        kind: "directory",
        label: "lib/",
        path: "src/lib/",
        depth: 1,
        additions: 8,
        deletions: 6,
      },
      {
        kind: "file",
        label: "git.ts",
        path: "src/lib/git.ts",
        depth: 2,
        additions: 8,
        deletions: 6,
      },
      {
        kind: "file",
        label: "README.md",
        path: "README.md",
        depth: 0,
        additions: 2,
        deletions: 0,
      },
    ]);
  });

  test("compacts a directory-only chain", () => {
    expect(
      changeTreeRows([
        { path: "src/components/ui/Button.tsx", additions: 3, deletions: 1 },
      ]).map(({ kind, label, path, depth }) => ({ kind, label, path, depth })),
    ).toEqual([
      {
        kind: "directory",
        label: "src/components/ui/",
        path: "src/components/ui/",
        depth: 0,
      },
      {
        kind: "file",
        label: "Button.tsx",
        path: "src/components/ui/Button.tsx",
        depth: 1,
      },
    ]);
  });
});
