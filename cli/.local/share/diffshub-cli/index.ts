#!/usr/bin/env bun

import { $ } from "bun";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { removeFileLines, removePatchAdditions } from "./patch-edit";

const cwd = process.cwd();
const port = parseInt(process.argv[2] || "3433", 10); // 3433 = DIFF on a phone keypad
const here = dirname(fileURLToPath(import.meta.url));

// ---- Resolve target repo(s) ----
// Single-repo mode: cwd is a git repo (today's behaviour).
// Workspace mode: cwd isn't a git repo but holds sub-repos (e.g. ~/work with
// app/ + web/) — combine commits/PRs/changes across them. The repo set comes
// from $DIFFSHUB_REPOS, then ./.diffshub.json, then the app+web default, then a
// scan of every immediate child git repo.

interface RepoCtx {
  key: string;
  dir: string;
  nameWithOwner: string;
  branch: string;
}

async function isGitWorkTree(dir: string): Promise<boolean> {
  try {
    return (await $`git -C ${dir} rev-parse --is-inside-work-tree`.quiet().text()).trim() === "true";
  } catch {
    return false;
  }
}

async function resolveRepo(key: string, dir: string): Promise<RepoCtx | null> {
  let nameWithOwner: string;
  try {
    nameWithOwner = (
      await $`gh repo view --json nameWithOwner -q .nameWithOwner`.cwd(dir).quiet().text()
    ).trim();
  } catch {
    return null;
  }
  if (!nameWithOwner) return null;
  let branch = "";
  try {
    branch = (await $`git branch --show-current`.cwd(dir).quiet().text()).trim();
  } catch {}
  return { key, dir, nameWithOwner, branch };
}

async function resolveWorkspaceRepos(): Promise<RepoCtx[]> {
  let keys: string[] = [];
  const env = process.env.DIFFSHUB_REPOS;
  if (env) keys = env.split(",").map((s) => s.trim()).filter(Boolean);
  if (!keys.length) {
    try {
      const cfg = await Bun.file(`${cwd}/.diffshub.json`).json();
      const list = Array.isArray(cfg) ? cfg : cfg?.repos;
      if (Array.isArray(list)) keys = list.filter((x: unknown): x is string => typeof x === "string");
    } catch {}
  }
  if (!keys.length) keys = ["app", "web"];
  let resolved = (
    await Promise.all(
      keys.filter((k) => existsSync(`${cwd}/${k}/.git`)).map((k) => resolveRepo(k, `${cwd}/${k}`)),
    )
  ).filter((r): r is RepoCtx => r !== null);
  if (!resolved.length) {
    // Fall back to every immediate child that is a git repo.
    let children: string[] = [];
    try {
      children = readdirSync(cwd, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(`${cwd}/${e.name}/.git`))
        .map((e) => e.name)
        .sort();
    } catch {}
    resolved = (
      await Promise.all(children.map((k) => resolveRepo(k, `${cwd}/${k}`)))
    ).filter((r): r is RepoCtx => r !== null);
  }
  return resolved;
}

const workspace = !(await isGitWorkTree(cwd));
let repos: RepoCtx[];
if (!workspace) {
  const r = await resolveRepo("", cwd);
  if (!r) {
    console.error(
      "diffshub: `gh repo view` failed — run from a repo with a GitHub remote (and `gh auth login`)",
    );
    process.exit(1);
  }
  r.key = r.nameWithOwner.split("/").pop() || "repo";
  repos = [r];
} else {
  repos = await resolveWorkspaceRepos();
  if (!repos.length) {
    console.error(
      `diffshub: ${cwd} is not a git repo and no sub-repos were found.\n` +
        `Set DIFFSHUB_REPOS=app,web (or add ./.diffshub.json with {"repos":["app","web"]}).`,
    );
    process.exit(1);
  }
}
const repoByKey = (key?: string | null): RepoCtx => repos.find((r) => r.key === key) ?? repos[0];
const label = workspace
  ? `${cwd.split("/").pop()} (${repos.map((r) => r.key).join(" · ")})`
  : repos[0].nameWithOwner;

// Reviewed-commit tracking, persisted per repo (by nameWithOwner) in a local db
const stateDir = `${process.env.HOME}/.local/state/diffshub`;
mkdirSync(stateDir, { recursive: true });
const db = new Database(`${stateDir}/diffshub.sqlite`);
db.run(`CREATE TABLE IF NOT EXISTS reviewed (
  repo TEXT NOT NULL,
  sha TEXT NOT NULL,
  reviewed_at INTEGER NOT NULL,
  PRIMARY KEY (repo, sha)
)`);
const markReviewedStmt = db.query(
  "INSERT OR REPLACE INTO reviewed (repo, sha, reviewed_at) VALUES (?, ?, ?)",
);
const unmarkReviewedStmt = db.query("DELETE FROM reviewed WHERE repo = ? AND sha = ?");
// Reviewed shas across every active repo (shas are globally unique in practice)
const listReviewedAllStmt = db.query<{ sha: string }, string[]>(
  `SELECT DISTINCT sha FROM reviewed WHERE repo IN (${repos.map(() => "?").join(",")})`,
);
const reviewedRepoNames = repos.map((r) => r.nameWithOwner);

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errText(e: any): string {
  const stderr = e?.stderr ? new TextDecoder().decode(e.stderr) : "";
  return stderr.trim() || String(e?.message ?? e);
}

