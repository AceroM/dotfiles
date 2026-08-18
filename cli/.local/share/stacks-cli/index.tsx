#!/usr/bin/env bun

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  render,
  Box,
  Text,
  useApp,
  useInput,
  useStdin,
  useStdout,
} from "@dotfiles/opentui-cli";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StackBranch = {
  branch: string;
  prNumber: number | null;
  prUrl: string | null;
  prState: string | null; // OPEN | MERGED | CLOSED (from gh stack view)
  isCurrent: boolean;
  isMerged: boolean;
  isQueued: boolean;
  needsRebase: boolean;
};

type PrDetails = {
  title: string;
  state: string;
  isDraft: boolean;
  reviewDecision: string; // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ""
  additions: number;
  deletions: number;
  checks: { pass: number; fail: number; pending: number };
};

type StackData = {
  label: string;
  trunk: string;
  currentBranch: string | null;
  branches: StackBranch[]; // bottom -> top (closest to trunk first)
};

type Screen = "loading" | "pick" | "main" | "fatal";

// ---------------------------------------------------------------------------
// gh helpers
// ---------------------------------------------------------------------------

async function run(
  cmd: string[],
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

function parseViewJson(raw: string): StackData {
  const j = JSON.parse(raw) as {
    trunk: string;
    currentBranch: string;
    branches: Array<{
      name: string;
      isCurrent: boolean;
      isMerged: boolean;
      isQueued: boolean;
      needsRebase: boolean;
      pr: { number: number; url: string; state: string } | null;
    }>;
  };
  return {
    label: "current stack",
    trunk: j.trunk,
    currentBranch: j.currentBranch,
    branches: j.branches.map((b) => ({
      branch: b.name,
      prNumber: b.pr?.number ?? null,
      prUrl: b.pr?.url ?? null,
      prState: b.pr?.state ?? null,
      isCurrent: b.isCurrent,
      isMerged: b.isMerged,
      isQueued: b.isQueued,
      needsRebase: b.needsRebase,
    })),
  };
}

// Fallback when the current branch isn't part of a stack: read gh's local
// tracking file so any tracked stack in the repo can still be browsed.
async function readTrackingFile(): Promise<StackData[]> {
  const { code, out } = await run(["git", "rev-parse", "--git-common-dir"]);
  if (code !== 0) return [];
  const path = `${out.trim()}/gh-stack`;
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const j = (await file.json()) as {
    stacks?: Array<{
      number?: number;
      trunk: { branch: string };
      branches: Array<{
        branch: string;
        pullRequest?: { number: number; url: string };
      }>;
    }>;
  };
  return (j.stacks ?? []).map((s) => ({
    label: s.number ? `stack #${s.number}` : "untracked stack",
    trunk: s.trunk.branch,
    currentBranch: null,
    branches: s.branches.map((b) => ({
      branch: b.branch,
      prNumber: b.pullRequest?.number ?? null,
      prUrl: b.pullRequest?.url ?? null,
      prState: null,
      isCurrent: false,
      isMerged: false,
      isQueued: false,
      needsRebase: false,
    })),
  }));
}

async function resolveStacks(): Promise<{
  stacks: StackData[];
  viaFile: boolean;
  error?: string;
}> {
  const view = await run(["gh", "stack", "view", "--json"]);
  if (view.code === 0) {
    return { stacks: [parseViewJson(view.out)], viaFile: false };
  }
  const tracked = await readTrackingFile();
  if (tracked.length > 0) return { stacks: tracked, viaFile: true };
  return {
    stacks: [],
    viaFile: false,
    error:
      (view.err || view.out).trim() ||
      "No stack found. Run this from a branch that is part of a gh stack.",
  };
}

function summarizeChecks(rollup: unknown): PrDetails["checks"] {
  const checks = { pass: 0, fail: 0, pending: 0 };
  if (!Array.isArray(rollup)) return checks;
  for (const c of rollup as Array<Record<string, string>>) {
    const s = (c.conclusion || c.state || c.status || "").toUpperCase();
    if (s === "SUCCESS" || s === "NEUTRAL" || s === "SKIPPED") checks.pass++;
    else if (
      ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(s)
    )
      checks.fail++;
    else checks.pending++;
  }
  return checks;
}

async function fetchPrDetails(prNumber: number): Promise<PrDetails | null> {
  const { code, out } = await run([
    "gh",
    "pr",
    "view",
    String(prNumber),
    "--json",
    "title,state,isDraft,reviewDecision,additions,deletions,statusCheckRollup",
  ]);
  if (code !== 0) return null;
  const j = JSON.parse(out) as Record<string, unknown>;
  return {
    title: String(j.title ?? ""),
    state: String(j.state ?? ""),
    isDraft: Boolean(j.isDraft),
    reviewDecision: String(j.reviewDecision ?? ""),
    additions: Number(j.additions ?? 0),
    deletions: Number(j.deletions ?? 0),
    checks: summarizeChecks(j.statusCheckRollup),
  };
}

function pathFromDiffHeader(header: string): string {
  const rest = header.slice("diff --git ".length);
  const marker = Math.max(rest.lastIndexOf(" b/"), rest.lastIndexOf(' "b/'));
  if (marker === -1) return rest;

  const path = rest.slice(marker + 1);
  if (path.startsWith('"b/'))
    return path.slice(3, path.endsWith('"') ? -1 : undefined);
  return path.startsWith("b/") ? path.slice(2) : path;
}

function formatDiff(raw: string): string[] {
  const formatted: string[] = [];
  const metadata = /^(?:index |--- |\+\+\+ |(?:new|deleted) file mode |(?:old|new) mode |(?:dis)?similarity index |(?:rename|copy) (?:from|to) )/;
  let inHunk = false;

  for (const line of raw.replace(/\r/g, "").split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      if (formatted.length && formatted[formatted.length - 1] !== "")
        formatted.push("");
      formatted.push(`Δ ${pathFromDiffHeader(line)}`, "");
    } else if (line.startsWith("@@")) {
      inHunk = true;
      if (formatted.length && formatted[formatted.length - 1] !== "")
        formatted.push("");
    } else if (inHunk || !metadata.test(line)) {
      formatted.push(line.replaceAll("\t", "    "));
    }
  }

  while (formatted[formatted.length - 1] === "") formatted.pop();
  return formatted;
}

