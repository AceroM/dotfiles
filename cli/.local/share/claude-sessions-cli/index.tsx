#!/usr/bin/env bun

import React, {
  useState,
  useEffect,
  useMemo,
  useCallback,
  type ReactNode,
} from "react";
import { render, Box, Text, useApp, useInput, useStdout } from "ink";
import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SessionMeta = {
  id: string;
  filePath: string;
  projectDir: string;
  cwd: string;
  title: string;
  modifiedAt: number;
  size: number;
};

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
};

type SessionDetail = {
  id: string;
  messages: ChatMessage[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECTS_DIR = path.join(homedir(), ".claude", "projects");

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + "…";
}

function pad(str: string, width: number): string {
  return str.length >= width
    ? str.slice(0, width)
    : str + " ".repeat(width - str.length);
}

function relativeTime(ms: number): string {
  const now = Date.now();
  const diff = Math.max(0, now - ms) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400 / 7)}w ago`;
  return `${Math.floor(diff / 86400 / 30)}mo ago`;
}

function projectLabel(cwd: string, projectDir: string): string {
  const src = cwd || projectDir;
  if (!src) return "(unknown)";
  const home = homedir();
  if (src.startsWith(home)) {
    const rest = src.slice(home.length).replace(/^\//, "");
    return rest ? `~/${rest}` : "~";
  }
  return src;
}

// ---------------------------------------------------------------------------
// Title / metadata extraction (lightweight: head + tail only)
// ---------------------------------------------------------------------------

const TAIL_BYTES = 16 * 1024;
const HEAD_BYTES = 16 * 1024;

function parseLines(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

function extractStringText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (
        item &&
        typeof item === "object" &&
        (item as any).type === "text" &&
        typeof (item as any).text === "string"
      ) {
        parts.push((item as any).text);
      }
    }
    return parts.join("\n");
  }
  return "";
}

function isDisplayableUserText(text: string): boolean {
  if (!text) return false;
  if (text.startsWith("<local-command-caveat>")) return false;
  if (text.startsWith("<command-name>")) return false;
  if (text.startsWith("<bash-stdout>")) return false;
  if (text.startsWith("<bash-stderr>")) return false;
  if (text.startsWith("<command-message>")) return false;
  if (text.startsWith("<command-args>")) return false;
  return true;
}

function normalizeUserText(text: string): string {
  // Strip <bash-input>…</bash-input> wrappers for display
  const bashIn = text.match(/^<bash-input>([\s\S]*)<\/bash-input>$/);
  if (bashIn) return `$ ${bashIn[1].trim()}`;
  return text;
}

async function readMeta(
  filePath: string,
  projectDir: string,
): Promise<SessionMeta | null> {
  try {
    const st = await stat(filePath);
    if (!st.isFile()) return null;
    const file = Bun.file(filePath);
    const size = st.size;

    let head = "";
    let tail = "";
    if (size <= HEAD_BYTES + TAIL_BYTES) {
      head = await file.text();
    } else {
      head = await file.slice(0, HEAD_BYTES).text();
      tail = await file.slice(size - TAIL_BYTES).text();
    }

    // Drop possibly-partial first/last lines from sliced reads
    if (tail) {
      const firstNl = tail.indexOf("\n");
      if (firstNl > -1) tail = tail.slice(firstNl + 1);
    }
    if (size > HEAD_BYTES + TAIL_BYTES) {
      const lastNl = head.lastIndexOf("\n");
      if (lastNl > -1) head = head.slice(0, lastNl);
    }

    const entries = [...parseLines(head), ...parseLines(tail)];

    let title = "";
    let cwd = "";
    let firstUser = "";
    let lastPrompt = "";

    for (const e of entries) {
      if (!cwd && typeof e?.cwd === "string") cwd = e.cwd;
      if (e?.type === "ai-title" && typeof e.aiTitle === "string") {
        title = e.aiTitle;
      }
      if (e?.type === "last-prompt" && typeof e.lastPrompt === "string") {
        lastPrompt = e.lastPrompt;
      }
      if (
        !firstUser &&
        e?.type === "user" &&
        !e.isMeta &&
        e?.message?.role === "user"
      ) {
        const raw = extractStringText(e.message.content);
        if (isDisplayableUserText(raw)) {
          firstUser = normalizeUserText(raw).replace(/\s+/g, " ").trim();
        }
      }
    }

    const id = path.basename(filePath, ".jsonl");
    const finalTitle =
      title ||
      (firstUser && truncate(firstUser, 80)) ||
      (lastPrompt && truncate(lastPrompt, 80)) ||
      "(no title)";

    return {
      id,
      filePath,
      projectDir,
      cwd,
      title: finalTitle,
      modifiedAt: st.mtimeMs,
      size,
    };
  } catch {
    return null;
  }
}

async function scanAllSessions(
  onProgress?: (done: number, total: number) => void,
): Promise<SessionMeta[]> {
  let projectDirs: string[] = [];
  try {
    projectDirs = await readdir(PROJECTS_DIR);
  } catch {
    return [];
  }

  const jobs: Array<{ filePath: string; projectDir: string }> = [];
  for (const d of projectDirs) {
    const dirPath = path.join(PROJECTS_DIR, d);
    let files: string[] = [];
    try {
      files = await readdir(dirPath);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      jobs.push({ filePath: path.join(dirPath, f), projectDir: d });
    }
  }

  const total = jobs.length;
  const results: SessionMeta[] = [];
  const concurrency = 32;
  let cursor = 0;
  let done = 0;

  async function worker() {
    while (cursor < jobs.length) {
      const idx = cursor++;
      const job = jobs[idx];
      const meta = await readMeta(job.filePath, job.projectDir);
      if (meta) results.push(meta);
      done++;
      if (onProgress && done % 32 === 0) onProgress(done, total);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  onProgress?.(total, total);

  return results.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

// ---------------------------------------------------------------------------
// Full-session loading (for preview)
// ---------------------------------------------------------------------------

async function loadSessionDetail(meta: SessionMeta): Promise<SessionDetail> {
  let text = "";
  try {
    text = await Bun.file(meta.filePath).text();
  } catch {
    return { id: meta.id, messages: [] };
  }

  const messages: ChatMessage[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj?.isSidechain) continue;

    if (obj?.type === "user" && obj?.message?.role === "user" && !obj.isMeta) {
      // Skip pure tool-result messages
      const c = obj.message.content;
      if (Array.isArray(c) && c.every((b: any) => b?.type === "tool_result")) {
        continue;
      }
      const raw = extractStringText(c);
      if (!isDisplayableUserText(raw)) continue;
      const text = normalizeUserText(raw).trim();
      if (!text) continue;
      messages.push({
        role: "user",
        text,
        timestamp: obj.timestamp ?? "",
      });
      continue;
    }

    if (obj?.type === "assistant" && obj?.message?.role === "assistant") {
      const c = obj.message.content;
      if (!Array.isArray(c)) continue;
      const parts: string[] = [];
      for (const b of c) {
        if (b?.type === "text" && typeof b.text === "string") {
          parts.push(b.text);
        }
      }
      const text = parts.join("\n").trim();
      if (!text) continue;
      messages.push({
        role: "assistant",
        text,
        timestamp: obj.timestamp ?? "",
      });
    }
  }

  // Coalesce consecutive same-role messages (assistant sends multi-part)
  const coalesced: ChatMessage[] = [];
  for (const m of messages) {
    const prev = coalesced[coalesced.length - 1];
    if (prev && prev.role === m.role) {
      prev.text += "\n" + m.text;
    } else {
      coalesced.push({ ...m });
    }
  }

  return { id: meta.id, messages: coalesced };
}

// ---------------------------------------------------------------------------
// tmux spawn
// ---------------------------------------------------------------------------

const FALLBACK_ADJECTIVES = [
  "amber",
  "brave",
  "calm",
  "dapper",
  "eager",
  "fabled",
  "gentle",
  "hardy",
  "icy",
  "jaunty",
  "keen",
  "lucid",
  "misty",
  "noble",
  "odd",
  "plucky",
  "quick",
  "radiant",
  "sunny",
  "tidy",
  "upbeat",
  "vivid",
  "witty",
  "young",
  "zesty",
];

const FALLBACK_NOUNS = [
  "anchor",
  "beacon",
  "citadel",
  "dragon",
  "ember",
  "falcon",
  "grove",
  "harbor",
  "island",
  "junction",
  "kingdom",
  "lantern",
  "meadow",
  "nebula",
  "oasis",
  "prairie",
  "quarry",
  "rocket",
  "summit",
  "temple",
  "urchin",
  "valley",
  "workshop",
  "yard",
  "zephyr",
];

let cachedPools: { adj: string[]; noun: string[] } | null = null;

function loadNamePools(): { adj: string[]; noun: string[] } {
  if (cachedPools) return cachedPools;
  const r = spawnSync(
    "zsh",
    [
      "-c",
      `source ${homedir()}/.config/zsh/variables.zsh 2>/dev/null; printf '%s\\n' "\${SESSION_NAME_ADJECTIVES[@]}"; echo '---'; printf '%s\\n' "\${SESSION_NAME_NOUNS[@]}"`,
    ],
    { encoding: "utf8" },
  );
  if (r.status === 0 && r.stdout) {
    const [a, n] = r.stdout.split("---\n");
    const adj = a.trim().split("\n").filter(Boolean);
    const noun = (n ?? "").trim().split("\n").filter(Boolean);
    if (adj.length && noun.length) {
      cachedPools = { adj, noun };
      return cachedPools;
    }
  }
  cachedPools = { adj: FALLBACK_ADJECTIVES, noun: FALLBACK_NOUNS };
  return cachedPools;
}

function tmuxHasSession(name: string): boolean {
  return spawnSync("tmux", ["has-session", "-t", name]).status === 0;
}

function pickSessionName(): string {
  const { adj, noun } = loadNamePools();
  for (let i = 0; i < 100; i++) {
    const name = `${adj[Math.floor(Math.random() * adj.length)]}-${noun[Math.floor(Math.random() * noun.length)]}`;
    if (!tmuxHasSession(name)) return name;
  }
  return `claude-${Date.now().toString(36)}`;
}

type SpawnPlan = {
  sessionName: string;
  attach: "switch" | "attach";
};

function createTmuxSession(meta: SessionMeta): SpawnPlan | { error: string } {
  const cwd = meta.cwd && existsSync(meta.cwd) ? meta.cwd : process.cwd();
  const sessionName = pickSessionName();

  const claudeCmd = `CLAUDE_CODE_NO_FLICKER=0 direnv exec '${cwd.replace(/'/g, "'\\''")}' claude --resume ${meta.id}`;

  const r = spawnSync(
    "tmux",
    ["new-session", "-ds", sessionName, "-c", cwd, claudeCmd],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    return { error: r.stderr || `tmux exited ${r.status}` };
  }
  return {
    sessionName,
    attach: process.env.TMUX ? "switch" : "attach",
  };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function Header() {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="cyan">
        claude-sessions
      </Text>
      <Text dimColor>
        ↑↓ navigate · → preview · ← close · enter resume in tmux · / search · q
        quit
      </Text>
    </Box>
  );
}

