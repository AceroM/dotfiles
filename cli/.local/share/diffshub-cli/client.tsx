import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  repo: string;
  cwd: string; // absolute dir new claude sessions launch in; roots @-file refs
  branch: string;
  workspace: boolean;
  editor: string;
  repos: RepoMeta[];
}

// A line range highlighted in one rendered diff, driving the action bar.
interface DiffSelection {
  fileKey: string;
  range: SelectedLineRange;
}

type Tab = "commits" | "prs" | "changes" | "manual";

const TAB_ORDER: Tab[] = ["commits", "prs", "changes", "manual"];

interface ManualPatch {
  name: string;
  contents: string;
}

type View =
  | { kind: "commit"; sha: string; repo?: string }
  | { kind: "pr"; number: number; repo?: string }
  | { kind: "changes" }
  | { kind: "manual"; name: string }
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

function initialView(): { tab: Tab; view: View } {
  const params = new URLSearchParams(location.search);
  const repo = params.get("repo") ?? undefined;
  const pr = params.get("pr");
  if (pr) return { tab: "prs", view: { kind: "pr", number: parseInt(pr, 10), repo } };
  if (params.get("view") === "changes") return { tab: "changes", view: { kind: "changes" } };
  const manual = params.get("manual");
  if (manual) return { tab: "manual", view: { kind: "manual", name: manual } };
  const sha = params.get("sha");
  if (sha) return { tab: "commits", view: { kind: "commit", sha, repo } };
  return { tab: "commits", view: { kind: "none" } };
}