async function fetchDiff(prNumber: number): Promise<string[]> {
  const { code, out, err } = await run(["gh", "pr", "diff", String(prNumber)]);
  if (code !== 0) return [`(gh pr diff failed: ${(err || out).trim()})`];
  // OpenTUI owns terminal styling. Passing Delta's ANSI stream through a text
  // renderable exposes escape-code fragments and background-color runs.
  return formatDiff(out);
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

type Badge = { text: string; color: string };

// High-contrast diff colors tuned for dark terminal backgrounds.
const DIFF_ADD_COLOR = "#7EE787";
const DIFF_DELETE_COLOR = "#FFA198";
const DIFF_META_COLOR = "#79C0FF";
const DIFF_MUTED_COLOR = "#A7B1C2";

function badgeFor(b: StackBranch, d: PrDetails | undefined): Badge {
  if (b.prNumber == null) return { text: "no PR", color: "gray" };
  const state = d?.state ?? b.prState ?? "";
  if (b.isMerged || state === "MERGED") return { text: "Merged", color: "magenta" };
  if (state === "CLOSED") return { text: "Closed", color: "red" };
  if (b.isQueued) return { text: "Queued", color: "cyan" };
  if (d?.isDraft) return { text: "Draft", color: "gray" };
  if (d?.reviewDecision === "APPROVED") return { text: "Approved", color: "green" };
  if (d?.reviewDecision === "CHANGES_REQUESTED")
    return { text: "Changes", color: "red" };
  return { text: "Not ready", color: "yellow" };
}

function dotFor(b: StackBranch, d: PrDetails | undefined): Badge {
  const state = d?.state ?? b.prState ?? "";
  if (b.isMerged || state === "MERGED") return { text: "✓", color: "magenta" };
  if (state === "CLOSED") return { text: "✗", color: "red" };
  if (b.isQueued) return { text: "◎", color: "cyan" };
  if (b.needsRebase) return { text: "⚠", color: "yellow" };
  if (d?.isDraft) return { text: "◌", color: "gray" };
  return { text: "●", color: "yellow" };
}

function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  return s.length > max ? s.slice(0, Math.max(0, max - 1)) + "…" : s;
}

