import { describe, expect, test } from "bun:test";
import type { DiffLine } from "./delta-diff";
import {
  findMatches,
  firstMatch,
  hOffsetFor,
  paintSpans,
  searchRegex,
  sliceSpans,
  stepMatch,
} from "./search";

const lines = (...texts: string[]): DiffLine[] =>
  texts.map((text) => ({ text, spans: [] }));

describe("searchRegex", () => {
  test("is case-insensitive until the pattern carries an uppercase letter", () => {
    expect(searchRegex("todo")!.flags).toBe("gi");
    expect(searchRegex("Todo")!.flags).toBe("g");
  });

  test("falls back to a literal when the pattern is not a valid regex", () => {
    expect("a(b".match(searchRegex("a(")!)).toEqual(["a("]);
    expect("back\\slash".match(searchRegex("\\")!)).toEqual(["\\"]);
  });

  test("an empty pattern matches nothing at all", () => {
    expect(searchRegex("")).toBeNull();
  });
});

describe("findMatches", () => {
  test("returns every occurrence, not every matching line", () => {
    expect(findMatches(lines("foo bar foo", "baz", "foo"), "foo")).toEqual([
      { line: 0, start: 0, end: 3 },
      { line: 0, start: 8, end: 11 },
      { line: 2, start: 0, end: 3 },
    ]);
  });

  test("honors regex patterns", () => {
    expect(findMatches(lines("const x = 12;", "let y = 345;"), "\\d+")).toEqual([
      { line: 0, start: 10, end: 12 },
      { line: 1, start: 8, end: 11 },
    ]);
  });

  test("a zero-width pattern terminates instead of spinning", () => {
    expect(findMatches(lines("abc", "def"), "x*")).toEqual([]);
    expect(findMatches(lines("abc"), "^")).toEqual([]);
  });
});

describe("firstMatch / stepMatch", () => {
  const hits = [
    { line: 2, start: 0, end: 3 },
    { line: 9, start: 0, end: 3 },
    { line: 40, start: 0, end: 3 },
  ];

  test("a forward search takes the first hit at or below the viewport", () => {
    expect(firstMatch(hits, 0, 1)).toBe(0);
    expect(firstMatch(hits, 9, 1)).toBe(1);
    expect(firstMatch(hits, 10, 1)).toBe(2);
  });

  test("searching past the last hit wraps to the top, and back past the first wraps to the bottom", () => {
    expect(firstMatch(hits, 99, 1)).toBe(0);
    expect(firstMatch(hits, 0, -1)).toBe(2);
    expect(firstMatch(hits, 10, -1)).toBe(1);
  });

  test("n resumes from the current hit while it is still on screen", () => {
    expect(stepMatch(hits, 0, 0, 20, 1, 1)).toBe(1);
    expect(stepMatch(hits, 0, 0, 20, 1, 2)).toBe(2);
    expect(stepMatch(hits, 0, 0, 20, -1, 1)).toBe(2); // wraps backwards
  });

  test("n re-anchors on the viewport once the current hit has scrolled away", () => {
    // idx 0 is line 2, the viewport starts at line 30: the eye is past hit 1,
    // so n lands on the hit below the viewport rather than back at line 9.
    expect(stepMatch(hits, 0, 30, 20, 1, 1)).toBe(2);
    expect(stepMatch(hits, 0, 30, 20, -1, 1)).toBe(1);
  });

  test("no hits means no match to step to", () => {
    expect(firstMatch([], 0, 1)).toBe(-1);
    expect(stepMatch([], -1, 0, 20, 1, 1)).toBe(-1);
  });
});

describe("paintSpans", () => {
  const spans = [
    { text: "+ ", color: "green" },
    { text: "const foo = 1;", color: "white" },
  ];

  test("splits a span at the range boundaries and keeps its other styles", () => {
    expect(
      paintSpans(spans, [
        { start: 8, end: 11, style: { backgroundColor: "yellow" } },
      ]),
    ).toEqual([
      { text: "+ ", color: "green" },
      { text: "const ", color: "white" },
      { text: "foo", color: "white", backgroundColor: "yellow" },
      { text: " = 1;", color: "white" },
    ]);
  });

  test("a range spanning two spans paints both halves", () => {
    expect(
      paintSpans(spans, [{ start: 1, end: 3, style: { bold: true } }]),
    ).toEqual([
      { text: "+", color: "green" },
      { text: " ", color: "green", bold: true },
      { text: "c", color: "white", bold: true },
      { text: "onst foo = 1;", color: "white" },
    ]);
  });

  test("no ranges leaves the spans untouched", () => {
    expect(paintSpans(spans, [])).toBe(spans);
  });
});

describe("sliceSpans", () => {
  test("drops leading characters across span boundaries", () => {
    expect(
      sliceSpans(
        [
          { text: "abc", color: "red" },
          { text: "defg", color: "blue" },
        ],
        4,
      ),
    ).toEqual([{ text: "efg", color: "blue" }]);
  });

  test("an offset of zero is a no-op", () => {
    const spans = [{ text: "abc" }];
    expect(sliceSpans(spans, 0)).toBe(spans);
  });
});

describe("hOffsetFor", () => {
  test("stays at zero while the hit fits on screen", () => {
    expect(hOffsetFor({ line: 0, start: 10, end: 13 }, 80)).toBe(0);
    expect(hOffsetFor(undefined, 80)).toBe(0);
  });

  test("brings a hit past the right edge a third of the way in", () => {
    expect(hOffsetFor({ line: 0, start: 200, end: 203 }, 90)).toBe(170);
  });
});