function App() {
  const initial = useMemo(initialView, []);
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>(initial.tab);
  const [view, setView] = useState<View>(initial.view);

  // Whether the Changes view auto-refreshes (polling + window focus). Toggle
  // with `v`; `space` forces a one-off refresh of whatever tab you're on.
  // Defaults to off and persists across reloads via localStorage.
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
  const metaQuery = useQuery({
    queryKey: ["meta"],
    queryFn: ({ signal }) => fetchJSON<Meta>("/api/meta", signal),
    staleTime: Infinity,
  });
  const meta = metaQuery.data ?? null;
  const workspace = !!meta?.workspace;

  // Commits are paginated; useInfiniteQuery stitches the pages together and the
  // "Load more" button just asks for the next one.
  const commitsQuery = useInfiniteQuery({
    queryKey: ["commits"],
    queryFn: ({ pageParam, signal }) =>
      fetchJSON<Commit[]>(`/api/commits?page=${pageParam}`, signal),
    initialPageParam: 1,
    getNextPageParam: (lastPage, allPages) => (lastPage.length > 0 ? allPages.length + 1 : undefined),
  });
  const commits = useMemo(() => commitsQuery.data?.pages.flat() ?? [], [commitsQuery.data]);
  const hasMore = commitsQuery.hasNextPage;
  const loadingMore = commitsQuery.isFetchingNextPage;

  const prsQuery = useQuery({
    queryKey: ["prs"],
    queryFn: ({ signal }) => fetchJSON<PR[]>("/api/prs", signal),
    enabled: tab === "prs",
  });
  const prs = prsQuery.data ?? null;
  const prError = errMessage(prsQuery.error);

  const manualQuery = useQuery({
    queryKey: ["manual"],
    queryFn: ({ signal }) => fetchJSON<ManualPatch[]>("/api/manual", signal),
    enabled: tab === "manual" || initial.tab === "manual",
  });
  const manualPatches = manualQuery.data ?? null;
  const manualError = errMessage(manualQuery.error);

  const changesQuery = useQuery({
    queryKey: ["changes"],
    queryFn: ({ signal }) => fetchJSON<RepoChanges[]>("/api/changes", signal),
    enabled: tab === "changes",
    // Poll + refetch-on-focus only while auto-refresh is on. Structural sharing
    // keeps `data` referentially stable when nothing changed, so a poll that
    // finds no diff doesn't re-render the view — replacing the old manual
    // JSON.stringify dedup.
    refetchInterval: autoRefresh && tab === "changes" ? 2500 : false,
    refetchOnWindowFocus: autoRefresh,
  });
  const changes = changesQuery.data ?? null;

  const [busyPath, setBusyPath] = useState<string | null>(null);

  // Commit & push dialog (Changes view, `;`)
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState(false);

  // New Claude session dialog (`'`) — launches an interactive claude tmux
  // session in the dh directory, detached, seeded with the typed prompt.
  const [claudeOpen, setClaudeOpen] = useState(false);
  const [claudePrompt, setClaudePrompt] = useState("");
  const [launching, setLaunching] = useState(false);
  const [launchedSession, setLaunchedSession] = useState<string | null>(null);

  // Auto-dismiss the "Launched" banner after a short period.
  useEffect(() => {
    if (!launchedSession) return;
    const id = window.setTimeout(() => setLaunchedSession(null), 5000);
    return () => window.clearTimeout(id);
  }, [launchedSession]);

  const [filter, setFilter] = useState("");

  // ---- Diff for the active commit/PR view ----
  // Keyed by sha/number+repo so revisiting one is instant from cache; commit
  // diffs are immutable so they never go stale.
  const diffKey = useMemo<readonly unknown[]>(() => {
    if (view.kind === "commit") return ["diff", "commit", view.sha, view.repo ?? null];
    if (view.kind === "pr") return ["diff", "pr", view.number, view.repo ?? null];
    return ["diff", "none"];
  }, [view]);
  const diffQuery = useQuery({
    queryKey: diffKey,
    queryFn: ({ signal }) => {
      if (view.kind !== "commit" && view.kind !== "pr") throw new Error("no diff");
      const rp = view.repo ? `?repo=${encodeURIComponent(view.repo)}` : "";
      const url =
        view.kind === "commit" ? `/api/diff/${view.sha}${rp}` : `/api/diff/pr/${view.number}${rp}`;
      return fetchText(url, signal);
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

  // ---- Reviewed commits (persisted server-side in sqlite) ----
  const reviewedQuery = useQuery({
    queryKey: ["reviewed"],
    queryFn: ({ signal }) => fetchJSON<string[]>("/api/reviewed", signal),
    staleTime: Infinity,
  });
  const reviewed = useMemo(() => new Set(reviewedQuery.data ?? []), [reviewedQuery.data]);
  // Optimistically flip the reviewed flag in the cache, then persist; roll the
  // cache back to its previous value if the request fails.
  const toggleReviewed = useCallback(
    (sha: string, repo?: string) => {
      const prev = queryClient.getQueryData<string[]>(["reviewed"]) ?? [];
      const on = !prev.includes(sha);
      queryClient.setQueryData<string[]>(
        ["reviewed"],
        on ? [...prev, sha] : prev.filter((s) => s !== sha),
      );
      fetch("/api/reviewed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sha, reviewed: on, repo }),
      }).catch(() => queryClient.setQueryData(["reviewed"], prev));
    },
    [queryClient],
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
        const res = await fetch("/api/git", {
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
    [queryClient],
  );

  // Open a file (optionally at a line) in the default editor, server-side
  const openInEditor = useCallback(
    (path: string, line?: number, repo?: string, worktree?: string) => {
      fetch("/api/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, line, repo, worktree }),
      }).catch(() => {});
    },
    [],
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
      const res = await fetch("/api/commit", {
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
  }, [commitMsg, changes, queryClient]);

  // Launch a new interactive claude session in the dh directory (detached).
  const submitClaude = useCallback(async () => {
    const prompt = claudePrompt.trim();
    if (!prompt) return;
    setLaunching(true);
    try {
      const res = await fetch("/api/claude", {
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
  }, [claudePrompt]);

  const selectTab = useCallback((next: Tab) => {
    setTab(next);
    setFilter("");
    // The per-tab queries fetch themselves via their `enabled` flag; we only
    // need to point the view at the right thing and update the URL.
    if (next === "changes") {
      setView({ kind: "changes" });
      history.replaceState(null, "", "/?view=changes");
    }
    if (next === "manual") {
      setView({ kind: "manual", name: "" });
      history.replaceState(null, "", "/?manual=");
    }
  }, []);

  const selectCommit = useCallback((sha: string, repo?: string) => {
    setView({ kind: "commit", sha, repo });
    const rp = repo ? `&repo=${encodeURIComponent(repo)}` : "";
    history.replaceState(null, "", `/?sha=${sha}${rp}`);
  }, []);

  const selectPr = useCallback((number: number, repo?: string) => {
    setView({ kind: "pr", number, repo });
    const rp = repo ? `&repo=${encodeURIComponent(repo)}` : "";
    history.replaceState(null, "", `/?pr=${number}${rp}`);
  }, []);

  const selectManual = useCallback((name: string) => {
    setView({ kind: "manual", name });
    history.replaceState(null, "", `/?manual=${encodeURIComponent(name)}`);
  }, []);

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
      const res = await fetch("/api/delete-lines", {
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
  }, [selFile, selection, view, queryClient]);

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
  const keyCtx = useRef({ tab, view, visibleCommits, visiblePrs, visibleManual, selection });
  keyCtx.current = { tab, view, visibleCommits, visiblePrs, visibleManual, selection };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { tab, view, visibleCommits, visiblePrs, visibleManual } = keyCtx.current;
      const target = (e.composedPath()[0] ?? e.target) as HTMLElement;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target.isContentEditable;
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
      // 1–4 jump straight to a tab
      if (e.key >= "1" && e.key <= String(TAB_ORDER.length)) {
        e.preventDefault();
        selectTab(TAB_ORDER[Number(e.key) - 1]);
        return;
      }
      // `v` toggles auto-refresh while on the Changes tab
      if (e.key === "v" && tab === "changes") {
        e.preventDefault();
        setAutoRefresh((v) => !v);
        return;
      }
      // Space forces a refresh of the current tab: resetting the query drops its
      // cached data, so the sidebar skeleton + content spinner flash while it
      // refetches.
      if (e.key === " ") {
        e.preventDefault();
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
      const down = e.key === "ArrowDown" || e.key === "j";
      const up = e.key === "ArrowUp" || e.key === "k";
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
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectCommit, selectPr, selectManual, selectTab, toggleReviewed, toggleCollapsed, queryClient]);

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

  return (
    <div className="layout">
      <nav className="commits">
        <header className="commits-header">
          <h1>
            diffshub
            {meta && (
              <span className="repo">
                {meta.repo}
                {meta.branch ? ` @ ${meta.branch}` : ""}
              </span>
            )}
          </h1>
          <div className="tabs">
            <button className={tab === "commits" ? "on" : ""} onClick={() => selectTab("commits")}>
              Commits
            </button>
            <button className={tab === "prs" ? "on" : ""} onClick={() => selectTab("prs")}>
              PRs
            </button>
            <button className={tab === "changes" ? "on" : ""} onClick={() => selectTab("changes")}>
              Changes
            </button>
            <button className={tab === "manual" ? "on" : ""} onClick={() => selectTab("manual")}>
              Manual{manualPatches && manualPatches.length > 0 ? ` (${manualPatches.length})` : ""}
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
                title="Toggle auto-refresh (V)"
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
        <div className="kbd-hints">
          <span>
            <kbd>1-4</kbd>/<kbd>←/→</kbd> tabs
          </span>
          <span>
            <kbd>↑/↓</kbd> navigate
          </span>
          <span>
            <kbd>space</kbd> refresh
          </span>
          {tab === "changes" && (
            <span>
              <kbd>v</kbd> auto-refresh
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

      <main className="diffs" ref={mainEl}>
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
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitCommit();
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
                <kbd>⌘↵</kbd> commit
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
            <textarea
              autoFocus
              className="commit-input"
              placeholder="Prompt for a new Claude Code session…"
              value={claudePrompt}
              onChange={(e) => setClaudePrompt(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") setClaudeOpen(false);
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey || e.altKey)) {
                  e.preventDefault();
                  submitClaude();
                }
              }}
            />
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
                Detached <code>claude</code> in tmux
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
