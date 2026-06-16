import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type CSSProperties,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { getSharedHighlighter, parsePatchFiles, type FileDiffMetadata, type SelectedLineRange } from "@pierre/diffs";
import { FileDiff, MultiFileDiff } from "@pierre/diffs/react";
import type { GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import {
  House,
  GitCommitHorizontal,
  GitPullRequest,
  FileDiff as FileDiffIcon,
  FileStack,
  SquareTerminal,
  Menu,
  PanelRight,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  EllipsisVertical,
  Sparkles,
  Image as ImageIcon,
  FolderClock,
  ArrowUpToLine,
  ArrowUp,
  Send,
  Square,
  RefreshCw,
  RotateCw,
  Plus,
  Minus,
  Archive,
  Bot,
  Check,
  Trash2,
  Sun,
  Moon,
  Gauge,
  Highlighter,
  BellDot,
  ExternalLink,
  FileCode,
  Share2,
  Link2,
  X,
} from "lucide-react";

type Theme = "light" | "dark";

interface Commit {
  sha: string;
  message: string;
  author: string;
  login: string | null;
  avatar: string | null;
  date: string;
  repo: string;
}

interface PR {
  number: number;
  title: string;
  login: string;
  branch: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  isDraft: boolean;
  repo: string;
}

interface ChangeEntry {
  path: string;
  status: string;
}

interface UntrackedEntry {
  path: string;
  contents: string | null;
  binary?: boolean;
  tooLarge?: boolean;
}

// Working-tree changes for one worktree (the API returns one of these per
// worktree, across every repo).
interface RepoChanges {
  repo: string;
  segment: string; // worktree segment header ("" when there's a single worktree)
  dir: string; // absolute worktree dir, echoed back to route git ops
  staged: ChangeEntry[];
  unstaged: ChangeEntry[];
  untracked: UntrackedEntry[];
  stagedDiff: string;
  unstagedDiff: string;
}

interface RepoMeta {
  key: string;
  nameWithOwner: string;
  branch: string;
}

interface Meta {
  id: number; // active directory id
  name: string; // active directory display name
  path: string; // active directory path
  repo: string;
  cwd: string; // absolute dir new claude sessions launch in; roots @-file refs
  branch: string;
  workspace: boolean;
  editor: string;
  repos: RepoMeta[];
  defaultDirId: number; // the launch cwd's directory id
}

// A registered directory the top-left dropdown switches between.
interface DirEntry {
  id: number;
  path: string;
  name: string;
  repos: string[]; // member sub-dir names ([] = auto-detect)
}

// A line range highlighted in one rendered diff, driving the action bar.
interface DiffSelection {
  fileKey: string;
  range: SelectedLineRange;
}

type Tab = "home" | "commits" | "prs" | "changes" | "manual" | "tmux";

// Order drives the 1–6 / ←→ shortcuts and the tab strip. The first entry is the
// landing tab for the default route (see initialView) — Home, the session monitor.
const TAB_ORDER: Tab[] = ["home", "tmux", "changes", "commits", "prs", "manual"];

interface ManualPatch {
  name: string;
  contents: string;
}

// A claude session running in a tmux session (Tmux tab).
interface TmuxSession {
  name: string;
  cwd: string;
  task: string; // what claude is doing (cleaned pane title), "" if not meaningful
  busy: boolean; // claude is actively working
  waiting: boolean; // idle but blocked on an interactive prompt (waiting for input)
  sessionId: string;
  hasTranscript: boolean;
  mtime: number;
}

// A prompt enqueued while the machine was offline (Tmux tab). It launches into a
// real session automatically once connectivity returns — see the offline queue in
// index.ts.
interface QueuedSession {
  id: number;
  prompt: string;
  createdAt: number;
  cwd: string;
}

// One rendered line of a session's transcript.
interface TranscriptMsg {
  role: "user" | "assistant" | "tool";
  kind: "text" | "tool_use" | "tool_result" | "image";
  text: string;
  tool?: string;
  ts?: string;
  path?: string; // file path for Edit/Write/MultiEdit/Read
  edits?: { old: string; new: string }[]; // hunks for Edit/Write/MultiEdit diff rendering
  lang?: string; // language id for a Read tool result's code block
  imgRef?: string; // "<lineIdx>:<imgOrdinal>" — locates the bytes for /api/tmux/image
  mediaType?: string; // image media type for an image message
}

interface Transcript {
  session: string;
  cwd: string;
  sessionId: string;
  path: string | null;
  messages: TranscriptMsg[];
  model: string;
  title: string;
  // Live capture of a pending interactive prompt (AskUserQuestion / plan /
  // permission) that claude hasn't written to the transcript yet — set only when
  // the session is idle and the pane is showing a selection prompt. Null otherwise.
  pendingPane?: string | null;
  // The same pending prompt parsed into renderable controls (see parsePendingPrompt
  // on the server); null when the pane couldn't be parsed and only pendingPane (the
  // raw text) is usable. Mirrors the server's PendingPrompt type.
  pendingPrompt?: PendingPrompt | null;
}

// Mirror of the server's PendingPrompt (index.ts) — kept in sync by hand since the
// client is bundled separately from the server module.
interface PendingOption {
  index: number; // 1-based, the digit you'd press in the pane
  label: string;
  desc?: string;
  checked: boolean; // [x] vs [ ] — multi-select only
  cursor: boolean; // the ❯-highlighted row
  freeText: boolean; // claude's appended "Type something" option
}
interface PendingPrompt {
  kind: "multi" | "single" | "confirm";
  question: string;
  options: PendingOption[];
  multiQuestion: boolean;
}

type View =
  | { kind: "home" }
  | { kind: "commit"; sha: string; repo?: string }
  | { kind: "pr"; number: number; repo?: string }
  | { kind: "changes" }
  | { kind: "manual"; name: string }
  | { kind: "tmux"; session: string }
  | { kind: "none" };

type GitAction = "stage" | "unstage" | "stash";

interface SectionFile {
  key: string;
  path: string; // repo-relative path used for git ops
  treePath: string; // possibly namespaced path used by the file tree
  repo?: string; // which workspace repo this file belongs to
  worktree?: string; // absolute worktree dir this file lives in
  fileDiff?: FileDiffMetadata;
  rawDiff?: string; // this file's slice of the raw unified patch, for "copy diff"
  untracked?: UntrackedEntry;
  actions: GitAction[];
}

interface Section {
  label: string | null;
  segment?: string; // worktree segment this group belongs to
  repo?: string;
  dir?: string; // absolute worktree dir
  files: SectionFile[];
}

function timeAgo(iso: string | number): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// ~/.claude/rate-limits.json, surfaced verbatim by /api/usage. Each window is
// null until Claude Code's statusline hook has written at least once. `resets_at`
// and `updated_at` are unix seconds.
interface UsageWindow {
  used_percentage: number;
  resets_at: number;
}
interface UsageData {
  five_hour: UsageWindow | null;
  seven_day: UsageWindow | null;
  updated_at: number | null;
}

// Compact countdown to a future unix-seconds timestamp: "2h 14m", "8m", "<1m",
// or "3d 4h" for the weekly window. "now" once it's elapsed (the file is stale).
function untilReset(unixSeconds: number): string {
  const secs = Math.floor(unixSeconds - Date.now() / 1000);
  if (secs <= 0) return "now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins < 1 ? "<1m" : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins ? `${hours}h ${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

// Absolute local clock for a reset — "3:00 PM" if it lands today, "Mon 3:00 PM"
// otherwise (the weekly window can be days out).
function resetClock(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const today = new Date().toDateString() === d.toDateString();
  return today ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

const STATUS_FOR_CHANGE: Record<FileDiffMetadata["type"], GitStatusEntry["status"]> = {
  new: "added",
  deleted: "deleted",
  "rename-pure": "renamed",
  "rename-changed": "renamed",
  change: "modified",
};

const ACTION_LABELS: Record<GitAction, { label: string; title: string }> = {
  stage: { label: "stage", title: "git add" },
  unstage: { label: "unstage", title: "git restore --staged" },
  stash: { label: "stash", title: "git stash push" },
};

const DIFF_OPTIONS = {
  themeType: "light",
  stickyHeader: true,
  lineHoverHighlight: "line",
  enableLineSelection: true,
} as const;

// How often the Tmux tab re-reads the session list / open transcript while a
// claude session is actively working (see the queries below).
const TMUX_POLL_MS = 2000;
// Slower baseline for the open transcript when its session is idle — keeps prompts
// that pause the session (AskUserQuestion / plan / permission) from going unseen
// until the answer, without the cost of full-speed polling. See transcriptQuery.
const TMUX_IDLE_POLL_MS = 3000;
// Cadence for the session list while prompts sit in the offline queue, so they
// flip to real sessions promptly once the network is back (no busy-polling).
const TMUX_QUEUE_POLL_MS = 5000;

// ---- Fetch helpers shared by every query ----
async function fetchJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}
async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(await res.text());
  return res.text();
}
const errMessage = (e: unknown): string =>
  e ? String((e as { message?: unknown }).message ?? e) : "";

// Split a unified git patch into one raw-text chunk per file, in document order.
// Each chunk starts at its `diff --git` header; any preamble before the first
// header is dropped. parsePatchFiles() emits one FileDiffMetadata per `diff
// --git` block in the same order, so callers zip the two by index.
function splitPatchByFile(patch: string): string[] {
  if (!patch) return [];
  const chunks: string[] = [];
  let current: string[] | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current) chunks.push(current.join("\n"));
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) chunks.push(current.join("\n"));
  return chunks;
}

// Parse a patch into its files, each paired with the raw diff text for just that
// file. rawDiff is only filled when the chunk count lines up with the parsed
// file count (always true for standard git/gh diffs); otherwise it's left empty
// and the per-file "copy diff" button hides.
function parseSectionFiles(
  patch: string,
  cacheKey?: string,
): Array<{ file: FileDiffMetadata; rawDiff: string }> {
  const files = parsePatchFiles(patch, cacheKey).flatMap((p) => p.files);
  const chunks = splitPatchByFile(patch);
  const aligned = chunks.length === files.length;
  return files.map((file, i) => ({ file, rawDiff: aligned ? chunks[i] : "" }));
}

// One file's rendered diff. Memoized so that highlighting lines (which only
// changes `selectedRange`/`viewing` for the active file) re-renders just that
// file, not every diff on the page.
interface DiffRowProps {
  file: SectionFile;
  viewing: boolean;
  collapsed: boolean;
  selectedRange: SelectedLineRange | null;
  busy: boolean;
  // "split" side-by-side on desktop; "unified" single-column on mobile/tablet
  // where there isn't room for two columns. Part of the props so the memo busts
  // when the viewport crosses the breakpoint.
  diffStyle: "split" | "unified";
  // Whether tapping lines highlights them (driving the floating action bar). On
  // mobile this is off by default — taps then scroll/select normally — and flips
  // on via the Actions menu. A prop so the memo busts when the toggle changes.
  selectable: boolean;
  // Light/dark — drives the diff library's own palette + syntax theme. A prop so
  // the memo busts (and the diff re-renders) the moment the theme is toggled.
  themeType: Theme;
  registerEl: (key: string, el: HTMLDivElement | null) => void;
  onSelect: (fileKey: string, range: SelectedLineRange | null) => void;
  onAct: (action: GitAction, path: string, repo?: string, worktree?: string) => void;
  onOpenOpaque: (path: string, repo?: string, worktree?: string) => void;
}

// Small clipboard button that flips its label to "copied" for a beat after a
// successful copy. Used for the per-file path/diff actions under each diff.
function CopyButton({ label, text, title }: { label: string; text: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="act"
      title={title}
      disabled={!text}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? "copied" : label}
    </button>
  );
}

// A compact square icon button shared by the composer toolbars (attach image, go
// to last directory, new session). Same surface as the other `.act` buttons —
// just wrapping a lucide glyph instead of a text label, sized square by `.icon-btn`.
function IconButton({
  onClick,
  title,
  disabled,
  className,
  children,
}: {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`act icon-btn${className ? ` ${className}` : ""}`}
      disabled={disabled}
      onClick={onClick}
      title={title}
      aria-label={title}
    >
      {children}
    </button>
  );
}

// Attach-image icon button: a hidden file <input> (camera / photo library on
// mobile) fronted by an IconButton. The parent owns the upload + insert via
// `onPick`; we only hold the input ref so the button can open the picker. Shows
// an ellipsis while an upload is in flight. Used by the New Claude session
// composer and the Tmux reply composer.
function ImageAttachButton({
  uploading,
  onPick,
}: {
  uploading: boolean;
  onPick: (e: ChangeEvent<HTMLInputElement>) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <input ref={inputRef} type="file" accept="image/*" hidden onChange={onPick} />
      <IconButton
        className="img-pick"
        disabled={uploading}
        title="Attach image"
        onClick={() => inputRef.current?.click()}
      >
        {uploading ? <span className="icon-spin">…</span> : <ImageIcon />}
      </IconButton>
    </>
  );
}

const DiffRow = memo(function DiffRow({
  file,
  viewing,
  collapsed,
  selectedRange,
  busy,
  diffStyle,
  selectable,
  themeType,
  registerEl,
  onSelect,
  onAct,
  onOpenOpaque,
}: DiffRowProps) {
  const acts = file.actions.map((a) => (
    <button
      key={a}
      className="act"
      title={ACTION_LABELS[a].title}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation();
        onAct(a, file.path, file.repo, file.worktree);
      }}
    >
      {ACTION_LABELS[a].label}
    </button>
  ));
  // Passing `selectedLines` puts the diff in controlled-selection mode, so the
  // highlight is driven entirely from App state — selecting in one file clears
  // the highlight in every other. `enableLineSelection` (off here on mobile by
  // default) overrides DIFF_OPTIONS' default since it's spread after it.
  const selectionOptions = {
    collapsed,
    enableLineSelection: selectable,
    onLineSelectionChange: (r: SelectedLineRange | null) => onSelect(file.key, r),
    onLineSelected: (r: SelectedLineRange | null) => onSelect(file.key, r),
  };
  return (
    <div className={`file-diff${viewing ? " viewing" : ""}`} ref={(el) => registerEl(file.key, el)}>
      {file.fileDiff && (
        <FileDiff
          fileDiff={file.fileDiff}
          selectedLines={selectedRange}
          options={{ ...DIFF_OPTIONS, themeType, diffStyle, ...selectionOptions }}
          disableWorkerPool
          renderHeaderMetadata={
            file.actions.length ? () => <span className="hdr-acts">{acts}</span> : undefined
          }
        />
      )}
      {file.untracked &&
        (file.untracked.contents !== null ? (
          <MultiFileDiff
            oldFile={{ name: file.path, contents: "" }}
            newFile={{ name: file.path, contents: file.untracked.contents }}
            selectedLines={selectedRange}
            options={{ ...DIFF_OPTIONS, themeType, diffStyle, ...selectionOptions }}
            disableWorkerPool
            renderHeaderMetadata={() => <span className="hdr-acts">{acts}</span>}
          />
        ) : (
          <div className="opaque-file">
            <span
              className="opaque-open"
              title="Open in editor"
              onClick={() => onOpenOpaque(file.path, file.repo, file.worktree)}
            >
              {file.path} — {file.untracked.binary ? "binary file" : "file too large to preview"}
            </span>
            <span className="hdr-acts">{acts}</span>
          </div>
        ))}
      <div className="diff-foot">
        <CopyButton label="copy path" title="Copy file path" text={file.path} />
        {file.rawDiff ? (
          <CopyButton label="copy diff" title="Copy this file's diff" text={file.rawDiff} />
        ) : null}
      </div>
    </div>
  );
});

// Sidebar list placeholder shown while a tab's data is still loading. Widths
// vary deterministically per row so it reads as a list, not a solid block.
function SkeletonList({ rows = 7 }: { rows?: number }) {
  return (
    <div className="skel-list" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skel-row" key={i}>
          <div className="skel-bar title" style={{ width: `${55 + ((i * 13) % 35)}%` }} />
          <div className="skel-bar meta" />
        </div>
      ))}
    </div>
  );
}

// Centered spinner for the diff/content column while it loads. No label text —
// just the spinner, sitting in the middle of the column.
function ContentSpinner({ label }: { label: string }) {
  return (
    <div className="loading-wrap">
      <div className="spinner" aria-label={label} />
    </div>
  );
}

