#!/usr/bin/env bun

import { $ } from "bun";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
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
// Each member entry may be an exact sub-dir name OR a glob (`*`, `?`, `[2-6]`)
// matched against the immediate child git repos/worktrees — so `tax-holiday.[2-6]`
// keeps picking up worktrees as they come and go without re-editing the list.

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
  } catch { }
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
  } catch { }
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
  } catch { }
  return null;
}

// Immediate child directories of `path` that are git repos or worktrees (a `.git`
// dir or file), sorted. Shared by glob expansion and the auto-detect fallback.
function childGitRepos(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(`${path}/${e.name}/.git`))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

// Expand a member spec into concrete child directory names. Each entry is either an
// exact name or a glob (`*`, `?`, `[2-6]`) matched against the immediate child git
// repos. A glob matches a single path segment only (no recursion). An exact name
// keeps the prior behavior: kept only if it's actually a git repo/worktree. Order
// follows the spec; duplicates are dropped. The child scan runs only when a glob is
// present, so the common exact-list case stays a cheap existsSync per entry.
function expandRepoPatterns(path: string, patterns: string[]): string[] {
  const isGlob = (s: string) => /[*?[\]]/.test(s);
  const children = patterns.some(isGlob) ? childGitRepos(path) : [];
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (name: string) => {
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  };
  for (const pat of patterns) {
    if (isGlob(pat)) {
      const glob = new Bun.Glob(pat);
      for (const name of children) if (glob.match(name)) add(name);
    } else if (existsSync(`${path}/${pat}/.git`)) {
      add(pat);
    }
  }
  return out;
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
    } catch { }
  }
  if (!keys.length) keys = ["app", "web"];
  // Exact names and globs alike resolve through expandRepoPatterns (so member lists,
  // $DIFFSHUB_REPOS, and .diffshub.json all get glob support for free).
  const members = expandRepoPatterns(path, keys);
  let resolved = await Promise.all(members.map((k) => resolveRepoOrLocal(k, `${path}/${k}`)));
  if (!resolved.length) {
    // Fall back to every immediate child that is a git repo.
    resolved = await Promise.all(
      childGitRepos(path).map((k) => resolveRepoOrLocal(k, `${path}/${k}`)),
    );
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
    } catch { }
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

// ---- Web Push (installed-PWA notifications) ----
// One row per device that opted in. Keyed by the push endpoint; p256dh/auth are
// the subscription's encryption keys. Dead endpoints (HTTP 404/410 on send) are
// pruned automatically — see sendPush / notifyAll.
interface PushSub {
  endpoint: string;
  p256dh: string;
  auth: string;
}
db.run(`CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`);
const upsertSubStmt = db.query(
  "INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?) " +
  "ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth",
);
const listSubsStmt = db.query<PushSub, []>("SELECT endpoint, p256dh, auth FROM push_subscriptions");
const deleteSubStmt = db.query("DELETE FROM push_subscriptions WHERE endpoint = ?");
const countSubsStmt = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM push_subscriptions");

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

// Prompts enqueued while the machine was offline (the agent can't reach its API, so
// launching a session would do nothing). Each row is drained — launched as a real
// session of its `agent` — automatically once connectivity returns. See checkOnline
// / drainQueue.
db.run(`CREATE TABLE IF NOT EXISTS queued_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dir_id INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  agent TEXT NOT NULL DEFAULT 'claude',
  effort TEXT,
  chrome INTEGER NOT NULL DEFAULT 0
)`);
// Migrate DBs created before the agent column existed (no-op once applied).
try {
  db.run("ALTER TABLE queued_sessions ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude'");
} catch { }
try {
  db.run("ALTER TABLE queued_sessions ADD COLUMN effort TEXT");
} catch { }
try {
  db.run("ALTER TABLE queued_sessions ADD COLUMN chrome INTEGER NOT NULL DEFAULT 0");
} catch { }
interface QueuedRow {
  id: number;
  dir_id: number;
  prompt: string;
  created_at: number;
  agent: string;
  effort: string | null;
  chrome: number;
}
const insertQueuedStmt = db.query<{ id: number }, [number, string, number, string, string | null, number]>(
  "INSERT INTO queued_sessions (dir_id, prompt, created_at, agent, effort, chrome) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
);
const listQueuedStmt = db.query<QueuedRow, []>(
  "SELECT * FROM queued_sessions ORDER BY created_at, id",
);
const deleteQueuedStmt = db.query("DELETE FROM queued_sessions WHERE id = ?");

// Template prompts shown in the Prompts tab. Scoped to a registered directory so
// project-specific runbooks stay beside the work they belong to.
db.run(`CREATE TABLE IF NOT EXISTS template_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dir_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`);
// Migrate rows created by the earlier draft table name. Kept best-effort so fresh
// DBs (where saved_prompts never existed) continue without branching on schema.
try {
  db.run(
    "INSERT OR IGNORE INTO template_prompts (id, dir_id, title, body, created_at, updated_at) " +
    "SELECT id, dir_id, title, body, created_at, updated_at FROM saved_prompts",
  );
} catch { }
interface TemplatePromptRow {
  id: number;
  dir_id: number;
  title: string;
  body: string;
  created_at: number;
  updated_at: number;
}
const listTemplatePromptsStmt = db.query<TemplatePromptRow, [number]>(
  "SELECT * FROM template_prompts WHERE dir_id = ? ORDER BY updated_at DESC, id DESC",
);
const getTemplatePromptStmt = db.query<TemplatePromptRow, [number, number]>(
  "SELECT * FROM template_prompts WHERE id = ? AND dir_id = ?",
);
const insertTemplatePromptStmt = db.query<{ id: number }, [number, string, string, number, number]>(
  "INSERT INTO template_prompts (dir_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
);
const updateTemplatePromptStmt = db.query<unknown, [string, string, number, number, number]>(
  "UPDATE template_prompts SET title = ?, body = ?, updated_at = ? WHERE id = ? AND dir_id = ?",
);
const deleteTemplatePromptStmt = db.query("DELETE FROM template_prompts WHERE id = ? AND dir_id = ?");

// When each Claude session last finished a turn — written by its Stop hook (POST
// /api/session-ended), keyed by session_id (which is the transcript file's UUID).
// The Home and sidebar lists order idle sessions by this "most recently ended" time
// instead of the transcript file's mtime, which also advances mid-turn and so made
// the ordering jump around. Rows are tiny; we prune ones older than 60 days on write.
db.run(`CREATE TABLE IF NOT EXISTS session_ends (
  session_id TEXT PRIMARY KEY,
  cwd TEXT,
  ended_at INTEGER NOT NULL
)`);
const upsertSessionEndStmt = db.query(
  "INSERT INTO session_ends (session_id, cwd, ended_at) VALUES (?, ?, ?) " +
  "ON CONFLICT(session_id) DO UPDATE SET ended_at = excluded.ended_at, cwd = excluded.cwd",
);
const getSessionEndStmt = db.query<{ ended_at: number }, [string]>(
  "SELECT ended_at FROM session_ends WHERE session_id = ?",
);
const pruneSessionEndsStmt = db.query("DELETE FROM session_ends WHERE ended_at < ?");

// Subway "Keep" dismissals: keep the live tmux chat, but remove it from future
// Subway review snapshots for the selected directory.
db.run(`CREATE TABLE IF NOT EXISTS subway_kept (
  dir_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  session_name TEXT NOT NULL,
  cwd TEXT NOT NULL,
  agent TEXT NOT NULL,
  kept_at INTEGER NOT NULL,
  PRIMARY KEY (dir_id, session_id)
)`);
const upsertSubwayKeptStmt = db.query(
  "INSERT INTO subway_kept (dir_id, session_id, session_name, cwd, agent, kept_at) VALUES (?, ?, ?, ?, ?, ?) " +
  "ON CONFLICT(dir_id, session_id) DO UPDATE SET session_name = excluded.session_name, cwd = excluded.cwd, agent = excluded.agent, kept_at = excluded.kept_at",
);
const listSubwayKeptStmt = db.query<{ session_id: string }, [number]>(
  "SELECT session_id FROM subway_kept WHERE dir_id = ?",
);
const pruneSubwayKeptStmt = db.query("DELETE FROM subway_kept WHERE kept_at < ?");

// ---- Public sharing (R2 via the wrangler CLI) ----
// The "Share" button in the HTML preview uploads an artifact's .html (plus any
// local, non-base64 image assets it references) to a public R2 bucket and hands
// back a cdn link. Bucket + public base live in env vars so these dotfiles stay
// generic — defaults point at my porio-public bucket / cdn.porio.ai domain.
const R2_BUCKET = process.env.DIFFSHUB_R2_BUCKET || "porio-public";
const R2_PUBLIC_BASE = (process.env.DIFFSHUB_R2_PUBLIC_BASE || "https://cdn.porio.ai").replace(
  /\/+$/,
  "",
);
const R2_PREFIX = "diffshub"; // namespace under the shared public bucket
// One row per shared artifact, keyed by its absolute path so re-sharing the same
// file always resolves to the same link (we re-upload in place when the contents
// changed, leaving the URL stable). content_hash lets us skip a no-op re-upload.
db.run(`CREATE TABLE IF NOT EXISTS shares (
  abs_path TEXT PRIMARY KEY,
  share_id TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  asset_keys TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`);
// Migration for any pre-existing shares table (asset_keys was added later, to let
// "Undo" delete the artifact's uploaded image objects too). Dupe-column throws.
try {
  db.run("ALTER TABLE shares ADD COLUMN asset_keys TEXT");
} catch { }
interface ShareRow {
  abs_path: string;
  share_id: string;
  url: string;
  content_hash: string;
  asset_keys: string | null; // JSON array of uploaded R2 asset keys
  created_at: number;
  updated_at: number;
}
const getShareStmt = db.query<ShareRow, [string]>("SELECT * FROM shares WHERE abs_path = ?");
const upsertShareStmt = db.query(
  "INSERT INTO shares (abs_path, share_id, url, content_hash, asset_keys, created_at, updated_at) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(abs_path) DO UPDATE SET " +
  "url = excluded.url, content_hash = excluded.content_hash, asset_keys = excluded.asset_keys, " +
  "updated_at = excluded.updated_at",
);
const deleteShareStmt = db.query("DELETE FROM shares WHERE abs_path = ?");

// Image extensions we know how to serve — also the allowlist deciding which
// local refs in an HTML artifact are worth uploading (we leave fonts/css/js).
const IMG_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  avif: "image/avif",
  apng: "image/apng",
};
const extOf = (p: string) => (p.split(".").pop() || "").toLowerCase();

// Upload bytes to R2 at <key> via the wrangler CLI. Writes a temp file and
// shells out to `wrangler r2 object put … --remote` (the --remote flag is
// required — without it wrangler targets its local simulation, not the real
// bucket). Throws a ShellError carrying wrangler's stderr on a non-zero exit,
// which errText() surfaces to the share dialog.
async function r2Put(key: string, body: Buffer | string, contentType: string): Promise<void> {
  const tmp = `/tmp/diffshub-share-${crypto.randomUUID()}`;
  await Bun.write(tmp, body);
  try {
    // Run in the state dir (not the server's cwd) so wrangler's .wrangler cache
    // doesn't get scattered into whatever repo diffshub was launched from. The
    // --file path is absolute, so the cwd change doesn't affect it.
    await $`wrangler r2 object put ${`${R2_BUCKET}/${key}`} --file ${tmp} --content-type ${contentType} --remote`
      .cwd(stateDir)
      .quiet();
  } finally {
    try {
      unlinkSync(tmp);
    } catch { }
  }
}

// Delete an object from R2 by key (used by Undo). Tolerates an already-missing
// object — wrangler treats a delete of a non-existent key as success.
async function r2Delete(key: string): Promise<void> {
  await $`wrangler r2 object delete ${`${R2_BUCKET}/${key}`} --remote`.cwd(stateDir).quiet();
}

// Pull every src/href/poster/srcset/url(...) reference out of an HTML string.
function collectAssetRefs(html: string): string[] {
  const refs = new Set<string>();
  const add = (u?: string | null) => {
    if (u && u.trim()) refs.add(u.trim());
  };
  for (const m of html.matchAll(/\b(?:src|href|poster)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi))
    add(m[1] ?? m[2]);
  for (const m of html.matchAll(/\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const val = m[1] ?? m[2] ?? "";
    for (const cand of val.split(",")) add(cand.trim().split(/\s+/)[0]);
  }
  for (const m of html.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]+))\s*\)/gi))
    add(m[1] ?? m[2] ?? m[3]);
  return [...refs];
}

// A ref we should leave alone: already-inlined (data:), already-remote (http(s)
// or protocol-relative //), or a non-asset URL (anchors, mailto, tel).
const isExternalRef = (u: string) => /^(?:data:|https?:|\/\/|#|mailto:|tel:|blob:)/i.test(u);

// Replace every src/href/poster/srcset/url() ref present in `map` with its mapped
// value — one pass per attribute family, since a literal string replace would
// corrupt a ref that's a substring of another. Shared by the R2 share rewrite and
// the live-preview asset rewrite (rewriteLocalAssets). Emits a bare url(...) so the
// result stays valid CSS in a <style> block or a quoted style="" attribute.
function applyRefMap(html: string, map: Map<string, string>): string {
  if (map.size === 0) return html;
  let out = html.replace(
    /(\b(?:src|href|poster)\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi,
    (full, pre, dq, sq) => {
      const raw = dq ?? sq;
      const mapped = map.get(raw.trim());
      return mapped ? `${pre}"${mapped}"` : full;
    },
  );
  out = out.replace(/(\bsrcset\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi, (full, pre, dq, sq) => {
    const raw = dq ?? sq ?? "";
    const rebuilt = raw
      .split(",")
      .map((cand: string) => {
        const t = cand.trim();
        if (!t) return cand;
        const [u, ...descr] = t.split(/\s+/);
        const mapped = map.get(u.trim());
        return mapped ? [mapped, ...descr].join(" ") : t;
      })
      .join(", ");
    return `${pre}"${rebuilt}"`;
  });
  out = out.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]+))\s*\)/gi, (full, dq, sq, bare) => {
    const mapped = map.get((dq ?? sq ?? bare ?? "").trim());
    return mapped ? `url(${mapped})` : full;
  });
  return out;
}