// Single-quote a string for safe interpolation into a /bin/sh command line
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// Resolve the user's editor ($VISUAL/$EDITOR, default zed) and build an argv
// that jumps to a line for the editors that understand it.
function editorTokens(): string[] {
  const raw = (process.env.VISUAL || process.env.EDITOR || "zed").trim();
  return raw ? raw.split(/\s+/) : ["zed"];
}
function editorName(): string {
  const bin = editorTokens()[0];
  return bin.split("/").pop() || bin;
}
function editorArgv(fileAbs: string, line: number | null): string[] {
  const tokens = editorTokens();
  if (line == null) return [...tokens, fileAbs];
  const name = editorName();
  if (/^(code|codium|code-insiders|vscodium|cursor|windsurf)$/.test(name))
    return [...tokens, "--goto", `${fileAbs}:${line}`];
  if (/^(vim|nvim|vi|view|nano|micro|emacs|emacsclient|kak|hx|helix)$/.test(name))
    return [...tokens, `+${line}`, fileAbs];
  // zed, subl, JetBrains and unknown GUI editors take a `path:line` argument
  return [...tokens, `${fileAbs}:${line}`];
}

// ---- New Claude session (mirrors the `p` shell function) ----
// The `p` zsh function reads these pools (exported as zsh arrays, not env vars,
// so we mirror them here) to pick an adjective-noun session name, then launches
// claude in a detached tmux session and pastes the first prompt. We can't call
// `p` directly — it ends by attaching, which needs a TTY this server doesn't
// have — so we reproduce its session-creation half and skip the attach.
// All claude tmux commands pass `-L default` explicitly: this server often runs
// inside a `bg`-socket tmux pane, so a bare `tmux` would inherit $TMUX and land
// the session on the `bg` socket instead of the default one claude lives on.
const SESSION_ADJECTIVES = [
  "amber", "brave", "calm", "dapper", "eager", "fabled", "gentle", "hardy", "icy",
  "jaunty", "keen", "lucid", "misty", "noble", "odd", "plucky", "quick", "radiant",
  "sunny", "tidy", "upbeat", "vivid", "witty", "xtra", "young", "zesty",
];
const SESSION_NOUNS = [
  "anchor", "beacon", "citadel", "dragon", "ember", "falcon", "grove", "harbor",
  "island", "junction", "kingdom", "lantern", "meadow", "nebula", "oasis", "prairie",
  "quarry", "rocket", "summit", "temple", "urchin", "valley", "workshop", "xenon",
  "yard", "zephyr",
];

