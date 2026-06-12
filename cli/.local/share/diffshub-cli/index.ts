#!/usr/bin/env bun

import { $ } from "bun";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const cwd = process.cwd();
const port = parseInt(process.argv[2] || "3433", 10); // 3433 = DIFF on a phone keypad
const here = dirname(fileURLToPath(import.meta.url));

// Resolve the GitHub repo from wherever the server was launched
let repo: string;
try {
  repo = (await $`gh repo view --json nameWithOwner -q .nameWithOwner`.cwd(cwd).quiet().text()).trim();
} catch {
  console.error("diffshub: `gh repo view` failed — run from a repo with a GitHub remote (and `gh auth login`)");
  process.exit(1);
}

let branch = "";
try {
  branch = (await $`git branch --show-current`.cwd(cwd).quiet().text()).trim();
} catch {}

// Reviewed-commit tracking, persisted per repo in a local SQLite db
const stateDir = `${process.env.HOME}/.local/state/diffshub`;
mkdirSync(stateDir, { recursive: true });
const db = new Database(`${stateDir}/diffshub.sqlite`);
db.run(`CREATE TABLE IF NOT EXISTS reviewed (
  repo TEXT NOT NULL,
  sha TEXT NOT NULL,
  reviewed_at INTEGER NOT NULL,
  PRIMARY KEY (repo, sha)
)`);
const listReviewedStmt = db.query<{ sha: string }, [string]>(
  "SELECT sha FROM reviewed WHERE repo = ?",
);
const markReviewedStmt = db.query(
  "INSERT OR REPLACE INTO reviewed (repo, sha, reviewed_at) VALUES (?, ?, ?)",
);
const unmarkReviewedStmt = db.query("DELETE FROM reviewed WHERE repo = ? AND sha = ?");

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

interface CommitSummary {
  sha: string;
  message: string;
  author: string;
  login: string | null;
  avatar: string | null;
  date: string;
}

async function listCommits(page: number): Promise<CommitSummary[]> {
  const base = `repos/${repo}/commits?per_page=50&page=${page}`;
  // Prefer the checked-out branch; fall back to the default branch if it
  // isn't pushed to GitHub.
  const urls = branch ? [`${base}&sha=${encodeURIComponent(branch)}`, base] : [base];
  let lastError: unknown;
  for (const url of urls) {
    try {
      const raw = await $`gh api ${url}`.cwd(cwd).quiet().text();
      return JSON.parse(raw).map((c: any) => ({
        sha: c.sha,
        message: c.commit?.message ?? "",
        author: c.commit?.author?.name ?? "unknown",
        login: c.author?.login ?? null,
        avatar: c.author?.avatar_url ?? null,
        date: c.commit?.author?.date ?? c.commit?.committer?.date ?? "",
      }));
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

async function listPrs() {
  const raw =
    await $`gh pr list --json number,title,author,headRefName,updatedAt,additions,deletions,isDraft --limit 100`
      .cwd(cwd)
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
  }));
}

// Commit diffs are immutable, cache them for the lifetime of the server
const diffCache = new Map<string, string>();

async function commitDiff(sha: string): Promise<string> {
  const cached = diffCache.get(sha);
  if (cached !== undefined) return cached;
  const diff = await $`gh api repos/${repo}/commits/${sha} -H ${"Accept: application/vnd.github.diff"}`
    .cwd(cwd)
    .quiet()
    .text();
  diffCache.set(sha, diff);
  return diff;
}

// ---- Pending changes (working tree) ----

interface UntrackedEntry {
  path: string;
  contents: string | null;
  binary?: boolean;
  tooLarge?: boolean;
}

async function untrackedEntry(path: string): Promise<UntrackedEntry> {
  try {
    const file = Bun.file(`${cwd}/${path}`);
    if (file.size > 512 * 1024) return { path, contents: null, tooLarge: true };
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.subarray(0, 8000).includes(0)) return { path, contents: null, binary: true };
    return { path, contents: new TextDecoder().decode(bytes) };
  } catch {
    return { path, contents: null, binary: true };
  }
}

async function getChanges() {
  const raw = await $`git status --porcelain=v1 -z -uall`.cwd(cwd).quiet().text();
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
    staged.length ? $`git diff --cached`.cwd(cwd).quiet().text() : Promise.resolve(""),
    unstaged.length ? $`git diff`.cwd(cwd).quiet().text() : Promise.resolve(""),
    Promise.all(untrackedPaths.map(untrackedEntry)),
  ]);
  return { staged, unstaged, untracked, stagedDiff, unstagedDiff };
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

