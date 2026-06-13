#!/usr/bin/env bun

import { $ } from "bun";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { removeFileLines, removePatchAdditions } from "./patch-edit";

const cwd = process.cwd();
const port = parseInt(process.argv[2] || "3433", 10); // 3433 = DIFF on a phone keypad
const here = dirname(fileURLToPath(import.meta.url));

// ---- Directories & repo resolution ----
// A "directory" (persisted in sqlite) is a top-level entry the UI switches
// between. It resolves into one or more git repos:
//   single-repo:  the directory itself is a git repo (today's default).
//   workspace:    a non-git folder combining sub-repos (e.g. ~/work = app+web),
//                 or any directory given an explicit member list.
// Members come from the directory's `repos` column, then (for the launch cwd
// only) $DIFFSHUB_REPOS, then ./.diffshub.json, then the app+web default, then a
// scan of every immediate child git repo.

interface RepoCtx {
  key: string;
  dir: string;
  nameWithOwner: string;
  branch: string;
}

interface DirRow {
  id: number;
  path: string;
  name: string;
  repos: string | null; // JSON string[] of member sub-dir names, or null = auto
  created_at: number;
}

interface Workspace {
  id: number;
  path: string;
  name: string;
  repos: RepoCtx[];
  isWorkspace: boolean; // multi-repo parent (vs a single git repo)
  label: string;
  // Worktree dirs reported by the last /api/changes for this workspace; git
  // actions may only target a dir in this set (an echoed path can't escape).
  worktreeDirs: Set<string>;
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

// A member repo, falling back to a local-only RepoCtx when its GitHub remote
// can't be read — so Changes + the file index still work (commits/PRs need gh).
async function resolveRepoOrLocal(key: string, dir: string): Promise<RepoCtx> {
  const r = await resolveRepo(key, dir);
  if (r) return r;
  let branch = "";
  try {
    branch = (await $`git -C ${dir} branch --show-current`.quiet().text()).trim();
  } catch {}
  return { key, dir, nameWithOwner: "", branch };
}

// A directory's stored member list (JSON string[]) → clean array, or null to auto-detect.
function parseRepos(repos: string | null): string[] | null {
  if (!repos) return null;
  try {
    const arr = JSON.parse(repos);
    if (Array.isArray(arr)) {
      const list = arr
        .filter((x: unknown): x is string => typeof x === "string")
        .map((s) => s.trim())
        .filter(Boolean);
      return list.length ? list : null;
    }
  } catch {}
  return null;
}

// Member repos for a workspace directory (non-git parent or explicit list).
async function resolveMemberRepos(path: string, explicit: string[] | null): Promise<RepoCtx[]> {
  let keys: string[] = explicit ? [...explicit] : [];
  if (!keys.length && path === cwd) {
    const env = process.env.DIFFSHUB_REPOS;
    if (env) keys = env.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (!keys.length) {
    try {
      const cfg = await Bun.file(`${path}/.diffshub.json`).json();
      const list = Array.isArray(cfg) ? cfg : cfg?.repos;
      if (Array.isArray(list)) keys = list.filter((x: unknown): x is string => typeof x === "string");
    } catch {}
  }
  if (!keys.length) keys = ["app", "web"];
  let resolved = await Promise.all(
    keys
      .filter((k) => existsSync(`${path}/${k}/.git`))
      .map((k) => resolveRepoOrLocal(k, `${path}/${k}`)),
  );
  if (!resolved.length) {
    // Fall back to every immediate child that is a git repo.
    let children: string[] = [];
    try {
      children = readdirSync(path, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(`${path}/${e.name}/.git`))
        .map((e) => e.name)
        .sort();
    } catch {}
    resolved = await Promise.all(children.map((k) => resolveRepoOrLocal(k, `${path}/${k}`)));
  }
  return resolved;
}

// Resolve a directory path into repos. A git repo with no explicit member list is
// single-repo mode; otherwise it's a workspace. A git repo whose GitHub remote
// can't be read still yields a local-only RepoCtx so the Changes tab works.
async function resolveMembers(
  path: string,
  explicit: string[] | null,
): Promise<{ repos: RepoCtx[]; isWorkspace: boolean }> {
  if (!explicit && (await isGitWorkTree(path))) {
    const r = await resolveRepo("", path);
    if (r) {
      r.key = r.nameWithOwner.split("/").pop() || "repo";
      return { repos: [r], isWorkspace: false };
    }
    let branch = "";
    try {
      branch = (await $`git -C ${path} branch --show-current`.quiet().text()).trim();
    } catch {}
    return {
      repos: [{ key: path.split("/").pop() || "repo", dir: path, nameWithOwner: "", branch }],
      isWorkspace: false,
    };
  }
  return { repos: await resolveMemberRepos(path, explicit), isWorkspace: true };
}

async function resolveWorkspace(row: DirRow): Promise<Workspace> {
  const { repos, isWorkspace } = await resolveMembers(row.path, parseRepos(row.repos));
  const label = isWorkspace
    ? `${row.path.split("/").pop()} (${repos.map((r) => r.key).join(" · ")})`
    : repos[0]?.nameWithOwner || repos[0]?.key || row.name;
  return { id: row.id, path: row.path, name: row.name, repos, isWorkspace, label, worktreeDirs: new Set() };
}

const repoByKey = (ws: Workspace, key?: string | null): RepoCtx | undefined =>
  ws.repos.find((r) => r.key === key) ?? ws.repos[0];

// ---- Persistent state (sqlite) ----
const stateDir = `${process.env.HOME}/.local/state/diffshub`;
mkdirSync(stateDir, { recursive: true });
const db = new Database(`${stateDir}/diffshub.sqlite`);
// Reviewed-commit tracking, persisted per repo (by nameWithOwner).
db.run(`CREATE TABLE IF NOT EXISTS reviewed (
  repo TEXT NOT NULL,
  sha TEXT NOT NULL,
  reviewed_at INTEGER NOT NULL,
  PRIMARY KEY (repo, sha)
)`);
// Switchable directories the UI lists in the top-left dropdown.
db.run(`CREATE TABLE IF NOT EXISTS directories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  repos TEXT,
  created_at INTEGER NOT NULL
)`);
// Per-directory file index (gitignore-respecting) for @-file references.
db.run(`CREATE TABLE IF NOT EXISTS files (
  dir_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (dir_id, path)
)`);
db.run(`CREATE INDEX IF NOT EXISTS files_dir ON files(dir_id)`);

const markReviewedStmt = db.query(
  "INSERT OR REPLACE INTO reviewed (repo, sha, reviewed_at) VALUES (?, ?, ?)",
);
const unmarkReviewedStmt = db.query("DELETE FROM reviewed WHERE repo = ? AND sha = ?");

const listDirsStmt = db.query<DirRow, []>("SELECT * FROM directories ORDER BY created_at, id");
const getDirStmt = db.query<DirRow, [number]>("SELECT * FROM directories WHERE id = ?");
const getDirByPathStmt = db.query<DirRow, [string]>("SELECT * FROM directories WHERE path = ?");
const insertDirStmt = db.query<{ id: number }, [string, string, string | null, number]>(
  "INSERT INTO directories (path, name, repos, created_at) VALUES (?, ?, ?, ?) RETURNING id",
);
const insertFileStmt = db.query("INSERT OR IGNORE INTO files (dir_id, path) VALUES (?, ?)");
const listFilesStmt = db.query<{ path: string }, [number]>(
  "SELECT path FROM files WHERE dir_id = ? ORDER BY path",
);

// ---- Resolved-workspace cache (gh calls are slow) ----
const wsCache = new Map<number, Promise<Workspace>>();
function getWorkspace(id: number): Promise<Workspace> {
  let p = wsCache.get(id);
  if (!p) {
    const row = getDirStmt.get(id);
    if (!row) return Promise.reject(new Error(`No directory #${id}`));
    p = resolveWorkspace(row);
    wsCache.set(id, p);
    p.catch(() => wsCache.delete(id)); // let a failed resolution retry next time
  }
  return p;
}
const invalidateWorkspace = (id: number) => wsCache.delete(id);

// Tilde-expand a user-entered path.
function expandTilde(p: string): string {
  if (p === "~") return process.env.HOME || p;
  if (p.startsWith("~/")) return `${process.env.HOME}/${p.slice(2)}`;
  return p;
}

// Normalize a member-repos input (comma/space text or array) to a JSON string or null.
function normalizeReposInput(input: unknown): string | null {
  let list: string[] = [];
  if (typeof input === "string") list = input.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  else if (Array.isArray(input))
    list = input.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean);
  return list.length ? JSON.stringify(list) : null;
}

// ---- File index (gitignore-respecting) ----
const MAX_INDEX_FILES = 20000;
class TooManyFiles extends Error {
  constructor(public count: number) {
    super(`${count} files (max ${MAX_INDEX_FILES}) — set member repos to narrow`);
  }
}

// Every referencable file across a workspace's repos, respecting .gitignore.
// Workspace paths are prefixed with the member key so they're relative to ws.path.
async function collectFiles(repos: RepoCtx[], isWorkspace: boolean): Promise<string[]> {
  const lists = await Promise.all(
    repos.map(async (r) => {
      let out: string;
      try {
        out = await $`git -C ${r.dir} ls-files --cached --others --exclude-standard -z`.quiet().text();
      } catch {
        return [] as string[];
      }
      const paths = out.split("\0").filter(Boolean);
      return isWorkspace ? paths.map((p) => `${r.key}/${p}`) : paths;
    }),
  );
  return lists.flat();
}

// Sync the file index for a directory to `paths` as a delta (a no-op writes nothing).
function syncFiles(dirId: number, paths: string[]): void {
  const current = new Set(listFilesStmt.all(dirId).map((r) => r.path));
  const next = new Set(paths);
  const toAdd = paths.filter((p) => !current.has(p));
  const toRemove = [...current].filter((p) => !next.has(p));
  if (!toAdd.length && !toRemove.length) return;
  db.transaction(() => {
    for (const p of toRemove) db.run("DELETE FROM files WHERE dir_id = ? AND path = ?", [dirId, p]);
    for (const p of toAdd) insertFileStmt.run(dirId, p);
  })();
}

// Count first; throw TooManyFiles before writing any rows.
async function indexFiles(dirId: number, repos: RepoCtx[], isWorkspace: boolean): Promise<number> {
  const paths = await collectFiles(repos, isWorkspace);
  if (paths.length > MAX_INDEX_FILES) throw new TooManyFiles(paths.length);
  syncFiles(dirId, paths);
  return paths.length;
}

// Ensure the launch cwd is registered — it's the default directory the UI opens.
function ensureCwdDir(): number {
  const existing = getDirByPathStmt.get(cwd);
  if (existing) return existing.id;
  return insertDirStmt.get(cwd, cwd.split("/").pop() || cwd, null, Date.now())!.id;
}
const defaultDirId = ensureCwdDir();

// Resolve the workspace for a request's ?dir=<id> (default = the launch cwd).
async function wsFromReq(url: URL): Promise<Workspace> {
  const raw = url.searchParams.get("dir");
  const id = raw ? parseInt(raw, 10) : defaultDirId;
  const useId = Number.isInteger(id) && getDirStmt.get(id) ? id : defaultDirId;
  return getWorkspace(useId);
}

// Warm the default directory's resolution + file index (best-effort; the cwd is
// exempt from the too-many-files refusal so the server always has a usable default).
getWorkspace(defaultDirId)
  .then((ws) => indexFiles(ws.id, ws.repos, ws.isWorkspace).catch(() => {}))
  .catch(() => {});

// Permissive CORS so the Chrome extension's content scripts can call the API
// from any origin (the server is localhost-only and personal).
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
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

// Paste text into a running pane via a tmux buffer (robust for multi-line input
// and special characters, unlike literal send-keys) and submit it with Enter.
async function pasteAndSubmit(name: string, text: string): Promise<void> {
  const bufFile = `${stateDir}/claude-prompt-${Date.now()}.txt`;
  await Bun.write(bufFile, text);
  const buf = `diffshub-${name}`;
  await $`tmux -L default load-buffer -b ${buf} ${bufFile}`.quiet();
  await $`tmux -L default paste-buffer -d -b ${buf} -t ${`${name}:0.0`}`.quiet();
  await $`tmux -L default send-keys -t ${`${name}:0.0`} Enter`.quiet();
  await $`rm -f ${bufFile}`.quiet();
}

// Paste the prompt into a freshly-started claude session and submit it. Runs
// fire-and-forget after a short delay so claude's TUI is ready to receive it.
async function sendClaudePrompt(name: string, prompt: string): Promise<void> {
  try {
    await Bun.sleep(1000);
    await pasteAndSubmit(name, prompt);
  } catch {}
}

// Launch an interactive claude session detached in the directory (mirrors `p`),
// returning the session name so the caller can `tmux attach -t <name>`.
// We mint the claude session id ourselves (`--session-id`) and stamp it onto the
// tmux session as the `@claude_session` user option, so the Tmux tab can map this
// session straight to its ~/.claude transcript (see resolveTranscript).
async function newClaudeSession(dir: string, prompt: string): Promise<string> {
  const name = await pickClaudeSessionName();
  const sid = crypto.randomUUID();
  const claudeCmd = `CLAUDE_CODE_NO_FLICKER=1 direnv exec ${shq(dir)} claude --session-id ${sid}`;
  await $`tmux -L default new-session -ds ${name} -c ${dir} ${claudeCmd}`.quiet();
  await $`tmux -L default set-option -t ${name} @claude_session ${sid}`.quiet().catch(() => {});
  if (prompt.trim()) void sendClaudePrompt(name, prompt);
  return name;
}

// ---- Tmux tab: claude sessions <-> ~/.claude transcripts ----
// claude stores each session's transcript at
//   ~/.claude/projects/<munged-cwd>/<session-id>.jsonl
// where the munged dir replaces every non-alphanumeric char with "-"
// (e.g. /Users/me/.dotfiles -> -Users-me--dotfiles).
const claudeProjectsRoot = `${process.env.HOME}/.claude/projects`;
const mungeDir = (p: string) => p.replace(/[^a-zA-Z0-9]/g, "-");

// Find a transcript by session id regardless of which project dir it landed in
// (robust against any munging quirks): scan project dirs for "<sid>.jsonl".
function findTranscriptBySid(sid: string): string | null {
  if (!/^[0-9a-fA-F-]{8,}$/.test(sid)) return null;
  let subdirs: string[] = [];
  try {
    subdirs = readdirSync(claudeProjectsRoot);
  } catch {
    return null;
  }
  for (const sub of subdirs) {
    const candidate = `${claudeProjectsRoot}/${sub}/${sid}.jsonl`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// For untagged (legacy) sessions we can't go straight from session id to file, so
// we disambiguate within a cwd's project folder by matching the tmux pane title
// to a transcript's ai-title (claude keeps both in sync). This is what lets two
// sessions sharing one directory map to their own transcripts.
interface Candidate {
  path: string;
  mtime: number;
  aiTitle: string;
}

// Read the most recent ai-title from a transcript. claude rewrites it throughout
// the session, so it's reliably in the tail — we only read the last chunk.
async function tailAiTitle(path: string): Promise<string> {
  try {
    const file = Bun.file(path);
    const size = file.size;
    const text = await file.slice(size > 65536 ? size - 65536 : 0).text();
    let title = "";
    for (const line of text.split("\n")) {
      if (!line.includes('"ai-title"')) continue;
      try {
        const d = JSON.parse(line);
        if (d?.type === "ai-title" && typeof d.aiTitle === "string") title = d.aiTitle;
      } catch {}
    }
    return title;
  } catch {
    return "";
  }
}

// The recent .jsonl transcripts in a cwd's project folder, newest first, each
// with its ai-title. Capped so a busy folder stays cheap.
async function dirCandidates(cwd: string): Promise<Candidate[]> {
  const dir = `${claudeProjectsRoot}/${mungeDir(cwd)}`;
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const recent = files
    .map((f) => {
      const path = `${dir}/${f}`;
      let mtime = 0;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {}
      return { path, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)
    // Cap so a giant folder stays bounded; live sessions (incl. idle ones whose
    // files are older) need a wide enough net to title-match against.
    .slice(0, 400);
  return Promise.all(recent.map(async (c) => ({ ...c, aiTitle: await tailAiTitle(c.path) })));
}

// Tolerant title comparison — terminal titles can be truncated, so accept a
// prefix match (of meaningful length) either direction.
function titlesMatch(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  return Math.min(x.length, y.length) >= 12 && (x.startsWith(y) || y.startsWith(x));
}

// Resolve a tmux session to its transcript. Tagged sessions (@claude_session) map
// directly by id; untagged ones match by ai-title within the cwd, falling back to
// the most recently modified transcript there.
async function resolveTranscript(
  cwd: string,
  sid: string,
  task: string,
  cache?: Map<string, Candidate[]>,
): Promise<string | null> {
  if (sid) {
    const byId = findTranscriptBySid(sid);
    if (byId) return byId;
    const expected = `${claudeProjectsRoot}/${mungeDir(cwd)}/${sid}.jsonl`;
    if (existsSync(expected)) return expected;
  }
  let cands = cache?.get(cwd);
  if (!cands) {
    cands = await dirCandidates(cwd);
    cache?.set(cwd, cands);
  }
  if (task) {
    const hit = cands.find((c) => titlesMatch(c.aiTitle, task));
    if (hit) return hit.path;
  }
  return cands[0]?.path ?? null;
}

// Strip claude's leading status glyph (spinner / ✳) from a pane title, leaving
// the task summary. Returns "" when the title isn't a meaningful task.
function cleanTitle(title: string, name: string, cmd: string): string {
  let task = (title ?? "").replace(/^[^\x00-\x7f]\s*/u, "").trim();
  // Drop non-task titles: the session/command name, a bare shell, or claude's
  // default "Claude Code" placeholder shown before it generates a real title.
  if (task === name || task === "zsh" || task === cmd || task === "Claude Code" || task === "claude")
    task = "";
  return task;
}

interface TmuxSession {
  name: string;
  cwd: string;
  task: string; // what claude is doing (cleaned pane title), "" if not meaningful
  busy: boolean; // claude is actively working (braille-spinner pane title)
  sessionId: string; // @claude_session if tagged, else ""
  hasTranscript: boolean;
  mtime: number; // transcript mtime (ms), 0 if none — used for sorting
}

// List tmux sessions on the default socket that are running claude, each resolved
// to its transcript. `pane_current_command` is claude's version string (e.g.
// "2.1.177") once it's running, so we match that, "claude", or "node".
async function listClaudeSessions(): Promise<TmuxSession[]> {
  const SEP = "\x1f";
  const fmt = ["#{session_name}", "#{pane_current_path}", "#{pane_current_command}", "#{pane_title}", "#{@claude_session}"].join(SEP);
  let raw = "";
  try {
    raw = await $`tmux -L default list-sessions -F ${fmt}`.quiet().text();
  } catch {
    return [];
  }
  const cache = new Map<string, Candidate[]>(); // dir -> candidates, reused across same-dir sessions
  const out: TmuxSession[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [name, cwd, cmd, title, sid] = line.split(SEP);
    if (!name) continue;
    const isClaude = /claude|node/.test(cmd) || /^[0-9]+\.[0-9]+/.test(cmd);
    if (!isClaude) continue;
    // Pane title is claude's status: a leading braille glyph (U+2800–U+28FF)
    // means it's actively working; "✳" (and other leading glyphs) mean idle.
    const busy = /^[⠀-⣿]/u.test(title ?? "");
    const task = cleanTitle(title ?? "", name, cmd ?? "");
    const path = await resolveTranscript(cwd ?? "", sid ?? "", task, cache);
    let mtime = 0;
    if (path) {
      try {
        mtime = statSync(path).mtimeMs;
      } catch {}
    }
    out.push({ name, cwd: cwd ?? "", task, busy, sessionId: sid ?? "", hasTranscript: !!path, mtime });
  }
  // Most recently active first.
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

interface TranscriptMsg {
  role: "user" | "assistant" | "tool";
  kind: "text" | "tool_use" | "tool_result";
  text: string;
  tool?: string; // tool name for tool_use
  ts?: string; // ISO timestamp
}

// One-line-ish summary of a tool call's input for the transcript.
function summarizeToolInput(name: string, input: any): string {
  if (input == null || typeof input !== "object") return "";
  const pick = (k: string) => (typeof input[k] === "string" ? input[k] : "");
  if (name === "Bash") return pick("command");
  if (name === "Read" || name === "Edit" || name === "Write" || name === "NotebookEdit")
    return pick("file_path") || pick("notebook_path");
  if (name === "Grep") return [pick("pattern"), pick("path") && `in ${pick("path")}`].filter(Boolean).join(" ");
  if (name === "Glob") return pick("pattern");
  if (name === "Task") return pick("description") || pick("subagent_type");
  if (name === "TodoWrite") return Array.isArray(input.todos) ? `${input.todos.length} todos` : "";
  const s = JSON.stringify(input);
  return s.length > 200 ? s.slice(0, 200) + "…" : s;
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((b: any) => (typeof b === "string" ? b : b?.type === "text" ? b.text : b?.text ?? ""))
      .filter(Boolean)
      .join("\n");
  return "";
}

// Parse a claude .jsonl transcript into a readable conversation, keeping only the
// last `limit` messages (the "latest part" the Tmux tab shows). Text is truncated
// so a multi-MB transcript stays a small payload.
function parseTranscript(text: string, limit: number): { messages: TranscriptMsg[]; model: string; title: string } {
  const msgs: TranscriptMsg[] = [];
  let model = "";
  let title = "";
  const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "\n… (truncated)" : s);
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d?.type === "ai-title" && typeof d.aiTitle === "string") title = d.aiTitle;
    if (d?.isSidechain) continue; // skip subagent side-conversations
    const type = d?.type;
    if (type !== "user" && type !== "assistant") continue;
    const msg = d.message;
    if (!msg) continue;
    const ts = typeof d.timestamp === "string" ? d.timestamp : undefined;
    if (type === "assistant" && typeof msg.model === "string") model = msg.model;
    const content = msg.content;
    if (type === "user") {
      if (typeof content === "string") {
        if (content.trim()) msgs.push({ role: "user", kind: "text", text: trunc(content, 8000), ts });
      } else if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === "text" && b.text?.trim())
            msgs.push({ role: "user", kind: "text", text: trunc(b.text, 8000), ts });
          else if (b?.type === "tool_result") {
            const t = blockText(b.content) || (typeof b.content === "string" ? b.content : "");
            msgs.push({ role: "tool", kind: "tool_result", text: trunc(t || "(tool result)", 2000), ts });
          }
        }
      }
    } else {
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === "text" && b.text?.trim())
            msgs.push({ role: "assistant", kind: "text", text: trunc(b.text, 8000), ts });
          else if (b?.type === "tool_use")
            msgs.push({
              role: "assistant",
              kind: "tool_use",
              tool: b.name,
              text: trunc(summarizeToolInput(b.name, b.input), 1000),
              ts,
            });
        }
      } else if (typeof content === "string" && content.trim()) {
        msgs.push({ role: "assistant", kind: "text", text: trunc(content, 8000), ts });
      }
    }
  }
  return { messages: msgs.slice(-limit), model, title };
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

