import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
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

interface Changes {
  staged: ChangeEntry[];
  unstaged: ChangeEntry[];
  untracked: UntrackedEntry[];
  stagedDiff: string;
  unstagedDiff: string;
}

interface Meta {
  repo: string;
  branch: string;
}

type Tab = "commits" | "prs" | "changes";

type View =
  | { kind: "commit"; sha: string }
  | { kind: "pr"; number: number }
  | { kind: "changes" }
  | { kind: "none" };

type GitAction = "stage" | "unstage" | "stash";

interface SectionFile {
  key: string;
  path: string;
  fileDiff?: FileDiffMetadata;
  untracked?: UntrackedEntry;
  actions: GitAction[];
}

interface Section {
  label: string | null;
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
  themeType: "dark",
  stickyHeader: true,
  lineHoverHighlight: "line",
} as const;

function initialView(): { tab: Tab; view: View } {
  const params = new URLSearchParams(location.search);
  const pr = params.get("pr");
  if (pr) return { tab: "prs", view: { kind: "pr", number: parseInt(pr, 10) } };
  if (params.get("view") === "changes") return { tab: "changes", view: { kind: "changes" } };
  const sha = params.get("sha");
  if (sha) return { tab: "commits", view: { kind: "commit", sha } };
  return { tab: "commits", view: { kind: "none" } };
}