// Placeholder for the diff column while a commit/PR/changes diff is still being
// computed server-side (git runs in the background). Mimics a few file cards with
// shimmering line bars so switching to a diff feels instant — the layout is there
// immediately and only the text streams in. Row counts/widths vary per index so it
// reads as code, not a solid block.
function SkeletonDiff({ files = 3 }: { files?: number }) {
  return (
    <div className="skel-diff" aria-busy="true" aria-label="Loading diff">
      {Array.from({ length: files }, (_, i) => (
        <div className="skel-file" key={i}>
          <div className="skel-file-head">
            <div className="skel-bar" style={{ width: `${28 + ((i * 17) % 38)}%` }} />
          </div>
          {Array.from({ length: 5 + ((i * 4) % 5) }, (_, j) => (
            <div className="skel-code-line" key={j}>
              <div className="skel-bar code" style={{ width: `${30 + ((j * 23) % 58)}%` }} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---- Lightweight markdown rendering for assistant messages ----
// Not a full CommonMark parser — just enough (code blocks, headings, lists,
// quotes, **bold**/*italic*/`code`/[links]) to make claude's markdown read like
// a chat. Inline formatting within a single line/segment.
function parseInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\n]+?)\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1] != null) nodes.push(<code key={k++} className="md-code-inline">{m[1]}</code>);
    else if (m[2] != null) nodes.push(<strong key={k++}>{m[2]}</strong>);
    else if (m[3] != null) nodes.push(<strong key={k++}>{m[3]}</strong>);
    else if (m[4] != null) nodes.push(<em key={k++}>{m[4]}</em>);
    else if (m[5] != null)
      nodes.push(
        <a key={k++} href={m[6]} target="_blank" rel="noreferrer">
          {m[5]}
        </a>,
      );
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// Syntax highlighting for fenced code blocks. Reuses the very same shiki
// highlighter the diff viewer already bundles via @pierre/diffs (a singleton
// that loads each language on demand), so chat code and diffs tokenize
// identically and we ship no extra highlighter. We mirror the diff viewer's two
// pierre themes and emit BOTH as CSS vars (shiki dual-theme output), so chat
// code recolors with the app's light/dark toggle through pure CSS — no
// re-highlight on theme change. See the `.md-code .shiki` rules in index.ts.
const CODE_THEMES = { light: "pierre-light", dark: "pierre-dark" } as const;

// Common fence labels shiki doesn't recognize under that exact name.
const LANG_ALIASES: Record<string, string> = {
  sh: "bash", shell: "bash", zsh: "bash", console: "bash",
  js: "javascript", cjs: "javascript", mjs: "javascript",
  ts: "typescript", py: "python", rb: "ruby", yml: "yaml", md: "markdown",
  "c++": "cpp", "c#": "csharp", cs: "csharp", rs: "rust", kt: "kotlin", htm: "html",
};

// Tokenize `code` to themed HTML, loading the language on demand. Falls back to a
// plain (still themed) render for unknown languages or any load failure; returns
// "" on total failure so the caller keeps its plain <pre>.
async function highlightToHtml(code: string, lang: string): Promise<string> {
  const id = LANG_ALIASES[lang] ?? lang;
  const themes = [CODE_THEMES.light, CODE_THEMES.dark];
  try {
    const hl = await getSharedHighlighter({ themes, langs: id ? [id] : [] });
    const resolved = hl.getLoadedLanguages().includes(id) ? id : "text";
    return hl.codeToHtml(code, { lang: resolved, themes: CODE_THEMES, defaultColor: false });
  } catch {
    try {
      const hl = await getSharedHighlighter({ themes, langs: [] });
      return hl.codeToHtml(code, { lang: "text", themes: CODE_THEMES, defaultColor: false });
    } catch {
      return "";
    }
  }
}

// A fenced code block with a language label + copy button (ChatGPT-style).
const CodeBlock = memo(function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  // Highlighting is async (shiki); render a plain <pre> until it resolves so
  // there's never a flash of broken layout. Re-runs as `code` streams in.
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    highlightToHtml(code, lang).then((h) => {
      if (live && h) setHtml(h);
    });
    return () => {
      live = false;
    };
  }, [code, lang]);
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span className="lang">{lang || "code"}</span>
        <button
          className="copy"
          onClick={() => {
            navigator.clipboard.writeText(code).catch(() => {});
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {html ? (
        <div className="md-code-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre>
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
});

const isUl = (l: string) => /^\s*[-*+]\s+/.test(l);
const isOl = (l: string) => /^\s*\d+[.)]\s+/.test(l);
const isHeading = (l: string) => /^#{1,6}\s+/.test(l);
const isQuote = (l: string) => /^>\s?/.test(l);
// A GFM table row contains at least one unescaped pipe.
const isTableRow = (l: string) => /\|/.test(l) && l.trim() !== "";
// The separator under the header: cells of dashes with optional `:` alignment.
const isTableSep = (l: string) => /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(l);

// Split a table row into trimmed cells, tolerating optional leading/trailing
// pipes and `\|` escapes inside a cell.
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let j = 0; j < s.length; j++) {
    if (s[j] === "\\" && s[j + 1] === "|") {
      cur += "|";
      j++;
    } else if (s[j] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += s[j];
    }
  }
  cells.push(cur.trim());
  return cells;
}

type Align = "left" | "center" | "right" | null;
function parseAlign(sep: string): Align[] {
  return splitRow(sep).map((c) => {
    const l = c.startsWith(":");
    const r = c.endsWith(":");
    if (l && r) return "center";
    if (r) return "right";
    if (l) return "left";
    return null;
  });
}

function renderBlocks(src: string): ReactNode[] {
  const lines = src.split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++; // skip closing fence
      out.push(<CodeBlock key={key++} lang={fence[1].trim()} code={body.join("\n")} />);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      out.push(
        <div key={key++} className={`md-h h${level}`}>
          {parseInline(h[2])}
        </div>,
      );
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(<hr key={key++} className="md-hr" />);
      i++;
      continue;
    }
    if (isQuote(line)) {
      const body: string[] = [];
      while (i < lines.length && isQuote(lines[i])) body.push(lines[i++].replace(/^>\s?/, ""));
      out.push(
        <blockquote key={key++} className="md-quote">
          {renderBlocks(body.join("\n"))}
        </blockquote>,
      );
      continue;
    }
    if (isUl(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && isUl(lines[i]))
        items.push(<li key={items.length}>{parseInline(lines[i++].replace(/^\s*[-*+]\s+/, ""))}</li>);
      out.push(
        <ul key={key++} className="md-ul">
          {items}
        </ul>,
      );
      continue;
    }
    if (isOl(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && isOl(lines[i]))
        items.push(<li key={items.length}>{parseInline(lines[i++].replace(/^\s*\d+[.)]\s+/, ""))}</li>);
      out.push(
        <ol key={key++} className="md-ol">
          {items}
        </ol>,
      );
      continue;
    }
    // GFM table: a header row immediately followed by a separator row.
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const headers = splitRow(line);
      const aligns = parseAlign(lines[i + 1]);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i]) && !isTableSep(lines[i])) {
        rows.push(splitRow(lines[i++]));
      }
      const colAlign = (c: number): Align => aligns[c] ?? null;
      out.push(
        <div key={key++} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {headers.map((c, ci) => (
                  <th key={ci} style={colAlign(ci) ? { textAlign: colAlign(ci)! } : undefined}>
                    {parseInline(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {headers.map((_, ci) => (
                    <td key={ci} style={colAlign(ci) ? { textAlign: colAlign(ci)! } : undefined}>
                      {parseInline(r[ci] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    // Paragraph: gather consecutive plain lines, soft-wrapped with <br/>.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i]) &&
      !isHeading(lines[i]) &&
      !isQuote(lines[i]) &&
      !isUl(lines[i]) &&
      !isOl(lines[i]) &&
      !(isTableRow(lines[i]) && i + 1 < lines.length && isTableSep(lines[i + 1]))
    )
      para.push(lines[i++]);
    const inlined: ReactNode[] = [];
    para.forEach((p, idx) => {
      if (idx > 0) inlined.push(<br key={`b${idx}`} />);
      inlined.push(...parseInline(p));
    });
    out.push(<p key={key++}>{inlined}</p>);
  }
  return out;
}

const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => renderBlocks(text), [text]);
  return <div className="md">{blocks}</div>;
});

const PLAN_CHOICES = [
  { n: 1, label: "Yes, and auto-accept edits" },
  { n: 2, label: "Yes, and manually approve edits" },
  { n: 3, label: "No, keep planning" },
] as const;

const PlanCard = memo(function PlanCard({
  plan,
  onAnswer,
}: {
  plan: string;
  onAnswer?: (choice: number) => Promise<void> | void;
}) {
  const [sending, setSending] = useState<number | null>(null);
  const answer = async (n: number) => {
    if (!onAnswer || sending !== null) return;
    setSending(n);
    try {
      await onAnswer(n);
    } finally {
      setSending(null);
    }
  };
  return (
    <div className="plan-card">
      <div className="plan-card-head">Plan</div>
      <div className="plan-card-body">
        <Markdown text={plan} />
      </div>
      <div className="plan-card-foot">
        <div className="plan-q">Would you like to proceed?</div>
        {PLAN_CHOICES.map((c) => (
          <button
            key={c.n}
            className="plan-choice"
            disabled={!onAnswer || sending !== null}
            onClick={() => answer(c.n)}
          >
            <span className="plan-choice-n">{c.n}</span>
            <span className="plan-choice-label">{c.label}</span>
            {sending === c.n ? <span className="plan-choice-spin">sending…</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
});

interface AskQuestion {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: { label: string; description?: string }[];
}

// Parse AskUserQuestion's JSON input into renderable questions. Wrapped so a
// malformed/blank payload degrades to null and the caller falls back to a plain
// tool line instead of throwing or showing an empty card.
function parseQuestions(text: string): AskQuestion[] | null {
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const qs = data?.questions;
  if (!Array.isArray(qs)) return null;
  const parsed = qs
    .filter((q: any) => q && typeof q.question === "string" && Array.isArray(q.options))
    .map((q: any) => ({
      question: q.question as string,
      header: typeof q.header === "string" ? q.header : undefined,
      multiSelect: !!q.multiSelect,
      options: (q.options as any[])
        .filter((o) => o && typeof o.label === "string")
        .map((o) => ({
          label: o.label as string,
          description: typeof o.description === "string" ? o.description : undefined,
        })),
    }))
    .filter((q) => q.options.length > 0);
  return parsed.length ? parsed : null;
}

// AskUserQuestion card — mirrors the in-TUI multiple-choice prompt. Like the plan
// card, only the live (last-turn) prompt is answerable: clicking an option sends
// its 1-based number into the pane (the key you'd press in the TUI), advancing to
// the next question. Multi-select questions render read-only — a single keypress
// can't express them — with a hint to answer from the reply box.
const QuestionCard = memo(function QuestionCard({
  text,
  onAnswer,
}: {
  text: string;
  // (questionIndex, optionIndex) — questionIndex lets a future caller map clicks
  // back to a specific question; today the pane just receives the option number.
  onAnswer?: (questionIndex: number, optionIndex: number) => Promise<void> | void;
}) {
  const questions = useMemo(() => parseQuestions(text), [text]);
  // The option mid-send, keyed `${qi}:${oi}`, so only the clicked button spins.
  const [sending, setSending] = useState<string | null>(null);
  if (!questions) {
    // Unparseable payload — fall back to a plain tool line, not an empty card.
    return (
      <div className="tool-use">
        <span className="tool-name">AskUserQuestion</span>
      </div>
    );
  }
  const answer = async (qi: number, oi: number) => {
    if (!onAnswer || sending !== null) return;
    setSending(`${qi}:${oi}`);
    try {
      await onAnswer(qi, oi);
    } finally {
      setSending(null);
    }
  };
  return (
    <div className="q-card">
      <div className="q-card-head">{questions.length > 1 ? `${questions.length} questions` : "Question"}</div>
      {questions.map((q, qi) => {
        const clickable = !!onAnswer && !q.multiSelect;
        return (
          <div key={qi} className="q-block">
            {q.header ? <div className="q-tag">{q.header}</div> : null}
            <div className="q-text">{q.question}</div>
            <div className="q-opts">
              {q.options.map((o, oi) => (
                <button
                  key={oi}
                  className={`q-choice${clickable ? "" : " readonly"}`}
                  disabled={!clickable || sending !== null}
                  onClick={clickable ? () => answer(qi, oi) : undefined}
                  title={clickable ? "Send this answer" : undefined}
                >
                  <span className="q-choice-n">{oi + 1}</span>
                  <span className="q-choice-body">
                    <span className="q-choice-label">{o.label}</span>
                    {o.description ? <span className="q-choice-desc">{o.description}</span> : null}
                  </span>
                  {sending === `${qi}:${oi}` ? <span className="q-choice-spin">sending…</span> : null}
                </button>
              ))}
            </div>
            {q.multiSelect && onAnswer ? (
              <div className="q-multi">Multi-select — type your picks in the reply box below.</div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
});

// A pending interactive prompt (AskUserQuestion / plan approval / permission) that
// claude is blocked on but hasn't written to the transcript .jsonl yet. The server
// parses the live pane into renderable controls (prompt), so instead of making you
// read ASCII and hand-type a digit we show real buttons / checkboxes:
//   • single-select → numbered buttons (click sends the digit, like pressing it)
//   • multi-select  → checkboxes + Submit (server toggles + verifies + Enters)
//   • confirm       → a single "Confirm & submit" for claude's final-submit gate
// The raw pane stays one click away ("show raw pane") and is the fallback when the
// pane can't be parsed (prompt == null) — the original type-in-the-reply-box flow.
const PendingPrompt = memo(function PendingPrompt({
  text,
  prompt,
  onAnswerSingle,
  onAnswerMulti,
  onConfirm,
}: {
  text: string;
  prompt?: PendingPrompt | null;
  onAnswerSingle?: (digit: number) => Promise<void> | void;
  onAnswerMulti?: (selected: number[]) => Promise<void> | void;
  onConfirm?: () => Promise<void> | void;
}) {
  // Multi-select working set, seeded once from the pane's current [x] state. The
  // call site keys this component by question, so it remounts (re-seeds) per
  // question and preserves in-progress toggles across background polls.
  const [checked, setChecked] = useState<Set<number>>(
    () =>
      new Set(
        (prompt?.kind === "multi" ? prompt.options : [])
          .filter((o) => o.checked && !o.freeText)
          .map((o) => o.index),
      ),
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const head = (
    <div className="pending-pane-head">
      <span className="pending-pane-dot" />
      Waiting for your input
    </div>
  );

  // Unparseable pane → original raw-pane + reply-box behavior.
  if (!prompt) {
    return (
      <div className="pending-pane">
        {head}
        <pre className="pending-pane-body">{text}</pre>
        <div className="pending-pane-hint">
          Live from the pane — answer in the reply box below (e.g. type <code>1</code>).
        </div>
      </div>
    );
  }

  const real = prompt.options.filter((o) => !o.freeText);
  const hasFreeText = prompt.options.some((o) => o.freeText);
  const rawDetails = (
    <details className="pending-raw">
      <summary>show raw pane</summary>
      <pre className="pending-pane-body">{text}</pre>
    </details>
  );
  const freeHint = hasFreeText ? (
    <div className="pending-pane-hint">…or type your own answer in the reply box below.</div>
  ) : null;

  if (prompt.kind === "confirm") {
    const confirm = async () => {
      if (!onConfirm || busy) return;
      setBusy(true);
      try {
        await onConfirm();
      } finally {
        setBusy(false);
      }
    };
    return (
      <div className="pending-pane">
        {head}
        <div className="pending-body">
          <div className="q-text">{prompt.question || "Ready to submit your answers?"}</div>
          <button className="pending-submit" disabled={!onConfirm || busy} onClick={confirm}>
            {busy ? "submitting…" : "Confirm & submit"}
          </button>
        </div>
        {rawDetails}
      </div>
    );
  }

  if (prompt.kind === "single") {
    const pick = async (i: number) => {
      if (!onAnswerSingle || busy) return;
      setBusy(true);
      try {
        await onAnswerSingle(i);
      } finally {
        setBusy(false);
      }
    };
    return (
      <div className="pending-pane">
        {head}
        <div className="pending-body">
          {prompt.question ? <div className="q-text">{prompt.question}</div> : null}
          <div className="q-opts">
            {real.map((o) => (
              <button
                key={o.index}
                className="q-choice"
                disabled={!onAnswerSingle || busy}
                onClick={() => pick(o.index)}
                title="Send this answer"
              >
                <span className="q-choice-n">{o.index}</span>
                <span className="q-choice-body">
                  <span className="q-choice-label">{o.label}</span>
                  {o.desc ? <span className="q-choice-desc">{o.desc}</span> : null}
                </span>
              </button>
            ))}
          </div>
          {freeHint}
        </div>
        {rawDetails}
      </div>
    );
  }

  // multi-select
  const toggle = (i: number) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const submit = async () => {
    if (!onAnswerMulti || busy) return;
    setErr(null);
    setBusy(true);
    try {
      await onAnswerMulti([...checked]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pending-pane">
      {head}
      <div className="pending-body">
        {prompt.question ? <div className="q-text">{prompt.question}</div> : null}
        <div className="q-checks">
          {real.map((o) => {
            const on = checked.has(o.index);
            return (
              <button
                key={o.index}
                type="button"
                className={`q-check${on ? " on" : ""}`}
                role="checkbox"
                aria-checked={on}
                disabled={busy}
                onClick={() => toggle(o.index)}
              >
                <span className="q-check-box">{on ? "✓" : ""}</span>
                <span className="q-choice-body">
                  <span className="q-choice-label">{o.label}</span>
                  {o.desc ? <span className="q-choice-desc">{o.desc}</span> : null}
                </span>
              </button>
            );
          })}
        </div>
        {freeHint}
        {err ? <div className="pending-err">Couldn’t auto-fill ({err}) — use the reply box below.</div> : null}
        <button className="pending-submit" disabled={!onAnswerMulti || busy} onClick={submit}>
          {busy ? "submitting…" : `Submit${checked.size ? ` ${checked.size}` : ""}`}
        </button>
      </div>
      {rawDetails}
    </div>
  );
});

// An Edit/Write/MultiEdit tool call rendered as inline diff hunks via the same
// diffs library the Changes tab uses. old_string/new_string are snippets (not
// whole files), so each shows as a standalone unified hunk with synthetic line
// numbers — compact and readable inline in the chat.
const EditDiff = memo(function EditDiff({
  tool,
  path,
  edits,
  theme,
}: {
  tool: string;
  path: string;
  edits: { old: string; new: string }[];
  theme: Theme;
}) {
  const name = path ? path.split("/").pop() || path : tool;
  const options = {
    ...DIFF_OPTIONS,
    themeType: theme,
    diffStyle: "unified" as const,
    enableLineSelection: false,
  };
  return (
    <div className="chat-diff">
      <div className="tool-use">
        <span className="tool-name">{tool}</span>
        {path ? <span className="tool-arg">{path}</span> : null}
      </div>
      {edits.map((e, j) => (
        <MultiFileDiff
          key={j}
          oldFile={{ name, contents: e.old }}
          newFile={{ name, contents: e.new }}
          options={options}
          disableWorkerPool
        />
      ))}
    </div>
  );
});

// A Read tool result as a collapsed, syntax-highlighted code block. Reuses the
// chat CodeBlock so it inherits the shared highlighter; collapsed by default so
// a long file doesn't flood the transcript.
const ReadBlock = memo(function ReadBlock({
  path,
  lang,
  code,
}: {
  path: string;
  lang: string;
  code: string;
}) {
  const [open, setOpen] = useState(false);
  const name = path ? path.split("/").pop() || path : "file";
  const lines = code ? code.split("\n").length : 0;
  return (
    <div className="read-block">
      <button className="read-block-head" onClick={() => setOpen((o) => !o)}>
        <span className="tool-name">Read</span>
        <span className="tool-arg">{name}</span>
        <span className="read-block-meta">
          {lines} {lines === 1 ? "line" : "lines"} · {open ? "hide" : "show"}
        </span>
      </button>
      {open ? <CodeBlock lang={lang} code={code} /> : null}
    </div>
  );
});

// An image claude read (Read on a png), a screenshot tool's output, or a pasted
// image — fetched lazily from /api/tmux/image (kept out of the polled transcript
// payload, then cached hard). Click to open full size in a new tab.
const ImageBlock = memo(function ImageBlock({
  session,
  imgRef,
  tool,
  path,
}: {
  session: string;
  imgRef: string;
  tool?: string;
  path?: string;
}) {
  const src = `/api/tmux/image?session=${encodeURIComponent(session)}&ref=${encodeURIComponent(imgRef)}`;
  const name = path ? path.split("/").pop() || path : "";
  return (
    <div className="img-block">
      {(tool || name) && (
        <div className="img-block-head">
          {tool ? <span className="tool-name">{tool}</span> : null}
          {name ? <span className="tool-arg">{name}</span> : null}
        </div>
      )}
      <a href={src} target="_blank" rel="noreferrer">
        <img className="img-block-img" src={src} loading="lazy" alt={name || "image"} />
      </a>
    </div>
  );
});

// One conversation turn: a user turn is a right-aligned bubble; an assistant turn
// is a left avatar + content stack (markdown text, tool calls, tool results).
const TranscriptTurn = memo(function TranscriptTurn({
  role,
  msgs,
  session,
  theme,
  onAnswerPlan,
  onAnswerQuestion,
}: {
  role: "user" | "assistant";
  msgs: TranscriptMsg[];
  session: string;
  theme: Theme;
  onAnswerPlan?: (choice: number) => Promise<void> | void;
  onAnswerQuestion?: (questionIndex: number, optionIndex: number) => Promise<void> | void;
}) {
  if (role === "user") {
    return (
      <div className="turn user">
        {msgs.map((m, i) =>
          m.kind === "image" ? (
            <ImageBlock key={i} session={session} imgRef={m.imgRef || ""} tool={m.tool} path={m.path} />
          ) : (
            <div key={i} className="bubble">
              {m.text}
            </div>
          ),
        )}
      </div>
    );
  }
  return (
    <div className="turn assistant">
      <div className="content">
        {msgs.map((m, i) => {
          if (m.kind === "tool_use" && m.tool === "ExitPlanMode")
            return <PlanCard key={i} plan={m.text} onAnswer={onAnswerPlan} />;
          if (m.kind === "tool_use" && m.tool === "AskUserQuestion")
            return <QuestionCard key={i} text={m.text} onAnswer={onAnswerQuestion} />;
          if (m.kind === "tool_use" && m.edits && m.edits.length)
            return (
              <EditDiff
                key={i}
                tool={m.tool || "Edit"}
                path={m.path || ""}
                edits={m.edits}
                theme={theme}
              />
            );
          if (m.kind === "tool_use")
            return (
              <div key={i} className="tool-use">
                <span className="tool-name">{m.tool}</span>
                {m.text ? <span className="tool-arg">{m.text}</span> : null}
              </div>
            );
          if (m.kind === "image")
            return <ImageBlock key={i} session={session} imgRef={m.imgRef || ""} tool={m.tool} path={m.path} />;
          if (m.kind === "tool_result" && m.tool === "Read")
            return <ReadBlock key={i} path={m.path || ""} lang={m.lang || "text"} code={m.text} />;
          if (m.kind === "tool_result")
            return (
              <div key={i} className="tool-result">
                <pre>{m.text}</pre>
              </div>
            );
          return <Markdown key={i} text={m.text} />;
        })}
      </div>
    </div>
  );
});

// An Edit/Write/MultiEdit tool call — carries diff hunks we render inline.
function isEditMsg(m: TranscriptMsg): boolean {
  return m.kind === "tool_use" && !!m.edits && m.edits.length > 0;
}

interface Turn {
  role: "user" | "assistant";
  msgs: TranscriptMsg[];
}
// Flatten a transcript into one searchable, lowercased blob for the ephemeral
// "Search html…" index. Pulls every bit of text a message carries — message
// bodies, edited file paths, and the old/new sides of each edit hunk — so a
// content search hits both prose and code the session touched.
function transcriptText(t: Transcript): string {
  const parts: string[] = [];
  if (t.title) parts.push(t.title);
  for (const m of t.messages) {
    if (m.text) parts.push(m.text);
    if (m.path) parts.push(m.path);
    if (m.edits) for (const e of m.edits) parts.push(e.old, e.new);
  }
  return parts.join("\n").toLowerCase();
}

// Group the flat message list into chat turns: a `user` text message starts a
// user turn; everything else (assistant text, tool_use, tool_result) collects
// into the surrounding assistant turn.
function groupTurns(messages: TranscriptMsg[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    const role: Turn["role"] = m.role === "user" ? "user" : "assistant";
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.msgs.push(m);
    else turns.push({ role, msgs: [m] });
  }
  return turns;
}

function initialView(): { tab: Tab; view: View; dir: number | null; homeChat?: string | null } {
  const params = new URLSearchParams(location.search);
  const dirRaw = params.get("dir");
  const dir = dirRaw && /^\d+$/.test(dirRaw) ? parseInt(dirRaw, 10) : null;
  const repo = params.get("repo") ?? undefined;
  const pr = params.get("pr");
  if (pr) return { tab: "prs", view: { kind: "pr", number: parseInt(pr, 10), repo }, dir };
  if (params.get("view") === "changes") return { tab: "changes", view: { kind: "changes" }, dir };
  const tmuxSession = params.get("tmux");
  if (tmuxSession !== null)
    return { tab: "tmux", view: { kind: "tmux", session: tmuxSession }, dir };
  const manual = params.get("manual");
  if (manual) return { tab: "manual", view: { kind: "manual", name: manual }, dir };
  const sha = params.get("sha");
  if (sha) return { tab: "commits", view: { kind: "commit", sha, repo }, dir };
  // Home deep-link (?home=<session>): land on the Home tab with that session's chat
  // panel open. Drives the push-notification tap target (see /api/notify) and is
  // kept in sync as you open/close cards (see the URL-sync effect).
  const home = params.get("home");
  if (home) return { tab: "home", view: { kind: "home" }, dir, homeChat: home };
  // Default route lands on the first tab (Home — the session monitor); see TAB_ORDER.
  return { tab: "home", view: { kind: "home" }, dir };
}

// ---- Draft persistence (localStorage) ----
// The New Claude session prompt and each Tmux tab's half-typed reply survive
// reloads and closing/reopening the dialog. The Claude prompt is keyed by the
// active directory id so a temp prompt typed in one dir never bleeds into
// another; reply drafts are keyed by session name (globally unique) so every
// tab keeps its own draft, and killing a session drops its key.
const claudeDraftKey = (dirId: number) => `claudeDraft:${dirId}`;
const claudeCaretKey = (dirId: number) => `claudeCaret:${dirId}`;
const replyDraftKey = (session: string) => `replyDraft:${session}`;
function loadDraft(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
function saveDraft(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key); // empty draft → no stale key left behind
  } catch {
    // ignore storage failures (private mode, quota, etc.)
  }
}
// ---- Reply history (localStorage) ----
// Each session keeps a shell-style history of the replies you've sent it, so
// ArrowUp on an empty composer walks back through them (see recallReplyHistory).
// Stored oldest→newest and capped; persisted per session like the reply draft.
const replyHistoryKey = (session: string) => `replyHistory:${session}`;
const REPLY_HISTORY_MAX = 50;
function loadHistory(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function pushHistory(key: string, value: string) {
  const text = value.trim();
  if (!text) return;
  try {
    // Drop any earlier copy so a repeated reply jumps to the front instead of
    // leaving you to scroll past duplicates (HIST_IGNORE_ALL_DUPS-style).
    const hist = loadHistory(key).filter((h) => h !== text);
    hist.push(text);
    while (hist.length > REPLY_HISTORY_MAX) hist.shift();
    localStorage.setItem(key, JSON.stringify(hist));
  } catch {
    // ignore storage failures (private mode, quota, etc.)
  }
}
// The composer caret rides along with its per-directory draft: where the cursor
// sat when you last closed the dialog (or switched directories) survives reloads
// and dir hops, so reopening with `'` — or jumping back to a directory — lands
// you exactly where you left off instead of at the start/end of the text.
function loadCaret(key: string): { start: number; end: number } | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const [s, e] = raw.split(",").map(Number);
    if (Number.isFinite(s) && Number.isFinite(e)) return { start: s, end: e };
  } catch {
    // ignore storage failures (private mode, quota, etc.)
  }
  return null;
}
function saveCaret(key: string, caret: { start: number; end: number } | null) {
  try {
    if (caret) localStorage.setItem(key, `${caret.start},${caret.end}`);
    else localStorage.removeItem(key);
  } catch {
    // ignore storage failures (private mode, quota, etc.)
  }
}

// ---- Numeric prefs (localStorage) ----
// Small helpers for the resizable-sidebar widths; fall back to the default when
// the key is missing or corrupt.
function loadNum(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}
function saveNum(key: string, value: number) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // ignore storage failures (private mode, quota, etc.)
  }
}
// Resizable-sidebar bounds (px). Desktop only; mobile drawers use a fixed width.
const LEFT_MIN = 240;
const LEFT_MAX = 460;
const RIGHT_MIN = 240;
const RIGHT_MAX = 560;

// Grow a textarea to fit its content (capped + scrolled by its CSS max-height)
// so a long message never hides behind a fixed-height box. Shared by the New
// Claude session and Commit & push composers.
function autosize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

// ---- Last-tab memory (sessionStorage) ----
// Switching directories restores the tab you were last on instead of forcing
// one, so browsing across dirs keeps you in the same tab. Defaults to the Tmux
// tab the first time. Session-scoped so it resets when the tab/window closes.
const LAST_TAB_KEY = "lastTab";
function loadLastTab(): Tab {
  try {
    const t = sessionStorage.getItem(LAST_TAB_KEY);
    if (t && (TAB_ORDER as string[]).includes(t)) return t as Tab;
  } catch {
    // ignore storage failures (private mode, quota, etc.)
  }
  return "tmux";
}
function saveLastTab(t: Tab) {
  try {
    sessionStorage.setItem(LAST_TAB_KEY, t);
  } catch {
    // ignore storage failures (private mode, quota, etc.)
  }
}

// The view + URL param a tab lands on by default (used when a directory switch
// restores a remembered tab). Commits/PRs have no default sub-view — they show
// their list and wait for a selection — so they reset to an empty pane.
function tabDefaults(t: Tab): { view: View; param: string } {
  switch (t) {
    case "home":
      return { view: { kind: "home" }, param: "" };
    case "changes":
      return { view: { kind: "changes" }, param: "view=changes" };
    case "manual":
      return { view: { kind: "manual", name: "" }, param: "manual=" };
    case "tmux":
      return { view: { kind: "tmux", session: "" }, param: "tmux=" };
    default:
      return { view: { kind: "none" }, param: "" };
  }
}

// VAPID public key (base64url) → the Uint8Array the Push API wants.
function urlB64ToUint8Array(base64: string): Uint8Array {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

// Per-device push opt-in, shown in the Directories dialog. Subscribes this
// browser to Web Push and registers the subscription with the server, which then
// sends notifications (e.g. when a Claude session finishes via the Stop hook).
// Requires a secure context — only works over the https tailscale URL.
function PushToggle() {
  const supported =
    typeof navigator !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;
  const secure = typeof window !== "undefined" && window.isSecureContext;
  const [sub, setSub] = useState<PushSubscription | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (!supported || !secure) {
      setReady(true);
      return;
    }
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((s) => setSub(s))
      .catch(() => {})
      .finally(() => setReady(true));
  }, [supported, secure]);

  const enable = useCallback(async () => {
    setBusy(true);
    setMsg("");
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setMsg("Notification permission denied.");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = await fetch("/api/push/vapid").then((r) => r.json());
      const s = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(publicKey),
      });
      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(s),
      });
      setSub(s);
      setMsg("Enabled on this device.");
    } catch (e) {
      console.error(e);
      setMsg("Couldn't enable — see the console.");
    } finally {
      setBusy(false);
    }
  }, []);

  const disable = useCallback(async () => {
    setBusy(true);
    setMsg("");
    try {
      if (sub) {
        await fetch("/api/push/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setSub(null);
      setMsg("Disabled on this device.");
    } finally {
      setBusy(false);
    }
  }, [sub]);

  const test = useCallback(async () => {
    setBusy(true);
    setMsg("");
    try {
      const r = await fetch("/api/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "diffshub", body: "Test notification", tag: "test" }),
      }).then((x) => x.json());
      setMsg(`Sent to ${r.sent} device${r.sent === 1 ? "" : "s"}.`);
    } catch {
      setMsg("Send failed.");
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div className="push-box">
      <div className="push-head">
        <span className="push-title">Phone notifications</span>
        {sub && <span className="push-on">on</span>}
      </div>
      {!supported ? (
        <div className="push-hint">Not supported in this browser.</div>
      ) : !secure ? (
        <div className="push-hint">
          Needs HTTPS — open diffshub via its <code>tailscale serve</code>{" "}
          <code>https://…ts.net</code> URL to enable.
        </div>
      ) : !ready ? (
        <div className="push-hint">Checking…</div>
      ) : (
        <>
          <div className="push-actions">
            {sub ? (
              <>
                <button className="act" disabled={busy} onClick={disable}>
                  Disable
                </button>
                <button className="act" disabled={busy} onClick={test}>
                  Send test
                </button>
              </>
            ) : (
              <button className="act primary" disabled={busy} onClick={enable}>
                Enable on this device
              </button>
            )}
          </div>
          {msg && <div className="push-msg">{msg}</div>}
        </>
      )}
    </div>
  );
}

// One session tile on the Home dashboard. The `state` class drives the status
// dot's colour/pulse (see the .home-card CSS); clicking opens the transcript.
// `onMarkRead` is passed only for the attention states (Done / Needs-action); the
// mark-read check then shows whenever the card is `unseen`, and once acknowledged
// the `read` class calms its dot so it stops clamouring for attention.
function HomeCard({
  session,
  state,
  selected,
  unseen,
  onOpen,
  onDelete,
  onMarkRead,
}: {
  session: TmuxSession;
  state: string;
  selected?: boolean;
  unseen?: boolean;
  onOpen: (name: string) => void;
  onDelete: (name: string) => void;
  onMarkRead?: (name: string) => void;
}) {
  const attention = !!onMarkRead;
  // A <div> (not a <button>) so the nested kill button stays valid HTML —
  // matches the Tmux list rows, which are also clickable divs.
  return (
    <div
      id={`row-tmux-${session.name}`}
      className={`home-card ${state}${selected ? " selected" : ""}${
        attention && !unseen ? " read" : ""
      }`}
      onClick={() => onOpen(session.name)}
    >
      <div className="home-card-top">
        <span className="home-dot" />
        <span className="home-card-name">{session.name}</span>
      </div>
      {session.task && <div className="home-card-task">{session.task}</div>}
      <div className="home-card-foot">
        <span className="home-card-cwd">{session.cwd.replace(/^.*\//, "") || session.cwd}</span>
        {session.mtime > 0 && (
          <span className="home-card-time" title="Last message">
            {timeAgo(session.mtime)}
          </span>
        )}
      </div>
      {attention && unseen && (
        <button
          className="read-btn"
          title={`Mark ${session.name} read`}
          onClick={(e) => {
            e.stopPropagation();
            onMarkRead!(session.name);
          }}
        >
          ✓
        </button>
      )}
      <button
        className="kill-btn"
        title={`Kill ${session.name}`}
        onClick={(e) => {
          e.stopPropagation();
          onDelete(session.name);
        }}
      >
        ✕
      </button>
    </div>
  );
}

// The Home tab: the active directory's claude tmux chats grouped by state. "In
// progress" and "Needs action" always show (even empty — they're the states you
// watch for); the rest appear only when populated. Pure presentation over the
// already-fetched, dir-scoped + filtered session lists.
function HomeView({
  groups,
  queued,
  loading,
  error,
  selectedName,
  isUnseen,
  onOpen,
  onDelete,
  onMarkRead,
  onCancelQueued,
}: {
  groups: {
    inProgress: TmuxSession[];
    needsAction: TmuxSession[];
    done: TmuxSession[];
    idle: TmuxSession[];
  };
  queued: QueuedSession[];
  loading: boolean;
  error: string | null;
  selectedName: string | null;
  isUnseen: (s: TmuxSession) => boolean;
  onOpen: (name: string) => void;
  onDelete: (name: string) => void;
  onMarkRead: (name: string) => void;
  onCancelQueued: (id: number) => void;
}) {
  if (loading) return <ContentSpinner label="Loading sessions…" />;
  if (error) return <div className="empty error">{error}</div>;
  const { inProgress, needsAction, done, idle } = groups;
  const total =
    inProgress.length + needsAction.length + done.length + idle.length + queued.length;
  return (
    <div className="home">
      <section className="home-group">
        <div className="home-group-head in-progress">
          <span className="home-group-title">In progress</span>
          <span className="home-group-count">{inProgress.length}</span>
        </div>
        {inProgress.length ? (
          <div className="home-cards">
            {inProgress.map((s) => (
              <HomeCard
                key={s.name}
                session={s}
                state="busy"
                selected={selectedName === s.name}
                onOpen={onOpen}
                onDelete={onDelete}
              />
            ))}
          </div>
        ) : (
          <div className="home-empty">Nothing running right now.</div>
        )}
      </section>

      <section className="home-group">
        <div className="home-group-head needs-action">
          <span className="home-group-title">Needs action</span>
          <span className="home-group-count">{needsAction.length}</span>
        </div>
        {needsAction.length ? (
          <div className="home-cards">
            {needsAction.map((s) => (
              <HomeCard
                key={s.name}
                session={s}
                state="waiting"
                selected={selectedName === s.name}
                unseen={isUnseen(s)}
                onOpen={onOpen}
                onDelete={onDelete}
                onMarkRead={onMarkRead}
              />
            ))}
          </div>
        ) : (
          <div className="home-empty">All clear — nothing waiting on you.</div>
        )}
      </section>

      {queued.length > 0 && (
        <section className="home-group">
          <div className="home-group-head needs-action">
            <span className="home-group-title">Queued</span>
            <span className="home-group-count">{queued.length}</span>
          </div>
          <div className="home-cards">
            {queued.map((q) => (
              <div key={q.id} className="home-card queued">
                <div className="home-card-top">
                  <span className="home-dot" />
                  <span className="home-card-name">Queued prompt</span>
                </div>
                <div className="home-card-task">{q.prompt}</div>
                <div className="home-card-cwd">{q.cwd.replace(/^.*\//, "") || q.cwd}</div>
                <button
                  className="kill-btn"
                  title="Cancel queued prompt"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCancelQueued(q.id);
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {done.length > 0 && (
        <section className="home-group">
          <div className="home-group-head done">
            <span className="home-group-title">Done</span>
            <span className="home-group-count">{done.length}</span>
          </div>
          <div className="home-cards">
            {done.map((s) => (
              <HomeCard
                key={s.name}
                session={s}
                state="unread"
                selected={selectedName === s.name}
                unseen
                onOpen={onOpen}
                onDelete={onDelete}
                onMarkRead={onMarkRead}
              />
            ))}
          </div>
        </section>
      )}

      {idle.length > 0 && (
        <section className="home-group">
          <div className="home-group-head idle">
            <span className="home-group-title">Idle</span>
            <span className="home-group-count">{idle.length}</span>
          </div>
          <div className="home-cards">
            {idle.map((s) => (
              <HomeCard
                key={s.name}
                session={s}
                state="idle"
                selected={selectedName === s.name}
                onOpen={onOpen}
                onDelete={onDelete}
              />
            ))}
          </div>
        </section>
      )}

      {total === 0 && (
        <div className="home-empty-all">No claude sessions in this directory.</div>
      )}
    </div>
  );
}

// Geometric arrow-key navigation across the Home dashboard's card grid. Each state
// subsection is its own CSS grid whose column count flexes with the viewport (~3 on
// desktop, 1 on mobile — see the .home-cards `auto-fill` rule), so instead of
// hard-coding a width we read the cards' real on-screen rects: left/right step to
// the nearest neighbour within the same row, up/down jump to the nearest row in
// that direction (which naturally crosses subsection boundaries and keeps you in
// the column you were in). `cur` is the focused card's name (null seeds the first
// card); returns the name to focus next, or null to stay put at a grid edge.
function homeGridTarget(cur: string | null, key: string): string | null {
  const PREFIX = "row-tmux-";
  // Only the openable session cards carry this id — queued-prompt tiles don't, so
  // they're excluded from the walk just like they are from homeNav.
  const els = Array.from(
    document.querySelectorAll<HTMLElement>(`.home .home-card[id^="${PREFIX}"]`),
  );
  if (!els.length) return null;
  const cards = els.map((el) => {
    const r = el.getBoundingClientRect();
    return { name: el.id.slice(PREFIX.length), cx: r.left + r.width / 2, top: r.top, left: r.left };
  });
  const curCard = cur ? cards.find((c) => c.name === cur) : null;
  if (!curCard) return cards[0].name;
  // Bucket tops into grid rows: cards on the same row line up to the same top,
  // while separate rows (and separate subsections) sit at least a row-height-plus-
  // gap apart — far more than this 8px slop — so rounding cleanly separates rows.
  const rowOf = (top: number) => Math.round(top / 8);
  const curRow = rowOf(curCard.top);
  if (key === "ArrowLeft" || key === "ArrowRight") {
    const right = key === "ArrowRight";
    const side = cards.filter(
      (c) =>
        rowOf(c.top) === curRow && (right ? c.left > curCard.left : c.left < curCard.left),
    );
    if (!side.length) return null;
    side.sort((a, b) => Math.abs(a.left - curCard.left) - Math.abs(b.left - curCard.left));
    return side[0].name;
  }
  if (key === "ArrowUp" || key === "ArrowDown") {
    const down = key === "ArrowDown";
    const dir = cards.filter((c) => (down ? rowOf(c.top) > curRow : rowOf(c.top) < curRow));
    if (!dir.length) return null;
    const rowKeys = dir.map((c) => rowOf(c.top));
    const targetRow = down ? Math.min(...rowKeys) : Math.max(...rowKeys);
    const rowCards = dir.filter((c) => rowOf(c.top) === targetRow);
    rowCards.sort((a, b) => Math.abs(a.cx - curCard.cx) - Math.abs(b.cx - curCard.cx));
    return rowCards[0].name;
  }
  return null;
}

function App() {
  const initial = useMemo(initialView, []);
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>(initial.tab);
  const [view, setView] = useState<View>(initial.view);
  // ---- Home dashboard chat side-panel ----
  // homeSel = the focused card (drives the selection ring + arrow-key nav).
  // homeChat = the session whose chat panel is open (docked right sidebar on
  // desktop, full-screen sheet on mobile); null when the panel is closed. Kept
  // separate so you can arrow through cards with the panel shut, then Enter to
  // open — and once open, arrowing live-swaps the panel to the focused card.
  // A ?home=<session> deep-link (push-notification tap) seeds both so the page
  // boots with that card focused and its chat open.
  const [homeSel, setHomeSel] = useState<string | null>(initial.homeChat ?? null);
  const [homeChat, setHomeChat] = useState<string | null>(initial.homeChat ?? null);
  // The HTML artifact path currently open in the full-screen preview (the second
  // dialog layered over the Home chat panel), or null when it's closed. Set from
  // the chat's "Open HTML" button (see htmlArtifact / the .html-overlay portal).
  const [htmlView, setHtmlView] = useState<string | null>(null);
  // Whether the "Share" dialog (publishes the open HTML artifact to R2 and shows
  // the public cdn link) is open. Layers above the HTML preview; the share
  // request's state lives on shareMut below.
  const [shareOpen, setShareOpen] = useState(false);

  // ---- Light / dark theme ----
  // Toggle with the `t` shortcut or the theme action; no system mode. Defaults to
  // light. Persisted to localStorage; the `dark` class on <html> flips the
  // CSS-variable palette (see the page <style>) and is fed to the diff library's
  // themeType so the rendered diffs recolor too.
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return localStorage.getItem("theme") === "dark" ? "dark" : "light";
    } catch {
      return "light";
    }
  });
  // Apply before paint so a reload into dark mode doesn't flash light first.
  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);
  useEffect(() => {
    try {
      localStorage.setItem("theme", theme);
    } catch {
      // ignore storage failures (private mode, quota, etc.)
    }
  }, [theme]);
  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  // ---- PWA service worker ----
  // Registers the push/notification worker. No-ops in a non-secure context
  // (plain http), so it only really activates over the https tailscale URL.
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  // ---- Active directory (top-left dropdown) ----
  // null means "the server default" (the launch cwd). Persisted to the URL only,
  // so a reload stays put but launching `dh` elsewhere still opens that new cwd.
  const [activeDir, setActiveDir] = useState<number | null>(initial.dir);
  const activeDirRef = useRef(activeDir);
  activeDirRef.current = activeDir;
  // The directory you were viewing before the current one — drives the Tmux reply
  // bar's "go to last directory" button (a back/toggle). `undefined` until you've
  // switched dirs at least once, which keeps that button disabled on first load.
  const [prevDir, setPrevDir] = useState<number | null | undefined>(undefined);
  // Append ?dir=<id> to an API url so every request targets the active directory.
  const qd = useCallback((base: string) => {
    const d = activeDirRef.current;
    return d == null ? base : `${base}${base.includes("?") ? "&" : "?"}dir=${d}`;
  }, []);
  // Build a "/?dir=…&…" address that preserves the active directory in the URL.
  const navUrl = useCallback((...parts: (string | false | null | undefined)[]) => {
    const d = activeDirRef.current;
    const all = [d != null ? `dir=${d}` : "", ...parts].filter(Boolean);
    return all.length ? `/?${all.join("&")}` : "/";
  }, []);

  // Whether the Changes view auto-refreshes (polling + window focus). Toggle
  // with the switch in the Changes sidebar; `space` forces a one-off refresh of
  // whatever tab you're on. Defaults to off and persists via localStorage.
  const [autoRefresh, setAutoRefresh] = useState(() => {
    try {
      return localStorage.getItem("autoRefresh") === "true";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("autoRefresh", String(autoRefresh));
    } catch {
      // ignore storage failures (private mode, quota, etc.)
    }
  }, [autoRefresh]);

  // Whether tapping a diff line highlights it (driving the floating action bar).
  // Desktop always allows it; on mobile it's off by default so taps scroll and
  // select text normally, and you flip it on from the Actions menu. Persisted.
  const [diffHighlights, setDiffHighlights] = useState(() => {
    try {
      return localStorage.getItem("diffHighlights") === "true";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("diffHighlights", String(diffHighlights));
    } catch {
      // ignore storage failures (private mode, quota, etc.)
    }
  }, [diffHighlights]);

  // ---- Sidebar sizing + responsive layout ----
  // Both sidebars are drag-resizable on desktop (widths persisted); the right one
  // can be minimized to a floating chevron; and below 1024px the columns become
  // off-canvas drawers opened from a top bar (burger = left, panel = right).
  const [leftWidth, setLeftWidth] = useState(() => loadNum("sidebarLeftWidth", 300));
  const [rightWidth, setRightWidth] = useState(() => loadNum("sidebarRightWidth", 280));
  const leftWidthRef = useRef(leftWidth);
  leftWidthRef.current = leftWidth;
  const rightWidthRef = useRef(rightWidth);
  rightWidthRef.current = rightWidth;
  const [rightMinimized, setRightMinimized] = useState(() => {
    try {
      return localStorage.getItem("rightSidebarMinimized") === "true";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("rightSidebarMinimized", String(rightMinimized));
    } catch {
      // ignore storage failures (private mode, quota, etc.)
    }
  }, [rightMinimized]);
  // Which off-canvas drawer is open on mobile (transient — never persisted).
  const [drawerOpen, setDrawerOpen] = useState<null | "left" | "right">(null);
  // Mobile-only "Actions" menu in the top bar (the tab-relevant things you'd
  // otherwise trigger by keyboard on desktop). Transient — never persisted.
  const [actionsOpen, setActionsOpen] = useState(false);
  const [isDesktop, setIsDesktop] = useState(() => {
    try {
      return window.matchMedia("(min-width: 1025px)").matches;
    } catch {
      return true;
    }
  });
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1025px)");
    const onChange = () => {
      setIsDesktop(mq.matches);
      if (mq.matches) setDrawerOpen(null); // back to desktop → no stale drawer
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  // On mobile, any navigation (tab or selection — both change `view`) closes the
  // drawer so the chosen diff/session is visible.
  useEffect(() => {
    if (!isDesktop) setDrawerOpen(null);
  }, [tab, view, isDesktop]);
  const layoutRef = useRef<HTMLDivElement | null>(null);
  // Live-drag a sidebar divider: write the CSS var straight to the DOM on each
  // move for a smooth drag, then commit the clamped width to state + storage on
  // release. Reads the start width from a ref so the handler can stay stable.
  const startResize = useCallback(
    (side: "left" | "right") => (e: ReactPointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = side === "left" ? leftWidthRef.current : rightWidthRef.current;
      const min = side === "left" ? LEFT_MIN : RIGHT_MIN;
      const max = side === "left" ? LEFT_MAX : RIGHT_MAX;
      const cssVar = side === "left" ? "--left-w" : "--right-w";
      let latest = startW;
      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        // The left handle grows with rightward drag; the right handle is mirrored.
        const raw = side === "left" ? startW + dx : startW - dx;
        latest = Math.max(min, Math.min(max, raw));
        layoutRef.current?.style.setProperty(cssVar, `${latest}px`);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        if (side === "left") {
          setLeftWidth(latest);
          saveNum("sidebarLeftWidth", latest);
        } else {
          setRightWidth(latest);
          saveNum("sidebarRightWidth", latest);
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [],
  );

  // Remember the tab you're on so the next directory switch restores it.
  useEffect(() => {
    saveLastTab(tab);
  }, [tab]);

  // ---- Server data (TanStack Query) ----
  // Every list/diff query keys on `activeDir` so switching directories refetches.
  const metaQuery = useQuery({
    queryKey: ["meta", activeDir],
    queryFn: ({ signal }) => fetchJSON<Meta>(qd("/api/meta"), signal),
    staleTime: Infinity,
  });
  const meta = metaQuery.data ?? null;
  const workspace = !!meta?.workspace;

  // Registered directories for the top-left dropdown + settings dialog.
  const dirsQuery = useQuery({
    queryKey: ["dirs"],
    queryFn: ({ signal }) =>
      fetchJSON<{ dirs: DirEntry[]; defaultDirId: number }>("/api/dirs", signal),
    staleTime: Infinity,
  });
  const dirs = dirsQuery.data?.dirs ?? [];

  // Commits are paginated; useInfiniteQuery stitches the pages together and the
  // "Load more" button just asks for the next one.
  const commitsQuery = useInfiniteQuery({
    queryKey: ["commits", activeDir],
    queryFn: ({ pageParam, signal }) =>
      fetchJSON<Commit[]>(qd(`/api/commits?page=${pageParam}`), signal),
    initialPageParam: 1,
    getNextPageParam: (lastPage, allPages) => (lastPage.length > 0 ? allPages.length + 1 : undefined),
  });
  const commits = useMemo(() => commitsQuery.data?.pages.flat() ?? [], [commitsQuery.data]);
  const hasMore = commitsQuery.hasNextPage;
  const loadingMore = commitsQuery.isFetchingNextPage;

  const prsQuery = useQuery({
    queryKey: ["prs", activeDir],
    queryFn: ({ signal }) => fetchJSON<PR[]>(qd("/api/prs"), signal),
    enabled: tab === "prs",
  });
  const prs = prsQuery.data ?? null;
  const prError = errMessage(prsQuery.error);

  const manualQuery = useQuery({
    queryKey: ["manual", activeDir],
    queryFn: ({ signal }) => fetchJSON<ManualPatch[]>(qd("/api/manual"), signal),
    enabled: tab === "manual" || initial.tab === "manual",
  });
  const manualPatches = manualQuery.data ?? null;
  const manualError = errMessage(manualQuery.error);

  const changesQuery = useQuery({
    queryKey: ["changes", activeDir],
    queryFn: ({ signal }) => fetchJSON<RepoChanges[]>(qd("/api/changes"), signal),
    // Home also reads this — its top-bar "Commit with Claude" button greys out
    // when the tree is clean — but only the Changes tab polls; Home settles for a
    // single fetch (+ refetch-on-focus) so the dashboard doesn't add a 2.5s poll.
    enabled: tab === "changes" || tab === "home",
    // Poll + refetch-on-focus only while auto-refresh is on. Structural sharing
    // keeps `data` referentially stable when nothing changed, so a poll that
    // finds no diff doesn't re-render the view — replacing the old manual
    // JSON.stringify dedup.
    refetchInterval: autoRefresh && tab === "changes" ? 2500 : false,
    refetchOnWindowFocus: autoRefresh,
  });
  const changes = changesQuery.data ?? null;
  // Whether the active dir's working tree has anything to commit — gates the
  // "Commit with Claude" affordances (Changes-tab actions menu + Home top bar).
  const dirty = (changes ?? []).some(
    (rc) => rc.staged.length || rc.unstaged.length || rc.untracked.length,
  );

  // ---- Tmux tab: claude sessions + the selected session's transcript ----
  // These are global (not dir-scoped) — they reflect every claude tmux session.
  // Poll the session list only while some claude session is actively working, so
  // the busy dots + task lines stay live during a run but we stay quiet at idle.
  const tmuxQuery = useQuery({
    queryKey: ["tmux-sessions"],
    queryFn: ({ signal }) =>
      fetchJSON<{ sessions: TmuxSession[]; queued?: QueuedSession[]; online?: boolean }>(
        "/api/tmux/sessions",
        signal,
      ),
    enabled: tab === "tmux" || tab === "home",
    refetchOnWindowFocus: false,
    // Poll while a session is working (live busy dots), while one sits waiting for
    // input (so its "Waiting" badge appears the moment a run pauses on a prompt and
    // clears once answered — same reason the transcript keeps an idle poll), or
    // while prompts sit queued (so they vanish + their real session pops in the
    // moment the network returns).
    refetchInterval: (query) =>
      query.state.data?.sessions.some((s) => s.busy)
        ? TMUX_POLL_MS
        : query.state.data?.sessions.some((s) => s.waiting)
          ? TMUX_IDLE_POLL_MS
          : query.state.data?.queued?.length
            ? TMUX_QUEUE_POLL_MS
            : false,
  });
  const tmuxSessions = tmuxQuery.data?.sessions ?? null;
  const queuedSessions = tmuxQuery.data?.queued ?? null;
  // Whether the machine can reach the API (so launches run vs. queue). Defaults to
  // online until the first poll; other tabs keep the last polled value.
  const serverOnline = tmuxQuery.data?.online ?? true;
  // The session whose chat is on screen. On the Tmux tab that's the tab's
  // selection; on the Home dashboard it's the card whose chat side-panel is open
  // (homeChat). Tab wins over view.kind so a stray Tmux `view` left behind by a
  // shared handler (e.g. killSession's neighbour-select) can't leak into Home.
  // Both feed the same transcript machinery below (query, turns, reply box), so
  // the chat renders identically whether it's the full Tmux pane or the Home
  // right-sidebar.
  const selectedSession =
    tab === "home" ? homeChat ?? "" : view.kind === "tmux" ? view.session : "";
  // Stream the open transcript fast while its session is busy. When idle we keep a
  // slow baseline poll rather than stopping: a session paused on an AskUserQuestion
  // / plan / permission prompt reads as not-busy (the pane title drops its braille
  // spinner), and claude doesn't write that pending turn to the transcript until
  // it's answered — so the server captures it from the live pane (pendingPane).
  // The idle poll is what keeps that capture fresh; without it the prompt wouldn't
  // surface until the answer flips the session busy again. Structural sharing keeps
  // an unchanged poll's data ref stable, so reading back through an idle transcript
  // still isn't yanked to the end.
  const selectedBusy = !!tmuxSessions?.find((s) => s.name === selectedSession)?.busy;
  const transcriptQuery = useQuery({
    queryKey: ["tmux-transcript", selectedSession],
    queryFn: ({ signal }) =>
      fetchJSON<Transcript>(`/api/tmux/transcript?session=${encodeURIComponent(selectedSession)}`, signal),
    enabled: (tab === "tmux" || tab === "home") && !!selectedSession,
    refetchOnWindowFocus: false,
    refetchInterval: selectedBusy ? TMUX_POLL_MS : TMUX_IDLE_POLL_MS,
  });
  const selectedSessionRef = useRef(selectedSession);
  selectedSessionRef.current = selectedSession;
  // Latest tab, readable from stable callbacks (chatScroll) without re-binding.
  const tabRef = useRef(tab);
  tabRef.current = tab;

  // ---- Per-session "unread" tracking (Tmux tab) ----
  // A session reads as "unread" once it finishes a turn (goes idle) with new
  // transcript output you haven't opened since — the sidebar dot + the "next
  // unread" jump button. We track it client-side off the transcript mtime each
  // session already reports: remember the mtime you last looked at, and anything
  // newer-while-idle is unread. Persisted per device (keyed by the stable
  // sessionId), so sessions that finish while the tab is closed still surface.
  const [seenMtimes, setSeenMtimes] = useState<Record<string, number>>(() => {
    try {
      const raw = localStorage.getItem("tmuxSeen");
      return raw ? (JSON.parse(raw) as Record<string, number>) : {};
    } catch {
      return {};
    }
  });
  // Whether a seen-map already existed at startup, captured (lazily, so it reads
  // the value before the persist effect below writes one). Lets the first-load
  // seeding tell a fresh device — seed everything as read so old idle sessions
  // don't all light up — apart from a returning one, where the persisted map
  // already decides and unknown sessions should default to unseen.
  const [hadStoredSeen] = useState<boolean>(() => {
    try {
      return localStorage.getItem("tmuxSeen") !== null;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    // Don't write an empty map: it carries no information (unknown sessions
    // already default to unseen) and writing it early would make a fresh device
    // look "returning" before first-load seeding gets to run.
    if (Object.keys(seenMtimes).length === 0) return;
    try {
      localStorage.setItem("tmuxSeen", JSON.stringify(seenMtimes));
    } catch {
      // ignore storage failures (private mode, quota, etc.)
    }
  }, [seenMtimes]);
  // Seed once on first ever load: mark every current session read at its present
  // mtime so a brand-new device doesn't open with every idle session flagged.
  // Skipped on returning devices — defaulting unknown sessions to "unseen" is
  // what surfaces sessions that finished while the tab was closed.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !tmuxSessions) return;
    seededRef.current = true;
    if (hadStoredSeen) return;
    setSeenMtimes((prev) => {
      const next = { ...prev };
      for (const s of tmuxSessions) {
        const key = s.sessionId || s.name;
        if (next[key] === undefined) next[key] = s.mtime;
      }
      return next;
    });
  }, [tmuxSessions, hadStoredSeen]);
  // Viewing a session on the *Tmux tab* marks it read: pin its last-seen mtime to
  // the latest each poll so the open transcript never shows unread, even as new
  // output streams in. The Home dashboard deliberately opts out — there you clear a
  // card's unread state with its explicit "mark read" button (or the `r` key), so
  // arrowing through and peeking at cards never silently acknowledges them. That's
  // what keeps the grid stable while you navigate it.
  useEffect(() => {
    if (tabRef.current !== "tmux") return;
    if (!selectedSession || !tmuxSessions) return;
    const s = tmuxSessions.find((x) => x.name === selectedSession);
    if (!s || !s.mtime) return;
    const key = s.sessionId || s.name;
    setSeenMtimes((prev) => (prev[key] === s.mtime ? prev : { ...prev, [key]: s.mtime }));
  }, [selectedSession, tmuxSessions]);

  // Sessions are global (every claude tmux session on the box), but the Tmux tab
  // should only show the ones running under the directory you're browsing. Scope
  // by cwd against the active directory's root (`meta.path`): a session belongs
  // here if its cwd is that root or sits beneath it (covers workspace sub-repos).
  const dirScopedTmux = useMemo(() => {
    if (!tmuxSessions) return null;
    const root = meta?.path;
    if (!root) return tmuxSessions;
    return tmuxSessions.filter((s) => s.cwd === root || s.cwd.startsWith(`${root}/`));
  }, [tmuxSessions, meta?.path]);

  // The Tmux tab badge counts only sessions where claude is actively working,
  // not the total — idle sessions don't earn a number.
  const runningTmux = useMemo(
    () => dirScopedTmux?.filter((s) => s.busy).length ?? 0,
    [dirScopedTmux],
  );
  // The Home tab badge counts sessions blocked on input — the actionable number.
  // Independent of the search filter, so it always reflects the directory's truth.
  const needsActionCount = useMemo(
    () => dirScopedTmux?.filter((s) => s.waiting && !s.busy).length ?? 0,
    [dirScopedTmux],
  );

  const [busyPath, setBusyPath] = useState<string | null>(null);

  // Commit & push dialog (Changes view, `;`)
  // Restart-server dialog (`⇧R`) — which tmux window to bounce and what command
  // to relaunch it with. Both default to `dh` (diffshub itself) but can point at
  // any window/command pair. Kept in state so the last-used values stick for the
  // session rather than resetting to `dh` on every open.
  const [restartOpen, setRestartOpen] = useState(false);
  const [restartWindow, setRestartWindow] = useState("dh");
  const [restartCommand, setRestartCommand] = useState("dh");

  // Kill-all confirmation dialog (`_`) — wipes every session currently listed on
  // the Tmux tab. `killingAll` disables the buttons while the kills are in flight.
  const [killAllOpen, setKillAllOpen] = useState(false);
  const [killingAll, setKillingAll] = useState(false);

  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState(false);
  // Same cursor-preservation + auto-grow as the New Claude session composer: the
  // message and caret survive closing/reopening the dialog so an edited multi-line
  // message isn't lost when you pop out to read the diff. In-memory only (the
  // message itself isn't persisted), so there's nothing to restore across reloads.
  const commitTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const commitCaretRef = useRef<{ start: number; end: number } | null>(null);
  const captureCommitCaret = useCallback((el: HTMLTextAreaElement) => {
    commitCaretRef.current = { start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 };
  }, []);
  const autosizeCommit = useCallback(() => autosize(commitTextareaRef.current), []);
  // On (re)open, drop the caret back where it was and size to the message; a fresh
  // (empty) message defaults the caret to the end like autoFocus would.
  useEffect(() => {
    if (!commitOpen) return;
    const caret = commitCaretRef.current;
    requestAnimationFrame(() => {
      const el = commitTextareaRef.current;
      if (!el) return;
      el.focus();
      const pos = caret ?? { start: el.value.length, end: el.value.length };
      el.setSelectionRange(pos.start, pos.end);
      autosizeCommit();
    });
  }, [commitOpen, autosizeCommit]);

  // New Claude session dialog (`'`) — launches an interactive claude tmux
  // session in the active directory, detached, seeded with the typed prompt.
  const [claudeOpen, setClaudeOpen] = useState(false);
  // Loaded per-directory by the effect below once `meta` (the active dir) is known.
  const [claudePrompt, setClaudePrompt] = useState("");
  const [launching, setLaunching] = useState(false);
  const [launchedSession, setLaunchedSession] = useState<string | null>(null);
  // Brief confirmation shown after an offline prompt is queued (auto-dismissed).
  const [queuedNote, setQueuedNote] = useState(false);
  // True while a pasted image is being uploaded to /tmp/images (⌃V in the dialog).
  const [imgUploading, setImgUploading] = useState(false);

  // Claude usage dialog (`⇧U`) — shows how much of the 5-hour and weekly
  // rate-limit windows is spent and when each resets (see usageQuery below).
  const [usageOpen, setUsageOpen] = useState(false);

  // Reply composer (Tmux tab) — types a reply into the selected session's pane.
  const [replyText, setReplyText] = useState("");
  const [replySending, setReplySending] = useState(false);
  const [replyStopping, setReplyStopping] = useState(false);
  const [replyImgUploading, setReplyImgUploading] = useState(false);
  const replyTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Set when `/` opens a Home chat sheet that wasn't open yet, so the effect that
  // watches homeChat knows to drop focus into the composer once it has mounted.
  const focusReplyOnOpenRef = useRef(false);
  // Where we are while walking this session's sent-reply history with the arrow
  // keys: null = editing the live draft (not browsing). Reset on send, on a real
  // keystroke, and when the selected session changes. See recallReplyHistory.
  const replyHistoryIndexRef = useRef<number | null>(null);

  // Transcript header toggle: when on, the chat view is filtered down to just
  // the Edit/Write/MultiEdit tool calls (the inline diffs), hiding prose and
  // other tool noise.
  const [editsOnly, setEditsOnly] = useState(false);

  // Directory dropdown (top-left) + settings dialog (manage directories). The
  // dropdown is a combobox: `dirFilter` narrows the list as you type and
  // `dirActive` is the keyboard-highlighted row (Enter selects it). The `D`
  // shortcut opens it and focuses `dirSearchEl`.
  const [dirMenuOpen, setDirMenuOpen] = useState(false);
  const [dirsOpen, setDirsOpen] = useState(false);
  const [dirFilter, setDirFilter] = useState("");
  const [dirActive, setDirActive] = useState(0);
  const dirSearchEl = useRef<HTMLInputElement | null>(null);

  // Auto-dismiss the "Launched" banner after a short period.
  useEffect(() => {
    if (!launchedSession) return;
    const id = window.setTimeout(() => setLaunchedSession(null), 5000);
    return () => window.clearTimeout(id);
  }, [launchedSession]);

  // Auto-dismiss the "Queued" banner the same way.
  useEffect(() => {
    if (!queuedNote) return;
    const id = window.setTimeout(() => setQueuedNote(false), 6000);
    return () => window.clearTimeout(id);
  }, [queuedNote]);

  const [filter, setFilter] = useState("");
  // Second sidebar box (Tmux/Home): a full-text search over the transcripts you've
  // already opened. We index whatever the transcript query has fetched into an
  // ephemeral in-memory map — only viewed sessions are searchable, by design (a
  // lightweight best-effort search, not a server-side scan of every jsonl). The
  // ref holds the lowercased blobs; contentVersion just nudges the filter memo to
  // re-run when the index gains/loses an entry while a search is active.
  const [contentFilter, setContentFilter] = useState("");
  const contentIndex = useRef<Map<string, string>>(new Map());
  const [contentVersion, setContentVersion] = useState(0);

  // ---- @-file autocomplete (New Claude session dialog + reply composer) ----
  // The active `@token` being typed: its query text + where the `@` sits + caret,
  // plus which composer (`owner`) it belongs to. Both composers share this state —
  // only the focused one can own a live token at a time — and `owner` decides which
  // textarea accept/placement act on and which popup renders.
  const [fileToken, setFileToken] = useState<{
    query: string;
    start: number;
    caret: number;
    owner: "claude" | "reply";
  } | null>(null);
  const [fileMenuIndex, setFileMenuIndex] = useState(0);
  // The directory's gitignore-respecting file list. Fetched while the New Claude
  // dialog is open (so the first `@` there is instant) and lazily whenever a
  // mention token goes live in either composer. Typing `@…` filters it into a
  // popup that inserts `@path` references.
  const filesQuery = useQuery({
    queryKey: ["files", activeDir],
    queryFn: ({ signal }) => fetchJSON<{ files: string[] }>(qd("/api/files"), signal),
    enabled: claudeOpen || !!fileToken,
    staleTime: 30_000,
  });

  // ---- Claude usage (rate-limit windows) ----
  // Read from ~/.claude/rate-limits.json (written by the statusline hook) only
  // while the Usage dialog is open. The short staleTime lets a quick reopen reuse
  // the cache while still refetching the file on its own cadence; opening always
  // pulls the freshest snapshot the statusline has written.
  const usageQuery = useQuery({
    queryKey: ["usage"],
    queryFn: ({ signal }) => fetchJSON<UsageData>("/api/usage", signal),
    enabled: usageOpen,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });
  const claudeTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  // A live mirror of `claudeOpen` for callbacks/effects that shouldn't re-subscribe
  // just to read it (e.g. the per-dir draft effect restoring focus mid-compose).
  const claudeOpenRef = useRef(claudeOpen);
  claudeOpenRef.current = claudeOpen;
  // Grow the composer to fit its content, but cap it to the *visible* viewport so
  // a long prompt's caret never slides behind the mobile keyboard. visualViewport
  // .height excludes the keyboard (vh/innerHeight don't), and offsetTop tells us
  // where that visible band sits — so we keep the box's bottom above the keyboard
  // and let it scroll internally past that. Reserve room below for the modal's
  // action row + padding. Falls back to plain autosize where visualViewport is
  // unavailable or the box still fits.
  const autosizeClaude = useCallback(() => {
    const el = claudeTextareaRef.current;
    if (!el) return;
    const vv = window.visualViewport;
    el.style.height = "auto";
    let target = el.scrollHeight;
    if (vv) {
      const top = el.getBoundingClientRect().top - vv.offsetTop;
      const room = vv.height - top - 96; // leave space for the footer buttons
      if (room > 120) target = Math.min(target, room);
    }
    el.style.height = `${target}px`;
  }, []);
  // Re-fit when the visible viewport changes (the mobile keyboard sliding in or
  // out) so the cap tracks the keyboard instead of the prompt's last keystroke.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!claudeOpen || !vv) return;
    const onResize = () => autosizeClaude();
    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  }, [claudeOpen, autosizeClaude]);
  // Re-fit on every value change (typing, draft load, dir switch). useLayoutEffect
  // runs after React commits the new value but before paint, so scrollHeight is
  // measured against the text actually in the box — no rAF race, no stale height.
  // This is what makes a directory's grown height survive hopping away and back:
  // the swapped-in draft re-fits deterministically instead of relying on a frame
  // callback that may run before the new value lands in the DOM.
  useLayoutEffect(() => {
    if (claudeOpen) autosizeClaude();
  }, [claudePrompt, claudeOpen, autosizeClaude]);
  // Where the caret/selection sat when the dialog last closed, so reopening it
  // (e.g. after `esc`) restores the cursor instead of jumping to the start/end.
  // Persisted per directory (see claudeCaretKey) so it survives reloads and dir
  // hops too, matching the per-directory draft.
  const claudeCaretRef = useRef<{ start: number; end: number } | null>(null);
  const captureClaudeCaret = useCallback((el: HTMLTextAreaElement) => {
    const caret = { start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 };
    claudeCaretRef.current = caret;
    const id = claudeDraftDirRef.current;
    if (id != null) saveCaret(claudeCaretKey(id), caret);
  }, []);
  // A @-mention target bundles everything the shared autocomplete needs to drive a
  // particular composer: its textarea ref, value setter, caret-capture/autosize
  // hooks, and an optional post-insert callback (the reply box persists its draft).
  // The active `fileToken.owner` selects which of these the logic operates on.
  type MentionTarget = {
    id: "claude" | "reply";
    ref: MutableRefObject<HTMLTextAreaElement | null>;
    setText: Dispatch<SetStateAction<string>>;
    captureCaret: (el: HTMLTextAreaElement) => void;
    autosize: () => void;
    onAccept?: (next: string) => void;
  };
  const claudeMentionTarget = useMemo<MentionTarget>(
    () => ({
      id: "claude",
      ref: claudeTextareaRef,
      setText: setClaudePrompt,
      captureCaret: captureClaudeCaret,
      autosize: autosizeClaude,
    }),
    [captureClaudeCaret, autosizeClaude],
  );
  const replyMentionTarget = useMemo<MentionTarget>(
    () => ({
      id: "reply",
      ref: replyTextareaRef,
      setText: setReplyText,
      // The reply box has no persisted caret and is CSS-resizable, so both are no-ops.
      captureCaret: () => {},
      autosize: () => {},
      // No onChange fires for a programmatic insert, so persist the draft here too.
      onAccept: (next: string) => {
        if (selectedSessionRef.current) saveDraft(replyDraftKey(selectedSessionRef.current), next);
      },
    }),
    [],
  );
  // The Claude draft is kept per active directory (meta.id, which resolves the
  // "server default" case too). `claudeDraftDirRef` records which dir the
  // in-memory prompt belongs to, so switching directories loads that dir's own
  // draft and the save effect always writes back to the right key. The
  // `current === id` guard means a meta refetch for the same dir won't clobber
  // what the user is currently typing.
  const claudeDraftDirRef = useRef<number | null>(null);
  useEffect(() => {
    const id = meta?.id;
    if (id == null || claudeDraftDirRef.current === id) return;
    claudeDraftDirRef.current = id;
    setClaudePrompt(loadDraft(claudeDraftKey(id)));
    claudeCaretRef.current = loadCaret(claudeCaretKey(id));
    // Switching directories with the composer open (⌥1-9) swaps in that dir's
    // own draft without stealing focus, so you can juggle a prompt per directory.
    // Re-focus and drop the caret into the freshly-loaded draft on the next frame.
    if (claudeOpenRef.current) {
      requestAnimationFrame(() => {
        const el = claudeTextareaRef.current;
        if (!el) return;
        el.focus();
        const pos = claudeCaretRef.current ?? { start: el.value.length, end: el.value.length };
        el.setSelectionRange(pos.start, pos.end);
        autosizeClaude();
      });
    }
  }, [meta?.id, autosizeClaude]);
  // Persist the draft under its directory's key; launching clears the prompt,
  // which also clears the stored key. Wait until we know the active dir so we
  // never write the draft under the wrong (or a stale) key.
  useEffect(() => {
    const id = claudeDraftDirRef.current;
    if (id == null) return;
    saveDraft(claudeDraftKey(id), claudePrompt);
  }, [claudePrompt]);
  // On (re)open, drop the caret back where it was; autoFocus has already focused
  // the textarea, so default a fresh prompt's caret to the end of the text.
  useEffect(() => {
    if (!claudeOpen) return;
    const caret = claudeCaretRef.current;
    requestAnimationFrame(() => {
      const el = claudeTextareaRef.current;
      if (!el) return;
      el.focus();
      const pos = caret ?? { start: el.value.length, end: el.value.length };
      el.setSelectionRange(pos.start, pos.end);
      autosizeClaude();
    });
  }, [claudeOpen, autosizeClaude]);
  // Recompute the active @token from a textarea's value + caret position, tagging
  // it with which composer (`target.id`) it belongs to.
  const syncFileToken = useCallback((el: HTMLTextAreaElement, target: MentionTarget) => {
    const value = el.value;
    const caret = el.selectionStart ?? value.length;
    let i = caret - 1;
    let token: { query: string; start: number; caret: number; owner: "claude" | "reply" } | null =
      null;
    while (i >= 0) {
      const ch = value[i];
      if (ch === "@") {
        const prev = i > 0 ? value[i - 1] : " ";
        if (i === 0 || /\s/.test(prev))
          token = { query: value.slice(i + 1, caret), start: i, caret, owner: target.id };
        break;
      }
      if (/\s/.test(ch)) break; // whitespace before any '@' — not in a token
      i--;
    }
    setFileToken(token);
    setFileMenuIndex(0);
  }, []);
  const fileSuggestions = useMemo(() => {
    if (!fileToken) return [];
    const all = filesQuery.data?.files ?? [];
    const q = fileToken.query.toLowerCase();
    const matched = q ? all.filter((f) => f.toLowerCase().includes(q)) : all;
    // Prefer the shortest (closest) matches, then alphabetical.
    return [...matched].sort((a, b) => a.length - b.length || (a < b ? -1 : 1)).slice(0, 20);
  }, [fileToken, filesQuery.data]);
  // Replace the active @token with `@<path> ` in its owning composer and restore
  // the caret after it.
  const acceptFile = useCallback(
    (path: string) => {
      const tok = fileToken;
      if (!tok) return;
      const target = tok.owner === "reply" ? replyMentionTarget : claudeMentionTarget;
      target.setText((prev) => {
        const inserted = `@${path} `;
        const next = prev.slice(0, tok.start) + inserted + prev.slice(tok.caret);
        const pos = tok.start + inserted.length;
        target.onAccept?.(next);
        requestAnimationFrame(() => {
          const el = target.ref.current;
          if (el) {
            el.focus();
            el.setSelectionRange(pos, pos);
            target.captureCaret(el);
            target.autosize();
          }
        });
        return next;
      });
      setFileToken(null);
    },
    [fileToken, claudeMentionTarget, replyMentionTarget],
  );
  const fileMenuOpen = !!fileToken && fileSuggestions.length > 0;
  // The @-file popover is portaled to <body> (see the dialog JSX) so the modal's
  // `overflow-y: auto` can't clip it — the old in-modal absolute popover got cut
  // off whenever the composer grew. We pin it to the textarea with fixed coords,
  // flip it above when there's more room up top, and cap its height to the space
  // available so it never spills past the viewport. Recomputed as the box grows
  // or shrinks (claudePrompt), as the list fills in, and on scroll/resize.
  const [fileMenuStyle, setFileMenuStyle] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!fileToken) {
      setFileMenuStyle(null);
      return;
    }
    const target = fileToken.owner === "reply" ? replyMentionTarget : claudeMentionTarget;
    const place = () => {
      const el = target.ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const gap = 4;
      const below = window.innerHeight - r.bottom - gap;
      const above = r.top - gap;
      const placeAbove = below < 180 && above > below;
      setFileMenuStyle({
        position: "fixed",
        left: r.left,
        width: r.width,
        maxHeight: Math.max(120, Math.min(280, placeAbove ? above : below)),
        ...(placeAbove ? { bottom: window.innerHeight - r.top + gap } : { top: r.bottom + gap }),
      });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [fileToken, claudePrompt, replyText, fileSuggestions.length, claudeMentionTarget, replyMentionTarget]);

  // ---- Diff for the active commit/PR view ----
  // Keyed by sha/number+repo so revisiting one is instant from cache; commit
  // diffs are immutable so they never go stale.
  const diffKey = useMemo<readonly unknown[]>(() => {
    if (view.kind === "commit") return ["diff", activeDir, "commit", view.sha, view.repo ?? null];
    if (view.kind === "pr") return ["diff", activeDir, "pr", view.number, view.repo ?? null];
    return ["diff", activeDir, "none"];
  }, [view, activeDir]);
  const diffQuery = useQuery({
    queryKey: diffKey,
    queryFn: ({ signal }) => {
      if (view.kind !== "commit" && view.kind !== "pr") throw new Error("no diff");
      const rp = view.repo ? `?repo=${encodeURIComponent(view.repo)}` : "";
      const url =
        view.kind === "commit" ? `/api/diff/${view.sha}${rp}` : `/api/diff/pr/${view.number}${rp}`;
      return fetchText(qd(url), signal);
    },
    enabled: view.kind === "commit" || view.kind === "pr",
    staleTime: Infinity,
  });
  const diffText = diffQuery.data ?? "";
  const diffLoading = (view.kind === "commit" || view.kind === "pr") && diffQuery.isPending;
  const diffError = errMessage(diffQuery.error);
  const diffKeyRef = useRef(diffKey);
  diffKeyRef.current = diffKey;

  // Highlighted diff lines + the floating action bar they drive.
  const [selection, setSelection] = useState<DiffSelection | null>(null);
  // Selecting lines is always on at desktop width; on mobile it follows the
  // `diffHighlights` toggle. When off, the diff swallows no taps (so they scroll
  // and select text normally) and any stale highlight is dropped.
  const lineSelectable = isDesktop || diffHighlights;
  useEffect(() => {
    if (!lineSelectable) setSelection(null);
  }, [lineSelectable]);

  const fileEls = useRef(new Map<string, HTMLDivElement>());
  const mainEl = useRef<HTMLDivElement | null>(null);
  // The Home chat side-panel owns its own scroll container; on the Tmux tab the
  // chat scrolls in the main column (mainEl). chatScroll() returns whichever is
  // live so the auto-scroll / "jump to latest" logic drives the right element.
  const chatScrollEl = useRef<HTMLDivElement | null>(null);
  const chatScroll = useCallback(
    () => (tabRef.current === "home" ? chatScrollEl.current : mainEl.current),
    [],
  );
  const searchEl = useRef<HTMLInputElement | null>(null);

  // Whenever a transcript loads/refreshes, jump to the bottom so the newest part
  // of the conversation is in view. While the session is busy this polls (see
  // selectedBusy), so streamed-in messages auto-scroll to the end; structural
  // sharing means an unchanged poll keeps the same data ref and won't re-scroll.
  const transcriptData = transcriptQuery.data;
  // Index the open transcript into the ephemeral "Search html…" cache whenever it
  // (re)loads. Keyed by the stable sessionId so it survives renames; overwritten
  // each load so an entry always reflects the latest content we've seen. Cheap:
  // structural sharing keeps the data ref stable on an unchanged poll, and we bail
  // early when the blob is identical, so an idle session's poll does no work and
  // never bumps the version (no needless re-render).
  useEffect(() => {
    if (!transcriptData) return;
    const key = transcriptData.sessionId || transcriptData.session;
    if (!key) return;
    const text = transcriptText(transcriptData);
    if (contentIndex.current.get(key) === text) return;
    contentIndex.current.set(key, text);
    setContentVersion((v) => v + 1);
  }, [transcriptData]);
  // Evict index entries for sessions that no longer exist (killed, or replaced by
  // a brand-new session). Keeps the ephemeral cache from leaking and stops a
  // deleted chat's text from still matching a search.
  useEffect(() => {
    if (!tmuxSessions) return;
    const live = new Set(tmuxSessions.map((s) => s.sessionId || s.name));
    let pruned = false;
    for (const key of contentIndex.current.keys()) {
      if (!live.has(key)) {
        contentIndex.current.delete(key);
        pruned = true;
      }
    }
    if (pruned) setContentVersion((v) => v + 1);
  }, [tmuxSessions]);
  const turns = useMemo(() => {
    const msgs = transcriptData?.messages ?? [];
    const filtered = editsOnly ? msgs.filter(isEditMsg) : msgs;
    return groupTurns(filtered);
  }, [transcriptData, editsOnly]);
  // Detect an HTML artifact the session has been building (the "agents folder"
  // pattern: an agent writes/appends one .html file across many tool calls). We
  // pick the most-recently-touched .html path from the transcript's Write/Edit/
  // MultiEdit calls — regardless of which directory it lives in — and surface an
  // "Open HTML" button in the Home chat panel that previews its live contents.
  const htmlArtifact = useMemo(() => {
    const msgs = transcriptData?.messages ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (
        m.kind === "tool_use" &&
        (m.tool === "Write" || m.tool === "Edit" || m.tool === "MultiEdit") &&
        m.path &&
        /\.html?$/i.test(m.path)
      )
        return m.path;
    }
    return null;
  }, [transcriptData]);
  // Live contents of the open HTML artifact, read off disk (the transcript caps
  // each edit hunk, so it can't be reconstructed there). Polls while the preview
  // is open so the iframe reflects edits the agent keeps making.
  const htmlQuery = useQuery({
    queryKey: ["tmux-html", selectedSession, htmlView],
    queryFn: ({ signal }) =>
      fetchText(
        `/api/tmux/html?session=${encodeURIComponent(selectedSession)}&path=${encodeURIComponent(htmlView!)}`,
        signal,
      ),
    enabled: !!htmlView && !!selectedSession,
    refetchOnWindowFocus: false,
    refetchInterval: selectedBusy ? TMUX_POLL_MS : TMUX_IDLE_POLL_MS,
  });
  // Publish the open HTML artifact to the public R2 bucket (server shells out to
  // wrangler) and surface the cdn link in a dialog. Idempotent per file: an
  // unchanged artifact returns its existing link instantly (alreadyShared).
  type ShareResult = { url: string; alreadyShared: boolean; assets: number; skipped: string[] };
  const shareMut = useMutation<ShareResult>({
    mutationFn: async () => {
      const res = await fetch("/api/tmux/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: selectedSession, path: htmlView }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<ShareResult> & { error?: string };
      if (!res.ok || data.error || !data.url) throw new Error(data.error || `HTTP ${res.status}`);
      return data as ShareResult;
    },
  });
  // Undo a share: tell the server to delete the published HTML (and its uploaded
  // image assets) from R2 and drop the db row, fully retracting the link.
  const unshareMut = useMutation<{ removed: boolean }>({
    mutationFn: async () => {
      const res = await fetch("/api/tmux/unshare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: selectedSession, path: htmlView }),
      });
      const data = (await res.json().catch(() => ({}))) as { removed?: boolean; error?: string };
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      return { removed: !!data.removed };
    },
  });
  const openShare = () => {
    if (!htmlView) return;
    setShareOpen(true);
    shareMut.mutate();
  };
  const closeShare = () => {
    setShareOpen(false);
    shareMut.reset();
    unshareMut.reset();
  };
  // ChatGPT-style "jump to latest" chevron: track whether the transcript is
  // pinned to the bottom so we can float a chevron above the composer whenever
  // the user has scrolled up. 80px of slack keeps it hidden while effectively
  // at the end (and during the brief auto-scroll settle).
  const [atBottom, setAtBottom] = useState(true);
  // A chat is on screen whenever a session is selected on the Tmux tab or open in
  // the Home side-panel — the gate for the transcript scroll effects below.
  const chatOpen = !!selectedSession && (tab === "tmux" || tab === "home");
  useEffect(() => {
    if (!chatOpen || !transcriptData) return;
    const el = chatScroll();
    if (el)
      requestAnimationFrame(() => {
        el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
        setAtBottom(true);
      });
  }, [chatOpen, transcriptData, selectedSession, chatScroll]);

  useEffect(() => {
    if (!chatOpen) return;
    const el = chatScroll();
    if (!el) return;
    const update = () => setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    update();
    el.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      el.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [chatOpen, transcriptData, selectedSession, chatScroll]);
  const jumpToBottom = useCallback(() => {
    const el = chatScroll();
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
  }, [chatScroll]);
  // Mobile: jump back to the very top of the transcript — handy on long chats
  // where the original prompt has scrolled far out of view.
  const jumpToTop = useCallback(() => {
    const el = chatScroll();
    if (el) el.scrollTo({ top: 0, behavior: "auto" });
  }, [chatScroll]);

  // ---- Reviewed commits (persisted server-side in sqlite) ----
  const reviewedQuery = useQuery({
    queryKey: ["reviewed", activeDir],
    queryFn: ({ signal }) => fetchJSON<string[]>(qd("/api/reviewed"), signal),
    staleTime: Infinity,
  });
  const reviewed = useMemo(() => new Set(reviewedQuery.data ?? []), [reviewedQuery.data]);
  // Optimistically flip the reviewed flag in the cache, then persist; roll the
  // cache back to its previous value if the request fails.
  const toggleReviewed = useCallback(
    (sha: string, repo?: string) => {
      const key = ["reviewed", activeDirRef.current];
      const prev = queryClient.getQueryData<string[]>(key) ?? [];
      const on = !prev.includes(sha);
      queryClient.setQueryData<string[]>(key, on ? [...prev, sha] : prev.filter((s) => s !== sha));
      fetch(qd("/api/reviewed"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sha, reviewed: on, repo }),
      }).catch(() => queryClient.setQueryData(key, prev));
    },
    [queryClient, qd],
  );

  // ---- Commits ----
  // Land on the newest commit whenever the commits tab has nothing selected —
  // on first load (URL didn't pin a specific view) and on every (re)entry to the
  // tab, since switching tabs resets the view to "none". A view that's already a
  // commit (e.g. URL-pinned or hand-picked) is left untouched.
  useEffect(() => {
    if (tab !== "commits") return;
    const first = commits[0];
    if (!first) return;
    setView((v) => (v.kind === "none" ? { kind: "commit", sha: first.sha, repo: first.repo } : v));
  }, [tab, commits]);

  // ---- Manual patches (./diffs/*.patch in the cwd) ----
  // Auto-select the first patch when the Manual tab is open with none chosen.
  useEffect(() => {
    const first = manualPatches?.[0];
    if (!first) return;
    setView((v) => (v.kind === "manual" && !v.name ? { kind: "manual", name: first.name } : v));
  }, [manualPatches]);

  const runGit = useCallback(
    async (action: GitAction, path?: string, repo?: string, worktree?: string) => {
      setBusyPath(path ?? worktree ?? (repo ? `*${repo}` : "*"));
      try {
        const res = await fetch(qd("/api/git"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, path, repo, worktree }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}) as any);
          alert(`${action} failed: ${body.error ?? res.statusText}`);
        }
      } finally {
        setBusyPath(null);
        queryClient.invalidateQueries({ queryKey: ["changes"] });
      }
    },
    [queryClient, qd],
  );

  // Open a file (optionally at a line) in the default editor, server-side
  const openInEditor = useCallback(
    (path: string, line?: number, repo?: string, worktree?: string) => {
      fetch(qd("/api/open"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, line, repo, worktree }),
      }).catch(() => {});
    },
    [qd],
  );
  const onOpenOpaque = useCallback(
    (path: string, repo?: string, worktree?: string) => openInEditor(path, undefined, repo, worktree),
    [openInEditor],
  );

  // Stable ref registrar + selection handler for the memoized diff rows.
  const registerEl = useCallback((key: string, el: HTMLDivElement | null) => {
    if (el) fileEls.current.set(key, el);
    else fileEls.current.delete(key);
  }, []);
  const onDiffSelect = useCallback((fileKey: string, range: SelectedLineRange | null) => {
    setSelection((prev) => {
      if (range) return { fileKey, range };
      // A cleared selection only clears the bar if it was this file's.
      return prev && prev.fileKey === fileKey ? null : prev;
    });
  }, []);

  // Commit staged changes + push, detached in `tmux -L bg`. In a workspace this
  // commits every repo that currently has something staged.
  const submitCommit = useCallback(async () => {
    const message = commitMsg.trim();
    if (!message) return;
    const worktrees = (changes ?? []).filter((rc) => rc.staged.length).map((rc) => rc.dir);
    setCommitting(true);
    try {
      const res = await fetch(qd("/api/commit"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, worktrees }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as any);
        alert(`commit failed: ${body.error ?? res.statusText}`);
        return;
      }
      setCommitOpen(false);
      setCommitMsg("");
      commitCaretRef.current = null; // committed: drop the saved caret
      // The commit/push runs async in tmux; nudge a refetch so the cleared
      // working tree shows up (interval polling will also catch it).
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["changes"] }), 600);
    } finally {
      setCommitting(false);
    }
  }, [commitMsg, changes, queryClient, qd]);

  // Insert text at the current caret of a textarea-backed input (used to drop a
  // pasted image's /tmp path into the prompt/reply), restoring the caret after.
  const insertAtCaret = useCallback(
    (
      ref: MutableRefObject<HTMLTextAreaElement | null>,
      setValue: Dispatch<SetStateAction<string>>,
      insert: string,
      onValue?: (next: string) => void,
    ) => {
      const el = ref.current;
      setValue((prev) => {
        const start = el?.selectionStart ?? prev.length;
        const end = el?.selectionEnd ?? start;
        const next = prev.slice(0, start) + insert + prev.slice(end);
        const pos = start + insert.length;
        requestAnimationFrame(() => {
          const e2 = ref.current;
          if (e2) {
            e2.focus();
            e2.setSelectionRange(pos, pos);
          }
        });
        onValue?.(next);
        return next;
      });
    },
    [],
  );
  // The prompt persists via its own effect on `claudePrompt`; the reply has no
  // such effect, so persist its draft here too (keeps a pasted image ref).
  const insertIntoPrompt = useCallback(
    (insert: string) => insertAtCaret(claudeTextareaRef, setClaudePrompt, insert),
    [insertAtCaret],
  );
  const insertIntoReply = useCallback(
    (insert: string) =>
      insertAtCaret(replyTextareaRef, setReplyText, insert, (next) => {
        if (selectedSessionRef.current) saveDraft(replyDraftKey(selectedSessionRef.current), next);
      }),
    [insertAtCaret],
  );

  // Upload one image File to the server, which saves it under
  // /tmp/images/<random>.<ext>, then insert that absolute path so the claude
  // session can Read it (Read works on /tmp without a permission prompt and
  // renders images visually). Shared by ⌃V paste and the mobile file picker.
  const uploadImageFile = useCallback(
    async (file: File, insert: (path: string) => void, setUploading: (b: boolean) => void) => {
      setUploading(true);
      try {
        const dataUrl: string = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.onerror = () => reject(r.error);
          r.readAsDataURL(file);
        });
        const res = await fetch("/api/upload-image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: dataUrl }),
        });
        const body = await res.json().catch(() => ({}) as any);
        if (!res.ok) {
          alert(`image upload failed: ${body.error ?? res.statusText}`);
          return;
        }
        if (typeof body.path === "string") insert(`${body.path} `);
      } catch (err) {
        alert(`image upload failed: ${String((err as any)?.message ?? err)}`);
      } finally {
        setUploading(false);
      }
    },
    [],
  );
  // Paste an image (⌃V): pull the image off the clipboard and upload it.
  // Non-image pastes fall through to normal text paste.
  const handleImagePaste = useCallback(
    async (
      e: ClipboardEvent<HTMLTextAreaElement>,
      insert: (path: string) => void,
      setUploading: (b: boolean) => void,
    ) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imgItem = Array.from(items).find(
        (it) => it.kind === "file" && it.type.startsWith("image/"),
      );
      if (!imgItem) return; // not an image — let the normal text paste happen
      e.preventDefault();
      const file = imgItem.getAsFile();
      if (!file) return;
      await uploadImageFile(file, insert, setUploading);
    },
    [uploadImageFile],
  );
  // Mobile path: an image chosen from the file picker (photo library / camera).
  const handleImageFile = useCallback(
    async (
      e: ChangeEvent<HTMLInputElement>,
      insert: (path: string) => void,
      setUploading: (b: boolean) => void,
    ) => {
      const input = e.currentTarget;
      const file = input.files?.[0];
      input.value = ""; // let the same file be re-picked next time
      if (!file) return;
      await uploadImageFile(file, insert, setUploading);
    },
    [uploadImageFile],
  );
  const handleClaudePaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) =>
      handleImagePaste(e, insertIntoPrompt, setImgUploading),
    [handleImagePaste, insertIntoPrompt],
  );
  const handleReplyPaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) =>
      handleImagePaste(e, insertIntoReply, setReplyImgUploading),
    [handleImagePaste, insertIntoReply],
  );

  // Launch a new interactive claude session in the active directory (detached).
  const submitClaude = useCallback(async () => {
    const prompt = claudePrompt.trim();
    if (!prompt) return;
    setLaunching(true);
    try {
      const res = await fetch(qd("/api/claude"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as any);
        alert(`launch failed: ${body.error ?? res.statusText}`);
        return;
      }
      const body = await res.json().catch(() => ({}) as any);
      setClaudeOpen(false);
      setClaudePrompt("");
      // Launched: the draft is consumed, so drop its saved caret too (the empty
      // prompt already clears the draft key via the save effect).
      claudeCaretRef.current = null;
      if (claudeDraftDirRef.current != null) saveCaret(claudeCaretKey(claudeDraftDirRef.current), null);
      if (body.queued) {
        // Offline: the prompt was enqueued, not launched. It shows in the Tmux
        // sidebar as a queued row and fires automatically once we're back online.
        setQueuedNote(true);
      } else {
        setLaunchedSession(typeof body.session === "string" ? body.session : null);
      }
      // The new tmux session (or queued row) needs a beat to register before it
      // shows up in the list, so nudge a refresh now and again shortly after rather
      // than waiting for the next poll — otherwise it never pops in.
      queryClient.refetchQueries({ queryKey: ["tmux-sessions"] });
      setTimeout(() => queryClient.refetchQueries({ queryKey: ["tmux-sessions"] }), 900);
    } finally {
      setLaunching(false);
    }
  }, [claudePrompt, qd, queryClient]);

  // Send a reply into the selected session's claude pane (server pastes the text
  // + Enter), then refresh the transcript + session list once so the new turn and
  // the busy dot show up.
  const submitReply = useCallback(async () => {
    const text = replyText.trim();
    const session = selectedSessionRef.current;
    if (!text || !session) return;
    setReplySending(true);
    try {
      const res = await fetch("/api/tmux/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session, text }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as any);
        alert(`reply failed: ${body.error ?? res.statusText}`);
        return;
      }
      pushHistory(replyHistoryKey(session), text); // remember it for ArrowUp recall
      replyHistoryIndexRef.current = null; // sending ends any history browse
      setReplyText("");
      setFileToken(null); // drop any open @-mention popup along with the sent text
      saveDraft(replyDraftKey(session), ""); // sent → drop this tab's saved draft
      // Drop focus once the reply is on its way — keeps the transcript (not a
      // blinking caret) the focus after you fire off a message, and on mobile lets
      // the on-screen keyboard retract so the conversation is fully visible.
      replyTextareaRef.current?.blur();
      // Give claude a beat to accept the keys before reading the transcript back.
      setTimeout(() => {
        queryClient.refetchQueries({ queryKey: ["tmux-transcript", session] });
        queryClient.refetchQueries({ queryKey: ["tmux-sessions"] });
      }, 500);
    } finally {
      setReplySending(false);
    }
  }, [replyText, queryClient]);

  // Drop a recalled history entry into the composer and park the caret at the end
  // so it's ready to edit or fire off. setReplyText is programmatic, so no onChange
  // fires — the saved draft and the history index are left untouched on purpose.
  const applyRecalled = useCallback((next: string) => {
    setReplyText(next);
    requestAnimationFrame(() => {
      const ta = replyTextareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(next.length, next.length);
    });
  }, []);
  // Shell-style history navigation for the reply box. dir = -1 walks toward older
  // replies, +1 toward newer; past the newest you land back on the empty box.
  // Recall only *starts* from an empty composer (so a half-typed draft keeps its
  // normal ArrowUp caret movement); once browsing, both arrows keep stepping.
  // Returns true when it handled the key so the caller can preventDefault.
  const recallReplyHistory = useCallback((dir: -1 | 1): boolean => {
    const session = selectedSessionRef.current;
    if (!session) return false;
    const navigating = replyHistoryIndexRef.current !== null;
    if (dir === -1) {
      // ArrowUp from a non-empty draft is ordinary caret movement, not recall.
      if (!navigating && (replyTextareaRef.current?.value ?? "") !== "") return false;
      const hist = loadHistory(replyHistoryKey(session));
      if (!hist.length) return false;
      const idx = navigating ? Math.max(0, replyHistoryIndexRef.current! - 1) : hist.length - 1;
      replyHistoryIndexRef.current = idx;
      applyRecalled(hist[idx] ?? "");
      return true;
    }
    // ArrowDown only does anything while we're already browsing history.
    if (!navigating) return false;
    const hist = loadHistory(replyHistoryKey(session));
    const idx = replyHistoryIndexRef.current! + 1;
    if (idx >= hist.length) {
      replyHistoryIndexRef.current = null; // past the newest → empty composer
      applyRecalled("");
      return true;
    }
    replyHistoryIndexRef.current = idx;
    applyRecalled(hist[idx] ?? "");
    return true;
  }, [applyRecalled]);

  // Stop claude mid-turn in the selected session: send Escape into its pane (the
  // same key you'd press in the terminal to interrupt). Then refresh so the now-idle
  // state shows up.
  const stopSession = useCallback(async () => {
    const session = selectedSessionRef.current;
    if (!session) return;
    setReplyStopping(true);
    try {
      const res = await fetch("/api/tmux/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as any);
        alert(`stop failed: ${body.error ?? res.statusText}`);
        return;
      }
      setTimeout(() => {
        queryClient.refetchQueries({ queryKey: ["tmux-transcript", session] });
        queryClient.refetchQueries({ queryKey: ["tmux-sessions"] });
      }, 500);
    } finally {
      setReplyStopping(false);
    }
  }, [queryClient]);

  // Type a single answer keystroke into the selected session's pane, then refresh
  // so the resulting turn (and busy dot) show up. Shared by the plan and question
  // cards — both answer a live TUI prompt by sending the option's digit, exactly
  // the key you'd press in the terminal.
  const sendToSession = useCallback(
    async (text: string) => {
      const session = selectedSessionRef.current;
      if (!session) return;
      const res = await fetch("/api/tmux/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session, text }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as any);
        alert(`answer failed: ${body.error ?? res.statusText}`);
        return;
      }
      setTimeout(() => {
        queryClient.refetchQueries({ queryKey: ["tmux-transcript", session] });
        queryClient.refetchQueries({ queryKey: ["tmux-sessions"] });
      }, 500);
    },
    [queryClient],
  );
  // Answer a live plan card — the ExitPlanMode prompt is keyed 1/2/3 like the TUI.
  // Only the last turn's card is wired to call this.
  const answerPlan = useCallback((choice: number) => sendToSession(String(choice)), [sendToSession]);
  // Answer a live AskUserQuestion option by sending its 1-based number into the
  // pane; the TUI selects that option and advances to the next question.
  const answerQuestion = useCallback(
    (_questionIndex: number, optionIndex: number) => sendToSession(String(optionIndex + 1)),
    [sendToSession],
  );

  // Answer a live multi-select AskUserQuestion from the pending-prompt checkboxes.
  // The server toggles the pane to match `selected`, verifies, then submits — so we
  // throw on failure to surface the message inline (the card falls back to the reply
  // box). On success, refresh once so the next question / busy dot shows up.
  const answerPendingMulti = useCallback(
    async (selected: number[]) => {
      const session = selectedSessionRef.current;
      if (!session) return;
      const res = await fetch("/api/tmux/answer-multi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session, selected }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as any);
        throw new Error(body.error ?? res.statusText);
      }
      setTimeout(() => {
        queryClient.refetchQueries({ queryKey: ["tmux-transcript", session] });
        queryClient.refetchQueries({ queryKey: ["tmux-sessions"] });
      }, 500);
    },
    [queryClient],
  );

  // Send a bare Enter into the pane — used by the pending-prompt confirm card to
  // clear claude's "Ready to submit your answers?" gate.
  const confirmPending = useCallback(async () => {
    const session = selectedSessionRef.current;
    if (!session) return;
    const res = await fetch("/api/tmux/key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session, key: "Enter" }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}) as any);
      alert(`submit failed: ${body.error ?? res.statusText}`);
      return;
    }
    setTimeout(() => {
      queryClient.refetchQueries({ queryKey: ["tmux-transcript", session] });
      queryClient.refetchQueries({ queryKey: ["tmux-sessions"] });
    }, 500);
  }, [queryClient]);

  // `x` — stage everything, then hand the commit off to a detached claude
  // session that writes the message itself (and pushes). Skips the `;` dialog
  // for when you'd rather claude author an informative commit from the diff.
  const commitWithClaude = useCallback(async (deploy = false) => {
    await runGit("stage");
    try {
      const res = await fetch(qd("/api/claude"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: deploy
            ? "Commit and push the staged changes with a clear, informative commit message, then deploy the changes."
            : "Commit and push the staged changes with a clear, informative commit message.",
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as any);
        alert(`launch failed: ${body.error ?? res.statusText}`);
        return;
      }
      const body = await res.json().catch(() => ({}) as any);
      if (body.queued) setQueuedNote(true);
      else setLaunchedSession(typeof body.session === "string" ? body.session : null);
      queryClient.refetchQueries({ queryKey: ["tmux-sessions"] });
    } catch (e) {
      alert(`launch failed: ${errMessage(e)}`);
    }
  }, [runGit, qd, queryClient]);

  // Refetch the current tab's data — the same thing `space` does, exposed to the
  // mobile Actions menu (where there's no keyboard). Resetting the list query
  // flashes its skeleton; the Tmux tab just refetches the list + open transcript.
  const refreshTab = useCallback(() => {
    if (tab === "tmux") {
      queryClient.refetchQueries({ queryKey: ["tmux-sessions"] });
      if (selectedSession)
        queryClient.refetchQueries({ queryKey: ["tmux-transcript", selectedSession] });
      return;
    }
    const listKey: string[] =
      tab === "commits"
        ? ["commits"]
        : tab === "prs"
          ? ["prs"]
          : tab === "changes"
            ? ["changes"]
            : ["manual"];
    queryClient.resetQueries({ queryKey: listKey });
    if (view.kind === "commit" || view.kind === "pr") {
      queryClient.resetQueries({ queryKey: diffKeyRef.current });
    }
  }, [tab, view, selectedSession, queryClient]);

  // Restart the diffshub server itself (the `dh` window on the bg tmux socket:
  // Ctrl-C, then re-run `dh`). The server bounces this to a detached tmux session,
  // so it answers ok *before* it dies — but the response can still race the death,
  // so a dropped request is treated as the restart working, not an error. The
  // server is down for ~1–2s; nudge a full refetch once it should be back (the
  // auto-refresh interval also reconnects on its own).
  const refreshServer = useCallback(
    async (opts?: { window?: string; command?: string }) => {
      try {
        const res = await fetch("/api/restart-server", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ window: opts?.window ?? "dh", command: opts?.command ?? "dh" }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}) as any);
          alert(`restart failed: ${body.error ?? res.statusText}`);
          return;
        }
      } catch {
        // The server may die before the response lands — that *is* the restart.
      }
      setTimeout(() => queryClient.invalidateQueries(), 2500);
    },
    [queryClient],
  );

  // Submit the Restart dialog: bounce the named window with the given command.
  // Both fields are required (a blank either side falls back to `dh` server-side,
  // but we don't want a stray Enter on an empty field to do anything surprising).
  const submitRestart = useCallback(() => {
    const window = restartWindow.trim();
    const command = restartCommand.trim();
    if (!window || !command) return;
    setRestartOpen(false);
    void refreshServer({ window, command });
  }, [restartWindow, restartCommand, refreshServer]);

  const selectTab = useCallback(
    (next: Tab) => {
      setTab(next);
      setFilter("");
      setContentFilter("");
      // Always reset the view to the tab's default so the center/right columns
      // never keep showing the previous tab's content (e.g. a commit diff bleeding
      // into the PRs tab). Commits/PRs reset to an empty "none" view and wait for a
      // selection — commits then auto-lands on the newest one (see effect below).
      // The per-tab queries fetch themselves via their `enabled` flag.
      const { view: nextView, param } = tabDefaults(next);
      setView(nextView);
      history.replaceState(null, "", navUrl(param));
    },
    [navUrl],
  );

  const selectTmux = useCallback(
    (session: string) => {
      setView({ kind: "tmux", session });
      history.replaceState(null, "", navUrl(`tmux=${encodeURIComponent(session)}`));
    },
    [navUrl],
  );

  // Kill a tmux session, then refresh the list and move the selection to a
  // neighbour so browsing-and-killing stays on the keyboard.
  const killSession = useCallback(
    async (name: string) => {
      const list = tmuxSessions ?? [];
      const idx = list.findIndex((s) => s.name === name);
      const next = list[idx + 1]?.name ?? list[idx - 1]?.name ?? "";
      try {
        const res = await fetch("/api/tmux/kill", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session: name }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}) as any);
          alert(`kill failed: ${body.error ?? res.statusText}`);
          return;
        }
      } catch (e) {
        alert(`kill failed: ${errMessage(e)}`);
        return;
      }
      saveDraft(replyDraftKey(name), ""); // removing the tab drops its saved draft
      if (selectedSessionRef.current === name) selectTmux(next);
      tmuxQuery.refetch();
    },
    [tmuxSessions, selectTmux, tmuxQuery],
  );

  // Drop a queued (offline) prompt before it launches, then refresh the list.
  const cancelQueued = useCallback(
    async (id: number) => {
      try {
        const res = await fetch("/api/queue/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}) as any);
          alert(`cancel failed: ${body.error ?? res.statusText}`);
          return;
        }
      } catch (e) {
        alert(`cancel failed: ${errMessage(e)}`);
        return;
      }
      tmuxQuery.refetch();
    },
    [tmuxQuery],
  );

  // On the Tmux tab, auto-select the first session once the list loads (or when
  // the selected session disappears, e.g. after a kill or a directory switch) so
  // the transcript pane always shows something from the directory in view. Works
  // off the directory-scoped list so we never land on a session from another dir.
  useEffect(() => {
    if (tab !== "tmux" || !dirScopedTmux) return;
    const exists = selectedSession && dirScopedTmux.some((s) => s.name === selectedSession);
    if (!exists) selectTmux(dirScopedTmux.length ? dirScopedTmux[0].name : "");
  }, [tab, dirScopedTmux, selectedSession, selectTmux]);

  // Load the selected session's saved reply draft (each tab keeps its own
  // half-typed reply in localStorage), or clear when nothing is selected.
  useEffect(() => {
    setReplyText(selectedSession ? loadDraft(replyDraftKey(selectedSession)) : "");
    replyHistoryIndexRef.current = null; // each tab browses its own history afresh
  }, [selectedSession]);

  const selectCommit = useCallback(
    (sha: string, repo?: string) => {
      setView({ kind: "commit", sha, repo });
      history.replaceState(null, "", navUrl(`sha=${sha}`, repo && `repo=${encodeURIComponent(repo)}`));
    },
    [navUrl],
  );

  const selectPr = useCallback(
    (number: number, repo?: string) => {
      setView({ kind: "pr", number, repo });
      history.replaceState(
        null,
        "",
        navUrl(`pr=${number}`, repo && `repo=${encodeURIComponent(repo)}`),
      );
    },
    [navUrl],
  );

  const selectManual = useCallback(
    (name: string) => {
      setView({ kind: "manual", name });
      history.replaceState(null, "", navUrl(`manual=${encodeURIComponent(name)}`));
    },
    [navUrl],
  );

  // Switch the active directory: restore the tab you were last on (defaults to
  // Tmux) rather than forcing one, and reset the URL to match.
  const selectDir = useCallback(
    (id: number | null) => {
      // Remember where we came from so "go to last directory" can toggle back.
      const from = activeDirRef.current;
      if (from !== id) setPrevDir(from);
      setActiveDir(id);
      activeDirRef.current = id;
      const nextTab = loadLastTab();
      const { view: nextView, param } = tabDefaults(nextTab);
      setTab(nextTab);
      setView(nextView);
      setFilter("");
      setContentFilter("");
      setDirMenuOpen(false);
      history.replaceState(null, "", navUrl(param));
    },
    [navUrl],
  );

  // Toggle back to the directory you were last viewing (recorded by selectDir).
  // Before you've switched once there's no "last" dir, so fall back to flipping
  // between the first two registered dirs — from index 0 go to 1, otherwise go
  // to 0 — mirroring the tmux "next, else previous" switch behavior.
  const goToLastDir = useCallback(() => {
    if (prevDir !== undefined) {
      selectDir(prevDir);
      return;
    }
    if (dirs.length < 2) return;
    const curId = activeDir ?? dirsQuery.data?.defaultDirId ?? null;
    const curIdx = dirs.findIndex((d) => d.id === curId);
    selectDir((curIdx === 0 ? dirs[1] : dirs[0]).id);
  }, [prevDir, selectDir, dirs, activeDir, dirsQuery.data]);

  // ---- Directory settings (add / edit / delete) ----
  const [dirForm, setDirForm] = useState<{
    id: number | null;
    name: string;
    path: string;
    repos: string;
  }>({ id: null, name: "", path: "", repos: "" });
  const [dirError, setDirError] = useState("");
  const [dirSaving, setDirSaving] = useState(false);

  const openDirForm = useCallback((d?: DirEntry) => {
    setDirError("");
    setDirForm(
      d
        ? { id: d.id, name: d.name, path: d.path, repos: d.repos.join(", ") }
        : { id: null, name: "", path: "", repos: "" },
    );
  }, []);

  const saveDir = useCallback(async () => {
    const path = dirForm.path.trim();
    if (!path) return;
    const isEdit = dirForm.id != null;
    setDirSaving(true);
    setDirError("");
    try {
      const res = await fetch(isEdit ? `/api/dirs/${dirForm.id}` : "/api/dirs", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, name: dirForm.name.trim() || undefined, repos: dirForm.repos }),
      });
      const body = await res.json().catch(() => ({}) as any);
      if (!res.ok) {
        setDirError(body.error ?? res.statusText);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["dirs"] });
      if (!isEdit && typeof body.id === "number") {
        // Jump straight to the directory you just added.
        selectDir(body.id);
        setDirsOpen(false);
      } else {
        // Edited an existing dir — refresh everything for the active one.
        queryClient.invalidateQueries();
        setDirForm({ id: null, name: "", path: "", repos: "" });
      }
    } finally {
      setDirSaving(false);
    }
  }, [dirForm, queryClient, selectDir]);

  const deleteDir = useCallback(
    async (d: DirEntry) => {
      if (!confirm(`Remove "${d.name}" from diffshub? (the directory itself is left untouched)`)) {
        return;
      }
      setDirError("");
      const res = await fetch(`/api/dirs/${d.id}`, { method: "DELETE" });
      const body = await res.json().catch(() => ({}) as any);
      if (!res.ok) {
        setDirError(body.error ?? res.statusText);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["dirs"] });
      if (dirForm.id === d.id) setDirForm({ id: null, name: "", path: "", repos: "" });
      if (activeDirRef.current === d.id) selectDir(null); // fall back to the default
    },
    [queryClient, selectDir, dirForm.id],
  );

  // Close the directory dropdown on an outside click.
  useEffect(() => {
    if (!dirMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest?.(".dir-dropdown")) setDirMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [dirMenuOpen]);

  // Close the mobile Actions menu on an outside click.
  useEffect(() => {
    if (!actionsOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest?.(".topbar-actions")) setActionsOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [actionsOpen]);

  // When the dropdown opens, focus its filter box and reset the highlight; when
  // it closes, drop the filter so it reopens clean next time.
  useEffect(() => {
    if (dirMenuOpen) {
      setDirActive(0);
      requestAnimationFrame(() => dirSearchEl.current?.focus());
    } else {
      setDirFilter("");
    }
  }, [dirMenuOpen]);

  // Keep the keyboard-highlighted directory scrolled into view as you arrow
  // through a long, filtered list.
  useEffect(() => {
    if (dirMenuOpen) document.getElementById(`diropt-${dirActive}`)?.scrollIntoView({ block: "nearest" });
  }, [dirActive, dirMenuOpen]);

  // Directories shown in the dropdown, narrowed by the combobox filter (matched
  // against both the display name and the path).
  const visibleDirs = useMemo(() => {
    const f = dirFilter.trim().toLowerCase();
    if (!f) return dirs;
    return dirs.filter(
      (d) => d.name.toLowerCase().includes(f) || d.path.toLowerCase().includes(f),
    );
  }, [dirs, dirFilter]);

  // ---- Sections rendered in the center column ----
  const sections = useMemo<Section[]>(() => {
    // Namespace tree paths by worktree segment so the same path in different
    // worktrees/repos (e.g. app/src/x and web/src/x) doesn't collide in the
    // (path-keyed) file tree.
    const tpath = (segment: string, name: string) =>
      segment ? `${segment.replace(/ · /g, "/")}/${name}` : name;

    if (view.kind === "commit" || view.kind === "pr") {
      if (!diffText) return [];
      const cacheKey = view.kind === "commit" ? view.sha : `pr-${view.number}`;
      const files = parseSectionFiles(diffText, cacheKey);
      return [
        {
          label: null,
          files: files.map(({ file: f, rawDiff }) => ({
            key: `main:${f.name}`,
            path: f.name,
            treePath: f.name,
            repo: view.repo,
            fileDiff: f,
            rawDiff,
            actions: [],
          })),
        },
      ];
    }
    if (view.kind === "changes" && changes) {
      const out: Section[] = [];
      for (const rc of changes) {
        const idns = rc.segment || rc.repo; // unique per worktree change-source
        if (rc.staged.length) {
          const files = parseSectionFiles(rc.stagedDiff);
          out.push({
            label: "Staged",
            segment: rc.segment,
            repo: rc.repo,
            dir: rc.dir,
            files: files.map(({ file: f, rawDiff }) => ({
              key: `staged:${idns}:${f.name}`,
              path: f.name,
              treePath: tpath(rc.segment, f.name),
              repo: rc.repo,
              worktree: rc.dir,
              fileDiff: f,
              rawDiff,
              actions: ["unstage", "stash"],
            })),
          });
        }
        const unstagedFiles: SectionFile[] = parseSectionFiles(rc.unstagedDiff).map(
          ({ file: f, rawDiff }) => ({
            key: `unstaged:${idns}:${f.name}`,
            path: f.name,
            treePath: tpath(rc.segment, f.name),
            repo: rc.repo,
            worktree: rc.dir,
            fileDiff: f,
            rawDiff,
            actions: ["stage", "stash"] as GitAction[],
          }),
        );
        for (const u of rc.untracked) {
          unstagedFiles.push({
            key: `untracked:${idns}:${u.path}`,
            path: u.path,
            treePath: tpath(rc.segment, u.path),
            repo: rc.repo,
            worktree: rc.dir,
            untracked: u,
            actions: ["stage", "stash"],
          });
        }
        if (unstagedFiles.length) {
          out.push({
            label: "Unstaged",
            segment: rc.segment,
            repo: rc.repo,
            dir: rc.dir,
            files: unstagedFiles,
          });
        }
      }
      return out;
    }
    if (view.kind === "manual" && manualPatches) {
      const patch = manualPatches.find((p) => p.name === view.name);
      if (!patch) return [];
      // Include the content length in the cache key so editing a patch (Delete)
      // busts the render cache instead of showing the pre-edit diff.
      const files = parseSectionFiles(
        patch.contents,
        `manual-${patch.name}-${patch.contents.length}`,
      );
      return [
        {
          label: null,
          files: files.map(({ file: f, rawDiff }) => ({
            key: `manual:${f.name}`,
            path: f.name,
            treePath: f.name,
            fileDiff: f,
            rawDiff,
            actions: [],
          })),
        },
      ];
    }
    return [];
  }, [view, diffText, changes, manualPatches, workspace]);

  // ---- Highlighted-line action bar (Delete / Open in $EDITOR) ----
  const selFile = useMemo(
    () =>
      selection
        ? (sections.flatMap((s) => s.files).find((f) => f.key === selection.fileKey) ?? null)
        : null,
    [selection, sections],
  );
  // Only added (new-side) lines can be deleted, and only where there's a local
  // file to edit: the working tree (Changes) or the ./diffs patch (Manual).
  const selSide = selection?.range.side ?? "additions";
  const selLo = selection ? Math.min(selection.range.start, selection.range.end) : 0;
  const selHi = selection ? Math.max(selection.range.start, selection.range.end) : 0;
  const canDelete =
    !!selFile && (view.kind === "manual" || view.kind === "changes") && selSide === "additions";

  // A Claude Code @-file reference (cwd-relative path + line range) for the
  // active line selection, e.g. `@cli/client.tsx#172-175`. Seeded into the
  // New-session prompt when it's opened with `'` while lines are highlighted.
  const claudeRef = useMemo(() => {
    if (!selection || !selFile) return "";
    const abs = selFile.worktree ? `${selFile.worktree}/${selFile.path}` : selFile.path;
    const rel =
      meta?.cwd && abs.startsWith(`${meta.cwd}/`) ? abs.slice(meta.cwd.length + 1) : selFile.path;
    return `@${rel}#${selHi > selLo ? `${selLo}-${selHi}` : selLo}`;
  }, [selection, selFile, meta, selLo, selHi]);
  const claudeRefRef = useRef(claudeRef);
  claudeRefRef.current = claudeRef;

  const openSelection = useCallback(() => {
    if (!selFile || !selection) return;
    openInEditor(
      selFile.path,
      Math.min(selection.range.start, selection.range.end),
      selFile.repo,
      selFile.worktree,
    );
    setSelection(null);
  }, [selFile, selection, openInEditor]);

  const deleteSelection = useCallback(async () => {
    if (!selFile || !selection) return;
    const lo = Math.min(selection.range.start, selection.range.end);
    const hi = Math.max(selection.range.start, selection.range.end);
    const side = selection.range.side ?? "additions";
    let payload: Record<string, unknown> | null = null;
    if (view.kind === "manual") {
      payload = { source: "patch", name: view.name, path: selFile.path, start: lo, end: hi, side };
    } else if (view.kind === "changes") {
      payload = {
        source: "working",
        path: selFile.path,
        repo: selFile.repo,
        worktree: selFile.worktree,
        start: lo,
        end: hi,
        side,
      };
    }
    if (!payload) return;
    try {
      const res = await fetch(qd("/api/delete-lines"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as any);
        alert(`Delete failed: ${body.error ?? res.statusText}`);
        return;
      }
    } catch (err) {
      alert(`Delete failed: ${errMessage(err)}`);
      return;
    }
    setSelection(null);
    queryClient.invalidateQueries({ queryKey: [view.kind === "manual" ? "manual" : "changes"] });
  }, [selFile, selection, view, queryClient, qd]);

  // Refs so the global keydown handler (registered once) can fire the latest
  // delete on Backspace while lines are highlighted, mirroring the sel-bar's
  // Delete button (which is gated on canDelete).
  const deleteSelectionRef = useRef(deleteSelection);
  deleteSelectionRef.current = deleteSelection;
  const canDeleteRef = useRef(canDelete);
  canDeleteRef.current = canDelete;

  // ---- Actively viewing file: the file under the sticky header line ----
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const orderedKeys = useMemo(() => sections.flatMap((s) => s.files.map((f) => f.key)), [sections]);
  useEffect(() => {
    const main = mainEl.current;
    if (!main) return;
    let raf = 0;
    const compute = () => {
      raf = 0;
      // First file whose bottom edge is still below the sticky-header line
      const topEdge = main.getBoundingClientRect().top + 60;
      let next: string | null = null;
      for (const key of orderedKeys) {
        const el = fileEls.current.get(key);
        if (el && el.getBoundingClientRect().bottom > topEdge) {
          next = key;
          break;
        }
      }
      setActiveKey(next ?? orderedKeys[orderedKeys.length - 1] ?? null);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(compute);
    };
    compute();
    main.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      main.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [orderedKeys]);

  // Path of the actively-viewed diff — drives the highlight in the file tree.
  const activePath = useMemo(() => {
    if (!activeKey) return null;
    for (const s of sections) {
      const hit = s.files.find((f) => f.key === activeKey);
      if (hit) return hit.treePath;
    }
    return null;
  }, [activeKey, sections]);
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;

  // ---- Per-file collapse, toggled with `c` on the actively viewed file ----
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(new Set());
  useEffect(() => {
    setCollapsedKeys(new Set());
    setSelection(null);
    // Scroll the main column back to the top when the viewed commit/PR changes,
    // or when landing on the Home dashboard.
    if (view.kind === "commit" || view.kind === "pr" || view.kind === "home")
      mainEl.current?.scrollTo({ top: 0 });
  }, [view]);
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;
  // Timestamp of the last bare `g` press, so a second `g` within the window
  // completes the `gg` (jump-to-top) sequence.
  const lastGRef = useRef(0);
  const toggleCollapsed = useCallback(() => {
    const key = activeKeyRef.current;
    if (!key) return;
    setCollapsedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    // Keep the toggled file's header in view once layout settles
    setTimeout(() => fileEls.current.get(key)?.scrollIntoView({ block: "nearest" }), 50);
  }, []);

  // ---- Per-worktree collapse (Changes sidebar) ----
  // Click a worktree header to fold/unfold its staged/unstaged groups. Keyed by
  // the worktree segment, so the state survives auto-refresh refetches.
  const [collapsedWorktrees, setCollapsedWorktrees] = useState<Set<string>>(new Set());
  const toggleWorktree = useCallback((segment: string) => {
    setCollapsedWorktrees((prev) => {
      const next = new Set(prev);
      if (next.has(segment)) next.delete(segment);
      else next.add(segment);
      return next;
    });
  }, []);

  // ---- File tree (right sidebar) ----
  const onTreeSelect = useRef<(paths: readonly string[]) => void>(() => {});
  onTreeSelect.current = (paths) => {
    if (!paths[0]) return;
    // Ignore the selection we set ourselves to mirror the active diff — only
    // react to the user actually picking a different file in the tree.
    if (paths[0] === activePathRef.current) return;
    for (const section of sections) {
      const hit = section.files.find((f) => f.treePath === paths[0]);
      if (hit) {
        fileEls.current.get(hit.key)?.scrollIntoView({ block: "start" });
        return;
      }
    }
  };
  const { model } = useFileTree({
    paths: [],
    initialExpansion: "open",
    flattenEmptyDirectories: true,
    search: true,
    onSelectionChange: (paths) => onTreeSelect.current(paths),
  });

  const treeStatusByPath = useMemo(() => {
    const statusByPath = new Map<string, GitStatusEntry["status"]>();
    for (const section of sections) {
      for (const f of section.files) {
        const status = f.untracked
          ? "untracked"
          : f.fileDiff
            ? (STATUS_FOR_CHANGE[f.fileDiff.type] ?? "modified")
            : "modified";
        statusByPath.set(f.treePath, status);
      }
    }
    return statusByPath;
  }, [sections]);
  const treeFileCount = treeStatusByPath.size;

  useEffect(() => {
    model.resetPaths([...treeStatusByPath.keys()]);
    model.setGitStatus([...treeStatusByPath].map(([path, status]) => ({ path, status })));
    // resetPaths clears selection — re-apply the active diff's highlight.
    if (activePathRef.current) model.getItem(activePathRef.current)?.select();
  }, [treeStatusByPath, model]);

  // Mirror the actively-viewed diff onto the tree's selection as you scroll.
  useEffect(() => {
    if (!activePath) return;
    const selected = model.getSelectedPaths();
    if (selected.length === 1 && selected[0] === activePath) return;
    for (const p of selected) if (p !== activePath) model.getItem(p)?.deselect();
    model.getItem(activePath)?.select();
  }, [activePath, model]);

  // ---- Sidebar lists ----
  const q = filter.toLowerCase();
  const visibleCommits = useMemo(
    () =>
      q
        ? commits.filter(
            (c) =>
              c.message.toLowerCase().includes(q) ||
              c.sha.startsWith(q) ||
              c.author.toLowerCase().includes(q),
          )
        : commits,
    [commits, q],
  );
  const visiblePrs = useMemo(
    () =>
      q && prs
        ? prs.filter((p) => p.title.toLowerCase().includes(q) || String(p.number).includes(q))
        : prs,
    [prs, q],
  );
  const visibleManual = useMemo(
    () =>
      q && manualPatches
        ? manualPatches.filter((p) => p.name.toLowerCase().includes(q))
        : manualPatches,
    [manualPatches, q],
  );
  const cq = contentFilter.trim().toLowerCase();
  const visibleTmux = useMemo(() => {
    if (!dirScopedTmux) return dirScopedTmux;
    let list = dirScopedTmux;
    if (q)
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.cwd.toLowerCase().includes(q) ||
          s.task.toLowerCase().includes(q),
      );
    // Content search only matches sessions whose transcript we've already indexed;
    // contentVersion is in the deps so a freshly-opened/pruned chat re-filters live.
    if (cq)
      list = list.filter((s) => contentIndex.current.get(s.sessionId || s.name)?.includes(cq));
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirScopedTmux, q, cq, contentVersion]);

  // Step to the previous (-1) / next (+1) session in the visible, dir-scoped list,
  // wrapping around — the same traversal as the ↑/↓ keys, surfaced as the mobile
  // top-bar chevrons so you can flip through chats without opening the sidebar.
  const cycleSession = useCallback(
    (dir: 1 | -1) => {
      const list = visibleTmux;
      if (!list?.length) return;
      const idx = list.findIndex((s) => s.name === selectedSessionRef.current);
      const next = (idx + dir + list.length) % list.length;
      selectTmux(list[next].name);
      document
        .getElementById(`row-tmux-${list[next].name}`)
        ?.scrollIntoView({ block: "nearest" });
    },
    [visibleTmux, selectTmux],
  );

  // A session is "unread" once it's idle (finished its turn — not busy, not
  // blocked on a prompt) with transcript output newer than you last saw. Drives
  // the sidebar dots and the "next unread" jump. Waiting rows are excluded: they
  // carry their own badge and haven't finished.
  const isUnread = useCallback(
    (s: TmuxSession) =>
      !s.busy && !s.waiting && s.mtime > 0 && s.mtime > (seenMtimes[s.sessionId || s.name] ?? 0),
    [seenMtimes],
  );
  // The raw "new output since you last acknowledged it" test, independent of state.
  // isUnread narrows this to *idle* sessions (the Done bucket); the Home dashboard
  // also wants it for *waiting* sessions (a Needs-action prompt you haven't looked
  // at yet), which isUnread excludes — so the mark-read affordance can cover both.
  const isUnseen = useCallback(
    (s: TmuxSession) => s.mtime > 0 && s.mtime > (seenMtimes[s.sessionId || s.name] ?? 0),
    [seenMtimes],
  );
  // Is there an unread session to jump to other than the one already open? Gates
  // the "next unread" button's disabled state.
  const hasNextUnread = useMemo(
    () => (visibleTmux ?? []).some((s) => s.name !== selectedSession && isUnread(s)),
    [visibleTmux, selectedSession, isUnread],
  );
  // Jump to the next unread session after the current one in the visible list,
  // wrapping around — same traversal as cycleSession, but skipping read rows.
  const goToNextUnread = useCallback(() => {
    const list = visibleTmux;
    if (!list?.length) return;
    const start = list.findIndex((s) => s.name === selectedSessionRef.current);
    for (let i = 1; i <= list.length; i++) {
      const s = list[(start + i + list.length) % list.length];
      if (s && isUnread(s)) {
        selectTmux(s.name);
        document.getElementById(`row-tmux-${s.name}`)?.scrollIntoView({ block: "nearest" });
        return;
      }
    }
  }, [visibleTmux, isUnread, selectTmux]);

  // ---- Home (session monitor) groups ----
  // Partition the visible, dir-scoped + filtered sessions by state for the Home
  // dashboard. isUnread already excludes busy + waiting, so every session lands in
  // exactly one of these buckets; queued (offline) prompts come from scopedQueued.
  const homeGroups = useMemo(() => {
    const list = visibleTmux ?? [];
    // Order each group by recency (most recently updated chat first) — a property
    // that only changes when a session actually does something, so the grid holds
    // still while you arrow around it. Read/unread doesn't enter the sort for the
    // passive states (In progress / Idle); only Needs-action floats the prompts you
    // haven't looked at yet above the ones you've already acknowledged. .filter()
    // returns fresh arrays, so the in-place .sort is safe.
    const byRecency = (a: TmuxSession, b: TmuxSession) => b.mtime - a.mtime;
    const unseenFirst = (a: TmuxSession, b: TmuxSession) => {
      const ua = isUnseen(a) ? 1 : 0;
      const ub = isUnseen(b) ? 1 : 0;
      return ua !== ub ? ub - ua : b.mtime - a.mtime;
    };
    return {
      inProgress: list.filter((s) => s.busy).sort(byRecency),
      needsAction: list.filter((s) => s.waiting && !s.busy).sort(unseenFirst),
      done: list.filter((s) => isUnread(s)).sort(byRecency),
      idle: list.filter((s) => !s.busy && !s.waiting && !isUnread(s)).sort(byRecency),
    };
  }, [visibleTmux, isUnread, isUnseen]);
  // Flat, display-ordered list of the dashboard's openable cards (queued prompts
  // aren't sessions, so they're left out). Seeds the first selection and gates the
  // arrow keys (no cards → nothing to do); the actual movement is geometric, read
  // off the rendered grid by homeGridTarget rather than from this flat order.
  const homeNav = useMemo(
    () =>
      [
        ...homeGroups.inProgress,
        ...homeGroups.needsAction,
        ...homeGroups.done,
        ...homeGroups.idle,
      ].map((s) => s.name),
    [homeGroups],
  );
  // Open a Home card's chat in the side-panel (a docked right sidebar on desktop,
  // a full-screen sheet on mobile) without leaving the dashboard. selectedSession
  // resolves to homeChat on the Home tab, so the existing transcript query + reply
  // box light up for it automatically.
  const openHomeChat = useCallback((name: string) => {
    setHomeSel(name);
    setHomeChat(name);
  }, []);
  const closeHomeChat = useCallback(() => setHomeChat(null), []);
  // Acknowledge a card without opening it: pin its seen-mtime to the latest so it
  // stops reading as unread. Only meaningful for the attention states — a Done card
  // (idle + new output) drops to Idle, a Needs-action card stays put but calms. A
  // no-op on busy sessions and on anything already caught up, so the button/`r` key
  // can fire freely. This is the *only* path that clears unread on the dashboard
  // (navigation never does), which is what makes the grid hold still as you move.
  const markHomeRead = useCallback(
    (name: string) => {
      const s = (visibleTmux ?? []).find((x) => x.name === name);
      if (!s || s.busy || !s.mtime) return;
      const key = s.sessionId || s.name;
      if ((seenMtimes[key] ?? 0) >= s.mtime) return;
      setSeenMtimes((prev) => ({ ...prev, [key]: s.mtime }));
    },
    [visibleTmux, seenMtimes],
  );
  // Flip the focused card between Done and Idle, the two faces of a finished
  // session (Done = idle + output you haven't acknowledged, Idle = idle + caught
  // up). A read card is marked *unread* by rewinding its seen-mtime to just behind
  // the transcript's latest (mtime - 1ms), so isUnread flips true and it jumps back
  // to Done; an unread card is marked read (seen = mtime) and drops to Idle. A no-op
  // on busy sessions — you can't "finish" one that's still working — and on cards
  // with no transcript yet. The Space-key counterpart to markHomeRead's one-way `r`.
  const toggleHomeRead = useCallback(
    (name: string) => {
      const s = (visibleTmux ?? []).find((x) => x.name === name);
      if (!s || s.busy || !s.mtime) return;
      const key = s.sessionId || s.name;
      const seen = seenMtimes[key] ?? 0;
      const next = seen >= s.mtime ? s.mtime - 1 : s.mtime; // read → unread, else read
      setSeenMtimes((prev) => ({ ...prev, [key]: next }));
    },
    [visibleTmux, seenMtimes],
  );
  // Kill a card's session from the dashboard, closing the panel first if it was
  // showing the one being killed (otherwise it'd briefly read a dead transcript).
  const deleteHomeCard = useCallback(
    (name: string) => {
      setHomeChat((c) => (c === name ? null : c));
      void killSession(name);
    },
    [killSession],
  );
  // Drop the Home selection / open chat when its session disappears — killed, or
  // gone from view after a directory switch or filter change.
  useEffect(() => {
    if (tab !== "home" || !dirScopedTmux) return;
    const names = new Set(dirScopedTmux.map((s) => s.name));
    if (homeSel && !names.has(homeSel)) setHomeSel(null);
    if (homeChat && !names.has(homeChat)) setHomeChat(null);
  }, [tab, dirScopedTmux, homeSel, homeChat]);
  // The HTML preview belongs to the open chat — tear it down whenever the chat
  // panel itself closes (✕, Esc, or the session being killed / scrolled away).
  useEffect(() => {
    if (!homeChat) setHtmlView(null);
  }, [homeChat]);
  // `/` on a focused card opens its sheet and wants the composer focused; the
  // textarea only mounts once the panel renders, so finish the focus here (effects
  // run after commit, by which point the ref is live).
  useEffect(() => {
    if (homeChat && focusReplyOnOpenRef.current) {
      focusReplyOnOpenRef.current = false;
      replyTextareaRef.current?.focus();
    }
  }, [homeChat]);

  // Mirror the open Home chat into the URL (?home=<session>) so a reload — or a
  // push-notification tap — reopens the same chat, and closing it clears the
  // param. Only drives the URL while the Home tab is active; the other tabs own
  // the URL through their own select* handlers, so we leave it alone there.
  useEffect(() => {
    if (tab !== "home") return;
    history.replaceState(
      null,
      "",
      navUrl(homeChat ? `home=${encodeURIComponent(homeChat)}` : ""),
    );
  }, [tab, homeChat, navUrl]);

  // Kill every session currently listed on the Tmux tab (the dir-scoped, filtered
  // set the user is looking at — not every claude session on the box). Reuses the
  // single-kill endpoint per session, then refreshes; the auto-select effect picks
  // a survivor (or clears the pane). Driven by the `_` confirmation dialog.
  const killAllSessions = useCallback(async () => {
    const list = visibleTmux ?? [];
    if (!list.length) {
      setKillAllOpen(false);
      return;
    }
    setKillingAll(true);
    try {
      await Promise.all(
        list.map((s) =>
          fetch("/api/tmux/kill", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session: s.name }),
          }),
        ),
      );
      for (const s of list) saveDraft(replyDraftKey(s.name), ""); // dropped tabs lose their drafts
    } catch (e) {
      alert(`kill failed: ${errMessage(e)}`);
    } finally {
      setKillingAll(false);
      setKillAllOpen(false);
      tmuxQuery.refetch();
    }
  }, [visibleTmux, tmuxQuery]);

  // Queued (offline) prompts scoped to the directory in view, then narrowed by the
  // sidebar filter against the prompt text — same shape as visibleTmux above.
  const visibleQueued = useMemo(() => {
    if (!queuedSessions) return null;
    const root = meta?.path;
    let list = root
      ? queuedSessions.filter((x) => x.cwd === root || x.cwd.startsWith(`${root}/`))
      : queuedSessions;
    if (q) list = list.filter((x) => x.prompt.toLowerCase().includes(q));
    return list;
  }, [queuedSessions, meta?.path, q]);
  // File count per patch for the sidebar (parsePatchFiles is cached by key).
  const manualFileCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of manualPatches ?? []) {
      try {
        counts.set(
          p.name,
          parsePatchFiles(p.contents, `manual-${p.name}-${p.contents.length}`).reduce(
            (n, x) => n + x.files.length,
            0,
          ),
        );
      } catch {
        counts.set(p.name, 0);
      }
    }
    return counts;
  }, [manualPatches]);

  const activeCommit =
    view.kind === "commit"
      ? commits.find((c) => c.sha === view.sha && (view.repo === undefined || c.repo === view.repo))
      : null;
  const activePr =
    view.kind === "pr"
      ? prs?.find(
          (p) => p.number === view.number && (view.repo === undefined || p.repo === view.repo),
        )
      : null;
  const changeCount = changes
    ? changes.reduce((n, rc) => n + rc.staged.length + rc.unstaged.length + rc.untracked.length, 0)
    : null;
  // Worktrees with something staged — what the commit dialog will actually commit.
  const stagedWorktrees = (changes ?? [])
    .filter((rc) => rc.staged.length)
    .map((rc) => rc.segment || rc.repo || "working tree");

  // ---- Keyboard navigation (agents-cli style) ----
  const keyCtx = useRef({
    tab,
    view,
    visibleCommits,
    visiblePrs,
    visibleManual,
    visibleTmux,
    selectedTmux: selectedSession,
    selection,
    orderedKeys,
    sections,
    restartOpen,
    killAllOpen,
    commitOpen,
    claudeOpen,
    usageOpen,
    dirsOpen,
    dirMenuOpen,
    fileToken,
    changes,
    dirs,
    homeNav,
    homeSel,
    homeChatOpen: !!homeChat,
    htmlViewOpen: !!htmlView,
    shareOpen,
  });
  keyCtx.current = {
    tab,
    view,
    visibleCommits,
    visiblePrs,
    visibleManual,
    visibleTmux,
    selectedTmux: selectedSession,
    selection,
    orderedKeys,
    sections,
    restartOpen,
    killAllOpen,
    commitOpen,
    claudeOpen,
    usageOpen,
    dirsOpen,
    dirMenuOpen,
    fileToken,
    changes,
    dirs,
    homeNav,
    homeSel,
    homeChatOpen: !!homeChat,
    htmlViewOpen: !!htmlView,
    shareOpen,
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘↑ / ⌘↓ on the Home dashboard fling the open chat sheet to its top / bottom
      // — the one bare-modifier shortcut we claim, so it's handled before the
      // ⌘/Ctrl bail-out below. Only when a sheet is actually open (nothing else to
      // scroll); ⌘← / ⌘→ stay with the browser for history navigation.
      if (
        (e.metaKey || e.ctrlKey) &&
        (e.key === "ArrowUp" || e.key === "ArrowDown") &&
        keyCtx.current.tab === "home" &&
        keyCtx.current.homeChatOpen
      ) {
        e.preventDefault();
        if (e.key === "ArrowUp") jumpToTop();
        else jumpToBottom();
        return;
      }
      // On the Home dashboard, Ctrl-d/u/j/k scroll the open chat sheet — Vimium's
      // d/u (half-page) and j/k (line) keys, but aimed at the sheet instead of the
      // document so you can skim a long transcript while focus stays on the card
      // grid. Like the ⌘↑/⌘↓ fling above, it's handled before the ⌘/Ctrl bail-out.
      // We leave them to the browser while typing in the composer, where Ctrl-d/u/k
      // are the Emacs delete-char / delete-to-start / kill-line edits.
      if (
        e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        keyCtx.current.tab === "home" &&
        keyCtx.current.homeChatOpen &&
        (e.key === "d" || e.key === "u" || e.key === "j" || e.key === "k")
      ) {
        const el = (e.composedPath()[0] ?? e.target) as HTMLElement;
        const typing =
          el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement ||
          el.isContentEditable;
        const sheet = chatScroll();
        if (!typing && sheet) {
          e.preventDefault();
          const half = sheet.clientHeight / 2;
          const top =
            e.key === "j" ? 64 : e.key === "k" ? -64 : e.key === "d" ? half : -half;
          sheet.scrollBy({ top });
          return;
        }
      }
      // Every other shortcut below is a bare keypress — none use ⌘/Ctrl. So when a
      // meta or ctrl modifier is held, the event belongs to the browser/OS (⌘N new
      // window, ⌘T, ⌘L, ⌘A, ⌘D…); bail so we never shadow the native shortcut.
      if (e.metaKey || e.ctrlKey) return;
      const { tab, view, visibleCommits, visiblePrs, visibleManual, visibleTmux, selectedTmux } =
        keyCtx.current;
      const target = (e.composedPath()[0] ?? e.target) as HTMLElement;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable;
      // Esc-to-close for every dialog/dropdown lives in the capture-phase
      // onEscClose handler (registered below) so it fires before modal inputs
      // can swallow Esc via e.stopPropagation() — one source of truth.
      if (e.key === "/" && !typing) {
        e.preventDefault();
        // On Home, `/` dives into the focused card's chat composer — opening its
        // sheet first if it isn't already (the focus then lands once the textarea
        // mounts, via focusReplyOnOpenRef). In an open Tmux chat it jumps to the
        // reply composer; otherwise it focuses the sidebar filter.
        if (tab === "home" && keyCtx.current.homeSel) {
          if (keyCtx.current.homeChatOpen && replyTextareaRef.current) {
            replyTextareaRef.current.focus();
          } else {
            focusReplyOnOpenRef.current = true;
            setHomeChat(keyCtx.current.homeSel);
          }
        } else if (tab === "tmux" && selectedTmux && replyTextareaRef.current) {
          replyTextareaRef.current.focus();
        } else {
          searchEl.current?.focus();
        }
        return;
      }
      if (e.key === "Escape" && typing) {
        (target as HTMLInputElement).blur();
        return;
      }
      // On the Home dashboard, ArrowDown from the filter box drops focus into the
      // card grid and points at the first card, so you can keep arrowing through
      // them straight after typing a filter (without it, `typing` swallows it).
      if (
        tab === "home" &&
        e.key === "ArrowDown" &&
        target === searchEl.current &&
        keyCtx.current.homeNav.length
      ) {
        e.preventDefault();
        searchEl.current?.blur();
        const name = keyCtx.current.homeNav[0];
        setHomeSel(name);
        if (keyCtx.current.homeChatOpen) setHomeChat(name);
        document.getElementById(`row-tmux-${name}`)?.scrollIntoView({ block: "nearest" });
        return;
      }
      if (typing) return;
      // On the Home dashboard, Esc closes the open chat side-panel. (Esc inside
      // the composer is handled by the textarea — it stops propagation — so this
      // only fires when focus is outside it.)
      if (e.key === "Escape" && tab === "home" && keyCtx.current.homeChatOpen) {
        e.preventDefault();
        setHomeChat(null);
        return;
      }
      // Escape dismisses the line-selection action bar.
      if (e.key === "Escape" && keyCtx.current.selection) {
        e.preventDefault();
        setSelection(null);
        return;
      }
      // Backspace deletes the highlighted lines — same as the sel-bar's Delete
      // button, so it only fires where deletion is allowed (canDelete).
      if (e.key === "Backspace" && keyCtx.current.selection) {
        e.preventDefault();
        if (canDeleteRef.current) void deleteSelectionRef.current();
        return;
      }
      // On the Home dashboard, Backspace kills the focused card's session — the
      // keyboard mirror of its ✕ button. Rather than dump you out, it advances to
      // the card that slides into the gap (the next in display order, or the
      // previous one if we killed the last card) and, if the chat sheet was open,
      // swaps it to that card instead of closing — so you can keep clearing through
      // the grid. Focus is on the grid here, not the composer; typing in the reply
      // box was already filtered out above.
      if (e.key === "Backspace" && tab === "home" && keyCtx.current.homeSel) {
        e.preventDefault();
        const sel = keyCtx.current.homeSel;
        const list = keyCtx.current.homeNav;
        const idx = list.indexOf(sel);
        const next = idx >= 0 ? (list[idx + 1] ?? list[idx - 1] ?? null) : null;
        setHomeSel(next);
        if (keyCtx.current.homeChatOpen) setHomeChat(next);
        if (next) document.getElementById(`row-tmux-${next}`)?.scrollIntoView({ block: "nearest" });
        void killSession(sel);
        return;
      }
      // Leave keys alone while focus is inside the file tree (it has its own nav)
      if (e.composedPath().some((n) => n instanceof HTMLElement && n.classList?.contains("tree"))) {
        return;
      }
      // `D` opens the directory dropdown and focuses its filter box, so you can
      // jump between directories without reaching for the mouse (the open effect
      // handles focusing the input).
      if (e.key === "D") {
        e.preventDefault();
        setDirMenuOpen(true);
        return;
      }
      // Home dashboard: arrow keys walk the card grid geometrically (left/right
      // step within a row, up/down jump to the nearest row above/below — which
      // crosses subsection boundaries and tracks your column; see homeGridTarget).
      // Enter opens the focused card's chat in the side-panel, and while the panel
      // is open arrowing live-swaps it to the new card. At a grid edge (or with no
      // cards) the arrows do nothing.
      if (tab === "home" && (e.key === "Enter" || e.key.startsWith("Arrow"))) {
        const list = keyCtx.current.homeNav;
        if (e.key === "Enter") {
          const sel = keyCtx.current.homeSel;
          if (sel) {
            e.preventDefault();
            setHomeSel(sel);
            setHomeChat(sel);
          }
          return;
        }
        if (list.length) {
          e.preventDefault();
          const name = homeGridTarget(keyCtx.current.homeSel, e.key);
          if (name) {
            setHomeSel(name);
            if (keyCtx.current.homeChatOpen) setHomeChat(name);
            document.getElementById(`row-tmux-${name}`)?.scrollIntoView({ block: "nearest" });
          }
          return;
        }
      }
      // Home dashboard: `r` marks the focused card read (same as its check button) —
      // the keyboard half of the "clear it and move on" loop. A no-op unless the
      // card is an unacknowledged attention card (Done / Needs-action), so it's safe
      // to mash; markHomeRead does the gating.
      if (tab === "home" && e.key === "r" && keyCtx.current.homeSel) {
        e.preventDefault();
        markHomeRead(keyCtx.current.homeSel);
        return;
      }
      // Tabs are switched with the number keys (1–6) below — the ←/→ keys are left
      // free for in-tab navigation (the Home card grid; otherwise unused).
      // 1–6 jump straight to a tab (plain, not ⌥ — that switches directories).
      if (!e.altKey && e.key >= "1" && e.key <= String(TAB_ORDER.length)) {
        e.preventDefault();
        selectTab(TAB_ORDER[Number(e.key) - 1]);
        return;
      }
      // `0`/`9` jump to the first/last session on the Tmux tab (the visible,
      // dir-scoped list), mirroring the ↑/↓ row navigation below.
      if ((e.key === "0" || e.key === "9") && tab === "tmux" && visibleTmux?.length) {
        e.preventDefault();
        const target = e.key === "9" ? visibleTmux[visibleTmux.length - 1] : visibleTmux[0];
        selectTmux(target.name);
        document.getElementById(`row-tmux-${target.name}`)?.scrollIntoView({ block: "nearest" });
        return;
      }
      // `_` (⇧-) asks to kill every session currently listed on the Tmux tab.
      // Destructive, so it routes through a confirmation dialog.
      if (e.key === "_" && tab === "tmux") {
        e.preventDefault();
        if (visibleTmux?.length) setKillAllOpen(true);
        return;
      }
      // Vimium-style scrolling of the diff column. We recreate j/k/d/u here so
      // they work even where Vimium is disabled and so they target the diff pane
      // rather than the document. (`v` is gone — it collided with Vimium's
      // visual mode; toggle auto-refresh from the switch in the sidebar.)
      const main = mainEl.current;
      if (main && (e.key === "j" || e.key === "k" || e.key === "d" || e.key === "u")) {
        e.preventDefault();
        const half = main.clientHeight / 2;
        const top = e.key === "j" ? 64 : e.key === "k" ? -64 : e.key === "d" ? half : -half;
        main.scrollBy({ top });
        return;
      }
      // `G` jumps to the bottom of the diff column, `gg` to the top (a second
      // `g` within 500ms of the first completes the sequence).
      if (main && e.key === "G") {
        e.preventDefault();
        lastGRef.current = 0;
        main.scrollTo({ top: main.scrollHeight });
        return;
      }
      if (main && e.key === "g") {
        e.preventDefault();
        const now = Date.now();
        if (now - lastGRef.current < 500) {
          lastGRef.current = 0;
          main.scrollTo({ top: 0 });
        } else {
          lastGRef.current = now;
        }
        return;
      }
      // `h`/`l` jump to the previous/next file in the diff (otherwise the active
      // file is driven by scroll position).
      if (e.key === "h" || e.key === "l") {
        e.preventDefault();
        const keys = keyCtx.current.orderedKeys;
        if (keys.length) {
          const idx = activeKeyRef.current ? keys.indexOf(activeKeyRef.current) : -1;
          const next =
            e.key === "l" ? Math.min(idx + 1, keys.length - 1) : Math.max(idx - 1, 0);
          fileEls.current.get(keys[next])?.scrollIntoView({ block: "start" });
        }
        return;
      }
      // `a` stages the actively-viewed file (Changes view only — it's the only
      // place a file carries a stage action).
      if (e.key === "a") {
        e.preventDefault();
        const cur = activeKeyRef.current;
        const file = cur
          ? keyCtx.current.sections.flatMap((s) => s.files).find((f) => f.key === cur)
          : null;
        if (file?.actions.includes("stage")) {
          runGit("stage", file.path, file.repo, file.worktree);
        }
        return;
      }
      // `A` stages everything if anything is still unstaged, otherwise (when
      // every change is already staged) unstages everything — a toggle over the
      // Stage all / Unstage all bulk buttons. Changes view only.
      if (e.key === "A") {
        e.preventDefault();
        if (tab !== "changes") return;
        const cs = keyCtx.current.changes ?? [];
        const unstaged = cs.reduce((n, rc) => n + rc.unstaged.length + rc.untracked.length, 0);
        const staged = cs.reduce((n, rc) => n + rc.staged.length, 0);
        if (unstaged > 0) runGit("stage");
        else if (staged > 0) runGit("unstage");
        return;
      }
      // On the Home dashboard, Space toggles the focused card between Done and Idle
      // (mark unread / mark read) — the bidirectional counterpart to `r`, which only
      // clears. Scoped to Home so Space keeps its global refresh meaning elsewhere.
      if (e.key === " " && tab === "home" && keyCtx.current.homeSel) {
        e.preventDefault();
        toggleHomeRead(keyCtx.current.homeSel);
        return;
      }
      // Space forces a refresh of the current tab: resetting the query drops its
      // cached data, so the sidebar skeleton + content spinner flash while it
      // refetches.
      if (e.key === " ") {
        e.preventDefault();
        // Tmux tab re-reads the session list + the open transcript from disk.
        if (tab === "tmux") {
          queryClient.refetchQueries({ queryKey: ["tmux-sessions"] });
          if (selectedTmux)
            queryClient.refetchQueries({ queryKey: ["tmux-transcript", selectedTmux] });
          return;
        }
        const listKey: string[] =
          tab === "commits"
            ? ["commits"]
            : tab === "prs"
              ? ["prs"]
              : tab === "changes"
                ? ["changes"]
                : ["manual"];
        queryClient.resetQueries({ queryKey: listKey });
        if (view.kind === "commit" || view.kind === "pr") {
          queryClient.resetQueries({ queryKey: diffKeyRef.current });
        }
        return;
      }
      if (e.key === ";") {
        if (view.kind === "changes") {
          e.preventDefault();
          setCommitOpen(true);
          return;
        }
        if (tab === "commits" && view.kind === "commit") {
          e.preventDefault();
          toggleReviewed(view.sha, view.repo);
          return;
        }
      }
      if (e.key === "c") {
        e.preventDefault();
        toggleCollapsed();
        return;
      }
      // `t` toggles light/dark.
      if (e.key === "t") {
        e.preventDefault();
        toggleTheme();
        return;
      }
      // `R` (Shift+R, so it's deliberate) opens the Restart dialog: which tmux
      // window to bounce and what command to relaunch it with (both default `dh`,
      // i.e. the diffshub server itself).
      if (e.key === "R") {
        e.preventDefault();
        setRestartOpen(true);
        return;
      }
      // `U` (Shift+U — lowercase `u` is half-page scroll up) opens the Claude
      // usage dialog: how much of the 5-hour and weekly windows is spent and when
      // each resets.
      if (e.key === "U") {
        e.preventDefault();
        setUsageOpen(true);
        return;
      }
      if (e.key === "'") {
        e.preventDefault();
        // If lines are highlighted, clear the prompt and replace it with their
        // @-file reference so the new session lands with just that context.
        const ref = claudeRefRef.current;
        if (ref) {
          setClaudePrompt(`${ref} `);
          claudeCaretRef.current = null; // land the caret after the inserted ref
        }
        setClaudeOpen(true);
        return;
      }
      // `x` kills the selected session on the Tmux tab; otherwise it stages
      // everything and launches a claude session to author the commit message and
      // push (Changes view only, and only when there's something to commit).
      // `X` (Shift+X) does the same commit+push, then also tells Claude to deploy.
      if (e.key === "x" || e.key === "X") {
        e.preventDefault();
        // On the Home dashboard, `x` closes the open card's chat panel (same as
        // Escape) — there's no commit/kill action mapped to `x` there.
        if (tab === "home") {
          if (e.key === "x" && keyCtx.current.homeChatOpen) setHomeChat(null);
          return;
        }
        if (tab === "tmux") {
          if (e.key === "x" && selectedTmux) void killSession(selectedTmux);
          return;
        }
        const dirty = (keyCtx.current.changes ?? []).some(
          (rc) => rc.staged.length || rc.unstaged.length || rc.untracked.length,
        );
        if (keyCtx.current.view.kind === "changes" && dirty)
          void commitWithClaude(e.key === "X");
        return;
      }
      const down = e.key === "ArrowDown";
      const up = e.key === "ArrowUp";
      if (!down && !up) return;
      if (tab === "commits" && visibleCommits.length) {
        e.preventDefault();
        const idx =
          view.kind === "commit" ? visibleCommits.findIndex((c) => c.sha === view.sha) : -1;
        const next = down
          ? idx + 1 >= visibleCommits.length
            ? 0
            : idx + 1
          : idx <= 0
            ? visibleCommits.length - 1
            : idx - 1;
        selectCommit(visibleCommits[next].sha, visibleCommits[next].repo);
        document
          .getElementById(`row-commit-${visibleCommits[next].sha}`)
          ?.scrollIntoView({ block: "nearest" });
      } else if (tab === "prs" && visiblePrs?.length) {
        e.preventDefault();
        const idx =
          view.kind === "pr"
            ? visiblePrs.findIndex((p) => p.number === view.number && p.repo === view.repo)
            : -1;
        const next = down
          ? idx + 1 >= visiblePrs.length
            ? 0
            : idx + 1
          : idx <= 0
            ? visiblePrs.length - 1
            : idx - 1;
        selectPr(visiblePrs[next].number, visiblePrs[next].repo);
        document
          .getElementById(`row-pr-${visiblePrs[next].repo}-${visiblePrs[next].number}`)
          ?.scrollIntoView({ block: "nearest" });
      } else if (tab === "manual" && visibleManual?.length) {
        e.preventDefault();
        const idx =
          view.kind === "manual" ? visibleManual.findIndex((p) => p.name === view.name) : -1;
        const next = down
          ? idx + 1 >= visibleManual.length
            ? 0
            : idx + 1
          : idx <= 0
            ? visibleManual.length - 1
            : idx - 1;
        selectManual(visibleManual[next].name);
        document
          .getElementById(`row-manual-${visibleManual[next].name}`)
          ?.scrollIntoView({ block: "nearest" });
      } else if (tab === "tmux" && visibleTmux?.length) {
        e.preventDefault();
        const idx = visibleTmux.findIndex((s) => s.name === selectedTmux);
        const next = down
          ? idx + 1 >= visibleTmux.length
            ? 0
            : idx + 1
          : idx <= 0
            ? visibleTmux.length - 1
            : idx - 1;
        selectTmux(visibleTmux[next].name);
        document
          .getElementById(`row-tmux-${visibleTmux[next].name}`)
          ?.scrollIntoView({ block: "nearest" });
      }
    };
    // Esc closes whichever dialog/dropdown is open. Registered in the *capture*
    // phase (like ⌥-digit below) so it fires before the event reaches any modal
    // input that calls e.stopPropagation() in its bubble-phase onKeyDown — those
    // would otherwise eat Esc and leave the dialog open. This is the single
    // source of truth, so every dialog closes on the first Esc, instantly.
    const onEscClose = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const k = keyCtx.current;
      // The share dialog layers above the HTML preview, which layers above the
      // Home chat panel — so Esc peels them off one at a time, innermost first.
      if (k.shareOpen) {
        e.preventDefault();
        e.stopPropagation();
        setShareOpen(false);
        shareMut.reset();
        unshareMut.reset();
        return;
      }
      if (k.htmlViewOpen) {
        e.preventDefault();
        e.stopPropagation();
        setHtmlView(null);
        return;
      }
      if (!(k.restartOpen || k.killAllOpen || k.commitOpen || k.claudeOpen || k.usageOpen || k.dirsOpen || k.dirMenuOpen))
        return;
      // In the Claude composer a live @-mention should be cancelled first; its
      // textarea's own Esc handler does that, so defer to it. A second Esc (no
      // token) falls through to here and closes the dialog.
      if (k.claudeOpen && k.fileToken) return;
      e.preventDefault();
      e.stopPropagation();
      setRestartOpen(false);
      setKillAllOpen(false);
      setCommitOpen(false);
      setClaudeOpen(false);
      setUsageOpen(false);
      setDirsOpen(false);
      setDirMenuOpen(false);
    };
    // ⌥1–⌥9 jump straight to the Nth registered directory (top-left dropdown),
    // 1-indexed. Registered in the *capture* phase on its own listener so it
    // fires before the event reaches any element — including modal textareas
    // that call e.stopPropagation() in their bubble-phase onKeyDown. This makes
    // directory switching supersede everything else: even mid-typing in a
    // commit box or filter field, ⌥+digit wins. Match on e.code, not e.key,
    // since ⌥+digit yields a special glyph for e.key on macOS but e.code stays
    // "Digit1"…"Digit9".
    const onDirHotkey = (e: KeyboardEvent) => {
      if (!e.altKey || !/^Digit[1-9]$/.test(e.code)) return;
      e.preventDefault();
      e.stopPropagation();
      // Keep focus in the Claude composer when switching dirs mid-prompt so you can
      // juggle a draft per directory; otherwise blur the active field (filter box,
      // commit message, etc.) so the switch reads cleanly.
      if (!keyCtx.current.claudeOpen) {
        const active = document.activeElement;
        if (active instanceof HTMLElement) active.blur();
      }
      const d = keyCtx.current.dirs[Number(e.code.slice(5)) - 1];
      if (d) selectDir(d.id);
    };
    document.addEventListener("keydown", onEscClose, true);
    document.addEventListener("keydown", onDirHotkey, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onEscClose, true);
      document.removeEventListener("keydown", onDirHotkey, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [selectCommit, selectPr, selectManual, selectTab, selectTmux, selectDir, killSession, markHomeRead, jumpToTop, jumpToBottom, chatScroll, toggleReviewed, toggleCollapsed, toggleTheme, runGit, commitWithClaude, refreshServer, queryClient]);

  const scrollToKey = (key: string) => {
    fileEls.current.get(key)?.scrollIntoView({ block: "start" });
  };

  const actionButtons = (file: SectionFile) =>
    file.actions.map((a) => (
      <button
        key={a}
        className="act"
        title={ACTION_LABELS[a].title}
        disabled={busyPath !== null}
        onClick={(e) => {
          e.stopPropagation();
          runGit(a, file.path, file.repo, file.worktree);
        }}
      >
        {ACTION_LABELS[a].label}
      </button>
    ));

  const changeGroups: {
    label: string;
    segment: string;
    repo?: string;
    dir?: string;
    files: SectionFile[];
  }[] = sections
    .filter((s) => s.label)
    .map((s) => ({ label: s.label!, segment: s.segment ?? "", repo: s.repo, dir: s.dir, files: s.files }));

  // Group the staged/unstaged groups under their worktree segment so the
  // sidebar shows each worktree (when there's more than one) with its files.
  const worktreeSegments: { segment: string; groups: typeof changeGroups }[] = [];
  for (const g of changeGroups) {
    let seg = worktreeSegments.find((w) => w.segment === g.segment);
    if (!seg) {
      seg = { segment: g.segment, groups: [] };
      worktreeSegments.push(seg);
    }
    seg.groups.push(g);
  }

  // The directory currently in view, and the launch cwd's id (can't be removed).
  const defaultDirId = dirsQuery.data?.defaultDirId ?? meta?.defaultDirId ?? null;
  const currentDirId = meta?.id ?? activeDir;

  // The right "details" sidebar only exists for a commit/PR/changes/manual view —
  // not the Tmux tab or an empty pane. It drives the desktop column, the mobile
  // right-drawer opener, and the minimize chevron. On desktop it hides when
  // minimized; on mobile it's always mounted (as a drawer) so its opener works.
  const hasRightSidebar = tab !== "tmux" && view.kind !== "none";
  const showRight = hasRightSidebar && (isDesktop ? !rightMinimized : true);

  // Mobile "Actions" menu (top bar) — the tab-relevant things you'd otherwise
  // reach by keyboard on desktop. "New Claude session" works on every tab; the
  // rest depend on the active tab/view. Refresh is always offered, last.
  const actionItems: {
    label: string;
    icon: ReactNode;
    onClick: () => void;
    disabled?: boolean;
  }[] = [{ label: "New Claude session", icon: <Sparkles />, onClick: () => setClaudeOpen(true) }];
  if (tab === "tmux") {
    // Mobile mirror of the `_` shortcut: opens the confirmation that kills every
    // session currently listed (dir-scoped + filtered). Disabled when none.
    actionItems.push({
      label: "Close all sessions",
      icon: <Trash2 />,
      onClick: () => setKillAllOpen(true),
      disabled: !visibleTmux?.length,
    });
  }
  if (tab === "changes" && view.kind === "changes") {
    actionItems.push(
      { label: "Stage all", icon: <Plus />, onClick: () => runGit("stage"), disabled: busyPath !== null },
      { label: "Unstage all", icon: <Minus />, onClick: () => runGit("unstage"), disabled: busyPath !== null },
      { label: "Stash all", icon: <Archive />, onClick: () => runGit("stash"), disabled: busyPath !== null },
      { label: "Commit with Claude", icon: <Bot />, onClick: () => void commitWithClaude(), disabled: !dirty },
      { label: "Commit & deploy with Claude", icon: <Bot />, onClick: () => void commitWithClaude(true), disabled: !dirty },
      { label: "Commit & push…", icon: <GitCommitHorizontal />, onClick: () => setCommitOpen(true) },
    );
  }
  if (tab === "commits" && view.kind === "commit") {
    actionItems.push({
      label: reviewed.has(view.sha) ? "Mark unreviewed" : "Mark reviewed",
      icon: <Check />,
      onClick: () => toggleReviewed(view.sha, view.repo),
    });
  }
  // Diff-line highlighting is off by default on mobile (this menu only renders
  // there), so offer it as a toggle wherever a diff is on screen.
  if (hasRightSidebar) {
    actionItems.push({
      label: diffHighlights ? "Disable line highlights" : "Enable line highlights",
      icon: <Highlighter />,
      onClick: () => setDiffHighlights((h) => !h),
    });
  }
  // The Tmux tab's "Kill session" lives as a dedicated trash button beside this
  // menu (see the topbar), so it's intentionally not duplicated here.
  actionItems.push({ label: "Claude usage", icon: <Gauge />, onClick: () => setUsageOpen(true) });
  actionItems.push({ label: "Refresh", icon: <RefreshCw />, onClick: refreshTab });
  actionItems.push({ label: "Restart server…", icon: <RotateCw />, onClick: () => setRestartOpen(true) });
  actionItems.push({
    label: theme === "dark" ? "Light mode" : "Dark mode",
    icon: theme === "dark" ? <Sun /> : <Moon />,
    onClick: toggleTheme,
  });

  // The chat surface (transcript + composer) for the selected session, shared by
  // the Tmux tab and the Home dashboard's side-panel. Both resolve the same
  // selectedSession, so one transcript query / turns list / reply box drives
  // whichever surface is on screen. A function so it's built only when rendered.
  const renderChat = () => (
    <>
      {!selectedSession && <div className="transcript-empty">Select a session on the left</div>}
      {selectedSession && transcriptQuery.isPending && (
        <ContentSpinner label="Loading transcript…" />
      )}
      {transcriptQuery.isError && (
        <div className="empty error">{errMessage(transcriptQuery.error)}</div>
      )}
      {transcriptData && (
        <>
          <div className="transcript-head">
            <h2>{transcriptData.title || transcriptData.session}</h2>
            <span className="t-sub">
              {transcriptData.cwd}
              {transcriptData.model ? ` · ${transcriptData.model}` : ""}
              {transcriptData.session ? ` · ${transcriptData.session}` : ""}
            </span>
            <button
              type="button"
              className={`edits-toggle${editsOnly ? " on" : ""}`}
              aria-pressed={editsOnly}
              title={editsOnly ? "Show all messages" : "Show only edits"}
              onClick={() => setEditsOnly((v) => !v)}
            >
              Edits only
            </button>
          </div>
          {transcriptData.messages.length === 0 ? (
            <div className="transcript-empty">
              {transcriptData.path
                ? "No conversation yet — press space to refresh"
                : "Starting session…"}
            </div>
          ) : editsOnly && turns.length === 0 ? (
            <div className="transcript-empty">No edits in this conversation yet</div>
          ) : (
            turns.map((t, i) => (
              <TranscriptTurn
                key={i}
                role={t.role}
                msgs={t.msgs}
                session={selectedSession}
                theme={theme}
                onAnswerPlan={i === turns.length - 1 ? answerPlan : undefined}
                onAnswerQuestion={i === turns.length - 1 ? answerQuestion : undefined}
              />
            ))
          )}
          {transcriptData.pendingPane && !selectedBusy && (
            <PendingPrompt
              // Remount (re-seed checkboxes) when the question changes, but keep
              // in-progress toggles stable across background polls of the same one.
              key={
                transcriptData.pendingPrompt
                  ? `${transcriptData.pendingPrompt.kind}:${transcriptData.pendingPrompt.question}:${transcriptData.pendingPrompt.options
                      .map((o) => o.label)
                      .join("|")}`
                  : "raw"
              }
              text={transcriptData.pendingPane}
              prompt={transcriptData.pendingPrompt}
              onAnswerSingle={(d) => sendToSession(String(d))}
              onAnswerMulti={answerPendingMulti}
              onConfirm={confirmPending}
            />
          )}
          {selectedBusy && (
            <div className="turn assistant">
              <div className="content">
                <div className="typing">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            </div>
          )}
        </>
      )}
      {selectedSession && (
        <div className="reply-box">
          {!atBottom && (
            <button
              type="button"
              className="scroll-bottom"
              title="Scroll to latest"
              aria-label="Scroll to latest"
              onClick={jumpToBottom}
            >
              <ChevronDown />
            </button>
          )}
          <div className="file-menu-wrap">
            <textarea
              ref={replyTextareaRef}
              className="reply-input"
              placeholder={`Reply to ${selectedSession}…  (type @ to reference a file, ⌃V to paste an image, ↵ to send, ⇧↵ for newline)`}
              value={replyText}
              onChange={(e) => {
                replyHistoryIndexRef.current = null; // editing exits history browse
                setReplyText(e.target.value);
                saveDraft(replyDraftKey(selectedSession), e.target.value);
                syncFileToken(e.target, replyMentionTarget);
              }}
              onPaste={handleReplyPaste}
              onClick={(e) => syncFileToken(e.currentTarget, replyMentionTarget)}
              onKeyUp={(e) => {
                // Let the menu's own ArrowUp/Down win while it's open; otherwise
                // keep the @token current as the caret moves (arrows/home/end).
                if (fileMenuOpen && (e.key === "ArrowUp" || e.key === "ArrowDown")) return;
                syncFileToken(e.currentTarget, replyMentionTarget);
              }}
              // Leaving the box (clicking into the transcript) dismisses the popup;
              // a menu click can't trigger this because its onMouseDown preventDefault
              // keeps focus here.
              onBlur={() => {
                if (fileToken?.owner === "reply") setFileToken(null);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                // While the @-file popup is open it owns navigation/acceptance.
                if (fileMenuOpen) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setFileMenuIndex((i) => (i + 1) % fileSuggestions.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setFileMenuIndex((i) => (i - 1 + fileSuggestions.length) % fileSuggestions.length);
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    acceptFile(fileSuggestions[fileMenuIndex] ?? fileSuggestions[0]);
                    return;
                  }
                }
                // Shell-style history: ArrowUp on an empty composer recalls
                // the previous reply sent to this session; ArrowDown walks
                // back toward the empty box. recallReplyHistory returns false
                // (leaving the keys to their default caret movement) when
                // there's nothing to recall or a draft is being edited.
                if (e.key === "ArrowUp" && recallReplyHistory(-1)) {
                  e.preventDefault();
                  return;
                }
                if (e.key === "ArrowDown" && recallReplyHistory(1)) {
                  e.preventDefault();
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  // A live @-token cancels first (keeping the literal "@…" text);
                  // a second Esc (no token) blurs the composer.
                  if (fileToken) setFileToken(null);
                  else e.currentTarget.blur();
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submitReply();
                }
              }}
            />
            {fileToken?.owner === "reply" &&
              fileMenuStyle &&
              createPortal(
                <div className="file-menu" style={fileMenuStyle}>
                  {fileSuggestions.length ? (
                    fileSuggestions.map((f, i) => (
                      <button
                        key={f}
                        className={`file-opt${i === fileMenuIndex ? " on" : ""}`}
                        title={f}
                        onMouseDown={(e) => {
                          e.preventDefault(); // keep focus in the textarea
                          acceptFile(f);
                        }}
                        onMouseEnter={() => setFileMenuIndex(i)}
                      >
                        {f}
                      </button>
                    ))
                  ) : (
                    <div className="file-menu-empty">
                      {filesQuery.isPending ? "Loading files…" : "No matching files"}
                    </div>
                  )}
                </div>,
                document.body,
              )}
          </div>
          <div className="reply-bar">
            {/* Quick-action cluster. On a phone none of the desktop keyboard
                shortcuts (⌃V paste, dir switch, `'`) are reachable, so these are
                always surfaced as icon buttons. The desktop *Home* chat sheet shows
                them too: it's a focused dialog floating over the dashboard without
                the sidebar's affordances to hand, so the buttons earn their place
                there. The desktop Tmux tab stays lean — its sidebar already does
                all of this. */}
            {(!isDesktop || tab === "home") && (
              <>
                {/* Close the Home chat dialog — a thumb-reachable mirror of the
                    ✕ in the panel's top bar (only this surface is a dialog; the
                    Tmux tab's reply bar shares renderChat but has nothing to
                    close). */}
                {tab === "home" && (
                  <IconButton title="Close chat" onClick={closeHomeChat}>
                    <X />
                  </IconButton>
                )}
                {/* Kill the chat you're viewing (and close the panel) — a
                    thumb-reachable mirror of the ✕ kill button on the card.
                    Home-only: the Tmux tab has no panel to close and its own
                    kill lives on the `x` key / sidebar row. */}
                {tab === "home" && homeChat && (
                  <IconButton
                    className="delete"
                    title="Delete chat"
                    onClick={() => deleteHomeCard(homeChat)}
                  >
                    <Trash2 />
                  </IconButton>
                )}
                <ImageAttachButton
                  uploading={replyImgUploading}
                  onPick={(e) => handleImageFile(e, insertIntoReply, setReplyImgUploading)}
                />
                <IconButton
                  title="Go to last directory"
                  disabled={prevDir === undefined && dirs.length < 2}
                  onClick={goToLastDir}
                >
                  <FolderClock />
                </IconButton>
                <IconButton
                  title="New Claude session"
                  onClick={() => {
                    // Close the Home chat dialog as we open the new-session
                    // modal (no-op on Tmux, where homeChat is already null).
                    closeHomeChat();
                    setClaudeOpen(true);
                  }}
                >
                  <Sparkles />
                </IconButton>
                {/* Jump to the topmost (latest) session in the sidebar — same
                    target as the `0` key. Disabled when it's already selected. */}
                <IconButton
                  title="Jump to latest chat"
                  disabled={!visibleTmux?.length || visibleTmux[0].name === selectedSession}
                  onClick={() => {
                    if (visibleTmux?.length) selectTmux(visibleTmux[0].name);
                  }}
                >
                  <ArrowUpToLine />
                </IconButton>
                {/* Scroll the transcript to its very top — re-read the prompt you
                    started with on a long chat. Mirrors the topbar's "Jump to
                    top" (no keyboard shortcut is reachable on a phone). */}
                <IconButton title="Jump to top of chat" onClick={jumpToTop}>
                  <ArrowUp />
                </IconButton>
              </>
            )}
            {/* Jump to the next session that finished with output you haven't
                opened — the unread dots in the sidebar. Rendered on desktop
                too (no keyboard shortcut drives it); disabled when nothing but
                the current chat is unread. */}
            <IconButton
              title="Go to next unread session"
              disabled={!hasNextUnread}
              onClick={goToNextUnread}
            >
              <BellDot />
            </IconButton>
            {replyImgUploading && <span className="reply-hint">Uploading image…</span>}
            <span className="spacer" />
            {/* Desktop keeps the roomy text buttons; on mobile they collapse to
                square icon buttons in the right corner to free up room in the bar
                for the left-cluster quick actions. */}
            {isDesktop ? (
              <>
                <button
                  className="act stop"
                  disabled={replyStopping || !selectedBusy}
                  onClick={stopSession}
                  title="Interrupt claude (sends Escape)"
                >
                  {replyStopping ? "Stopping…" : "Stop"}
                </button>
                <button
                  className="act primary"
                  disabled={replySending || !replyText.trim()}
                  onClick={submitReply}
                >
                  {replySending ? "Sending…" : "Send"}
                </button>
              </>
            ) : (
              <>
                <IconButton
                  className="stop"
                  title="Interrupt claude (sends Escape)"
                  disabled={replyStopping || !selectedBusy}
                  onClick={stopSession}
                >
                  {replyStopping ? <span className="icon-spin">…</span> : <Square />}
                </IconButton>
                <IconButton
                  className="primary"
                  title="Send reply"
                  disabled={replySending || !replyText.trim()}
                  onClick={submitReply}
                >
                  {replySending ? <span className="icon-spin">…</span> : <Send />}
                </IconButton>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );

  return (
    <div
      className="layout"
      ref={layoutRef}
      style={
        { "--left-w": `${leftWidth}px`, "--right-w": `${rightWidth}px` } as CSSProperties
      }
      data-drawer={drawerOpen ?? ""}
    >
      <header className="topbar">
        <button
          className="topbar-btn burger"
          title="Menu"
          aria-label="Open menu"
          onClick={() => setDrawerOpen((d) => (d === "left" ? null : "left"))}
        >
          <Menu size={18} />
        </button>
        <span className="topbar-title">{meta?.name ?? "diffshub"}</span>
        {tab === "tmux" && (
          <>
            <button
              className="topbar-btn"
              title="Jump to top of chat"
              aria-label="Jump to top of chat"
              onClick={jumpToTop}
            >
              <ArrowUp size={18} />
            </button>
            <button
              className="topbar-btn"
              title="Previous chat"
              aria-label="Previous chat"
              disabled={!visibleTmux || visibleTmux.length < 2}
              onClick={() => cycleSession(-1)}
            >
              <ChevronLeft size={18} />
            </button>
            <button
              className="topbar-btn"
              title="Next chat"
              aria-label="Next chat"
              disabled={!visibleTmux || visibleTmux.length < 2}
              onClick={() => cycleSession(1)}
            >
              <ChevronRight size={18} />
            </button>
          </>
        )}
        {tab === "home" && (
          <button
            className="topbar-btn"
            title="Go to last directory"
            aria-label="Go to last directory"
            disabled={prevDir === undefined && dirs.length < 2}
            onClick={goToLastDir}
          >
            <FolderClock size={18} />
          </button>
        )}
        {tab === "home" && (
          <button
            className="topbar-btn"
            title="Commit with Claude"
            aria-label="Commit with Claude"
            disabled={!dirty}
            onClick={() => void commitWithClaude()}
          >
            <Bot size={18} />
          </button>
        )}
        {(tab === "home" || tab === "tmux" || tab === "commits") && (
          <button
            className="topbar-btn topbar-new"
            title="New Claude session"
            aria-label="New Claude session"
            onClick={() => setClaudeOpen(true)}
          >
            <Plus size={18} />
          </button>
        )}
        {tab === "tmux" && selectedSession && (
          <button
            className="topbar-btn topbar-kill"
            title={`Kill ${selectedSession}`}
            aria-label={`Kill session ${selectedSession}`}
            onClick={() => void killSession(selectedSession)}
          >
            <Trash2 size={18} />
          </button>
        )}
        <div className="topbar-actions">
          <button
            className="topbar-btn"
            title="Actions"
            aria-label="Tab actions"
            aria-haspopup="menu"
            aria-expanded={actionsOpen}
            onClick={() => setActionsOpen((o) => !o)}
          >
            <EllipsisVertical size={18} />
          </button>
          {actionsOpen && (
            <div className="topbar-actions-menu" role="menu">
              {actionItems.map((it) => (
                <button
                  key={it.label}
                  className="topbar-action"
                  role="menuitem"
                  disabled={it.disabled}
                  onClick={() => {
                    setActionsOpen(false);
                    it.onClick();
                  }}
                >
                  {it.icon}
                  <span>{it.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {hasRightSidebar && (
          <button
            className="topbar-btn topbar-right"
            title="Show details"
            aria-label="Open details panel"
            onClick={() => setDrawerOpen((d) => (d === "right" ? null : "right"))}
          >
            <PanelRight size={18} />
          </button>
        )}
      </header>
      <div className="body">
      <nav className="commits">
        <header className="commits-header">
          <div className="dir-dropdown">
            <button
              className="dir-trigger"
              title="Switch directory (D)"
              onClick={() => setDirMenuOpen((o) => !o)}
            >
              <span className="dir-text">
                <span className="dir-name">{meta?.name ?? "diffshub"}</span>
                {meta && (
                  <span className="dir-sub">
                    {meta.repo}
                    {meta.branch ? ` @ ${meta.branch}` : ""}
                  </span>
                )}
              </span>
              <span className="dir-caret">▾</span>
            </button>
            {dirMenuOpen && (
              <div className="dir-menu">
                <input
                  ref={dirSearchEl}
                  className="dir-search"
                  type="text"
                  placeholder="Filter directories…"
                  value={dirFilter}
                  onChange={(e) => {
                    setDirFilter(e.target.value);
                    setDirActive(0);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setDirActive((i) => Math.min(i + 1, visibleDirs.length - 1));
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setDirActive((i) => Math.max(i - 1, 0));
                    } else if (e.key === "Enter") {
                      e.preventDefault();
                      const d = visibleDirs[dirActive] ?? visibleDirs[0];
                      if (d) selectDir(d.id);
                    }
                  }}
                />
                <div className="dir-list">
                  {visibleDirs.map((d, i) => {
                    // Shortcut index off the full list so ⌥N stays right when filtered.
                    const kbIndex = dirs.indexOf(d);
                    return (
                      <button
                        key={d.id}
                        id={`diropt-${i}`}
                        className={`dir-item${d.id === currentDirId ? " on" : ""}${
                          i === dirActive ? " active" : ""
                        }`}
                        onMouseEnter={() => setDirActive(i)}
                        onClick={() => selectDir(d.id)}
                      >
                        <span className="dir-item-text">
                          <span className="dir-item-name">
                            {d.name}
                            {d.id === defaultDirId ? " · launch" : ""}
                          </span>
                          <span className="dir-item-path">{d.path}</span>
                        </span>
                        {kbIndex >= 0 && kbIndex < 9 && (
                          <span className="dir-item-key">⌥{kbIndex + 1}</span>
                        )}
                      </button>
                    );
                  })}
                  {visibleDirs.length === 0 && <div className="dir-empty">No matches</div>}
                </div>
                <div className="dir-menu-sep" />
                <button
                  className="dir-menu-act"
                  onClick={() => {
                    setDirMenuOpen(false);
                    openDirForm();
                    setDirsOpen(true);
                  }}
                >
                  + Add directory…
                </button>
                <button
                  className="dir-menu-act"
                  onClick={() => {
                    setDirMenuOpen(false);
                    setDirsOpen(true);
                  }}
                >
                  Manage directories…
                </button>
              </div>
            )}
          </div>
          <div className="tabs">
            <button
              className={tab === "home" ? "on" : ""}
              data-tip="Home"
              aria-label="Home"
              onClick={() => selectTab("home")}
            >
              <House />
              {needsActionCount > 0 && (
                <span className="tab-badge waiting">{needsActionCount}</span>
              )}
            </button>
            <button
              className={tab === "tmux" ? "on" : ""}
              data-tip="Tmux sessions"
              aria-label="Tmux sessions"
              onClick={() => selectTab("tmux")}
            >
              <SquareTerminal />
              {runningTmux > 0 && <span className="tab-badge">{runningTmux}</span>}
            </button>
            <button
              className={tab === "changes" ? "on" : ""}
              data-tip="Changes"
              aria-label="Changes"
              onClick={() => selectTab("changes")}
            >
              <FileDiffIcon />
              {!!changeCount && <span className="tab-badge">{changeCount}</span>}
            </button>
            <button
              className={tab === "commits" ? "on" : ""}
              data-tip="Commits"
              aria-label="Commits"
              onClick={() => selectTab("commits")}
            >
              <GitCommitHorizontal />
            </button>
            <button
              className={tab === "prs" ? "on" : ""}
              data-tip="Pull requests"
              aria-label="Pull requests"
              onClick={() => selectTab("prs")}
            >
              <GitPullRequest />
            </button>
            <button
              className={tab === "manual" ? "on" : ""}
              data-tip="Manual patches"
              aria-label="Manual patches"
              onClick={() => selectTab("manual")}
            >
              <FileStack />
            </button>
          </div>
          {tab !== "changes" && (
            <input
              ref={searchEl}
              type="text"
              placeholder={
                tab === "commits"
                  ? "Filter commits…"
                  : tab === "prs"
                    ? "Filter PRs…"
                    : tab === "tmux" || tab === "home"
                      ? "Filter sessions…"
                      : "Filter patches…"
              }
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          )}
          {(tab === "tmux" || tab === "home") && (
            <input
              className="content-search"
              type="text"
              placeholder="Search html for string…"
              value={contentFilter}
              onChange={(e) => setContentFilter(e.target.value)}
            />
          )}
        </header>

        {tab === "commits" && (
          <div className="commit-list">
            {commitsQuery.isPending && <SkeletonList />}
            {commitsQuery.isError && (
              <div className="side-note error">{errMessage(commitsQuery.error)}</div>
            )}
            {visibleCommits.map((c) => (
              <div
                key={`${c.repo}:${c.sha}`}
                id={`row-commit-${c.sha}`}
                className={`commit${view.kind === "commit" && c.sha === view.sha && c.repo === view.repo ? " active" : ""}${reviewed.has(c.sha) ? " reviewed" : ""}`}
                onClick={() => selectCommit(c.sha, c.repo)}
              >
                <span className="commit-msg">{c.message.split("\n")[0]}</span>
                <span className="commit-meta">
                  {workspace && <span className="repo-badge">{c.repo}</span>}
                  {c.avatar && <img src={c.avatar} alt="" />}
                  <span className="commit-author">{c.login ?? c.author}</span>
                  <code>{c.sha.slice(0, 7)}</code>
                  <span className="commit-ago">{timeAgo(c.date)}</span>
                </span>
                <button
                  className="rev-btn"
                  title="Toggle reviewed (;)"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleReviewed(c.sha, c.repo);
                  }}
                >
                  ✓
                </button>
              </div>
            ))}
            {!filter && hasMore && commits.length > 0 && (
              <button
                className="load-more"
                disabled={loadingMore}
                onClick={() => commitsQuery.fetchNextPage()}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            )}
          </div>
        )}

        {tab === "prs" && (
          <div className="commit-list">
            {prs === null && !prError && <SkeletonList />}
            {prError && <div className="side-note error">{prError}</div>}
            {visiblePrs?.map((p) => (
              <button
                key={`${p.repo}:${p.number}`}
                id={`row-pr-${p.repo}-${p.number}`}
                className={`commit${view.kind === "pr" && p.number === view.number && p.repo === view.repo ? " active" : ""}`}
                onClick={() => selectPr(p.number, p.repo)}
              >
                <span className="commit-msg">
                  {p.isDraft ? "✎ " : ""}
                  {p.title}
                </span>
                <span className="commit-meta">
                  {workspace && <span className="repo-badge">{p.repo}</span>}
                  <code>#{p.number}</code>
                  <span className="commit-author">{p.login}</span>
                  <span className="pr-stats">
                    <span className="add">+{p.additions}</span> <span className="del">−{p.deletions}</span>
                  </span>
                  <span className="commit-ago">{timeAgo(p.updatedAt)}</span>
                </span>
              </button>
            ))}
            {prs !== null && !prError && prs.length === 0 && (
              <div className="side-note">No open PRs</div>
            )}
          </div>
        )}

        {tab === "manual" && (
          <div className="commit-list">
            {manualPatches === null && !manualError && <SkeletonList />}
            {manualError && <div className="side-note error">{manualError}</div>}
            {visibleManual?.map((p) => (
              <button
                key={p.name}
                id={`row-manual-${p.name}`}
                className={`commit${view.kind === "manual" && p.name === view.name ? " active" : ""}`}
                onClick={() => selectManual(p.name)}
              >
                <span className="commit-msg">{p.name}</span>
                <span className="commit-meta">
                  <span className="commit-author">{manualFileCounts.get(p.name) ?? 0} files</span>
                </span>
              </button>
            ))}
            {manualPatches !== null && !manualError && manualPatches.length === 0 && (
              <div className="side-note">
                No <code>.patch</code> files in <code>./diffs</code>
              </div>
            )}
          </div>
        )}

        {tab === "changes" && (
          <div className="commit-list">
            <div className="auto-refresh-bar">
              <span>Auto-refresh</span>
              <button
                className={`switch${autoRefresh ? " on" : ""}`}
                role="switch"
                aria-checked={autoRefresh}
                title="Toggle auto-refresh"
                onClick={() => setAutoRefresh((v) => !v)}
              >
                <span className="switch-knob" />
              </button>
              <span className="switch-state">{autoRefresh ? "On" : "Off"}</span>
            </div>
            <div className="bulk-actions">
              <button disabled={busyPath !== null} onClick={() => runGit("stage")}>
                Stage all
              </button>
              <button disabled={busyPath !== null} onClick={() => runGit("unstage")}>
                Unstage all
              </button>
              <button disabled={busyPath !== null} onClick={() => runGit("stash")}>
                Stash all
              </button>
            </div>
            {changes === null && <SkeletonList />}
            {changes !== null && changeCount === 0 && (
              <div className="side-note">Working tree clean ✨</div>
            )}
            {worktreeSegments.map((seg) => {
              // Only worktrees with a segment header collapse; a single working
              // tree (segment "") has no header and always shows its groups.
              const collapsed = !!seg.segment && collapsedWorktrees.has(seg.segment);
              const wtFiles = seg.groups.reduce((n, g) => n + g.files.length, 0);
              return (
                <div key={seg.segment || "_"}>
                  {seg.segment && (
                    <button
                      className={`wt-label${collapsed ? " collapsed" : ""}`}
                      title={collapsed ? "Expand worktree" : "Collapse worktree"}
                      aria-expanded={!collapsed}
                      onClick={() => toggleWorktree(seg.segment)}
                    >
                      <span className="wt-name">{seg.segment}</span>
                      <span className="wt-count">{wtFiles}</span>
                      <span className="wt-caret">▾</span>
                    </button>
                  )}
                  {!collapsed &&
                    seg.groups.map((group) => (
                      <div key={group.label}>
                        <div className="group-label">
                          <span>
                            {group.label} ({group.files.length})
                          </span>
                          {group.label === "Unstaged" && (
                            <button
                              className="group-act"
                              title="git add -A"
                              disabled={busyPath !== null}
                              onClick={() => runGit("stage", undefined, undefined, group.dir)}
                            >
                              stage all
                            </button>
                          )}
                        </div>
                        {group.files.map((f) => (
                          <div key={f.key} className="change-row" onClick={() => scrollToKey(f.key)}>
                            <code className={`st st-${f.untracked ? "untracked" : (f.fileDiff && STATUS_FOR_CHANGE[f.fileDiff.type]) || "modified"}`}>
                              {f.untracked ? "?" : f.fileDiff?.type === "new" ? "A" : f.fileDiff?.type === "deleted" ? "D" : f.fileDiff?.type.startsWith("rename") ? "R" : "M"}
                            </code>
                            <span className="change-path" title={f.path}>
                              {f.path}
                            </span>
                            <span className="change-acts">{actionButtons(f)}</span>
                          </div>
                        ))}
                      </div>
                    ))}
                </div>
              );
            })}
          </div>
        )}

        {tab === "tmux" && (
          <div className="commit-list">
            {tmuxQuery.isPending && <SkeletonList />}
            {tmuxQuery.isError && (
              <div className="side-note error">{errMessage(tmuxQuery.error)}</div>
            )}
            {!serverOnline && (
              <div className="offline-note">
                <span className="offline-dot" />
                Offline — new sessions are queued and launch when you reconnect.
              </div>
            )}
            {visibleQueued?.map((qs) => (
              <div key={`q-${qs.id}`} className="commit queued" title={qs.prompt}>
                <div className="sess-top">
                  <span className="sess-queued" />
                  <span className="sess-name">Queued session</span>
                  <span className="queued-badge">Queued</span>
                </div>
                <div className="sess-task">{qs.prompt}</div>
                <button
                  className="kill-btn"
                  title="Remove from queue"
                  onClick={(e) => {
                    e.stopPropagation();
                    void cancelQueued(qs.id);
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
            {visibleTmux?.map((s) => (
              <div
                key={s.name}
                id={`row-tmux-${s.name}`}
                className={`commit${selectedSession === s.name ? " active" : ""}${
                  s.waiting && !s.busy ? " waiting" : ""
                }${selectedSession !== s.name && isUnread(s) ? " unread" : ""}`}
                onClick={() => selectTmux(s.name)}
              >
                <div className="sess-top">
                  <span
                    className={`sess-busy${s.busy ? " on" : s.waiting ? " waiting" : ""}`}
                  />
                  <span className="sess-name">{s.name}</span>
                  {s.waiting && !s.busy && <span className="waiting-badge">Waiting</span>}
                  {selectedSession !== s.name && isUnread(s) && (
                    <span className="unread-dot" title="Finished — unread" />
                  )}
                </div>
                {s.task && <div className="sess-task">{s.task}</div>}
                <div className="sess-cwd">{s.cwd.replace(/^.*\//, "") || s.cwd}</div>
                <button
                  className="kill-btn"
                  title={`Kill ${s.name} (x)`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void killSession(s.name);
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
            {visibleTmux !== null &&
              visibleTmux.length === 0 &&
              (!visibleQueued || visibleQueued.length === 0) && (
                <div className="side-note">
                  {tmuxSessions && tmuxSessions.length > 0
                    ? "No claude sessions in this directory"
                    : "No claude tmux sessions"}
                </div>
              )}
          </div>
        )}

        <div className="kbd-hints">
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            title="Toggle light/dark (t)"
            aria-label="Toggle light/dark"
          >
            {theme === "dark" ? <Sun size={13} /> : <Moon size={13} />}
            <span>{theme === "dark" ? "Light" : "Dark"}</span>
          </button>
          {/* Shortcut hints hidden — they took up too much sidebar space. The
              keyboard shortcuts themselves still work; only the legend is gone.
          <span>
            <kbd>1-5</kbd>/<kbd>←/→</kbd> tabs
          </span>
          <span>
            <kbd>⌥1-9</kbd> dir
          </span>
          <span>
            <kbd>↑/↓</kbd> list
          </span>
          {tab === "tmux" && (
            <span>
              <kbd>0/9</kbd> first/last <kbd>x</kbd> kill <kbd>_</kbd> kill all <kbd>space</kbd> refresh
            </span>
          )}
          <span>
            <kbd>j/k/d/u</kbd> scroll
          </span>
          <span>
            <kbd>gg/G</kbd> top/bottom
          </span>
          <span>
            <kbd>h/l</kbd> files
          </span>
          <span>
            <kbd>space</kbd> refresh
          </span>
          {tab === "changes" && (
            <span>
              <kbd>a</kbd> stage <kbd>A</kbd> all <kbd>x</kbd> commit w/ claude <kbd>⇧X</kbd> + deploy
            </span>
          )}
          <span>
            <kbd>;</kbd> {tab === "changes" ? "commit" : "reviewed"}
          </span>
          <span>
            <kbd>c</kbd> collapse
          </span>
          <span>
            <kbd>'</kbd> new session
          </span>
          <span>
            <kbd>t</kbd> theme
          </span>
          <span>
            <kbd>⇧R</kbd> restart server
          </span>
          <span>
            <kbd>⇧U</kbd> usage
          </span>
          <span>
            <kbd>/</kbd> filter
          </span>
          */}
        </div>
      </nav>

      <div className="resizer rz-left" onPointerDown={startResize("left")} />

      <main
        className={`diffs${tab === "tmux" ? " tmux" : tab === "home" ? " home-main" : ""}${
          tab === "home" && homeChat ? " chat-open" : ""
        }`}
        ref={mainEl}
      >
        {tab === "home" && (
          <HomeView
            groups={homeGroups}
            queued={visibleQueued ?? []}
            loading={tmuxQuery.isPending && !tmuxSessions}
            error={tmuxQuery.isError ? errMessage(tmuxQuery.error) : null}
            selectedName={homeSel}
            isUnseen={isUnseen}
            onOpen={openHomeChat}
            onDelete={deleteHomeCard}
            onMarkRead={markHomeRead}
            onCancelQueued={cancelQueued}
          />
        )}
        {tab === "tmux" && <div className="transcript">{renderChat()}</div>}
        {/* Home dashboard: clicking a card opens its chat here instead of leaving
            the dashboard — a docked right sidebar on desktop, a full-screen sheet
            on mobile (see .home-chat-panel). Portaled to <body> so the fixed panel
            isn't clipped by the scrolling main column. Esc or the ✕ closes it. */}
        {tab === "home" &&
          homeChat &&
          createPortal(
            <aside className="home-chat-panel" role="dialog" aria-modal="true">
              <div className="home-chat-bar">
                <button
                  type="button"
                  className="home-chat-close"
                  title="Close chat (Esc)"
                  aria-label="Close chat"
                  onClick={closeHomeChat}
                >
                  <X size={18} />
                </button>
                <span className="home-chat-title">{homeChat}</span>
                {/* Surfaces only once the chat has written an .html file — opens
                    its live contents in a full-screen iframe over this panel. */}
                {htmlArtifact && (
                  <button
                    type="button"
                    className="home-chat-html"
                    title={`Open HTML preview (${htmlArtifact})`}
                    aria-label="Open HTML preview"
                    onClick={() => setHtmlView(htmlArtifact)}
                  >
                    <FileCode size={15} />
                    <span>HTML</span>
                  </button>
                )}
              </div>
              <div className="home-chat-scroll" ref={chatScrollEl}>
                <div className="transcript">{renderChat()}</div>
              </div>
            </aside>,
            document.body,
          )}
        {/* The HTML artifact preview — a second full-screen dialog layered over the
            Home chat panel, showing the live .html the chat has been building in a
            sandboxed iframe. Refetches while the panel is open so edits stream in.
            Portaled to <body> and z-indexed above the chat panel. */}
        {htmlView &&
          createPortal(
            <div className="html-overlay" role="dialog" aria-modal="true">
              <div className="html-bar">
                <FileCode size={16} className="html-bar-icon" />
                <span className="html-title">{htmlView.split("/").pop()}</span>
                <span className="html-path" title={htmlView}>
                  {htmlView}
                </span>
                <span className="spacer" />
                {/* The preview auto-polls while open; this just forces a refetch now. */}
                <IconButton title="Reload preview" onClick={() => htmlQuery.refetch()}>
                  <RefreshCw size={16} />
                </IconButton>
                <IconButton
                  title="Open in new tab"
                  onClick={() =>
                    window.open(
                      `/api/tmux/html?session=${encodeURIComponent(selectedSession)}&path=${encodeURIComponent(htmlView)}`,
                      "_blank",
                      "noopener",
                    )
                  }
                >
                  <ExternalLink size={16} />
                </IconButton>
                {/* Publish this artifact to the public R2 bucket and show the link. */}
                <IconButton
                  title="Share — publish to a public link"
                  disabled={shareMut.isPending}
                  onClick={openShare}
                >
                  {shareMut.isPending ? <RefreshCw size={16} className="spin" /> : <Share2 size={16} />}
                </IconButton>
                <IconButton title="Close preview (Esc)" onClick={() => setHtmlView(null)}>
                  <X size={16} />
                </IconButton>
              </div>
              <div className="html-body">
                {htmlQuery.isError ? (
                  <div className="empty error">{errMessage(htmlQuery.error)}</div>
                ) : htmlQuery.data !== undefined ? (
                  <iframe
                    className="html-frame"
                    title="HTML preview"
                    sandbox="allow-scripts allow-popups allow-forms allow-modals allow-downloads"
                    srcDoc={htmlQuery.data}
                  />
                ) : (
                  <div className="empty">Loading…</div>
                )}
              </div>
            </div>,
            document.body,
          )}
        {/* The "Share" dialog — a compact modal layered above the HTML preview that
            reports the public R2 link for the open artifact. Opens immediately on
            click in a loading state, then resolves to the link (with a copy button)
            or an error. Portaled to <body>; Esc / the ✕ / a backdrop click closes. */}
        {shareOpen &&
          createPortal(
            <div className="share-overlay" role="dialog" aria-modal="true" onClick={closeShare}>
              <div className="share-card" onClick={(e) => e.stopPropagation()}>
                <div className="share-head">
                  <Link2 size={16} />
                  <span className="share-title">Share link</span>
                  <span className="spacer" />
                  <IconButton title="Close (Esc)" onClick={closeShare}>
                    <X size={16} />
                  </IconButton>
                </div>
                {unshareMut.isSuccess ? (
                  <div className="share-status">Link removed — the public files were deleted.</div>
                ) : shareMut.isPending ? (
                  <div className="share-status">Uploading to R2…</div>
                ) : shareMut.isError ? (
                  <div className="share-status error">{errMessage(shareMut.error)}</div>
                ) : shareMut.data ? (
                  <>
                    <div className="share-row">
                      <input className="share-url" readOnly value={shareMut.data.url} onFocus={(e) => e.currentTarget.select()} />
                      <CopyButton label="copy" title="Copy link" text={shareMut.data.url} />
                    </div>
                    <div className="share-meta">
                      {shareMut.data.alreadyShared
                        ? "Already shared — unchanged since last time."
                        : `Published${shareMut.data.assets ? ` with ${shareMut.data.assets} image asset${shareMut.data.assets === 1 ? "" : "s"}` : ""}.`}
                      {shareMut.data.skipped.length > 0 &&
                        ` ${shareMut.data.skipped.length} local ref${shareMut.data.skipped.length === 1 ? "" : "s"} skipped.`}
                      {" "}
                      <a href={shareMut.data.url} target="_blank" rel="noopener noreferrer">
                        Open ↗
                      </a>
                    </div>
                    {/* Undo retracts the link entirely — deletes the HTML + assets
                        from R2 and clears the db row. */}
                    <div className="share-foot">
                      <button
                        className="act danger"
                        title="Delete the public link and its files from R2"
                        disabled={unshareMut.isPending}
                        onClick={() => unshareMut.mutate()}
                      >
                        {unshareMut.isPending ? "Removing…" : "Undo share"}
                      </button>
                      {unshareMut.isError && (
                        <span className="share-foot-err">{errMessage(unshareMut.error)}</span>
                      )}
                    </div>
                  </>
                ) : null}
              </div>
            </div>,
            document.body,
          )}
        {/* Diff-column skeleton: shown while git computes a commit/PR/changes/manual
            diff in the background, and on the commits tab during the brief moment
            before it auto-lands on the newest commit. The layout lands instantly so
            switching tabs feels SPA-snappy and only the diff text streams in. */}
        {(diffLoading ||
          (view.kind === "changes" && changes === null) ||
          (view.kind === "manual" && manualPatches === null && !manualError) ||
          (view.kind === "none" &&
            tab === "commits" &&
            (commitsQuery.isPending || commits.length > 0))) && <SkeletonDiff />}
        {/* Nothing selected: keep the column scoped to the current tab rather than
            leaking the previous tab's diff. PRs wait for a pick; an empty commits
            repo says so. */}
        {view.kind === "none" && tab === "prs" && (
          <div className="empty">Select a PR on the left to view its diff</div>
        )}
        {view.kind === "none" &&
          tab === "commits" &&
          !commitsQuery.isPending &&
          commits.length === 0 && <div className="empty">No commits yet</div>}
        {diffQuery.isError && (view.kind === "commit" || view.kind === "pr") && (
          <div className="empty error">{diffError}</div>
        )}
        {view.kind === "changes" && changes !== null && changeCount === 0 && (
          <div className="empty">Working tree clean — nothing pending</div>
        )}
        {view.kind === "manual" &&
          manualPatches !== null &&
          sections.every((s) => !s.files.length) && (
            <div className={`empty${manualError ? " error" : ""}`}>
              {manualError ||
                (manualPatches.length === 0
                  ? "No .patch files found in ./diffs"
                  : "No file changes in this patch")}
            </div>
          )}
        {(view.kind === "commit" || view.kind === "pr") &&
          diffQuery.isSuccess &&
          sections.every((s) => !s.files.length) && <div className="empty">No file changes</div>}

        {sections.map((section) => (
          <div key={section.label ?? "main"}>
            {section.label && <h3 className="section-label">{section.label}</h3>}
            {section.files.map((f) => (
              <DiffRow
                key={f.key}
                file={f}
                viewing={f.key === activeKey}
                collapsed={collapsedKeys.has(f.key)}
                selectedRange={selection?.fileKey === f.key ? selection.range : null}
                busy={busyPath !== null}
                diffStyle={isDesktop ? "split" : "unified"}
                selectable={lineSelectable}
                themeType={theme}
                registerEl={registerEl}
                onSelect={onDiffSelect}
                onAct={runGit}
                onOpenOpaque={onOpenOpaque}
              />
            ))}
          </div>
        ))}
      </main>

      {selection && selFile && (
        <div className="sel-bar">
          <span className="sel-info">
            <code>{selFile.path.split("/").pop()}</code> {selSide === "deletions" ? "old " : ""}
            {selHi > selLo ? `L${selLo}–${selHi}` : `L${selLo}`}
          </span>
          {(view.kind === "manual" || view.kind === "changes") && (
            <button
              className="sel-act danger"
              disabled={!canDelete}
              title={canDelete ? "Delete these lines" : "Select added (+) lines to delete"}
              onClick={deleteSelection}
            >
              Delete
            </button>
          )}
          <button className="sel-act" onClick={openSelection}>
            Open in {meta?.editor ?? "editor"}
          </button>
          <button className="sel-x" title="Dismiss (esc)" onClick={() => setSelection(null)}>
            ✕
          </button>
        </div>
      )}

      {showRight && (
        <>
        <div className="resizer rz-right" onPointerDown={startResize("right")} />
        <aside className="tree">
        <button
          className="tree-min"
          title="Hide panel"
          aria-label="Hide details panel"
          onClick={() => setRightMinimized(true)}
        >
          <ChevronRight size={16} />
        </button>
        <div className="meta-panel">
          {view.kind === "commit" && (
            <>
              <h2 title={activeCommit?.message}>
                {activeCommit?.message.split("\n")[0] ?? "Commit"}
              </h2>
              <div className="meta-line">
                {workspace && view.repo && <span className="repo-badge">{view.repo}</span>}
                {activeCommit && (
                  <>
                    {activeCommit.avatar && <img src={activeCommit.avatar} alt="" />}
                    <span>{activeCommit.login ?? activeCommit.author}</span>
                    <span>·</span>
                    <span>{timeAgo(activeCommit.date)}</span>
                  </>
                )}
              </div>
              <div className="meta-line">
                <button
                  className="sha-btn"
                  title="Copy full sha"
                  onClick={() => navigator.clipboard.writeText(view.sha)}
                >
                  {view.sha.slice(0, 12)}
                </button>
              </div>
              {(() => {
                const nwo =
                  meta?.repos.find((r) => r.key === (activeCommit?.repo ?? view.repo))
                    ?.nameWithOwner || meta?.repos[0]?.nameWithOwner;
                return nwo ? (
                  <div className="meta-line gh-links">
                    <a
                      className="gh-link"
                      href={`https://github.com/${nwo}`}
                      target="_blank"
                      rel="noreferrer"
                      title={`Open ${nwo} on GitHub`}
                    >
                      <ExternalLink size={13} /> {nwo}
                    </a>
                    <a
                      className="gh-link"
                      href={`https://github.com/${nwo}/commit/${view.sha}`}
                      target="_blank"
                      rel="noreferrer"
                      title="Open this commit on GitHub"
                    >
                      <GitCommitHorizontal size={13} /> Commit
                    </a>
                  </div>
                ) : null;
              })()}
            </>
          )}
          {view.kind === "pr" && (
            <>
              <h2>{activePr?.title ?? `PR #${view.number}`}</h2>
              <div className="meta-line">
                {workspace && view.repo && <span className="repo-badge">{view.repo}</span>}
                <span>#{view.number}</span>
                {activePr && (
                  <>
                    <span>·</span>
                    <span>{activePr.login}</span>
                    <span>·</span>
                    <span className="pr-stats">
                      <span className="add">+{activePr.additions}</span>{" "}
                      <span className="del">−{activePr.deletions}</span>
                    </span>
                  </>
                )}
              </div>
              {activePr && (
                <div className="meta-line">
                  <button
                    className="sha-btn"
                    title="Copy branch name"
                    onClick={() => navigator.clipboard.writeText(activePr.branch)}
                  >
                    {activePr.branch}
                  </button>
                </div>
              )}
            </>
          )}
          {view.kind === "changes" && (
            <>
              <h2>Pending changes</h2>
              <div className="meta-line">
                <span>{changeCount ?? 0} files</span>
                {workspace ? (
                  <>
                    <span>·</span>
                    <span>{meta?.repos.map((r) => r.key).join(" · ")}</span>
                  </>
                ) : (
                  meta?.branch && (
                    <>
                      <span>·</span>
                      <span>{meta.branch}</span>
                    </>
                  )
                )}
              </div>
            </>
          )}
          {view.kind === "manual" && (
            <>
              <h2 title={view.name}>{view.name || "Manual patches"}</h2>
              <div className="meta-line">
                <span>{treeFileCount} files</span>
                <span>·</span>
                <span>./diffs</span>
              </div>
            </>
          )}
        </div>
        <div className="tree-body">
          <FileTree
            model={model}
            header={<strong>Files changed ({treeFileCount})</strong>}
            style={{ colorScheme: "light" }}
          />
        </div>
      </aside>
        </>
      )}
      </div>

      {/* Mobile: dim + tap-to-close behind an open drawer. */}
      {drawerOpen && <div className="scrim" onClick={() => setDrawerOpen(null)} />}

      {/* Desktop: when the right sidebar is minimized, a floating chevron tab at
          the right edge brings it back. */}
      {isDesktop && hasRightSidebar && rightMinimized && (
        <button
          className="tree-reveal"
          title="Show panel"
          aria-label="Show details panel"
          onClick={() => setRightMinimized(false)}
        >
          <ChevronLeft size={16} />
        </button>
      )}

      {restartOpen && (
        <div className="modal-overlay" onClick={() => setRestartOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Restart server</h3>
            <div className="dir-form">
              <label>Window</label>
              <input
                autoFocus
                value={restartWindow}
                placeholder="dh"
                onChange={(e) => setRestartWindow(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Escape") setRestartOpen(false);
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitRestart();
                  }
                }}
              />
              <label>Command</label>
              <input
                value={restartCommand}
                placeholder="dh"
                onChange={(e) => setRestartCommand(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Escape") setRestartOpen(false);
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitRestart();
                  }
                }}
              />
            </div>
            <div className="modal-actions">
              <button className="act" onClick={() => setRestartOpen(false)}>
                Cancel
              </button>
              <button
                className="act primary"
                disabled={!restartWindow.trim() || !restartCommand.trim()}
                onClick={submitRestart}
              >
                Restart
              </button>
            </div>
            <div className="modal-hint">
              <span>
                Ctrl-C the <code>{restartWindow.trim() || "dh"}</code> window, then run{" "}
                <code>{restartCommand.trim() || "dh"}</code> in <code>tmux -L bg</code>
              </span>
              <span>
                <kbd>↵</kbd> restart
              </span>
              <span>
                <kbd>esc</kbd> cancel
              </span>
            </div>
          </div>
        </div>
      )}

      {killAllOpen && (
        <div className="modal-overlay" onClick={() => !killingAll && setKillAllOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Kill all sessions</h3>
            <p className="modal-body">
              Kill {visibleTmux?.length ?? 0} tmux{" "}
              {(visibleTmux?.length ?? 0) === 1 ? "session" : "sessions"} currently listed
              {meta?.repo ? (
                <>
                  {" "}in <code>{meta.repo}</code>
                </>
              ) : null}
              ? This can't be undone.
            </p>
            <div className="modal-actions">
              <button className="act" disabled={killingAll} onClick={() => setKillAllOpen(false)}>
                Cancel
              </button>
              <button
                autoFocus
                className="act primary"
                disabled={killingAll || !(visibleTmux?.length ?? 0)}
                onClick={() => void killAllSessions()}
              >
                {killingAll ? "Killing…" : "Kill all"}
              </button>
            </div>
            <div className="modal-hint">
              <span>
                <kbd>↵</kbd> kill all
              </span>
              <span>
                <kbd>esc</kbd> cancel
              </span>
            </div>
          </div>
        </div>
      )}

      {commitOpen && (
        <div className="modal-overlay" onClick={() => !committing && setCommitOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>
              Commit &amp; push
              {stagedWorktrees.length ? (
                <span className="modal-repos"> · {stagedWorktrees.join(", ")}</span>
              ) : (
                ""
              )}
            </h3>
            <textarea
              autoFocus
              ref={commitTextareaRef}
              className="commit-input auto"
              placeholder="Commit message…"
              value={commitMsg}
              onChange={(e) => {
                setCommitMsg(e.target.value);
                captureCommitCaret(e.target);
                autosizeCommit();
              }}
              onClick={(e) => captureCommitCaret(e.currentTarget)}
              onSelect={(e) => captureCommitCaret(e.currentTarget)}
              onKeyUp={(e) => captureCommitCaret(e.currentTarget)}
              onKeyDown={(e) => {
                e.stopPropagation();
                // Enter submits; Shift+Enter falls through for a newline.
                // (⌘/⌃/⌥+Enter also submit, for old muscle memory.)
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submitCommit();
                }
              }}
            />
            <div className="modal-actions">
              <button className="act" disabled={committing} onClick={() => setCommitOpen(false)}>
                Cancel
              </button>
              <button
                className="act primary"
                disabled={committing || !commitMsg.trim() || !stagedWorktrees.length}
                onClick={submitCommit}
              >
                {committing
                  ? "Committing…"
                  : stagedWorktrees.length
                    ? "Commit & push"
                    : "Nothing staged"}
              </button>
            </div>
          </div>
        </div>
      )}

      {claudeOpen && (
        <div className="modal-overlay claude-overlay" onClick={() => !launching && setClaudeOpen(false)}>
          <div className="modal claude" onClick={(e) => e.stopPropagation()}>
            <h3>
              New Claude session
              {meta?.repo ? <span className="modal-repos"> · {meta.repo}</span> : ""}
            </h3>
            <div className="file-menu-wrap">
              <textarea
                autoFocus
                ref={claudeTextareaRef}
                className="commit-input auto"
                placeholder="Prompt for a new Claude Code session…  (type @ to reference a file, ⌃V to paste an image)"
                value={claudePrompt}
                onChange={(e) => {
                  setClaudePrompt(e.target.value);
                  syncFileToken(e.target, claudeMentionTarget);
                  captureClaudeCaret(e.target);
                  autosizeClaude();
                }}
                onPaste={handleClaudePaste}
                onClick={(e) => {
                  syncFileToken(e.currentTarget, claudeMentionTarget);
                  captureClaudeCaret(e.currentTarget);
                }}
                onSelect={(e) => captureClaudeCaret(e.currentTarget)}
                onKeyUp={(e) => {
                  captureClaudeCaret(e.currentTarget);
                  // Track caret moves (arrows/home/end) so the @token stays current,
                  // but let the menu's own ArrowUp/Down handling win when it's open.
                  if (fileMenuOpen && (e.key === "ArrowUp" || e.key === "ArrowDown")) return;
                  syncFileToken(e.currentTarget, claudeMentionTarget);
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  // While the @-file popup is open it owns navigation/acceptance.
                  if (fileMenuOpen) {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setFileMenuIndex((i) => (i + 1) % fileSuggestions.length);
                      return;
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setFileMenuIndex((i) => (i - 1 + fileSuggestions.length) % fileSuggestions.length);
                      return;
                    }
                    if (e.key === "Enter" || e.key === "Tab") {
                      e.preventDefault();
                      acceptFile(fileSuggestions[fileMenuIndex] ?? fileSuggestions[0]);
                      return;
                    }
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    // A live @-token — even with no matches yet, or while the file
                    // list is still loading — means you wanted the literal "@…"
                    // text, so cancel just the mention and keep typing. A second
                    // Esc (no token) closes the dialog.
                    if (fileToken) setFileToken(null);
                    else setClaudeOpen(false);
                    return;
                  }
                  // Enter submits; Shift+Enter falls through to the textarea for a
                  // newline. (⌘/⌃/⌥+Enter also submit, for old muscle memory.)
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submitClaude();
                  }
                }}
              />
              {fileToken?.owner === "claude" &&
                fileMenuStyle &&
                createPortal(
                  <div className="file-menu" style={fileMenuStyle}>
                    {fileSuggestions.length ? (
                      fileSuggestions.map((f, i) => (
                        <button
                          key={f}
                          className={`file-opt${i === fileMenuIndex ? " on" : ""}`}
                          title={f}
                          onMouseDown={(e) => {
                            e.preventDefault(); // keep focus in the textarea
                            acceptFile(f);
                          }}
                          onMouseEnter={() => setFileMenuIndex(i)}
                        >
                          {f}
                        </button>
                      ))
                    ) : (
                      <div className="file-menu-empty">
                        {filesQuery.isPending ? "Loading files…" : "No matching files"}
                      </div>
                    )}
                  </div>,
                  document.body,
                )}
            </div>
            {!serverOnline && (
              <div className="modal-offline">
                <span className="offline-dot" />
                You're offline — this prompt will be queued and launch automatically
                once you're back online.
              </div>
            )}
            <div className="modal-actions">
              {!isDesktop && (
                <ImageAttachButton
                  uploading={imgUploading}
                  onPick={(e) => handleImageFile(e, insertIntoPrompt, setImgUploading)}
                />
              )}
              <button className="act" disabled={launching} onClick={() => setClaudeOpen(false)}>
                Cancel
              </button>
              <button
                className="act primary"
                disabled={launching || !claudePrompt.trim()}
                onClick={submitClaude}
              >
                {launching
                  ? serverOnline
                    ? "Launching…"
                    : "Queuing…"
                  : serverOnline
                    ? "Launch"
                    : "Queue"}
              </button>
            </div>
          </div>
        </div>
      )}

      {usageOpen && (
        <div className="modal-overlay" onClick={() => setUsageOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Claude usage</h3>
            {usageQuery.isLoading && !usageQuery.data ? (
              <div className="usage-note">Loading…</div>
            ) : usageQuery.isError ? (
              <div className="usage-note error">{errMessage(usageQuery.error)}</div>
            ) : !usageQuery.data?.five_hour && !usageQuery.data?.seven_day ? (
              <div className="usage-note">
                No usage data yet — it appears once Claude Code's statusline has
                rendered at least once.
              </div>
            ) : (
              <div className="usage-grid">
                {(
                  [
                    ["Session", "5-hour window", usageQuery.data?.five_hour ?? null],
                    ["Weekly", "7-day window", usageQuery.data?.seven_day ?? null],
                  ] as const
                ).map(([label, sub, win]) => (
                  <div className="usage-row" key={label}>
                    <div className="usage-head">
                      <span className="usage-label">
                        {label} <span className="usage-sub">{sub}</span>
                      </span>
                      <span className="usage-pct">
                        {win ? `${Math.round(win.used_percentage)}%` : "—"}
                      </span>
                    </div>
                    {win ? (
                      <>
                        <div className="usage-bar">
                          <div
                            className={`usage-fill${
                              win.used_percentage >= 90
                                ? " hot"
                                : win.used_percentage >= 70
                                  ? " warm"
                                  : ""
                            }`}
                            style={{
                              width: `${Math.min(100, Math.max(2, win.used_percentage))}%`,
                            }}
                          />
                        </div>
                        <div className="usage-reset">
                          Resets in <strong>{untilReset(win.resets_at)}</strong>
                          <span className="usage-clock"> · {resetClock(win.resets_at)}</span>
                        </div>
                      </>
                    ) : (
                      <div className="usage-reset muted">No data for this window</div>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="modal-actions">
              <button
                className="act"
                onClick={() => void usageQuery.refetch()}
                disabled={usageQuery.isFetching}
              >
                {usageQuery.isFetching ? "Refreshing…" : "Refresh"}
              </button>
              <button className="act primary" onClick={() => setUsageOpen(false)}>
                Close
              </button>
            </div>
            <div className="modal-hint">
              {usageQuery.data?.updated_at ? (
                <span>
                  Updated{" "}
                  {timeAgo(new Date(usageQuery.data.updated_at * 1000).toISOString())}
                </span>
              ) : null}
              <span>
                <kbd>esc</kbd> close
              </span>
            </div>
          </div>
        </div>
      )}

      {launchedSession && (
        <div className="sel-bar sel-bar-toast">
          <span className="sel-info">New session created</span>
          <button className="sel-x" title="Dismiss" onClick={() => setLaunchedSession(null)}>
            ✕
          </button>
        </div>
      )}

      {queuedNote && (
        <div className="sel-bar">
          <span className="sel-info">
            Queued — Claude will start it automatically once you're back online.
          </span>
          <button className="sel-x" title="Dismiss" onClick={() => setQueuedNote(false)}>
            ✕
          </button>
        </div>
      )}

      {dirsOpen && (
        <div className="modal-overlay" onClick={() => !dirSaving && setDirsOpen(false)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <h3>Directories</h3>
            <div className="dir-rows">
              {dirs.map((d) => (
                <div className="dir-row" key={d.id}>
                  <div className="dir-row-text">
                    <div className="dir-row-name">
                      {d.name}
                      {d.id === defaultDirId ? " · launch" : ""}
                    </div>
                    <div className="dir-row-meta" title={d.path}>
                      {d.path}
                      {d.repos.length ? ` — ${d.repos.join(", ")}` : ""}
                    </div>
                  </div>
                  <button className="act" onClick={() => openDirForm(d)}>
                    Edit
                  </button>
                  {d.id !== defaultDirId && (
                    <button className="act" onClick={() => deleteDir(d)}>
                      Delete
                    </button>
                  )}
                </div>
              ))}
              {dirs.length === 0 && <div className="side-note">No directories yet</div>}
            </div>
            <div className="dir-form">
              <label>Name</label>
              <input
                value={dirForm.name}
                placeholder="optional — defaults to the folder name"
                onChange={(e) => setDirForm((f) => ({ ...f, name: e.target.value }))}
                onKeyDown={(e) => {
                  e.stopPropagation();
                }}
              />
              <label>Path</label>
              <input
                value={dirForm.path}
                placeholder="~/work or /Users/me/project"
                onChange={(e) => setDirForm((f) => ({ ...f, path: e.target.value }))}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") {
                    e.preventDefault();
                    saveDir();
                  }
                }}
              />
              <label>Member repos</label>
              <input
                value={dirForm.repos}
                placeholder="app, web (optional)"
                onChange={(e) => setDirForm((f) => ({ ...f, repos: e.target.value }))}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") {
                    e.preventDefault();
                    saveDir();
                  }
                }}
              />
              <div className="dir-form-hint">Leave empty to auto-detect git subdirectories.</div>
            </div>
            <div className="push-sep" />
            <PushToggle />
            {dirError && <div className="modal-error">{dirError}</div>}
            <div className="modal-actions">
              {dirForm.id != null && (
                <button className="act" disabled={dirSaving} onClick={() => openDirForm()}>
                  New
                </button>
              )}
              <button className="act" disabled={dirSaving} onClick={() => setDirsOpen(false)}>
                Close
              </button>
              <button
                className="act primary"
                disabled={dirSaving || !dirForm.path.trim()}
                onClick={saveDir}
              >
                {dirSaving ? "Saving…" : dirForm.id != null ? "Save" : "Add"}
              </button>
            </div>
            <div className="modal-hint">
              <span>
                Files indexed via <code>git ls-files</code> (respects .gitignore)
              </span>
              <span>
                <kbd>esc</kbd> close
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const queryClient = new QueryClient({
  defaultOptions: {
    // Errors surface immediately (no retry delay) like the old fetch code, and
    // only the changes query opts back into focus refetching.
    queries: { retry: false, refetchOnWindowFocus: false },
  },
});

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
);