function diffLineStyle(line: string): { color?: string; bold?: boolean; dim?: boolean } {
  if (line.startsWith("Δ ")) return { color: DIFF_META_COLOR, bold: true };
  if (line.startsWith("+++") || line.startsWith("---"))
    return { color: DIFF_MUTED_COLOR };
  if (line.startsWith("@@")) return { color: DIFF_META_COLOR };
  if (line.startsWith("+")) return { color: DIFF_ADD_COLOR };
  if (line.startsWith("-")) return { color: DIFF_DELETE_COLOR };
  if (
    line.startsWith("index ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("similarity") ||
    line.startsWith("rename ")
  )
    return { color: DIFF_MUTED_COLOR };
  return {};
}

function useTermSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    cols: stdout.columns ?? 80,
    rows: stdout.rows ?? 24,
  });
  useEffect(() => {
    const onResize = () =>
      setSize({ cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  return size;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App() {
  const { exit } = useApp();
  const { cols, rows } = useTermSize();

  const [screen, setScreen] = useState<Screen>("loading");
  const [fatal, setFatal] = useState<string | null>(null);
  const [stackChoices, setStackChoices] = useState<StackData[]>([]);
  const [pickIdx, setPickIdx] = useState(0);
  const [stack, setStack] = useState<StackData | null>(null);
  const [details, setDetails] = useState<Map<number, PrDetails>>(new Map());

  // display order: top of stack first, like the GitHub stack UI
  const entries = useMemo(
    () => (stack ? [...stack.branches].reverse() : []),
    [stack],
  );

  const [selected, setSelected] = useState(0);
  const [diffLines, setDiffLines] = useState<string[] | null>(null);
  const [scroll, setScroll] = useState(0);

  const diffCache = useRef(new Map<number, string[]>());
  const scrollMemo = useRef(new Map<number, number>());
  const diffSeq = useRef(0);

  const openStack = useCallback((s: StackData) => {
    setStack(s);
    const rev = [...s.branches].reverse();
    const cur = rev.findIndex((b) => b.isCurrent);
    setSelected(cur >= 0 ? cur : 0);
    setScreen("main");
    // enrich each PR with title/state/checks in parallel
    for (const b of s.branches) {
      if (b.prNumber == null) continue;
      fetchPrDetails(b.prNumber).then((d) => {
        if (!d) return;
        setDetails((m) => {
          const next = new Map(m);
          next.set(b.prNumber!, d);
          return next;
        });
      });
    }
  }, []);

  const load = useCallback(() => {
    setScreen("loading");
    setDetails(new Map());
    diffCache.current.clear();
    setDiffLines(null);
    resolveStacks()
      .then(({ stacks, error }) => {
        if (error || stacks.length === 0) {
          setFatal(error ?? "No stacks found.");
          setScreen("fatal");
        } else if (stacks.length === 1) {
          openStack(stacks[0]);
        } else {
          setStackChoices(stacks);
          setPickIdx(0);
          setScreen("pick");
        }
      })
      .catch((e: Error) => {
        setFatal(e.message);
        setScreen("fatal");
      });
  }, [openStack]);

  useEffect(load, [load]);

  // load the diff for the selected PR (cached per PR number)
  const sel = entries[selected];
  useEffect(() => {
    if (screen !== "main" || !sel) return;
    setScroll(sel.prNumber != null ? (scrollMemo.current.get(sel.prNumber) ?? 0) : 0);
    if (sel.prNumber == null) {
      setDiffLines(["(no PR for this branch yet — nothing to diff)"]);
      return;
    }
    const cached = diffCache.current.get(sel.prNumber);
    if (cached) {
      setDiffLines(cached);
      return;
    }
    setDiffLines(null);
    const seq = ++diffSeq.current;
    const num = sel.prNumber;
    fetchDiff(num).then((lines) => {
      diffCache.current.set(num, lines);
      if (diffSeq.current === seq) setDiffLines(lines);
    });
  }, [screen, sel]);

  // ----- layout ---------------------------------------------------------
  const sidebarW = Math.max(28, Math.min(46, Math.floor(cols * 0.34)));
  // OpenTUI reserves the terminal's first line and Yoga needs room for the
  // header, footer, and their separating rows. Keep the visible diff within
  // the actual flex body so its title rows never collapse under line content.
  const bodyH = Math.max(4, rows - 5);
  const diffViewH = Math.max(1, bodyH - 2); // pane title line + meta line

  // sidebar windowing: 2 rows per entry, plus the trunk row
  const slots = Math.max(1, Math.floor((bodyH - 1) / 2));
  let winStart = 0;
  if (entries.length > slots) {
    winStart = Math.min(
      Math.max(0, selected - Math.floor(slots / 2)),
      entries.length - slots,
    );
  }
  const winEntries = entries.slice(winStart, winStart + slots);

  const fileMarks = useMemo(() => {
    if (!diffLines) return [] as number[];
    const marks: number[] = [];
    diffLines.forEach((l, i) => {
      if (l.startsWith("Δ ")) marks.push(i);
    });
    return marks;
  }, [diffLines]);

  const maxScroll = Math.max(0, (diffLines?.length ?? 0) - diffViewH);

  const setScrollFor = useCallback(
    (updater: (v: number) => number) => {
      setScroll((v) => {
        const next = Math.max(0, Math.min(maxScroll, updater(v)));
        if (sel?.prNumber != null) scrollMemo.current.set(sel.prNumber, next);
        return next;
      });
    },
    [maxScroll, sel],
  );

  // ----- mouse ----------------------------------------------------------
  const { stdin } = useStdin();

  const onMouse = useRef<(button: number, x: number, y: number) => void>(() => {});
  onMouse.current = (button, x, y) => {
    if (button === 64 || button === 65) {
      // wheel: over the sidebar it moves the selection, elsewhere it scrolls
      const dir = button === 64 ? -1 : 1;
      if (screen === "pick")
        setPickIdx((i) => Math.max(0, Math.min(stackChoices.length - 1, i + dir)));
      else if (screen !== "main") return;
      else if (x < sidebarW)
        setSelected((i) => Math.max(0, Math.min(entries.length - 1, i + dir)));
      else setScrollFor((v) => v + dir * 3);
      return;
    }
    if (button !== 0) return; // left click only

    if (screen === "pick") {
      // padding row + title + subtitle + margin row, then 2 rows per stack
      const i = Math.floor((y - 4) / 2);
      if (y >= 4 && i < stackChoices.length) openStack(stackChoices[i]);
      return;
    }
    if (screen !== "main" || x >= sidebarW) return;
    // header row + border row, plus the "↑ N more" line when windowed
    const top = 2 + (winStart > 0 ? 1 : 0);
    const wi = Math.floor((y - top) / 2);
    if (y >= top && wi < winEntries.length) setSelected(winStart + wi);
  };

  useEffect(() => {
    if (!stdin) return;
    const onData = (data: Buffer | string) => {
      // SGR mouse reports: \x1b[<button;col;row then M (press) / m (release)
      const re = /\x1b\[<(\d+);(\d+);(\d+)M/g;
      const s = data.toString();
      let m: RegExpExecArray | null;
      while ((m = re.exec(s)))
        onMouse.current(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 1);
    };
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
    };
  }, [stdin]);

  // ----- input ----------------------------------------------------------
  useInput((input, key) => {
    if (input.includes("[<")) return; // mouse reports, handled above
    if (input === "q" || key.escape) {
      exit();
      return;
    }

    if (screen === "pick") {
      if (key.upArrow || input === "k") setPickIdx((i) => Math.max(0, i - 1));
      else if (key.downArrow || input === "j")
        setPickIdx((i) => Math.min(stackChoices.length - 1, i + 1));
      else if (key.return) openStack(stackChoices[pickIdx]);
      return;
    }

    if (screen !== "main") return;

    if (key.upArrow || (key.tab && key.shift))
      setSelected((i) => Math.max(0, i - 1));
    else if (key.downArrow || key.tab)
      setSelected((i) => Math.min(entries.length - 1, i + 1));
    else if (/^[1-9]$/.test(input)) {
      const n = parseInt(input, 10) - 1;
      if (n < entries.length) setSelected(n);
    } else if (input === "j") setScrollFor((v) => v + 1);
    else if (input === "k") setScrollFor((v) => v - 1);
    else if (key.pageDown || input === " ") setScrollFor((v) => v + diffViewH);
    else if (key.pageUp || input === "b") setScrollFor((v) => v - diffViewH);
    else if (input === "d") setScrollFor((v) => v + Math.ceil(diffViewH / 2));
    else if (input === "u") setScrollFor((v) => v - Math.ceil(diffViewH / 2));
    else if (input === "g") setScrollFor(() => 0);
    else if (input === "G") setScrollFor(() => maxScroll);
    else if (input === "n")
      setScrollFor((v) => fileMarks.find((m) => m > v) ?? v);
    else if (input === "p")
      setScrollFor((v) => [...fileMarks].reverse().find((m) => m < v) ?? 0);
    else if (input === "o" && sel?.prNumber != null)
      Bun.spawn(["gh", "pr", "view", String(sel.prNumber), "--web"], {
        stdout: "ignore",
        stderr: "ignore",
      });
    else if (input === "r") load();
  });

  // ----- screens --------------------------------------------------------
  if (screen === "loading") {
    return (
      <Box padding={1}>
        <Text color="cyan">loading stack…</Text>
      </Box>
    );
  }

  if (screen === "fatal") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">{fatal}</Text>
        <Text dimColor>press q to quit</Text>
      </Box>
    );
  }

  if (screen === "pick") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">
          Pick a stack
        </Text>
        <Text dimColor>current branch isn't in a stack — tracked stacks in this repo:</Text>
        <Box flexDirection="column" marginTop={1}>
          {stackChoices.map((s, i) => (
            <Box key={i} flexDirection="column">
              <Text color={i === pickIdx ? "cyan" : undefined}>
                {i === pickIdx ? "❯ " : "  "}
                <Text bold={i === pickIdx}>{s.label}</Text>
                <Text dimColor>
                  {"  "}
                  {s.branches.length} branch{s.branches.length === 1 ? "" : "es"} · trunk{" "}
                  {s.trunk}
                </Text>
              </Text>
              <Text dimColor>
                {"    "}
                {s.branches
                  .map((b) => b.branch)
                  .join(", ")
                  .slice(0, cols - 6)}
              </Text>
            </Box>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>↑↓ choose · enter open · q quit</Text>
        </Box>
      </Box>
    );
  }

  if (!stack || !sel) return null;

  // ----- main -----------------------------------------------------------
  const needsRebase = entries.some((b) => b.needsRebase);
  const selDetails = sel.prNumber != null ? details.get(sel.prNumber) : undefined;
  const baseBranch =
    stack.branches[stack.branches.indexOf(sel) - 1]?.branch ?? stack.trunk;

  const pct =
    maxScroll === 0 ? 100 : Math.round((Math.min(scroll, maxScroll) / maxScroll) * 100);
  const visible = (diffLines ?? []).slice(scroll, scroll + diffViewH);

  return (
    <Box flexDirection="column" width={cols} height={rows} overflow="hidden">
      {/* header */}
      <Box paddingX={1} flexShrink={0}>
        <Text>
          <Text bold color="cyan">
            {stack.label}
          </Text>
          <Text dimColor>
            {" "}
            · {entries.length} PR{entries.length === 1 ? "" : "s"} · trunk {stack.trunk}
          </Text>
          {needsRebase ? <Text color="yellow">  ⚠ out-of-date with {stack.trunk}</Text> : null}
        </Text>
      </Box>

      <Box flexDirection="row" flexGrow={1} minHeight={0} overflow="hidden">
        {/* sidebar */}
        <Box
          flexDirection="column"
          width={sidebarW}
          height="100%"
          flexShrink={0}
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
          overflow="hidden"
        >
          {winStart > 0 ? <Text dimColor>↑ {winStart} more</Text> : null}
          {winEntries.map((b, wi) => {
            const i = winStart + wi;
            const active = i === selected;
            const d = b.prNumber != null ? details.get(b.prNumber) : undefined;
            const dot = dotFor(b, d);
            const badge = badgeFor(b, d);
            const innerW = sidebarW - 4; // border + padding
            const titleW = Math.max(4, innerW - 3 - badge.text.length - 1);
            const title = truncate(d?.title ?? b.branch, titleW).padEnd(titleW);
            const meta = truncate(
              `${b.prNumber != null ? `#${b.prNumber} · ` : ""}${b.branch}${b.isCurrent ? " ✦" : ""}`,
              innerW - 4,
            );
            return (
              <Box key={b.branch} flexDirection="column">
                <Text wrap="truncate-end">
                  <Text color="blue">{active ? "▎" : " "}</Text>
                  <Text color={dot.color}>{dot.text}</Text>{" "}
                  <Text bold={active} color={active ? "white" : undefined}>
                    {title}
                  </Text>{" "}
                  <Text color={badge.color}>{badge.text}</Text>
                </Text>
                <Text dimColor wrap="truncate-end">
                  {"  │ "}
                  {meta}
                </Text>
              </Box>
            );
          })}
          {winStart + slots < entries.length ? (
            <Text dimColor>↓ {entries.length - winStart - slots} more</Text>
          ) : null}
          <Text dimColor> ○ {stack.trunk}</Text>
        </Box>

        {/* diff pane */}
        <Box
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          minWidth={0}
          paddingLeft={1}
          overflow="hidden"
        >
          <Text wrap="truncate-end" flexShrink={0}>
            {sel.prNumber != null ? (
              <Text bold color="cyan">
                #{sel.prNumber}{" "}
              </Text>
            ) : null}
            <Text bold>{selDetails?.title ?? sel.branch}</Text>
          </Text>
          <Text dimColor wrap="truncate-end" flexShrink={0}>
            {sel.branch} → {baseBranch}
            {selDetails ? (
              <>
                {" · "}
                <Text color={DIFF_ADD_COLOR}>+{selDetails.additions}</Text>{" "}
                <Text color={DIFF_DELETE_COLOR}>−{selDetails.deletions}</Text>
                {selDetails.checks.fail > 0 ? (
                  <Text color={DIFF_DELETE_COLOR}> · ✗ {selDetails.checks.fail} checks</Text>
                ) : selDetails.checks.pending > 0 ? (
                  <Text color="yellow"> · ◌ {selDetails.checks.pending} pending</Text>
                ) : selDetails.checks.pass > 0 ? (
                  <Text color={DIFF_ADD_COLOR}> · ✓ checks</Text>
                ) : null}
              </>
            ) : null}
            {" · "}
            {pct}%
          </Text>
          {diffLines === null ? (
            <Text dimColor>loading diff…</Text>
          ) : (
            visible.map((line, i) => {
              const s = diffLineStyle(line);
              return (
                <Box
                  key={scroll + i}
                  width="100%"
                  flexShrink={0}
                  overflow="hidden"
                >
                  <Text color={s.color} bold={s.bold} dimColor={s.dim} wrap="truncate-end">
                    {line.length ? line : " "}
                  </Text>
                </Box>
              );
            })
          )}
        </Box>
      </Box>

      {/* footer */}
      <Box paddingX={1} flexShrink={0}>
        <Text dimColor wrap="truncate-end">
          ↑↓/click pr · j/k/wheel scroll · d/u half · g/G top/bot · n/p file · o open · r refresh · q quit
        </Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

if (argv.includes("--dump")) {
  // headless mode for debugging: print resolved stack data as JSON
  const { stacks, viaFile, error } = await resolveStacks();
  if (error) {
    console.error(error);
    process.exit(1);
  }
  const first = stacks[0];
  const enriched = await Promise.all(
    first.branches.map(async (b) => ({
      ...b,
      details: b.prNumber != null ? await fetchPrDetails(b.prNumber) : null,
    })),
  );
  console.log(JSON.stringify({ viaFile, stackCount: stacks.length, ...first, branches: enriched }, null, 2));
  process.exit(0);
}

if (argv.includes("-h") || argv.includes("--help")) {
  console.log(`stacks — browse a gh stack: PRs on the left, gh pr diff on the right

usage: stacks [--dump]

keys: ↑↓/tab pick PR · j/k scroll · d/u half page · space/b page ·
      g/G top/bottom · n/p next/prev file · 1-9 jump · o open in browser ·
      r refresh · q quit
mouse: click a PR to select it · wheel scrolls the diff (over the sidebar it
       moves the selection)`);
  process.exit(0);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("stacks requires an interactive terminal (or use --dump).");
  process.exit(1);
}

const app = await render(<App />);
await app.waitUntilExit();