// Find local, non-base64 image assets referenced by an HTML artifact, upload
// each to R2 under the share's asset folder, and return the HTML with those
// references rewritten to absolute cdn URLs. Assets are resolved against the
// HTML file's own directory and must stay inside the session cwd (same guard as
// /api/tmux/html), so a crafted ref can't exfiltrate arbitrary files. Refs we
// can't resolve to a local image are left untouched and reported in `skipped`.
async function uploadHtmlAssets(
  html: string,
  htmlDir: string,
  cwd: string,
  shareId: string,
): Promise<{ html: string; uploaded: string[]; skipped: string[]; keys: string[] }> {
  const uploaded: string[] = [];
  const skipped: string[] = [];
  const keys: string[] = []; // R2 object keys we created (for Undo)
  const map = new Map<string, string>(); // original ref -> cdn url

  for (const ref of collectAssetRefs(html)) {
    if (isExternalRef(ref) || map.has(ref)) continue;
    const clean = ref.replace(/[?#].*$/, ""); // drop ?query / #frag
    if (!IMG_MIME[extOf(clean)]) continue; // only images
    let absAsset: string;
    try {
      absAsset = resolve(htmlDir, decodeURIComponent(clean));
    } catch {
      absAsset = resolve(htmlDir, clean);
    }
    if (absAsset !== cwd && !absAsset.startsWith(cwd + sep)) {
      skipped.push(ref);
      continue;
    }
    if (!existsSync(absAsset) || !statSync(absAsset).isFile()) {
      skipped.push(ref);
      continue;
    }
    // Tag the basename with a short path hash so two same-named files in
    // different folders don't collide in the flat asset directory. The basename
    // is sanitized to a URL-safe charset so the resulting cdn link never needs
    // quoting/escaping (it goes into bare url(...) / src="" without breakage).
    const base = (absAsset.split(sep).pop() || "asset").replace(/[^A-Za-z0-9._-]/g, "_");
    const tag = crypto.createHash("sha1").update(absAsset).digest("hex").slice(0, 8);
    const key = `${R2_PREFIX}/${shareId}/${tag}-${base}`;
    const bytes = Buffer.from(await Bun.file(absAsset).arrayBuffer());
    await r2Put(key, bytes, IMG_MIME[extOf(clean)]);
    map.set(ref, `${R2_PUBLIC_BASE}/${key}`);
    uploaded.push(ref);
    keys.push(key);
  }

  return { html: applyRefMap(html, map), uploaded, skipped, keys };
}

// Rewrite an HTML artifact's local asset refs (images, css, js, fonts, …) to
// absolute /api/tmux/asset URLs so the srcDoc preview can load the files sitting
// next to the HTML. Mirrors uploadHtmlAssets' resolve + cwd guard, but points at
// our own asset route instead of uploading to R2: the rewritten URLs are
// same-origin as the diffshub page, so they work over the https tailscale URL (no
// mixed content) where a bare relative ref — resolved against the diffshub origin,
// not the file's folder — just 404s into the SPA fallback. Refs that don't resolve
// to a real file inside cwd (and .html links, which aren't this preview's job) are
// left untouched.
function rewriteLocalAssets(html: string, htmlDir: string, cwd: string, session: string): string {
  const map = new Map<string, string>(); // original ref -> /api/tmux/asset url
  for (const ref of collectAssetRefs(html)) {
    if (isExternalRef(ref) || map.has(ref)) continue;
    const clean = ref.replace(/[?#].*$/, ""); // drop ?query / #frag for resolution
    if (!clean || /\.html?$/i.test(clean)) continue;
    let absAsset: string;
    try {
      absAsset = resolve(htmlDir, decodeURIComponent(clean));
    } catch {
      absAsset = resolve(htmlDir, clean);
    }
    if (absAsset !== cwd && !absAsset.startsWith(cwd + sep)) continue; // escape guard
    if (!existsSync(absAsset) || !statSync(absAsset).isFile()) continue;
    map.set(
      ref,
      `/api/tmux/asset?session=${encodeURIComponent(session)}&path=${encodeURIComponent(absAsset)}`,
    );
  }
  return applyRefMap(html, map);
}

// ---- HTML reports viewer (the standalone agents-cli, folded in) ----
// Lists and serves agents/**/*.html under a workspace so one diffshub server
// covers what the separate agents-cli viewer did. Unlike the tmux/html preview
// (srcDoc + rewritten assets), reports load by URL under /api/html/raw/<dir>/…,
// so a report's relative sibling refs (images, css, fonts) resolve to the same
// prefix and get served as-is — no rewriting needed.
function listAgentHtml(root: string): { path: string; mtime: number }[] {
  if (!existsSync(`${root}/agents`)) return [];
  const out: { path: string; mtime: number }[] = [];
  for (const rel of new Bun.Glob("agents/**/*.html").scanSync({ cwd: root, onlyFiles: true })) {
    try {
      out.push({ path: rel, mtime: statSync(`${root}/${rel}`).mtimeMs });
    } catch {
      // file vanished between scan and stat — skip it
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// Resolve a client-supplied dir id to its workspace root path (sync — no gh).
function htmlRootFromDir(dir: unknown): string | null {
  const id = typeof dir === "number" ? dir : typeof dir === "string" ? parseInt(dir, 10) : NaN;
  if (!Number.isInteger(id)) return null;
  return getDirStmt.get(id)?.path ?? null;
}

// Resolve a relative report path under root, requiring it to stay inside agents/
// and end in .html — so rename/delete can't escape the tree or touch other files.
function htmlSafePath(root: string, p: unknown): string | null {
  if (typeof p !== "string" || !p.trim()) return null;
  const abs = resolve(root, p);
  const agentsDir = `${root}/agents`;
  if (abs !== agentsDir && !abs.startsWith(agentsDir + sep)) return null;
  if (!/\.html?$/i.test(abs)) return null;
  return abs;
}

// Vimium-style keyboard layer injected into every served report. Runs inside the
// (same-origin) iframe: j/k/d/u/g/G/h/l scroll, f/F are link hints, and the app
// keys (J/K next/prev report, / search, ; copy, o open, r reload, 1-9 tab switch)
// post up to the diffshub parent. Skips when typing in the report's own fields.
const REPORT_SHORTCUTS_JS = `<script>/* diffshub report keys */(function(){
  if (window.__diffshubReportKeys) return; window.__diffshubReportKeys = true;
  var d = document, w = window, lastG = 0;
  function typing(el){ return !!el && (el.tagName==='INPUT'||el.tagName==='TEXTAREA'||el.tagName==='SELECT'||el.isContentEditable); }
  function send(a){ try { w.parent.postMessage({source:'diffshub-report', action:a}, '*'); } catch(e){} }
  var CH = 'sadfjklewcmpgh', hints = [], hintBuf = '', hintMode = false, hintNew = false;
  function labels(n){ var o=[],i; if(n<=CH.length){ for(i=0;i<n;i++) o.push(CH[i]); } else { for(i=0;i<n;i++) o.push(CH[Math.floor(i/CH.length)%CH.length]+CH[i%CH.length]); } return o; }
  function clearHints(){ for(var i=0;i<hints.length;i++){ var tp=hints[i].tip; if(tp&&tp.parentNode) tp.parentNode.removeChild(tp); } hints=[]; hintBuf=''; hintMode=false; }
  function showHints(nt){ clearHints(); hintMode=true; hintNew=nt;
    var nodes=d.querySelectorAll('a[href],button,[onclick],[role=button],input:not([type=hidden]),select,textarea,summary,label[for]'), vis=[], i;
    for(i=0;i<nodes.length;i++){ var el=nodes[i], r=el.getBoundingClientRect(); if(r.width>0&&r.height>0&&r.bottom>0&&r.top<w.innerHeight&&r.right>0&&r.left<w.innerWidth) vis.push(el); }
    if(!vis.length){ hintMode=false; return; }
    var labs=labels(vis.length);
    for(i=0;i<vis.length;i++){ var e2=vis[i], rr=e2.getBoundingClientRect(), tip=d.createElement('div'); tip.textContent=labs[i];
      tip.style.cssText='position:fixed;z-index:2147483647;left:'+Math.max(1,rr.left)+'px;top:'+Math.max(1,rr.top)+'px;background:#fde047;color:#1e293b;font:bold 11px ui-monospace,Menlo,monospace;padding:1px 4px;border:1px solid #a16207;border-radius:3px;box-shadow:0 1px 2px rgba(0,0,0,.3);text-transform:uppercase;pointer-events:none;line-height:1.3;';
      d.body.appendChild(tip); hints.push({el:e2, tip:tip, label:labs[i]}); }
  }
  function matchHints(){ var exact=null, pre=0;
    for(var i=0;i<hints.length;i++){ var h=hints[i], ok=h.label.indexOf(hintBuf)===0; h.tip.style.opacity=ok?'1':'0.2'; if(ok) pre++; if(h.label===hintBuf) exact=h; }
    if(exact){ var el=exact.el, nt=hintNew; clearHints(); if(nt&&el.href){ w.open(el.href,'_blank'); } else { try{el.focus();}catch(e){} if(el.click) el.click(); } return; }
    if(pre===0) clearHints();
  }
  d.addEventListener('keydown', function(e){
    if(e.metaKey||e.ctrlKey||e.altKey) return;
    var t=(e.composedPath&&e.composedPath()[0])||e.target;
    if(hintMode){ e.preventDefault();
      if(e.key==='Escape') clearHints();
      else if(e.key==='Backspace'){ hintBuf=hintBuf.slice(0,-1); matchHints(); }
      else if(/^[a-z]$/i.test(e.key)){ hintBuf+=e.key.toLowerCase(); matchHints(); }
      return; }
    if(typing(t)) return;
    var k=e.key, se=d.scrollingElement||d.documentElement, H=w.innerHeight;
    if(k==='j'){ e.preventDefault(); w.scrollBy(0,90); }
    else if(k==='k'){ e.preventDefault(); w.scrollBy(0,-90); }
    else if(k==='d'){ e.preventDefault(); w.scrollBy(0,H/2); }
    else if(k==='u'){ e.preventDefault(); w.scrollBy(0,-H/2); }
    else if(k==='h'){ e.preventDefault(); w.scrollBy(-90,0); }
    else if(k==='l'){ e.preventDefault(); w.scrollBy(90,0); }
    else if(k==='G'){ e.preventDefault(); w.scrollTo(0,se.scrollHeight); lastG=0; }
    else if(k==='g'){ e.preventDefault(); var n=Date.now(); if(n-lastG<500){ w.scrollTo(0,0); lastG=0; } else lastG=n; }
    else if(k==='f'){ e.preventDefault(); showHints(false); }
    else if(k==='F'){ e.preventDefault(); showHints(true); }
    else if(k==='J'||k===']'){ e.preventDefault(); send('next'); }
    else if(k==='K'||k==='['){ e.preventDefault(); send('prev'); }
    else if(k==='/'){ e.preventDefault(); send('search'); }
    else if(k===';'||k==='y'){ e.preventDefault(); send('copy'); }
    else if(k==='o'){ e.preventDefault(); send('open'); }
    else if(k==='r'){ e.preventDefault(); send('reload'); }
    else if(k==='Escape') send('blur');
    else if(/^[1-9]$/.test(k)){ e.preventDefault(); send('tab:'+k); }
  }, true);
  w.addEventListener('scroll', function(){ if(hintMode) clearHints(); }, {passive:true});
})();</script>`;

function injectReportShortcuts(html: string): string {
  if (html.includes("__diffshubReportKeys")) return html;
  const i = html.toLowerCase().lastIndexOf("</body>");
  return i === -1 ? html + REPORT_SHORTCUTS_JS : html.slice(0, i) + REPORT_SHORTCUTS_JS + html.slice(i);
}

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
  .then((ws) => indexFiles(ws.id, ws.repos, ws.isWorkspace).catch(() => { }))
  .catch(() => { });

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

// Known terminal (TUI) editors. Spawned headless by the server they have no
// controlling terminal, so editorArgv launches them inside a fresh terminal
// window instead of letting them render nowhere.
const TERMINAL_EDITOR_RE =
  /^(vim|nvim|vi|view|nano|micro|emacs|emacsclient|kak|hx|helix)$/;

// Resolve the user's editor ($EDITOR, then $VISUAL, default zed) and build an
// argv that jumps to a line for the editors that understand it. $EDITOR wins
// over $VISUAL on purpose: $VISUAL is often a GUI editor (here `zed`), but
// "open in editor" should follow the terminal editor you actually live in.
function editorTokens(): string[] {
  const raw = (process.env.EDITOR || process.env.VISUAL || "nvim").trim();
  return raw ? raw.split(/\s+/) : ["nvim"];
}
function editorName(): string {
  const bin = editorTokens()[0];
  return bin.split("/").pop() || bin;
}
function editorArgv(fileAbs: string, line: number | null, cwd?: string): string[] {
  const tokens = editorTokens();
  const name = editorName();
  let argv: string[];
  if (line == null) {
    argv = [...tokens, fileAbs];
  } else if (/^(code|codium|code-insiders|vscodium|cursor|windsurf)$/.test(name)) {
    argv = [...tokens, "--goto", `${fileAbs}:${line}`];
  } else if (TERMINAL_EDITOR_RE.test(name)) {
    argv = [...tokens, `+${line}`, fileAbs];
  } else {
    // zed, subl, JetBrains and unknown GUI editors take a `path:line` argument
    argv = [...tokens, `${fileAbs}:${line}`];
  }
  // A TUI editor spawned headless renders nowhere, so open it in a new ghostty
  // window. ghostty runs everything after `-e` as the command, so window
  // options (--working-directory) must precede it.
  if (TERMINAL_EDITOR_RE.test(name)) {
    const win = ["open", "-na", "Ghostty", "--args"];
    if (cwd) win.push(`--working-directory=${cwd}`);
    return [...win, "-e", ...argv];
  }
  return argv;
}

// nvim opens inside a dedicated tmux session ("edit") on the default socket —
// the same socket your interactive sessions live on — rather than a standalone
// Ghostty window. macOS can't add a window to the running Ghostty from the CLI,
// so a standalone window is always a *separate* Ghostty process that Cmd+` can't
// reach; routing through tmux instead means the editor is reachable with your
// normal tmux keys and never triggers Ghostty's "-e" allow-prompt (we don't use
// `open -e` at all). nvim keeps a --listen server so repeated opens land as new
// TABS in the one session via --remote-tab.
const NVIM_TMUX_SOCK = "/tmp/diffshub-nvim.sock";
const NVIM_TMUX_SESSION = "edit";
// Is something actually listening on the socket? A stale socket FILE survives an
// nvim crash/quit, and `nvim --remote-tab` to a dead socket silently falls back
// to opening a foreground editor (which would hang our spawn), so we must probe
// a real connection before deciding the server is reusable.
async function nvimAlive(sock: string): Promise<boolean> {
  if (!existsSync(sock)) return false;
  try {
    const s = await Bun.connect({ unix: sock, socket: { data() {}, error() {} } });
    s.end();
    return true;
  } catch {
    return false;
  }
}
// Pull every attached client on the default socket over to `session` so pressing
// shift+v actually brings the editor to the foreground. No-op if nothing's
// attached (the session still exists to attach to later).
async function focusTmuxSession(session: string): Promise<void> {
  let clients: string[] = [];
  try {
    clients = (await $`tmux -L default list-clients -F ${"#{client_tty}"}`.quiet().text())
      .split("\n").map((s) => s.trim()).filter(Boolean);
  } catch { }
  await Promise.all(
    clients.map((tty) =>
      $`tmux -L default switch-client -c ${tty} -t ${session}`.quiet().catch(() => { })),
  );
}
const NVIM_SPAWN = { stdin: "ignore", stdout: "ignore", stderr: "ignore" } as const;
// Open fileAbs in the user's editor, jumping to `line`. nvim goes into the shared
// "edit" tmux session (new tab if it's already running); every other editor falls
// back to editorArgv's one-window-per-open behavior.
async function launchEditor(fileAbs: string, line: number | null, dir: string): Promise<void> {
  if (editorName() !== "nvim") {
    Bun.spawn(editorArgv(fileAbs, line, dir), { cwd: dir, ...NVIM_SPAWN });
    return;
  }
  const tokens = editorTokens(); // honor EDITOR="nvim -u …"
  const nvimBin = tokens[0];
  if (await nvimAlive(NVIM_TMUX_SOCK)) {
    // Live server: drop the file in a new tab, then move the cursor. Two steps
    // because `--remote-tab +<line>` would treat the `+<line>` as a filename.
    await Bun.spawn([nvimBin, "--server", NVIM_TMUX_SOCK, "--remote-tab", fileAbs], NVIM_SPAWN).exited;
    if (line != null)
      await Bun.spawn([nvimBin, "--server", NVIM_TMUX_SOCK, "--remote-expr", `cursor(${line},1)`], NVIM_SPAWN).exited;
  } else {
    // No live server: clear any dead session/socket, then start nvim --listen in
    // a fresh detached "edit" session so the NEXT open reuses it as a tab.
    await $`tmux -L default kill-session -t ${NVIM_TMUX_SESSION}`.quiet().catch(() => { });
    try { if (existsSync(NVIM_TMUX_SOCK)) unlinkSync(NVIM_TMUX_SOCK); } catch { }
    const cmd = [...tokens, "--listen", NVIM_TMUX_SOCK];
    if (line != null) cmd.push(`+${line}`);
    cmd.push(fileAbs);
    // Single shell-string command (mirrors newClaudeSession) so tmux runs it via
    // sh; shq keeps `$`/spaces in the path literal (e.g. demos.$id.tsx).
    const nvimCmd = cmd.map(shq).join(" ");
    await $`tmux -L default new-session -ds ${NVIM_TMUX_SESSION} -c ${dir} ${nvimCmd}`.quiet();
  }
  await focusTmuxSession(NVIM_TMUX_SESSION);
}

// ---- New session (mirrors the `p` shell function) ----
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
  } catch { }
  const existing = new Set(sessions);
  const usedLetters = new Set<string>();
  await Promise.all(
    sessions.map(async (s) => {
      try {
        const cmd = (
          await $`tmux -L default display-message -p -t ${`${s}:0.0`} ${"#{pane_current_command}"}`.quiet().text()
        ).trim();
        if (/claude|node|codex/.test(cmd) || /^[0-9]+\.[0-9]+/.test(cmd)) usedLetters.add(s[0]);
      } catch { }
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

// ---- Structured pending-prompt parsing ----
// capturePendingPrompt returns the raw TUI text of a selection prompt claude is
// blocked on. For the web UI we want real controls (checkboxes / buttons) instead
// of asking the user to read ASCII and hand-type a digit, so we parse that text
// into options. The layout claude renders (verified against the 2.1.179 TUI):
//
//   ❯ 1. [ ] Label            ← multi-select option (checkbox); ❯ marks the cursor
//        description…          ← dim, indented, may wrap across lines
//     4. [✔] Type something    ← a ticked box renders [✔] (U+2714), not [x]
//          Submit
//     5. Chat about this        ← a "discuss instead" affordance, not an answer
//
// Single-select / plan-approval / permission prompts render the same numbered list
// WITHOUT the [ ]/[✔] checkboxes (a digit picks + submits). A final-submit screen
// shows "Ready to submit your answers?" with no options. We classify accordingly.
//
// Digit i maps straight to option i in claude's key handler, so the client never
// needs cursor tracking. For multi-select a bare Enter no longer submits (it
// toggles the focused row) — you press Tab to open the submit gate, then Enter.
export type PendingOption = {
  index: number; // 1-based, exactly the digit you'd press in the pane
  label: string;
  desc?: string;
  checked: boolean; // [x] vs [ ] — meaningful for multi-select only
  cursor: boolean; // the ❯-highlighted row
  freeText: boolean; // claude's appended "Type something" option (answer via reply box)
  preview?: string; // the option's boxed preview art (see detectBoxLeftCol / enrichSinglePreviews)
};
export type PendingPrompt = {
  kind: "multi" | "single" | "confirm";
  question: string; // prompt text shown above the options
  options: PendingOption[];
  multiQuestion: boolean; // one question of a multi-question AskUserQuestion (tab strip)
};

// A numbered option row: optional ❯ cursor, the index, an optional [ ]/[✔] box, label.
// The ticked box is U+2714 (✔) in claude's TUI — NOT the lighter U+2713 (✓); both are
// accepted here so a marker change can't silently leave a [✔] glyph stuck in the label.
const OPT_RE = /^(\s*)(❯|>)?\s*(\d+)\.\s+(\[([ xX✓✔·])\]\s+)?(.*\S)\s*$/u;
const FREE_TEXT_RE = /^(?:type something|type your own|something else|none of the above|chat about this)\b/iu;
// A multi-question AskUserQuestion renders a tab strip ("← ⊟ Scope ☐ State ✓ Submit →").
const TAB_BAR_RE = /[←→]|[⊟☐☑✓▢]\s+\S+\s+[⊟☐☑✓▢]/u;
const CONFIRM_RE = /ready to submit your answers|submit your answers\?/iu;

// When an AskUserQuestion option carries a `preview`, claude paints that art in a
// box to the RIGHT of the option list — but only for the *focused* option, and a
// single capture interleaves the box columns with the option columns. We detect the
// box, slice it off so labels parse clean (instead of smearing the art across every
// label/description), and hand the art back as the focused option's preview.
const BOX_TOP_RE = /[┌╭][─━]{2,}/u; // a boxed top border: a corner immediately followed by a rule
const BOX_BORDER_CH = /[│┃┌┐└┘├┤┬┴┼╭╮╰╯─━]/u;
// The preview box sits well to the right of the options; ignore any corner closer
// than this so claude's full-width prompt rules (col 0, no corner) and short labels
// can't be mistaken for it.
const MIN_BOX_COL = 12;

// Column where the preview box's left edge starts, or null if there's no box. Keyed
// on the top border (┌/╭ immediately followed by a ─ run) so the diagram's own inner
// tree glyphs (┌ pass / └ fail — followed by text, not a rule) can't trigger a split.
function detectBoxLeftCol(lines: string[]): number | null {
  let best: number | null = null;
  for (const l of lines) {
    const idx = l.search(/[┌╭]/u);
    if (idx < MIN_BOX_COL) continue;
    if (!BOX_TOP_RE.test(l.slice(idx))) continue;
    if (best == null || idx < best) best = idx;
  }
  return best;
}

// True if column `bx` of `l` holds a box border char — i.e. this row is part of the
// preview box (vs. a full-width question line that merely runs past `bx`).
function isBoxRow(l: string, bx: number): boolean {
  return bx < l.length && BOX_BORDER_CH.test(l[bx]);
}

// Pull the boxed preview (columns at/after `bx`, box rows only) out as plain text:
// drop the frame borders and the now-empty border rows, then dedent by the common
// indent so the diagram keeps its relative alignment.
function extractPreviewAt(lines: string[], bx: number): string {
  const segs = lines.map((l) => {
    if (!isBoxRow(l, bx)) return "";
    let seg = l.slice(bx);
    seg = seg.replace(/^[│┃┌└├╭╰]/u, ""); // drop the left border char
    seg = seg.replace(/[\s│┃┌┐└┘├┤┬┴┼╭╮╰╯─━]+$/u, ""); // drop trailing border + ws (kills border-only rows)
    return seg.replace(/\s+$/u, "");
  });
  while (segs.length && !segs[0].trim()) segs.shift();
  while (segs.length && !segs[segs.length - 1].trim()) segs.pop();
  if (!segs.length) return "";
  const indent = Math.min(...segs.filter((s) => s.trim()).map((s) => (s.match(/^ */u)?.[0].length ?? 0)));
  return segs
    .map((s) => s.slice(indent))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n");
}

function parsePendingPrompt(pane: string | null): PendingPrompt | null {
  if (!pane) return null;
  // Strip any box-drawing side borders so the option regex anchors cleanly.
  const lines = pane.split("\n").map((l) => l.replace(/^\s*[│┃]\s?/u, "").replace(/\s*[│┃]\s*$/u, ""));
  const multiQuestion = lines.some((l) => TAB_BAR_RE.test(l));

  // Split a side preview box off the option columns (only on the box's own rows, so
  // the full-width question above it is left intact), and lift its art separately.
  const bx = detectBoxLeftCol(lines);
  const optLines = bx == null ? lines : lines.map((l) => (isBoxRow(l, bx) ? l.slice(0, bx) : l));
  const focusedPreview = bx == null ? "" : extractPreviewAt(lines, bx);

  type Row = { opt: PendingOption; hasBox: boolean; descLines: string[] };
  const rows: Row[] = [];
  const preamble: string[] = [];
  let expecting = 1;
  let last: Row | null = null;

  for (const line of optLines) {
    const m = OPT_RE.exec(line);
    // Accept only sequential indices (1,2,3,…) so a number inside a description
    // ("the existing isUnread state") can't masquerade as a new option.
    if (m && Number(m[3]) === expecting) {
      const label = m[6].trim();
      last = {
        opt: {
          index: expecting,
          label,
          checked: m[5] != null && /[xX✓✔·]/u.test(m[5]),
          cursor: !!m[2],
          freeText: FREE_TEXT_RE.test(label),
        },
        hasBox: m[4] != null,
        descLines: [],
      };
      rows.push(last);
      expecting++;
      continue;
    }
    const t = line.trim();
    if (last) {
      // Continuation: a dim description line. Skip the chrome that trails the option
      // list (the "Submit" affordance, a horizontal rule, the notes hint, the nav
      // footer) so it doesn't get glued onto the last option's description.
      const chrome =
        /^submit$/iu.test(t) ||
        /^[─━]{3,}$/u.test(t) ||
        /press .* to add notes|^notes:/iu.test(t) ||
        PROMPT_FOOTER.test(t);
      if (t && !chrome) last.descLines.push(t);
    } else if (t) {
      preamble.push(t);
    }
  }

  const question = preamble.filter((l) => !TAB_BAR_RE.test(l)).join(" ").trim();
  if (rows.length === 0) {
    return lines.some((l) => CONFIRM_RE.test(l))
      ? { kind: "confirm", question, options: [], multiQuestion }
      : null;
  }
  const anyBox = rows.some((r) => r.hasBox);
  // The captured frame paints only the focused option's preview; attach it there
  // (enrichSinglePreviews fills the rest by walking the other options).
  const focusedRow = rows.find((r) => r.opt.cursor) ?? rows[0];
  const options = rows.map((r) => {
    const desc = r.descLines.join(" ").trim();
    const opt: PendingOption = desc ? { ...r.opt, desc } : { ...r.opt };
    if (r === focusedRow && focusedPreview) opt.preview = focusedPreview;
    return opt;
  });
  return { kind: anyBox ? "multi" : "single", question, options, multiQuestion };
}

// How long to let the TUI register individual keystrokes (option toggles, Enter)
// sent one at a time — shorter than a paste settle since these aren't bracketed.
const KEY_SETTLE_MS = 60;
// Longer pause before re-capturing the pane to read back the result of keystrokes —
// the TUI repaint lags the input, so a too-short wait reads the pre-toggle frame.
const VERIFY_SETTLE_MS = 200;

// Send a sequence of tmux key names (e.g. "1", "3", "Enter") into a pane, pausing
// between each so claude's input handler processes them as distinct keypresses.
async function sendKeySeq(name: string, keys: string[]): Promise<void> {
  for (const key of keys) {
    await $`tmux -L default send-keys -t ${`${name}:0.0`} ${key}`.quiet();
    await Bun.sleep(KEY_SETTLE_MS);
  }
}

// ---- Per-option preview capture ----
// A single pane capture paints only the *focused* option's preview box. To show
// every option's art in the web UI we briefly drive the TUI — focus each option in
// turn (Up/Down only; never a digit, which would submit) and capture its preview,
// then restore the original focus. This perturbs the user's live terminal, so we run
// it at most once per distinct prompt and cache the result; later polls reuse the
// cache and never touch the pane. Keyed by session, invalidated when the prompt's
// question/labels change (a new question of a multi-question ask, or a new prompt).
type PreviewCache = { sig: string; previews: Map<number, string> };
const previewCacheBySession = new Map<string, PreviewCache>();
const enrichingSessions = new Set<string>();

function promptSignature(p: PendingPrompt): string {
  return `${p.question} ${p.options.map((o) => o.label).join(" ")}`;
}

// Step the TUI cursor onto `target` (1-based option index) by reading the live cursor
// and pressing Up/Down toward it — robust to list wrapping and interleaved non-answer
// rows. Returns the parsed prompt once focused, or null if it can't land.
async function focusOption(name: string, target: number, maxSteps: number): Promise<PendingPrompt | null> {
  for (let step = 0; step < maxSteps; step++) {
    const p = parsePendingPrompt(await capturePendingPrompt(name));
    if (!p) return null;
    const cur = p.options.find((o) => o.cursor)?.index;
    if (cur == null) return null;
    if (cur === target) return p;
    await sendKeySeq(name, [cur < target ? "Down" : "Up"]);
    await Bun.sleep(VERIFY_SETTLE_MS);
  }
  return null;
}

// Walk every real (non-free-text) option, capturing each one's preview box, then
// return focus to where it started. Returns index → preview-text.
async function captureAllPreviews(name: string, prompt: PendingPrompt): Promise<Map<number, string>> {
  const real = prompt.options.filter((o) => !o.freeText);
  const startFocus = prompt.options.find((o) => o.cursor)?.index ?? real[0]?.index ?? 1;
  const maxSteps = prompt.options.length * 2 + 4;
  const out = new Map<number, string>();
  for (const o of real) {
    const focused = await focusOption(name, o.index, maxSteps);
    if (!focused) continue;
    await Bun.sleep(VERIFY_SETTLE_MS); // let the preview pane repaint for the new focus
    const reread = parsePendingPrompt(await capturePendingPrompt(name));
    const cur = reread?.options.find((x) => x.cursor);
    if (cur?.preview) out.set(o.index, cur.preview);
  }
  await focusOption(name, startFocus, maxSteps); // leave the pane as we found it
  return out;
}

function applyPreviews(prompt: PendingPrompt, previews: Map<number, string>): PendingPrompt {
  if (!previews.size) return prompt;
  return {
    ...prompt,
    options: prompt.options.map((o) => (previews.has(o.index) ? { ...o, preview: previews.get(o.index) } : o)),
  };
}

// Fill in every option's preview for a single-select prompt that has preview art,
// via the once-per-prompt cache. No-ops (returns the prompt unchanged) for prompts
// without a preview box, while a capture is already in flight, or on any tmux error.
async function enrichSinglePreviews(name: string, prompt: PendingPrompt): Promise<PendingPrompt> {
  if (prompt.kind !== "single") return prompt;
  const sig = promptSignature(prompt);
  const cached = previewCacheBySession.get(name);
  if (cached && cached.sig === sig) return applyPreviews(prompt, cached.previews);
  // Nothing to capture if claude rendered no preview art for this prompt.
  if (!prompt.options.some((o) => o.preview)) {
    previewCacheBySession.set(name, { sig, previews: new Map() });
    return prompt;
  }
  if (enrichingSessions.has(name)) return prompt; // a capture is already running; use focused-only for now
  enrichingSessions.add(name);
  try {
    const previews = await captureAllPreviews(name, prompt);
    previewCacheBySession.set(name, { sig, previews });
    return applyPreviews(prompt, previews);
  } catch {
    return prompt;
  } finally {
    enrichingSessions.delete(name);
  }
}

// Answer a live multi-select AskUserQuestion by reproducing the selection the user
// built in the web UI. `selected` is the set of 1-based option indices that should
// end up checked. We capture the pane, toggle only the options whose state differs
// (digit i toggles option i), re-capture to CONFIRM the checkbox pattern matches
// before committing — so a wrong protocol assumption can never submit a bad answer
// — then press Tab to open claude's "Ready to submit your answers?" gate and Enter
// to commit it. (A bare Enter would just toggle the focused row, not submit.)
// Returns {ok:false} without submitting if verification fails.
async function answerMultiSelect(name: string, selected: number[]): Promise<{ ok: boolean; error?: string }> {
  const parsed = parsePendingPrompt(await capturePendingPrompt(name));
  if (!parsed || parsed.kind !== "multi") return { ok: false, error: "no multi-select prompt is waiting" };
  const want = new Set(selected);
  const real = parsed.options.filter((o) => !o.freeText);
  const toggles = real.filter((o) => want.has(o.index) !== o.checked).map((o) => String(o.index));
  if (toggles.length) await sendKeySeq(name, toggles);

  // Verify: re-read the pane and check every real option matches the desired state.
  // Wait a render frame or two first — keystrokes are processed immediately but the
  // TUI repaint (the [x] we're about to read back) lags the input.
  await Bun.sleep(VERIFY_SETTLE_MS);
  const after = parsePendingPrompt(await capturePendingPrompt(name));
  if (!after || after.kind !== "multi") return { ok: false, error: "prompt changed while answering" };
  const ok = after.options
    .filter((o) => !o.freeText)
    .every((o) => o.checked === want.has(o.index));
  if (!ok) return { ok: false, error: "could not confirm the selection in the pane" };

  // Tab opens claude's "Review your answers / Ready to submit your answers?" screen
  // (cursor defaulting to "Submit answers"); Enter there commits. A bare Enter here
  // would instead toggle whichever option the cursor sits on. For a multi-question
  // prompt Tab lands on the next question instead of the gate — we leave this
  // question's picks recorded and let the web UI render the next one rather than
  // forcing a submit.
  await sendKeySeq(name, ["Tab"]);
  await Bun.sleep(VERIFY_SETTLE_MS);
  const gate = await capturePendingPrompt(name);
  if (gate && CONFIRM_RE.test(gate)) await sendKeySeq(name, ["Enter"]);
  return { ok: true };
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
// Reasoning effort levels accepted by each CLI. Anything outside these sets is
// dropped so the session inherits that tool's global default.
const CLAUDE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const CODEX_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

async function newClaudeSession(
  dir: string,
  prompt: string,
  effort?: string,
  chrome?: boolean,
): Promise<string> {
  const name = await pickClaudeSessionName();
  const sid = crypto.randomUUID();
  const promptArg = prompt.trim() ? ` ${shq(prompt)}` : "";
  // effort is validated against CLAUDE_EFFORTS before it reaches here, so it's a
  // plain word — safe unquoted in the command.
  const effortArg = effort && CLAUDE_EFFORTS.has(effort) ? ` --effort ${effort}` : "";
  // --chrome enables the Claude-in-Chrome integration for this session.
  const chromeArg = chrome ? " --chrome" : "";
  const claudeCmd = `CLAUDE_CODE_NO_FLICKER=1 direnv exec ${shq(dir)} claude --session-id ${sid}${effortArg}${chromeArg}${promptArg}`;
  await $`tmux -L default new-session -ds ${name} -c ${dir} ${claudeCmd}`.quiet();
  await $`tmux -L default set-option -t ${name} @claude_session ${sid}`.quiet().catch(() => { });
  return name;
}

// Resume a closed claude session by id, mirroring newClaudeSession: a detached
// tmux session running `claude --resume <sid>` in the directory, re-stamped with
// @claude_session so the Tmux tab maps it straight back to its transcript. We omit
// --fork-session, so claude reuses the same session id and appends to the existing
// <sid>.jsonl rather than starting a fresh transcript.
async function resumeClaudeSession(dir: string, sid: string): Promise<string> {
  const name = await pickClaudeSessionName();
  const claudeCmd = `CLAUDE_CODE_NO_FLICKER=1 direnv exec ${shq(dir)} claude --resume ${sid}`;
  await $`tmux -L default new-session -ds ${name} -c ${dir} ${claudeCmd}`.quiet();
  await $`tmux -L default set-option -t ${name} @claude_session ${sid}`.quiet().catch(() => { });
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
    agent: (row.agent ?? "claude") as "claude" | "codex",
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
      if (row.agent === "codex") await newCodexSession(dir.path, row.prompt, row.effort ?? undefined);
      else await newClaudeSession(dir.path, row.prompt, row.effort ?? undefined, row.chrome === 1);
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

// ---- Codex sessions <-> ~/.codex rollouts ----
// codex mints its OWN session uuid and writes the transcript ("rollout") to
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
// (the uuid is also in the file's first `session_meta` line). codex.zsh stamps that
// uuid onto the tmux session as @codex_session — the analogue of @claude_session.
// Unlike claude's sid-addressable path, the rollout is date-bucketed, so we glob the
// tree to find it (cached: the file is append-only, so its path never moves).
const codexSessionsRoot = `${process.env.HOME}/.codex/sessions`;
const rolloutPathCache = new Map<string, string>();

// Find a rollout by its session uuid (date-bucketed → glob the tree, first match).
function findRolloutByUuid(uuid: string): string | null {
  if (!/^[0-9a-fA-F-]{8,}$/.test(uuid)) return null;
  const cached = rolloutPathCache.get(uuid);
  if (cached && existsSync(cached)) return cached;
  try {
    const glob = new Bun.Glob(`**/rollout-*-${uuid}.jsonl`);
    for (const rel of glob.scanSync(codexSessionsRoot)) {
      const full = `${codexSessionsRoot}/${rel}`;
      rolloutPathCache.set(uuid, full);
      return full;
    }
  } catch { }
  return null;
}

// The cwd a rollout was recorded in (its session_meta, line 1). Only the file head
// is read. Used to resolve untagged codex sessions by directory.
async function rolloutCwd(path: string): Promise<string> {
  try {
    const head = await Bun.file(path).slice(0, 8192).text();
    const line1 = head.split("\n", 1)[0] ?? "";
    const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(line1);
    return m ? (JSON.parse(`"${m[1]}"`) as string) : "";
  } catch {
    return "";
  }
}

// Resolve a codex tmux session to its rollout: by @codex_session uuid when tagged,
// else the newest rollout recorded in this cwd (covers the brief window before the
// tag lands, and codex sessions started outside codex.zsh). The cwd scan is bounded
// to the most recent rollouts so the sidebar poll stays cheap.
async function resolveCodexTranscript(cwd: string, uuid: string): Promise<string | null> {
  if (uuid) return findRolloutByUuid(uuid); // null until codex writes the first turn
  if (!cwd) return null;
  const recent: { path: string; mtime: number }[] = [];
  try {
    const glob = new Bun.Glob("**/rollout-*.jsonl");
    for (const rel of glob.scanSync(codexSessionsRoot)) {
      const p = `${codexSessionsRoot}/${rel}`;
      try {
        recent.push({ path: p, mtime: statSync(p).mtimeMs });
      } catch { }
    }
  } catch {
    return null;
  }
  recent.sort((a, b) => b.mtime - a.mtime);
  for (const r of recent.slice(0, 60)) {
    if ((await rolloutCwd(r.path)) === cwd) return r.path;
  }
  return null;
}

// Which agent (if any) a tmux session is running, from its pane command + tags.
// claude's pane command is "claude", "node", or a version string (e.g. 2.1.177);
// codex's is "codex". The @codex_session tag is a secondary signal (e.g. while codex
// is still booting and the command hasn't settled).
function agentOf(cmd: string, codexSid: string): "claude" | "codex" | null {
  if (/codex/.test(cmd) || codexSid) return "codex";
  if (/claude|node/.test(cmd) || /^[0-9]+\.[0-9]+/.test(cmd)) return "claude";
  return null;
}

// Every rollout uuid that exists right now (a launch snapshot). codex only writes a
// rollout once its first turn starts, so the new session is the uuid absent here.
function codexRolloutUuids(): Set<string> {
  const out = new Set<string>();
  try {
    const glob = new Bun.Glob("**/rollout-*.jsonl");
    for (const rel of glob.scanSync(codexSessionsRoot)) {
      const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(rel);
      if (m) out.add(m[1]);
    }
  } catch { }
  return out;
}

// Discover the rollout a freshly-launched codex session wrote and stamp its uuid onto
// the tmux session as @codex_session — the server-side port of codex.zsh's _cx_tag.
// codex mints its own uuid (no --session-id) and only writes the rollout once the
// first turn starts, so we poll: the new rollout is the one absent from `before`
// whose session_meta cwd is ours and that no other live session has already claimed.
async function tagCodexSession(name: string, cwd: string, before: Set<string>): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const claimed = new Set<string>();
    try {
      const raw = await $`tmux -L default list-sessions -F ${"#{@codex_session}"}`.quiet().text();
      for (const u of raw.split("\n")) if (u.trim()) claimed.add(u.trim());
    } catch { }
    const fresh: { uuid: string; path: string; mtime: number }[] = [];
    try {
      const glob = new Bun.Glob("**/rollout-*.jsonl");
      for (const rel of glob.scanSync(codexSessionsRoot)) {
        const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(rel);
        if (!m || before.has(m[1]) || claimed.has(m[1])) continue;
        const path = `${codexSessionsRoot}/${rel}`;
        try { fresh.push({ uuid: m[1], path, mtime: statSync(path).mtimeMs }); } catch { }
      }
    } catch { }
    fresh.sort((a, b) => b.mtime - a.mtime); // newest first wins a same-cwd race
    for (const f of fresh) {
      if ((await rolloutCwd(f.path)) === cwd) {
        await $`tmux -L default set-option -t ${name} @codex_session ${f.uuid}`.quiet().catch(() => { });
        return;
      }
    }
    // Give up if the session closed before ever writing a rollout (never prompted).
    const alive = await $`tmux -L default has-session -t ${name}`.quiet().then(() => true).catch(() => false);
    if (!alive) return;
    await Bun.sleep(i < 20 ? 250 : 1000);
  }
}

// Launch codex from diffshub — the server-side twin of codex.zsh's `xe`. Detached and
// autonomous (approvals + sandbox bypassed, since nobody is attached to approve), with
// the prompt as codex's positional arg so codex submits it itself on boot (the same
// zero-timing trick newClaudeSession uses — a send-keys Enter would race codex's paste
// debounce). The @codex_session tag is discovered + stamped asynchronously.
async function newCodexSession(dir: string, prompt: string, effort?: string): Promise<string> {
  const name = await pickClaudeSessionName();
  const before = codexRolloutUuids();
  const promptArg = prompt.trim() ? ` ${shq(prompt)}` : "";
  const effortArg =
    effort && CODEX_EFFORTS.has(effort)
      ? ` -c ${shq(`model_reasoning_effort="${effort}"`)}`
      : "";
  const codexCmd = `direnv exec ${shq(dir)} codex --dangerously-bypass-approvals-and-sandbox${effortArg}${promptArg}`;
  await $`tmux -L default new-session -ds ${name} -c ${dir} ${codexCmd}`.quiet();
  void tagCodexSession(name, dir, before);
  return name;
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
      } catch { }
    }
    return title;
  } catch {
    return "";
  }
}

// The first human prompt in a transcript — the resume dialog's fallback label for
// a session claude never titled (it only writes an ai-title after a few turns). We
// only read the head: the opening user message is always near the top.
async function headFirstPrompt(path: string): Promise<string> {
  try {
    const text = await Bun.file(path).slice(0, 65536).text();
    for (const line of text.split("\n")) {
      if (!line.includes('"user"')) continue;
      let d: any;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      if (d?.type !== "user") continue;
      const c = d?.message?.content;
      let s = "";
      if (typeof c === "string") s = c;
      else if (Array.isArray(c)) s = c.filter((p) => p?.type === "text").map((p) => p.text).join(" ");
      s = s.replace(/\s+/g, " ").trim();
      // Skip meta turns (tool results, slash-command/system-reminder wrappers in
      // <…> tags) that aren't a real first prompt; keep scanning for one that is.
      if (s && !s.startsWith("<")) return s.slice(0, 140);
    }
  } catch { }
  return "";
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
      } catch { }
      return { path, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)
    // Cap so a giant folder stays bounded; live sessions (incl. idle ones whose
    // files are older) need a wide enough net to title-match against.
    .slice(0, 400);
  return Promise.all(recent.map(async (c) => ({ ...c, aiTitle: await tailAiTitle(c.path) })));
}

interface ResumableSession {
  sid: string;
  title: string; // ai-title, falling back to the session's first human prompt
  mtime: number;
}

// The closed claude sessions in a cwd's project folder, newest first — every
// <sid>.jsonl that isn't currently open in a live tmux session — so the resume
// dialog can relaunch one via `claude --resume <sid>`. Title is the ai-title (read
// from the tail like the sidebar) or, when claude never wrote one, the first
// prompt. Capped: a resume picker doesn't need the whole history of a busy folder.
async function resumableSessions(cwd: string): Promise<ResumableSession[]> {
  // sids already attached to a running tmux session aren't "old" — skip them.
  const live = new Set<string>();
  try {
    const raw = await $`tmux -L default list-sessions -F ${"#{@claude_session}"}`.quiet().text();
    for (const s of raw.split("\n")) if (s.trim()) live.add(s.trim());
  } catch { }
  const dir = `${claudeProjectsRoot}/${mungeDir(cwd)}`;
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const recent = files
    .map((f) => {
      const sid = f.replace(/\.jsonl$/, "");
      let mtime = 0;
      try {
        mtime = statSync(`${dir}/${f}`).mtimeMs;
      } catch { }
      return { sid, path: `${dir}/${f}`, mtime };
    })
    .filter((c) => /^[0-9a-fA-F-]{8,}$/.test(c.sid) && !live.has(c.sid))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 100);
  return Promise.all(
    recent.map(async (c) => ({
      sid: c.sid,
      mtime: c.mtime,
      title: (await tailAiTitle(c.path)) || (await headFirstPrompt(c.path)),
    })),
  );
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
  task: string; // what the agent is doing (cleaned pane title), "" if not meaningful
  busy: boolean; // agent is actively working (braille-spinner pane title)
  waiting: boolean; // idle but blocked on an interactive prompt in the live pane
  sessionId: string; // @claude_session / @codex_session if tagged, else ""
  hasTranscript: boolean;
  mtime: number; // transcript mtime (ms), 0 if none — last write, advances mid-turn
  endedAt: number; // when its Stop hook last fired (ms), 0 if never — see session_ends
  agent: "claude" | "codex"; // which CLI is running — drives transcript resolution + a badge
  transcriptPath?: string; // server-only: lets Subway snapshot exact resolved files
}

// The timestamp the session lists sort and label by: when a non-busy session last
// finished a turn (its Stop hook, recorded in session_ends), falling back to the
// transcript mtime when that's unrecorded. A busy session is mid-turn — its last
// recorded end is a stale prior turn — so it sorts on live mtime instead.
function finishedTs(s: TmuxSession): number {
  return s.busy ? s.mtime : s.endedAt || s.mtime;
}

// List tmux sessions on the default socket that are running claude, each resolved
// to its transcript. `pane_current_command` is claude's version string (e.g.
// "2.1.177") once it's running, so we match that, "claude", or "node".
async function listClaudeSessions(): Promise<TmuxSession[]> {
  const SEP = "\x1f";
  const fmt = ["#{session_name}", "#{pane_current_path}", "#{pane_current_command}", "#{pane_title}", "#{@claude_session}", "#{@codex_session}"].join(SEP);
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
    const [name, cwd, cmd, title, claudeSid, codexSid] = line.split(SEP);
    if (!name) continue;
    const agent = agentOf(cmd ?? "", codexSid ?? "");
    if (!agent) continue;
    // Pane title is the agent's status: a leading braille glyph (U+2800–U+28FF)
    // means it's actively working; "✳" (and other leading glyphs) mean idle. codex
    // uses the same braille spinner convention, so this works for both.
    const busy = /^[⠀-⣿]/u.test(title ?? "");
    let task = cleanTitle(title ?? "", name, cmd ?? "");
    let sid: string;
    let path: string | null;
    if (agent === "codex") {
      sid = codexSid ?? "";
      // codex's pane title is just the cwd basename (+ spinner), not a task summary,
      // so drop it when it's only the directory — the row already shows the cwd.
      if (task && task === (cwd ?? "").replace(/^.*\//, "")) task = "";
      path = await resolveCodexTranscript(cwd ?? "", sid);
    } else {
      sid = claudeSid ?? "";
      path = await resolveTranscript(cwd ?? "", sid, task, cache);
    }
    let mtime = 0;
    if (path) {
      try {
        mtime = statSync(path).mtimeMs;
      } catch { }
    }
    // The Stop hook records "finished a turn" keyed by session_id, which is the
    // transcript's basename UUID. Prefer that (authoritative); fall back to the tmux
    // @claude_session tag when no transcript resolved. 0 = never recorded (e.g. codex,
    // which doesn't run Claude hooks) — finishedTs then falls back to mtime.
    const uuid = path ? (path.split("/").pop() ?? "").replace(/\.jsonl$/, "") : sid;
    let endedAt = 0;
    if (uuid) endedAt = getSessionEndStmt.get(uuid)?.ended_at ?? 0;
    out.push({ name, cwd: cwd ?? "", task, busy, waiting: false, sessionId: sid, hasTranscript: !!path, mtime, endedAt, agent, transcriptPath: path ?? undefined });
  }
  // An idle session may actually be blocked on an interactive prompt (the same
  // case capturePendingPrompt handles for the open transcript). Flag those so the
  // sidebar can mark them "waiting for input" without opening each one. Only idle
  // sessions can be waiting — a busy pane is mid-turn — and we run the captures in
  // parallel so a handful of sessions don't serialize a poll. Detection reuses
  // capturePendingPrompt so the sidebar and transcript views never disagree.
  await Promise.all(
    out.map(async (s) => {
      // capturePendingPrompt parses claude's TUI prompt layout; codex's differs, so
      // we don't flag waiting for codex (it runs autonomously under xe anyway).
      if (s.agent === "claude" && !s.busy) s.waiting = !!(await capturePendingPrompt(s.name));
    }),
  );
  // Most recently finished first — see finishedTs (idle: Stop time; busy: live mtime).
  out.sort((a, b) => finishedTs(b) - finishedTs(a));
  return out;
}

interface TranscriptMsg {
  role: "user" | "assistant" | "tool";
  kind: "text" | "tool_use" | "tool_result" | "image";
  text: string;
  tool?: string; // tool name for tool_use
  ts?: string; // ISO timestamp
  path?: string; // file path for Edit/Write/MultiEdit/Read; sub-agent description for a Task/Agent result
  edits?: { old: string; new: string }[]; // hunks for Edit/Write/MultiEdit diff rendering
  lang?: string; // language id for a Read tool result's code block
  imgRef?: string; // "<lineIdx>:<imgOrdinal>" — locates an image block for /api/tmux/image
  mediaType?: string; // image media type (e.g. image/png) for an image message
  reasoning?: boolean; // a codex reasoning summary (agent_reasoning) — rendered dimmed
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
  if (name === "Task" || name === "Agent") return pick("description") || pick("subagent_type");
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
function parseTranscript(text: string, limit: number): { messages: TranscriptMsg[]; model: string; title: string; total: number } {
  const msgs: TranscriptMsg[] = [];
  let model = "";
  let title = "";
  // Remember each tool_use by id so its matching tool_result (which arrives in a
  // later user message) can be enriched — e.g. a Read result rendered as a code
  // block in the file's language.
  const toolById = new Map<string, { name: string; path: string; label?: string }>();
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
            } else if (src?.name === "Task" || src?.name === "Agent") {
              // A sub-agent's final report — typically a long, important
              // deliverable (a plan or an investigation summary). Carry it
              // through at length and tag it with the sub-agent name +
              // description so the client renders an expandable report block,
              // never trapping it in a tiny scroll box.
              msgs.push({
                role: "tool",
                kind: "tool_result",
                tool: src.name,
                path: src.label || undefined,
                text: trunc(t || "(tool result)", 16000),
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
            if (typeof b.id === "string")
              toolById.set(b.id, {
                name: b.name,
                path,
                // A sub-agent's description, kept so its result block can be
                // labelled with what it was asked to do (results come back in a
                // later message, detached from this tool_use card).
                label:
                  b.name === "Task" || b.name === "Agent"
                    ? summarizeToolInput(b.name, b.input)
                    : undefined,
              });
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
  // `total` is the full message count so the client can tell when older history
  // is still on disk above the returned window (drives the scroll-up paging).
  return { messages: msgs.slice(-limit), model, title, total: msgs.length };
}

// ---- Codex rollout parsing ----
// Concatenate the text of a codex message's content blocks (input_text / output_text
// / text — the OpenAI Responses item shape).
function codexText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const c of content) {
    if (c && typeof c === "object") {
      const b = c as any;
      out += b.text || b.input_text || b.output_text || "";
    }
  }
  return out;
}

// Map a codex function_call to (tool label, one-line summary, file path if any) — we
// reuse claude's tool vocabulary ("Bash") where it lines up so the client renders
// codex tool calls with the same cards.
function codexCall(name: unknown, argsJson: unknown): { tool: string; summary: string; path: string } {
  let args: any = {};
  if (typeof argsJson === "string") {
    try { args = JSON.parse(argsJson); } catch { }
  } else if (argsJson && typeof argsJson === "object") {
    args = argsJson;
  }
  if (name === "exec_command" || name === "shell_command" || name === "shell") {
    const cmd =
      typeof args.cmd === "string" ? args.cmd
        : typeof args.command === "string" ? args.command
          : Array.isArray(args.command) ? args.command.join(" ") : "";
    return { tool: "Bash", summary: cmd, path: "" };
  }
  if (name === "write_stdin") {
    const chars = typeof args.chars === "string" ? args.chars : "";
    return { tool: "write_stdin", summary: chars || "(enter)", path: "" };
  }
  if (name === "update_plan") {
    const plan = Array.isArray(args.plan) ? args.plan : [];
    const mark = (s: string) => (s === "completed" ? "✔" : s === "in_progress" ? "▶" : "○");
    const steps = plan.map((s: any) => `${mark(s?.status)} ${s?.step ?? ""}`).join("\n");
    const head = typeof args.explanation === "string" && args.explanation ? args.explanation + "\n" : "";
    return { tool: "update_plan", summary: head + steps, path: "" };
  }
  return { tool: typeof name === "string" ? name : "tool", summary: typeof argsJson === "string" ? argsJson : JSON.stringify(args), path: "" };
}

// Pull the human-readable part out of a codex tool output. exec_command wraps stdout
// in a header ("Command: …\n…\nOutput:\n<stdout>"); apply_patch outputs a JSON blob
// {"output":"…","metadata":{…}}. Show the stdout / message, not the wrapper.
function codexOutput(output: unknown): string {
  let s = typeof output === "string" ? output : output == null ? "" : JSON.stringify(output);
  if (s.startsWith("{")) {
    try {
      const j = JSON.parse(s);
      if (typeof j.output === "string") s = j.output;
    } catch { }
  }
  const i = s.indexOf("\nOutput:\n");
  if (i !== -1) s = s.slice(i + "\nOutput:\n".length);
  return s;
}

// Parse a codex apply_patch payload into per-file changes with diff hunks, shaped
// like claude's Edit/Write edits so the client's EditDiff renders them inline.
function parseApplyPatch(input: string): { tool: string; path: string; edits: { old: string; new: string }[] }[] {
  const files: { tool: string; path: string; edits: { old: string; new: string }[] }[] = [];
  let cur: { tool: string; path: string; edits: { old: string; new: string }[] } | null = null;
  let hunk: { old: string; new: string } | null = null;
  for (const raw of input.split("\n")) {
    let m: RegExpExecArray | null;
    if ((m = /^\*\*\* Add File: (.+)$/.exec(raw))) { cur = { tool: "Write", path: m[1], edits: [{ old: "", new: "" }] }; files.push(cur); hunk = null; continue; }
    if ((m = /^\*\*\* Update File: (.+)$/.exec(raw))) { cur = { tool: "Edit", path: m[1], edits: [] }; files.push(cur); hunk = null; continue; }
    if ((m = /^\*\*\* Delete File: (.+)$/.exec(raw))) { cur = { tool: "Delete", path: m[1], edits: [{ old: "", new: "" }] }; files.push(cur); hunk = null; continue; }
    if (/^\*\*\* (Begin|End) Patch/.test(raw)) continue;
    if (!cur) continue;
    if (cur.tool === "Write") {
      if (raw.startsWith("+")) cur.edits[0].new += raw.slice(1) + "\n";
      continue;
    }
    if (cur.tool === "Edit") {
      if (raw.startsWith("@@")) { hunk = { old: "", new: "" }; cur.edits.push(hunk); continue; }
      if (!hunk) { hunk = { old: "", new: "" }; cur.edits.push(hunk); }
      if (raw.startsWith("+")) hunk.new += raw.slice(1) + "\n";
      else if (raw.startsWith("-")) hunk.old += raw.slice(1) + "\n";
      else { const c = raw.startsWith(" ") ? raw.slice(1) : raw; hunk.old += c + "\n"; hunk.new += c + "\n"; }
    }
  }
  // Cap each hunk so a giant patch doesn't bloat the transcript payload (mirrors extractEdits).
  const cap = (s: string) => (s.length > 4000 ? s.slice(0, 4000) + "\n… (truncated)" : s);
  for (const f of files) f.edits = f.edits.map((e) => ({ old: cap(e.old), new: cap(e.new) }));
  return files;
}

// Parse a codex rollout into the SAME TranscriptMsg shape parseTranscript emits, so
// the client renders codex and claude chats with one code path. codex's schema is a
// stream of {type, payload} events; we pull:
//   - user turns from event_msg.user_message (the clean typed text — the response_item
//     user messages are AGENTS.md / environment-context injections + duplicates)
//   - assistant text from response_item.message(role=assistant)
//   - reasoning from event_msg.agent_reasoning (response_item.reasoning is encrypted)
//   - tool calls from response_item.function_call / custom_tool_call (+ their outputs)
// model comes from turn_context; codex writes no ai-title, so the title is the first
// user message.
function parseCodexTranscript(text: string, limit: number): { messages: TranscriptMsg[]; model: string; title: string; total: number } {
  const msgs: TranscriptMsg[] = [];
  let model = "";
  let title = "";
  const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "\n… (truncated)" : s);
  // call_id -> tool meta, so a *_output line can label its result with the tool/path.
  const toolById = new Map<string, { tool: string; path: string }>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    const p = d?.payload;
    if (!p || typeof p !== "object") continue;
    const ts = typeof d.timestamp === "string" ? d.timestamp : undefined;
    const type = d.type;

    if (type === "turn_context") {
      if (typeof p.model === "string" && p.model) model = p.model;
      continue;
    }
    if (type === "event_msg") {
      if (p.type === "user_message") {
        const txt = typeof p.message === "string" ? p.message : "";
        if (txt.trim()) {
          if (!title) title = txt.replace(/\s+/g, " ").trim().slice(0, 80);
          msgs.push({ role: "user", kind: "text", text: trunc(txt, 8000), ts });
        }
      } else if (p.type === "agent_reasoning") {
        const txt = typeof p.text === "string" ? p.text : "";
        if (txt.trim()) msgs.push({ role: "assistant", kind: "text", text: trunc(txt, 4000), reasoning: true, ts });
      }
      continue;
    }
    if (type !== "response_item") continue;
    const pt = p.type;
    if (pt === "message") {
      if (p.role !== "assistant") continue; // skip developer/user (injected context + dupes)
      const txt = codexText(p.content);
      if (txt.trim()) msgs.push({ role: "assistant", kind: "text", text: trunc(txt, 8000), ts });
    } else if (pt === "function_call") {
      const { tool, summary, path } = codexCall(p.name, p.arguments);
      if (typeof p.call_id === "string") toolById.set(p.call_id, { tool, path });
      msgs.push({ role: "assistant", kind: "tool_use", tool, text: trunc(summary, 2000), path: path || undefined, ts });
    } else if (pt === "custom_tool_call") {
      if (p.name === "apply_patch" && typeof p.input === "string") {
        const files = parseApplyPatch(p.input);
        if (files.length) {
          // one Edit/Write/Delete card per file the patch touches
          for (const f of files) msgs.push({ role: "assistant", kind: "tool_use", tool: f.tool, path: f.path, edits: f.edits, text: "", ts });
        } else {
          msgs.push({ role: "assistant", kind: "tool_use", tool: "apply_patch", text: trunc(p.input, 2000), ts });
        }
      } else {
        const input = typeof p.input === "string" ? p.input : JSON.stringify(p.input ?? "");
        msgs.push({ role: "assistant", kind: "tool_use", tool: typeof p.name === "string" ? p.name : "tool", text: trunc(input, 2000), ts });
      }
    } else if (pt === "function_call_output" || pt === "custom_tool_call_output") {
      const src = typeof p.call_id === "string" ? toolById.get(p.call_id) : undefined;
      const out = codexOutput(p.output);
      if (out.trim()) msgs.push({ role: "tool", kind: "tool_result", tool: src?.tool, path: src?.path || undefined, text: trunc(out, 2000), ts });
    } else if (pt === "web_search_call") {
      const a = (p.action && typeof p.action === "object" ? p.action : {}) as any;
      const summary = typeof a.query === "string" ? a.query : typeof a.url === "string" ? a.url : "";
      msgs.push({ role: "assistant", kind: "tool_use", tool: "WebSearch", text: trunc(summary, 500), ts });
    }
    // response_item.reasoning is encrypted — skipped; we show event_msg.agent_reasoning instead
  }
  return { messages: msgs.slice(-limit), model, title, total: msgs.length };
}

// ---- Subway tab snapshot ----
// One-shot offline cache for reviewing backlog on a train: only idle/waiting/done
// sessions in the selected directory, capped separately by agent so one tool cannot
// starve the other.
const SUBWAY_AGENT_LIMIT = 10;
const SUBWAY_MESSAGE_LIMIT = 16;
const SUBWAY_TEXT_LIMIT = 2200;

interface SubwaySessionSnapshot {
  name: string;
  cwd: string;
  task: string;
  waiting: boolean;
  sessionId: string;
  mtime: number;
  endedAt: number;
  agent: "claude" | "codex";
  title: string;
  model: string;
  total: number;
  messages: TranscriptMsg[];
}

function publicTmuxSession(s: TmuxSession): Omit<TmuxSession, "transcriptPath"> {
  const { transcriptPath: _transcriptPath, ...pub } = s;
  return pub;
}

function compactSubwayMessages(messages: TranscriptMsg[]): TranscriptMsg[] {
  return messages.map((m) => ({
    ...m,
    text:
      m.text.length > SUBWAY_TEXT_LIMIT
        ? `${m.text.slice(0, SUBWAY_TEXT_LIMIT)}\n... (truncated for Subway cache)`
        : m.text,
    edits: undefined,
  }));
}

function transcriptIdFromPath(path?: string): string {
  return path ? (path.split("/").pop() ?? "").replace(/\.jsonl$/, "") : "";
}

function subwayKeepIds(s: Pick<TmuxSession, "sessionId" | "name" | "transcriptPath">): string[] {
  return [transcriptIdFromPath(s.transcriptPath), s.sessionId, s.name].filter(Boolean);
}

async function subwaySessionSnapshot(s: TmuxSession): Promise<SubwaySessionSnapshot> {
  let title = "";
  let model = "";
  let total = 0;
  let messages: TranscriptMsg[] = [];
  const path = s.transcriptPath;
  if (path && existsSync(path)) {
    try {
      const parsed =
        s.agent === "codex"
          ? parseCodexTranscript(await Bun.file(path).text(), SUBWAY_MESSAGE_LIMIT)
          : parseTranscript(await Bun.file(path).text(), SUBWAY_MESSAGE_LIMIT);
      title = parsed.title;
      model = parsed.model;
      total = parsed.total;
      messages = compactSubwayMessages(parsed.messages);
    } catch { }
  }
  return {
    name: s.name,
    cwd: s.cwd,
    task: s.task,
    waiting: s.waiting,
    sessionId: s.sessionId,
    mtime: s.mtime,
    endedAt: s.endedAt,
    agent: s.agent,
    title,
    model,
    total,
    messages,
  };
}

async function subwaySnapshot(ws: Workspace) {
  const inScope = (dir: string) => dir === ws.path || dir.startsWith(`${ws.path}${sep}`);
  const kept = new Set(listSubwayKeptStmt.all(ws.id).map((r) => r.session_id));
  const idle = (await listClaudeSessions()).filter(
    (s) => !s.busy && inScope(s.cwd) && !subwayKeepIds(s).some((id) => kept.has(id)),
  );
  const picked = [
    ...idle.filter((s) => s.agent === "claude").slice(0, SUBWAY_AGENT_LIMIT),
    ...idle.filter((s) => s.agent === "codex").slice(0, SUBWAY_AGENT_LIMIT),
  ].sort((a, b) => finishedTs(b) - finishedTs(a));
  return {
    dir: ws.id,
    cwd: ws.path,
    fetchedAt: Date.now(),
    sessions: await Promise.all(picked.map(subwaySessionSnapshot)),
  };
}

interface UsageWindow {
  used_percentage: number;
  resets_at: number;
}

interface TokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

interface AgentUsage {
  five_hour: UsageWindow | null;
  seven_day: UsageWindow | null;
  updated_at: number | null;
  total_token_usage?: TokenUsage | null;
  last_token_usage?: TokenUsage | null;
  model_context_window?: number | null;
  plan_type?: string | null;
}

const emptyAgentUsage = (): AgentUsage => ({
  five_hour: null,
  seven_day: null,
  updated_at: null,
});

const finiteNumber = (x: unknown): number | null => {
  const n = typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN;
  return Number.isFinite(n) ? n : null;
};

function normalizeUsageWindow(win: unknown): UsageWindow | null {
  if (!win || typeof win !== "object") return null;
  const o = win as Record<string, unknown>;
  const used = finiteNumber(o.used_percentage ?? o.used_percent);
  const resets = finiteNumber(o.resets_at);
  if (used == null || resets == null) return null;
  return { used_percentage: used, resets_at: resets };
}

function normalizeTokenUsage(usage: unknown): TokenUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const o = usage as Record<string, unknown>;
  const input = finiteNumber(o.input_tokens);
  const cached = finiteNumber(o.cached_input_tokens);
  const output = finiteNumber(o.output_tokens);
  const reasoning = finiteNumber(o.reasoning_output_tokens);
  const total = finiteNumber(o.total_tokens);
  if (input == null || cached == null || output == null || reasoning == null || total == null) {
    return null;
  }
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: total,
  };
}

async function readClaudeUsage(): Promise<AgentUsage> {
  const f = Bun.file(`${process.env.HOME}/.claude/rate-limits.json`);
  if (!(await f.exists())) return emptyAgentUsage();
  const raw = await f.json();
  return {
    five_hour: normalizeUsageWindow(raw?.five_hour),
    seven_day: normalizeUsageWindow(raw?.seven_day),
    updated_at: finiteNumber(raw?.updated_at),
  };
}

async function readCodexUsage(): Promise<AgentUsage> {
  let files: { path: string; mtime: number }[] = [];
  try {
    const glob = new Bun.Glob("**/rollout-*.jsonl");
    for (const rel of glob.scanSync(codexSessionsRoot)) {
      const path = `${codexSessionsRoot}/${rel}`;
      try {
        files.push({ path, mtime: statSync(path).mtimeMs });
      } catch { }
    }
  } catch {
    return emptyAgentUsage();
  }
  files = files.sort((a, b) => b.mtime - a.mtime);

  for (const { path, mtime } of files.slice(0, 120)) {
    try {
      const file = Bun.file(path);
      const start = Math.max(0, file.size - 512 * 1024);
      const tail = await file.slice(start).text();
      for (const line of tail.trimEnd().split("\n").reverse()) {
        if (!line.includes('"rate_limits"')) continue;
        let d: any;
        try { d = JSON.parse(line); } catch { continue; }
        const p = d?.payload;
        const limits = p?.rate_limits;
        if (p?.type !== "token_count" || !limits) continue;
        const ts = typeof d.timestamp === "string" ? Date.parse(d.timestamp) / 1000 : mtime / 1000;
        return {
          five_hour: normalizeUsageWindow(limits.primary),
          seven_day: normalizeUsageWindow(limits.secondary),
          updated_at: Number.isFinite(ts) ? ts : mtime / 1000,
          total_token_usage: normalizeTokenUsage(p.info?.total_token_usage),
          last_token_usage: normalizeTokenUsage(p.info?.last_token_usage),
          model_context_window: finiteNumber(p.info?.model_context_window),
          plan_type: typeof limits.plan_type === "string" ? limits.plan_type : null,
        };
      }
    } catch { }
  }

  return emptyAgentUsage();
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
  // The repo's main working tree (git's first `worktree list` entry). Can't be
  // removed via `git worktree remove`, so the client hides its delete affordance.
  isMain: boolean;
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
    // `git worktree list` always reports the main working tree first (index 0),
    // so that entry is the one we won't let the client remove.
    worktrees.map(async (wt, i) => {
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
      return { repo: r.key, segment, dir: wt.dir, isMain: i === 0, ...status };
    }),
  );
}

async function getChanges(ws: Workspace): Promise<RepoChanges[]> {
  const all = (await Promise.all(ws.repos.map((r) => getChangesForRepo(ws, r)))).flat();
  ws.worktreeDirs.clear();
  for (const rc of all) ws.worktreeDirs.add(rc.dir);
  // Keep the file index fresh on every Changes refresh — never fatal to the view
  // (a directory that has grown past the limit just keeps its existing rows).
  void indexFiles(ws.id, ws.repos, ws.isWorkspace).catch(() => { });
  return all;
}

// Resolve a client-supplied worktree dir to a real directory, only allowing a
// dir this workspace has already reported; falls back to the repo's main dir.
function dirForWorktree(ws: Workspace, worktree: unknown, repoKey: unknown): string {
  if (typeof worktree === "string" && ws.worktreeDirs.has(worktree)) return worktree;
  return repoByKey(ws, typeof repoKey === "string" ? repoKey : null)?.dir ?? ws.path;
}

// Locate which repo owns a worktree dir (re-listing live, so we never trust the
// client's view of which tree is the removable one). Returns the repo's main dir
// to run `git -C` from, plus whether `dir` is that repo's main working tree.
async function repoOfWorktree(
  ws: Workspace,
  dir: string,
): Promise<{ repoDir: string; isMain: boolean } | null> {
  for (const r of ws.repos) {
    const wts = await listWorktrees(r.dir);
    if (wts.some((w) => w.dir === dir)) return { repoDir: r.dir, isMain: wts[0]?.dir === dir };
  }
  return null;
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

// Make sure `entry` is ignored by the repo at `dir`, appending it to (or
// creating) the local `.gitignore`. A no-op if it's already listed.
async function ensureGitignored(dir: string, entry: string) {
  const gi = `${dir}/.gitignore`;
  let text = "";
  try {
    text = await Bun.file(gi).text();
  } catch {
    // no .gitignore yet — we'll create one
  }
  const bare = entry.replace(/\/$/, "");
  const listed = text.split("\n").some((l) => {
    const t = l.trim();
    return t === entry || t === bare || t === `/${entry}` || t === `/${bare}`;
  });
  if (listed) return;
  const prefix = text.length && !text.endsWith("\n") ? "\n" : "";
  await Bun.write(gi, `${text}${prefix}${entry}\n`);
}

// Snapshot the working tree (staged + unstaged tracked changes vs HEAD) into a
// local `diffs/<branch>-<stamp>.patch` that `git apply` can replay. Keeps the
// `diffs/` dir out of version control. Returns the repo-relative file written,
// or null when there's nothing to save.
async function savePatch(dir: string): Promise<string | null> {
  const diff = await $`git diff HEAD`.cwd(dir).nothrow().quiet().text();
  if (!diff.trim()) return null;
  await ensureGitignored(dir, "diffs/");
  const branch =
    (await $`git symbolic-ref --quiet --short HEAD`.cwd(dir).nothrow().quiet().text()).trim() ||
    "detached";
  const safeBranch = branch.replace(/[^A-Za-z0-9._-]+/g, "-") || "patch";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const rel = `diffs/${safeBranch}-${stamp}.patch`;
  await Bun.write(`${dir}/${rel}`, diff);
  return rel;
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
<link rel="manifest" href="/manifest.webmanifest" />
<meta name="theme-color" content="#6e56cf" />
<link rel="apple-touch-icon" href="/icon-192.png" />
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
  .topbar-btn:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
  .topbar-btn:disabled { opacity: .4; cursor: default; }
  /* Toggled-on state (e.g. Home's "Prompt with context" while you're picking cards). */
  .topbar-btn.active { color: var(--accent); border-color: var(--accent); background: var(--accent-bg); }
  .topbar-btn.active:hover:not(:disabled) { background: var(--accent-bg); border-color: var(--accent); }
  /* New-session (+, Tmux + Commits tabs) and kill (trash, Tmux tab) buttons —
     sit beside the actions dropdown. */
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
  .commits-header input.content-search { margin-top: 6px; }

  .tabs {
    display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 2px;
    margin-bottom: 10px; background: var(--bg-tabs); border: 1px solid var(--border);
    border-radius: 7px; padding: 2px;
  }
  .tabs button {
    width: 100%; height: 30px; cursor: pointer; position: relative;
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
  /* Home tab badge counts sessions needing input — amber, like the waiting state. */
  .tabs button .tab-badge.waiting { background: var(--amber); }
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
  /* Idle-but-blocked: the session is waiting for input. Amber pulse + chip mark it
     apart from a working (purple) or plain-idle (gray) row, mirroring the queued look. */
  .sess-busy.waiting { background: var(--amber); animation: pendingPulse 1.6s ease-in-out infinite; }
  .commit.waiting { border-left-color: var(--amber); }
  .waiting-badge {
    margin-left: auto; flex-shrink: 0; font-size: 9px; font-weight: 700;
    letter-spacing: .04em; text-transform: uppercase; line-height: 14px;
    color: var(--amber); border: 1px solid var(--amber); border-radius: 999px; padding: 0 6px;
  }
  /* Unread: a session that finished with output you haven't opened since (see
     seenMtimes in client.tsx). An accent dot on the right + a bolder name, like an
     unread message. Mutually exclusive with the waiting badge — waiting rows are
     never flagged unread — so the right-aligned dot never collides with it. */
  .unread-dot {
    margin-left: auto; flex-shrink: 0; width: 8px; height: 8px; border-radius: 50%;
    background: var(--accent); margin-right: 2px;
  }
  .commit.unread .sess-name { font-weight: 700; }
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
  .kill-btn.keep-btn { right: 34px; }
  .kill-btn.keep-btn:hover { background: var(--green-bg); border-color: var(--green-border); color: var(--green); }

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

  /* ---- Subway tab: one-shot offline review cache ---- */
  .subway-status {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    margin: 8px 14px 4px; color: var(--text-muted); font-size: 11px;
  }
  .subway-status button {
    display: inline-flex; align-items: center; gap: 5px; min-height: 24px;
    padding: 3px 8px; border: 1px solid var(--border-strong); border-radius: 6px;
    background: var(--bg); color: var(--text-2); cursor: pointer;
  }
  .subway-status button:hover:not(:disabled) { color: var(--text); border-color: var(--accent); }
  .subway-status button:disabled { opacity: .5; cursor: default; }
  .subway-queue-note {
    margin: 7px 14px 2px; padding: 6px 9px;
    font-size: 11px; color: var(--amber);
    background: var(--bg-soft); border: 1px solid var(--amber); border-radius: 7px;
  }
  .commit.subway-row { border-left-color: var(--border); }
  .commit.subway-row.waiting { border-left-color: var(--amber); }
  .commit.subway-row .sess-task, .commit.subway-row .sess-cwd { padding-right: 48px; }
  .diffs.subway-main { padding: 0; background: var(--bg); }
  .subway-pane {
    min-height: 100%; width: min(100%, 980px); margin: 0 auto; padding: 0 20px 120px;
    display: flex; flex-direction: column;
  }
  .subway-head {
    position: sticky; top: 0; z-index: 5;
    display: flex; align-items: flex-start; justify-content: space-between; gap: 14px;
    padding: 15px 0 12px; border-bottom: 1px solid var(--border); background: var(--bg);
  }
  .subway-head h2 { margin: 0 0 3px; font-size: 16px; line-height: 1.3; overflow-wrap: anywhere; }
  .subway-head p { margin: 0; color: var(--text-muted); font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; }
  .subway-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
  .subway-head .act {
    min-height: 30px; display: inline-flex; align-items: center; gap: 6px;
    padding: 5px 10px; border-radius: 7px; flex-shrink: 0;
  }
  .act.keep { color: var(--green); border-color: var(--green-border); }
  .act.keep:hover:not(:disabled) { background: var(--green-bg); border-color: var(--green); color: var(--green); }
  .act.delete { color: var(--red); border-color: var(--red-border); }
  .act.delete:hover:not(:disabled) { background: var(--red-bg); border-color: var(--red); color: var(--red); }
  .subway-messages {
    display: flex; flex-direction: column; gap: 12px; padding: 18px 0 14px;
  }
  .subway-msg {
    max-width: min(760px, 92%); padding: 10px 12px; border: 1px solid var(--border);
    border-radius: 8px; background: var(--bg-raised); color: var(--text-md);
    line-height: 1.55; overflow-wrap: anywhere;
  }
  .subway-msg.user {
    align-self: flex-end; background: var(--accent-bg); border-color: var(--accent-border);
    color: var(--text-q);
  }
  .subway-msg.assistant { align-self: flex-start; }
  .subway-msg.pending { opacity: .72; border-style: dashed; }
  .subway-pending {
    display: inline-flex; margin-top: 7px; font-size: 10px; font-weight: 700;
    letter-spacing: .04em; text-transform: uppercase; color: var(--amber);
  }
  .subway-tool, .subway-tool-head {
    display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap;
    color: var(--text-muted); font-size: 12px;
  }
  .subway-tool .tool-path, .subway-tool-head .tool-path {
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px; color: var(--text-faint);
  }
  .subway-tool-result pre {
    margin: 7px 0 0; white-space: pre-wrap; overflow-wrap: anywhere;
    font: 11px/1.5 ui-monospace, "SF Mono", Menlo, monospace; color: var(--text-muted);
  }
  .subway-image-note { color: var(--text-muted); font-size: 12px; }
  .subway-composer {
    position: sticky; bottom: 0; z-index: 4;
    display: flex; align-items: flex-end; gap: 8px;
    margin-top: auto; padding: 10px 0 14px;
    background: linear-gradient(to top, var(--bg) 84%, transparent);
  }
  .subway-composer textarea {
    flex: 1 1 auto; min-height: 42px; max-height: 180px; resize: none;
    padding: 9px 10px; border: 1px solid var(--border-strong); border-radius: 8px;
    background: var(--bg); color: var(--text); font: inherit; line-height: 1.45; outline: none;
  }
  .subway-composer textarea:focus { border-color: var(--accent); }
  .subway-composer .act {
    min-height: 38px; display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 12px; border-radius: 8px; flex-shrink: 0;
  }
  .subway-empty {
    min-height: 360px; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 8px; color: var(--text-muted); text-align: center; padding: 20px;
  }
  .subway-empty h2 { margin: 0; color: var(--text); font-size: 18px; }
  .subway-empty p { margin: 0; max-width: 420px; }

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
  /* A queued reply still draining to the pane (see the reply outbox): dimmed so it
     reads as "sending", then solidifies the instant the real turn echoes back. */
  .turn.user.pending .bubble { opacity: .55; }
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
  /* codex reasoning summaries (agent_reasoning) — quiet, set apart from answers. */
  .reasoning { color: var(--text-muted); font-style: italic; opacity: .9; font-size: 12.5px; border-left: 2px solid var(--border); padding-left: 9px; margin: 2px 0; }
  .reasoning p { margin: 2px 0; }
  .tool-use .tool-arg { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  /* Generic tool output. Long results collapse to a preview with a "show more"
     toggle that expands the FULL content inline — no inner scrollbar to trap it. */
  .tool-result {
    align-self: flex-start; max-width: 100%;
    display: flex; flex-direction: column; align-items: flex-start; gap: 4px;
  }
  .tool-result pre {
    margin: 0; padding: 7px 10px; max-width: 100%;
    background: var(--bg-soft); border: 1px solid var(--border); border-radius: 6px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
    color: var(--text-muted); white-space: pre-wrap; word-break: break-word;
  }
  .tool-result-toggle, .tool-report-toggle {
    background: none; border: none; padding: 2px 4px; cursor: pointer;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--accent);
  }
  .tool-result-toggle:hover, .tool-report-toggle:hover { text-decoration: underline; }

  /* A sub-agent (Task/Agent) result — a report worth reading at length. Collapsed
     to a header by default; expands to full markdown inline, never an inner scroll. */
  .tool-report { align-self: stretch; max-width: 100%; display: flex; flex-direction: column; gap: 6px; }
  .tool-report-head {
    align-self: flex-start; max-width: 100%; display: inline-flex; align-items: baseline; gap: 7px; flex-wrap: wrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
    color: var(--text-2); background: var(--bg-muted); border: 1px solid var(--border);
    border-radius: 6px; padding: 4px 9px; cursor: pointer; text-align: left;
  }
  .tool-report-head:hover { border-color: var(--accent-border); }
  .tool-report-head .tool-name { color: var(--accent); font-weight: 600; }
  .tool-report-head .tool-name::before { content: "✳ "; opacity: .8; }
  .tool-report-head .tool-arg { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .tool-report-head .tool-report-meta { color: var(--text-muted); opacity: .75; }
  .tool-report-body {
    border: 1px solid var(--border); border-radius: 8px; background: var(--bg-soft); padding: 11px 14px;
  }
  .tool-report-body .md { font-size: 13.5px; }

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

  /* Structured pending-prompt controls (see PendingPrompt) — real buttons/checkboxes
     drawn over the live pane so you tap instead of hand-typing a digit. Reuses the
     q-card accent treatment for the option rows. */
  .pending-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
  .pending-body .q-text { margin: 0; }
  .q-checks { display: flex; flex-direction: column; gap: 7px; }
  .q-check {
    display: flex; align-items: flex-start; gap: 10px; width: 100%; text-align: left;
    padding: 9px 11px; border: 1px solid var(--accent-border-4); border-radius: 7px;
    background: var(--accent-choice-bg); color: var(--text-on-accent-bg);
    font-size: 13px; font-family: inherit; cursor: pointer;
  }
  .q-check:hover:not(:disabled) { border-color: var(--accent); background: var(--accent-bg-hover); }
  .q-check:disabled { cursor: default; opacity: .6; }
  .q-check.on { border-color: var(--accent); background: var(--accent-bg-hover); }
  .q-check-box {
    flex: none; display: inline-flex; align-items: center; justify-content: center;
    width: 18px; height: 18px; margin-top: 1px; border-radius: 5px;
    border: 1.5px solid var(--accent-border); background: var(--accent-card);
    color: #fff; font-size: 12px; font-weight: 800; line-height: 1;
  }
  .q-check.on .q-check-box { background: var(--accent); border-color: var(--accent); }
  .pending-submit {
    align-self: flex-start; padding: 8px 16px; border: 1px solid var(--accent); border-radius: 7px;
    background: var(--accent); color: #fff; font-size: 13px; font-weight: 650; font-family: inherit; cursor: pointer;
  }
  .pending-submit:hover:not(:disabled) { filter: brightness(1.08); }
  .pending-submit:disabled { opacity: .55; cursor: default; }
  .pending-err { font-size: 12px; color: var(--amber); }
  .pending-raw { border-top: 1px solid var(--border); }
  .pending-raw > summary {
    padding: 7px 14px; font-size: 11.5px; color: var(--text-hint);
    cursor: pointer; user-select: none; list-style: none;
  }
  .pending-raw > summary::-webkit-details-marker { display: none; }
  .pending-raw > summary:hover { color: var(--text-2); }
  .pending-raw[open] > summary { border-bottom: 1px solid var(--border); }
  .pending-raw .pending-pane-body { border-top: none; }

  /* Single-select pending prompt: radio list on the left, the selected option's
     preview art in a monospace pane on the right, explicit Submit at the bottom. */
  .pending-split { display: flex; gap: 14px; align-items: stretch; flex-wrap: wrap; }
  .pending-split.no-preview { display: block; }
  .pending-split > .q-radios { flex: 1 1 240px; min-width: 220px; }
  .q-radio.on { border-color: var(--accent); background: var(--accent-bg-hover); }
  .q-radio-dot {
    flex: none; display: inline-flex; align-items: center; justify-content: center;
    width: 16px; height: 16px; margin-top: 1px; border-radius: 50%;
    border: 1.5px solid var(--accent-border); background: var(--accent-card);
    color: var(--accent); font-size: 9px; line-height: 1;
  }
  .q-radio.on .q-radio-dot { border-color: var(--accent); }
  .pending-preview {
    flex: 2 1 320px; min-width: 240px; display: flex; flex-direction: column;
    border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--bg-soft);
  }
  .pending-preview-head {
    padding: 6px 12px; font-size: 11px; font-weight: 650; color: var(--text-hint);
    border-bottom: 1px solid var(--border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .pending-preview-body {
    margin: 0; padding: 10px 12px; overflow: auto; max-height: 24em; flex: 1;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; line-height: 1.5;
    color: var(--text-md); white-space: pre;
  }
  .pending-preview-empty { padding: 14px 12px; font-size: 12px; color: var(--text-hint); }

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
  /* GFM tables. Wrapper scrolls horizontally so wide tables never blow out the
     chat column on narrow tmux/mobile widths. */
  .md .md-table-wrap { margin: 0 0 10px; overflow-x: auto; }
  .md table.md-table { border-collapse: collapse; font-size: 13px; line-height: 1.5; width: auto; }
  .md table.md-table th, .md table.md-table td {
    border: 1px solid var(--border); padding: 5px 10px; text-align: left; vertical-align: top;
    white-space: normal; word-break: normal;
  }
  .md table.md-table th { font-weight: 650; background: var(--bg-muted); }
  .md table.md-table tbody tr:nth-child(even) td { background: var(--bg-raised); }
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
     New session textarea: multi-line, ⌃V image paste, ↵ to send. */
  .reply-box {
    position: sticky; bottom: 0; z-index: 4;
    margin-top: 6px; padding: 10px 0 14px;
    background: var(--bg); border-top: 1px solid var(--border);
  }
  /* Floating "jump to latest" chevron — anchored to the sticky composer so it
     hovers just above it, centered over the transcript column. */
  .scroll-bottom {
    position: absolute; left: 50%; bottom: 100%; transform: translateX(-50%);
    margin-bottom: 12px; z-index: 5;
    display: grid; place-items: center;
    width: 34px; height: 34px; border-radius: 50%; cursor: pointer;
    background: var(--bg-muted); color: var(--text-2);
    border: 1px solid var(--border-strong);
    box-shadow: 0 2px 10px rgba(0, 0, 0, .28);
  }
  .scroll-bottom:hover { color: var(--text); border-color: var(--accent); }
  .scroll-bottom svg { width: 18px; height: 18px; }
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
  .reply-bar .icon-btn.delete:hover:not(:disabled) { background: var(--red-bg); border-color: var(--red-border); color: var(--red); }
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

  /* Worktree switcher (Changes sidebar) — picks which tree's diffs are shown. */
  .wt-dropdown { position: relative; padding: 6px 14px 2px; }
  .wt-trigger {
    display: flex; align-items: center; gap: 6px; width: 100%;
    padding: 6px 10px; cursor: pointer; text-align: left; font-family: inherit;
    background: var(--accent-bg); border: 1px solid var(--accent-ring); border-radius: 7px; color: var(--accent);
  }
  .wt-trigger:hover { border-color: var(--accent); }
  .wt-trigger::before { content: "⎇"; opacity: .75; font-size: 12px; flex-shrink: 0; }
  .wt-trigger-label {
    font-size: 12px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .wt-trigger .wt-caret { margin-left: 2px; }
  .wt-menu {
    position: absolute; top: calc(100% + 4px); left: 14px; right: 14px; z-index: 30;
    background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
    box-shadow: 0 10px 34px rgba(0, 0, 0, .16); padding: 4px;
    display: flex; flex-direction: column; max-height: 60vh; overflow-y: auto;
  }
  .wt-item {
    display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; cursor: pointer;
    padding: 6px 9px; background: none; border: none; border-radius: 6px; color: var(--text); font-family: inherit;
  }
  .wt-item:hover { background: var(--bg-hover); }
  .wt-item.on { background: var(--accent-bg); }
  /* The select half fills the row; the delete (✕) sits after it. */
  .wt-item-select {
    display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0;
    background: none; border: none; padding: 0; margin: 0;
    text-align: left; cursor: pointer; color: inherit; font-family: inherit;
  }
  .wt-item-label {
    font-size: 12px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0;
  }
  .wt-item .wt-count { flex-shrink: 0; }
  /* Per-worktree delete (✕) — dim by default (so it stays tappable on touch,
     where there's no hover), louder on hover. Never shown for the main tree. */
  .wt-item-del {
    flex-shrink: 0; display: grid; place-items: center;
    width: 18px; height: 18px; padding: 0; border: none; border-radius: 5px;
    background: none; color: var(--text-muted); cursor: pointer; font-size: 13px; line-height: 1;
    opacity: .45; transition: opacity .12s, color .12s, background .12s;
  }
  .wt-item:hover .wt-item-del, .wt-item-del:focus-visible { opacity: 1; }
  .wt-item-del:hover { color: var(--red); background: var(--red-bg); opacity: 1; }
  .wt-bulk-del {
    display: flex; align-items: center; justify-content: center; gap: 6px;
    margin-top: 4px; padding: 7px 9px; width: 100%;
    border: 0; border-top: 1px solid var(--border); border-radius: 0 0 6px 6px;
    background: none; color: var(--red); cursor: pointer; font: inherit; font-size: 12px;
  }
  .wt-bulk-del:hover { background: var(--red-bg); }
  .wt-bulk-del svg { width: 12px; height: 12px; flex-shrink: 0; }

  /* "Which worktree" banner at the top of the diff column. Not sticky — the
     per-file headers (stickyHeader) own top:0 as you scroll. */
  .wt-banner {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 16px; margin-bottom: 8px;
    background: var(--bg-soft); border: 1px solid var(--border); border-radius: 8px;
  }
  .wt-banner::before { content: "⎇"; color: var(--accent); opacity: .8; font-size: 13px; }
  .wt-banner-name { font-size: 13px; font-weight: 700; color: var(--text); }
  .wt-banner-count {
    margin-left: auto; font-size: 11px; font-weight: 600;
    color: var(--accent-dim); background: var(--accent-bg); border-radius: 999px; padding: 1px 8px;
  }

  /* Mobile commit pager — a bar at the top of the diff with newer/older buttons
     and a position readout, giving phones the ↑/↓ commit-walking the keyboard
     gives desktop (the list there is a hidden drawer). Only rendered on mobile
     (gated by !isDesktop in client.tsx), so no media query needed here. The
     message sits centered between the two edge-pinned buttons. */
  .commit-pager {
    display: flex; align-items: center; gap: 8px;
    margin-bottom: 10px; padding: 6px 8px;
    background: var(--bg-soft); border: 1px solid var(--border); border-radius: 10px;
  }
  .commit-pager-btn {
    flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center;
    width: 40px; height: 34px; cursor: pointer; color: var(--text-2);
    background: var(--bg); border: 1px solid var(--border-strong); border-radius: 8px;
  }
  .commit-pager-btn:hover { color: var(--text); border-color: var(--accent); }
  .commit-pager-btn:active { background: var(--bg-hover); }
  .commit-pager-mid {
    flex: 1; min-width: 0; display: flex; flex-direction: column;
    align-items: center; gap: 1px; text-align: center;
  }
  .commit-pager-msg {
    max-width: 100%; font-size: 13px; font-weight: 600; color: var(--text);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .commit-pager-pos { font-size: 11px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
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
  .act.primary { background: var(--accent); border-color: var(--accent); color: var(--text-on-accent-bg); }
  .act.primary:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); color: var(--text-on-accent-bg); }
  .hdr-acts { display: inline-flex; gap: 5px; margin-left: 10px; }

  .diffs { flex: 1; overflow-y: auto; padding: 16px 20px 60vh; }
  /* Tmux tab: drop the top/bottom padding so the sticky title and the reply
     composer sit flush against the column edges. */
  .diffs.tmux { padding: 0 20px; }

  /* ---- Home tab: session monitor dashboard ---- */
  /* The landing view groups the directory's claude chats by state. Cards reuse the
     sidebar's status-dot language (purple = working, amber = waiting/queued). "In
     progress" and "Needs action" always show; the rest appear when populated. */
  .diffs.home-main { padding: 18px 20px 60vh; }

  /* ---- HTML reports tab: a full-bleed iframe under a thin toolbar ---- */
  .diffs.report-main { padding: 0; overflow: hidden; display: flex; }
  .report-pane { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .report-bar {
    display: flex; align-items: center; gap: 6px; flex-shrink: 0;
    padding: 6px 10px; border-bottom: 1px solid var(--border);
    background: var(--bg-soft); font-size: 12px;
  }
  .report-bar-icon { color: var(--text-faint); flex-shrink: 0; }
  .report-title { font-weight: 600; white-space: nowrap; flex-shrink: 0; }
  .report-path {
    color: var(--text-faint); font-family: ui-monospace, Menlo, monospace; font-size: 11px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
  }
  .report-bar .spacer { flex: 1; }
  .report-frame { flex: 1; width: 100%; border: 0; background: #fff; min-height: 0; }
  /* report list rows reuse .commit; the kebab mirrors .kill-btn but stays neutral */
  .html-kebab {
    position: absolute; top: 7px; right: 8px; width: 20px; height: 20px;
    display: flex; align-items: center; justify-content: center; padding: 0;
    background: none; border: none; border-radius: 4px;
    color: var(--text-faint); cursor: pointer; opacity: 0;
  }
  .commit:hover .html-kebab { opacity: 1; }
  .html-kebab:hover { background: var(--bg-hover); color: var(--text); }
  .html-menu {
    position: fixed; z-index: 60; min-width: 140px; padding: 4px;
    background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0,0,0,.18); font-size: 13px;
  }
  .html-menu button {
    display: flex; align-items: center; gap: 7px; width: 100%; text-align: left; padding: 6px 10px;
    background: none; border: none; border-radius: 5px; color: var(--text); cursor: pointer;
  }
  .html-menu button:hover { background: var(--bg-hover); }
  .html-menu button.danger { color: var(--red); }
  .html-menu button.danger:hover { background: var(--red-bg); }
  /* invisible full-screen catcher so a click outside the row menu closes it */
  .menu-backdrop { position: fixed; inset: 0; z-index: 59; }
  /* rename dialog reuses .share-overlay / .share-card; just style its form */
  .rename-form { padding: 14px 16px 16px; }
  .rename-input {
    width: 100%; box-sizing: border-box; padding: 7px 9px; font-size: 13px;
    font-family: ui-monospace, Menlo, monospace; color: var(--text);
    background: var(--bg); border: 1px solid var(--border-strong); border-radius: 6px;
  }
  .rename-input:focus { outline: none; border-color: var(--accent); }
  .rename-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
  .rename-actions button {
    padding: 6px 12px; font-size: 13px; border-radius: 6px; cursor: pointer;
    background: var(--bg-soft); border: 1px solid var(--border); color: var(--text);
  }
  .rename-actions button.primary { background: var(--accent); border-color: var(--accent); color: var(--text-on-accent-bg); }
  .home { display: flex; flex-direction: column; gap: 22px; max-width: 1100px; }
  .home-group { display: flex; flex-direction: column; gap: 10px; }
  .home-group-head { display: flex; align-items: center; gap: 8px; }
  .home-group-title { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
  .home-group-head.in-progress .home-group-title { color: var(--accent); }
  .home-group-head.needs-action .home-group-title { color: var(--amber); }
  .home-group-count { font-size: 11px; font-variant-numeric: tabular-nums; color: var(--text-muted); background: var(--bg-soft); border: 1px solid var(--border-soft); border-radius: 999px; padding: 1px 7px; }
  .home-empty { font-size: 13px; color: var(--text-muted); padding: 2px 2px 4px; }
  .home-empty-all { font-size: 14px; color: var(--text-muted); text-align: center; padding: 48px 0; }
  .home-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
  .home-card { position: relative; display: flex; flex-direction: column; gap: 5px; text-align: left; width: 100%; padding: 11px 13px; border: 1px solid var(--border); border-left: 3px solid var(--border); border-radius: 8px; background: var(--bg-raised); color: var(--text); cursor: pointer; font: inherit; transition: background .12s, border-color .12s; }
  .home-card:hover { background: var(--bg-hover); }
  .home-card:hover .kill-btn, .home-card:focus-within .kill-btn { opacity: 1; }
  .home-card.busy, .home-card.unread { border-left-color: var(--accent); }
  .home-card.waiting, .home-card.queued { border-left-color: var(--amber); }
  .home-card.queued { cursor: default; }
  /* Keyboard/click focus ring — the "selected card" the arrow keys move and Enter
     opens. Drawn as an accent border + soft ring so it reads on top of the
     state-coloured left stripe. */
  .home-card.selected { border-color: var(--accent); background: var(--accent-bg); box-shadow: 0 0 0 1px var(--accent); }
  .home-card-top { display: flex; align-items: center; gap: 7px; padding-right: 22px; }
  .home-card-name { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .home-card.unread .home-card-name { font-weight: 700; }
  .home-card-agent { flex: none; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--accent); border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; line-height: 15px; }
  .home-card-task { font-size: 12px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .home-card.queued .home-card-task { white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .home-card-cwd { font-size: 11px; color: var(--text-muted); opacity: .8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* cwd (left, ellipsised) + last-message time (right) share the card's bottom row. */
  .home-card-foot { display: flex; align-items: baseline; gap: 8px; }
  .home-card-foot .home-card-cwd { flex: 1; min-width: 0; }
  .home-card-time { flex: none; font-size: 11px; color: var(--text-faint); font-variant-numeric: tabular-nums; white-space: nowrap; }
  /* Click-to-copy claude session id chip — sits between the cwd and the time in
     the footer. Monospace short id (first 8 of the UUID); copies the full id.
     Stays muted until hover so it doesn't compete with the cwd/time. */
  .home-card-id {
    flex: none; display: inline-flex; align-items: center; gap: 4px; padding: 1px 5px;
    border: 1px solid var(--border-soft); border-radius: 5px; background: none;
    color: var(--text-faint); font: inherit; font-size: 10px; cursor: pointer;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .home-card-id:hover { color: var(--accent); border-color: var(--accent); background: var(--accent-bg); }
  /* Status dot — mirrors .sess-busy in the sidebar. */
  .home-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--text-muted); }
  .home-card.busy .home-dot { background: var(--accent); animation: sessPulse 1.4s ease-in-out infinite; }
  .home-card.waiting .home-dot, .home-card.queued .home-dot { background: var(--amber); animation: pendingPulse 1.6s ease-in-out infinite; }
  .home-card.unread .home-dot { background: var(--accent); }
  @media (max-width: 640px) { .home-cards { grid-template-columns: 1fr; } }
  /* "Prompt with context" selection mode — cards become checkboxes you tick to pick
     which sessions a new prompt should reference. A ticked card lights up like the
     keyboard-selected one (accent border + ring) so the picks read at a glance. */
  .home-card.picking { cursor: pointer; }
  .home-card-check {
    flex: none; width: 14px; height: 14px; border-radius: 4px;
    border: 1.5px solid var(--border-strong); background: var(--bg);
    display: flex; align-items: center; justify-content: center;
    font-size: 10px; line-height: 1; color: #fff;
  }
  .home-card.picked { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .home-card.picked .home-card-check { background: var(--accent); border-color: var(--accent); }
  /* Mark-read check — shows on unacknowledged attention cards (Done / Needs-action),
     sat just left of the kill button. Same chip as .kill-btn, but it acknowledges
     (accent) rather than destroys (red). */
  .read-btn {
    position: absolute; top: 9px; right: 34px; width: 18px; height: 18px;
    display: flex; align-items: center; justify-content: center; padding: 0;
    background: none; border: 1px solid var(--border-strong); border-radius: 50%;
    color: var(--text-faint); font-size: 11px; cursor: pointer; opacity: 0;
  }
  .home-card:hover .read-btn, .home-card:focus-within .read-btn { opacity: 1; }
  .read-btn:hover { background: var(--accent-bg); border-color: var(--accent); color: var(--accent); }
  /* Two action chips need more clear space to the right of the name than one. */
  .home-card:has(.read-btn) .home-card-top { padding-right: 44px; }
  /* An acknowledged Needs-action card (seen, but still waiting) calms its dot, so
     only the genuinely-new prompts keep pulsing for your attention. */
  .home-card.waiting.read .home-dot { animation: none; opacity: .55; }
  /* Touch devices can't hover, so keep the card's action buttons visible there. */
  @media (hover: none) { .home-card .kill-btn, .home-card .read-btn { opacity: 1; } }

  /* ---- Home dashboard chat side-panel ---- */
  /* Clicking a card opens its chat here without leaving the dashboard. Desktop:
     a docked right sidebar. Mobile (≤1024px): a full-screen sheet. Portaled to
     <body> and fixed so the scrolling card grid behind it stays put. */
  .home-chat-panel {
    position: fixed; top: 0; right: 0; bottom: 0; z-index: 60;
    width: min(520px, 44vw);
    display: flex; flex-direction: column;
    background: var(--bg); border-left: 1px solid var(--border);
    box-shadow: -10px 0 30px rgba(0, 0, 0, .18);
    animation: chatPanelIn .16s ease;
  }
  @keyframes chatPanelIn { from { transform: translateX(20px); opacity: .3; } to { transform: none; opacity: 1; } }
  .home-chat-bar {
    flex: 0 0 auto; display: flex; align-items: center; gap: 10px;
    padding: 9px 12px; border-bottom: 1px solid var(--border);
  }
  .home-chat-title { flex: 1 1 auto; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .home-chat-close {
    flex: 0 0 auto; display: grid; place-items: center;
    width: 30px; height: 30px; border-radius: 7px; cursor: pointer;
    background: var(--bg-muted); border: 1px solid var(--border); color: var(--text-2);
  }
  .home-chat-close:hover { color: var(--text); border-color: var(--text-muted); }
  /* "Open HTML" button — appears in the chat bar once the session has written an
     .html artifact; opens the .html-overlay preview. */
  .home-chat-html {
    flex: 0 0 auto; display: inline-flex; align-items: center; gap: 5px;
    height: 30px; padding: 0 10px; border-radius: 7px; cursor: pointer;
    font-size: 12px; font-weight: 600;
    background: var(--accent-bg); border: 1px solid var(--accent); color: var(--accent-strong);
  }
  .home-chat-html:hover { background: var(--accent-bg-hover); }
  /* "Copy ID" button — copies this session's claude id so it can be referenced
     from another chat. Neutral chip sat next to the accent "Open HTML" button. */
  .home-chat-id {
    flex: 0 0 auto; display: inline-flex; align-items: center; gap: 5px;
    height: 30px; padding: 0 10px; border-radius: 7px; cursor: pointer;
    font-size: 12px; font-weight: 600;
    background: var(--bg-muted); border: 1px solid var(--border); color: var(--text-2);
  }
  .home-chat-id:hover { color: var(--text); border-color: var(--text-muted); }
  /* The panel's own scroll container: the transcript-head sticks to its top and
     the composer to its bottom, same as the Tmux tab's main column. */
  .home-chat-scroll { flex: 1 1 auto; overflow-y: auto; padding: 0 18px; }
  /* Push the card grid clear of the docked panel on desktop so nothing hides
     behind it. */
  @media (min-width: 1025px) {
    .diffs.home-main.chat-open { padding-right: calc(min(520px, 44vw) + 24px); }
  }
  /* Phones/tablets: the chat takes the whole screen, like a dialog. */
  @media (max-width: 1024px) {
    .home-chat-panel { width: 100%; border-left: none; box-shadow: none; animation: chatSheetIn .18s ease; }
  }
  @keyframes chatSheetIn { from { transform: translateY(14px); opacity: .4; } to { transform: none; opacity: 1; } }

  /* Full-screen HTML artifact preview, layered above the Home chat panel. */
  .html-overlay {
    position: fixed; inset: 0; z-index: 70;
    display: flex; flex-direction: column;
    background: var(--bg);
    animation: chatSheetIn .16s ease;
  }
  .html-bar {
    flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
    padding: 8px 12px; border-bottom: 1px solid var(--border); background: var(--bg-sidebar);
  }
  .html-bar-icon { flex: 0 0 auto; color: var(--accent); }
  .html-title { flex: 0 0 auto; font-size: 13px; font-weight: 600; }
  .html-path {
    flex: 0 1 auto; min-width: 0; font-size: 11px; color: var(--text-muted);
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .html-bar .spacer { flex: 1 1 auto; }
  .html-body { flex: 1 1 auto; min-height: 0; background: #fff; }
  .html-frame { width: 100%; height: 100%; border: 0; display: block; background: #fff; }
  .spin { animation: spin .8s linear infinite; }

  /* ---- Template prompts tab ---- */
  .diffs.prompts-main { padding: 0; background: var(--bg); }
  .prompt-pane {
    min-height: 100%; padding: 18px 20px 60vh;
    display: flex; align-items: stretch;
  }
  .prompt-board, .prompt-editor {
    width: min(100%, 1040px); display: flex; flex-direction: column; gap: 14px;
  }
  .prompt-board-head {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 16px;
    padding-bottom: 12px; border-bottom: 1px solid var(--border);
  }
  .prompt-board-head h2 { margin: 0 0 3px; font-size: 18px; line-height: 1.25; }
  .prompt-board-head p { margin: 0; color: var(--text-muted); font-size: 12px; }
  .prompt-board-head .act {
    min-height: 32px; display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 12px; border-radius: 7px;
  }
  .prompt-cards {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px;
  }
  .prompt-card {
    position: relative; min-height: 150px; display: flex; flex-direction: column; gap: 10px;
    padding: 12px 13px; border: 1px solid var(--border); border-left: 3px solid var(--accent);
    border-radius: 8px; background: var(--bg-raised); color: var(--text); cursor: pointer;
    transition: background .12s, border-color .12s, box-shadow .12s;
  }
  .prompt-card:hover, .prompt-card:focus-visible { background: var(--bg-hover); border-color: var(--accent); outline: none; }
  .prompt-card.selected { background: var(--accent-bg); box-shadow: 0 0 0 1px var(--accent); }
  .prompt-card-top { display: flex; align-items: center; gap: 8px; min-width: 0; padding-right: 24px; }
  .prompt-card-icon {
    flex: none; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center;
    border-radius: 7px; background: var(--accent-bg); color: var(--accent);
  }
  .prompt-card h3 {
    flex: 1 1 auto; min-width: 0; margin: 0; font-size: 13px; line-height: 1.35;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .prompt-card p {
    margin: 0; color: var(--text-muted); font-size: 12px; line-height: 1.45;
    display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;
  }
  .prompt-card-edit {
    position: absolute; top: 10px; right: 10px; width: 22px; height: 22px;
    display: inline-flex; align-items: center; justify-content: center; padding: 0;
    border: 1px solid var(--border-strong); border-radius: 6px; background: var(--bg);
    color: var(--text-faint); cursor: pointer; opacity: 0;
  }
  .prompt-card:hover .prompt-card-edit, .prompt-card:focus-within .prompt-card-edit { opacity: 1; }
  .prompt-card-edit:hover { color: var(--text); border-color: var(--accent); background: var(--accent-bg); }
  .prompt-card-foot {
    margin-top: auto; display: flex; align-items: center; justify-content: space-between; gap: 8px;
    color: var(--text-faint); font-size: 11px; font-variant-numeric: tabular-nums;
  }
  .prompt-card-cursor {
    display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px;
    border: 1px solid var(--border-soft); border-radius: 6px; color: var(--accent); background: var(--bg);
  }
  @media (hover: none) { .prompt-card-edit { opacity: 1; } }
  @media (max-width: 640px) {
    .prompt-pane { padding: 14px 14px 60vh; }
    .prompt-board-head, .prompt-editor-head { flex-direction: column; align-items: stretch; }
    .prompt-cards { grid-template-columns: 1fr; }
  }
  .prompt-editor-head {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 16px;
    padding-bottom: 12px; border-bottom: 1px solid var(--border);
  }
  .prompt-editor-head h2 { margin: 0 0 3px; font-size: 18px; line-height: 1.25; }
  .prompt-editor-head p { margin: 0; color: var(--text-muted); font-size: 12px; }
  .prompt-editor-actions { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; justify-content: flex-end; }
  .prompt-editor-actions .act { min-height: 30px; padding: 5px 12px; border-radius: 7px; }
  .prompt-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .prompt-field.grow { flex: 1 1 auto; min-height: 380px; }
  .prompt-field span {
    color: var(--text-muted); font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: .04em;
  }
  .prompt-field input, .prompt-field textarea {
    width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--border-strong);
    border-radius: 8px; outline: none; font: inherit;
  }
  .prompt-field input { height: 36px; padding: 7px 10px; }
  .prompt-field textarea {
    flex: 1 1 auto; min-height: 360px; resize: vertical; padding: 10px 12px;
    line-height: 1.55; font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .prompt-field input:focus, .prompt-field textarea:focus { border-color: var(--accent); }
  /* Share dialog: a centered modal layered above the .html-overlay preview. */
  .share-overlay {
    position: fixed; inset: 0; z-index: 80;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0,0,0,.45); padding: 20px;
    animation: chatSheetIn .14s ease;
  }
  .share-card {
    width: 100%; max-width: 460px;
    background: var(--bg); border: 1px solid var(--border); border-radius: 12px;
    box-shadow: 0 12px 40px rgba(0,0,0,.3); padding: 14px 16px 16px;
  }
  .share-head { display: flex; align-items: center; gap: 8px; color: var(--accent); margin-bottom: 12px; }
  .share-head .spacer { flex: 1 1 auto; }
  .share-title { font-size: 13px; font-weight: 600; color: var(--text); }
  .share-status { font-size: 13px; color: var(--text-muted); padding: 8px 2px; }
  .share-status.error { color: var(--red); white-space: pre-wrap; }
  .share-row { display: flex; gap: 8px; align-items: center; }
  .share-url {
    flex: 1 1 auto; min-width: 0;
    font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px;
    padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px;
    background: var(--bg-sidebar); color: var(--text);
  }
  .share-url:focus { outline: none; border-color: var(--accent); }
  .share-meta { margin-top: 10px; font-size: 12px; color: var(--text-muted); line-height: 1.5; }
  .share-meta a { color: var(--accent); text-decoration: none; }
  .share-meta a:hover { text-decoration: underline; }
  .share-foot { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
  .act.danger { color: var(--red); border-color: color-mix(in srgb, var(--red) 35%, var(--border)); }
  .act.danger:hover:not(:disabled) { background: color-mix(in srgb, var(--red) 12%, transparent); border-color: var(--red); }
  .act.danger:disabled { opacity: .6; cursor: default; }
  .share-foot-err { font-size: 11px; color: var(--red); white-space: pre-wrap; }
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
    /* Above the docked Home chat panel (.home-chat-panel, z-index 60) so dialogs
       like "New session" open over the right sheet, not behind it. */
    position: fixed; inset: 0; z-index: 65;
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
  .modal-list {
    display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0 0;
    font-size: 11px; color: var(--text-muted);
  }
  .modal-list code {
    padding: 2px 6px; border: 1px solid var(--border); border-radius: 5px;
    background: var(--bg-soft); color: var(--text); font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .commit-input {
    width: 100%; min-height: 92px; max-height: 60vh; resize: vertical; overflow-y: auto;
    background: var(--bg); color: inherit; font: inherit; line-height: 1.5;
    border: 1px solid var(--border-strong); border-radius: 6px; padding: 8px 10px; outline: none;
  }
  /* The New session composer grows to fit its content via JS (autosizeClaude),
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
  /* Options row in the New session composer (effort picker, etc.). */
  .claude-opts { display: flex; align-items: center; gap: 12px; margin-top: 10px; }
  .claude-opt { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-muted); }
  .claude-opt select {
    font: inherit; font-size: 11px; color: var(--text-2); cursor: pointer; outline: none;
    background: var(--bg-muted); border: 1px solid var(--border-strong); border-radius: 5px; padding: 2px 6px;
  }
  .claude-opt select:hover, .claude-opt select:focus { color: var(--text); border-color: var(--accent); }
  .claude-opt input[type="checkbox"] { accent-color: var(--accent); cursor: pointer; margin: 0; }

  /* Agent usage dialog (⇧U) — one row per rate-limit window: label, percent,
     a fill bar, and the reset countdown. */
  .usage-note { padding: 8px 2px 4px; font-size: 13px; color: var(--text-muted); line-height: 1.5; }
  .usage-note.error { color: var(--red); white-space: pre-wrap; }
  .usage-grid { display: flex; flex-direction: column; gap: 16px; padding: 4px 0 2px; }
  .usage-panel { display: flex; flex-direction: column; gap: 12px; }
  .usage-panel + .usage-panel { border-top: 1px solid var(--border); padding-top: 14px; }
  .usage-panel-head { display: flex; align-items: baseline; gap: 8px; }
  .usage-source { font-size: 13px; font-weight: 700; }
  .usage-source-sub { font-size: 11px; color: var(--text-faint); }
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

  /* Resume-session dialog (⇧') — a filterable list of the active directory's past
     claude transcripts; clicking one relaunches it via claude --resume. */
  .modal.resume { width: 520px; }
  .resume-list { display: flex; flex-direction: column; gap: 2px; max-height: 56vh; overflow-y: auto; margin-top: 8px; }
  .resume-item {
    display: flex; align-items: baseline; gap: 10px; width: 100%; text-align: left; cursor: pointer;
    padding: 7px 9px; background: none; border: none; border-radius: 6px; color: var(--text);
  }
  .resume-item:hover { background: var(--bg-hover); }
  .resume-item.active { background: var(--bg-hover); box-shadow: inset 0 0 0 1px var(--accent-ring); }
  .resume-item:disabled { cursor: default; }
  .resume-item .resume-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .resume-item .resume-time { flex-shrink: 0; font-size: 11px; color: var(--text-faint); font-variant-numeric: tabular-nums; }

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
  .push-sep { height: 1px; background: var(--border); margin: 14px 0 12px; }
  .push-box { display: flex; flex-direction: column; gap: 8px; }
  .push-head { display: flex; align-items: center; gap: 8px; }
  .push-title { font-size: 13px; font-weight: 600; color: var(--text-strong); }
  .push-on { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--green); background: var(--green-bg); border: 1px solid var(--green-border); border-radius: 999px; padding: 1px 7px; }
  .push-hint { font-size: 11.5px; color: var(--text-faint); line-height: 1.45; }
  .push-hint code { font-size: 11px; padding: 1px 4px; border-radius: 4px; background: var(--bg-muted); color: var(--text-2); }
  .push-actions { display: flex; gap: 8px; }
  .push-msg { font-size: 11.5px; color: var(--text-muted); }

  /* @-file autocomplete popup in the New session dialog. Portaled to
     <body> with fixed coords (left/top|bottom/width/max-height set inline from
     the textarea's rect) so the modal's overflow never clips it. */
  .file-menu-wrap { position: relative; }
  .file-menu {
    /* Stay above the dialog it belongs to (.modal-overlay, z-index 65) so the
       @-file autocomplete is never clipped behind the New session modal. */
    position: fixed; z-index: 90;
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

    /* Drawers: fixed, off-canvas, snap in on transform (no transition — the app
       favors instant response). They sit below the top bar (top: 51px) and
       above the scrim. */
    .commits, .tree {
      position: fixed; top: 51px; bottom: 0; z-index: 45;
      width: min(86vw, 380px); min-width: 0;
    }
    .commits { left: 0; transform: translateX(-100%); }
    .tree { right: 0; left: auto; transform: translateX(100%); }
    .layout[data-drawer="left"] .commits { transform: translateX(0); box-shadow: 6px 0 28px rgba(0,0,0,.18); }
    .layout[data-drawer="right"] .tree { transform: translateX(0); box-shadow: -6px 0 28px rgba(0,0,0,.18); }

    .scrim { position: fixed; top: 51px; inset: 51px 0 0; z-index: 44; background: rgba(0,0,0,.35); }

    /* New session dialog on mobile: a centered dialog gets covered by the
       on-screen keyboard, so pin it to the top and give the composer more room
       by default (it still auto-grows + scrolls past this floor). */
    .claude-overlay { align-items: flex-start; padding-top: 12px; }
    .claude .commit-input.auto { min-height: 180px; }

    /* The "New session created" toast sits at the bottom by default, but on
       mobile the composer/keyboard area is busy — pin it to the top, just below
       the top bar (51px) plus any notch inset. Other .sel-bar uses stay put. */
    .sel-bar-toast {
      top: calc(60px + env(safe-area-inset-top, 0px));
      bottom: auto;
    }
  }
</style>
</head>
<body>
<div id="root"></div>
<script type="module" src="/client.js"></script>
</body>
</html>`;

// ---- PWA: manifest + service worker ----
// Served so the app is installable on a phone (Android Chrome) and can receive
// push notifications when closed. NOTE: Service Workers + Push only work over a
// secure context — open diffshub via its https://<host>.ts.net `tailscale serve`
// URL, not http://<tailnet-ip>:port.
const MANIFEST_JSON = JSON.stringify({
  name: "diffshub",
  short_name: "diffshub",
  start_url: "/",
  scope: "/",
  display: "standalone",
  background_color: "#1c1c1f",
  theme_color: "#6e56cf",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
});

// The push handler shows the notification; clicking it focuses an open diffshub
// tab (or opens one) at the payload's url.
const SW_JS = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
// A registered fetch handler (even a no-op) makes Android Chrome treat this as an
// installable PWA rather than a plain home-screen shortcut.
self.addEventListener("fetch", () => {});
self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) { d = { body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(d.title || "diffshub", {
    body: d.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: d.tag || "diffshub",
    renotify: true,
    data: { url: d.url || "/" },
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // Reuse an open diffshub window: focus it and navigate to the chat. A full
    // navigate reloads the SPA, which reads the ?home=…&dir=… deep link on boot.
    // If navigate is unavailable or rejects (uncontrolled client), fall through
    // to opening a fresh window at the URL rather than focusing the stale view.
    for (const c of wins) {
      if ("focus" in c) {
        await c.focus();
        if ("navigate" in c) {
          try { await c.navigate(url); return; } catch (_) {}
        }
        break;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});
`;

// ---- Web Push crypto (RFC 8291 aes128gcm payload + RFC 8292 VAPID) ----
// A P-256 VAPID keypair is minted once and persisted; its public key is handed to
// the browser as the applicationServerKey. Each payload is ECDH-encrypted to the
// subscription's keys and POSTed to its endpoint (FCM for Chrome). No Firebase
// project or server key needed — VAPID is the whole auth story.
const b64url = (b: Buffer) => b.toString("base64url");
const fromB64url = (s: string) => Buffer.from(s, "base64url");

const vapidPath = `${stateDir}/vapid.json`;
let vapid: { publicKey: string; privateKeyPem: string };
try {
  vapid = JSON.parse(readFileSync(vapidPath, "utf8"));
} catch {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  // applicationServerKey is the uncompressed point: 0x04 || X || Y.
  const pub = Buffer.concat([Buffer.from([0x04]), fromB64url(jwk.x), fromB64url(jwk.y)]);
  vapid = {
    publicKey: b64url(pub),
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }) as string,
  };
  writeFileSync(vapidPath, JSON.stringify(vapid));
}
const vapidPrivateKey = crypto.createPrivateKey(vapid.privateKeyPem);

// HKDF-SHA256 (RFC 5869). Outputs here are ≤32 bytes but the loop stays general.
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = crypto.createHmac("sha256", salt).update(ikm).digest();
  const chunks: Buffer[] = [];
  let prev = Buffer.alloc(0);
  for (let i = 0; i < Math.ceil(length / 32); i++) {
    prev = crypto
      .createHmac("sha256", prk)
      .update(Buffer.concat([prev, info, Buffer.from([i + 1])]))
      .digest();
    chunks.push(prev);
  }
  return Buffer.concat(chunks).subarray(0, length);
}

// Encrypt `payload` for one subscription using aes128gcm (RFC 8291 §3.4 + 8188).
function encryptPayload(sub: PushSub, payload: Buffer): Buffer {
  const uaPublic = fromB64url(sub.p256dh); // browser ECDH public key (65 bytes)
  const authSecret = fromB64url(sub.auth); // 16-byte shared auth secret
  const salt = crypto.randomBytes(16);

  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey(); // our ephemeral public key (65 bytes)
  const sharedSecret = ecdh.computeSecret(uaPublic);

  const ikm = hkdf(
    authSecret,
    sharedSecret,
    Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]),
    32,
  );
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);

  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(payload),
    cipher.update(Buffer.from([0x02])), // single-record padding delimiter
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  // RFC 8188 header: salt(16) | record-size(u32) | keyid-len(1) | keyid(as_public)
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ciphertext]);
}

// VAPID Authorization header: an ES256 JWT signed with our private key.
function vapidAuthHeader(endpoint: string): string {
  const aud = new URL(endpoint).origin;
  const head = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64url(
    Buffer.from(
      JSON.stringify({
        aud,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: "mailto:miguelacero528@gmail.com",
      }),
    ),
  );
  const signingInput = `${head}.${body}`;
  const sig = crypto.sign("sha256", Buffer.from(signingInput), {
    key: vapidPrivateKey,
    dsaEncoding: "ieee-p1363", // raw r||s, as JOSE requires
  });
  return `vapid t=${signingInput}.${b64url(sig)}, k=${vapid.publicKey}`;
}

async function sendPush(sub: PushSub, payload: object): Promise<{ ok: boolean; gone: boolean }> {
  try {
    const encrypted = encryptPayload(sub, Buffer.from(JSON.stringify(payload)));
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: vapidAuthHeader(sub.endpoint),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "86400",
      },
      body: encrypted.buffer.slice(
        encrypted.byteOffset,
        encrypted.byteOffset + encrypted.byteLength,
      ) as ArrayBuffer,
    });
    return { ok: res.ok, gone: res.status === 404 || res.status === 410 };
  } catch {
    return { ok: false, gone: false };
  }
}

// Fan a notification out to every stored subscription; prune dead endpoints.
async function notifyAll(payload: {
  title: string;
  body?: string;
  url?: string;
  tag?: string;
}): Promise<{ sent: number; failed: number }> {
  const subs = listSubsStmt.all();
  let sent = 0;
  let failed = 0;
  await Promise.all(
    subs.map(async (s) => {
      const r = await sendPush(s, payload);
      if (r.ok) sent++;
      else {
        failed++;
        if (r.gone) deleteSubStmt.run(s.endpoint);
      }
    }),
  );
  return { sent, failed };
}

// Resolve a tmux session name to its clean chat title (claude's current task) and
// cwd, so a notification can name the chat and deep-link to its directory. Empty
// fields if the pane can't be read.
async function sessionInfo(name: string): Promise<{ task: string; cwd: string }> {
  try {
    const SEP = "\x1f";
    const info = (
      await $`tmux -L default display-message -p -t ${`${name}:0.0`} ${["#{pane_title}", "#{pane_current_command}", "#{pane_current_path}"].join(SEP)}`
        .quiet()
        .text()
    ).trim();
    const [title, cmd, cwd] = info.split(SEP);
    return { task: cleanTitle(title ?? "", name, cmd ?? ""), cwd: cwd ?? "" };
  } catch {
    return { task: "", cwd: "" };
  }
}

// Map a session's cwd to the registered directory it belongs under, choosing the
// most specific (longest) match — mirrors the client's dir-scoping of the Tmux
// tab. Returns null when the cwd sits outside every registered directory. The
// notification deep-link needs this so the app opens the right directory and the
// target session is in scope (otherwise the Tmux tab snaps to a different chat).
function dirIdForCwd(cwd: string): number | null {
  if (!cwd) return null;
  let best: { id: number; len: number } | null = null;
  for (const d of listDirsStmt.all()) {
    if (cwd === d.path || cwd.startsWith(`${d.path}/`)) {
      if (!best || d.path.length > best.len) best = { id: d.id, len: d.path.length };
    }
  }
  return best?.id ?? null;
}

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

    // ---- PWA assets + Web Push API ----
    if (url.pathname === "/manifest.webmanifest") {
      return new Response(MANIFEST_JSON, {
        headers: { "Content-Type": "application/manifest+json", ...CORS },
      });
    }
    if (url.pathname === "/sw.js") {
      return new Response(SW_JS, {
        headers: {
          "Content-Type": "text/javascript; charset=utf-8",
          "Service-Worker-Allowed": "/",
          "Cache-Control": "no-cache",
        },
      });
    }
    if (url.pathname === "/icon-192.png" || url.pathname === "/icon-512.png") {
      return new Response(Bun.file(`${here}${url.pathname}`), {
        headers: { "Cache-Control": "public, max-age=86400" },
      });
    }
    // The browser fetches the applicationServerKey before subscribing.
    if (url.pathname === "/api/push/vapid" && req.method === "GET") {
      return json({ publicKey: vapid.publicKey, count: countSubsStmt.get()?.n ?? 0 });
    }
    if (url.pathname === "/api/push/subscribe" && req.method === "POST") {
      let b: any;
      try {
        b = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      const endpoint = b?.endpoint;
      const p256dh = b?.keys?.p256dh;
      const auth = b?.keys?.auth;
      if (typeof endpoint !== "string" || typeof p256dh !== "string" || typeof auth !== "string") {
        return json({ error: "Invalid subscription" }, 400);
      }
      upsertSubStmt.run(endpoint, p256dh, auth, Date.now());
      return json({ ok: true });
    }
    if (url.pathname === "/api/push/unsubscribe" && req.method === "POST") {
      let b: any;
      try {
        b = await req.json();
      } catch {
        b = {};
      }
      if (typeof b?.endpoint === "string") deleteSubStmt.run(b.endpoint);
      return json({ ok: true });
    }
    // Fire a push to every subscribed device. The Claude `Stop`/`Notification`
    // hooks POST here (from localhost) with a tmux `session` + `kind`; open to any
    // tailnet caller. When a session is given we label the push with that chat's
    // task and deep-link the tap to the Home tab with that chat open; otherwise
    // raw title/body/url.
    if (url.pathname === "/api/notify" && req.method === "POST") {
      let b: any;
      try {
        b = await req.json();
      } catch {
        b = {};
      }
      const session = typeof b?.session === "string" ? b.session.trim() : "";
      const kind = b?.kind === "ask" ? "ask" : b?.kind === "stop" ? "stop" : "";
      let payload: { title: string; body: string; url: string; tag?: string };
      if (session) {
        const { task, cwd } = await sessionInfo(session);
        const dirId = dirIdForCwd(cwd);
        const dirParam = dirId != null ? `&dir=${dirId}` : "";
        payload = {
          title: task || session,
          body: kind === "ask" ? "Needs your input" : kind === "stop" ? "Finished" : task ? session : "",
          // Pin the directory so the deep-linked session is in the Home tab's
          // dir-scoped list and doesn't get dropped from the open chat on load.
          url: `/?home=${encodeURIComponent(session)}${dirParam}`,
          tag: `claude-${session}`, // same chat ⇒ later status replaces the earlier
        };
      } else {
        payload = {
          title: typeof b?.title === "string" && b.title.trim() ? b.title.trim() : "diffshub",
          body: typeof b?.body === "string" ? b.body : "",
          url: typeof b?.url === "string" ? b.url : "/",
          tag: typeof b?.tag === "string" ? b.tag : undefined,
        };
      }
      const r = await notifyAll(payload);
      return json({ ...r, subscribers: countSubsStmt.get()?.n ?? 0 });
    }

    // The Stop hook posts here when a Claude session finishes a turn, forwarding the
    // raw hook JSON. We stamp session_ends[session_id] = now so the Home/sidebar lists
    // order idle sessions by when they most recently ended (steadier than transcript
    // mtime, which also moves mid-turn). session_id is the transcript's UUID, which is
    // how listClaudeSessions joins it back. Best-effort: always 200, even on no id.
    if (url.pathname === "/api/session-ended" && req.method === "POST") {
      let b: any;
      try {
        b = await req.json();
      } catch {
        b = {};
      }
      const sid =
        typeof b?.session_id === "string" && b.session_id.trim()
          ? b.session_id.trim()
          : typeof b?.transcript_path === "string"
            ? (b.transcript_path.split("/").pop() ?? "").replace(/\.jsonl$/, "")
            : "";
      if (sid) {
        const now = Date.now();
        upsertSessionEndStmt.run(sid, typeof b?.cwd === "string" ? b.cwd : "", now);
        pruneSessionEndsStmt.run(now - 60 * 86_400_000); // drop ends older than 60d
      }
      return json({ ok: !!sid });
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

    // Force a full rebuild of a directory's @-file index (the "Reindex" button).
    // Normally the index self-syncs on every Changes refresh; this is the manual
    // escape hatch — re-collects from git and replaces all rows in one shot.
    const reindexMatch = url.pathname.match(/^\/api\/dirs\/(\d+)\/reindex$/);
    if (reindexMatch && req.method === "POST") {
      const id = parseInt(reindexMatch[1], 10);
      const row = getDirStmt.get(id);
      if (!row) return json({ error: "No such directory" }, 404);
      let paths: string[];
      try {
        const { repos, isWorkspace } = await resolveMembers(row.path, parseRepos(row.repos));
        paths = await collectFiles(repos, isWorkspace);
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
      if (paths.length > MAX_INDEX_FILES) {
        return json({ error: new TooManyFiles(paths.length).message }, 400);
      }
      db.transaction(() => {
        db.run("DELETE FROM files WHERE dir_id = ?", [id]);
        for (const p of paths) insertFileStmt.run(id, p);
      })();
      invalidateWorkspace(id);
      return json({ ok: true, count: paths.length });
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
      if (
        action !== "stage" &&
        action !== "unstage" &&
        action !== "stash" &&
        action !== "save-patch"
      ) {
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
        if (action === "save-patch") {
          const files: string[] = [];
          for (const dir of dirs) {
            const rel = await savePatch(dir);
            if (rel) files.push(rel);
          }
          return json({ ok: true, files });
        }
        for (const dir of dirs) await runGitAction(action, dir, path as string | undefined);
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
      return json({ ok: true });
    }

    // Remove one or more linked worktrees (`git worktree remove`). The main
    // working tree is refused both here and in the UI. `--force` so trees with
    // pending/untracked changes still go — the client confirms before calling.
    if (req.method === "POST" && url.pathname === "/api/worktree/remove") {
      let ws: Workspace;
      try {
        ws = await wsFromReq(url);
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
      let body: { worktree?: unknown; worktrees?: unknown };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      const dirs =
        Array.isArray(body.worktrees)
          ? [...new Set(body.worktrees.filter((d): d is string => typeof d === "string"))]
          : typeof body.worktree === "string"
            ? [body.worktree]
            : [];
      if (!dirs.length) return json({ error: "Missing worktree" }, 400);
      const unknown = dirs.find((dir) => !ws.worktreeDirs.has(dir));
      if (unknown) return json({ error: `Unknown worktree: ${unknown}` }, 400);

      const targets: { dir: string; repoDir: string }[] = [];
      for (const dir of dirs) {
        const info = await repoOfWorktree(ws, dir);
        if (!info) return json({ error: `Worktree not found: ${dir}` }, 404);
        if (info.isMain) return json({ error: `Can't remove the main worktree: ${dir}` }, 400);
        targets.push({ dir, repoDir: info.repoDir });
      }
      const removed: string[] = [];
      try {
        for (const target of targets) {
          await $`git -C ${target.repoDir} worktree remove --force ${target.dir}`.quiet();
          removed.push(target.dir);
          ws.worktreeDirs.delete(target.dir);
        }
      } catch (e) {
        return json({ error: errText(e), removed }, 500);
      }
      return json({ ok: true, removed });
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

    // Agent usage windows. Claude comes from the statusline hook's
    // ~/.claude/rate-limits.json; Codex comes from the newest rollout token_count
    // event with rate_limits metadata.
    if (req.method === "GET" && url.pathname === "/api/usage") {
      try {
        const [claude, codex] = await Promise.all([readClaudeUsage(), readCodexUsage()]);
        return json({
          ...claude,
          claude,
          codex,
        });
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
    }

    // Save a pasted image (base64 data URL or bare base64) to /tmp/images/<random>
    // and return its absolute path, so the New session prompt can reference
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

    if (req.method === "GET" && url.pathname === "/api/template-prompts") {
      let ws: Workspace;
      try {
        ws = await wsFromReq(url);
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
      return json(
        listTemplatePromptsStmt.all(ws.id).map((p) => ({
          id: p.id,
          title: p.title,
          body: p.body,
          createdAt: p.created_at,
          updatedAt: p.updated_at,
        })),
      );
    }

    if (req.method === "POST" && url.pathname === "/api/template-prompts") {
      let ws: Workspace;
      try {
        ws = await wsFromReq(url);
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
      let body: { title?: unknown; body?: unknown };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      const promptBody = typeof body.body === "string" ? body.body.trim() : "";
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!promptBody) return json({ error: "Empty prompt" }, 400);
      if (!title) return json({ error: "Empty title" }, 400);
      const now = Date.now();
      const id = insertTemplatePromptStmt.get(ws.id, title, promptBody, now, now)!.id;
      const row = getTemplatePromptStmt.get(id, ws.id)!;
      return json({
        id: row.id,
        title: row.title,
        body: row.body,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }

    const promptMatch = url.pathname.match(/^\/api\/template-prompts\/(\d+)$/);
    if (promptMatch && (req.method === "PUT" || req.method === "DELETE")) {
      let ws: Workspace;
      try {
        ws = await wsFromReq(url);
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
      const id = Number(promptMatch[1]);
      if (!Number.isInteger(id) || id < 1) return json({ error: "Invalid id" }, 400);
      const existing = getTemplatePromptStmt.get(id, ws.id);
      if (!existing) return json({ error: "Prompt not found" }, 404);
      if (req.method === "DELETE") {
        deleteTemplatePromptStmt.run(id, ws.id);
        return json({ ok: true });
      }
      let body: { title?: unknown; body?: unknown };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      const promptBody = typeof body.body === "string" ? body.body.trim() : "";
      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!promptBody) return json({ error: "Empty prompt" }, 400);
      if (!title) return json({ error: "Empty title" }, 400);
      updateTemplatePromptStmt.run(title, promptBody, Date.now(), id, ws.id);
      const row = getTemplatePromptStmt.get(id, ws.id)!;
      return json({
        id: row.id,
        title: row.title,
        body: row.body,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }

    if (req.method === "POST" && url.pathname === "/api/claude") {
      let ws: Workspace;
      try {
        ws = await wsFromReq(url);
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
      let body: { prompt?: unknown; effort?: unknown; chrome?: unknown; agent?: unknown };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      if (typeof body.prompt !== "string" || !body.prompt.trim()) {
        return json({ error: "Empty prompt" }, 400);
      }
      const agent: "claude" | "codex" = body.agent === "codex" ? "codex" : "claude";
      // Allowlisted so it's safe to splice straight into the shell command, and so a
      // bad value falls back to the global default rather than erroring the launch.
      const effort =
        typeof body.effort === "string" &&
        (agent === "codex" ? CODEX_EFFORTS : CLAUDE_EFFORTS).has(body.effort)
          ? body.effort
          : undefined;
      const chrome = agent === "claude" && body.chrome === true;
      // Offline → enqueue instead of launching a session that couldn't reach the
      // API. drainQueue() launches it (as its agent) automatically once we're online.
      if (!(await checkOnline(true))) {
        const id = insertQueuedStmt.get(ws.id, body.prompt, Date.now(), agent, effort ?? null, chrome ? 1 : 0)!.id;
        return json({ ok: true, queued: true, id });
      }
      try {
        const session =
          agent === "codex"
            ? await newCodexSession(ws.path, body.prompt, effort)
            : await newClaudeSession(ws.path, body.prompt, effort, chrome);
        return json({ ok: true, session });
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
    }

    // The closed claude sessions in the active directory available to resume
    // (powers the resume dialog's list — see resumableSessions).
    if (req.method === "GET" && url.pathname === "/api/claude/resumable") {
      let ws: Workspace;
      try {
        ws = await wsFromReq(url);
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
      try {
        return json({ sessions: await resumableSessions(ws.path), cwd: ws.path });
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
    }

    // Resume a closed claude session by id: launch `claude --resume <sid>` in a
    // fresh detached tmux session in the active directory.
    if (req.method === "POST" && url.pathname === "/api/claude/resume") {
      let ws: Workspace;
      try {
        ws = await wsFromReq(url);
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
      let body: { sid?: unknown };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      const sid = typeof body.sid === "string" ? body.sid.trim() : "";
      if (!/^[0-9a-fA-F-]{8,}$/.test(sid)) return json({ error: "Invalid session id" }, 400);
      // claude needs the API to do anything; don't spawn a session that can't reach it.
      if (!(await checkOnline(true))) return json({ error: "You're offline" }, 503);
      try {
        const session = await resumeClaudeSession(ws.path, sid);
        return json({ ok: true, session });
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
    }

    // ---- Tmux tab ----
    // List claude tmux sessions (global, not dir-scoped) with transcript status.
    if (req.method === "GET" && url.pathname === "/api/tmux/sessions") {
      try {
        const sessions = (await listClaudeSessions()).map(publicTmuxSession);
        return json({
          sessions,
          queued: listQueuedSessions(),
          online: onlineState.online,
        });
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
    }

    // ---- Subway tab ----
    // One-shot pseudo-offline snapshot: latest messages for up to 10 non-busy
    // Claude sessions and 10 non-busy Codex sessions in the selected directory.
    if (req.method === "GET" && url.pathname === "/api/subway/snapshot") {
      let ws: Workspace;
      try {
        ws = await wsFromReq(url);
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
      try {
        return json(await subwaySnapshot(ws));
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
    }

    // Execute one Subway queued action. Deletes are idempotent so an already-gone
    // session drains cleanly; Keep persists a Subway dismissal without touching
    // tmux; replies still fail if the target pane disappeared.
    if (req.method === "POST" && url.pathname === "/api/subway/action") {
      let body: { kind?: unknown; session?: unknown; sessionId?: unknown; agent?: unknown; cwd?: unknown; text?: unknown };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      if (typeof body.session !== "string" || !body.session) {
        return json({ error: "Missing session" }, 400);
      }
      if (body.kind === "keep") {
        let ws: Workspace;
        try {
          ws = await wsFromReq(url);
        } catch (e) {
          return json({ error: errText(e) }, 500);
        }
        const now = Date.now();
        const sid =
          typeof body.sessionId === "string" && body.sessionId.trim()
            ? body.sessionId.trim()
            : body.session;
        upsertSubwayKeptStmt.run(
          ws.id,
          sid,
          body.session,
          typeof body.cwd === "string" ? body.cwd : "",
          body.agent === "codex" ? "codex" : "claude",
          now,
        );
        pruneSubwayKeptStmt.run(now - 60 * 86_400_000);
        return json({ ok: true });
      }
      if (body.kind === "delete") {
        try {
          await $`tmux -L default has-session -t ${body.session}`.quiet();
        } catch {
          return json({ ok: true, gone: true });
        }
        try {
          await $`tmux -L default kill-session -t ${body.session}`.quiet();
          return json({ ok: true });
        } catch (e) {
          return json({ error: errText(e) }, 500);
        }
      }
      if (body.kind === "reply") {
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
      return json({ error: "Invalid action" }, 400);
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
      const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "500", 10) || 500, 1), 1000);
      try {
        const SEP = "\x1f";
        const info = (
          await $`tmux -L default display-message -p -t ${`${name}:0.0`} ${["#{pane_current_path}", "#{@claude_session}", "#{pane_current_command}", "#{pane_title}", "#{@codex_session}"].join(SEP)}`.quiet().text()
        ).trim();
        const [cwd, claudeSid, cmd, paneTitle, codexSid] = info.split(SEP);
        const agent = agentOf(cmd ?? "", codexSid ?? "");
        // codex: resolve to its rollout and parse codex's schema. It runs
        // autonomously (no claude-style interactive prompts), so there's no pending
        // prompt to capture.
        if (agent === "codex") {
          const path = await resolveCodexTranscript(cwd ?? "", codexSid ?? "");
          if (!path || !existsSync(path)) {
            return json({ session: name, cwd, sessionId: codexSid ?? "", path: null, messages: [], model: "", title: "", total: 0, pendingPane: null, pendingPrompt: null });
          }
          const text = await Bun.file(path).text();
          const { messages, model, title, total } = parseCodexTranscript(text, limit);
          return json({ session: name, cwd, sessionId: codexSid ?? "", path, messages, model, title, total, pendingPane: null, pendingPrompt: null });
        }
        const sid = claudeSid;
        const task = cleanTitle(paneTitle ?? "", name, cmd ?? "");
        // An idle pane (no braille spinner) may be blocked on an interactive
        // prompt that isn't in the transcript yet — capture it from the live pane
        // so the question doesn't go unseen until it's answered.
        const busy = /^[⠀-⣿]/u.test(paneTitle ?? "");
        const pendingPane = busy ? null : await capturePendingPrompt(name);
        // Parse the raw pane into renderable controls; pendingPane stays as the
        // always-correct fallback the client can drop back to ("show raw pane").
        // For a single-select with option previews, fill in every option's art (the
        // capture only has the focused one) — once per prompt, cached thereafter.
        const parsedPrompt = parsePendingPrompt(pendingPane);
        const pendingPrompt = parsedPrompt ? await enrichSinglePreviews(name, parsedPrompt) : parsedPrompt;
        const path = await resolveTranscript(cwd ?? "", sid ?? "", task);
        if (!path || !existsSync(path)) {
          return json({ session: name, cwd, sessionId: sid, path: null, messages: [], model: "", title: "", total: 0, pendingPane, pendingPrompt });
        }
        const text = await Bun.file(path).text();
        const { messages, model, title, total } = parseTranscript(text, limit);
        return json({ session: name, cwd, sessionId: sid, path, messages, model, title, total, pendingPane, pendingPrompt });
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

    // Serve the live contents of an HTML artifact a session has been building
    // (the "agents folder" pattern: an agent writes/appends a single .html file
    // across many edits). The client finds the path from the transcript's
    // Write/Edit tool calls and the Home chat's "Open HTML" button renders this in
    // a sandboxed iframe. The requested path is resolved against the session cwd
    // and must stay inside it, so a crafted ?path can't read arbitrary files.
    if (req.method === "GET" && url.pathname === "/api/tmux/html") {
      const name = url.searchParams.get("session") ?? "";
      const want = url.searchParams.get("path") ?? "";
      if (!name || !want) return json({ error: "Missing session or path" }, 400);
      try {
        const cwd = (
          await $`tmux -L default display-message -p -t ${`${name}:0.0`} ${"#{pane_current_path}"}`.quiet().text()
        ).trim();
        if (!cwd) return json({ error: "No such session" }, 404);
        const abs = resolve(cwd, want);
        if (abs !== cwd && !abs.startsWith(cwd + sep)) return json({ error: "Path outside session" }, 403);
        if (!/\.html?$/i.test(abs)) return json({ error: "Not an HTML file" }, 400);
        if (!existsSync(abs)) return json({ error: "File not found" }, 404);
        const html = await Bun.file(abs).text();
        // Rewrite local asset refs (sibling images/css/js/fonts) to absolute
        // /api/tmux/asset URLs so they resolve inside the srcDoc iframe — a bare
        // relative ref there resolves against the diffshub origin, not this file's
        // folder, so it would otherwise 404 into the SPA fallback.
        const rewritten = rewriteLocalAssets(html, dirname(abs), cwd, name);
        return new Response(rewritten, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            // Live file — the client polls while the preview is open, so never cache.
            "Cache-Control": "no-store",
          },
        });
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
    }

    // Serve a single asset (image/css/js/font/…) sitting next to a previewed HTML
    // artifact, so the srcDoc preview's rewritten refs resolve. Same session-cwd
    // escape guard as /api/tmux/html; `path` is the absolute file path embedded by
    // rewriteLocalAssets. Same-origin as the diffshub page → works over the https
    // tailscale URL. CORS is set so CSS @font-face fetches (always CORS-checked,
    // and issued from the sandboxed iframe's opaque origin) succeed.
    if (req.method === "GET" && url.pathname === "/api/tmux/asset") {
      const name = url.searchParams.get("session") ?? "";
      const want = url.searchParams.get("path") ?? "";
      if (!name || !want) return json({ error: "Missing session or path" }, 400);
      try {
        const cwd = (
          await $`tmux -L default display-message -p -t ${`${name}:0.0`} ${"#{pane_current_path}"}`.quiet().text()
        ).trim();
        if (!cwd) return json({ error: "No such session" }, 404);
        const abs = resolve(cwd, want);
        if (abs !== cwd && !abs.startsWith(cwd + sep)) return json({ error: "Path outside session" }, 403);
        if (!existsSync(abs) || !statSync(abs).isFile()) return json({ error: "File not found" }, 404);
        const file = Bun.file(abs);
        return new Response(file, {
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            "Cache-Control": "no-store",
            ...CORS,
          },
        });
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
    }

    // ---- HTML reports (agents/**/*.html under the active workspace) ----
    // List reports for the sidebar. Returns the resolved dir id so the client can
    // build /api/html/raw/<dir>/… URLs even when no ?dir= was supplied.
    if (req.method === "GET" && url.pathname === "/api/html/list") {
      let ws: Workspace;
      try {
        ws = await wsFromReq(url);
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
      return json({ dirId: ws.id, files: listAgentHtml(ws.path) });
    }

    // Serve a report (HTML, with the vim-key layer injected) or one of its sibling
    // assets (image/css/font/…) by URL, so the report's relative refs resolve under
    // the same /api/html/raw/<dir>/ prefix. The path is validated to stay in the dir.
    const htmlRawMatch = url.pathname.match(/^\/api\/html\/raw\/(\d+)\/(.+)$/);
    if (req.method === "GET" && htmlRawMatch) {
      const row = getDirStmt.get(parseInt(htmlRawMatch[1], 10));
      if (!row) return new Response("Unknown directory", { status: 404 });
      const root = row.path;
      let rel: string;
      try {
        rel = decodeURIComponent(htmlRawMatch[2]);
      } catch {
        return new Response("Bad path", { status: 400 });
      }
      // Confine serving to agents/ — reports and their sibling assets live there,
      // and this keeps the route from handing out .git/, .env, source, etc. even
      // though they sit under the same workspace root.
      const abs = resolve(root, rel);
      const agentsDir = `${root}/agents`;
      if (abs !== agentsDir && !abs.startsWith(agentsDir + sep))
        return new Response("Forbidden", { status: 403 });
      if (!existsSync(abs) || !statSync(abs).isFile()) return new Response("Not found", { status: 404 });
      if (/\.html?$/i.test(abs)) {
        return new Response(injectReportShortcuts(await Bun.file(abs).text()), {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
      const file = Bun.file(abs);
      return new Response(file, {
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "Cache-Control": "no-store",
          ...CORS,
        },
      });
    }

    // Rename a report (mv) within agents/ under the active dir — { dir, from, to }.
    if (req.method === "POST" && url.pathname === "/api/html/rename") {
      let body: { dir?: unknown; from?: unknown; to?: unknown };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      const root = htmlRootFromDir(body.dir);
      if (!root) return json({ error: "Unknown directory" }, 404);
      const from = htmlSafePath(root, body.from);
      const to = htmlSafePath(root, body.to);
      if (!from || !to) return json({ error: "Invalid path" }, 400);
      if (!existsSync(from)) return json({ error: "Source not found" }, 404);
      if (existsSync(to)) return json({ error: "Target already exists" }, 409);
      try {
        await $`mkdir -p ${dirname(to)}`.quiet();
        await $`mv ${from} ${to}`.quiet();
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
      return json({ ok: true });
    }

    // Delete a report — { dir, path }, restricted to agents/ under the active dir.
    if (req.method === "POST" && url.pathname === "/api/html/delete") {
      let body: { dir?: unknown; path?: unknown };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      const root = htmlRootFromDir(body.dir);
      if (!root) return json({ error: "Unknown directory" }, 404);
      const abs = htmlSafePath(root, body.path);
      if (!abs) return json({ error: "Invalid path" }, 400);
      if (!existsSync(abs)) return json({ error: "Not found" }, 404);
      try {
        unlinkSync(abs);
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
      return json({ ok: true });
    }

    // Publish an HTML artifact to the public R2 bucket and return a cdn link.
    // Uploads any local, non-base64 image assets it references (rewriting their
    // URLs), then the HTML itself, via the wrangler CLI. Idempotent per file:
    // the share is keyed by the artifact's absolute path, so re-sharing returns
    // the same stable link — and skips the upload entirely when the contents
    // haven't changed since last time (see the shares table).
    if (req.method === "POST" && url.pathname === "/api/tmux/share") {
      let body: { session?: unknown; path?: unknown };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      const name = typeof body.session === "string" ? body.session : "";
      const want = typeof body.path === "string" ? body.path : "";
      if (!name || !want) return json({ error: "Missing session or path" }, 400);
      try {
        const cwd = (
          await $`tmux -L default display-message -p -t ${`${name}:0.0`} ${"#{pane_current_path}"}`.quiet().text()
        ).trim();
        if (!cwd) return json({ error: "No such session" }, 404);
        const abs = resolve(cwd, want);
        if (abs !== cwd && !abs.startsWith(cwd + sep)) return json({ error: "Path outside session" }, 403);
        if (!/\.html?$/i.test(abs)) return json({ error: "Not an HTML file" }, 400);
        if (!existsSync(abs)) return json({ error: "File not found" }, 404);
        const html = await Bun.file(abs).text();
        const hash = crypto.createHash("sha256").update(html).digest("hex");
        const existing = getShareStmt.get(abs);
        // Unchanged since the last share → hand back the existing link, no upload.
        if (existing && existing.content_hash === hash) {
          return json({ url: existing.url, alreadyShared: true, assets: 0, skipped: [] });
        }
        // Reuse the prior id so edits re-upload in place and the URL stays stable.
        const shareId = existing?.share_id ?? crypto.randomBytes(6).toString("hex");
        const { html: rewritten, uploaded, skipped, keys } = await uploadHtmlAssets(
          html,
          dirname(abs),
          cwd,
          shareId,
        );
        const htmlKey = `${R2_PREFIX}/${shareId}.html`;
        await r2Put(htmlKey, rewritten, "text/html; charset=utf-8");
        const shareUrl = `${R2_PUBLIC_BASE}/${htmlKey}`;
        const now = Date.now();
        upsertShareStmt.run(
          abs,
          shareId,
          shareUrl,
          hash,
          JSON.stringify(keys),
          existing?.created_at ?? now,
          now,
        );
        return json({ url: shareUrl, alreadyShared: false, assets: uploaded.length, skipped });
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
    }

    // Undo a share: delete the published HTML object (and any image assets it
    // uploaded) from R2, then drop the sqlite row so the link is fully retracted.
    // Keyed by the artifact path, like /api/tmux/share. A no-op (still 200) when
    // the file was never shared, so Undo is always safe to call.
    if (req.method === "POST" && url.pathname === "/api/tmux/unshare") {
      let body: { session?: unknown; path?: unknown };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      const name = typeof body.session === "string" ? body.session : "";
      const want = typeof body.path === "string" ? body.path : "";
      if (!name || !want) return json({ error: "Missing session or path" }, 400);
      try {
        const cwd = (
          await $`tmux -L default display-message -p -t ${`${name}:0.0`} ${"#{pane_current_path}"}`.quiet().text()
        ).trim();
        if (!cwd) return json({ error: "No such session" }, 404);
        const abs = resolve(cwd, want);
        if (abs !== cwd && !abs.startsWith(cwd + sep)) return json({ error: "Path outside session" }, 403);
        const existing = getShareStmt.get(abs);
        if (!existing) return json({ ok: true, removed: false });
        let assetKeys: string[] = [];
        try {
          assetKeys = JSON.parse(existing.asset_keys || "[]");
        } catch { }
        // HTML first, then its assets — deleting a missing key is a no-op.
        for (const key of [`${R2_PREFIX}/${existing.share_id}.html`, ...assetKeys]) {
          await r2Delete(key);
        }
        deleteShareStmt.run(abs);
        return json({ ok: true, removed: true });
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

    // Answer a live multi-select AskUserQuestion from the web checkboxes: toggle the
    // pane's options to match `selected` (1-based indices to end up checked), verify,
    // then submit. The heavy lifting + safety checks live in answerMultiSelect.
    if (req.method === "POST" && url.pathname === "/api/tmux/answer-multi") {
      let body: { session?: unknown; selected?: unknown };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      if (typeof body.session !== "string" || !body.session) {
        return json({ error: "Missing session" }, 400);
      }
      const selected = Array.isArray(body.selected)
        ? body.selected.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0)
        : null;
      if (!selected) return json({ error: "Missing selected" }, 400);
      try {
        const res = await answerMultiSelect(body.session, selected);
        return res.ok ? json({ ok: true }) : json({ error: res.error ?? "answer failed" }, 409);
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
    }

    // Send a single bare key into a pane (e.g. Enter to clear claude's "Ready to
    // submit your answers?" gate). Allowlisted to navigation/confirm keys so this
    // can't be used to inject arbitrary input — text goes through /api/tmux/send.
    if (req.method === "POST" && url.pathname === "/api/tmux/key") {
      let body: { session?: unknown; key?: unknown };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      if (typeof body.session !== "string" || !body.session) {
        return json({ error: "Missing session" }, 400);
      }
      const ALLOWED = new Set(["Enter", "Escape", "Up", "Down", "Left", "Right", "Space"]);
      if (typeof body.key !== "string" || !ALLOWED.has(body.key)) {
        return json({ error: "Invalid key" }, 400);
      }
      try {
        await $`tmux -L default send-keys -t ${`${body.session}:0.0`} ${body.key}`.quiet();
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
        // All spawns here either fork-and-return (GUI editors, `open`) or are
        // quick nvim remote calls — none block on a live TUI, so awaiting is safe.
        await launchEditor(`${dir}/${body.path}`, line, dir);
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