async function runGitAction(action: string, path?: string) {
  if (action === "stage") {
    return path ? $`git add -- ${path}`.cwd(cwd).quiet() : $`git add -A`.cwd(cwd).quiet();
  }
  if (action === "unstage") {
    return path
      ? $`git restore --staged -- ${path}`.cwd(cwd).quiet()
      : $`git restore --staged .`.cwd(cwd).quiet();
  }
  if (action === "stash") {
    return path
      ? $`git stash push -u -- ${path}`.cwd(cwd).quiet()
      : $`git stash push -u`.cwd(cwd).quiet();
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
<title>${repo} — diffshub</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body, #root { height: 100%; margin: 0; }
  body {
    font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #101012;
    color: #e4e4e7;
  }
  code { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  button { font: inherit; color: inherit; }
  .layout { display: flex; height: 100%; overflow: hidden; }

  .commits {
    width: 300px; min-width: 300px;
    display: flex; flex-direction: column;
    border-right: 1px solid #26262b;
    background: #141417;
  }
  .commits-header { padding: 14px 14px 10px; border-bottom: 1px solid #26262b; }
  .commits-header h1 { font-size: 15px; margin: 0 0 10px; display: flex; align-items: baseline; gap: 8px; }
  .commits-header .repo { font-size: 11px; font-weight: 400; color: #8b8b93; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .commits-header input {
    width: 100%; padding: 6px 10px; font-size: 13px;
    background: #101012; color: inherit;
    border: 1px solid #2e2e34; border-radius: 6px; outline: none;
  }
  .commits-header input:focus { border-color: #6e56cf; }

  .tabs { display: flex; gap: 2px; margin-bottom: 10px; background: #101012; border: 1px solid #2e2e34; border-radius: 7px; padding: 2px; }
  .tabs button {
    flex: 1; padding: 4px 0; font-size: 12px; cursor: pointer;
    background: none; border: none; border-radius: 5px; color: #8b8b93;
  }
  .tabs button.on { background: #26262b; color: #e4e4e7; }

  .commit-list { flex: 1; overflow-y: auto; padding: 6px 0; }
  .commit {
    display: block; width: 100%; text-align: left; cursor: pointer;
    padding: 8px 14px; border: none; border-left: 3px solid transparent;
    background: none; position: relative;
  }
  .commit:hover { background: #1c1c21; }
  .commit.active { background: #1e1b2e; border-left-color: #6e56cf; }
  .commit-msg {
    display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-weight: 500; margin-bottom: 3px; padding-right: 22px;
  }
  .rev-btn {
    position: absolute; top: 7px; right: 10px; width: 18px; height: 18px;
    display: flex; align-items: center; justify-content: center; padding: 0;
    background: none; border: 1px solid #36363d; border-radius: 50%;
    color: #6b6b73; font-size: 10px; cursor: pointer; opacity: 0;
  }
  .commit:hover .rev-btn { opacity: 1; }
  .commit.reviewed .rev-btn { opacity: 1; background: #14321f; border-color: #1f5c33; color: #4ade80; }
  .commit.reviewed .commit-msg { color: #8b8b93; font-weight: 400; }
  .spinner {
    width: 28px; height: 28px; margin: 0 auto; border-radius: 50%;
    border: 3px solid #26262b; border-top-color: #6e56cf;
    animation: spin .8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .commit-meta { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #8b8b93; }
  .commit-meta img { width: 14px; height: 14px; border-radius: 50%; }
  .commit-meta code { color: #8b8b93; }
  .commit-ago { margin-left: auto; white-space: nowrap; }
  .pr-stats .add { color: #4ade80; }
  .pr-stats .del { color: #f87171; }
  .load-more {
    display: block; width: calc(100% - 28px); margin: 8px 14px; padding: 6px;
    background: #1c1c21; color: #8b8b93; border: 1px solid #2e2e34;
    border-radius: 6px; cursor: pointer; font-size: 12px;
  }
  .load-more:hover { color: #e4e4e7; }
  .side-note { color: #8b8b93; padding: 16px 14px; }
  .side-note.error { color: #f87171; white-space: pre-wrap; }

  .kbd-hints {
    padding: 8px 14px; border-top: 1px solid #26262b;
    font-size: 11px; color: #6b6b73; display: flex; gap: 10px; flex-wrap: wrap;
  }
  .kbd-hints kbd { background: #26262b; border-radius: 3px; padding: 1px 4px; font-size: 10px; }

  .bulk-actions { display: flex; gap: 6px; padding: 8px 14px; }
  .bulk-actions button {
    flex: 1; padding: 5px 0; font-size: 11px; cursor: pointer;
    background: #1c1c21; border: 1px solid #2e2e34; border-radius: 6px; color: #b9b9c0;
  }
  .bulk-actions button:hover:not(:disabled) { color: #e4e4e7; border-color: #6e56cf; }
  .bulk-actions button:disabled { opacity: .5; cursor: default; }

  .group-label {
    padding: 10px 14px 4px; font-size: 11px; font-weight: 600;
    color: #8b8b93; text-transform: uppercase; letter-spacing: .04em;
  }
  .change-row {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 14px; cursor: pointer;
  }
  .change-row:hover { background: #1c1c21; }
  .change-row .st { width: 12px; text-align: center; font-size: 11px; flex-shrink: 0; }
  .st-added, .st-untracked { color: #4ade80; }
  .st-modified { color: #fbbf24; }
  .st-deleted { color: #f87171; }
  .st-renamed { color: #60a5fa; }
  .change-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
  .change-acts { display: none; gap: 4px; flex-shrink: 0; }
  .change-row:hover .change-acts { display: flex; }

  .act {
    padding: 1px 7px; font-size: 11px; cursor: pointer;
    background: #26262b; border: 1px solid #36363d; border-radius: 5px; color: #b9b9c0;
  }
  .act:hover:not(:disabled) { color: #e4e4e7; border-color: #6e56cf; }
  .act:disabled { opacity: .5; cursor: default; }
  .hdr-acts { display: inline-flex; gap: 5px; margin-left: 10px; }

  .diffs { flex: 1; overflow-y: auto; padding: 16px 20px 60vh; }
  .section-label { font-size: 12px; color: #8b8b93; text-transform: uppercase; letter-spacing: .04em; margin: 6px 2px 10px; }
  .file-diff { margin-bottom: 16px; position: relative; }
  .file-diff.viewing::before {
    content: ""; position: absolute; left: -10px; top: 0; bottom: 0;
    width: 3px; border-radius: 2px; background: #6e56cf;
  }
  .empty { color: #8b8b93; padding: 40px 0; text-align: center; }
  .empty.error { color: #f87171; white-space: pre-wrap; text-align: left; }
  .opaque-file {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 14px; border: 1px solid #26262b; border-radius: 8px;
    color: #8b8b93; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px;
  }

  .tree {
    width: 280px; min-width: 280px;
    border-left: 1px solid #26262b;
    background: #141417;
    display: flex; flex-direction: column;
  }
  .meta-panel { padding: 14px; border-bottom: 1px solid #26262b; }
  .meta-panel h2 { font-size: 13px; margin: 0 0 6px; line-height: 1.4; word-break: break-word; }
  .meta-panel .meta-line { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #8b8b93; margin-top: 4px; }
  .meta-panel .meta-line img { width: 14px; height: 14px; border-radius: 50%; }
  .meta-panel .sha-btn {
    background: #1c1c21; border: 1px solid #2e2e34; border-radius: 5px;
    padding: 1px 7px; font-size: 11px; cursor: pointer; color: #b9b9c0;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
  }
  .meta-panel .sha-btn:hover { border-color: #6e56cf; color: #e4e4e7; }
  .tree-body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 8px 6px;
    --trees-bg-override: #141417;
    --trees-bg-muted-override: #1c1c21;
    --trees-fg-override: #e4e4e7;
    --trees-fg-muted-override: #8b8b93;
    --trees-border-color-override: #26262b;
    --trees-selected-bg-override: #1e1b2e;
    --trees-accent-override: #6e56cf;
  }
  .tree-body > * { flex: 1; min-height: 0; }
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
      return json({ repo, branch });
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

    if (url.pathname === "/api/reviewed") {
      if (req.method === "POST") {
        let body: { sha?: unknown; reviewed?: unknown };
        try {
          body = await req.json();
        } catch {
          return json({ error: "Invalid JSON" }, 400);
        }
        if (typeof body.sha !== "string" || !/^[0-9a-f]{7,40}$/.test(body.sha)) {
          return json({ error: "Invalid sha" }, 400);
        }
        if (body.reviewed) markReviewedStmt.run(repo, body.sha, Date.now());
        else unmarkReviewedStmt.run(repo, body.sha);
        return json({ ok: true });
      }
      return json(listReviewedStmt.all(repo).map((r) => r.sha));
    }

    if (req.method === "POST" && url.pathname === "/api/git") {
      let body: { action?: unknown; path?: unknown };
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      const action = body.action;
      if (action !== "stage" && action !== "unstage" && action !== "stash") {
        return json({ error: "Invalid action" }, 400);
      }
      if (body.path !== undefined && !safeRepoPath(body.path)) {
        return json({ error: "Invalid path" }, 400);
      }
      try {
        await runGitAction(action, body.path as string | undefined);
      } catch (e) {
        return json({ error: errText(e) }, 500);
      }
      return json({ ok: true });
    }

    const prDiffMatch = url.pathname.match(/^\/api\/diff\/pr\/(\d{1,7})$/);
    if (prDiffMatch) {
      try {
        const diff = await $`gh pr diff ${prDiffMatch[1]}`.cwd(cwd).quiet().text();
        return new Response(diff, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      } catch (e) {
        return new Response(errText(e), { status: 502 });
      }
    }

    const diffMatch = url.pathname.match(/^\/api\/diff\/([0-9a-f]{7,40})$/);
    if (diffMatch) {
      try {
        return new Response(await commitDiff(diffMatch[1]), {
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

console.log(`diffshub for ${repo} running at http://localhost:${server.port}`);