function FilterBar({
  search,
  searching,
  count,
  total,
}: {
  search: string;
  searching: boolean;
  count: number;
  total: number;
}) {
  return (
    <Box gap={1} marginBottom={0}>
      <Text dimColor>
        {count === total ? `${total} sessions` : `${count}/${total} sessions`}
      </Text>
      {(searching || search) && (
        <Text>
          <Text dimColor> / </Text>
          <Text color="yellow">{search}</Text>
          {searching && <Text color="yellow">▌</Text>}
        </Text>
      )}
    </Box>
  );
}

function TableHeader({ width }: { width: number }) {
  const titleW = Math.max(12, width - 38);
  return (
    <Box>
      <Text dimColor>
        {pad(" # ", 4)}
        {pad("Title", titleW)}
        {pad("Project", 22)}
        {pad("When", 12)}
      </Text>
    </Box>
  );
}

function SessionRow({
  meta,
  rank,
  active,
  width,
}: {
  meta: SessionMeta;
  rank: number;
  active: boolean;
  width: number;
}) {
  const titleW = Math.max(12, width - 38);
  const cursor = active ? "❯" : " ";
  const proj = projectLabel(meta.cwd, meta.projectDir);
  const projTrunc = truncate(proj, 21);
  const titleTrunc = truncate(meta.title, titleW - 1);
  return (
    <Box>
      <Text color={active ? "cyan" : undefined}>
        {cursor}
        {pad(String(rank), 3)}
      </Text>
      <Text color={active ? "cyan" : undefined} bold={active}>
        {pad(titleTrunc, titleW)}
      </Text>
      <Text dimColor>{pad(projTrunc, 22)}</Text>
      <Text dimColor>{pad(relativeTime(meta.modifiedAt), 12)}</Text>
    </Box>
  );
}

