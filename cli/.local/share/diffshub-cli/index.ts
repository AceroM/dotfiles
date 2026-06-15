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

// Prompts enqueued while the machine was offline (claude can't reach the Anthropic
// API, so launching a session would do nothing). Each row is drained — launched as
// a real claude session — automatically once connectivity returns. See checkOnline
// / drainQueue.
db.run(`CREATE TABLE IF NOT EXISTS queued_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dir_id INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`);
interface QueuedRow {
  id: number;
  dir_id: number;
  prompt: string;
  created_at: number;
}
const insertQueuedStmt = db.query<{ id: number }, [number, string, number]>(
  "INSERT INTO queued_sessions (dir_id, prompt, created_at) VALUES (?, ?, ?) RETURNING id",
);
const listQueuedStmt = db.query<QueuedRow, []>(
  "SELECT * FROM queued_sessions ORDER BY created_at, id",
);
const deleteQueuedStmt = db.query("DELETE FROM queued_sessions WHERE id = ?");

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
// from any origin (the server is localhost-only and personal). The
// Allow-Private-Network header keeps Chrome's Private Network Access check from
// blocking the call when the page is an https origin (e.g. a tailscale URL)
// reaching back to this http://localhost server.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Private-Network": "true",
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

// How long to wait between pasting text and sending Enter when replying into an
// already-running session (/api/tmux/send). Claude's TUI debounces bracketed
// paste: an Enter that lands in the same beat as the paste is swallowed into the
// pasted content as a literal newline instead of submitting. Letting the TUI
// settle first makes the Enter reliably submit. (New sessions sidestep this
// entirely — see newClaudeSession, which passes the prompt as a CLI arg.)
const PASTE_SETTLE_MS = 400;

// Paste text into a running pane via a tmux buffer (robust for multi-line input
// and special characters, unlike literal send-keys) and submit it with Enter.
async function pasteAndSubmit(name: string, text: string): Promise<void> {
  const bufFile = `${stateDir}/claude-prompt-${Date.now()}.txt`;
  await Bun.write(bufFile, text);
  const buf = `diffshub-${name}`;
  await $`tmux -L default load-buffer -b ${buf} ${bufFile}`.quiet();
  await $`tmux -L default paste-buffer -d -b ${buf} -t ${`${name}:0.0`}`.quiet();
  await Bun.sleep(PASTE_SETTLE_MS);
  await $`tmux -L default send-keys -t ${`${name}:0.0`} Enter`.quiet();
  await $`rm -f ${bufFile}`.quiet();
}

// A session that's idle (no braille spinner in its pane title) may actually be
// *blocked on an interactive prompt* — an AskUserQuestion, an ExitPlanMode plan
// approval, or a tool-permission request. claude does NOT write that turn to the
// transcript .jsonl until it's answered, so the prompt is invisible to
// parseTranscript (the file just freezes mid-conversation). It lives only in the
// live TUI pane. So when a session is idle we capture the visible pane and, if it
// looks like a selection prompt, return it verbatim — the client surfaces it as a
// "waiting for input" block and the user answers from the reply box (the same
// digit/text they'd type in the terminal). Returns null for an ordinary idle pane
// (empty input box, no pending prompt).
//
// Signal: every one of these prompts renders a highlighted numbered choice
// ("❯ 1. …"); a plain input box never does. A select/navigate/proceed footer is
// accepted as a secondary signal in case the cursor glyph ever differs.
const PROMPT_CURSOR = /❯\s*\d+\.\s/u;
const PROMPT_FOOTER = /(?:to select|↑\/↓|to navigate|Do you want to proceed|Would you like to proceed)/iu;
// A full-width horizontal rule — claude brackets the prompt box with these.
const FULL_RULE = /^\s*─{20,}\s*$/u;
async function capturePendingPrompt(name: string): Promise<string | null> {
  let pane: string;
  try {
    // Capture scrollback above the visible area too: a prompt taller than a short
    // pane scrolls its own question off-screen, so the visible lines alone miss it
    // (a 18-row tmux pane shows only the footer of a tall AskUserQuestion).
    pane = await $`tmux -L default capture-pane -p -S -120 -t ${`${name}:0.0`}`.quiet().text();
  } catch {
    return null;
  }
  if (!PROMPT_CURSOR.test(pane) && !PROMPT_FOOTER.test(pane)) return null;
  let lines = pane.replace(/\s+$/u, "").split("\n");
  // The prompt box is delimited by full-width rules; keep from the rule that opens
  // it (the second-to-last rule, just before the question) onward, so we show the
  // question + options + footer without the conversation scrolled in above it.
  const rules = lines.flatMap((l, i) => (FULL_RULE.test(l) ? [i] : []));
  if (rules.length >= 2) lines = lines.slice(rules[rules.length - 2] + 1);
  while (lines.length && !lines[0].trim()) lines.shift();
  const MAX = 80; // backstop for an unusual prompt with no detectable rules
  const text = (lines.length > MAX ? lines.slice(-MAX) : lines).join("\n").trimEnd();
  return text || null;
}

// Launch an interactive claude session detached in the directory (mirrors `p`),
// returning the session name so the caller can `tmux attach -t <name>`.
// We mint the claude session id ourselves (`--session-id`) and stamp it onto the
// tmux session as the `@claude_session` user option, so the Tmux tab can map this
// session straight to its ~/.claude transcript (see resolveTranscript).
//
// The first prompt is passed as claude's positional CLI argument, NOT pasted into
// the pane after startup. The old approach (waitForReady + paste-buffer + delayed
// Enter) raced claude's bracketed-paste debounce: an Enter landing in the same
// beat as the paste was swallowed as a literal newline, leaving the prompt sitting
// unsent in the input box — exactly the "it just made a new line" failure. A
// positional arg has zero timing: claude reads it on boot and submits it itself.
// Images still work because the upload route embeds /tmp/images/<id> paths as text
// in the prompt, and claude's Read tool resolves those paths.
async function newClaudeSession(dir: string, prompt: string): Promise<string> {
  const name = await pickClaudeSessionName();
  const sid = crypto.randomUUID();
  const promptArg = prompt.trim() ? ` ${shq(prompt)}` : "";
  const claudeCmd = `CLAUDE_CODE_NO_FLICKER=1 direnv exec ${shq(dir)} claude --session-id ${sid}${promptArg}`;
  await $`tmux -L default new-session -ds ${name} -c ${dir} ${claudeCmd}`.quiet();
  await $`tmux -L default set-option -t ${name} @claude_session ${sid}`.quiet().catch(() => {});
  return name;
}

// ---- Offline queue ----
// claude needs to reach the Anthropic API to do anything, so when the machine is
// offline we enqueue new-session prompts instead of launching dead sessions, then
// drain the queue automatically once connectivity returns. Connectivity is probed
// with a cheap HEAD to the API host: any HTTP response (even a 4xx) proves we got
// through; only a network error / timeout means we're offline. The result is cached
// briefly so the hot paths (a launch decision, a sidebar poll) don't reprobe the
// network every call.
const ONLINE_PROBE_URL = "https://api.anthropic.com/";
let onlineState = { online: true, checkedAt: 0 };
async function checkOnline(force = false): Promise<boolean> {
  if (!force && Date.now() - onlineState.checkedAt < 10_000) return onlineState.online;
  let online = false;
  try {
    await fetch(ONLINE_PROBE_URL, { method: "HEAD", signal: AbortSignal.timeout(3500) });
    online = true;
  } catch {
    online = false;
  }
  onlineState = { online, checkedAt: Date.now() };
  return online;
}

// Each queued prompt, resolved to the directory it was created in, so the client
// can scope queued rows to the active directory just like live sessions.
function listQueuedSessions() {
  return listQueuedStmt.all().map((row) => ({
    id: row.id,
    prompt: row.prompt,
    createdAt: row.created_at,
    cwd: getDirStmt.get(row.dir_id)?.path ?? "",
  }));
}

// Launch every queued prompt, oldest first, dropping each row as its session
// starts. Stops at the first failure (e.g. a tmux hiccup) and leaves the rest for
// the next tick. A no-op while offline or when nothing is queued.
async function drainQueue(): Promise<void> {
  if (!onlineState.online) return;
  for (const row of listQueuedStmt.all()) {
    const dir = getDirStmt.get(row.dir_id);
    if (!dir) {
      deleteQueuedStmt.run(row.id); // directory was removed — drop the orphan
      continue;
    }
    try {
      await newClaudeSession(dir.path, row.prompt);
      deleteQueuedStmt.run(row.id);
    } catch {
      break;
    }
  }
}

