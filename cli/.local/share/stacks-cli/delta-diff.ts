export type DiffSpan = {
  text: string;
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  inverse?: boolean;
};

export type DiffLine = {
  text: string;
  spans: DiffSpan[];
  // Delta can change the visual form of file headers. Keep the path as data so
  // file navigation and the changes tree do not have to scrape rendered text.
  filePath?: string;
};

export type DeltaDiffGroup = {
  raw: string;
  paths: string[];
  defaultLanguage?: string;
};

const ANSI_COLORS = [
  "#000000",
  "#cd3131",
  "#0dbc79",
  "#e5e510",
  "#2472c8",
  "#bc3fbc",
  "#11a8cd",
  "#e5e5e5",
  "#666666",
  "#f14c4c",
  "#23d18b",
  "#f5f543",
  "#3b8eea",
  "#d670d6",
  "#29b8db",
  "#ffffff",
] as const;

function ansi256(index: number): string {
  if (index < 16) return ANSI_COLORS[Math.max(0, index)] ?? ANSI_COLORS[0];
  if (index < 232) {
    const n = index - 16;
    const component = (value: number) => (value === 0 ? 0 : 55 + value * 40);
    const r = component(Math.floor(n / 36));
    const g = component(Math.floor((n % 36) / 6));
    const b = component(n % 6);
    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
  }
  const gray = Math.max(0, Math.min(255, 8 + (index - 232) * 10));
  const hex = gray.toString(16).padStart(2, "0");
  return `#${hex}${hex}${hex}`;
}

type AnsiStyle = Omit<DiffSpan, "text">;

function sameStyle(a: AnsiStyle, b: AnsiStyle): boolean {
  return (
    a.color === b.color &&
    a.backgroundColor === b.backgroundColor &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strike === b.strike &&
    a.inverse === b.inverse
  );
}

function applySgr(style: AnsiStyle, raw: string): AnsiStyle {
  const values = (raw.length ? raw : "0")
    .split(/[;:]/)
    .map((value) => Number(value || 0));
  let next = { ...style };

  for (let i = 0; i < values.length; i++) {
    const code = values[i];
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 9) next.strike = true;
    else if (code === 22) {
      delete next.bold;
      delete next.dim;
    } else if (code === 23) delete next.italic;
    else if (code === 24) delete next.underline;
    else if (code === 27) delete next.inverse;
    else if (code === 29) delete next.strike;
    else if (code >= 30 && code <= 37) next.color = ANSI_COLORS[code - 30];
    else if (code >= 90 && code <= 97) next.color = ANSI_COLORS[code - 90 + 8];
    else if (code === 39) delete next.color;
    else if (code >= 40 && code <= 47)
      next.backgroundColor = ANSI_COLORS[code - 40];
    else if (code >= 100 && code <= 107)
      next.backgroundColor = ANSI_COLORS[code - 100 + 8];
    else if (code === 49) delete next.backgroundColor;
    else if (code === 38 || code === 48) {
      const target = code === 38 ? "color" : "backgroundColor";
      if (values[i + 1] === 2 && values.length > i + 4) {
        const [r, g, b] = values.slice(i + 2, i + 5).map((value) =>
          Math.max(0, Math.min(255, value)),
        );
        next[target] = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
        i += 4;
      } else if (values[i + 1] === 5 && values.length > i + 2) {
        next[target] = ansi256(values[i + 2]);
        i += 2;
      }
    }
  }
  return next;
}

