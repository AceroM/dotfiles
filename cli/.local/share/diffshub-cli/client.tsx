import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type Dispatch,
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
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { getSharedHighlighter, parsePatchFiles, type FileDiffMetadata, type SelectedLineRange } from "@pierre/diffs";
import { FileDiff, MultiFileDiff } from "@pierre/diffs/react";
import type { GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import {
  GitCommitHorizontal,
  GitPullRequest,
  FileDiff as FileDiffIcon,
  FileStack,
  SquareTerminal,
  Menu,
  PanelRight,
  ChevronLeft,
  ChevronRight,
  EllipsisVertical,
  Sparkles,
  RefreshCw,
  Plus,
  Minus,
  Archive,
  Bot,
  Check,
  Trash2,
  Sun,
  Moon,
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

type Tab = "commits" | "prs" | "changes" | "manual" | "tmux";

// Order drives the 1–5 / ←→ shortcuts and the tab strip. The first entry is the
// landing tab for the default route (see initialView).
const TAB_ORDER: Tab[] = ["tmux", "changes", "commits", "prs", "manual"];

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
  sessionId: string;
  hasTranscript: boolean;
  mtime: number;
}

// One rendered line of a session's transcript.
interface TranscriptMsg {
  role: "user" | "assistant" | "tool";
  kind: "text" | "tool_use" | "tool_result";
  text: string;
  tool?: string;
  ts?: string;
  path?: string; // file path for Edit/Write/MultiEdit/Read
  edits?: { old: string; new: string }[]; // hunks for Edit/Write/MultiEdit diff rendering
  lang?: string; // language id for a Read tool result's code block
}

interface Transcript {
  session: string;
  cwd: string;
  sessionId: string;
  path: string | null;
  messages: TranscriptMsg[];
  model: string;
  title: string;
}

type View =
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

function timeAgo(iso: string): string {
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

// How often the Tmux tab re-reads the session list / open transcript, but only
// while a claude session is actively working (see the queries below). At idle we
// stop polling entirely.
const TMUX_POLL_MS = 2000;

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
  // Light/dark — drives the diff library's own palette + syntax theme. A prop so
  // the memo busts (and the diff re-renders) the moment the theme is toggled.
  themeType: Theme;
  registerEl: (key: string, el: HTMLDivElement | null) => void;
  onSelect: (fileKey: string, range: SelectedLineRange | null) => void;
  onAct: (action: GitAction, path: string, repo?: string, worktree?: string) => void;
  onOpenOpaque: (path: string, repo?: string, worktree?: string) => void;
}

const DiffRow = memo(function DiffRow({
  file,
  viewing,
  collapsed,
  selectedRange,
  busy,
  diffStyle,
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
  // the highlight in every other.
  const selectionOptions = {
    collapsed,
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
    // Paragraph: gather consecutive plain lines, soft-wrapped with <br/>.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/.test(lines[i]) &&
      !isHeading(lines[i]) &&
      !isQuote(lines[i]) &&
      !isUl(lines[i]) &&
      !isOl(lines[i])
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

// One conversation turn: a user turn is a right-aligned bubble; an assistant turn
// is a left avatar + content stack (markdown text, tool calls, tool results).
const TranscriptTurn = memo(function TranscriptTurn({
  role,
  msgs,
  theme,
  onAnswerPlan,
  onAnswerQuestion,
}: {
  role: "user" | "assistant";
  msgs: TranscriptMsg[];
  theme: Theme;
  onAnswerPlan?: (choice: number) => Promise<void> | void;
  onAnswerQuestion?: (questionIndex: number, optionIndex: number) => Promise<void> | void;
}) {
  if (role === "user") {
    return (
      <div className="turn user">
        {msgs.map((m, i) => (
          <div key={i} className="bubble">
            {m.text}
          </div>
        ))}
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

interface Turn {
  role: "user" | "assistant";
  msgs: TranscriptMsg[];
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

function initialView(): { tab: Tab; view: View; dir: number | null } {
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
  // Default route lands on the first tab (Tmux sessions); see TAB_ORDER.
  return { tab: "tmux", view: { kind: "tmux", session: "" }, dir };
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

function App() {
  const initial = useMemo(initialView, []);
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>(initial.tab);
  const [view, setView] = useState<View>(initial.view);

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

  // ---- Active directory (top-left dropdown) ----
  // null means "the server default" (the launch cwd). Persisted to the URL only,
  // so a reload stays put but launching `dh` elsewhere still opens that new cwd.
  const [activeDir, setActiveDir] = useState<number | null>(initial.dir);
  const activeDirRef = useRef(activeDir);
  activeDirRef.current = activeDir;
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
    enabled: tab === "changes",
    // Poll + refetch-on-focus only while auto-refresh is on. Structural sharing
    // keeps `data` referentially stable when nothing changed, so a poll that
    // finds no diff doesn't re-render the view — replacing the old manual
    // JSON.stringify dedup.
    refetchInterval: autoRefresh && tab === "changes" ? 2500 : false,
    refetchOnWindowFocus: autoRefresh,
  });
  const changes = changesQuery.data ?? null;

  // ---- Tmux tab: claude sessions + the selected session's transcript ----
  // These are global (not dir-scoped) — they reflect every claude tmux session.
  // Poll the session list only while some claude session is actively working, so
  // the busy dots + task lines stay live during a run but we stay quiet at idle.
  const tmuxQuery = useQuery({
    queryKey: ["tmux-sessions"],
    queryFn: ({ signal }) =>
      fetchJSON<{ sessions: TmuxSession[] }>("/api/tmux/sessions", signal).then((r) => r.sessions),
    enabled: tab === "tmux",
    refetchOnWindowFocus: false,
    refetchInterval: (query) => (query.state.data?.some((s) => s.busy) ? TMUX_POLL_MS : false),
  });
  const tmuxSessions = tmuxQuery.data ?? null;
  const selectedSession = view.kind === "tmux" ? view.session : "";
  // Stream the open transcript only while its session is busy; once claude goes
  // idle we stop polling so you can scroll back without being yanked to the end.
  const selectedBusy = !!tmuxSessions?.find((s) => s.name === selectedSession)?.busy;
  const transcriptQuery = useQuery({
    queryKey: ["tmux-transcript", selectedSession],
    queryFn: ({ signal }) =>
      fetchJSON<Transcript>(`/api/tmux/transcript?session=${encodeURIComponent(selectedSession)}`, signal),
    enabled: tab === "tmux" && !!selectedSession,
    refetchOnWindowFocus: false,
    refetchInterval: selectedBusy ? TMUX_POLL_MS : false,
  });
  const selectedSessionRef = useRef(selectedSession);
  selectedSessionRef.current = selectedSession;

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

  const [busyPath, setBusyPath] = useState<string | null>(null);

  // Commit & push dialog (Changes view, `;`)
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
  // True while a pasted image is being uploaded to /tmp/images (⌃V in the dialog).
  const [imgUploading, setImgUploading] = useState(false);

  // Reply composer (Tmux tab) — types a reply into the selected session's pane.
  const [replyText, setReplyText] = useState("");
  const [replySending, setReplySending] = useState(false);
  const [replyImgUploading, setReplyImgUploading] = useState(false);
  const replyTextareaRef = useRef<HTMLTextAreaElement | null>(null);

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

  const [filter, setFilter] = useState("");

  // ---- @-file autocomplete (New Claude session dialog) ----
  // The directory's gitignore-respecting file list, fetched only while the dialog
  // is open. Typing `@…` filters it into a popup that inserts `@path` references.
  const filesQuery = useQuery({
    queryKey: ["files", activeDir],
    queryFn: ({ signal }) => fetchJSON<{ files: string[] }>(qd("/api/files"), signal),
    enabled: claudeOpen,
    staleTime: 30_000,
  });
  const claudeTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  // A live mirror of `claudeOpen` for callbacks/effects that shouldn't re-subscribe
  // just to read it (e.g. the per-dir draft effect restoring focus mid-compose).
  const claudeOpenRef = useRef(claudeOpen);
  claudeOpenRef.current = claudeOpen;
  // Grow the composer to fit its content (then scroll past the CSS max-height)
  // so a long prompt never hides behind a fixed-height box.
  const autosizeClaude = useCallback(() => autosize(claudeTextareaRef.current), []);
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
  // The active `@token` being typed: its query text + where the `@` sits + caret.
  const [fileToken, setFileToken] = useState<{ query: string; start: number; caret: number } | null>(
    null,
  );
  const [fileMenuIndex, setFileMenuIndex] = useState(0);
  // Recompute the active @token from the textarea's value + caret position.
  const syncFileToken = useCallback((el: HTMLTextAreaElement) => {
    const value = el.value;
    const caret = el.selectionStart ?? value.length;
    let i = caret - 1;
    let token: { query: string; start: number; caret: number } | null = null;
    while (i >= 0) {
      const ch = value[i];
      if (ch === "@") {
        const prev = i > 0 ? value[i - 1] : " ";
        if (i === 0 || /\s/.test(prev)) token = { query: value.slice(i + 1, caret), start: i, caret };
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
  // Replace the active @token with `@<path> ` and restore the caret after it.
  const acceptFile = useCallback(
    (path: string) => {
      const tok = fileToken;
      if (!tok) return;
      setClaudePrompt((prev) => {
        const inserted = `@${path} `;
        const next = prev.slice(0, tok.start) + inserted + prev.slice(tok.caret);
        const pos = tok.start + inserted.length;
        requestAnimationFrame(() => {
          const el = claudeTextareaRef.current;
          if (el) {
            el.focus();
            el.setSelectionRange(pos, pos);
            captureClaudeCaret(el);
            autosizeClaude();
          }
        });
        return next;
      });
      setFileToken(null);
    },
    [fileToken, captureClaudeCaret, autosizeClaude],
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
    const place = () => {
      const el = claudeTextareaRef.current;
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
  }, [fileToken, claudePrompt, fileSuggestions.length]);

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

  const fileEls = useRef(new Map<string, HTMLDivElement>());
  const mainEl = useRef<HTMLDivElement | null>(null);
  const searchEl = useRef<HTMLInputElement | null>(null);

  // Whenever a transcript loads/refreshes, jump to the bottom so the newest part
  // of the conversation is in view. While the session is busy this polls (see
  // selectedBusy), so streamed-in messages auto-scroll to the end; structural
  // sharing means an unchanged poll keeps the same data ref and won't re-scroll.
  const transcriptData = transcriptQuery.data;
  const turns = useMemo(() => groupTurns(transcriptData?.messages ?? []), [transcriptData]);
  useEffect(() => {
    if (tab !== "tmux" || !transcriptData) return;
    const el = mainEl.current;
    if (el) requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight }));
  }, [tab, transcriptData, selectedSession]);

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

  // Paste an image (⌃V): read it as base64, upload to the server which saves it
  // under /tmp/images/<random>.<ext>, then insert that absolute path so the
  // claude session can Read it (Read works on /tmp without a permission prompt
  // and renders images visually). Non-image pastes fall through to normal paste.
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
          alert(`image paste failed: ${body.error ?? res.statusText}`);
          return;
        }
        if (typeof body.path === "string") insert(`${body.path} `);
      } catch (err) {
        alert(`image paste failed: ${String((err as any)?.message ?? err)}`);
      } finally {
        setUploading(false);
      }
    },
    [],
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
      setLaunchedSession(typeof body.session === "string" ? body.session : null);
      // The new tmux session needs a beat to register before it shows up in the
      // list, so nudge a refresh now and again shortly after rather than waiting
      // for the next poll — otherwise the just-launched session never pops in.
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
      setReplyText("");
      saveDraft(replyDraftKey(session), ""); // sent → drop this tab's saved draft
      // Give claude a beat to accept the keys before reading the transcript back.
      setTimeout(() => {
        queryClient.refetchQueries({ queryKey: ["tmux-transcript", session] });
        queryClient.refetchQueries({ queryKey: ["tmux-sessions"] });
      }, 500);
    } finally {
      setReplySending(false);
    }
  }, [replyText, queryClient]);

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

  // `x` — stage everything, then hand the commit off to a detached claude
  // session that writes the message itself (and pushes). Skips the `;` dialog
  // for when you'd rather claude author an informative commit from the diff.
  const commitWithClaude = useCallback(async () => {
    await runGit("stage");
    try {
      const res = await fetch(qd("/api/claude"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Commit and push the staged changes with a clear, informative commit message.",
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as any);
        alert(`launch failed: ${body.error ?? res.statusText}`);
        return;
      }
      const body = await res.json().catch(() => ({}) as any);
      setLaunchedSession(typeof body.session === "string" ? body.session : null);
    } catch (e) {
      alert(`launch failed: ${errMessage(e)}`);
    }
  }, [runGit, qd]);

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

  const selectTab = useCallback(
    (next: Tab) => {
      setTab(next);
      setFilter("");
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
      setActiveDir(id);
      activeDirRef.current = id;
      const nextTab = loadLastTab();
      const { view: nextView, param } = tabDefaults(nextTab);
      setTab(nextTab);
      setView(nextView);
      setFilter("");
      setDirMenuOpen(false);
      history.replaceState(null, "", navUrl(param));
    },
    [navUrl],
  );

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
      const files = parsePatchFiles(diffText, cacheKey).flatMap((p) => p.files);
      return [
        {
          label: null,
          files: files.map((f) => ({
            key: `main:${f.name}`,
            path: f.name,
            treePath: f.name,
            repo: view.repo,
            fileDiff: f,
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
          const files = parsePatchFiles(rc.stagedDiff).flatMap((p) => p.files);
          out.push({
            label: "Staged",
            segment: rc.segment,
            repo: rc.repo,
            dir: rc.dir,
            files: files.map((f) => ({
              key: `staged:${idns}:${f.name}`,
              path: f.name,
              treePath: tpath(rc.segment, f.name),
              repo: rc.repo,
              worktree: rc.dir,
              fileDiff: f,
              actions: ["unstage", "stash"],
            })),
          });
        }
        const unstagedFiles: SectionFile[] = parsePatchFiles(rc.unstagedDiff)
          .flatMap((p) => p.files)
          .map((f) => ({
            key: `unstaged:${idns}:${f.name}`,
            path: f.name,
            treePath: tpath(rc.segment, f.name),
            repo: rc.repo,
            worktree: rc.dir,
            fileDiff: f,
            actions: ["stage", "stash"] as GitAction[],
          }));
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
      const files = parsePatchFiles(
        patch.contents,
        `manual-${patch.name}-${patch.contents.length}`,
      ).flatMap((p) => p.files);
      return [
        {
          label: null,
          files: files.map((f) => ({
            key: `manual:${f.name}`,
            path: f.name,
            treePath: f.name,
            fileDiff: f,
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
    // Scroll the diff column back to the top when the viewed commit/PR changes.
    if (view.kind === "commit" || view.kind === "pr") mainEl.current?.scrollTo({ top: 0 });
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
  const visibleTmux = useMemo(
    () =>
      q && dirScopedTmux
        ? dirScopedTmux.filter(
            (s) =>
              s.name.toLowerCase().includes(q) ||
              s.cwd.toLowerCase().includes(q) ||
              s.task.toLowerCase().includes(q),
          )
        : dirScopedTmux,
    [dirScopedTmux, q],
  );
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
    commitOpen,
    claudeOpen,
    dirsOpen,
    dirMenuOpen,
    changes,
    dirs,
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
    commitOpen,
    claudeOpen,
    dirsOpen,
    dirMenuOpen,
    changes,
    dirs,
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { tab, view, visibleCommits, visiblePrs, visibleManual, visibleTmux, selectedTmux } =
        keyCtx.current;
      const target = (e.composedPath()[0] ?? e.target) as HTMLElement;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable;
      // Esc closes the open dialog / dropdown from anywhere (each dialog's
      // textarea also handles Esc while it holds focus).
      if (
        e.key === "Escape" &&
        (keyCtx.current.commitOpen ||
          keyCtx.current.claudeOpen ||
          keyCtx.current.dirsOpen ||
          keyCtx.current.dirMenuOpen)
      ) {
        e.preventDefault();
        setCommitOpen(false);
        setClaudeOpen(false);
        setDirsOpen(false);
        setDirMenuOpen(false);
        return;
      }
      if (e.key === "/" && !typing) {
        e.preventDefault();
        // In an open Tmux chat, `/` jumps to the reply composer (where you spend
        // your time); elsewhere it focuses the sidebar filter.
        if (tab === "tmux" && selectedTmux && replyTextareaRef.current) {
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
      if (typing) return;
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
      // ←/→ switch between tabs globally
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const idx = TAB_ORDER.indexOf(tab);
        const delta = e.key === "ArrowRight" ? 1 : TAB_ORDER.length - 1;
        selectTab(TAB_ORDER[(idx + delta) % TAB_ORDER.length]);
        return;
      }
      // 1–5 jump straight to a tab (plain, not ⌥ — that switches directories).
      if (!e.altKey && e.key >= "1" && e.key <= String(TAB_ORDER.length)) {
        e.preventDefault();
        selectTab(TAB_ORDER[Number(e.key) - 1]);
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
      if (e.key === "x") {
        e.preventDefault();
        if (tab === "tmux") {
          if (selectedTmux) void killSession(selectedTmux);
          return;
        }
        const dirty = (keyCtx.current.changes ?? []).some(
          (rc) => rc.staged.length || rc.unstaged.length || rc.untracked.length,
        );
        if (keyCtx.current.view.kind === "changes" && dirty) void commitWithClaude();
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
    document.addEventListener("keydown", onDirHotkey, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onDirHotkey, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [selectCommit, selectPr, selectManual, selectTab, selectTmux, selectDir, killSession, toggleReviewed, toggleCollapsed, toggleTheme, runGit, commitWithClaude, queryClient]);

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
  if (tab === "changes" && view.kind === "changes") {
    const dirty = (changes ?? []).some(
      (rc) => rc.staged.length || rc.unstaged.length || rc.untracked.length,
    );
    actionItems.push(
      { label: "Stage all", icon: <Plus />, onClick: () => runGit("stage"), disabled: busyPath !== null },
      { label: "Unstage all", icon: <Minus />, onClick: () => runGit("unstage"), disabled: busyPath !== null },
      { label: "Stash all", icon: <Archive />, onClick: () => runGit("stash"), disabled: busyPath !== null },
      { label: "Commit with Claude", icon: <Bot />, onClick: () => void commitWithClaude(), disabled: !dirty },
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
  if (tab === "tmux" && selectedSession) {
    actionItems.push({
      label: "Kill session",
      icon: <Trash2 />,
      onClick: () => void killSession(selectedSession),
    });
  }
  actionItems.push({ label: "Refresh", icon: <RefreshCw />, onClick: refreshTab });
  actionItems.push({
    label: theme === "dark" ? "Light mode" : "Dark mode",
    icon: theme === "dark" ? <Sun /> : <Moon />,
    onClick: toggleTheme,
  });

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
                    : tab === "tmux"
                      ? "Filter sessions…"
                      : "Filter patches…"
              }
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
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
            {visibleTmux?.map((s) => (
              <div
                key={s.name}
                id={`row-tmux-${s.name}`}
                className={`commit${selectedSession === s.name ? " active" : ""}`}
                onClick={() => selectTmux(s.name)}
              >
                <div className="sess-top">
                  <span className={`sess-busy${s.busy ? " on" : ""}`} />
                  <span className="sess-name">{s.name}</span>
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
            {visibleTmux !== null && visibleTmux.length === 0 && (
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
              <kbd>x</kbd> kill <kbd>space</kbd> refresh
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
              <kbd>a</kbd> stage <kbd>A</kbd> all <kbd>x</kbd> commit w/ claude
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
            <kbd>/</kbd> filter
          </span>
        </div>
      </nav>

      <div className="resizer rz-left" onPointerDown={startResize("left")} />

      <main className={`diffs${tab === "tmux" ? " tmux" : ""}`} ref={mainEl}>
        {tab === "tmux" && (
          <div className="transcript">
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
                  </span>
                </div>
                {transcriptData.messages.length === 0 ? (
                  <div className="transcript-empty">
                    {transcriptData.path
                      ? "No conversation yet — press space to refresh"
                      : "No transcript found for this session"}
                  </div>
                ) : (
                  turns.map((t, i) => (
                    <TranscriptTurn
                      key={i}
                      role={t.role}
                      msgs={t.msgs}
                      theme={theme}
                      onAnswerPlan={i === turns.length - 1 ? answerPlan : undefined}
                      onAnswerQuestion={i === turns.length - 1 ? answerQuestion : undefined}
                    />
                  ))
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
                <textarea
                  ref={replyTextareaRef}
                  className="reply-input"
                  placeholder={`Reply to ${selectedSession}…  (⌃V to paste an image, ↵ to send, ⇧↵ for newline)`}
                  value={replyText}
                  onChange={(e) => {
                    setReplyText(e.target.value);
                    saveDraft(replyDraftKey(selectedSession), e.target.value);
                  }}
                  onPaste={handleReplyPaste}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Escape") {
                      e.currentTarget.blur();
                      return;
                    }
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      submitReply();
                    }
                  }}
                />
                <div className="reply-bar">
                  <span className="reply-hint">
                    {replyImgUploading ? (
                      "Uploading image…"
                    ) : (
                      <>
                        <span>
                          <kbd>⌃V</kbd> image
                        </span>
                        <span>
                          <kbd>↵</kbd> send
                        </span>
                        <span>
                          <kbd>⇧↵</kbd> newline
                        </span>
                      </>
                    )}
                  </span>
                  <span className="spacer" />
                  <button
                    className="act primary"
                    disabled={replySending || !replyText.trim()}
                    onClick={submitReply}
                  >
                    {replySending ? "Sending…" : "Send"}
                  </button>
                </div>
              </div>
            )}
          </div>
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
                if (e.key === "Escape") setCommitOpen(false);
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey || e.altKey)) {
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
            <div className="modal-hint">
              <span>
                Runs in <code>tmux -L bg</code>
              </span>
              <span>
                <kbd>⌘↵</kbd> / <kbd>⌥↵</kbd> commit
              </span>
              <span>
                <kbd>esc</kbd> cancel
              </span>
            </div>
          </div>
        </div>
      )}

      {claudeOpen && (
        <div className="modal-overlay" onClick={() => !launching && setClaudeOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
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
                  syncFileToken(e.target);
                  captureClaudeCaret(e.target);
                  autosizeClaude();
                }}
                onPaste={handleClaudePaste}
                onClick={(e) => {
                  syncFileToken(e.currentTarget);
                  captureClaudeCaret(e.currentTarget);
                }}
                onSelect={(e) => captureClaudeCaret(e.currentTarget)}
                onKeyUp={(e) => {
                  captureClaudeCaret(e.currentTarget);
                  // Track caret moves (arrows/home/end) so the @token stays current,
                  // but let the menu's own ArrowUp/Down handling win when it's open.
                  if (fileMenuOpen && (e.key === "ArrowUp" || e.key === "ArrowDown")) return;
                  syncFileToken(e.currentTarget);
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
              {fileToken &&
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
            <div className="modal-actions">
              <button className="act" disabled={launching} onClick={() => setClaudeOpen(false)}>
                Cancel
              </button>
              <button
                className="act primary"
                disabled={launching || !claudePrompt.trim()}
                onClick={submitClaude}
              >
                {launching ? "Launching…" : "Launch"}
              </button>
            </div>
          </div>
        </div>
      )}

      {launchedSession && (
        <div className="sel-bar">
          <span className="sel-info">
            Launched <code>{launchedSession}</code> · attach with{" "}
            <code>tmux attach -t {launchedSession}</code>
          </span>
          <button
            className="sel-act"
            onClick={() => navigator.clipboard.writeText(`tmux attach -t ${launchedSession}`)}
          >
            Copy
          </button>
          <button className="sel-x" title="Dismiss" onClick={() => setLaunchedSession(null)}>
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
                  if (e.key === "Escape") setDirsOpen(false);
                }}
              />
              <label>Path</label>
              <input
                value={dirForm.path}
                placeholder="~/work or /Users/me/project"
                onChange={(e) => setDirForm((f) => ({ ...f, path: e.target.value }))}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Escape") setDirsOpen(false);
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
                  if (e.key === "Escape") setDirsOpen(false);
                  if (e.key === "Enter") {
                    e.preventDefault();
                    saveDir();
                  }
                }}
              />
              <div className="dir-form-hint">Leave empty to auto-detect git subdirectories.</div>
            </div>
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
