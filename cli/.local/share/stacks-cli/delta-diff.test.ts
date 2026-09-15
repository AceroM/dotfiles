import { describe, expect, test } from "bun:test";
import {
  deltaLanguageForPath,
  groupDiffForDelta,
  markDeltaFileHeaders,
  parseAnsiDiff,
} from "./delta-diff";

describe("parseAnsiDiff", () => {
  test("turns Delta true-color output into OpenTUI spans", () => {
    const lines = parseAnsiDiff(
      "\x1b[38;2;116;173;232;1mheader\x1b[0m\n" +
        "\x1b[48;5;22;38;5;248madded\x1b[0K\x1b[0m\n",
    );
    expect(lines).toEqual([
      {
        text: "header",
        spans: [{ text: "header", color: "#74ade8", bold: true }],
      },
      {
        text: "added",
        spans: [
          { text: "added", color: "#a8a8a8", backgroundColor: "#005f00" },
        ],
      },
    ]);
  });

  test("strips OSC hyperlinks but keeps their labels", () => {
    expect(
      parseAnsiDiff("\x1b]8;;file:///tmp/a.ts\x1b\\a.ts\x1b]8;;\x1b\\\n")[0]
        .text,
    ).toBe("a.ts");
  });
});

describe("groupDiffForDelta", () => {
  const header = (path: string) =>
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;

  test("uses GraphQL only for Prisma diff groups and preserves order", () => {
    const groups = groupDiffForDelta(
      header("src/a.ts") + header("prisma/schema.prisma") + header("README.md"),
    );
    expect(groups.map(({ paths, defaultLanguage }) => ({ paths, defaultLanguage }))).toEqual([
      { paths: ["src/a.ts"], defaultLanguage: undefined },
      { paths: ["prisma/schema.prisma"], defaultLanguage: "graphql" },
      { paths: ["README.md"], defaultLanguage: undefined },
    ]);
  });

  test("coalesces adjacent files with the same language", () => {
    const groups = groupDiffForDelta(header("a.ts") + header("b.ts"));
    expect(groups).toHaveLength(1);
    expect(groups[0].paths).toEqual(["a.ts", "b.ts"]);
  });
});

test("Prisma paths use GraphQL as Delta's fallback language", () => {
  expect(deltaLanguageForPath("prisma/schema.prisma")).toBe("graphql");
  expect(deltaLanguageForPath("src/schema.ts")).toBeUndefined();
});

test("Delta file headings retain semantic paths", () => {
  expect(
    markDeltaFileHeaders(
      parseAnsiDiff("\x1b[34mΔ src/a.ts\x1b[0m\n code\n"),
      ["src/a.ts"],
    )[0].filePath,
  ).toBe("src/a.ts");
});