// Pick an unused adjective-noun name, avoiding the first letter of any session
// already running claude/node (same heuristic as `p`).
async function pickClaudeSessionName(): Promise<string> {
  let sessions: string[] = [];
  try {
    sessions = (await $`tmux -L default list-sessions -F ${"#S"}`.quiet().text())
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {}
  const existing = new Set(sessions);
  const usedLetters = new Set<string>();
  await Promise.all(
    sessions.map(async (s) => {
      try {
        const cmd = (
          await $`tmux -L default display-message -p -t ${`${s}:0.0`} ${"#{pane_current_command}"}`.quiet().text()
        ).trim();
        if (/claude|node/.test(cmd) || /^[0-9]+\.[0-9]+/.test(cmd)) usedLetters.add(s[0]);
      } catch {}
    }),
  );
  let name = "";
  let attempts = 0;
  while (true) {
    const adj = SESSION_ADJECTIVES[Math.floor(Math.random() * SESSION_ADJECTIVES.length)];
    const noun = SESSION_NOUNS[Math.floor(Math.random() * SESSION_NOUNS.length)];
    name = `${adj}-${noun}`;
    if (!existing.has(name) && (!usedLetters.has(name[0]) || attempts > 50)) break;
    attempts++;
  }
  return name;
}

// Paste the prompt into a freshly-started claude session and submit it. Runs
// fire-and-forget after a short delay so claude's TUI is ready to receive it.
async function sendClaudePrompt(name: string, prompt: string): Promise<void> {
  try {
    await Bun.sleep(1000);
    const bufFile = `${stateDir}/claude-prompt-${Date.now()}.txt`;
    await Bun.write(bufFile, prompt);
    const buf = `diffshub-${name}`;
    await $`tmux -L default load-buffer -b ${buf} ${bufFile}`.quiet();
    await $`tmux -L default paste-buffer -d -b ${buf} -t ${`${name}:0.0`}`.quiet();
    await $`tmux -L default send-keys -t ${`${name}:0.0`} Enter`.quiet();
    await $`rm -f ${bufFile}`.quiet();
  } catch {}
}

// Launch an interactive claude session detached in the dh directory (mirrors
// `p`), returning the session name so the caller can `tmux attach -t <name>`.
async function newClaudeSession(prompt: string): Promise<string> {
  const name = await pickClaudeSessionName();
  const claudeCmd = `CLAUDE_CODE_NO_FLICKER=1 direnv exec ${shq(cwd)} claude`;
  await $`tmux -L default new-session -ds ${name} -c ${cwd} ${claudeCmd}`.quiet();
  if (prompt.trim()) void sendClaudePrompt(name, prompt);
  return name;
}

interface CommitSummary {
  sha: string;
  message: string;
  author: string;
  login: string | null;
  avatar: string | null;
  date: string;
  repo: string;
}

// Collect fulfilled values; only throw when every repo failed (so one bad
// remote doesn't blank the whole combined list).
function settle<T>(settled: PromiseSettledResult<T[]>[]): T[] {
  if (settled.length && settled.every((s) => s.status === "rejected")) {
    throw (settled[0] as PromiseRejectedResult).reason;
  }
  return settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
}

async function listCommitsForRepo(r: RepoCtx, page: number): Promise<CommitSummary[]> {
  const base = `repos/${r.nameWithOwner}/commits?per_page=50&page=${page}`;
  // Prefer the checked-out branch; fall back to the default branch if it
  // isn't pushed to GitHub.
  const urls = r.branch ? [`${base}&sha=${encodeURIComponent(r.branch)}`, base] : [base];
  let lastError: unknown;
  for (const url of urls) {
    try {
      const raw = await $`gh api ${url}`.cwd(r.dir).quiet().text();
      return JSON.parse(raw).map((c: any) => ({
        sha: c.sha,
        message: c.commit?.message ?? "",
        author: c.commit?.author?.name ?? "unknown",
        login: c.author?.login ?? null,
        avatar: c.author?.avatar_url ?? null,
        date: c.commit?.author?.date ?? c.commit?.committer?.date ?? "",
        repo: r.key,
      }));
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

async function listCommits(page: number): Promise<CommitSummary[]> {
  const settled = await Promise.allSettled(repos.map((r) => listCommitsForRepo(r, page)));
  return settle(settled).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

async function listPrsForRepo(r: RepoCtx) {
  const raw =
    await $`gh pr list --json number,title,author,headRefName,updatedAt,additions,deletions,isDraft --limit 100`
      .cwd(r.dir)
      .quiet()
      .text();
  return JSON.parse(raw).map((p: any) => ({
    number: p.number,
    title: p.title,
    login: p.author?.login ?? "unknown",
    branch: p.headRefName,
    updatedAt: p.updatedAt,
    additions: p.additions ?? 0,
    deletions: p.deletions ?? 0,
    isDraft: !!p.isDraft,
    repo: r.key,
  }));
}

async function listPrs() {
  const settled = await Promise.allSettled(repos.map((r) => listPrsForRepo(r)));
  return settle(settled).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

// Commit diffs are immutable, cache them for the lifetime of the server
const diffCache = new Map<string, string>();

async function commitDiff(r: RepoCtx, sha: string): Promise<string> {
  const cacheKey = `${r.key}:${sha}`;
  const cached = diffCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const diff = await $`gh api repos/${r.nameWithOwner}/commits/${sha} -H ${"Accept: application/vnd.github.diff"}`
    .cwd(r.dir)
    .quiet()
    .text();
  diffCache.set(cacheKey, diff);
  return diff;
}

// ---- Pending changes (working tree) ----

interface UntrackedEntry {
  path: string;
  contents: string | null;
  binary?: boolean;
  tooLarge?: boolean;
}

async function untrackedEntry(dir: string, path: string): Promise<UntrackedEntry> {
  try {
    const file = Bun.file(`${dir}/${path}`);
    if (file.size > 512 * 1024) return { path, contents: null, tooLarge: true };
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.subarray(0, 8000).includes(0)) return { path, contents: null, binary: true };
    return { path, contents: new TextDecoder().decode(bytes) };
  } catch {
    return { path, contents: null, binary: true };
  }
}

interface RepoChanges {
  repo: string;
  // Worktree segment header shown in the sidebar (branch / "repo · branch" /
  // empty when there's just the one working tree). The client also derives the
  // file-tree namespace from it.
  segment: string;
  // Absolute worktree directory — echoed back by the client to route git/open/
  // delete/commit actions to the right working tree (validated server-side).
  dir: string;
  staged: { path: string; status: string }[];
  unstaged: { path: string; status: string }[];
  untracked: UntrackedEntry[];
  stagedDiff: string;
  unstagedDiff: string;
}

interface Worktree {
  dir: string;
  branch: string;
}

// Every worktree dir we've reported to the client, refreshed on each
// /api/changes. Git/open/delete/commit actions are only allowed to target a
// dir in this set, so an echoed-back path can't escape the known worktrees.
const worktreeDirs = new Set<string>();

async function listWorktrees(repoDir: string): Promise<Worktree[]> {
  let out: string;
  try {
    out = await $`git -C ${repoDir} worktree list --porcelain`.quiet().text();
  } catch {
    return [{ dir: repoDir, branch: "" }];
  }
  const worktrees: Worktree[] = [];
  for (const block of out.split("\n\n")) {
    let dir = "";
    let branch = "";
    let bare = false;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) dir = line.slice("worktree ".length).trim();
      else if (line.startsWith("branch ")) branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
      else if (line === "bare") bare = true;
    }
    if (dir && !bare) worktrees.push({ dir, branch });
  }
  return worktrees.length ? worktrees : [{ dir: repoDir, branch: "" }];
}

// Working-tree status for a single directory (one worktree).
async function statusDir(dir: string) {
  const raw = await $`git status --porcelain=v1 -z -uall`.cwd(dir).quiet().text();
  const parts = raw.split("\0");
  const staged: { path: string; status: string }[] = [];
  const unstaged: { path: string; status: string }[] = [];
  const untrackedPaths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const path = entry.slice(3);
    if (x === "R" || x === "C") i++; // skip the rename-origin path that follows
    if (x === "?") {
      untrackedPaths.push(path);
      continue;
    }
    if (x !== " ") staged.push({ path, status: x });
    if (y !== " ") unstaged.push({ path, status: y });
  }
  const [stagedDiff, unstagedDiff, untracked] = await Promise.all([
    staged.length ? $`git diff --cached`.cwd(dir).quiet().text() : Promise.resolve(""),
    unstaged.length ? $`git diff`.cwd(dir).quiet().text() : Promise.resolve(""),
    Promise.all(untrackedPaths.map((p) => untrackedEntry(dir, p))),
  ]);
  return { staged, unstaged, untracked, stagedDiff, unstagedDiff };
}

async function getChangesForRepo(r: RepoCtx): Promise<RepoChanges[]> {
  const worktrees = await listWorktrees(r.dir);
  const multiWt = worktrees.length > 1;
  return Promise.all(
    worktrees.map(async (wt) => {
      const status = await statusDir(wt.dir);
      const wtLabel = wt.branch || wt.dir.split("/").pop() || wt.dir;
      const segment =
        workspace && multiWt
          ? `${r.key} · ${wtLabel}`
          : multiWt
            ? wtLabel
            : workspace
              ? r.key
              : "";
      return { repo: r.key, segment, dir: wt.dir, ...status };
    }),
  );
}

async function getChanges(): Promise<RepoChanges[]> {
  const all = (await Promise.all(repos.map(getChangesForRepo))).flat();
  worktreeDirs.clear();
  for (const rc of all) worktreeDirs.add(rc.dir);
  return all;
}

// Resolve a client-supplied worktree dir to a real directory, only allowing a
// dir we've already reported; falls back to the repo's main dir.
function dirForWorktree(worktree: unknown, repoKey: unknown): string {
  if (typeof worktree === "string" && worktreeDirs.has(worktree)) return worktree;
  return repoByKey(typeof repoKey === "string" ? repoKey : null).dir;
}

// ---- Manual patches (./diffs/*.patch in the cwd) ----

interface ManualPatch {
  name: string;
  contents: string;
}

async function listManualPatches(): Promise<ManualPatch[]> {
  let names: string[];
  try {
    names = readdirSync(`${cwd}/diffs`)
      .filter((n) => n.endsWith(".patch"))
      .sort();
  } catch {
    return []; // no ./diffs directory — just an empty list
  }
  return Promise.all(
    names.map(async (name) => ({
      name,
      contents: await Bun.file(`${cwd}/diffs/${name}`)
        .text()
        .catch(() => ""),
    })),
  );
}

function safeRepoPath(p: unknown): p is string {
  return (
    typeof p === "string" &&
    p.length > 0 &&
    !p.includes("\0") &&
    !p.startsWith("/") &&
    !p.split("/").includes("..")
  );
}

async function runGitAction(action: string, dir: string, path?: string) {
  if (action === "stage") {
    return path ? $`git add -- ${path}`.cwd(dir).quiet() : $`git add -A`.cwd(dir).quiet();
  }
  if (action === "unstage") {
    return path
      ? $`git restore --staged -- ${path}`.cwd(dir).quiet()
      : $`git restore --staged .`.cwd(dir).quiet();
  }
  if (action === "stash") {
    return path
      ? $`git stash push -u -- ${path}`.cwd(dir).quiet()
      : $`git stash push -u`.cwd(dir).quiet();
  }
  throw new Error(`Unknown action: ${action}`);
}

// Bundle the React client once at startup and serve it from memory
const build = await Bun.build({
  entrypoints: [`${here}/client.tsx`],
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!build.success) {
  console.error("diffshub: client build failed");
  for (const log of build.logs) console.error(log);
  process.exit(1);
}
const clientJS = await build.outputs[0].text();

const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${label} — diffshub</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body, #root { height: 100%; margin: 0; }
  body {
    font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #ffffff;
    color: #18181b;
  }
  code { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  button { font: inherit; color: inherit; }
  .layout { display: flex; height: 100%; overflow: hidden; }

  .commits {
    width: 300px; min-width: 300px;
    display: flex; flex-direction: column;
    border-right: 1px solid #e4e4e7;
    background: #f7f7f8;
  }
  .commits-header { padding: 14px 14px 10px; border-bottom: 1px solid #e4e4e7; }
  .commits-header h1 { font-size: 15px; margin: 0 0 10px; display: flex; align-items: baseline; gap: 8px; }
  .commits-header .repo { font-size: 11px; font-weight: 400; color: #71717a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .commits-header input {
    width: 100%; padding: 6px 10px; font-size: 13px;
    background: #ffffff; color: inherit;
    border: 1px solid #d4d4d8; border-radius: 6px; outline: none;
  }
  .commits-header input:focus { border-color: #6e56cf; }

  .tabs { display: flex; gap: 2px; margin-bottom: 10px; background: #efeff1; border: 1px solid #e4e4e7; border-radius: 7px; padding: 2px; }
  .tabs button {
    flex: 1; padding: 4px 0; font-size: 12px; cursor: pointer;
    background: none; border: none; border-radius: 5px; color: #71717a;
  }
  .tabs button.on { background: #ffffff; color: #18181b; box-shadow: 0 1px 2px rgba(0, 0, 0, .08); }

  .commit-list { flex: 1; overflow-y: auto; padding: 6px 0; }
  .commit {
    display: block; width: 100%; text-align: left; cursor: pointer;
    padding: 8px 14px; border: none; border-left: 3px solid transparent;
    background: none; position: relative;
  }
  .commit:hover { background: #f0f0f1; }
  .commit.active { background: #efe9fb; border-left-color: #6e56cf; }
  .commit-msg {
    display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-weight: 500; margin-bottom: 3px; padding-right: 22px;
  }
  .rev-btn {
    position: absolute; top: 7px; right: 10px; width: 18px; height: 18px;
    display: flex; align-items: center; justify-content: center; padding: 0;
    background: none; border: 1px solid #d4d4d8; border-radius: 50%;
    color: #a1a1aa; font-size: 10px; cursor: pointer; opacity: 0;
  }
  .commit:hover .rev-btn { opacity: 1; }
  .commit.reviewed .rev-btn { opacity: 1; background: #dcfce7; border-color: #86efac; color: #16a34a; }
  .commit.reviewed .commit-msg { color: #a1a1aa; font-weight: 400; }
  .spinner {
    width: 34px; height: 34px; margin: 0 auto; border-radius: 50%;
    border: 4px solid #e4e4e7; border-top-color: #6e56cf;
    animation: spin .8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  /* Sole child of the diff column while loading — center the spinner in the
     visible area rather than tucking it up near the top. */
  .loading-wrap {
    display: flex; align-items: center; justify-content: center;
    min-height: 75vh; color: #71717a;
  }

  /* Sidebar skeleton placeholders, shown while a tab's list is loading */
  .skel-list { padding: 6px 0; }
  .skel-row { padding: 8px 14px; }
  .skel-bar {
    border-radius: 4px;
    background-image: linear-gradient(90deg, #e8e8eb, #f1f1f3, #e8e8eb);
    background-size: 200% 100%;
    animation: shimmer 1.4s ease-in-out infinite;
  }
  .skel-bar.title { height: 9px; margin-bottom: 8px; }
  .skel-bar.meta { height: 7px; width: 45%; }
  @keyframes shimmer { 0% { background-position-x: 100%; } 100% { background-position-x: -100%; } }
  .commit-meta { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #71717a; }
  .commit-meta img { width: 14px; height: 14px; border-radius: 50%; }
  .commit-meta code { color: #71717a; }
  .commit-ago { margin-left: auto; white-space: nowrap; }
  .repo-badge {
    font-size: 10px; line-height: 1.5; padding: 0 5px; border-radius: 4px;
    background: #efe9fb; color: #6e56cf; border: 1px solid #ddd0fb;
    white-space: nowrap; flex-shrink: 0;
  }
  .modal-repos { color: #6e56cf; font-weight: 600; }
  .pr-stats .add { color: #16a34a; }
  .pr-stats .del { color: #dc2626; }
  .load-more {
    display: block; width: calc(100% - 28px); margin: 8px 14px; padding: 6px;
    background: #f4f4f5; color: #71717a; border: 1px solid #e4e4e7;
    border-radius: 6px; cursor: pointer; font-size: 12px;
  }
  .load-more:hover { color: #18181b; }
  .side-note { color: #71717a; padding: 16px 14px; }
  .side-note.error { color: #dc2626; white-space: pre-wrap; }

  .kbd-hints {
    padding: 8px 14px; border-top: 1px solid #e4e4e7;
    font-size: 11px; color: #a1a1aa; display: flex; gap: 10px; flex-wrap: wrap;
  }
  .kbd-hints kbd { background: #e4e4e7; border-radius: 3px; padding: 1px 4px; font-size: 10px; }

  .bulk-actions { display: flex; gap: 6px; padding: 8px 14px; }
  .bulk-actions button {
    flex: 1; padding: 5px 0; font-size: 11px; cursor: pointer;
    background: #ffffff; border: 1px solid #d4d4d8; border-radius: 6px; color: #52525b;
  }
  .bulk-actions button:hover:not(:disabled) { color: #18181b; border-color: #6e56cf; }
  .bulk-actions button:disabled { opacity: .5; cursor: default; }

  .auto-refresh-bar {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px 2px; font-size: 11px; color: #71717a;
  }
  .switch {
    position: relative; width: 30px; height: 17px; flex-shrink: 0; padding: 0;
    background: #d4d4d8; border: none; border-radius: 999px; cursor: pointer;
    transition: background .15s;
  }
  .switch.on { background: #6e56cf; }
  .switch-knob {
    position: absolute; top: 2px; left: 2px; width: 13px; height: 13px;
    background: #ffffff; border-radius: 50%; transition: transform .15s;
  }
  .switch.on .switch-knob { transform: translateX(13px); }
  .switch-state { min-width: 18px; font-variant-numeric: tabular-nums; }

  .wt-label {
    display: flex; align-items: center; gap: 6px;
    padding: 12px 14px 2px; font-size: 11px; font-weight: 700;
    color: #6e56cf; letter-spacing: .02em;
  }
  .wt-label::before { content: "⎇"; opacity: .75; font-size: 12px; }
  .wt-label + .group-label { padding-top: 4px; }
  .group-label {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 10px 14px 4px; font-size: 11px; font-weight: 600;
    color: #71717a; text-transform: uppercase; letter-spacing: .04em;
  }
  .group-act {
    padding: 2px 8px; font-size: 10px; cursor: pointer;
    text-transform: none; letter-spacing: 0; flex-shrink: 0;
    background: #ffffff; border: 1px solid #d4d4d8; border-radius: 5px; color: #52525b;
  }
  .group-act:hover:not(:disabled) { color: #18181b; border-color: #6e56cf; }
  .group-act:disabled { opacity: .5; cursor: default; }
  .change-row {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 14px; cursor: pointer;
    /* Reserve the height the hover-revealed action buttons need so showing
       them on :hover never reflows the row (no layout shift). */
    min-height: 30px;
  }
  .change-row:hover { background: #f0f0f1; }
  .change-row .st { width: 12px; text-align: center; font-size: 11px; flex-shrink: 0; }
  .st-added, .st-untracked { color: #16a34a; }
  .st-modified { color: #d97706; }
  .st-deleted { color: #dc2626; }
  .st-renamed { color: #2563eb; }
  .change-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
  .change-acts { display: none; gap: 4px; flex-shrink: 0; }
  .change-row:hover .change-acts { display: flex; }

  .act {
    padding: 1px 7px; font-size: 11px; cursor: pointer;
    background: #f4f4f5; border: 1px solid #d4d4d8; border-radius: 5px; color: #52525b;
  }
  .act:hover:not(:disabled) { color: #18181b; border-color: #6e56cf; }
  .act:disabled { opacity: .5; cursor: default; }
  .hdr-acts { display: inline-flex; gap: 5px; margin-left: 10px; }

  .diffs { flex: 1; overflow-y: auto; padding: 16px 20px 60vh; }
  .section-label { font-size: 12px; color: #71717a; text-transform: uppercase; letter-spacing: .04em; margin: 6px 2px 10px; }
  .file-diff { margin-bottom: 16px; position: relative; }
  .file-diff.viewing::before {
    content: ""; position: absolute; left: -10px; top: 0; bottom: 0;
    width: 3px; border-radius: 2px; background: #6e56cf;
  }
  .empty { color: #71717a; padding: 40px 0; text-align: center; }
  .empty.error { color: #dc2626; white-space: pre-wrap; text-align: left; }
  .opaque-file {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 14px; border: 1px solid #e4e4e7; border-radius: 8px;
    color: #71717a; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px;
  }
  .opaque-open { cursor: pointer; }
  .opaque-open:hover { color: #18181b; text-decoration: underline; }

  .tree {
    width: 280px; min-width: 280px;
    border-left: 1px solid #e4e4e7;
    background: #f7f7f8;
    display: flex; flex-direction: column;
  }
  .meta-panel { padding: 14px; border-bottom: 1px solid #e4e4e7; }
  .meta-panel h2 { font-size: 13px; margin: 0 0 6px; line-height: 1.4; word-break: break-word; }
  .meta-panel .meta-line { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #71717a; margin-top: 4px; }
  .meta-panel .meta-line img { width: 14px; height: 14px; border-radius: 50%; }
  .meta-panel .sha-btn {
    background: #ffffff; border: 1px solid #d4d4d8; border-radius: 5px;
    padding: 1px 7px; font-size: 11px; cursor: pointer; color: #52525b;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .meta-panel .sha-btn:hover { border-color: #6e56cf; color: #18181b; }
  .tree-body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 8px 6px;
    --trees-bg-override: #f7f7f8;
    --trees-bg-muted-override: #f0f0f1;
    --trees-fg-override: #18181b;
    --trees-fg-muted-override: #71717a;
    --trees-border-color-override: #e4e4e7;
    --trees-selected-bg-override: #efe9fb;
    --trees-accent-override: #6e56cf;
  }
  .tree-body > * { flex: 1; min-height: 0; }

  .modal-overlay {
    position: fixed; inset: 0; z-index: 50;
    background: rgba(0, 0, 0, .35);
    display: flex; align-items: center; justify-content: center;
  }
  .modal {
    width: 460px; max-width: calc(100vw - 40px);
    background: #ffffff; border: 1px solid #e4e4e7; border-radius: 10px;
    padding: 16px; box-shadow: 0 12px 44px rgba(0, 0, 0, .18);
  }
  .modal h3 { margin: 0 0 10px; font-size: 14px; }
  .commit-input {
    width: 100%; min-height: 92px; resize: vertical;
    background: #ffffff; color: inherit; font: inherit; line-height: 1.5;
    border: 1px solid #d4d4d8; border-radius: 6px; padding: 8px 10px; outline: none;
  }
  .commit-input:focus { border-color: #6e56cf; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  .modal-actions .primary { background: #6e56cf; border-color: #6e56cf; color: #fff; }
  .modal-actions .primary:hover:not(:disabled) { background: #7d68d6; border-color: #7d68d6; }
  .modal-hint { margin-top: 10px; font-size: 11px; color: #a1a1aa; display: flex; gap: 8px; flex-wrap: wrap; }
  .modal-hint kbd { background: #e4e4e7; border-radius: 3px; padding: 1px 4px; }
  .modal-hint code { color: #71717a; }

  /* Floating action bar shown when diff lines are highlighted */
  .sel-bar {
    position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
    z-index: 40; display: flex; align-items: center; gap: 8px;
    padding: 7px 8px 7px 14px;
    background: #18181b; color: #fafafa;
    border-radius: 10px; box-shadow: 0 10px 34px rgba(0, 0, 0, .28);
    font-size: 12px;
  }
  .sel-bar .sel-info { color: #d4d4d8; white-space: nowrap; margin-right: 2px; }
  .sel-bar .sel-info code { color: #fafafa; }
  .sel-bar .sel-act {
    padding: 4px 11px; font-size: 12px; cursor: pointer;
    background: #3f3f46; border: 1px solid #52525b; border-radius: 6px; color: #fafafa;
  }
  .sel-bar .sel-act:hover:not(:disabled) { background: #52525b; }
  .sel-bar .sel-act:disabled { opacity: .45; cursor: default; }
  .sel-bar .sel-act.danger { background: #b91c1c; border-color: #b91c1c; }
  .sel-bar .sel-act.danger:hover:not(:disabled) { background: #dc2626; border-color: #dc2626; }
  .sel-bar .sel-x {
    width: 22px; height: 22px; padding: 0; cursor: pointer; font-size: 14px;
    display: flex; align-items: center; justify-content: center;
    background: none; border: none; color: #a1a1aa;
  }
  .sel-bar .sel-x:hover { color: #fafafa; }
</style>
</head>
<body>
<div id="root"></div>
<script type="module" src="/client.js"></script>
</body>
</html>`;

const server = Bun.serve({
  port,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/client.js") {
      return new Response(clientJS, {
        headers: { "Content-Type": "text/javascript; charset=utf-8" },
      });
    }

    if (url.pathname === "/api/meta") {
      return json({
        repo: label,
        cwd,
        branch: workspace ? "" : repos[0].branch,
        workspace,
        editor: editorName(),
        repos: repos.map((r) => ({ key: r.key, nameWithOwner: r.nameWithOwner, branch: r.branch })),
      });
    }

    if (url.pathname === "/api/commits") {
      const pageNum = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
      try {
        return json(await listCommits(pageNum));
      } catch (e) {
        return json({ error: errText(e) }, 502);
      }
    }

    if (url.pathname === "/api/prs") {
      try {
        return json(await listPrs());
      } catch (e) {
        return new Response(errText(e), { status: 502 });
      }
    }

    if (url.pathname === "/api/changes") {
      try {
        return json(await getChanges());
      } catch (e) {
        return new Response(errText(e), { status: 500 });
      }
    }

    if (url.pathname === "/api/manual") {
      try {
        return json(await listManualPatches());
      } catch (e) {
        return new Response(errText(e), { status: 500 });
      }
    }

    if (url.pathname === "/api/reviewed") {
      if (req.method === "POST") {
        let body: { sha?: unknown; reviewed?: unknown; repo?: unknown };
        try {
          body = await req.json();
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }
        if (typeof body.sha !== "string" || !/^[0-9a-f]{7,40}$/.test(body.sha)) {
          return json({ error: "Invalid sha" }, 400);
        }
        const nwo = repoByKey(typeof body.repo === "string" ? body.repo : null).nameWithOwner;
        if (body.reviewed) markReviewedStmt.run(nwo, body.sha, Date.now());
        else unmarkReviewedStmt.run(nwo, body.sha);
        return json({ ok: true });
      }
      return json(listReviewedAllStmt.all(...reviewedRepoNames).map((r) => r.sha));
    }

    if (req.method === "POST" && url.pathname === "/api/git") {
      let body: { action?: unknown; path?: unknown; repo?: unknown; worktree?: unknown };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      const action = body.action;
      if (action !== "stage" && action !== "unstage" && action !== "stash") {
        return json({ error: "Invalid action" }, 400);
      }
      const path = body.path;
      if (path !== undefined && !safeRepoPath(path)) {
        return json({ error: "Invalid path" }, 400);
      }
      // A per-file or per-worktree action targets one worktree; a bulk action
      // with no worktree/repo applies to every known worktree.
      let dirs: string[];
      if (path !== undefined) {
        dirs = [dirForWorktree(body.worktree, body.repo)];
      } else if (typeof body.worktree === "string" && worktreeDirs.has(body.worktree)) {
        dirs = [body.worktree];
      } else if (typeof body.repo === "string") {
        dirs = [repoByKey(body.repo).dir];
      } else {
        dirs = worktreeDirs.size ? [...worktreeDirs] : repos.map((r) => r.dir);
      }
      try {
        for (const dir of dirs) await runGitAction(action, dir, path as string | undefined);
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
      return json({ ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/commit") {
      let body: { message?: unknown; worktrees?: unknown };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      if (typeof body.message !== "string" || !body.message.trim()) {
        return json({ error: "Empty commit message" }, 400);
      }
      // Which worktrees to commit: the requested dirs (deduped, validated) or
      // every known worktree.
      const wantedDirs = Array.isArray(body.worktrees)
        ? [...new Set(body.worktrees.filter((d): d is string => typeof d === "string" && worktreeDirs.has(d)))]
        : null;
      const targetDirs =
        wantedDirs && wantedDirs.length
          ? wantedDirs
          : worktreeDirs.size
            ? [...worktreeDirs]
            : repos.map((r) => r.dir);
      if (!targetDirs.length) return json({ error: "Nothing to commit" }, 400);
      try {
        // Stash the message in a file so it never has to be shell-escaped, then
        // commit + push each worktree that has staged changes, detached in the
        // `bg` tmux server so it outlives this request (attach: `tmux -L bg attach`).
        const msgFile = `${stateDir}/commit-msg-${Date.now()}.txt`;
        await Bun.write(msgFile, body.message);
        const session = `diffshub-commit-${Date.now()}`;
        const steps = targetDirs.map(
          (dir) =>
            `if ! git -C ${shq(dir)} diff --cached --quiet; then ` +
            `git -C ${shq(dir)} commit -F ${shq(msgFile)} && git -C ${shq(dir)} push; fi`,
        );
        const script = `${steps.join("; ")}; rm -f ${shq(msgFile)}`;
        await $`tmux -L bg new-session -d -c ${cwd} -s ${session} ${script}`.cwd(cwd).quiet();
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
      return json({ ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/claude") {
      let body: { prompt?: unknown };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      if (typeof body.prompt !== "string" || !body.prompt.trim()) {
        return json({ error: "Empty prompt" }, 400);
      }
      try {
        const session = await newClaudeSession(body.prompt);
        return json({ ok: true, session });
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
    }

    if (req.method === "POST" && url.pathname === "/api/open") {
      let body: { path?: unknown; line?: unknown; repo?: unknown; worktree?: unknown };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      if (!safeRepoPath(body.path)) {
        return json({ error: "Invalid path" }, 400);
      }
      const line =
        typeof body.line === "number" && Number.isInteger(body.line) && body.line > 0
          ? body.line
          : null;
      const dir = dirForWorktree(body.worktree, body.repo);
      try {
        // Fire-and-forget: GUI editors fork and return; we don't await so a
        // terminal editor (vim/etc) wouldn't hang the request.
        Bun.spawn(editorArgv(`${dir}/${body.path}`, line), {
          cwd: dir,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
      return json({ ok: true });
    }

    // Delete the highlighted lines from whatever is backing the diff: the
    // working-tree file (Changes view) or the ./diffs/*.patch (Manual view).
    // Only added (new-side) lines are removable — see patch-edit.ts.
    if (req.method === "POST" && url.pathname === "/api/delete-lines") {
      let body: {
        source?: unknown;
        name?: unknown;
        path?: unknown;
        repo?: unknown;
        worktree?: unknown;
        start?: unknown;
        end?: unknown;
        side?: unknown;
      };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      const start = Number(body.start);
      const end = Number(body.end);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1) {
        return json({ error: "Invalid line range" }, 400);
      }
      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      if (body.side === "deletions") {
        return json({ error: "Select added (+) lines to delete" }, 400);
      }
      if (!safeRepoPath(body.path)) {
        return json({ error: "Invalid path" }, 400);
      }
      try {
        if (body.source === "working") {
          const dir = dirForWorktree(body.worktree, body.repo);
          const fileAbs = `${dir}/${body.path}`;
          await Bun.write(fileAbs, removeFileLines(await Bun.file(fileAbs).text(), lo, hi));
          return json({ ok: true });
        }
        if (body.source === "patch") {
          if (typeof body.name !== "string" || !/^[^/\0]+\.patch$/.test(body.name)) {
            return json({ error: "Invalid patch name" }, 400);
          }
          const patchPath = `${cwd}/diffs/${body.name}`;
          const edited = removePatchAdditions(await Bun.file(patchPath).text(), body.path, lo, hi);
          await Bun.write(patchPath, edited);
          return json({ ok: true });
        }
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
      return json({ error: "Invalid source" }, 400);
    }

    const prDiffMatch = url.pathname.match(/^\/api\/diff\/pr\/(\d{1,7})$/);
    if (prDiffMatch) {
      const r = repoByKey(url.searchParams.get("repo"));
      try {
        const diff = await $`gh pr diff ${prDiffMatch[1]}`.cwd(r.dir).quiet().text();
        return new Response(diff, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      } catch (e) {
        return new Response(errText(e), { status: 502 });
      }
    }

    const diffMatch = url.pathname.match(/^\/api\/diff\/([0-9a-f]{7,40})$/);
    if (diffMatch) {
      const r = repoByKey(url.searchParams.get("repo"));
      try {
        return new Response(await commitDiff(r, diffMatch[1]), {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      } catch (e) {
        return new Response(errText(e), { status: 502 });
      }
    }

    return new Response(page, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
});

console.log(`diffshub for ${label} running at http://localhost:${server.port}`);