async function listCommits(ws: Workspace, page: number): Promise<CommitSummary[]> {
  const settled = await Promise.allSettled(ws.repos.map((r) => listCommitsForRepo(r, page)));
  return settle(settled).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

interface PrSummary {
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

async function listPrsForRepo(r: RepoCtx): Promise<PrSummary[]> {
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

async function listPrs(ws: Workspace) {
  const settled = await Promise.allSettled(ws.repos.map((r) => listPrsForRepo(r)));
  return settle(settled).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

// Commit diffs are immutable, cache them for the lifetime of the server
const diffCache = new Map<string, string>();

async function commitDiff(r: RepoCtx, sha: string): Promise<string> {
  const cacheKey = `${r.nameWithOwner}:${sha}`;
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

async function getChangesForRepo(ws: Workspace, r: RepoCtx): Promise<RepoChanges[]> {
  const worktrees = await listWorktrees(r.dir);
  const multiWt = worktrees.length > 1;
  return Promise.all(
    worktrees.map(async (wt) => {
      const status = await statusDir(wt.dir);
      const wtLabel = wt.branch || wt.dir.split("/").pop() || wt.dir;
      const segment =
        ws.isWorkspace && multiWt
          ? `${r.key} · ${wtLabel}`
          : multiWt
            ? wtLabel
            : ws.isWorkspace
              ? r.key
              : "";
      return { repo: r.key, segment, dir: wt.dir, ...status };
    }),
  );
}

async function getChanges(ws: Workspace): Promise<RepoChanges[]> {
  const all = (await Promise.all(ws.repos.map((r) => getChangesForRepo(ws, r)))).flat();
  ws.worktreeDirs.clear();
  for (const rc of all) ws.worktreeDirs.add(rc.dir);
  // Keep the file index fresh on every Changes refresh — never fatal to the view
  // (a directory that has grown past the limit just keeps its existing rows).
  void indexFiles(ws.id, ws.repos, ws.isWorkspace).catch(() => {});
  return all;
}

// Resolve a client-supplied worktree dir to a real directory, only allowing a
// dir this workspace has already reported; falls back to the repo's main dir.
function dirForWorktree(ws: Workspace, worktree: unknown, repoKey: unknown): string {
  if (typeof worktree === "string" && ws.worktreeDirs.has(worktree)) return worktree;
  return repoByKey(ws, typeof repoKey === "string" ? repoKey : null)?.dir ?? ws.path;
}

// ---- Manual patches (./diffs/*.patch in the directory) ----

interface ManualPatch {
  name: string;
  contents: string;
}

async function listManualPatches(ws: Workspace): Promise<ManualPatch[]> {
  let names: string[];
  try {
    names = readdirSync(`${ws.path}/diffs`)
      .filter((n) => n.endsWith(".patch"))
      .sort();
  } catch {
    return []; // no ./diffs directory — just an empty list
  }
  return Promise.all(
    names.map(async (name) => ({
      name,
      contents: await Bun.file(`${ws.path}/diffs/${name}`)
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
<title>diffshub</title>
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
    flex: 1; height: 30px; cursor: pointer; position: relative;
    display: flex; align-items: center; justify-content: center;
    background: none; border: none; border-radius: 5px; color: #71717a;
  }
  .tabs button:hover { color: #18181b; }
  .tabs button.on { background: #ffffff; color: #6e56cf; box-shadow: 0 1px 2px rgba(0, 0, 0, .08); }
  .tabs button svg { width: 16px; height: 16px; display: block; }
  /* count badge (e.g. number of manual patches / tmux sessions) */
  .tabs button .tab-badge {
    position: absolute; top: 1px; right: 4px; min-width: 13px; height: 13px;
    padding: 0 3px; border-radius: 7px; background: #6e56cf; color: #fff;
    font-size: 9px; line-height: 13px; font-weight: 600; text-align: center;
  }
  /* hover tooltip driven by data-tip */
  .tabs button[data-tip]::after {
    content: attr(data-tip); position: absolute; top: calc(100% + 6px); left: 50%;
    transform: translateX(-50%); white-space: nowrap; pointer-events: none;
    background: #18181b; color: #fff; font-size: 11px; padding: 3px 7px;
    border-radius: 5px; opacity: 0; transition: opacity .12s ease .15s; z-index: 30;
  }
  .tabs button[data-tip]::before {
    content: ""; position: absolute; top: calc(100% + 1px); left: 50%;
    transform: translateX(-50%); border: 5px solid transparent;
    border-bottom-color: #18181b; opacity: 0; transition: opacity .12s ease .15s; z-index: 30;
  }
  .tabs button[data-tip]:hover::after, .tabs button[data-tip]:hover::before { opacity: 1; }

  /* ---- Tmux tab: session list rows ---- */
  .sess-busy {
    flex-shrink: 0; width: 7px; height: 7px; border-radius: 50%;
    background: #d4d4d8; margin-right: 7px;
  }
  .sess-busy.on { background: #6e56cf; box-shadow: 0 0 0 0 rgba(110,86,207,.5); animation: sessPulse 1.4s ease-in-out infinite; }
  @keyframes sessPulse { 0% { box-shadow: 0 0 0 0 rgba(110,86,207,.5); } 70% { box-shadow: 0 0 0 5px rgba(110,86,207,0); } 100% { box-shadow: 0 0 0 0 rgba(110,86,207,0); } }
  .commit .sess-top { display: flex; align-items: center; }
  .sess-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .commit .sess-task { color: #71717a; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-left: 14px; margin-top: 2px; padding-right: 22px; }
  .commit .sess-cwd { color: #a1a1aa; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-left: 14px; }
  .kill-btn {
    position: absolute; top: 9px; right: 10px; width: 18px; height: 18px;
    display: flex; align-items: center; justify-content: center; padding: 0;
    background: none; border: 1px solid #d4d4d8; border-radius: 50%;
    color: #a1a1aa; font-size: 11px; cursor: pointer; opacity: 0;
  }
  .commit:hover .kill-btn { opacity: 1; }
  .kill-btn:hover { background: #fee2e2; border-color: #fca5a5; color: #dc2626; }

  /* ---- Tmux tab: transcript (ChatGPT-style chat) ---- */
  .transcript { max-width: 820px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
  .transcript-head {
    position: sticky; top: 0; z-index: 5; background: #ffffff;
    margin: 0 0 2px; padding: 10px 0;
    border-bottom: 1px solid #e4e4e7; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
  }
  /* Opaque shield filling any strip above the stuck header (e.g. the scroll
     container's top padding) so scrolled messages never peek above the title. */
  .transcript-head::before {
    content: ""; position: absolute; left: 0; right: 0; bottom: 100%; height: 20px; background: #ffffff;
  }
  .transcript-head h2 { font-size: 14px; margin: 0; }
  .transcript-head .t-sub { font-size: 11px; color: #71717a; }
  /* Chat turns */
  .turn { display: flex; gap: 11px; align-items: flex-start; }
  .turn.user { flex-direction: column; align-items: flex-end; gap: 6px; }
  .turn.user .bubble {
    max-width: 80%; background: #f4f4f5; color: #18181b;
    border-radius: 18px; padding: 10px 15px; text-align: left;
    white-space: pre-wrap; word-break: break-word; font-size: 14px; line-height: 1.55;
  }
  .turn.assistant .avatar {
    width: 26px; height: 26px; flex-shrink: 0; margin-top: 1px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 50%; color: #ffffff; background: linear-gradient(135deg, #8771dd, #6e56cf);
  }
  .turn.assistant .content {
    flex: 1; min-width: 0; padding-top: 2px;
    display: flex; flex-direction: column; gap: 10px;
  }

  /* Tool calls inside an assistant turn */
  .tool-use {
    align-self: flex-start; max-width: 100%;
    display: inline-flex; align-items: baseline; gap: 7px; flex-wrap: wrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
    color: #52525b; background: #f4f4f5; border: 1px solid #e4e4e7; border-radius: 6px; padding: 4px 9px;
  }
  .tool-use .tool-name { color: #6e56cf; font-weight: 600; }
  .tool-use .tool-name::before { content: "⚒ "; opacity: .8; }
  .tool-use .tool-arg { color: #71717a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .tool-result {
    align-self: flex-start; max-width: 100%;
    background: #fafafa; border: 1px solid #e4e4e7; border-radius: 6px;
  }
  .tool-result pre {
    margin: 0; padding: 7px 10px; max-height: 9em; overflow: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
    color: #71717a; white-space: pre-wrap; word-break: break-word;
  }

  /* "Claude is working" typing indicator */
  .typing { display: inline-flex; gap: 4px; padding: 6px 2px; }
  .typing span { width: 6px; height: 6px; border-radius: 50%; background: #b8a9ec; animation: typing 1.2s infinite ease-in-out; }
  .typing span:nth-child(2) { animation-delay: .15s; }
  .typing span:nth-child(3) { animation-delay: .3s; }
  @keyframes typing { 0%, 60%, 100% { opacity: .3; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-3px); } }

  /* Markdown rendering of assistant messages */
  .md { font-size: 14px; line-height: 1.62; color: #1f2328; word-break: break-word; }
  .md > :first-child { margin-top: 0; }
  .md > :last-child { margin-bottom: 0; }
  .md p { margin: 0 0 10px; white-space: pre-wrap; }
  .md .md-h { font-weight: 650; line-height: 1.3; margin: 18px 0 8px; }
  .md .md-h.h1 { font-size: 19px; }
  .md .md-h.h2 { font-size: 16px; }
  .md .md-h.h3, .md .md-h.h4, .md .md-h.h5, .md .md-h.h6 { font-size: 14px; }
  .md ul, .md ol { margin: 0 0 10px; padding-left: 22px; }
  .md li { margin: 3px 0; }
  .md a { color: #6e56cf; text-decoration: underline; }
  .md a:hover { color: #5a45b0; }
  .md strong { font-weight: 650; }
  .md em { font-style: italic; }
  .md blockquote.md-quote { margin: 0 0 10px; padding: 2px 0 2px 13px; border-left: 3px solid #e4e4e7; color: #52525b; }
  .md hr.md-hr { border: none; border-top: 1px solid #e4e4e7; margin: 16px 0; }
  .md-code-inline {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .88em;
    background: #f0f0f1; border: 1px solid #e7e7ea; border-radius: 5px; padding: .5px 5px;
  }
  /* Fenced code blocks */
  .md-code { margin: 0 0 10px; border: 1px solid #e4e4e7; border-radius: 8px; overflow: hidden; background: #fcfcfd; }
  .md-code-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 4px 8px 4px 11px; background: #f4f4f5; border-bottom: 1px solid #e4e4e7;
    font-size: 11px; color: #71717a;
  }
  .md-code-head .lang { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: lowercase; }
  .md-code-head .copy { background: none; border: none; cursor: pointer; color: #71717a; font-size: 11px; padding: 2px 7px; border-radius: 5px; }
  .md-code-head .copy:hover { background: #e4e4e7; color: #18181b; }
  .md-code pre { margin: 0; padding: 11px 12px; overflow-x: auto; }
  .md-code code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; line-height: 1.55; color: #1f2328; white-space: pre; }
  .transcript-empty { color: #71717a; padding: 40px 0; text-align: center; }

  /* Reply composer pinned to the bottom of the transcript column. Mirrors the
     New Claude session textarea: multi-line, ⌃V image paste, ↵ to send. */
  .reply-box {
    position: sticky; bottom: 0; z-index: 4;
    margin-top: 6px; padding: 10px 0 14px;
    background: #ffffff; border-top: 1px solid #e4e4e7;
  }
  .reply-input {
    width: 100%; min-height: 46px; max-height: 220px; resize: vertical;
    background: #ffffff; color: inherit; font: inherit; line-height: 1.5;
    border: 1px solid #d4d4d8; border-radius: 8px; padding: 8px 10px; outline: none;
  }
  .reply-input:focus { border-color: #6e56cf; }
  .reply-bar { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
  .reply-bar .spacer { flex: 1; }
  .reply-bar .act { padding: 5px 16px; font-size: 12px; border-radius: 7px; }
  .reply-bar .act.primary { background: #6e56cf; border-color: #6e56cf; color: #fff; }
  .reply-bar .act.primary:hover:not(:disabled) { background: #7d68d6; border-color: #7d68d6; }
  .reply-hint { font-size: 11px; color: #a1a1aa; display: flex; gap: 10px; flex-wrap: wrap; }
  .reply-hint kbd { background: #e4e4e7; border-radius: 3px; padding: 1px 4px; }

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
  /* Tmux tab: drop the top/bottom padding so the sticky title and the reply
     composer sit flush against the column edges. */
  .diffs.tmux { padding: 0 20px; }
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

  /* Top-left directory dropdown */
  .dir-dropdown { position: relative; margin-bottom: 10px; }
  .dir-trigger {
    display: flex; align-items: center; gap: 6px; width: 100%;
    padding: 7px 10px; cursor: pointer; text-align: left;
    background: #ffffff; border: 1px solid #d4d4d8; border-radius: 7px; color: #18181b;
  }
  .dir-trigger:hover { border-color: #6e56cf; }
  .dir-trigger .dir-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dir-trigger .dir-sub { font-size: 11px; font-weight: 400; color: #71717a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dir-trigger .dir-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .dir-trigger .dir-caret { margin-left: auto; color: #a1a1aa; font-size: 10px; flex-shrink: 0; }
  .dir-menu {
    position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 30;
    background: #ffffff; border: 1px solid #e4e4e7; border-radius: 8px;
    box-shadow: 0 10px 34px rgba(0, 0, 0, .16); padding: 4px; max-height: 60vh; overflow-y: auto;
  }
  .dir-item {
    display: flex; flex-direction: column; gap: 1px; width: 100%; text-align: left; cursor: pointer;
    padding: 6px 9px; background: none; border: none; border-radius: 6px;
  }
  .dir-item:hover { background: #f0f0f1; }
  .dir-item.on { background: #efe9fb; }
  .dir-item .dir-item-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dir-item .dir-item-path { font-size: 11px; color: #71717a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dir-menu-sep { height: 1px; background: #e4e4e7; margin: 4px 2px; }
  .dir-menu-act {
    display: block; width: 100%; text-align: left; cursor: pointer;
    padding: 6px 9px; background: none; border: none; border-radius: 6px; color: #52525b;
  }
  .dir-menu-act:hover { background: #f0f0f1; color: #18181b; }

  /* Settings dialog (manage directories) */
  .modal.wide { width: 560px; }
  .dir-rows { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; max-height: 46vh; overflow-y: auto; }
  .dir-row {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 10px; border: 1px solid #e4e4e7; border-radius: 8px;
  }
  .dir-row .dir-row-text { flex: 1; min-width: 0; }
  .dir-row .dir-row-name { font-weight: 600; }
  .dir-row .dir-row-meta { font-size: 11px; color: #71717a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dir-form { display: grid; grid-template-columns: 90px 1fr; gap: 8px 10px; align-items: center; }
  .dir-form label { font-size: 12px; color: #71717a; }
  .dir-form input {
    width: 100%; padding: 6px 9px; font: inherit; font-size: 13px;
    background: #ffffff; color: inherit; border: 1px solid #d4d4d8; border-radius: 6px; outline: none;
  }
  .dir-form input:focus { border-color: #6e56cf; }
  .dir-form .dir-form-hint { grid-column: 2; font-size: 11px; color: #a1a1aa; margin-top: -2px; }
  .modal-error { margin-top: 10px; color: #dc2626; font-size: 12px; white-space: pre-wrap; }

  /* @-file autocomplete popup in the New Claude session dialog */
  .file-menu-wrap { position: relative; }
  .file-menu {
    position: absolute; left: 0; right: 0; top: calc(100% + 2px); z-index: 60;
    background: #ffffff; border: 1px solid #e4e4e7; border-radius: 8px;
    box-shadow: 0 10px 34px rgba(0, 0, 0, .18); padding: 4px;
    max-height: 240px; overflow-y: auto;
  }
  .file-opt {
    display: block; width: 100%; text-align: left; cursor: pointer;
    padding: 5px 9px; background: none; border: none; border-radius: 6px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left;
  }
  .file-opt:hover, .file-opt.on { background: #efe9fb; }
  .file-menu-empty { padding: 8px 9px; color: #a1a1aa; font-size: 12px; }
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

    // CORS preflight for the extension's cross-origin API calls.
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === "/client.js") {
      return new Response(clientJS, {
        headers: { "Content-Type": "text/javascript; charset=utf-8" },
      });
    }

    // ---- Directory registry (top-left dropdown + settings dialog) ----
    if (url.pathname === "/api/dirs" && req.method === "GET") {
      return json({
        dirs: listDirsStmt.all().map((d) => ({
          id: d.id,
          path: d.path,
          name: d.name,
          repos: parseRepos(d.repos) ?? [],
        })),
        defaultDirId,
      });
    }

    if (url.pathname === "/api/dirs" && req.method === "POST") {
      let body: { path?: unknown; name?: unknown; repos?: unknown };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      if (typeof body.path !== "string" || !body.path.trim()) {
        return json({ error: "Path is required" }, 400);
      }
      const path = expandTilde(body.path.trim());
      try {
        if (!statSync(path).isDirectory()) return json({ error: `Not a directory: ${path}` }, 400);
      } catch {
        return json({ error: `No such directory: ${path}` }, 400);
      }
      if (getDirByPathStmt.get(path)) return json({ error: `Already added: ${path}` }, 409);
      const reposStr = normalizeReposInput(body.repos);
      const name =
        typeof body.name === "string" && body.name.trim()
          ? body.name.trim()
          : path.split("/").pop() || path;
      // Count files FIRST — refuse the whole add if it's over the limit (nothing
      // is created), so a giant directory never gets a row or a file index.
      let paths: string[];
      try {
        const { repos, isWorkspace } = await resolveMembers(path, parseRepos(reposStr));
        paths = await collectFiles(repos, isWorkspace);
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
      if (paths.length > MAX_INDEX_FILES) {
        return json({ error: new TooManyFiles(paths.length).message }, 400);
      }
      const id = db.transaction(() => {
        const created = insertDirStmt.get(path, name, reposStr, Date.now())!.id;
        for (const p of paths) insertFileStmt.run(created, p);
        return created;
      })();
      return json({ id, path, name, repos: parseRepos(reposStr) ?? [] }, 201);
    }

    const dirIdMatch = url.pathname.match(/^\/api\/dirs\/(\d+)$/);
    if (dirIdMatch && (req.method === "PATCH" || req.method === "DELETE")) {
      const id = parseInt(dirIdMatch[1], 10);
      const row = getDirStmt.get(id);
      if (!row) return json({ error: "No such directory" }, 404);

      if (req.method === "DELETE") {
        if (id === defaultDirId) {
          return json({ error: "Can't remove the launch directory" }, 400);
        }
        db.transaction(() => {
          db.run("DELETE FROM files WHERE dir_id = ?", [id]);
          db.run("DELETE FROM directories WHERE id = ?", [id]);
        })();
        invalidateWorkspace(id);
        return json({ ok: true });
      }

      // PATCH
      let body: { path?: unknown; name?: unknown; repos?: unknown };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      const newPath =
        typeof body.path === "string" && body.path.trim() ? expandTilde(body.path.trim()) : row.path;
      const newName =
        typeof body.name === "string" && body.name.trim() ? body.name.trim() : row.name;
      const newReposStr = body.repos !== undefined ? normalizeReposInput(body.repos) : row.repos;
      if (newPath !== row.path) {
        try {
          if (!statSync(newPath).isDirectory())
            return json({ error: `Not a directory: ${newPath}` }, 400);
        } catch {
          return json({ error: `No such directory: ${newPath}` }, 400);
        }
        const dup = getDirByPathStmt.get(newPath);
        if (dup && dup.id !== id) return json({ error: `Already added: ${newPath}` }, 409);
      }
      const reResolve = newPath !== row.path || newReposStr !== row.repos;
      if (reResolve) {
        let paths: string[];
        try {
          const { repos, isWorkspace } = await resolveMembers(newPath, parseRepos(newReposStr));
          paths = await collectFiles(repos, isWorkspace);
        } catch (e) {
          return json({ error: errText(e) }, 500);
        }
        if (paths.length > MAX_INDEX_FILES) {
          return json({ error: new TooManyFiles(paths.length).message }, 400);
        }
        db.transaction(() => {
          db.run("UPDATE directories SET path = ?, name = ?, repos = ? WHERE id = ?", [
            newPath,
            newName,
            newReposStr,
            id,
          ]);
          db.run("DELETE FROM files WHERE dir_id = ?", [id]);
          for (const p of paths) insertFileStmt.run(id, p);
        })();
      } else {
        db.run("UPDATE directories SET name = ? WHERE id = ?", [newName, id]);
      }
      invalidateWorkspace(id);
      return json({ ok: true });
    }

    // Indexed (gitignore-respecting) file list for the active directory.
    if (url.pathname === "/api/files") {
      let ws: Workspace;
      try {
        ws = await wsFromReq(url);
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
      return json({ files: listFilesStmt.all(ws.id).map((r) => r.path) });
    }

    if (url.pathname === "/api/meta") {
      let ws: Workspace;
      try {
        ws = await wsFromReq(url);
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
      return json({
        id: ws.id,
        name: ws.name,
        path: ws.path,
        cwd: ws.path, // alias kept for the client's claudeRef @-ref builder
        repo: ws.label,
        branch: ws.isWorkspace ? "" : ws.repos[0]?.branch ?? "",
        workspace: ws.isWorkspace,
        editor: editorName(),
        repos: ws.repos.map((r) => ({ key: r.key, nameWithOwner: r.nameWithOwner, branch: r.branch })),
        defaultDirId,
      });
    }

    if (url.pathname === "/api/commits") {
      const pageNum = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
      try {
        return json(await listCommits(await wsFromReq(url), pageNum));
      } catch (e) {
        return json({ error: errText(e) }, 502);
      }
    }

    if (url.pathname === "/api/prs") {
      try {
        return json(await listPrs(await wsFromReq(url)));
      } catch (e) {
        return new Response(errText(e), { status: 502 });
      }
    }

    if (url.pathname === "/api/changes") {
      try {
        return json(await getChanges(await wsFromReq(url)));
      } catch (e) {
        return new Response(errText(e), { status: 500 });
      }
    }

    if (url.pathname === "/api/manual") {
      try {
        return json(await listManualPatches(await wsFromReq(url)));
      } catch (e) {
        return new Response(errText(e), { status: 500 });
      }
    }

    if (url.pathname === "/api/reviewed") {
      let ws: Workspace;
      try {
        ws = await wsFromReq(url);
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
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
        const nwo = repoByKey(ws, typeof body.repo === "string" ? body.repo : null)?.nameWithOwner;
        if (!nwo) return json({ error: "No repo to mark" }, 400);
        if (body.reviewed) markReviewedStmt.run(nwo, body.sha, Date.now());
        else unmarkReviewedStmt.run(nwo, body.sha);
        return json({ ok: true });
      }
      const names = ws.repos.map((r) => r.nameWithOwner).filter(Boolean);
      if (!names.length) return json([]);
      const placeholders = names.map(() => "?").join(",");
      const rows = db
        .query<{ sha: string }, string[]>(
          `SELECT DISTINCT sha FROM reviewed WHERE repo IN (${placeholders})`,
        )
        .all(...names);
      return json(rows.map((r) => r.sha));
    }

    if (req.method === "POST" && url.pathname === "/api/git") {
      let ws: Workspace;
      try {
        ws = await wsFromReq(url);
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
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
        dirs = [dirForWorktree(ws, body.worktree, body.repo)];
      } else if (typeof body.worktree === "string" && ws.worktreeDirs.has(body.worktree)) {
        dirs = [body.worktree];
      } else if (typeof body.repo === "string") {
        const r = repoByKey(ws, body.repo);
        dirs = r ? [r.dir] : [];
      } else {
        dirs = ws.worktreeDirs.size ? [...ws.worktreeDirs] : ws.repos.map((r) => r.dir);
      }
      try {
        for (const dir of dirs) await runGitAction(action, dir, path as string | undefined);
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
      return json({ ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/commit") {
      let ws: Workspace;
      try {
        ws = await wsFromReq(url);
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
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
        ? [...new Set(body.worktrees.filter((d): d is string => typeof d === "string" && ws.worktreeDirs.has(d)))]
        : null;
      const targetDirs =
        wantedDirs && wantedDirs.length
          ? wantedDirs
          : ws.worktreeDirs.size
            ? [...ws.worktreeDirs]
            : ws.repos.map((r) => r.dir);
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
        await $`tmux -L bg new-session -d -c ${ws.path} -s ${session} ${script}`.cwd(ws.path).quiet();
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
      return json({ ok: true });
    }

    // Save a pasted image (base64 data URL or bare base64) to /tmp/images/<random>
    // and return its absolute path, so the New Claude session prompt can reference
    // it. claude's Read tool reads absolute paths (incl. /tmp) with no permission
    // prompt and renders images visually, so the detached session can see it.
    if (req.method === "POST" && url.pathname === "/api/upload-image") {
      let imgBody: { data?: unknown };
      try {
        imgBody = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      if (typeof imgBody.data !== "string" || !imgBody.data) {
        return json({ error: "Missing image data" }, 400);
      }
      const m = imgBody.data.match(/^data:(image\/[a-z0-9.+-]+)?;base64,(.*)$/is);
      const mime = (m?.[1] ?? "image/png").toLowerCase();
      const b64 = m ? m[2] : imgBody.data;
      const ext =
        ({
          "image/png": "png",
          "image/jpeg": "jpg",
          "image/jpg": "jpg",
          "image/gif": "gif",
          "image/webp": "webp",
          "image/bmp": "bmp",
          "image/svg+xml": "svg",
        } as Record<string, string>)[mime] ?? "png";
      let buf: Buffer;
      try {
        buf = Buffer.from(b64, "base64");
      } catch {
        return json({ error: "Invalid base64" }, 400);
      }
      if (buf.length === 0) return json({ error: "Empty image" }, 400);
      if (buf.length > 32 * 1024 * 1024) return json({ error: "Image too large (max 32MB)" }, 413);
      try {
        const imgDir = "/tmp/images";
        mkdirSync(imgDir, { recursive: true });
        const imgPath = `${imgDir}/${crypto.randomUUID()}.${ext}`;
        await Bun.write(imgPath, buf);
        return json({ ok: true, path: imgPath });
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
    }

    if (req.method === "POST" && url.pathname === "/api/claude") {
      let ws: Workspace;
      try {
        ws = await wsFromReq(url);
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
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
        const session = await newClaudeSession(ws.path, body.prompt);
        return json({ ok: true, session });
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
    }

    // ---- Tmux tab ----
    // List claude tmux sessions (global, not dir-scoped) with transcript status.
    if (req.method === "GET" && url.pathname === "/api/tmux/sessions") {
      try {
        return json({ sessions: await listClaudeSessions() });
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
    }

    // Read one session's transcript (the latest `limit` messages).
    if (req.method === "GET" && url.pathname === "/api/tmux/transcript") {
      const name = url.searchParams.get("session") ?? "";
      if (!name) return json({ error: "Missing session" }, 400);
      const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "150", 10) || 150, 1), 1000);
      try {
        const SEP = "\x1f";
        const info = (
          await $`tmux -L default display-message -p -t ${`${name}:0.0`} ${["#{pane_current_path}", "#{@claude_session}", "#{pane_current_command}", "#{pane_title}"].join(SEP)}`.quiet().text()
        ).trim();
        const [cwd, sid, cmd, paneTitle] = info.split(SEP);
        const task = cleanTitle(paneTitle ?? "", name, cmd ?? "");
        const path = await resolveTranscript(cwd ?? "", sid ?? "", task);
        if (!path || !existsSync(path)) {
          return json({ session: name, cwd, sessionId: sid, path: null, messages: [], model: "", title: "" });
        }
        const text = await Bun.file(path).text();
        const { messages, model, title } = parseTranscript(text, limit);
        return json({ session: name, cwd, sessionId: sid, path, messages, model, title });
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
    }

    // Kill a tmux session.
    if (req.method === "POST" && url.pathname === "/api/tmux/kill") {
      let body: { session?: unknown };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      if (typeof body.session !== "string" || !body.session) {
        return json({ error: "Missing session" }, 400);
      }
      try {
        await $`tmux -L default kill-session -t ${body.session}`.quiet();
        return json({ ok: true });
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
    }

    // Send a reply into a session's claude pane: paste the text + Enter.
    if (req.method === "POST" && url.pathname === "/api/tmux/send") {
      let body: { session?: unknown; text?: unknown };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      if (typeof body.session !== "string" || !body.session) {
        return json({ error: "Missing session" }, 400);
      }
      if (typeof body.text !== "string" || !body.text.trim()) {
        return json({ error: "Empty reply" }, 400);
      }
      try {
        await pasteAndSubmit(body.session, body.text);
        return json({ ok: true });
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
    }

    if (req.method === "POST" && url.pathname === "/api/open") {
      let ws: Workspace;
      try {
        ws = await wsFromReq(url);
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
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
      const dir = dirForWorktree(ws, body.worktree, body.repo);
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
      let ws: Workspace;
      try {
        ws = await wsFromReq(url);
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
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
          const dir = dirForWorktree(ws, body.worktree, body.repo);
          const fileAbs = `${dir}/${body.path}`;
          await Bun.write(fileAbs, removeFileLines(await Bun.file(fileAbs).text(), lo, hi));
          return json({ ok: true });
        }
        if (body.source === "patch") {
          if (typeof body.name !== "string" || !/^[^/\0]+\.patch$/.test(body.name)) {
            return json({ error: "Invalid patch name" }, 400);
          }
          const patchPath = `${ws.path}/diffs/${body.name}`;
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
      let ws: Workspace;
      try {
        ws = await wsFromReq(url);
      } catch (e) {
        return new Response(errText(e), { status: 500 });
      }
      const r = repoByKey(ws, url.searchParams.get("repo"));
      if (!r) return new Response("No repo", { status: 404 });
      try {
        const diff = await $`gh pr diff ${prDiffMatch[1]}`.cwd(r.dir).quiet().text();
        return new Response(diff, {
          headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS },
        });
      } catch (e) {
        return new Response(errText(e), { status: 502 });
      }
    }

    const diffMatch = url.pathname.match(/^\/api\/diff\/([0-9a-f]{7,40})$/);
    if (diffMatch) {
      let ws: Workspace;
      try {
        ws = await wsFromReq(url);
      } catch (e) {
        return new Response(errText(e), { status: 500 });
      }
      const r = repoByKey(ws, url.searchParams.get("repo"));
      if (!r) return new Response("No repo", { status: 404 });
      try {
        return new Response(await commitDiff(r, diffMatch[1]), {
          headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS },
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

console.log(
  `diffshub for ${cwd.split("/").pop() || cwd} running at http://localhost:${server.port}`,
);