// Keep the cached online status warm and flush the queue shortly after the network
// returns, without waiting for the next user action.
setInterval(() => {
  void checkOnline(true).then(() => drainQueue());
}, 12_000);
void checkOnline(true).then(() => drainQueue());

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
    // Tagged session whose transcript claude hasn't written yet (just launched):
    // its file is exactly <sid>.jsonl, so don't fall through to the title-match /
    // newest-transcript heuristics below — those are for untagged legacy sessions
    // and would briefly surface an unrelated chat (e.g. the previous one) until
    // claude writes the file.
    return null;
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
  kind: "text" | "tool_use" | "tool_result" | "image";
  text: string;
  tool?: string; // tool name for tool_use
  ts?: string; // ISO timestamp
  path?: string; // file path for Edit/Write/MultiEdit/Read
  edits?: { old: string; new: string }[]; // hunks for Edit/Write/MultiEdit diff rendering
  lang?: string; // language id for a Read tool result's code block
  imgRef?: string; // "<lineIdx>:<imgOrdinal>" — locates an image block for /api/tmux/image
  mediaType?: string; // image media type (e.g. image/png) for an image message
}

// Map a file path to a language id the diffs highlighter understands. Falls back
// to "text" (no highlighting) for anything unknown.
function langFromPath(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", cjs: "js",
    json: "json", jsonc: "json", md: "markdown", mdx: "markdown",
    css: "css", scss: "scss", less: "less", html: "html", xml: "xml",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin",
    c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp",
    php: "php", swift: "swift", lua: "lua", sql: "sql", graphql: "graphql",
    sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
    yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini", dockerfile: "docker",
  };
  return map[ext] ?? "text";
}

// Strip claude's cat -n prefixes ("   12\t<code>") off a Read tool result so the
// raw file content can render in a syntax-highlighted code block. Leaves output
// that isn't line-numbered (other tools) untouched.
function stripLineNumbers(text: string): string {
  const lines = text.split("\n");
  if (!lines.some((l) => /^\s*\d+\t/.test(l))) return text;
  return lines.map((l) => l.replace(/^\s*\d+\t/, "")).join("\n");
}

// Pull the before/after hunks out of an Edit/Write/MultiEdit tool call so the
// client can render them with the diffs library. Each hunk is capped so a giant
// edit doesn't bloat the transcript payload.
function extractEdits(name: string, input: any): { old: string; new: string }[] | undefined {
  if (input == null || typeof input !== "object") return undefined;
  const cap = (s: unknown) =>
    typeof s === "string" ? (s.length > 4000 ? s.slice(0, 4000) + "\n… (truncated)" : s) : "";
  if (name === "Edit") return [{ old: cap(input.old_string), new: cap(input.new_string) }];
  if (name === "Write") return [{ old: "", new: cap(input.content) }];
  if (name === "MultiEdit" && Array.isArray(input.edits))
    return input.edits.map((e: any) => ({ old: cap(e?.old_string), new: cap(e?.new_string) }));
  return undefined;
}