function App() {
  const initial = useMemo(initialView, []);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [tab, setTab] = useState<Tab>(initial.tab);
  const [view, setView] = useState<View>(initial.view);

  const [commits, setCommits] = useState<Commit[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const [prs, setPrs] = useState<PR[] | null>(null);
  const [prError, setPrError] = useState("");

  const [changes, setChanges] = useState<Changes | null>(null);
  const [busyPath, setBusyPath] = useState<string | null>(null);

  // Commit & push dialog (Changes view, `;`)
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState("");
  const [committing, setCommitting] = useState(false);

  const [diffText, setDiffText] = useState("");
  const [diffState, setDiffState] = useState<"idle" | "loading" | "error">("idle");
  const [diffError, setDiffError] = useState("");
  const [filter, setFilter] = useState("");

  const fileEls = useRef(new Map<string, HTMLDivElement>());
  const mainEl = useRef<HTMLDivElement | null>(null);
  const searchEl = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    fetch("/api/meta")
      .then((r) => r.json())
      .then(setMeta)
      .catch(() => {});
  }, []);

  // ---- Reviewed commits (persisted server-side in sqlite) ----
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const reviewedRef = useRef(reviewed);
  reviewedRef.current = reviewed;
  useEffect(() => {
    fetch("/api/reviewed")
      .then((r) => r.json())
      .then((shas: string[]) => setReviewed(new Set(shas)))
      .catch(() => {});
  }, []);
  const toggleReviewed = useCallback((sha: string) => {
    const on = !reviewedRef.current.has(sha);
    setReviewed((prev) => {
      const next = new Set(prev);
      if (on) next.add(sha);
      else next.delete(sha);
      return next;
    });
    fetch("/api/reviewed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha, reviewed: on }),
    }).catch(() => {});
  }, []);

  // ---- Commits ----
  const loadCommits = useCallback(async (pageNum: number) => {
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/commits?page=${pageNum}`);
      if (!res.ok) throw new Error(await res.text());
      const batch: Commit[] = await res.json();
      setCommits((prev) => (pageNum === 1 ? batch : [...prev, ...batch]));
      setHasMore(batch.length > 0);
      setPage(pageNum);
      return batch;
    } finally {
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    loadCommits(1)
      .then((batch) => {
        setView((v) => (v.kind === "none" && batch[0] ? { kind: "commit", sha: batch[0].sha } : v));
      })
      .catch((err) => {
        setDiffState("error");
        setDiffError(`Failed to list commits: ${err.message}`);
      });
  }, [loadCommits]);

  // ---- PRs ----
  const loadPrs = useCallback(() => {
    fetch("/api/prs")
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        return res.json();
      })
      .then((list: PR[]) => {
        setPrs(list);
        setPrError("");
      })
      .catch((err) => setPrError(String(err.message ?? err)));
  }, []);

  // ---- Pending changes ----
  const loadChanges = useCallback(async () => {
    const res = await fetch("/api/changes");
    if (!res.ok) throw new Error(await res.text());
    const next: Changes = await res.json();
    // Skip the state update (and the diff re-render it triggers) when nothing
    // actually changed — keeps interval polling from flickering the view.
    setChanges((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, []);

  const runGit = useCallback(
    async (action: GitAction, path?: string) => {
      setBusyPath(path ?? "*");
      try {
        const res = await fetch("/api/git", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, path }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}) as any);
          alert(`${action} failed: ${body.error ?? res.statusText}`);
        }
      } finally {
        setBusyPath(null);
        loadChanges().catch(() => {});
      }
    },
    [loadChanges],
  );

  // Open a file (optionally at a line) in the default editor, server-side
  const openInEditor = useCallback((path: string, line?: number) => {
    fetch("/api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, line }),
    }).catch(() => {});
  }, []);

  // Click a diff line to open that file at that line — unless the user is
  // actually selecting text, in which case leave the selection alone.
  const onDiffLineClick = useCallback(
    (path: string, lineNumber?: number) => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      openInEditor(path, typeof lineNumber === "number" ? lineNumber : undefined);
    },
    [openInEditor],
  );

  // Commit staged changes + push, detached in `tmux -L bg`
  const submitCommit = useCallback(async () => {
    const message = commitMsg.trim();
    if (!message) return;
    setCommitting(true);
    try {
      const res = await fetch("/api/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as any);
        alert(`commit failed: ${body.error ?? res.statusText}`);
        return;
      }
      setCommitOpen(false);
      setCommitMsg("");
      // The commit/push runs async in tmux; nudge a refresh so the cleared
      // working tree shows up (interval polling will also catch it).
      setTimeout(() => loadChanges().catch(() => {}), 600);
    } finally {
      setCommitting(false);
    }
  }, [commitMsg, loadChanges]);

  const selectTab = useCallback(
    (next: Tab) => {
      setTab(next);
      setFilter("");
      if (next === "prs" && prs === null) loadPrs();
      if (next === "changes") {
        setView({ kind: "changes" });
        history.replaceState(null, "", "/?view=changes");
        loadChanges().catch(() => {});
      }
    },
    [prs, loadPrs, loadChanges],
  );

  // Keep pending changes fresh while looking at them: refetch on window focus
  // and on a light interval, so a background commit/push (run in `tmux -L bg`)
  // is reflected here within a couple of seconds without any manual refresh.
  useEffect(() => {
    if (view.kind !== "changes") return;
    const refresh = () => loadChanges().catch(() => {});
    window.addEventListener("focus", refresh);
    const id = window.setInterval(refresh, 2500);
    return () => {
      window.removeEventListener("focus", refresh);
      window.clearInterval(id);
    };
  }, [view.kind, loadChanges]);

  // ---- Diff fetching for commit/pr views ----
  useEffect(() => {
    if (view.kind !== "commit" && view.kind !== "pr") return;
    const url = view.kind === "commit" ? `/api/diff/${view.sha}` : `/api/diff/pr/${view.number}`;
    const controller = new AbortController();
    setDiffState("loading");
    fetch(url, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        return res.text();
      })
      .then((text) => {
        setDiffText(text);
        setDiffState("idle");
        mainEl.current?.scrollTo({ top: 0 });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setDiffState("error");
        setDiffError(String(err.message ?? err));
      });
    return () => controller.abort();
  }, [view]);

  const selectCommit = useCallback((sha: string) => {
    setView({ kind: "commit", sha });
    history.replaceState(null, "", `/?sha=${sha}`);
  }, []);

  const selectPr = useCallback((number: number) => {
    setView({ kind: "pr", number });
    history.replaceState(null, "", `/?pr=${number}`);
  }, []);

  // ---- Sections rendered in the center column ----
  const sections = useMemo<Section[]>(() => {
    if (view.kind === "commit" || view.kind === "pr") {
      if (diffState !== "idle") return [];
      const cacheKey = view.kind === "commit" ? view.sha : `pr-${view.number}`;
      const files = parsePatchFiles(diffText, cacheKey).flatMap((p) => p.files);
      return [
        {
          label: null,
          files: files.map((f) => ({ key: `main:${f.name}`, path: f.name, fileDiff: f, actions: [] })),
        },
      ];
    }
    if (view.kind === "changes" && changes) {
      const out: Section[] = [];
      if (changes.staged.length) {
        const files = parsePatchFiles(changes.stagedDiff).flatMap((p) => p.files);
        out.push({
          label: "Staged",
          files: files.map((f) => ({
            key: `staged:${f.name}`,
            path: f.name,
            fileDiff: f,
            actions: ["unstage", "stash"],
          })),
        });
      }
      const unstagedFiles: SectionFile[] = parsePatchFiles(changes.unstagedDiff)
        .flatMap((p) => p.files)
        .map((f) => ({
          key: `unstaged:${f.name}`,
          path: f.name,
          fileDiff: f,
          actions: ["stage", "stash"] as GitAction[],
        }));
      for (const u of changes.untracked) {
        unstagedFiles.push({
          key: `untracked:${u.path}`,
          path: u.path,
          untracked: u,
          actions: ["stage", "stash"],
        });
      }
      if (unstagedFiles.length) out.push({ label: "Unstaged", files: unstagedFiles });
      return out;
    }
    return [];
  }, [view, diffText, diffState, changes]);

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
      if (hit) return hit.path;
    }
    return null;
  }, [activeKey, sections]);
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;

  // ---- Per-file collapse, toggled with `c` on the actively viewed file ----
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(new Set());
  useEffect(() => setCollapsedKeys(new Set()), [view]);
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
      const hit = section.files.find((f) => f.path === paths[0]);
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
        statusByPath.set(f.path, status);
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

  const activeCommit = view.kind === "commit" ? commits.find((c) => c.sha === view.sha) : null;
  const activePr = view.kind === "pr" ? prs?.find((p) => p.number === view.number) : null;
  const changeCount = changes
    ? changes.staged.length + changes.unstaged.length + changes.untracked.length
    : null;

  // ---- Keyboard navigation (agents-cli style) ----
  const keyCtx = useRef({ tab, view, visibleCommits, visiblePrs });
  keyCtx.current = { tab, view, visibleCommits, visiblePrs };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { tab, view, visibleCommits, visiblePrs } = keyCtx.current;
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
      // Leave keys alone while focus is inside the file tree (it has its own nav)
      if (e.composedPath().some((n) => n instanceof HTMLElement && n.classList?.contains("tree"))) {
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
          toggleReviewed(view.sha);
          return;
        }
      }
      if (e.key === "c") {
        e.preventDefault();
        toggleCollapsed();
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
        selectCommit(visibleCommits[next].sha);
        document
          .getElementById(`row-commit-${visibleCommits[next].sha}`)
          ?.scrollIntoView({ block: "nearest" });
      } else if (tab === "prs" && visiblePrs?.length) {
        e.preventDefault();
        const idx = view.kind === "pr" ? visiblePrs.findIndex((p) => p.number === view.number) : -1;
        const next = down
          ? idx + 1 >= visiblePrs.length
            ? 0
            : idx + 1
          : idx <= 0
            ? visiblePrs.length - 1
            : idx - 1;
        selectPr(visiblePrs[next].number);
        document
          .getElementById(`row-pr-${visiblePrs[next].number}`)
          ?.scrollIntoView({ block: "nearest" });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectCommit, selectPr, toggleReviewed, toggleCollapsed]);

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
          runGit(a, file.path);
        }}
      >
        {ACTION_LABELS[a].label}
      </button>
    ));

  const changeGroups: { label: string; files: SectionFile[] }[] = sections
    .filter((s) => s.label)
    .map((s) => ({ label: s.label!, files: s.files }));

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
              Changes{changeCount !== null && changeCount > 0 ? ` (${changeCount})` : ""}
            </button>
          </div>
          {tab !== "changes" && (
            <input
              ref={searchEl}
              type="text"
              placeholder={tab === "commits" ? "Filter commits…" : "Filter PRs…"}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          )}
        </header>

        {tab === "commits" && (
          <div className="commit-list">
            {visibleCommits.map((c) => (
              <div
                key={c.sha}
                id={`row-commit-${c.sha}`}
                className={`commit${view.kind === "commit" && c.sha === view.sha ? " active" : ""}${reviewed.has(c.sha) ? " reviewed" : ""}`}
                onClick={() => selectCommit(c.sha)}
              >
                <span className="commit-msg">{c.message.split("\n")[0]}</span>
                <span className="commit-meta">
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
                    toggleReviewed(c.sha);
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
                onClick={() => loadCommits(page + 1).catch(() => {})}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            )}
          </div>
        )}

        {tab === "prs" && (
          <div className="commit-list">
            {prs === null && !prError && <div className="side-note">Loading PRs…</div>}
            {prError && <div className="side-note error">{prError}</div>}
            {visiblePrs?.map((p) => (
              <button
                key={p.number}
                id={`row-pr-${p.number}`}
                className={`commit${view.kind === "pr" && p.number === view.number ? " active" : ""}`}
                onClick={() => selectPr(p.number)}
              >
                <span className="commit-msg">
                  {p.isDraft ? "✎ " : ""}
                  {p.title}
                </span>
                <span className="commit-meta">
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

        {tab === "changes" && (
          <div className="commit-list">
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
            {changes === null && <div className="side-note">Loading…</div>}
            {changes !== null && changeCount === 0 && (
              <div className="side-note">Working tree clean ✨</div>
            )}
            {changeGroups.map((group) => (
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
                      onClick={() => runGit("stage")}
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
        )}
        <div className="kbd-hints">
          <span>
            <kbd>↑/↓</kbd> navigate
          </span>
          <span>
            <kbd>;</kbd> {tab === "changes" ? "commit" : "reviewed"}
          </span>
          <span>
            <kbd>c</kbd> collapse
          </span>
          <span>
            <kbd>/</kbd> filter
          </span>
        </div>
      </nav>

      <main className="diffs" ref={mainEl}>
        {diffState === "loading" && view.kind !== "changes" && (
          <div className="empty">
            <div className="spinner" aria-label="Loading diff" />
          </div>
        )}
        {diffState === "error" && view.kind !== "changes" && (
          <div className="empty error">{diffError}</div>
        )}
        {view.kind === "changes" && changes !== null && changeCount === 0 && (
          <div className="empty">Working tree clean — nothing pending</div>
        )}
        {(view.kind === "commit" || view.kind === "pr") &&
          diffState === "idle" &&
          sections.every((s) => !s.files.length) && <div className="empty">No file changes</div>}

        {sections.map((section) => (
          <div key={section.label ?? "main"}>
            {section.label && <h3 className="section-label">{section.label}</h3>}
            {section.files.map((f) => (
              <div
                key={f.key}
                className={`file-diff${f.key === activeKey ? " viewing" : ""}`}
                ref={(el) => {
                  if (el) fileEls.current.set(f.key, el);
                  else fileEls.current.delete(f.key);
                }}
              >
                {f.fileDiff && (
                  <FileDiff
                    fileDiff={f.fileDiff}
                    options={{
                      ...DIFF_OPTIONS,
                      collapsed: collapsedKeys.has(f.key),
                      onLineClick: (p: { lineNumber?: number }) => onDiffLineClick(f.path, p.lineNumber),
                    }}
                    disableWorkerPool
                    renderHeaderMetadata={
                      f.actions.length ? () => <span className="hdr-acts">{actionButtons(f)}</span> : undefined
                    }
                  />
                )}
                {f.untracked &&
                  (f.untracked.contents !== null ? (
                    <MultiFileDiff
                      oldFile={{ name: f.path, contents: "" }}
                      newFile={{ name: f.path, contents: f.untracked.contents }}
                      options={{
                        ...DIFF_OPTIONS,
                        collapsed: collapsedKeys.has(f.key),
                        onLineClick: (p: { lineNumber?: number }) => onDiffLineClick(f.path, p.lineNumber),
                      }}
                      disableWorkerPool
                      renderHeaderMetadata={() => <span className="hdr-acts">{actionButtons(f)}</span>}
                    />
                  ) : (
                    <div className="opaque-file">
                      <span
                        className="opaque-open"
                        title="Open in editor"
                        onClick={() => openInEditor(f.path)}
                      >
                        {f.path} — {f.untracked.binary ? "binary file" : "file too large to preview"}
                      </span>
                      <span className="hdr-acts">{actionButtons(f)}</span>
                    </div>
                  ))}
              </div>
            ))}
          </div>
        ))}
      </main>

      <aside className="tree">
        <div className="meta-panel">
          {view.kind === "commit" && (
            <>
              <h2 title={activeCommit?.message}>
                {activeCommit?.message.split("\n")[0] ?? "Commit"}
              </h2>
              {activeCommit && (
                <div className="meta-line">
                  {activeCommit.avatar && <img src={activeCommit.avatar} alt="" />}
                  <span>{activeCommit.login ?? activeCommit.author}</span>
                  <span>·</span>
                  <span>{timeAgo(activeCommit.date)}</span>
                </div>
              )}
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
                {meta?.branch && (
                  <>
                    <span>·</span>
                    <span>{meta.branch}</span>
                  </>
                )}
              </div>
            </>
          )}
        </div>
        <div className="tree-body">
          <FileTree
            model={model}
            header={<strong>Files changed ({treeFileCount})</strong>}
            style={{ colorScheme: "dark" }}
          />
        </div>
      </aside>

      {commitOpen && (
        <div className="modal-overlay" onClick={() => !committing && setCommitOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Commit &amp; push staged changes</h3>
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
                disabled={committing || !commitMsg.trim()}
                onClick={submitCommit}
              >
                {committing ? "Committing…" : "Commit & push"}
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
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
