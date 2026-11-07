import type { DiffLine, DiffSpan } from "./delta-diff";

export type SearchHit = { line: number; start: number; end: number };

// A pathological pattern (".", "\s*") matches in every column of every line.
// Stop collecting long before that makes n/N meaningless or the render path
// slow; the footer says so when the count is capped.
export const MAX_HITS = 20000;

// vim's /pattern, as close as a diff pane gets to it:
//  - the pattern is a regex when it compiles as one and the literal text when
//    it does not, so a half-typed "(" searches for a paren instead of blowing
//    up out from under incremental search.
//  - smartcase: an all-lowercase pattern ignores case, and a pattern carrying
//    any uppercase letter is matched case-sensitively.
export function searchRegex(query: string): RegExp | null {
  if (!query) return null;
  const flags = /[A-Z]/.test(query) ? "g" : "gi";
  try {
    return new RegExp(query, flags);
  } catch {
    return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  }
}

// Every occurrence, not every matching line: n walks hits the way vim does, so
// three hits on one line are three stops with the highlight moving along it.
export function findMatches(
  lines: DiffLine[] | null,
  query: string,
): SearchHit[] {
  const hits: SearchHit[] = [];
  const re = searchRegex(query);
  if (!lines || !re) return hits;
  for (let i = 0; i < lines.length && hits.length < MAX_HITS; i++) {
    const text = lines[i].text;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      // A zero-width pattern (^, \b, x*) would spin on one line forever, and
      // there is nothing to highlight either way — step past it.
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      hits.push({ line: i, start: m.index, end: m.index + m[0].length });
      if (hits.length >= MAX_HITS) break;
    }
  }
  return hits;
}

const wrapIdx = (i: number, len: number) => ((i % len) + len) % len;

// Where a fresh search lands: the first hit at or below the top of the
// viewport going forward, the last one above it going back, wrapping around
// the ends of the diff rather than refusing to move.
export function firstMatch(
  hits: SearchHit[],
  top: number,
  dir: 1 | -1,
): number {
  if (hits.length === 0) return -1;
  if (dir === 1) {
    const i = hits.findIndex((h) => h.line >= top);
    return i === -1 ? 0 : i;
  }
  for (let i = hits.length - 1; i >= 0; i--) if (hits[i].line < top) return i;
  return hits.length - 1;
}

// n / N, and they take a count like every other motion here — 3n walks three
// hits on. vim searches from the cursor, so a hit that has scrolled out of the
// viewport (j/k, a click, an n/p file jump since the last match) re-anchors the
// walk on what is actually on screen instead of resuming from somewhere off it.
export function stepMatch(
  hits: SearchHit[],
  idx: number,
  top: number,
  viewH: number,
  dir: 1 | -1,
  n: number,
): number {
  if (hits.length === 0) return -1;
  const cur = hits[idx];
  if (cur && cur.line >= top && cur.line < top + viewH)
    return wrapIdx(idx + dir * n, hits.length);
  return wrapIdx(firstMatch(hits, top, dir) + dir * (n - 1), hits.length);
}

export type SpanRange = { start: number; end: number; style: Partial<DiffSpan> };

// Overlay styles onto a line's existing delta colors. Spans are split at every
// range boundary and the overlay merges onto the span it lands in, so a hit
// inside an added line keeps reading as added while taking the highlight.
export function paintSpans(
  spans: DiffSpan[],
  ranges: SpanRange[],
): DiffSpan[] {
  if (ranges.length === 0) return spans;
  const out: DiffSpan[] = [];
  let at = 0;
  for (const span of spans) {
    const from = at;
    const to = at + span.text.length;
    at = to;
    if (span.text.length === 0) continue;
    const cuts = new Set<number>([from, to]);
    for (const r of ranges) {
      if (r.start > from && r.start < to) cuts.add(r.start);
      if (r.end > from && r.end < to) cuts.add(r.end);
    }
    const points = [...cuts].sort((a, b) => a - b);
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const over = ranges.find((r) => r.start <= a && r.end >= b);
      out.push({
        ...span,
        ...(over ? over.style : {}),
        text: span.text.slice(a - from, b - from),
      });
    }
  }
  return out;
}

// Drop the first `from` characters of a styled line, keeping each span's style:
// the diff pane's horizontal scroll, which only ever engages to bring an
// off-screen search hit into view.
export function sliceSpans(spans: DiffSpan[], from: number): DiffSpan[] {
  if (from <= 0) return spans;
  const out: DiffSpan[] = [];
  let at = 0;
  for (const span of spans) {
    const to = at + span.text.length;
    if (to > from)
      out.push(
        at >= from ? span : { ...span, text: span.text.slice(from - at) },
      );
    at = to;
  }
  return out;
}

// How far the pane has to shift sideways for a hit to be on screen. Zero for
// anything that already fits, so ordinary browsing is never shifted; a hit past
// the right edge is brought a third of the way in from the left, and the whole
// pane shifts together so the code stays column-aligned.
export function hOffsetFor(
  hit: SearchHit | undefined,
  width: number,
): number {
  if (!hit || width <= 0 || hit.end <= width) return 0;
  return Math.max(0, hit.start - Math.floor(width / 3));
}