// One-line-ish summary of a tool call's input for the transcript.
function summarizeToolInput(name: string, input: any): string {
  if (input == null || typeof input !== "object") return "";
  const pick = (k: string) => (typeof input[k] === "string" ? input[k] : "");
  if (name === "Bash") return pick("command");
  if (name === "Read" || name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit")
    return pick("file_path") || pick("notebook_path");
  if (name === "Grep") return [pick("pattern"), pick("path") && `in ${pick("path")}`].filter(Boolean).join(" ");
  if (name === "Glob") return pick("pattern");
  if (name === "Task") return pick("description") || pick("subagent_type");
  // The whole plan is carried through verbatim — the client renders it as a
  // dedicated plan card (full markdown + approve/keep-planning choices) rather
  // than a one-line tool summary, so it must not be collapsed here.
  if (name === "ExitPlanMode") return pick("plan");
  // AskUserQuestion carries its questions + options as structured JSON; the
  // client parses it into a dedicated question card with selectable answers, so
  // pass the whole input through verbatim instead of collapsing the options away.
  if (name === "AskUserQuestion") return JSON.stringify(input);
  if (name === "TodoWrite") return Array.isArray(input.todos) ? `${input.todos.length} todos` : "";
  const s = JSON.stringify(input);
  return s.length > 200 ? s.slice(0, 200) + "…" : s;
}

// Collect every base64 image block in a message's content, in appearance order.
// A pasted image lives at the top level of a user message; an image claude read
// (a Read on a png, or a screenshot MCP tool) is nested inside a tool_result.
// Used both to emit image messages from parseTranscript and to serve the bytes in
// /api/tmux/image — they share this walk so the ordinal in an imgRef lines up.
function collectImages(content: unknown): { mediaType: string; data: string }[] {
  const out: { mediaType: string; data: string }[] = [];
  const visit = (b: any) => {
    if (b?.type === "image" && b.source?.type === "base64" && typeof b.source.data === "string")
      out.push({ mediaType: b.source.media_type || "image/png", data: b.source.data });
    else if (b?.type === "tool_result" && Array.isArray(b.content)) b.content.forEach(visit);
  };
  if (Array.isArray(content)) content.forEach(visit);
  return out;
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
  // Remember each tool_use by id so its matching tool_result (which arrives in a
  // later user message) can be enriched — e.g. a Read result rendered as a code
  // block in the file's language.
  const toolById = new Map<string, { name: string; path: string }>();
  const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "\n… (truncated)" : s);
  // Append-only transcript, so a line's index is stable — image messages carry it
  // (as "<lineIdx>:<imgOrdinal>") so /api/tmux/image can fetch the bytes lazily.
  const lines = text.split("\n");
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
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
        // Image ordinal within this line, matching collectImages(content) order so
        // the imgRef resolves to the right block server-side.
        let imgOrd = 0;
        for (const b of content) {
          if (b?.type === "text" && b.text?.trim())
            msgs.push({ role: "user", kind: "text", text: trunc(b.text, 8000), ts });
          else if (b?.type === "image") {
            // A pasted image — show it in the user bubble.
            msgs.push({
              role: "user",
              kind: "image",
              text: "",
              imgRef: `${lineIdx}:${imgOrd++}`,
              mediaType: b.source?.media_type || "image/png",
              ts,
            });
          } else if (b?.type === "tool_result") {
            const src = b.tool_use_id ? toolById.get(b.tool_use_id) : undefined;
            const imgs = collectImages([b]);
            if (imgs.length) {
              // claude read an image (Read on a png) or a screenshot tool returned
              // one — render it inline rather than the "(empty file)" text we'd get
              // from blockText on an image-only result.
              for (const img of imgs)
                msgs.push({
                  role: "tool",
                  kind: "image",
                  tool: src?.name || "Read",
                  path: src?.path || undefined,
                  imgRef: `${lineIdx}:${imgOrd++}`,
                  mediaType: img.mediaType,
                  text: "",
                  ts,
                });
              continue;
            }
            const t = blockText(b.content) || (typeof b.content === "string" ? b.content : "");
            if (src?.name === "Read") {
              // Render Read output as a syntax-highlighted code block: strip the
              // line-number gutter and carry the file's language. Bigger cap than
              // a generic tool result since the client collapses it by default.
              msgs.push({
                role: "tool",
                kind: "tool_result",
                tool: "Read",
                path: src.path || undefined,
                lang: langFromPath(src.path || ""),
                text: trunc(stripLineNumbers(t) || "(empty file)", 8000),
                ts,
              });
            } else {
              msgs.push({ role: "tool", kind: "tool_result", text: trunc(t || "(tool result)", 2000), ts });
            }
          }
        }
      }
    } else {
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === "text" && b.text?.trim())
            msgs.push({ role: "assistant", kind: "text", text: trunc(b.text, 8000), ts });
          else if (b?.type === "tool_use") {
            const path =
              typeof b.input?.file_path === "string"
                ? b.input.file_path
                : typeof b.input?.notebook_path === "string"
                  ? b.input.notebook_path
                  : "";
            if (typeof b.id === "string") toolById.set(b.id, { name: b.name, path });
            msgs.push({
              role: "assistant",
              kind: "tool_use",
              tool: b.name,
              // A plan (and an AskUserQuestion's full option list) needs much
              // more room than a one-line tool summary so the client's plan /
              // question card can show the whole thing.
              text: trunc(
                summarizeToolInput(b.name, b.input),
                b.name === "ExitPlanMode" || b.name === "AskUserQuestion" ? 16000 : 1000,
              ),
              // Edit/Write/MultiEdit carry their before/after hunks so the client
              // can render them with the diffs library instead of a one-liner.
              path: path || undefined,
              edits: extractEdits(b.name, b.input),
              ts,
            });
          }
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
  :root {
    color-scheme: light;
    --bg: #ffffff;
    --bg-raised: #fcfcfd;
    --bg-soft: #fafafa;
    --bg-sidebar: #f7f7f8;
    --bg-muted: #f4f4f5;
    --bg-hover: #f0f0f1;
    --bg-tabs: #efeff1;
    --skel-hi: #f1f1f3;
    --border-soft: #ececef;
    --skel-lo: #e8e8eb;
    --border-code: #e7e7ea;
    --border: #e4e4e7;
    --border-strong: #d4d4d8;
    --text: #18181b;
    --text-md: #1f2328;
    --text-strong: #3f3f46;
    --text-2: #52525b;
    --text-muted: #71717a;
    --text-faint: #a1a1aa;
    --text-hint: #8a8499;
    --text-desc: #6b6680;
    --text-on-accent-bg: #2a2540;
    --text-q: #45405c;
    --accent: #6e56cf;
    --accent-hover: #7d68d6;
    --accent-strong: #5b46b8;
    --accent-strong-2: #5a45b0;
    --accent-dim: #8b7fd0;
    --accent-faint: #a99fe0;
    --accent-dot: #b8a9ec;
    --accent-ring: #c4b8ef;
    --accent-bg: #efe9fb;
    --accent-bg-hover: #f3f0fc;
    --accent-chip: #ece7fa;
    --accent-card: #fbfaff;
    --accent-choice-bg: #ffffff;
    --accent-head: #f1edfb;
    --accent-foot: #f7f5fe;
    --accent-key-bg: #e4ddf7;
    --accent-border: #d9d2f4;
    --accent-border-2: #e6e0f7;
    --accent-border-3: #ece8f8;
    --accent-border-4: #ddd6f3;
    --accent-badge-border: #ddd0fb;
    --red: #dc2626;
    --red-strong: #b91c1c;
    --red-bg: #fee2e2;
    --red-border: #fca5a5;
    --green: #16a34a;
    --green-bg: #dcfce7;
    --green-border: #86efac;
    --amber: #d97706;
    --blue: #2563eb;
    --switch-knob: #ffffff;
  }
  html.dark {
    color-scheme: dark;
    --bg: #1c1c1f;
    --bg-raised: #222227;
    --bg-soft: #202024;
    --bg-sidebar: #161618;
    --bg-muted: #26262b;
    --bg-hover: #2a2a30;
    --bg-tabs: #202025;
    --skel-hi: #303037;
    --border-soft: #2a2a2f;
    --skel-lo: #242429;
    --border-code: #33333a;
    --border: #2e2e34;
    --border-strong: #3a3a41;
    --text: #e9e9ec;
    --text-md: #e3e3e7;
    --text-strong: #c6c6cd;
    --text-2: #a9a9b3;
    --text-muted: #8e8e98;
    --text-faint: #6d6d77;
    --text-hint: #7c7689;
    --text-desc: #9b94ac;
    --text-on-accent-bg: #e1ddf2;
    --text-q: #d0cae6;
    --accent: #8b7fe0;
    --accent-hover: #9d8fe8;
    --accent-strong: #a99fe6;
    --accent-strong-2: #b3aaea;
    --accent-dim: #9f94dd;
    --accent-faint: #7d72b8;
    --accent-dot: #8b7fe0;
    --accent-ring: #5a4f86;
    --accent-bg: #2a2447;
    --accent-bg-hover: #332c54;
    --accent-chip: #37305a;
    --accent-card: #1e1b2b;
    --accent-choice-bg: #262236;
    --accent-head: #262138;
    --accent-foot: #211d31;
    --accent-key-bg: #3a3360;
    --accent-border: #3f3866;
    --accent-border-2: #352e54;
    --accent-border-3: #2e2845;
    --accent-border-4: #403963;
    --accent-badge-border: #3a3160;
    --red: #f06a6a;
    --red-strong: #d84a4a;
    --red-bg: #3a1f1f;
    --red-border: #7d3b3b;
    --green: #42b86a;
    --green-bg: #16331f;
    --green-border: #2f6e44;
    --amber: #e3982f;
    --blue: #5b8def;
    --switch-knob: #e4e4e7;
  }
  * { box-sizing: border-box; }
  html, body, #root { height: 100%; margin: 0; }
  body {
    font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: var(--bg);
    color: var(--text);
  }
  code { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  button { font: inherit; color: inherit; }
  /* Outer shell stacks an (off-desktop) top bar above the 3-column body. */
  .layout { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
  .body { flex: 1; display: flex; min-height: 0; position: relative; }

  /* Mobile/tablet top bar — burger (left drawer), title, panel button (right
     drawer). Hidden on desktop; turned on in the max-width:1024px block below. */
  .topbar { display: none; }
  .topbar-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 34px; height: 34px; flex-shrink: 0; cursor: pointer;
    background: none; border: 1px solid var(--border); border-radius: 8px; color: var(--text-strong);
  }
  .topbar-btn:hover { background: var(--bg-hover); border-color: var(--border-strong); }
  /* New-session (+) and kill (trash) buttons (Tmux tab) — sit beside the actions
     dropdown. */
  .topbar-new { color: var(--accent); border-color: var(--accent); }
  .topbar-new:hover { background: var(--accent); border-color: var(--accent); color: #fff; }
  .topbar-kill { color: var(--red); border-color: var(--red-border); }
  .topbar-kill:hover { background: var(--red-bg); border-color: var(--red); color: var(--red); }
  .topbar-title { flex: 1; min-width: 0; font-weight: 600; font-size: 14px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Mobile "Actions" dropdown — sits beside the details toggle in the top bar. */
  .topbar-actions { position: relative; flex-shrink: 0; }
  .topbar-actions-menu {
    position: absolute; top: calc(100% + 6px); right: 0; z-index: 46;
    min-width: 212px; background: var(--bg); border: 1px solid var(--border);
    border-radius: 10px; box-shadow: 0 12px 34px rgba(0, 0, 0, .18); padding: 5px;
    display: flex; flex-direction: column;
  }
  .topbar-action {
    display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
    cursor: pointer; padding: 9px 10px; background: none; border: none;
    border-radius: 7px; color: var(--text-strong); font-size: 13px;
  }
  .topbar-action:hover:not(:disabled) { background: var(--bg-hover); color: var(--text); }
  .topbar-action:disabled { opacity: .45; cursor: default; }
  .topbar-action svg { width: 16px; height: 16px; flex-shrink: 0; color: var(--accent); }

  /* Drag handle between columns (desktop only — hidden in the mobile block). */
  .resizer { flex: 0 0 5px; cursor: col-resize; background: transparent; z-index: 6; }
  .resizer:hover, .resizer:active { background: var(--accent-border); }

  .commits {
    width: 300px; min-width: 300px;
    display: flex; flex-direction: column;
    border-right: 1px solid var(--border);
    background: var(--bg-sidebar);
  }
  .commits-header { padding: 14px 14px 10px; border-bottom: 1px solid var(--border); }
  .commits-header h1 { font-size: 15px; margin: 0 0 10px; display: flex; align-items: baseline; gap: 8px; }
  .commits-header .repo { font-size: 11px; font-weight: 400; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .commits-header input {
    width: 100%; padding: 6px 10px; font-size: 13px;
    background: var(--bg); color: inherit;
    border: 1px solid var(--border-strong); border-radius: 6px; outline: none;
  }
  .commits-header input:focus { border-color: var(--accent); }

  .tabs { display: flex; gap: 2px; margin-bottom: 10px; background: var(--bg-tabs); border: 1px solid var(--border); border-radius: 7px; padding: 2px; }
  .tabs button {
    flex: 1; height: 30px; cursor: pointer; position: relative;
    display: flex; align-items: center; justify-content: center;
    background: none; border: none; border-radius: 5px; color: var(--text-muted);
  }
  .tabs button:hover { color: var(--text); }
  .tabs button.on { background: var(--bg); color: var(--accent); box-shadow: 0 1px 2px rgba(0, 0, 0, .08); }
  .tabs button svg { width: 16px; height: 16px; display: block; }
  /* count badge (e.g. number of manual patches / tmux sessions) */
  .tabs button .tab-badge {
    position: absolute; top: 1px; right: 4px; min-width: 13px; height: 13px;
    padding: 0 3px; border-radius: 7px; background: var(--accent); color: #fff;
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
    background: var(--border-strong); margin-right: 7px;
  }
  .sess-busy.on { background: var(--accent); box-shadow: 0 0 0 0 rgba(110,86,207,.5); animation: sessPulse 1.4s ease-in-out infinite; }
  @keyframes sessPulse { 0% { box-shadow: 0 0 0 0 rgba(110,86,207,.5); } 70% { box-shadow: 0 0 0 5px rgba(110,86,207,0); } 100% { box-shadow: 0 0 0 0 rgba(110,86,207,0); } }
  .commit .sess-top { display: flex; align-items: center; }
  .sess-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .commit .sess-task { color: var(--text-muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-left: 14px; margin-top: 2px; padding-right: 22px; }
  .commit .sess-cwd { color: var(--text-faint); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-left: 14px; }
  .kill-btn {
    position: absolute; top: 9px; right: 10px; width: 18px; height: 18px;
    display: flex; align-items: center; justify-content: center; padding: 0;
    background: none; border: 1px solid var(--border-strong); border-radius: 50%;
    color: var(--text-faint); font-size: 11px; cursor: pointer; opacity: 0;
  }
  .commit:hover .kill-btn { opacity: 1; }
  .kill-btn:hover { background: var(--red-bg); border-color: var(--red-border); color: var(--red); }

  /* ---- Tmux tab: queued (offline) sessions ---- */
  /* A prompt enqueued while offline — it launches once the box is back online.
     An amber pulsing dot + a QUEUED chip set it apart from a live session, and the
     row isn't clickable (there's no transcript yet). */
  .commit.queued { border-left-color: var(--amber); cursor: default; }
  .commit.queued:hover { background: var(--bg-hover); }
  .sess-queued {
    flex-shrink: 0; width: 7px; height: 7px; border-radius: 50%;
    background: var(--amber); margin-right: 7px;
    animation: pendingPulse 1.6s ease-in-out infinite;
  }
  .queued-badge {
    margin-left: auto; flex-shrink: 0; font-size: 9px; font-weight: 700;
    letter-spacing: .04em; text-transform: uppercase; line-height: 14px;
    color: var(--amber); border: 1px solid var(--amber); border-radius: 999px; padding: 0 6px;
  }
  /* Offline banner — shown atop the session list and inside the New session dialog. */
  .offline-note {
    display: flex; align-items: center; gap: 7px;
    margin: 8px 14px 2px; padding: 7px 10px;
    font-size: 11px; color: var(--amber);
    background: var(--bg-soft); border: 1px solid var(--amber); border-radius: 7px;
  }
  .offline-dot {
    flex-shrink: 0; width: 7px; height: 7px; border-radius: 50%; background: var(--amber);
    animation: pendingPulse 1.6s ease-in-out infinite;
  }
  .modal-offline {
    display: flex; align-items: center; gap: 8px; margin-top: 12px; padding: 8px 11px;
    font-size: 12px; color: var(--amber);
    background: var(--bg-soft); border: 1px solid var(--amber); border-radius: 8px;
  }

  /* ---- Tmux tab: transcript (ChatGPT-style chat) ---- */
  .transcript { max-width: 820px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
  .transcript-head {
    position: sticky; top: 0; z-index: 5; background: var(--bg);
    margin: 0 0 2px; padding: 10px 0;
    border-bottom: 1px solid var(--border); display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
  }
  /* Opaque shield filling any strip above the stuck header (e.g. the scroll
     container's top padding) so scrolled messages never peek above the title. */
  .transcript-head::before {
    content: ""; position: absolute; left: 0; right: 0; bottom: 100%; height: 20px; background: var(--bg);
  }
  .transcript-head h2 { font-size: 14px; margin: 0; }
  .transcript-head .t-sub { font-size: 11px; color: var(--text-muted); }
  /* Top-right toggle: filter the chat down to just the edit diffs. */
  .edits-toggle {
    margin-left: auto; align-self: center; cursor: pointer;
    font-size: 11px; line-height: 1; white-space: nowrap;
    padding: 5px 10px; border-radius: 999px;
    border: 1px solid var(--border); background: var(--bg-muted); color: var(--text-muted);
  }
  .edits-toggle:hover { color: var(--text); border-color: var(--text-muted); }
  .edits-toggle.on {
    background: var(--accent); border-color: var(--accent); color: #fff;
  }
  /* Chat turns */
  .turn { display: flex; gap: 11px; align-items: flex-start; }
  .turn.user { flex-direction: column; align-items: flex-end; gap: 6px; }
  .turn.user .bubble {
    max-width: 80%; background: var(--bg-muted); color: var(--text);
    border-radius: 18px; padding: 10px 15px; text-align: left;
    white-space: pre-wrap; word-break: break-word; font-size: 14px; line-height: 1.55;
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
    color: var(--text-2); background: var(--bg-muted); border: 1px solid var(--border); border-radius: 6px; padding: 4px 9px;
  }
  .tool-use .tool-name { color: var(--accent); font-weight: 600; }
  .tool-use .tool-name::before { content: "⚒ "; opacity: .8; }
  .tool-use .tool-arg { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .tool-result {
    align-self: flex-start; max-width: 100%;
    background: var(--bg-soft); border: 1px solid var(--border); border-radius: 6px;
  }
  .tool-result pre {
    margin: 0; padding: 7px 10px; max-height: 9em; overflow: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
    color: var(--text-muted); white-space: pre-wrap; word-break: break-word;
  }

  /* Edit/Write/MultiEdit shown as inline diff hunks (diffs library), and Read
     output as a collapsible highlighted code block — same renderers as the
     Changes tab and chat code blocks. */
  .chat-diff { align-self: stretch; max-width: 100%; display: flex; flex-direction: column; gap: 6px; }
  .chat-diff .tool-use { margin-bottom: 1px; }
  .read-block { align-self: stretch; max-width: 100%; display: flex; flex-direction: column; gap: 6px; }
  .read-block-head {
    align-self: flex-start; display: inline-flex; align-items: baseline; gap: 7px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
    color: var(--text-2); background: var(--bg-muted); border: 1px solid var(--border);
    border-radius: 6px; padding: 4px 9px; cursor: pointer;
  }
  .read-block-head:hover { border-color: var(--accent-border); }
  .read-block-head .tool-name { color: var(--accent); font-weight: 600; }
  .read-block-head .tool-name::before { content: "📄 "; opacity: .8; }
  .read-block-head .tool-arg { color: var(--text-muted); }
  .read-block-head .read-block-meta { color: var(--text-muted); opacity: .75; }

  /* An image claude read (Read on a png), a screenshot tool's output, or a pasted
     image — fetched lazily from /api/tmux/image. Click to open full size. */
  .img-block { align-self: flex-start; max-width: 100%; display: flex; flex-direction: column; gap: 6px; }
  .turn.user .img-block { align-self: flex-end; }
  .img-block-head {
    align-self: flex-start; display: inline-flex; align-items: baseline; gap: 7px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
  }
  .img-block-head .tool-name { color: var(--accent); font-weight: 600; }
  .img-block-head .tool-name::before { content: "🖼 "; opacity: .8; }
  .img-block-head .tool-arg { color: var(--text-muted); }
  .img-block-img {
    max-width: min(520px, 100%); max-height: 460px; width: auto; height: auto;
    border: 1px solid var(--border); border-radius: 8px; display: block;
    object-fit: contain; background: var(--bg-soft);
  }

  /* ExitPlanMode plan card — the full plan plus claude's approve/keep-planning
     choices, mirroring the in-TUI plan prompt. No max-height: the whole plan is
     meant to be read inline, never trapped in a tiny scroll box. */
  .plan-card {
    align-self: stretch; max-width: 100%;
    border: 1px solid var(--accent-border); border-radius: 10px; overflow: hidden; background: var(--accent-card);
  }
  .plan-card-head {
    padding: 8px 14px; font-size: 12.5px; font-weight: 650; color: var(--accent);
    background: var(--accent-head); border-bottom: 1px solid var(--accent-border-2);
  }
  .plan-card-head::before { content: "◳ "; opacity: .8; }
  .plan-card-body { padding: 13px 16px; }
  .plan-card-body .md { font-size: 13.5px; }
  .plan-card-foot {
    padding: 11px 13px 13px; border-top: 1px solid var(--accent-border-3); background: var(--accent-foot);
    display: flex; flex-direction: column; gap: 7px;
  }
  .plan-q { font-size: 12.5px; font-weight: 600; color: var(--text-q); margin-bottom: 1px; }
  .plan-choice {
    display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
    padding: 8px 11px; border: 1px solid var(--accent-border-4); border-radius: 7px;
    background: var(--accent-choice-bg); color: var(--text-on-accent-bg); font-size: 13px; font-family: inherit; cursor: pointer;
  }
  .plan-choice:hover:not(:disabled) { border-color: var(--accent); background: var(--accent-bg-hover); }
  .plan-choice:disabled { cursor: default; opacity: .5; }
  .plan-choice-n {
    flex: none; display: inline-flex; align-items: center; justify-content: center;
    width: 18px; height: 18px; border-radius: 5px; background: var(--accent-chip);
    color: var(--accent); font-size: 11px; font-weight: 700;
  }
  .plan-choice-label { flex: 1; min-width: 0; }
  .plan-choice-spin { color: var(--accent); font-size: 12px; }

  /* AskUserQuestion card — the in-TUI multiple-choice prompt rebuilt for the web:
     each question with its options (label + description) as selectable answers.
     Only the live (last-turn) prompt is answerable; clicking an option sends its
     number into the pane, the same key you'd press in the TUI. Multi-select
     questions render read-only (a single keypress can't express them) with a hint
     to answer from the reply box. */
  .q-card {
    align-self: stretch; max-width: 100%;
    border: 1px solid var(--accent-border); border-radius: 10px; overflow: hidden; background: var(--accent-card);
  }
  .q-card-head {
    padding: 8px 14px; font-size: 12.5px; font-weight: 650; color: var(--accent);
    background: var(--accent-head); border-bottom: 1px solid var(--accent-border-2);
  }
  .q-card-head::before { content: "? "; opacity: .8; font-weight: 800; }
  .q-block { padding: 13px 16px; }
  .q-block + .q-block { border-top: 1px solid var(--accent-border-3); }
  .q-tag {
    display: inline-block; margin-bottom: 7px; padding: 2px 8px; border-radius: 999px;
    background: var(--accent-chip); color: var(--accent); font-size: 11px; font-weight: 700;
  }
  .q-text { font-size: 13.5px; font-weight: 600; color: var(--text-on-accent-bg); margin-bottom: 10px; }
  .q-opts { display: flex; flex-direction: column; gap: 7px; }
  .q-choice {
    display: flex; align-items: flex-start; gap: 10px; width: 100%; text-align: left;
    padding: 9px 11px; border: 1px solid var(--accent-border-4); border-radius: 7px;
    background: var(--accent-choice-bg); color: var(--text-on-accent-bg); font-size: 13px; font-family: inherit; cursor: pointer;
  }
  .q-choice:hover:not(:disabled) { border-color: var(--accent); background: var(--accent-bg-hover); }
  .q-choice:disabled { cursor: default; }
  .q-choice.readonly { opacity: 1; } /* historical/multi-select: shown, just not clickable */
  .q-choice.readonly:disabled { opacity: .9; }
  .q-choice-n {
    flex: none; display: inline-flex; align-items: center; justify-content: center;
    width: 18px; height: 18px; margin-top: 1px; border-radius: 5px; background: var(--accent-chip);
    color: var(--accent); font-size: 11px; font-weight: 700;
  }
  .q-choice-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .q-choice-label { font-weight: 600; }
  .q-choice-desc { font-size: 12px; color: var(--text-desc); white-space: pre-wrap; word-break: break-word; }
  .q-choice-spin { flex: none; align-self: center; color: var(--accent); font-size: 12px; }
  .q-multi { margin-top: 8px; font-size: 11.5px; color: var(--text-hint); }

  /* Live pane capture of a pending prompt (AskUserQuestion / plan / permission)
     that claude hasn't written to the transcript yet — see capturePendingPrompt. */
  .pending-pane {
    align-self: stretch; max-width: 100%;
    border: 1px solid var(--amber); border-radius: 10px; overflow: hidden;
    background: var(--bg-soft);
  }
  .pending-pane-head {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 14px; font-size: 12.5px; font-weight: 650; color: var(--amber);
    border-bottom: 1px solid var(--border);
  }
  .pending-pane-dot {
    width: 7px; height: 7px; border-radius: 50%; background: var(--amber);
    animation: pendingPulse 1.4s ease-in-out infinite;
  }
  @keyframes pendingPulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
  .pending-pane-body {
    margin: 0; padding: 10px 14px; max-height: 24em; overflow: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; line-height: 1.5;
    color: var(--text-md); white-space: pre;
  }
  .pending-pane-hint {
    padding: 7px 14px; font-size: 11.5px; color: var(--text-hint);
    border-top: 1px solid var(--border);
  }
  .pending-pane-hint code {
    padding: 1px 5px; border-radius: 4px; background: var(--bg-muted); color: var(--text-2);
  }

  /* "Claude is working" typing indicator */
  .typing { display: inline-flex; gap: 4px; padding: 6px 2px; }
  .typing span { width: 6px; height: 6px; border-radius: 50%; background: var(--accent-dot); animation: typing 1.2s infinite ease-in-out; }
  .typing span:nth-child(2) { animation-delay: .15s; }
  .typing span:nth-child(3) { animation-delay: .3s; }
  @keyframes typing { 0%, 60%, 100% { opacity: .3; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-3px); } }

  /* Markdown rendering of assistant messages */
  .md { font-size: 14px; line-height: 1.62; color: var(--text-md); word-break: break-word; }
  .md > :first-child { margin-top: 0; }
  .md > :last-child { margin-bottom: 0; }
  .md p { margin: 0 0 10px; white-space: pre-wrap; }
  .md .md-h { font-weight: 650; line-height: 1.3; margin: 18px 0 8px; }
  .md .md-h.h1 { font-size: 19px; }
  .md .md-h.h2 { font-size: 16px; }
  .md .md-h.h3, .md .md-h.h4, .md .md-h.h5, .md .md-h.h6 { font-size: 14px; }
  .md ul, .md ol { margin: 0 0 10px; padding-left: 22px; }
  .md li { margin: 3px 0; }
  .md a { color: var(--accent); text-decoration: underline; }
  .md a:hover { color: var(--accent-strong-2); }
  .md strong { font-weight: 650; }
  .md em { font-style: italic; }
  .md blockquote.md-quote { margin: 0 0 10px; padding: 2px 0 2px 13px; border-left: 3px solid var(--border); color: var(--text-2); }
  .md hr.md-hr { border: none; border-top: 1px solid var(--border); margin: 16px 0; }
  .md-code-inline {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .88em;
    background: var(--bg-hover); border: 1px solid var(--border-code); border-radius: 5px; padding: .5px 5px;
  }
  /* Fenced code blocks */
  .md-code { margin: 0 0 10px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--bg-raised); }
  .md-code-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 4px 8px 4px 11px; background: var(--bg-muted); border-bottom: 1px solid var(--border);
    font-size: 11px; color: var(--text-muted);
  }
  .md-code-head .lang { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: lowercase; }
  .md-code-head .copy { background: none; border: none; cursor: pointer; color: var(--text-muted); font-size: 11px; padding: 2px 7px; border-radius: 5px; }
  .md-code-head .copy:hover { background: var(--border); color: var(--text); }
  .md-code pre { margin: 0; padding: 11px 12px; overflow-x: auto; }
  .md-code code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; line-height: 1.55; color: var(--text-md); white-space: pre; }
  /* Shiki-highlighted blocks reuse the diff viewer's pierre themes. Tokens carry
     both light + dark colors as CSS vars (defaultColor:false); pick by .dark and
     let the .md-code card background show through. */
  .md-code .shiki { background: transparent !important; }
  .md-code .shiki, .md-code .shiki span { color: var(--shiki-light); }
  html.dark .md-code .shiki, html.dark .md-code .shiki span { color: var(--shiki-dark); }
  .transcript-empty { color: var(--text-muted); padding: 40px 0; text-align: center; }

  /* Reply composer pinned to the bottom of the transcript column. Mirrors the
     New Claude session textarea: multi-line, ⌃V image paste, ↵ to send. */
  .reply-box {
    position: sticky; bottom: 0; z-index: 4;
    margin-top: 6px; padding: 10px 0 14px;
    background: var(--bg); border-top: 1px solid var(--border);
  }
  .reply-input {
    width: 100%; min-height: 46px; max-height: 220px; resize: vertical;
    background: var(--bg); color: inherit; font: inherit; line-height: 1.5;
    border: 1px solid var(--border-strong); border-radius: 8px; padding: 8px 10px; outline: none;
  }
  .reply-input:focus { border-color: var(--accent); }
  .reply-bar { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
  .reply-bar .spacer { flex: 1; }
  .reply-bar .act { padding: 5px 16px; font-size: 12px; border-radius: 7px; }
  .reply-bar .act.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .reply-bar .act.primary:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); }
  .reply-bar .act.stop { background: #b91c1c; border-color: #b91c1c; color: #fff; }
  .reply-bar .act.stop:hover:not(:disabled) { background: #dc2626; border-color: #dc2626; }
  .reply-hint { font-size: 11px; color: var(--text-faint); display: flex; gap: 10px; flex-wrap: wrap; }
  .reply-hint kbd { background: var(--border); border-radius: 3px; padding: 1px 4px; }

  .commit-list { flex: 1; overflow-y: auto; padding: 6px 0; }
  .commit {
    display: block; width: 100%; text-align: left; cursor: pointer;
    padding: 8px 14px; border: none; border-left: 3px solid transparent;
    background: none; position: relative;
  }
  .commit:hover { background: var(--bg-hover); }
  .commit.active { background: var(--accent-bg); border-left-color: var(--accent); }
  .commit-msg {
    display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-weight: 500; margin-bottom: 3px; padding-right: 22px;
  }
  .rev-btn {
    position: absolute; top: 7px; right: 10px; width: 18px; height: 18px;
    display: flex; align-items: center; justify-content: center; padding: 0;
    background: none; border: 1px solid var(--border-strong); border-radius: 50%;
    color: var(--text-faint); font-size: 10px; cursor: pointer; opacity: 0;
  }
  .commit:hover .rev-btn { opacity: 1; }
  .commit.reviewed .rev-btn { opacity: 1; background: var(--green-bg); border-color: var(--green-border); color: var(--green); }
  .commit.reviewed .commit-msg { color: var(--text-faint); font-weight: 400; }
  .spinner {
    width: 34px; height: 34px; margin: 0 auto; border-radius: 50%;
    border: 4px solid var(--border); border-top-color: var(--accent);
    animation: spin .8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  /* Sole child of the diff column while loading — center the spinner in the
     visible area rather than tucking it up near the top. */
  .loading-wrap {
    display: flex; align-items: center; justify-content: center;
    min-height: 75vh; color: var(--text-muted);
  }

  /* Sidebar skeleton placeholders, shown while a tab's list is loading */
  .skel-list { padding: 6px 0; }
  .skel-row { padding: 8px 14px; }
  .skel-bar {
    border-radius: 4px;
    background-image: linear-gradient(90deg, var(--skel-lo), var(--skel-hi), var(--skel-lo));
    background-size: 200% 100%;
    animation: shimmer 1.4s ease-in-out infinite;
  }
  .skel-bar.title { height: 9px; margin-bottom: 8px; }
  .skel-bar.meta { height: 7px; width: 45%; }
  @keyframes shimmer { 0% { background-position-x: 100%; } 100% { background-position-x: -100%; } }

  /* Diff-column skeleton (center pane) — a few file cards with shimmering code
     lines, so a diff that's still being computed server-side renders its shape
     instantly instead of a blank/spinner gap. */
  .skel-diff { padding: 4px 2px; }
  .skel-file { margin-bottom: 18px; border: 1px solid var(--border-soft); border-radius: 8px; overflow: hidden; }
  .skel-file-head { padding: 10px 12px; background: var(--bg-sidebar); border-bottom: 1px solid var(--border-soft); }
  .skel-file-head .skel-bar { height: 9px; }
  .skel-code-line { padding: 5px 12px; }
  .skel-code-line .skel-bar.code { height: 8px; }
  .commit-meta { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-muted); }
  .commit-meta img { width: 14px; height: 14px; border-radius: 50%; }
  .commit-meta code { color: var(--text-muted); }
  .commit-ago { margin-left: auto; white-space: nowrap; }
  .repo-badge {
    font-size: 10px; line-height: 1.5; padding: 0 5px; border-radius: 4px;
    background: var(--accent-bg); color: var(--accent); border: 1px solid var(--accent-badge-border);
    white-space: nowrap; flex-shrink: 0;
  }
  .modal-repos { color: var(--accent); font-weight: 600; }
  .pr-stats .add { color: var(--green); }
  .pr-stats .del { color: var(--red); }
  .load-more {
    display: block; width: calc(100% - 28px); margin: 8px 14px; padding: 6px;
    background: var(--bg-muted); color: var(--text-muted); border: 1px solid var(--border);
    border-radius: 6px; cursor: pointer; font-size: 12px;
  }
  .load-more:hover { color: var(--text); }
  .side-note { color: var(--text-muted); padding: 16px 14px; }
  .side-note.error { color: var(--red); white-space: pre-wrap; }

  .kbd-hints {
    padding: 8px 14px; border-top: 1px solid var(--border);
    font-size: 11px; color: var(--text-faint); display: flex; gap: 10px; flex-wrap: wrap;
  }
  .kbd-hints kbd { background: var(--border); border-radius: 3px; padding: 1px 4px; font-size: 10px; }
  /* Light/dark toggle pill in the sidebar footer (also the t key / Actions menu). */
  .theme-toggle {
    display: inline-flex; align-items: center; gap: 5px; cursor: pointer;
    padding: 2px 8px; font-size: 11px; color: var(--text-2);
    background: var(--bg); border: 1px solid var(--border-strong); border-radius: 6px;
  }
  .theme-toggle:hover { color: var(--accent); border-color: var(--accent); }
  .theme-toggle svg { width: 13px; height: 13px; }

  .bulk-actions { display: flex; gap: 6px; padding: 8px 14px; }
  .bulk-actions button {
    flex: 1; padding: 5px 0; font-size: 11px; cursor: pointer;
    background: var(--bg); border: 1px solid var(--border-strong); border-radius: 6px; color: var(--text-2);
  }
  .bulk-actions button:hover:not(:disabled) { color: var(--text); border-color: var(--accent); }
  .bulk-actions button:disabled { opacity: .5; cursor: default; }

  .auto-refresh-bar {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px 2px; font-size: 11px; color: var(--text-muted);
  }
  .switch {
    position: relative; width: 30px; height: 17px; flex-shrink: 0; padding: 0;
    background: var(--border-strong); border: none; border-radius: 999px; cursor: pointer;
    transition: background .15s;
  }
  .switch.on { background: var(--accent); }
  .switch-knob {
    position: absolute; top: 2px; left: 2px; width: 13px; height: 13px;
    background: var(--switch-knob); border-radius: 50%; transition: transform .15s;
  }
  .switch.on .switch-knob { transform: translateX(13px); }
  .switch-state { min-width: 18px; font-variant-numeric: tabular-nums; }

  .wt-label {
    display: flex; align-items: center; gap: 6px; width: 100%;
    padding: 12px 14px 2px; font-size: 11px; font-weight: 700;
    color: var(--accent); letter-spacing: .02em;
    background: none; border: none; cursor: pointer;
    font-family: inherit; text-align: left;
  }
  .wt-label:hover { color: var(--accent-strong); }
  .wt-label::before { content: "⎇"; opacity: .75; font-size: 12px; }
  .wt-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wt-count {
    margin-left: auto; flex-shrink: 0; font-size: 10px; font-weight: 600;
    color: var(--accent-dim); background: var(--accent-bg); border-radius: 999px; padding: 0 6px;
  }
  .wt-caret { flex-shrink: 0; font-size: 9px; color: var(--accent-faint); transition: transform .12s; }
  .wt-label.collapsed .wt-caret { transform: rotate(-90deg); }
  .wt-label + .group-label { padding-top: 4px; }
  .group-label {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 10px 14px 4px; font-size: 11px; font-weight: 600;
    color: var(--text-muted); text-transform: uppercase; letter-spacing: .04em;
  }
  .group-act {
    padding: 2px 8px; font-size: 10px; cursor: pointer;
    text-transform: none; letter-spacing: 0; flex-shrink: 0;
    background: var(--bg); border: 1px solid var(--border-strong); border-radius: 5px; color: var(--text-2);
  }
  .group-act:hover:not(:disabled) { color: var(--text); border-color: var(--accent); }
  .group-act:disabled { opacity: .5; cursor: default; }
  .change-row {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 14px; cursor: pointer;
    /* Reserve the height the hover-revealed action buttons need so showing
       them on :hover never reflows the row (no layout shift). */
    min-height: 30px;
  }
  .change-row:hover { background: var(--bg-hover); }
  .change-row .st { width: 12px; text-align: center; font-size: 11px; flex-shrink: 0; }
  .st-added, .st-untracked { color: var(--green); }
  .st-modified { color: var(--amber); }
  .st-deleted { color: var(--red); }
  .st-renamed { color: var(--blue); }
  .change-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
  .change-acts { display: none; gap: 4px; flex-shrink: 0; }
  .change-row:hover .change-acts { display: flex; }

  .act {
    padding: 1px 7px; font-size: 11px; cursor: pointer;
    background: var(--bg-muted); border: 1px solid var(--border-strong); border-radius: 5px; color: var(--text-2);
  }
  .act:hover:not(:disabled) { color: var(--text); border-color: var(--accent); }
  .act:disabled { opacity: .5; cursor: default; }
  .hdr-acts { display: inline-flex; gap: 5px; margin-left: 10px; }

  .diffs { flex: 1; overflow-y: auto; padding: 16px 20px 60vh; }
  /* Tmux tab: drop the top/bottom padding so the sticky title and the reply
     composer sit flush against the column edges. */
  .diffs.tmux { padding: 0 20px; }
  .section-label { font-size: 12px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .04em; margin: 6px 2px 10px; }
  .file-diff { margin-bottom: 16px; position: relative; }
  .diff-foot { display: flex; gap: 6px; margin-top: 6px; }
  .file-diff.viewing::before {
    content: ""; position: absolute; left: -10px; top: 0; bottom: 0;
    width: 3px; border-radius: 2px; background: var(--accent);
  }
  .empty { color: var(--text-muted); padding: 40px 0; text-align: center; }
  .empty.error { color: var(--red); white-space: pre-wrap; text-align: left; }
  .opaque-file {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 14px; border: 1px solid var(--border); border-radius: 8px;
    color: var(--text-muted); font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px;
  }
  .opaque-open { cursor: pointer; }
  .opaque-open:hover { color: var(--text); text-decoration: underline; }

  .tree {
    width: 280px; min-width: 280px;
    border-left: 1px solid var(--border);
    background: var(--bg-sidebar);
    display: flex; flex-direction: column;
    position: relative;
  }
  /* Desktop: collapse the right sidebar to a floating chevron (see .tree-reveal). */
  .tree-min {
    position: absolute; top: 8px; right: 8px; z-index: 2;
    display: inline-flex; align-items: center; justify-content: center;
    width: 24px; height: 24px; padding: 0; cursor: pointer;
    background: var(--bg); border: 1px solid var(--border); border-radius: 6px; color: var(--text-muted);
  }
  .tree-min:hover { color: var(--text); border-color: var(--border-strong); background: var(--bg-hover); }
  /* Floating tab that brings the minimized right sidebar back. */
  .tree-reveal {
    position: fixed; right: 0; top: 50%; transform: translateY(-50%); z-index: 40;
    display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 52px; padding: 0; cursor: pointer; color: var(--accent);
    background: var(--bg); border: 1px solid var(--border); border-right: none;
    border-radius: 8px 0 0 8px; box-shadow: -4px 0 14px rgba(0, 0, 0, .08);
  }
  .tree-reveal:hover { background: var(--accent-bg-hover); color: var(--accent-strong); }
  /* leave room for the meta-panel title so the minimize button never overlaps it */
  .tree .meta-panel { padding-right: 38px; }
  .meta-panel { padding: 14px; border-bottom: 1px solid var(--border); }
  .meta-panel h2 { font-size: 13px; margin: 0 0 6px; line-height: 1.4; word-break: break-word; }
  .meta-panel .meta-line { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-muted); margin-top: 4px; }
  .meta-panel .meta-line img { width: 14px; height: 14px; border-radius: 50%; }
  .meta-panel .sha-btn {
    background: var(--bg); border: 1px solid var(--border-strong); border-radius: 5px;
    padding: 1px 7px; font-size: 11px; cursor: pointer; color: var(--text-2);
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .meta-panel .sha-btn:hover { border-color: var(--accent); color: var(--text); }
  .meta-panel .gh-links { flex-wrap: wrap; gap: 8px; }
  .meta-panel .gh-link {
    display: inline-flex; align-items: center; gap: 4px; max-width: 100%;
    color: var(--text-2); text-decoration: none; font-size: 11px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .meta-panel .gh-link svg { flex: none; }
  .meta-panel .gh-link:hover { color: var(--accent); text-decoration: underline; }
  .tree-body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 8px 6px;
    --trees-bg-override: var(--bg-sidebar);
    --trees-bg-muted-override: var(--bg-hover);
    --trees-fg-override: var(--text);
    --trees-fg-muted-override: var(--text-muted);
    --trees-border-color-override: var(--border);
    --trees-selected-bg-override: var(--accent-bg);
    --trees-accent-override: var(--accent);
  }
  .tree-body > * { flex: 1; min-height: 0; }

  .modal-overlay {
    position: fixed; inset: 0; z-index: 50;
    background: rgba(0, 0, 0, .35);
    display: flex; align-items: center; justify-content: center;
  }
  .modal {
    width: 460px; max-width: calc(100vw - 40px);
    max-height: 90vh; overflow-y: auto;
    background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
    padding: 16px; box-shadow: 0 12px 44px rgba(0, 0, 0, .18);
  }
  .modal h3 { margin: 0 0 10px; font-size: 14px; }
  .modal-body { margin: 0; font-size: 13px; line-height: 1.5; color: var(--text-muted); }
  .modal-body code { color: var(--text); }
  .commit-input {
    width: 100%; min-height: 92px; max-height: 60vh; resize: vertical; overflow-y: auto;
    background: var(--bg); color: inherit; font: inherit; line-height: 1.5;
    border: 1px solid var(--border-strong); border-radius: 6px; padding: 8px 10px; outline: none;
  }
  /* The New Claude session composer grows to fit its content via JS (autosizeClaude),
     so manual drag-resize is off; it scrolls internally once it hits max-height. */
  .commit-input.auto { resize: none; }
  .commit-input:focus { border-color: var(--accent); }
  .modal-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  /* Square icon buttons in the composer toolbars (attach image, go to last
     directory, new session). The lucide glyph is sized to 16px and the padding
     keeps them square against the wider text .act buttons sharing the row. */
  .icon-btn { display: inline-flex; align-items: center; justify-content: center; line-height: 0; }
  .icon-btn svg { width: 16px; height: 16px; }
  .icon-btn .icon-spin { font-size: 14px; line-height: 1; }
  .reply-bar .icon-btn, .modal-actions .icon-btn { padding: 6px; border-radius: 7px; }
  /* The image picker is pinned bottom-left in the modal footer (the rest of the
     row stays right-aligned). */
  .modal-actions .img-pick { margin-right: auto; }
  .modal-actions .primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .modal-actions .primary:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); }
  .modal-hint { margin-top: 10px; font-size: 11px; color: var(--text-faint); display: flex; gap: 8px; flex-wrap: wrap; }
  .modal-hint kbd { background: var(--border); border-radius: 3px; padding: 1px 4px; }
  .modal-hint code { color: var(--text-muted); }

  /* Claude usage dialog (⇧U) — one row per rate-limit window: label, percent,
     a fill bar, and the reset countdown. */
  .usage-note { padding: 8px 2px 4px; font-size: 13px; color: var(--text-muted); line-height: 1.5; }
  .usage-note.error { color: var(--red); white-space: pre-wrap; }
  .usage-grid { display: flex; flex-direction: column; gap: 16px; padding: 4px 0 2px; }
  .usage-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 7px; }
  .usage-label { font-size: 13px; font-weight: 600; }
  .usage-sub { font-weight: 400; font-size: 11px; color: var(--text-faint); }
  .usage-pct { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .usage-bar { height: 8px; border-radius: 999px; background: var(--border); overflow: hidden; }
  .usage-fill {
    height: 100%; border-radius: 999px; background: var(--accent);
    min-width: 2%; transition: width .2s;
  }
  .usage-fill.warm { background: #e0a800; }
  .usage-fill.hot { background: var(--red); }
  .usage-reset { margin-top: 6px; font-size: 11px; color: var(--text-muted); }
  .usage-reset.muted { color: var(--text-faint); }
  .usage-reset strong { color: var(--text); font-weight: 600; }
  .usage-clock { color: var(--text-faint); }

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
    background: var(--bg); border: 1px solid var(--border-strong); border-radius: 7px; color: var(--text);
  }
  .dir-trigger:hover { border-color: var(--accent); }
  .dir-trigger .dir-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dir-trigger .dir-sub { font-size: 11px; font-weight: 400; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dir-trigger .dir-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .dir-trigger .dir-caret { margin-left: auto; color: var(--text-faint); font-size: 10px; flex-shrink: 0; }
  .dir-menu {
    position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 30;
    background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
    box-shadow: 0 10px 34px rgba(0, 0, 0, .16); padding: 4px;
    display: flex; flex-direction: column; max-height: 60vh;
  }
  /* Combobox filter, pinned above the scrolling directory list. */
  .dir-search {
    width: 100%; box-sizing: border-box; margin: 0 0 6px; padding: 6px 9px;
    border: 1px solid var(--border-strong); border-radius: 6px; font: inherit; color: var(--text); outline: none;
  }
  .dir-search:focus { border-color: var(--accent); }
  .dir-list { overflow-y: auto; min-height: 0; }
  .dir-empty { padding: 8px 9px; color: var(--text-faint); font-size: 12px; }
  .dir-item {
    display: flex; flex-direction: row; align-items: center; gap: 8px; width: 100%; text-align: left; cursor: pointer;
    padding: 6px 9px; background: none; border: none; border-radius: 6px;
  }
  .dir-item:hover { background: var(--bg-hover); }
  .dir-item.on { background: var(--accent-bg); }
  /* Keyboard-highlighted row in the combobox (ring so it reads even on .on). */
  .dir-item.active { background: var(--bg-hover); box-shadow: inset 0 0 0 1px var(--accent-ring); }
  .dir-item .dir-item-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
  .dir-item .dir-item-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dir-item .dir-item-path { font-size: 11px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dir-item .dir-item-key {
    flex-shrink: 0; font-size: 10px; color: var(--text-faint); font-variant-numeric: tabular-nums;
    background: var(--bg-hover); border-radius: 4px; padding: 1px 5px;
  }
  .dir-item.on .dir-item-key, .dir-item.active .dir-item-key { background: var(--accent-key-bg); color: var(--accent); }
  .dir-menu-sep { height: 1px; background: var(--border); margin: 4px 2px; }
  .dir-menu-act {
    display: block; width: 100%; text-align: left; cursor: pointer;
    padding: 6px 9px; background: none; border: none; border-radius: 6px; color: var(--text-2);
  }
  .dir-menu-act:hover { background: var(--bg-hover); color: var(--text); }

  /* Settings dialog (manage directories) */
  .modal.wide { width: 560px; }
  .dir-rows { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; max-height: 46vh; overflow-y: auto; }
  .dir-row {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px;
  }
  .dir-row .dir-row-text { flex: 1; min-width: 0; }
  .dir-row .dir-row-name { font-weight: 600; }
  .dir-row .dir-row-meta { font-size: 11px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dir-form { display: grid; grid-template-columns: 90px 1fr; gap: 8px 10px; align-items: center; }
  .dir-form label { font-size: 12px; color: var(--text-muted); }
  .dir-form input {
    width: 100%; padding: 6px 9px; font: inherit; font-size: 13px;
    background: var(--bg); color: inherit; border: 1px solid var(--border-strong); border-radius: 6px; outline: none;
  }
  .dir-form input:focus { border-color: var(--accent); }
  .dir-form .dir-form-hint { grid-column: 2; font-size: 11px; color: var(--text-faint); margin-top: -2px; }
  .modal-error { margin-top: 10px; color: var(--red); font-size: 12px; white-space: pre-wrap; }

  /* @-file autocomplete popup in the New Claude session dialog. Portaled to
     <body> with fixed coords (left/top|bottom/width/max-height set inline from
     the textarea's rect) so the modal's overflow never clips it. */
  .file-menu-wrap { position: relative; }
  .file-menu {
    position: fixed; z-index: 60;
    background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
    box-shadow: 0 10px 34px rgba(0, 0, 0, .18); padding: 4px;
    overflow-y: auto;
  }
  .file-opt {
    display: block; width: 100%; text-align: left; cursor: pointer;
    padding: 5px 9px; background: none; border: none; border-radius: 6px;
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left;
  }
  .file-opt:hover, .file-opt.on { background: var(--accent-bg); }
  .file-menu-empty { padding: 8px 9px; color: var(--text-faint); font-size: 12px; }

  /* ---- Desktop (≥1025px): resizable sidebar widths from JS-driven CSS vars,
     clamped client-side to the min/max in client.tsx. ---- */
  @media (min-width: 1025px) {
    .commits { width: var(--left-w, 300px); min-width: var(--left-w, 300px); }
    .tree { width: var(--right-w, 280px); min-width: var(--right-w, 280px); }
  }

  /* ---- Mobile/tablet (≤1024px): the top bar appears and both sidebars become
     off-canvas drawers slid in by the burger / panel buttons. ---- */
  @media (max-width: 1024px) {
    .topbar {
      display: flex; align-items: center; gap: 10px; flex-shrink: 0;
      padding: 8px 12px; border-bottom: 1px solid var(--border); background: var(--bg-sidebar);
    }
    .resizer { display: none; }
    .tree-min { display: none; }

    /* Drawers: fixed, off-canvas, slide in on transform. They sit below the top
       bar (top: 51px) and above the scrim. */
    .commits, .tree {
      position: fixed; top: 51px; bottom: 0; z-index: 45;
      width: min(86vw, 380px); min-width: 0;
      transition: transform .22s ease;
    }
    .commits { left: 0; transform: translateX(-100%); }
    .tree { right: 0; left: auto; transform: translateX(100%); }
    .layout[data-drawer="left"] .commits { transform: translateX(0); box-shadow: 6px 0 28px rgba(0,0,0,.18); }
    .layout[data-drawer="right"] .tree { transform: translateX(0); box-shadow: -6px 0 28px rgba(0,0,0,.18); }

    .scrim { position: fixed; top: 51px; inset: 51px 0 0; z-index: 44; background: rgba(0,0,0,.35); }

    /* New Claude session dialog on mobile: a centered dialog gets covered by the
       on-screen keyboard, so pin it to the top and give the composer more room
       by default (it still auto-grows + scrolls past this floor). */
    .claude-overlay { align-items: flex-start; padding-top: 12px; }
    .claude .commit-input.auto { min-height: 180px; }
  }
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

    // Restart a server running in a tmux window. By default this is diffshub
    // itself — a foreground `bun` in the `dh` window of the `bg` tmux socket,
    // relaunched by typing `dh` — but the Restart dialog (`⇧R`) can point both
    // the target window and the relaunch command anywhere. A manual refresh is
    // Ctrl-C in that pane then re-typing the command. We can't do that inline —
    // sending C-c kills *this* process mid-request, before it could relaunch
    // anything. So, like /api/commit, we hand the work to a detached `tmux -L bg`
    // session that outlives our death: it pauses (so this response flushes
    // first), sends C-c to drop back to the shell, waits for the port to free,
    // then types the command + Enter.
    if (req.method === "POST" && url.pathname === "/api/restart-server") {
      try {
        const body = (await req.json().catch(() => ({}))) as {
          window?: string;
          command?: string;
        };
        const windowName = (body.window ?? "").trim() || "dh";
        const command = (body.command ?? "").trim() || "dh";
        // Find the pane whose window matches `windowName` on the bg socket.
        const SEP = "\x1f";
        const target = (
          await $`tmux -L bg list-panes -a -F ${`#{window_name}${SEP}#{session_name}:#{window_index}.#{pane_index}`}`.quiet().text()
        )
          .trim()
          .split("\n")
          .map((l) => l.split(SEP))
          .find(([name]) => name === windowName)?.[1];
        if (!target) return json({ error: `No \`${windowName}\` window on the bg tmux socket` }, 404);
        const session = `diffshub-restart-${Date.now()}`;
        const script =
          `sleep 0.4; tmux -L bg send-keys -t ${shq(target)} C-c; ` +
          `sleep 1; tmux -L bg send-keys -t ${shq(target)} ${shq(command)} Enter`;
        await $`tmux -L bg new-session -d -s ${session} ${script}`.quiet();
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
      return json({ ok: true });
    }

    // Claude usage windows. The statusline hook (~/.claude/statusline-ratelimit.sh)
    // writes the latest five-hour and seven-day rate-limit state to
    // ~/.claude/rate-limits.json on every render; we just surface that file so the
    // Usage dialog (`⇧U`) can show how much of each window is spent and when it
    // resets. No file yet (statusline never ran) → null windows, so the dialog can
    // say "no data yet" instead of erroring.
    if (req.method === "GET" && url.pathname === "/api/usage") {
      try {
        const f = Bun.file(`${process.env.HOME}/.claude/rate-limits.json`);
        if (!(await f.exists())) {
          return json({ five_hour: null, seven_day: null, updated_at: null });
        }
        return json(await f.json());
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
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
      // Offline → enqueue instead of launching a session that couldn't reach the
      // API. drainQueue() launches it automatically once we're back online.
      if (!(await checkOnline(true))) {
        const id = insertQueuedStmt.get(ws.id, body.prompt, Date.now())!.id;
        return json({ ok: true, queued: true, id });
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
        return json({
          sessions: await listClaudeSessions(),
          queued: listQueuedSessions(),
          online: onlineState.online,
        });
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
    }

    // Drop a queued (offline) prompt before it launches.
    if (req.method === "POST" && url.pathname === "/api/queue/cancel") {
      let body: { id?: unknown };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      const id = Number(body.id);
      if (!Number.isInteger(id) || id < 1) return json({ error: "Invalid id" }, 400);
      deleteQueuedStmt.run(id);
      return json({ ok: true });
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
        // An idle pane (no braille spinner) may be blocked on an interactive
        // prompt that isn't in the transcript yet — capture it from the live pane
        // so the question doesn't go unseen until it's answered.
        const busy = /^[⠀-⣿]/u.test(paneTitle ?? "");
        const pendingPane = busy ? null : await capturePendingPrompt(name);
        const path = await resolveTranscript(cwd ?? "", sid ?? "", task);
        if (!path || !existsSync(path)) {
          return json({ session: name, cwd, sessionId: sid, path: null, messages: [], model: "", title: "", pendingPane });
        }
        const text = await Bun.file(path).text();
        const { messages, model, title } = parseTranscript(text, limit);
        return json({ session: name, cwd, sessionId: sid, path, messages, model, title, pendingPane });
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
    }

    // Serve one image from a transcript (a png claude read, a screenshot tool's
    // output, or a pasted image) by the "<lineIdx>:<imgOrdinal>" ref that
    // parseTranscript emitted. Kept out of the transcript JSON — base64 images are
    // large and the transcript is polled — so the browser fetches each once and
    // caches it hard.
    if (req.method === "GET" && url.pathname === "/api/tmux/image") {
      const name = url.searchParams.get("session") ?? "";
      const ref = url.searchParams.get("ref") ?? "";
      const m = /^(\d+):(\d+)$/.exec(ref);
      if (!name || !m) return json({ error: "Missing session or ref" }, 400);
      try {
        const SEP = "\x1f";
        const info = (
          await $`tmux -L default display-message -p -t ${`${name}:0.0`} ${["#{pane_current_path}", "#{@claude_session}", "#{pane_current_command}", "#{pane_title}"].join(SEP)}`.quiet().text()
        ).trim();
        const [cwd, sid, cmd, paneTitle] = info.split(SEP);
        const task = cleanTitle(paneTitle ?? "", name, cmd ?? "");
        const path = await resolveTranscript(cwd ?? "", sid ?? "", task);
        if (!path || !existsSync(path)) return json({ error: "No transcript" }, 404);
        const line = (await Bun.file(path).text()).split("\n")[parseInt(m[1], 10)];
        if (!line) return json({ error: "Out of range" }, 404);
        let d: any;
        try {
          d = JSON.parse(line);
        } catch {
          return json({ error: "Unparseable line" }, 404);
        }
        const img = collectImages(d?.message?.content)[parseInt(m[2], 10)];
        if (!img) return json({ error: "No image" }, 404);
        return new Response(Buffer.from(img.data, "base64"), {
          headers: {
            "Content-Type": img.mediaType || "image/png",
            // ref → fixed bytes for an append-only transcript, so cache hard.
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        });
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

    // Interrupt a session's claude pane: send Escape, exactly the key you'd press
    // in the terminal to stop claude mid-turn. (Sent as a key name, not pasted
    // text, so it can't go through pasteAndSubmit.)
    if (req.method === "POST" && url.pathname === "/api/tmux/stop") {
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
        await $`tmux -L default send-keys -t ${`${body.session}:0.0`} Escape`.quiet();
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
