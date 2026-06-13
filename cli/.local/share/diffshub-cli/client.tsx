import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type Dispatch,
  type MutableRefObject,
  type ReactNode,
  type SetStateAction,
} from "react";
import { createRoot } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { parsePatchFiles, type FileDiffMetadata, type SelectedLineRange } from "@pierre/diffs";
import { FileDiff, MultiFileDiff } from "@pierre/diffs/react";
import type { GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import {
  GitCommitHorizontal,
  GitPullRequest,
  FileDiff as FileDiffIcon,
  FileStack,
  SquareTerminal,
  Sparkles,
} from "lucide-react";

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

const TAB_ORDER: Tab[] = ["commits", "prs", "changes", "manual", "tmux"];

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
          options={{ ...DIFF_OPTIONS, ...selectionOptions }}
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
            options={{ ...DIFF_OPTIONS, ...selectionOptions }}
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

// A fenced code block with a language label + copy button (ChatGPT-style).
const CodeBlock = memo(function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
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
      <pre>
        <code>{code}</code>
      </pre>
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

// One conversation turn: a user turn is a right-aligned bubble; an assistant turn
// is a left avatar + content stack (markdown text, tool calls, tool results).
const TranscriptTurn = memo(function TranscriptTurn({
  role,
  msgs,
}: {
  role: "user" | "assistant";
  msgs: TranscriptMsg[];
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
      <div className="avatar">
        <Sparkles size={15} />
      </div>
      <div className="content">
        {msgs.map((m, i) => {
          if (m.kind === "tool_use")
            return (
              <div key={i} className="tool-use">
                <span className="tool-name">{m.tool}</span>
                {m.text ? <span className="tool-arg">{m.text}</span> : null}
              </div>
            );
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
  return { tab: "commits", view: { kind: "none" }, dir };
}

function App() {
  const initial = useMemo(initialView, []);
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>(initial.tab);
  const [view, setView] = useState<View>(initial.view);

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

  const [busyPath, setBusyPath] = useState<string | null>(null);

  // Commit & push dialog (Changes view, `;`)
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState(false);

  // New Claude session dialog (`'`) — launches an interactive claude tmux
  // session in the active directory, detached, seeded with the typed prompt.
  const [claudeOpen, setClaudeOpen] = useState(false);
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

  // Directory dropdown (top-left) + settings dialog (manage directories).
  const [dirMenuOpen, setDirMenuOpen] = useState(false);
  const [dirsOpen, setDirsOpen] = useState(false);

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
          }
        });
        return next;
      });
      setFileToken(null);
    },
    [fileToken],
  );
  const fileMenuOpen = !!fileToken && fileSuggestions.length > 0;

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
  // Land on the newest commit once the first page arrives — unless the URL
  // already pinned a specific commit/PR/changes/manual view.
  useEffect(() => {
    const first = commits[0];
    if (!first) return;
    setView((v) => (v.kind === "none" ? { kind: "commit", sha: first.sha, repo: first.repo } : v));
  }, [commits]);

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
        return next;
      });
    },
    [],
  );
  const insertIntoPrompt = useCallback(
    (insert: string) => insertAtCaret(claudeTextareaRef, setClaudePrompt, insert),
    [insertAtCaret],
  );
  const insertIntoReply = useCallback(
    (insert: string) => insertAtCaret(replyTextareaRef, setReplyText, insert),
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
      setLaunchedSession(typeof body.session === "string" ? body.session : null);
    } finally {
      setLaunching(false);
    }
  }, [claudePrompt, qd]);

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
      // Give claude a beat to accept the keys before reading the transcript back.
      setTimeout(() => {
        queryClient.refetchQueries({ queryKey: ["tmux-transcript", session] });
        queryClient.refetchQueries({ queryKey: ["tmux-sessions"] });
      }, 500);
    } finally {
      setReplySending(false);
    }
  }, [replyText, queryClient]);

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

  const selectTab = useCallback(
    (next: Tab) => {
      setTab(next);
      setFilter("");
      // The per-tab queries fetch themselves via their `enabled` flag; we only
      // need to point the view at the right thing and update the URL.
      if (next === "changes") {
        setView({ kind: "changes" });
        history.replaceState(null, "", navUrl("view=changes"));
      }
      if (next === "manual") {
        setView({ kind: "manual", name: "" });
        history.replaceState(null, "", navUrl("manual="));
      }
      if (next === "tmux") {
        setView({ kind: "tmux", session: "" });
        history.replaceState(null, "", navUrl("tmux="));
      }
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
      if (selectedSessionRef.current === name) selectTmux(next);
      tmuxQuery.refetch();
    },
    [tmuxSessions, selectTmux, tmuxQuery],
  );

  // On the Tmux tab, auto-select the first session once the list loads (or when
  // the selected session disappears, e.g. after a kill) so the transcript pane
  // always shows something to read.
  useEffect(() => {
    if (tab !== "tmux" || !tmuxSessions) return;
    const exists = selectedSession && tmuxSessions.some((s) => s.name === selectedSession);
    if (!exists && tmuxSessions.length) selectTmux(tmuxSessions[0].name);
  }, [tab, tmuxSessions, selectedSession, selectTmux]);

  // Drop any half-typed reply when the selected session changes.
  useEffect(() => {
    setReplyText("");
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

  // Switch the active directory: land on its newest commit and reset the URL.
  const selectDir = useCallback((id: number | null) => {
    setActiveDir(id);
    activeDirRef.current = id;
    setTab("commits");
    setView({ kind: "none" });
    setFilter("");
    setDirMenuOpen(false);
    history.replaceState(null, "", id != null ? `/?dir=${id}` : "/");
  }, []);

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
      q && tmuxSessions
        ? tmuxSessions.filter(
            (s) =>
              s.name.toLowerCase().includes(q) ||
              s.cwd.toLowerCase().includes(q) ||
              s.task.toLowerCase().includes(q),
          )
        : tmuxSessions,
    [tmuxSessions, q],
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
        searchEl.current?.focus();
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
      // Leave keys alone while focus is inside the file tree (it has its own nav)
      if (e.composedPath().some((n) => n instanceof HTMLElement && n.classList?.contains("tree"))) {
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
      // 1–5 jump straight to a tab
      if (e.key >= "1" && e.key <= String(TAB_ORDER.length)) {
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
      if (e.key === "'") {
        e.preventDefault();
        // If lines are highlighted, clear the prompt and replace it with their
        // @-file reference so the new session lands with just that context.
        const ref = claudeRefRef.current;
        if (ref) setClaudePrompt(`${ref} `);
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
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectCommit, selectPr, selectManual, selectTab, selectTmux, killSession, toggleReviewed, toggleCollapsed, runGit, commitWithClaude, queryClient]);

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

  return (
    <div className="layout">
      <nav className="commits">
        <header className="commits-header">
          <div className="dir-dropdown">
            <button
              className="dir-trigger"
              title="Switch directory"
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
                {dirs.map((d) => (
                  <button
                    key={d.id}
                    className={`dir-item${d.id === currentDirId ? " on" : ""}`}
                    onClick={() => selectDir(d.id)}
                  >
                    <span className="dir-item-name">
                      {d.name}
                      {d.id === defaultDirId ? " · launch" : ""}
                    </span>
                    <span className="dir-item-path">{d.path}</span>
                  </button>
                ))}
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
              className={tab === "changes" ? "on" : ""}
              data-tip="Changes"
              aria-label="Changes"
              onClick={() => selectTab("changes")}
            >
              <FileDiffIcon />
            </button>
            <button
              className={tab === "manual" ? "on" : ""}
              data-tip="Manual patches"
              aria-label="Manual patches"
              onClick={() => selectTab("manual")}
            >
              <FileStack />
              {manualPatches && manualPatches.length > 0 && (
                <span className="tab-badge">{manualPatches.length}</span>
              )}
            </button>
            <button
              className={tab === "tmux" ? "on" : ""}
              data-tip="Tmux sessions"
              aria-label="Tmux sessions"
              onClick={() => selectTab("tmux")}
            >
              <SquareTerminal />
              {tmuxSessions && tmuxSessions.length > 0 && (
                <span className="tab-badge">{tmuxSessions.length}</span>
              )}
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
            {worktreeSegments.map((seg) => (
              <div key={seg.segment || "_"}>
                {seg.segment && <div className="wt-label">{seg.segment}</div>}
                {seg.groups.map((group) => (
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
            ))}
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
            {tmuxSessions !== null && tmuxSessions.length === 0 && (
              <div className="side-note">No claude tmux sessions</div>
            )}
          </div>
        )}

        <div className="kbd-hints">
          <span>
            <kbd>1-5</kbd>/<kbd>←/→</kbd> tabs
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
            <kbd>/</kbd> filter
          </span>
        </div>
      </nav>

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
                  turns.map((t, i) => <TranscriptTurn key={i} role={t.role} msgs={t.msgs} />)
                )}
                {selectedBusy && (
                  <div className="turn assistant">
                    <div className="avatar">
                      <Sparkles size={15} />
                    </div>
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
                  onChange={(e) => setReplyText(e.target.value)}
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
        {diffLoading && <ContentSpinner label="Loading diff…" />}
        {view.kind === "changes" && changes === null && <ContentSpinner label="Loading changes…" />}
        {view.kind === "manual" && manualPatches === null && !manualError && (
          <ContentSpinner label="Loading patches…" />
        )}
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

      {tab !== "tmux" && (
      <aside className="tree">
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
              className="commit-input"
              placeholder="Commit message…"
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
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
                className="commit-input"
                placeholder="Prompt for a new Claude Code session…  (type @ to reference a file, ⌃V to paste an image)"
                value={claudePrompt}
                onChange={(e) => {
                  setClaudePrompt(e.target.value);
                  syncFileToken(e.target);
                }}
                onPaste={handleClaudePaste}
                onClick={(e) => syncFileToken(e.currentTarget)}
                onKeyUp={(e) => {
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
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setFileToken(null);
                      return;
                    }
                  }
                  if (e.key === "Escape") setClaudeOpen(false);
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey || e.altKey)) {
                    e.preventDefault();
                    submitClaude();
                  }
                }}
              />
              {fileToken && (
                <div className="file-menu">
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
                </div>
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
            <div className="modal-hint">
              <span>
                {imgUploading ? (
                  "Uploading image…"
                ) : (
                  <>
                    Detached <code>claude</code> in tmux
                  </>
                )}
              </span>
              <span>
                <kbd>⌃V</kbd> paste image
              </span>
              <span>
                <kbd>⌘↵</kbd> / <kbd>⌥↵</kbd> launch
              </span>
              <span>
                <kbd>esc</kbd> cancel
              </span>
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