// Delta writes terminal SGR sequences, while OpenTUI expects styled spans.
// Translate the useful ANSI subset and discard cursor/erase/hyperlink controls.
export function parseAnsiDiff(raw: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let spans: DiffSpan[] = [];
  let text = "";
  let style: AnsiStyle = {};
  let plain = "";

  const flushPlain = () => {
    if (!plain) return;
    const normalized = plain.replaceAll("\t", "    ");
    const previous = spans[spans.length - 1];
    if (previous && sameStyle(previous, style)) previous.text += normalized;
    else spans.push({ text: normalized, ...style });
    text += normalized;
    plain = "";
  };
  const flushLine = () => {
    flushPlain();
    lines.push({ text, spans });
    spans = [];
    text = "";
  };

  for (let i = 0; i < raw.length; ) {
    const char = raw[i];
    if (char === "\n") {
      flushLine();
      i++;
      continue;
    }
    if (char === "\r") {
      i++;
      continue;
    }
    if (char !== "\x1b") {
      plain += char;
      i++;
      continue;
    }

    flushPlain();
    if (raw[i + 1] === "[") {
      let end = i + 2;
      while (end < raw.length && !/[@-~]/.test(raw[end])) end++;
      if (end >= raw.length) break;
      if (raw[end] === "m") style = applySgr(style, raw.slice(i + 2, end));
      i = end + 1;
      continue;
    }
    if (raw[i + 1] === "]") {
      // OSC sequences (notably hyperlinks) end with BEL or ESC + backslash.
      let end = i + 2;
      while (
        end < raw.length &&
        raw[end] !== "\x07" &&
        !(raw[end] === "\x1b" && raw[end + 1] === "\\")
      )
        end++;
      i = raw[end] === "\x1b" ? end + 2 : end + 1;
      continue;
    }
    // Unknown one-character escape.
    i += 2;
  }

  flushPlain();
  if (text || spans.length > 0 || !raw.endsWith("\n")) lines.push({ text, spans });
  return lines;
}

function pathFromHeader(header: string): string {
  const rest = header.slice("diff --git ".length);
  const marker = Math.max(rest.lastIndexOf(" b/"), rest.lastIndexOf(' "b/'));
  if (marker === -1) return rest;
  const path = rest.slice(marker + 1);
  if (path.startsWith('"b/'))
    return path.slice(3, path.endsWith('"') ? -1 : undefined);
  return path.startsWith("b/") ? path.slice(2) : path;
}

export function deltaLanguageForPath(path: string): string | undefined {
  return path.toLowerCase().endsWith(".prisma") ? "graphql" : undefined;
}

// Consecutive files with the same fallback language share one Delta process,
// avoiding a process per changed file while still scoping GraphQL to Prisma.
export function groupDiffForDelta(raw: string): DeltaDiffGroup[] {
  const blocks: Array<{ raw: string; path: string }> = [];
  let current: string[] = [];
  let path = "";

  for (const line of raw.replace(/\r/g, "").split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current.length > 0)
        blocks.push({ raw: `${current.join("\n")}\n`, path });
      current = [line];
      path = pathFromHeader(line);
    } else current.push(line);
  }
  if (current.some((line) => line.length > 0))
    blocks.push({ raw: `${current.join("\n")}\n`, path });

  if (blocks.length === 0) return [{ raw, paths: [] }];
  const groups: DeltaDiffGroup[] = [];
  for (const block of blocks) {
    const defaultLanguage = deltaLanguageForPath(block.path);
    const previous = groups[groups.length - 1];
    if (previous && previous.defaultLanguage === defaultLanguage) {
      previous.raw += block.raw;
      previous.paths.push(block.path);
    } else {
      groups.push({
        raw: block.raw,
        paths: block.path ? [block.path] : [],
        ...(defaultLanguage ? { defaultLanguage } : {}),
      });
    }
  }
  return groups;
}

export function markDeltaFileHeaders(
  lines: DiffLine[],
  paths: string[],
): DiffLine[] {
  const marked = lines.map((line) => ({ ...line }));
  let start = 0;
  for (const path of paths) {
    const at = marked.findIndex((line, i) => i >= start && line.text.includes(path));
    if (at < 0) continue;
    marked[at].filePath = path;
    start = at + 1;
  }
  return marked;
}


// Drop whole file sections from a rendered diff. A section runs from its
// marked header to the next one; lines before the first header always stay.
export function dropDiffFiles(
  lines: DiffLine[],
  drop: (path: string) => boolean,
): DiffLine[] {
  let keep = true;
  return lines.filter((line) => {
    if (line.filePath) keep = !drop(line.filePath);
    return keep;
  });
}