function MessageBox({
  msg,
  width,
  maxLines,
}: {
  msg: ChatMessage;
  width: number;
  maxLines: number;
}) {
  const isUser = msg.role === "user";
  const color = isUser ? "cyan" : "gray";
  const label = isUser ? "user" : "assistant";

  // Truncate the message to maxLines lines, also wrapping long lines first
  const innerWidth = Math.max(10, width - 4);
  const wrapped: string[] = [];
  for (const rawLine of msg.text.split("\n")) {
    if (rawLine === "") {
      wrapped.push("");
      continue;
    }
    let rest = rawLine;
    while (rest.length > innerWidth) {
      wrapped.push(rest.slice(0, innerWidth));
      rest = rest.slice(innerWidth);
      if (wrapped.length >= maxLines) break;
    }
    if (wrapped.length >= maxLines) break;
    wrapped.push(rest);
  }
  let lines = wrapped.slice(0, maxLines);
  if (wrapped.length > maxLines) {
    const last = lines[lines.length - 1] ?? "";
    lines[lines.length - 1] = truncate(last + " …", innerWidth);
  }

  return (
    <Box
      borderStyle="round"
      borderColor={color}
      flexDirection="column"
      paddingX={1}
      width={width}
    >
      <Text color={color} bold>
        {label}
      </Text>
      {lines.map((l, i) => (
        <Text key={i} wrap="truncate-end">
          {l || " "}
        </Text>
      ))}
    </Box>
  );
}

function PreviewPane({
  meta,
  detail,
  loading,
  width,
  height,
}: {
  meta: SessionMeta | undefined;
  detail: SessionDetail | undefined;
  loading: boolean;
  width: number;
  height: number;
}) {
  if (!meta) {
    return (
      <Box
        borderStyle="round"
        borderColor="gray"
        width={width}
        height={height}
        flexDirection="column"
        paddingX={1}
      >
        <Text dimColor>No session selected</Text>
      </Box>
    );
  }

  const innerWidth = Math.max(20, width - 4);
  const headerLines = 4; // title + meta + sep + spacing
  const available = Math.max(4, height - headerLines - 2);

  let body: ReactNode;
  if (loading || !detail) {
    body = <Text dimColor>Loading…</Text>;
  } else if (detail.messages.length === 0) {
    body = <Text dimColor>(no displayable messages)</Text>;
  } else {
    // Each box costs ~3 chrome lines (top border + role label + bottom border)
    // plus its content. Pick the most recent messages that fit.
    const CHROME = 3;
    const MIN_CONTENT = 2;
    const maxBoxes = Math.max(1, Math.floor(available / (CHROME + MIN_CONTENT)));
    const recent = detail.messages.slice(-maxBoxes);
    const perMsg = Math.max(
      MIN_CONTENT,
      Math.floor(available / recent.length) - CHROME,
    );
    body = (
      <Box flexDirection="column">
        {recent.map((m, i) => (
          <MessageBox key={i} msg={m} width={innerWidth} maxLines={perMsg} />
        ))}
      </Box>
    );
  }

  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      width={width}
      height={height}
      flexDirection="column"
      paddingX={1}
      overflow="hidden"
    >
      <Text bold color="cyan" wrap="truncate-end">
        {meta.title}
      </Text>
      <Text dimColor wrap="truncate-end">
        {projectLabel(meta.cwd, meta.projectDir)} · {relativeTime(meta.modifiedAt)} · {meta.id.slice(0, 8)}
      </Text>
      <Text dimColor>{"─".repeat(innerWidth)}</Text>
      {body}
    </Box>
  );
}

function Footer({ status }: { status: string }) {
  return (
    <Box marginTop={1}>
      <Text dimColor>{status}</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

type PostExit = {
  attach?: { name: string; mode: "switch" | "attach" };
  message?: string;
  error?: string;
};

function App({ postExit }: { postExit: PostExit }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const termWidth = stdout?.columns ?? 100;
  const termRows = Math.max(5, (stdout?.rows ?? 30) - 8);

  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadProgress, setLoadProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);

  const [cursor, setCursor] = useState(0);
  const [viewport, setViewport] = useState(0);
  const [search, setSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailCache, setDetailCache] = useState<Map<string, SessionDetail>>(
    new Map(),
  );
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    scanAllSessions((done, total) => {
      if (alive) setLoadProgress({ done, total });
    })
      .then((s) => {
        if (!alive) return;
        setSessions(s);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setError(String(e?.message ?? e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const filtered = useMemo(() => {
    if (!search) return sessions;
    const q = search.toLowerCase();
    return sessions.filter((s) => {
      return (
        s.title.toLowerCase().includes(q) ||
        s.cwd.toLowerCase().includes(q) ||
        s.projectDir.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q)
      );
    });
  }, [sessions, search]);

  useEffect(() => {
    setCursor(0);
    setViewport(0);
  }, [search]);

  const current = filtered[cursor];

  // Lazy-load preview detail
  useEffect(() => {
    if (!detailOpen || !current) return;
    if (detailCache.has(current.id)) return;
    setDetailLoading(true);
    let alive = true;
    loadSessionDetail(current).then((d) => {
      if (!alive) return;
      setDetailCache((prev) => {
        const next = new Map(prev);
        next.set(d.id, d);
        return next;
      });
      setDetailLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [detailOpen, current?.id]);

  const listWidth = detailOpen ? Math.floor(termWidth * 0.45) : termWidth;
  const detailWidth = termWidth - listWidth;

  useInput((input, key) => {
    if (searching) {
      if (key.escape || key.return) {
        setSearching(false);
        return;
      }
      if (key.backspace || key.delete) {
        setSearch((s) => s.slice(0, -1));
        return;
      }
      if (
        input &&
        !key.upArrow &&
        !key.downArrow &&
        !key.leftArrow &&
        !key.rightArrow &&
        !key.ctrl
      ) {
        setSearch((s) => s + input);
      }
      return;
    }

    if (input === "q") {
      exit();
      return;
    }
    if (input === "/") {
      setSearching(true);
      return;
    }
    if (loading) return;

    if (key.escape) {
      if (search) {
        setSearch("");
        return;
      }
      if (detailOpen) setDetailOpen(false);
      return;
    }

    if (key.return) {
      if (!current) return;
      const result = createTmuxSession(current);
      if ("error" in result) {
        postExit.error = result.error;
      } else {
        postExit.attach = { name: result.sessionName, mode: result.attach };
        postExit.message = `Resuming ${current.id.slice(0, 8)} in tmux session "${result.sessionName}"`;
      }
      exit();
      return;
    }

    if (key.rightArrow) {
      setDetailOpen(true);
      return;
    }
    if (key.leftArrow) {
      setDetailOpen(false);
      return;
    }

    if (key.upArrow) {
      setCursor((c) => {
        const next = Math.max(0, c - 1);
        setViewport((v) => (next < v ? next : v));
        return next;
      });
      return;
    }
    if (key.downArrow) {
      setCursor((c) => {
        const next = Math.min(filtered.length - 1, c + 1);
        setViewport((v) => (next >= v + termRows ? next - termRows + 1 : v));
        return next;
      });
      return;
    }
  });

  if (error) {
    return (
      <Box flexDirection="column">
        <Header />
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  if (loading) {
    const { done, total } = loadProgress;
    return (
      <Box flexDirection="column">
        <Header />
        <Text>
          Scanning sessions… {done}
          {total ? ` / ${total}` : ""}
        </Text>
      </Box>
    );
  }

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column">
        <Header />
        <Text color="yellow">No sessions found under {PROJECTS_DIR}</Text>
      </Box>
    );
  }

  const visible = filtered.slice(viewport, viewport + termRows);
  const status =
    filtered.length > termRows
      ? `${viewport + 1}–${Math.min(viewport + termRows, filtered.length)} of ${filtered.length}`
      : `${filtered.length} sessions`;

  return (
    <Box flexDirection="column">
      <Header />
      <FilterBar
        search={search}
        searching={searching}
        count={filtered.length}
        total={sessions.length}
      />
      <Box flexDirection="row">
        <Box flexDirection="column" width={listWidth}>
          <TableHeader width={listWidth} />
          {visible.map((meta, i) => {
            const globalIdx = viewport + i;
            return (
              <SessionRow
                key={meta.id}
                meta={meta}
                rank={globalIdx + 1}
                active={globalIdx === cursor}
                width={listWidth}
              />
            );
          })}
        </Box>
        {detailOpen && (
          <PreviewPane
            meta={current}
            detail={current ? detailCache.get(current.id) : undefined}
            loading={detailLoading && !detailCache.has(current?.id ?? "")}
            width={detailWidth}
            height={termRows + 2}
          />
        )}
      </Box>
      <Footer status={status} />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("claude-sessions requires an interactive terminal.");
  process.exit(1);
}

const postExit: PostExit = {};
const { waitUntilExit } = render(<App postExit={postExit} />);
await waitUntilExit();

if (postExit.error) {
  console.error(`Error spawning tmux: ${postExit.error}`);
  process.exit(1);
}

if (postExit.attach) {
  const { name, mode } = postExit.attach;
  if (postExit.message) console.log(postExit.message);
  if (mode === "switch") {
    const r = spawnSync("tmux", ["switch-client", "-t", name], {
      stdio: "inherit",
    });
    process.exit(r.status ?? 0);
  } else {
    const r = spawnSync("tmux", ["attach", "-t", name], { stdio: "inherit" });
    process.exit(r.status ?? 0);
  }
}
