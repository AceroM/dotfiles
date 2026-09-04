#!/usr/bin/env bun

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  render,
  Box,
  Text,
  useApp,
  useInput,
  useStdin,
  useStdout,
} from "@dotfiles/opentui-cli";
import { realpathSync } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StackBranch = {
  branch: string;
  prNumber: number | null;
  prUrl: string | null;
  prState: string | null; // OPEN | MERGED | CLOSED (from gh stack view)
  isCurrent: boolean;
  isMerged: boolean;
  isQueued: boolean;
  // True when this branch's base (the branch below it, or the trunk for the
  // bottom one) has moved on without it — i.e. GitHub's "out-of-date with its
  // base branch". Computed from the remote refs so it matches what the PR page
  // shows, not just what happens to be checked out.
  needsRebase: boolean;
  // Local checkout vs origin/<branch>. A force-push from the GitHub UI leaves
  // the worktree behind; unpushed work leaves it ahead. Either one silently
  // breaks the next push, so surface both.
  hasLocal: boolean;
  localAhead: number;
  localBehind: number;
  // Base this branch is measured against (branch below it, or the trunk).
  base: string;
};

type CheckItem = { name: string; status: "pass" | "fail" | "pending" };

type PrDetails = {
  title: string;
  state: string;
  isDraft: boolean;
  reviewDecision: string; // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ""
  additions: number;
  deletions: number;
  checks: { pass: number; fail: number; pending: number };
  checkList: CheckItem[];
};

type StackData = {
  label: string;
  trunk: string;
  currentBranch: string | null;
  // GitHub's stack number, when we know it. `gh stack rebase` works off local
  // tracking, but `gh stack merge` accepts this, which is the only way to act
  // on a stack created by `gh stack link` (no local tracking is written).
  stackNumber: number | null;
  branches: StackBranch[]; // bottom -> top (closest to trunk first)
  // Sync annotation (fetch + rebase/drift detection) is the slow, network-bound
  // part of loading, so it runs behind the first paint. False until it lands.
  synced?: boolean;
};

type Screen = "loading" | "pick" | "main" | "fatal";

// Rebase rewrites history, merge is irreversible, and an approval goes out to
// the PR's author and reviewers, so none fires on a bare keypress — each stages
// a PendingAction that a second key has to confirm. rebase spawns a Claude
// agent in a new Herdr pane; merge and approve run gh directly.
type PendingAction = {
  kind: "rebase" | "merge" | "approve";
  prompt: string;
  exec: () => Promise<{ code: number; out: string; err: string }>;
  after?: () => void; // on success, once the footer has the result
};

// Where a comment is headed: the Herdr tab holding the ticket's agent, resolved
// once when the dialog opens so the destination is on screen before anything is
// sent to it.
type CommentTarget = {
  tabLabel: string;
  agent: string; // herdr agent target: its name when it has one, else its pane
  status: string;
};

type CommentDraft = {
  ticket: string;
  branch: string;
  prNumber: number | null;
  text: string;
  target: CommentTarget | null;
  error: string | null;
  sending: boolean;
};

// The description dialog (space): the PR body plus its conversation, fetched
// once per PR and re-rendered to the dialog width. Modal like the comment box.
type DescDialog = {
  prNumber: number;
  data: Discussion | null;
  error: string | null;
  loading: boolean;
  scroll: number;
  // Resolved threads and known-noisy bots (Vercel, Linear) fold to one line
  // by default; x unfolds everything.
  showAll: boolean;
};

// ---------------------------------------------------------------------------
// gh helpers
// ---------------------------------------------------------------------------

async function run(
  cmd: string[],
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

// Placeholder sync fields. Every stack source fills these in later via
// annotateSync(), which is the one place that talks to git about ref positions.
const NO_SYNC = {
  hasLocal: false,
  localAhead: 0,
  localBehind: 0,
  base: "",
} satisfies Pick<StackBranch, "hasLocal" | "localAhead" | "localBehind" | "base">;

function parseViewJson(raw: string): StackData {
  const j = JSON.parse(raw) as {
    trunk: string;
    currentBranch: string;
    branches: Array<{
      name: string;
      isCurrent: boolean;
      isMerged: boolean;
      isQueued: boolean;
      needsRebase: boolean;
      pr: { number: number; url: string; state: string } | null;
    }>;
  };
  return {
    label: "current stack",
    trunk: j.trunk,
    currentBranch: j.currentBranch,
    stackNumber: null,
    branches: j.branches.map((b) => ({
      branch: b.name,
      prNumber: b.pr?.number ?? null,
      prUrl: b.pr?.url ?? null,
      prState: b.pr?.state ?? null,
      isCurrent: b.isCurrent,
      isMerged: b.isMerged,
      isQueued: b.isQueued,
      needsRebase: b.needsRebase,
      ...NO_SYNC,
    })),
  };
}

// Fallback when the current branch isn't part of a stack: read gh's local
// tracking file so any tracked stack in the repo can still be browsed.
async function readTrackingFile(): Promise<StackData[]> {
  // Bare --git-common-dir answers "\.git" in the primary worktree, which only
  // resolves when the cwd happens to be the repo root.
  const { code, out } = await run([
    "git",
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (code !== 0) return [];
  const path = `${out.trim()}/gh-stack`;
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const j = (await file.json()) as {
    stacks?: Array<{
      number?: number;
      trunk: { branch: string };
      branches: Array<{
        branch: string;
        pullRequest?: { number: number; url: string };
      }>;
    }>;
  };
  return (j.stacks ?? []).map((s) => ({
    label: s.number ? `stack #${s.number}` : "untracked stack",
    trunk: s.trunk.branch,
    currentBranch: null,
    stackNumber: s.number ?? null,
    branches: s.branches.map((b) => ({
      branch: b.branch,
      prNumber: b.pullRequest?.number ?? null,
      prUrl: b.pullRequest?.url ?? null,
      prState: null,
      isCurrent: false,
      isMerged: false,
      isQueued: false,
      needsRebase: false,
      ...NO_SYNC,
    })),
  }));
}

// `gh stack link` registers a stack on GitHub *without* writing local tracking,
// and `gh stack view` reads nothing but that local file — so a linked stack is
// invisible to both it and the .git/gh-stack fallback. Resolve those over the API.
type RemoteStackRef = { id: string; number: number };

async function currentBranch(): Promise<string | null> {
  const { code, out } = await run(["git", "branch", "--show-current"]);
  const name = out.trim();
  return code === 0 && name ? name : null;
}

async function prForBranch(branch: string): Promise<number | null> {
  const { code, out } = await run(["gh", "pr", "view", branch, "--json", "number"]);
  if (code !== 0) return null;
  const n = (JSON.parse(out) as { number?: number }).number;
  return typeof n === "number" ? n : null;
}

// Branch tips along HEAD's first-parent ancestry, nearest first. The branch you
// are writing on may have no PR yet, so anchor the lookup on the closest
// ancestor branch that does have one.
async function ancestorBranches(current: string | null): Promise<string[]> {
  const [revs, refs] = await Promise.all([
    run(["git", "rev-list", "--first-parent", "--max-count=50", "HEAD"]),
    run([
      "git",
      "for-each-ref",
      "--format=%(objectname) %(refname:short)",
      "refs/heads",
      "refs/remotes/origin",
    ]),
  ]);
  if (revs.code !== 0 || refs.code !== 0) return [];

  const byCommit = new Map<string, string[]>();
  for (const line of refs.out.trim().split("\n")) {
    const [sha, ref] = line.split(" ");
    if (!sha || !ref) continue;
    const name = ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
    if (!name || name === current || name === "HEAD") continue;
    const names = byCommit.get(sha) ?? [];
    if (!names.includes(name)) names.push(name);
    byCommit.set(sha, names);
  }

  const ordered: string[] = [];
  for (const sha of revs.out.trim().split("\n")) {
    for (const name of byCommit.get(sha) ?? []) {
      if (!ordered.includes(name)) ordered.push(name);
    }
  }
  return ordered;
}

async function remoteStackRef(prNumber: number): Promise<RemoteStackRef | null> {
  const { code, out } = await run([
    "gh",
    "api",
    "graphql",
    "-F",
    "owner={owner}",
    "-F",
    "name={repo}",
    "-F",
    `number=${prNumber}`,
    "-f",
    "query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){stack{id number}}}}",
  ]);
  if (code !== 0) return null;
  const stack = (
    JSON.parse(out) as {
      data?: { repository?: { pullRequest?: { stack?: RemoteStackRef | null } } };
    }
  ).data?.repository?.pullRequest?.stack;
  return stack?.id ? stack : null;
}

async function isAncestor(branch: string, of: string): Promise<boolean> {
  const { code } = await run(["git", "merge-base", "--is-ancestor", branch, of]);
  return code === 0;
}

// Update the remote-tracking refs so "out of date" means out of date with what
// GitHub actually has. Without this the whole panel can be confidently wrong —
// a stale origin/main makes every branch look current. Read-only: no merge, no
// checkout, nothing touched in the working tree.
async function fetchRefs(): Promise<void> {
  await run(["git", "fetch", "--quiet", "origin"]);
}

// Fill in needsRebase + local drift for every branch in the stack.
//
// Two independent questions, both of which have bitten this repo:
//   1. Is the branch behind its base? (GitHub's "This stack is out-of-date")
//      Measured on the REMOTE refs, because that's what the PR page compares.
//   2. Has the local checkout drifted from origin? A "Rebase stack" click in
//      the web UI force-pushes, leaving every worktree silently behind.
// Batches every ref-existence lookup annotateSync needs into a single spawn
// instead of up to 3 per branch — this runs on every load, so for a stack of
// any size that's the difference between one git call and a burst of them.
async function existingRefNames(): Promise<Set<string>> {
  const { code, out } = await run([
    "git",
    "for-each-ref",
    "--format=%(refname)",
    "refs/heads",
    "refs/remotes/origin",
  ]);
  if (code !== 0) return new Set();
  return new Set(out.trim().split("\n").filter(Boolean));
}

async function annotateSync(data: StackData): Promise<StackData> {
  const refs = await existingRefNames();
  const hasLocalRef = (name: string) => refs.has(`refs/heads/${name}`);
  const hasRemoteRef = (name: string) => refs.has(`refs/remotes/origin/${name}`);

  const branches = await Promise.all(
    data.branches.map(async (b, i) => {
      // bottom branch measures against the trunk; the rest against the one below
      const base = i === 0 ? data.trunk : data.branches[i - 1].branch;

      const hasLocal = hasLocalRef(b.branch);
      const hasRemote = hasRemoteRef(b.branch);
      const hasRemoteBase = hasRemoteRef(base);

      // Prefer remote-vs-remote; fall back to local refs when a branch hasn't
      // been pushed yet, so an unpushed top-of-stack still reports honestly.
      let needsRebase = b.needsRebase;
      if (hasRemote && hasRemoteBase) {
        needsRebase =
          needsRebase || !(await isAncestor(`origin/${base}`, `origin/${b.branch}`));
      } else if (hasLocal && hasRemoteBase) {
        needsRebase =
          needsRebase || !(await isAncestor(`origin/${base}`, b.branch));
      }

      let localAhead = 0;
      let localBehind = 0;
      if (hasLocal && hasRemote) {
        const { code, out } = await run([
          "git",
          "rev-list",
          "--left-right",
          "--count",
          `origin/${b.branch}...${b.branch}`,
        ]);
        if (code === 0) {
          const [behind, ahead] = out.trim().split(/\s+/).map(Number);
          localBehind = Number.isFinite(behind) ? behind : 0;
          localAhead = Number.isFinite(ahead) ? ahead : 0;
        }
      }

      return { ...b, base, hasLocal, needsRebase, localAhead, localBehind };
    }),
  );
  return { ...data, branches, synced: true };
}

// A merged branch can't be rebased and doesn't need it, so ignore those when
// deciding whether the stack as a whole is stale.
function staleBranches(data: StackData): StackBranch[] {
  return data.branches.filter((b) => b.needsRebase && !b.isMerged);
}

function driftedBranches(data: StackData): StackBranch[] {
  return data.branches.filter((b) => b.localAhead > 0 || b.localBehind > 0);
}

async function readRemoteStack(): Promise<StackData | null> {
  const current = await currentBranch();
  const candidates = [
    ...(current ? [current] : []),
    ...(await ancestorBranches(current)),
  ].slice(0, 12);

  let ref: RemoteStackRef | null = null;
  for (const branch of candidates) {
    const pr = await prForBranch(branch);
    if (pr == null) continue;
    ref = await remoteStackRef(pr);
    if (ref) break;
  }
  if (!ref) return null;

  const { code, out } = await run([
    "gh",
    "api",
    "graphql",
    "-F",
    `id=${ref.id}`,
    "-f",
    "query=query($id:ID!){node(id:$id){... on PullRequestStack{number baseRefName entries(first:50){nodes{position pullRequest{number url headRefName state}}}}}}",
  ]);
  if (code !== 0) return null;

  type Entry = {
    position: number;
    pullRequest: {
      number: number;
      url: string;
      headRefName: string;
      state: string;
    } | null;
  };
  const node = (
    JSON.parse(out) as {
      data?: {
        node?: {
          number: number;
          baseRefName: string;
          entries?: { nodes?: Entry[] };
        } | null;
      };
    }
  ).data?.node;
  if (!node) return null;

  const branches: StackBranch[] = [...(node.entries?.nodes ?? [])]
    .filter((e): e is Entry & { pullRequest: NonNullable<Entry["pullRequest"]> } =>
      e.pullRequest != null,
    )
    .sort((a, b) => a.position - b.position)
    .map((e) => ({
      branch: e.pullRequest.headRefName,
      prNumber: e.pullRequest.number,
      prUrl: e.pullRequest.url,
      prState: e.pullRequest.state,
      isCurrent: e.pullRequest.headRefName === current,
      isMerged: e.pullRequest.state === "MERGED",
      isQueued: false,
      needsRebase: false,
      ...NO_SYNC,
    }));
  if (branches.length === 0) return null;

  // A PR-less branch stacked on top of the topmost PR still belongs to the
  // stack from the author's point of view. Only append it when it really does
  // sit on top — a branch forked off the middle would be shown in the wrong place.
  const top = branches[branches.length - 1].branch;
  if (current && !branches.some((b) => b.branch === current)) {
    if (await isAncestor(top, "HEAD")) {
      branches.push({
        branch: current,
        prNumber: null,
        prUrl: null,
        prState: null,
        isCurrent: true,
        isMerged: false,
        isQueued: false,
        needsRebase: false,
        ...NO_SYNC,
      });
    }
  }

  return {
    label: `stack #${node.number} · on github`,
    trunk: node.baseRefName,
    currentBranch: current,
    stackNumber: node.number,
    branches,
  };
}

async function resolveStacks(): Promise<{
  stacks: StackData[];
  source: "tracked" | "github" | "file" | "none";
  error?: string;
}> {
  // No fetch, no sync annotation here: this is the critical path to first
  // paint. openStack() runs fetchRefs + annotateSync in the background.
  const view = await run(["gh", "stack", "view", "--json"]);
  if (view.code === 0) {
    return { stacks: [parseViewJson(view.out)], source: "tracked" };
  }
  const remote = await readRemoteStack();
  if (remote) return { stacks: [remote], source: "github" };
  const tracked = await readTrackingFile();
  if (tracked.length > 0) return { stacks: tracked, source: "file" };
  return {
    stacks: [],
    source: "none",
    error:
      (view.err || view.out).trim() ||
      "No stack found. Run this from a branch that is part of a gh stack.",
  };
}

function parseChecks(rollup: unknown): {
  checks: PrDetails["checks"];
  checkList: CheckItem[];
} {
  const checks = { pass: 0, fail: 0, pending: 0 };
  const checkList: CheckItem[] = [];
  if (!Array.isArray(rollup)) return { checks, checkList };
  for (const c of rollup as Array<Record<string, string>>) {
    const s = (c.conclusion || c.state || c.status || "").toUpperCase();
    let status: CheckItem["status"];
    if (s === "SUCCESS" || s === "NEUTRAL" || s === "SKIPPED") status = "pass";
    else if (
      ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(s)
    )
      status = "fail";
    else status = "pending";
    checks[status]++;
    checkList.push({ name: c.name || c.context || "check", status });
  }
  // Failures first, then pending, so the checks that need eyes surface at the
  // top of an expanded PR row.
  const rank = { fail: 0, pending: 1, pass: 2 } as const;
  checkList.sort((a, b) => rank[a.status] - rank[b.status]);
  return { checks, checkList };
}

async function fetchPrDetails(prNumber: number): Promise<PrDetails | null> {
  const { code, out } = await run([
    "gh",
    "pr",
    "view",
    String(prNumber),
    "--json",
    "title,state,isDraft,reviewDecision,additions,deletions,statusCheckRollup",
  ]);
  if (code !== 0) return null;
  const j = JSON.parse(out) as Record<string, unknown>;
  const { checks, checkList } = parseChecks(j.statusCheckRollup);
  return {
    title: String(j.title ?? ""),
    state: String(j.state ?? ""),
    isDraft: Boolean(j.isDraft),
    reviewDecision: String(j.reviewDecision ?? ""),
    additions: Number(j.additions ?? 0),
    deletions: Number(j.deletions ?? 0),
    checks,
    checkList,
  };
}

function pathFromDiffHeader(header: string): string {
  const rest = header.slice("diff --git ".length);
  const marker = Math.max(rest.lastIndexOf(" b/"), rest.lastIndexOf(' "b/'));
  if (marker === -1) return rest;

  const path = rest.slice(marker + 1);
  if (path.startsWith('"b/'))
    return path.slice(3, path.endsWith('"') ? -1 : undefined);
  return path.startsWith("b/") ? path.slice(2) : path;
}

function formatDiff(raw: string): string[] {
  const formatted: string[] = [];
  const metadata = /^(?:index |--- |\+\+\+ |(?:new|deleted) file mode |(?:old|new) mode |(?:dis)?similarity index |(?:rename|copy) (?:from|to) )/;
  let inHunk = false;

  for (const line of raw.replace(/\r/g, "").split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      if (formatted.length && formatted[formatted.length - 1] !== "")
        formatted.push("");
      formatted.push(`Δ ${pathFromDiffHeader(line)}`, "");
    } else if (line.startsWith("@@")) {
      inHunk = true;
      if (formatted.length && formatted[formatted.length - 1] !== "")
        formatted.push("");
    } else if (inHunk || !metadata.test(line)) {
      formatted.push(line.replaceAll("\t", "    "));
    }
  }

  while (formatted[formatted.length - 1] === "") formatted.pop();
  return formatted;
}

async function fetchDiff(prNumber: number): Promise<string[]> {
  const { code, out, err } = await run(["gh", "pr", "diff", String(prNumber)]);
  if (code !== 0) return [`(gh pr diff failed: ${(err || out).trim()})`];
  // OpenTUI owns terminal styling. Passing Delta's ANSI stream through a text
  // renderable exposes escape-code fragments and background-color runs.
  return formatDiff(out);
}

// ---------------------------------------------------------------------------
// herdr: hand a comment to the agent working this branch's Linear ticket
// ---------------------------------------------------------------------------

// herdr reports a failure as a JSON envelope, and prints it on stdout — dig the
// message out rather than dropping a line of JSON into the footer.
function herdrError(r: { code: number; out: string; err: string }): string {
  const raw = (r.err || r.out).trim();
  try {
    const m = (JSON.parse(raw) as { error?: { message?: string } }).error?.message;
    if (m) return m;
  } catch {
    // not JSON — fall through to the raw first line
  }
  return firstLine(raw) || `exit ${r.code}`;
}

// miguel/prod-3083-hide-officer-ssn -> PROD-3083. Branch names put the ticket
// straight after the miguel/ prefix, so anchor there and only fall back to a
// loose scan for branches that were named some other way.
function ticketFor(branch: string): string | null {
  const tail = branch.slice(branch.lastIndexOf("/") + 1);
  const m =
    /^([a-z]{2,10})-(\d+)/i.exec(tail) ?? /([a-z]{2,10})-(\d+)/i.exec(branch);
  return m ? `${m[1].toUpperCase()}-${m[2]}` : null;
}

// PROD-3083 must not match a tab for PROD-30831, so the character after the ID
// has to be something other than another digit.
function labelIsTicket(label: string, ticket: string): boolean {
  const l = label.trim().toUpperCase();
  return (
    l === ticket ||
    (l.startsWith(ticket) && !/\d/.test(l.charAt(ticket.length)))
  );
}

// A ticket's work lives in one Herdr tab per workspace, labeled with the
// uppercase ticket ID first ("PROD-3083 · slot 1"), hosting one agent — see the
// Herdr section of ~/.claude/CLAUDE.md. Ambiguity is an error rather than a coin
// flip: the wrong guess prompts an agent that is working on something else.
async function resolveCommentTarget(
  ticket: string,
): Promise<{ target?: CommentTarget; error?: string }> {
  if (process.env.HERDR_ENV !== "1")
    return { error: "not inside a Herdr pane (HERDR_ENV unset)" };
  const workspace = process.env.HERDR_WORKSPACE_ID;
  if (!workspace) return { error: "HERDR_WORKSPACE_ID unset" };

  const tabs = await run(["herdr", "tab", "list", "--workspace", workspace]);
  if (tabs.code !== 0)
    return { error: `herdr tab list failed — ${herdrError(tabs)}` };
  const listed = (
    JSON.parse(tabs.out) as {
      result?: { tabs?: Array<{ tab_id: string; label?: string | null }> };
    }
  ).result?.tabs ?? [];
  const hits = listed.filter((t) => labelIsTicket(t.label ?? "", ticket));
  if (hits.length === 0)
    return { error: `no tab in this workspace is labeled ${ticket}` };
  if (hits.length > 1)
    return {
      error: `${ticket} matches ${hits.length} tabs: ${hits
        .map((t) => (t.label ?? t.tab_id).trim())
        .join(", ")}`,
    };
  const tab = hits[0];
  const tabLabel = (tab.label ?? tab.tab_id).trim();

  const agents = await run(["herdr", "agent", "list"]);
  if (agents.code !== 0)
    return { error: `herdr agent list failed — ${herdrError(agents)}` };
  const inTab = (
    (
      JSON.parse(agents.out) as {
        result?: {
          agents?: Array<{
            tab_id: string;
            pane_id: string;
            name?: string | null;
            agent?: string | null;
            agent_status?: string | null;
          }>;
        };
      }
    ).result?.agents ?? []
  ).filter((a) => a.tab_id === tab.tab_id);
  if (inTab.length === 0) return { error: `${tabLabel} has no agent running` };
  if (inTab.length > 1)
    return { error: `${tabLabel} hosts ${inTab.length} agents — ambiguous` };

  const a = inTab[0];
  return {
    target: {
      tabLabel,
      agent: a.name || a.pane_id,
      status: a.agent_status ?? "",
    },
  };
}

// What the agent over there actually receives. It has no idea the text came out
// of a diff viewer, so name the PR and branch ahead of the comment itself.
function commentBody(c: CommentDraft): string {
  const what = c.prNumber != null ? `PR #${c.prNumber}` : `branch ${c.branch}`;
  return `Comment on ${what} (${c.branch}): ${c.text.trim()}`;
}

// R doesn't run the rebase here: it splits a sibling pane on the right, starts
// a Claude agent in it, and hands it the whole job — including resolving merge
// conflicts — so the human reviews a finished rebase instead of babysitting one.
function rebaseTask(s: StackData): string {
  const branches = s.branches.filter((b) => !b.isMerged).map((b) => b.branch);
  return [
    `Rebase my gh stack onto ${s.trunk}.`,
    `Branches, bottom to top: ${branches.join(", ")}.`,
    "Try `gh stack rebase` first; if it stops on merge conflicts (or the stack has no local tracking), rebase each branch onto the one below it manually, bottom first.",
    "Resolve every merge conflict yourself — keep both sides' intent, reading the surrounding code when unsure. Do not leave conflicts for me.",
    "Force-push each rebased branch with --force-with-lease.",
    "Do not merge or close any PRs. When done, summarize what was rebased and how each conflict was resolved so I can review.",
  ].join(" ");
}

async function launchRebaseAgent(
  s: StackData,
): Promise<{ code: number; out: string; err: string }> {
  if (process.env.HERDR_ENV !== "1")
    return { code: 1, out: "", err: "not inside a Herdr pane (HERDR_ENV unset)" };

  const split = await run([
    "herdr",
    "pane",
    "split",
    "--current",
    "--direction",
    "right",
    "--cwd",
    process.cwd(),
    "--no-focus",
  ]);
  if (split.code !== 0)
    return { code: 1, out: "", err: `pane split failed — ${herdrError(split)}` };
  let paneId: string | undefined;
  try {
    paneId = (
      JSON.parse(split.out) as { result?: { pane?: { pane_id?: string } } }
    ).result?.pane?.pane_id;
  } catch {
    // fall through to the missing-id error
  }
  if (!paneId)
    return { code: 1, out: "", err: "pane split returned no pane_id" };

  const name = `rebase-${Date.now().toString(36)}`;
  const start = await run([
    "herdr",
    "agent",
    "start",
    name,
    "--kind",
    "claude",
    "--pane",
    paneId,
  ]);
  if (start.code !== 0)
    return { code: 1, out: "", err: `agent start failed — ${herdrError(start)}` };

  const prompt = await run(["herdr", "agent", "prompt", name, rebaseTask(s)]);
  if (prompt.code !== 0)
    return { code: 1, out: "", err: `agent prompt failed — ${herdrError(prompt)}` };
  return {
    code: 0,
    out: `handed to claude (${name}, pane ${paneId}) — review there, then r to refresh`,
    err: "",
  };
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

type Badge = { text: string; color: string };

// High-contrast diff colors tuned for dark terminal backgrounds.
const DIFF_ADD_COLOR = "#7EE787";
const DIFF_DELETE_COLOR = "#FFA198";
const DIFF_META_COLOR = "#79C0FF";
const DIFF_MUTED_COLOR = "#A7B1C2";

function badgeFor(b: StackBranch, d: PrDetails | undefined): Badge {
  if (b.prNumber == null) return { text: "no PR", color: "gray" };
  const state = d?.state ?? b.prState ?? "";
  if (b.isMerged || state === "MERGED") return { text: "Merged", color: "magenta" };
  if (state === "CLOSED") return { text: "Closed", color: "red" };
  if (b.isQueued) return { text: "Queued", color: "cyan" };
  if (d?.isDraft) return { text: "Draft", color: "gray" };
  if (d?.reviewDecision === "APPROVED") return { text: "Approved", color: "green" };
  if (d?.reviewDecision === "CHANGES_REQUESTED")
    return { text: "Changes", color: "red" };
  return { text: "Not ready", color: "yellow" };
}

function dotFor(b: StackBranch, d: PrDetails | undefined): Badge {
  const state = d?.state ?? b.prState ?? "";
  if (b.isMerged || state === "MERGED") return { text: "✓", color: "magenta" };
  if (state === "CLOSED") return { text: "✗", color: "red" };
  if (b.isQueued) return { text: "◎", color: "cyan" };
  if (b.needsRebase) return { text: "⚠", color: "yellow" };
  if (d?.isDraft) return { text: "◌", color: "gray" };
  return { text: "●", color: "yellow" };
}

// Compact per-branch sync marker for the sidebar's meta line, e.g.
//   "⚠ rebase"   base moved on without this branch
//   "↓2"         local checkout is 2 commits behind origin (someone force-pushed)
//   "↑1"         1 unpushed commit
//   "local only" never pushed
function syncTags(b: StackBranch, synced: boolean): Badge[] {
  const tags: Badge[] = [];
  if (b.isMerged) return tags;
  if (b.needsRebase) tags.push({ text: "⚠ rebase", color: "yellow" });
  // hasLocal/ahead/behind are only meaningful once annotateSync has run;
  // before that every branch would falsely read "no local".
  if (!synced) return tags;
  if (b.localBehind > 0) tags.push({ text: `↓${b.localBehind}`, color: "red" });
  if (b.localAhead > 0) tags.push({ text: `↑${b.localAhead}`, color: "cyan" });
  if (b.hasLocal && b.prNumber != null && b.localAhead === 0 && b.localBehind === 0)
    return tags;
  if (!b.hasLocal && b.prNumber != null)
    tags.push({ text: "no local", color: "gray" });
  return tags;
}

// Rows shown under an expanded PR: one per failing/pending check (the ones
// worth expanding for), passes rolled up into a single line.
type CheckRow = { icon: string; color?: string; dim?: boolean; text: string };

function checkRowsFor(d: PrDetails | undefined): CheckRow[] {
  if (!d) return [{ icon: "◌", dim: true, text: "loading checks…" }];
  const rows: CheckRow[] = d.checkList
    .filter((c) => c.status !== "pass")
    .map((c) => ({
      icon: c.status === "fail" ? "✗" : "◌",
      color: c.status === "fail" ? "red" : "yellow",
      text: c.name,
    }));
  if (d.checks.pass > 0)
    rows.push({ icon: "✓", color: "green", text: `${d.checks.pass} passed` });
  if (rows.length === 0) rows.push({ icon: "–", dim: true, text: "no checks" });
  return rows;
}

// One glyph per viewport row for a vertical scrollbar, or null when the
// content fits and no bar is due. The thumb is the viewport's share of the
// content, never under one row, so a long diff still shows where you are.
function scrollbar(
  total: number,
  viewH: number,
  scroll: number,
): Array<"thumb" | "track"> | null {
  if (viewH <= 0 || total <= viewH) return null;
  const size = Math.max(1, Math.round((viewH * viewH) / total));
  const maxScroll = total - viewH;
  const start = Math.round((Math.min(scroll, maxScroll) / maxScroll) * (viewH - size));
  return Array.from({ length: viewH }, (_, i) =>
    i >= start && i < start + size ? "thumb" : "track",
  );
}

const SCROLL_THUMB_COLOR = "#C9D1D9";

function ScrollCell({
  bar,
  row,
}: {
  bar: Array<"thumb" | "track"> | null;
  row: number;
}) {
  if (!bar) return null;
  const thumb = bar[row] === "thumb";
  return (
    <Text flexShrink={0} color={thumb ? SCROLL_THUMB_COLOR : undefined} dimColor={!thumb}>
      {thumb ? "┃" : "│"}
    </Text>
  );
}

function firstLine(s: string): string {
  return (
    s
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ""
  );
}

function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  return s.length > max ? s.slice(0, Math.max(0, max - 1)) + "…" : s;
}

function diffLineStyle(line: string): { color?: string; bold?: boolean; dim?: boolean } {
  if (line.startsWith("Δ ")) return { color: DIFF_META_COLOR, bold: true };
  if (line.startsWith("+++") || line.startsWith("---"))
    return { color: DIFF_MUTED_COLOR };
  if (line.startsWith("@@")) return { color: DIFF_META_COLOR };
  if (line.startsWith("+")) return { color: DIFF_ADD_COLOR };
  if (line.startsWith("-")) return { color: DIFF_DELETE_COLOR };
  if (
    line.startsWith("index ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("similarity") ||
    line.startsWith("rename ")
  )
    return { color: DIFF_MUTED_COLOR };
  return {};
}

function useTermSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    cols: stdout.columns ?? 80,
    rows: stdout.rows ?? 24,
  });
  useEffect(() => {
    const onResize = () =>
      setSize({ cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  return size;
}

// ---------------------------------------------------------------------------
// zed: check the branch out and open its worktree
// ---------------------------------------------------------------------------

type Worktree = { path: string; branch: string | null };

async function listWorktrees(): Promise<Worktree[]> {
  const { code, out } = await run(["git", "worktree", "list", "--porcelain"]);
  if (code !== 0) return [];
  const trees: Worktree[] = [];
  let cur: Worktree | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice("worktree ".length), branch: null };
      trees.push(cur);
    } else if (line.startsWith("branch ") && cur) {
      cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  return trees;
}

function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function shortPath(p: string): string {
  const home = process.env.HOME;
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

// Put `branch` in a working tree and open that tree in Zed. Git refuses to
// check a branch out twice, so one that already lives in another worktree
// (a ~/Numeral slot, say) is opened where it is instead of being fought over.
// Nothing is stashed or forced: a checkout git rejects is reported as-is.
async function openInZed(
  branch: string,
): Promise<{ code: number; out: string; err: string }> {
  const top = await run(["git", "rev-parse", "--show-toplevel"]);
  if (top.code !== 0)
    return { code: 1, out: "", err: "not inside a git worktree" };
  const here = realPath(top.out.trim());
  const holder = (await listWorktrees()).find((w) => w.branch === branch);

  let dir = here;
  let did: string;
  if (holder && realPath(holder.path) !== here) {
    dir = realPath(holder.path);
    did = `${branch} lives in ${shortPath(dir)}`;
  } else if (holder) {
    did = `already on ${branch}`;
  } else {
    // Never checked out here means no local ref; make sure the remote one is
    // present so checkout can create the tracking branch from it.
    const refs = await existingRefNames();
    if (
      !refs.has(`refs/heads/${branch}`) &&
      !refs.has(`refs/remotes/origin/${branch}`)
    )
      await run(["git", "fetch", "--quiet", "origin", branch]);
    const co = await run(["git", "checkout", "--quiet", branch]);
    if (co.code !== 0)
      return {
        code: co.code,
        out: "",
        err: (co.err || co.out).trim() || `git checkout exited ${co.code}`,
      };
    did = `checked out ${branch}`;
  }

  // The zed CLI is a symlink into Zed.app; fall back to Launch Services when
  // it isn't on PATH.
  const zed = await run(
    Bun.which("zed") ? ["zed", dir] : ["open", "-a", "Zed", dir],
  );
  if (zed.code !== 0)
    return {
      code: zed.code,
      out: "",
      err: (zed.err || zed.out).trim() || `zed exited ${zed.code}`,
    };
  return { code: 0, out: `${did} — opened ${shortPath(dir)} in zed`, err: "" };
}

// ---------------------------------------------------------------------------
// PR discussion: description + comments, rendered as terminal markdown
// ---------------------------------------------------------------------------

type Reply = { author: string; when: string; body: string };

type DiscussionItem = {
  kind: "comment" | "review" | "thread";
  author: string;
  when: string; // ISO timestamp; items sort on it
  body: string;
  state?: string; // review: APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED
  path?: string; // thread: file the inline comment is anchored to
  line?: number | null;
  resolved?: boolean;
  outdated?: boolean;
  replies: Reply[];
};

type Discussion = {
  number: number;
  title: string;
  author: string;
  url: string;
  createdAt: string;
  body: string;
  items: DiscussionItem[]; // chronological
};

// One round trip for everything the dialog shows. `gh pr view --json` has no
// inline review comments, which is where Greptile puts its findings, so this
// goes through GraphQL; gh fills {owner}/{repo} from the cwd's remote.
const DISCUSSION_QUERY = `query($owner: String!, $repo: String!, $n: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $n) {
      number title body url createdAt author { login }
      comments(first: 100) { nodes { author { login } body createdAt } }
      reviews(first: 100) { nodes { author { login } body state submittedAt } }
      reviewThreads(first: 100) {
        nodes {
          isResolved isOutdated path line originalLine
          comments(first: 50) { nodes { author { login } body createdAt } }
        }
      }
    }
  }
}`;

type GqlAuthor = { login?: string } | null;
type GqlComment = { author: GqlAuthor; body: string; createdAt: string };
type GqlPr = {
  number: number;
  title: string;
  body: string;
  url: string;
  createdAt: string;
  author: GqlAuthor;
  comments: { nodes: GqlComment[] };
  reviews: {
    nodes: Array<{
      author: GqlAuthor;
      body: string;
      state: string;
      submittedAt: string | null;
    }>;
  };
  reviewThreads: {
    nodes: Array<{
      isResolved: boolean;
      isOutdated: boolean;
      path: string;
      line: number | null;
      originalLine: number | null;
      comments: { nodes: GqlComment[] };
    }>;
  };
};

async function fetchDiscussion(
  n: number,
): Promise<{ data?: Discussion; error?: string }> {
  const r = await run([
    "gh",
    "api",
    "graphql",
    "-F",
    "owner={owner}",
    "-F",
    "repo={repo}",
    "-F",
    `n=${n}`,
    "-f",
    `query=${DISCUSSION_QUERY}`,
  ]);
  if (r.code !== 0)
    return { error: firstLine(r.err || r.out) || `gh api exited ${r.code}` };
  let pr: GqlPr | null | undefined;
  try {
    pr = (
      JSON.parse(r.out) as {
        data?: { repository?: { pullRequest?: GqlPr | null } };
      }
    ).data?.repository?.pullRequest;
  } catch (e) {
    return { error: `unreadable gh api response — ${(e as Error).message}` };
  }
  if (!pr) return { error: `PR #${n} not found` };

  const login = (a: GqlAuthor) => a?.login || "ghost";
  const items: DiscussionItem[] = [];
  for (const c of pr.comments.nodes)
    items.push({
      kind: "comment",
      author: login(c.author),
      when: c.createdAt,
      body: c.body,
      replies: [],
    });
  for (const rv of pr.reviews.nodes) {
    // A bodiless COMMENTED review is just the container for inline threads
    // (Greptile's shape); the threads carry the content.
    if (
      !rv.body.trim() &&
      rv.state !== "APPROVED" &&
      rv.state !== "CHANGES_REQUESTED"
    )
      continue;
    items.push({
      kind: "review",
      author: login(rv.author),
      when: rv.submittedAt ?? "",
      body: rv.body,
      state: rv.state,
      replies: [],
    });
  }
  for (const t of pr.reviewThreads.nodes) {
    const [first, ...rest] = t.comments.nodes;
    if (!first) continue;
    items.push({
      kind: "thread",
      author: login(first.author),
      when: first.createdAt,
      body: first.body,
      path: t.path,
      line: t.line ?? t.originalLine ?? null,
      resolved: t.isResolved,
      outdated: t.isOutdated,
      replies: rest.map((c) => ({
        author: login(c.author),
        when: c.createdAt,
        body: c.body,
      })),
    });
  }
  items.sort((a, b) => a.when.localeCompare(b.when));
  return {
    data: {
      number: pr.number,
      title: pr.title,
      author: login(pr.author),
      url: pr.url,
      createdAt: pr.createdAt,
      body: pr.body,
      items,
    },
  };
}

function ago(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ----- markdown → styled lines -----------------------------------------
//
// PR bodies are GitHub-flavored markdown with HTML mixed in (Greptile's
// badges, <details> blocks, Vercel's deployment tables). OpenTUI owns
// terminal styling, so this renders to spans rather than ANSI: the HTML is
// rewritten to the markdown it stands for, each line gets its block shape
// (GitHub treats a newline in a comment as a hard break, so lines never
// merge), inline marks are parsed within it, and the result is word-wrapped
// to the dialog width. Images come out as a labeled "⧉ alt" placeholder: the
// terminal renderer can't take GitHub's private attachments or SVG badges.

type Span = {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
};
type Style = Omit<Span, "text">;
type StyledLine = Span[];

const MD_HEADING_COLOR = "#79C0FF";
const MD_CODE_COLOR = "#E3B341";
const MD_IMAGE_COLOR = "magenta";
const MD_MARK_COLOR = "#A7B1C2";

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// Rewrite the HTML GitHub allows in comments into the markdown it stands for,
// so one inline parser handles both. Inline code is masked first: a literal
// `Array<string>` has to survive the tag stripping.
function htmlToMarkdown(text: string): string {
  const codes: string[] = [];
  const masked = text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (m) => {
    codes.push(m);
    return `@@code${codes.length - 1}@@`;
  });
  const out = masked
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(?:picture|source)\b[^>]*>|<\/picture>/gi, "")
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const alt = /\balt="([^"]*)"/i.exec(tag)?.[1] ?? "";
      const src = /\bsrc="([^"]*)"/i.exec(tag)?.[1] ?? "";
      return `![${alt}](${src || "#"})`;
    })
    // a linked image becomes [![alt](src)](href), which the inline pass reads
    // as a badge and renders as its label
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<summary\b[^>]*>([\s\S]*?)<\/summary>/gi, "\n▸ $1\n")
    .replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<(i|em)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*")
    .replace(/<(code|kbd)\b[^>]*>([\s\S]*?)<\/\1>/gi, "`$2`")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(?:p|div|details|ul|ol|li|table|thead|tbody|tr|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(out).replace(
    /@@code(\d+)@@/g,
    (_m, i: string) => codes[Number(i)] ?? "",
  );
}

// Run the HTML rewrite over everything outside fenced code, which is kept
// byte-for-byte: a `<T>` in a code sample is code, not a tag.
function preprocessMarkdown(body: string): string {
  const out: string[] = [];
  let prose: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (prose.length) out.push(htmlToMarkdown(prose.join("\n")));
    prose = [];
  };
  for (const line of body.replace(/\r/g, "").split("\n")) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      out.push(line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
    } else if (m) {
      flush();
      fence = m[1];
      out.push(line);
    } else {
      prose.push(line);
    }
  }
  flush();
  return out.join("\n");
}

// Inline marks, tried in this order at each position. Groups:
//   1-2 code   3 badge link ([![alt](img)](href))   4-5 image   6-7 link
//   8-9 bold   10 strike   11-12 emphasis   13 bare url
const INLINE_RE =
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\[!\[([^\]]*)\]\([^)]*\)\]\([^)]*\)|!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|(?<![\w`*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])|(?<![\w`])_(?!\s)(.+?)(?<!\s)_(?!\w)|<?(https?:\/\/[^\s<>)\]]+)>?/g;

function inline(text: string, base: Style): Span[] {
  const spans: Span[] = [];
  const push = (t: string, st: Style) => {
    if (t) spans.push({ ...st, text: t });
  };
  const re = new RegExp(INLINE_RE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index), base);
    last = m.index + m[0].length;
    if (m[2] != null) push(m[2].trim(), { ...base, color: MD_CODE_COLOR });
    else if (m[3] != null) {
      // a linked badge (Greptile's P1 / security tags) reads as its label
      if (m[3].trim()) push(`[${m[3].trim()}]`, { ...base, color: MD_IMAGE_COLOR });
    } else if (m[4] != null) {
      // an inline image with no alt is decoration (Vercel's avatars): drop it.
      // Screenshots sit on their own line and are handled as a block.
      if (m[4].trim()) push(`⧉ ${m[4].trim()}`, { ...base, color: MD_IMAGE_COLOR });
    } else if (m[6] != null) spans.push(...inline(m[6], { ...base, underline: true }));
    else if (m[8] != null || m[9] != null)
      spans.push(...inline((m[8] ?? m[9])!, { ...base, bold: true }));
    else if (m[10] != null) spans.push(...inline(m[10], { ...base, strike: true }));
    else if (m[11] != null || m[12] != null)
      spans.push(...inline((m[11] ?? m[12])!, { ...base, italic: true }));
    else if (m[13] != null) push(m[13], { ...base, underline: true, dim: true });
  }
  push(text.slice(last), base);
  return spans;
}

// Width in terminal cells as the renderer measures it: East-Asian-ambiguous
// characters (em dash, arrows, ●) count as two cells there, and a line that
// only fits by string length comes back truncated.
function cellWidth(text: string): number {
  return Bun.stringWidth(text, { ambiguousIsNarrow: false });
}

function spanWidth(spans: Span[]): number {
  return spans.reduce((n, s) => n + cellWidth(s.text), 0);
}

// Word-wrap spans to `width`. `first` prefixes the first line (a bullet), and
// `hang` every continuation. Adjacent non-space text is one word even when it
// crosses a style boundary — "(`code`)" never breaks after the paren — and a
// word wider than the room left is hard-broken, so a long URL or hash still
// lands inside the box.
function wrapSpans(
  spans: Span[],
  width: number,
  first: Span[],
  hang: Span[],
): StyledLine[] {
  type Piece = { span: Span; text: string };
  type Token = { pieces: Piece[]; width: number; space: boolean };
  const tokens: Token[] = [];
  for (const sp of spans) {
    for (const part of sp.text.match(/\s+|\S+/g) ?? []) {
      const space = /^\s+$/.test(part);
      const last = tokens[tokens.length - 1];
      if (!space && last && !last.space) {
        last.pieces.push({ span: sp, text: part });
        last.width += cellWidth(part);
      } else {
        tokens.push({ pieces: [{ span: sp, text: part }], width: cellWidth(part), space });
      }
    }
  }

  const out: StyledLine[] = [];
  let cur: Span[] = [...first];
  let curW = spanWidth(first);
  let lineStart = true;
  // trailing whitespace would hang past the width and get the line truncated
  const trimEnd = (line: Span[]) => {
    while (line.length && /^\s*$/.test(line[line.length - 1].text)) line.pop();
    const last = line[line.length - 1];
    if (last) last.text = last.text.replace(/\s+$/, "");
    return line;
  };
  const flush = () => {
    out.push(trimEnd(cur));
    cur = [...hang];
    curW = spanWidth(hang);
    lineStart = true;
  };
  const put = (sp: Span, text: string) => {
    cur.push({ ...sp, text });
    curW += cellWidth(text);
  };
  for (const tok of tokens) {
    if (tok.space) {
      if (!lineStart) put(tok.pieces[0].span, tok.pieces[0].text); // none after a wrap
      continue;
    }
    if (curW + tok.width > width && !lineStart) flush();
    for (const piece of tok.pieces) {
      let text = piece.text;
      while (cellWidth(text) > width - curW && width > curW) {
        const take = width - curW; // by char; only ASCII-long words (urls) get here
        put(piece.span, text.slice(0, take));
        text = text.slice(take);
        flush();
      }
      put(piece.span, text);
      lineStart = false;
    }
  }
  if (!lineStart || out.length === 0) out.push(trimEnd(cur));
  return out;
}

function renderMarkdown(body: string, width: number): StyledLine[] {
  const lines: StyledLine[] = [];
  let fence: string | null = null;
  let blankPending = false; // runs of blank lines collapse to one
  const emit = (l: StyledLine) => {
    if (blankPending && lines.length) lines.push([]);
    blankPending = false;
    lines.push(l);
  };
  const emitWrapped = (spans: Span[], first: Span[], hang: Span[]) => {
    for (const l of wrapSpans(spans, width, first, hang)) emit(l);
  };
  const gutter: Span = { text: "  │ ", dim: true };
  const src = preprocessMarkdown(body).split("\n");

  for (let i = 0; i < src.length; i++) {
    const line = src[i].replace(/\t/g, "    ");
    const fm = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length) fence = null;
      else emit([gutter, { text: line, color: MD_CODE_COLOR }]); // truncated, never wrapped
      continue;
    }
    if (fm) {
      fence = fm[1];
      continue;
    }
    if (!line.trim()) {
      blankPending = true;
      continue;
    }
    // reference-style link definition (Vercel's "[vc]: #…" marker) — invisible
    // in rendered markdown
    if (/^\[[^\]]+\]:\s+\S+/.test(line)) continue;

    let m: RegExpExecArray | null;
    if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
      blankPending = blankPending || lines.length > 0; // room above a heading
      const color = m[1].length <= 2 ? MD_HEADING_COLOR : undefined;
      emitWrapped(inline(m[2], { bold: true, color }), [], []);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      emit([{ text: "─".repeat(Math.min(width, 40)), dim: true }]);
      continue;
    }
    if ((m = /^\s*!\[([^\]]*)\]\(([^)\s]+)[^)]*\)\s*$/.exec(line))) {
      // a block-level image is usually a screenshot: keep its address in view
      emit([
        { text: `⧉ ${m[1].trim() || "image"}`, color: MD_IMAGE_COLOR },
        { text: `  ${m[2]}`, dim: true },
      ]);
      continue;
    }
    if ((m = /^▸ (.*)$/.exec(line))) {
      // a <details> summary: bold, with the disclosure mark as its bullet
      emitWrapped(
        inline(m[1], { bold: true }),
        [{ text: "▸ ", color: MD_MARK_COLOR }],
        [{ text: "  " }],
      );
      continue;
    }
    if ((m = /^\s*>\s?(.*)$/.exec(line))) {
      const bar: Span = { text: "▎ ", dim: true };
      emitWrapped(inline(m[1], { dim: true }), [bar], [bar]);
      continue;
    }
    if ((m = /^(\s*)([-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line))) {
      const depth = Math.floor(m[1].length / 2);
      const pad = "  ".repeat(depth);
      const marker =
        m[3] != null
          ? m[3] === " "
            ? "☐"
            : "☑"
          : /^\d/.test(m[2])
            ? m[2]
            : ["•", "◦", "▪"][depth % 3];
      const hang = " ".repeat(pad.length + marker.length + 1);
      emitWrapped(
        inline(m[4], {}),
        [{ text: pad }, { text: marker, color: MD_MARK_COLOR }, { text: " " }],
        [{ text: hang }],
      );
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(line)) continue; // alignment row
      const header = /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(src[i + 1] ?? "");
      const cells = line.trim().slice(1, -1).split("|");
      const spans: Span[] = [];
      cells.forEach((c, ci) => {
        if (ci > 0) spans.push({ text: " │ ", dim: true });
        spans.push(...inline(c.trim(), { bold: header }));
      });
      emit(spans); // rows keep their columns: truncated, never wrapped
      continue;
    }
    if ((m = /^(\s{2,})(.*)$/.exec(line))) {
      // indented continuation of a list item or nested block
      const pad: Span = { text: "  ".repeat(Math.min(4, Math.floor(m[1].length / 2))) };
      emitWrapped(inline(m[2], {}), [pad], [pad]);
      continue;
    }
    emitWrapped(inline(line, {}), [], []);
  }
  return lines;
}

// First readable line of a body, marks and tags stripped — the one-line peek
// a folded thread shows.
function plainText(md: string): string {
  return (
    preprocessMarkdown(md)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^(```|~~~|\[[^\]]+\]:)/.test(l))
      .map((l) =>
        l
          .replace(/\[!\[([^\]]*)\]\([^)]*\)\]\([^)]*\)/g, "[$1]")
          .replace(/!\[([^\]]*)\]\([^)]*\)/g, "[$1]")
          .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
          .replace(/[*_`~#>]+/g, "")
          .trim(),
      )
      .find(Boolean) ?? ""
  );
}

function reviewVerb(state: string | undefined): { text: string; color?: string } {
  if (state === "APPROVED") return { text: "approved", color: "green" };
  if (state === "CHANGES_REQUESTED") return { text: "requested changes", color: "red" };
  if (state === "DISMISSED") return { text: "review dismissed" };
  return { text: "reviewed" };
}

// Bots whose comments are deployment tables and link-backs, not review. They
// fold to a header line unless the dialog is unfolded (x).
const NOISY_BOTS = new Set([
  "vercel",
  "linear",
  "github-actions",
  "codecov",
  "dependabot",
  "renovate",
  "netlify",
]);

function indentLines(ls: StyledLine[], pad: string): StyledLine[] {
  return ls.map((l) => (l.length ? [{ text: pad }, ...l] : l));
}

// The whole dialog body as lines, plus the line index where each comment
// starts (n/p jump between them).
function renderDiscussion(
  d: Discussion,
  width: number,
  showAll: boolean,
): { lines: StyledLine[]; marks: number[] } {
  const lines: StyledLine[] = [];
  const marks: number[] = [];

  lines.push(
    ...(d.body.trim()
      ? renderMarkdown(d.body, width)
      : [[{ text: "(no description)", dim: true }]]),
  );

  const unresolved = d.items.filter((i) => i.kind === "thread" && !i.resolved).length;
  lines.push([]);
  marks.push(lines.length);
  lines.push([{ text: "─".repeat(Math.min(width, 40)), dim: true }]);
  const head: Span[] = [
    {
      text: `${d.items.length} comment${d.items.length === 1 ? "" : "s"}`,
      bold: true,
      color: MD_HEADING_COLOR,
    },
  ];
  if (unresolved)
    head.push({
      text: ` · ${unresolved} unresolved thread${unresolved === 1 ? "" : "s"}`,
      color: "yellow",
    });
  lines.push(head);
  if (d.items.length === 0) lines.push([{ text: "(none yet)", dim: true }]);

  for (const it of d.items) {
    lines.push([]);
    marks.push(lines.length);
    const noisy = NOISY_BOTS.has(it.author) && !showAll;
    const folded = noisy || (it.kind === "thread" && it.resolved && !showAll);

    const row: Span[] = [];
    if (it.kind === "thread")
      row.push(
        it.resolved ? { text: "✓ ", color: "green" } : { text: "● ", color: "yellow" },
      );
    else if (it.kind === "review")
      row.push(
        it.state === "APPROVED"
          ? { text: "✓ ", color: "green" }
          : it.state === "CHANGES_REQUESTED"
            ? { text: "✗ ", color: "red" }
            : { text: "● ", color: "cyan" },
      );
    else row.push({ text: "● ", color: noisy ? "gray" : "cyan" });
    row.push({ text: it.author, bold: !folded, dim: folded });
    if (it.kind === "review") {
      const v = reviewVerb(it.state);
      row.push({ text: ` ${v.text}`, color: v.color, dim: !v.color });
    }
    if (it.kind === "thread" && it.path)
      row.push({
        text: ` · ${it.path}${it.line != null ? `:${it.line}` : ""}`,
        dim: true,
      });
    if (it.resolved) row.push({ text: " · resolved", color: "green" });
    if (it.outdated) row.push({ text: " · outdated", dim: true });
    row.push({ text: ` · ${ago(it.when)}`, dim: true });
    if (it.replies.length)
      row.push({
        text: ` · ${it.replies.length} repl${it.replies.length === 1 ? "y" : "ies"}`,
        dim: true,
      });
    if (folded)
      row.push({
        text: noisy ? "  (bot · x to show)" : "  (x to unfold)",
        dim: true,
        italic: true,
      });
    // a long path would otherwise be truncated out of the header
    lines.push(...wrapSpans(row, width, [], [{ text: "  " }]));

    if (folded) {
      // one dim line keeps a resolved thread findable without reading it
      const peek = noisy ? "" : plainText(it.body);
      if (peek)
        lines.push(
          ...wrapSpans(
            [{ text: peek, dim: true }],
            width,
            [{ text: "  " }],
            [{ text: "  " }],
          ).slice(0, 1),
        );
      continue;
    }
    lines.push(...indentLines(renderMarkdown(it.body, width - 2), "  "));
    for (const r of it.replies) {
      lines.push([]);
      lines.push([
        { text: "  ↳ ", dim: true },
        { text: r.author, bold: true },
        { text: ` · ${ago(r.when)}`, dim: true },
      ]);
      lines.push(...indentLines(renderMarkdown(r.body, width - 4), "    "));
    }
  }
  return { lines, marks };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App() {
  const { exit } = useApp();
  const { cols, rows } = useTermSize();

  const [screen, setScreen] = useState<Screen>("loading");
  const [fatal, setFatal] = useState<string | null>(null);
  const [stackChoices, setStackChoices] = useState<StackData[]>([]);
  const [pickIdx, setPickIdx] = useState(0);
  const [stack, setStack] = useState<StackData | null>(null);
  const [details, setDetails] = useState<Map<number, PrDetails>>(new Map());
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<Badge | null>(null);
  const [comment, setComment] = useState<CommentDraft | null>(null);
  // A keyboard burst — fast typing, or a paste that arrives as separate key
  // events — delivers many keys before React re-renders, so the draft lives in
  // a ref and state only mirrors it for display. Editing off the last render
  // would keep nothing but the final keystroke.
  const commentRef = useRef<CommentDraft | null>(null);
  // space: the selected PR's description + conversation. Fetched once per PR
  // (r inside the dialog refreshes), cached for the session.
  const [desc, setDesc] = useState<DescDialog | null>(null);
  const discussionCache = useRef(new Map<number, Discussion>());

  // display order: trunk on top, then the stack bottom-up — the oldest PR
  // (closest to trunk) first, the newest last — so the list reads in merge order
  const entries = useMemo(() => stack?.branches ?? [], [stack]);

  const [selected, setSelected] = useState(0);
  // branch names whose sidebar row is expanded to show individual CI checks
  const [expandedPrs, setExpandedPrs] = useState<Set<string>>(new Set());
  const [diffLines, setDiffLines] = useState<string[] | null>(null);
  const [scroll, setScroll] = useState(0);

  const diffCache = useRef(new Map<number, string[]>());
  // in-flight diff fetches, so a prefetch and a selection never fetch twice
  const diffPromises = useRef(new Map<number, Promise<string[]>>());
  const scrollMemo = useRef(new Map<number, number>());
  const diffSeq = useRef(0);
  const syncSeq = useRef(0);

  const refreshDetails = useCallback((prNumber: number) => {
    fetchPrDetails(prNumber).then((d) => {
      if (!d) return;
      setDetails((m) => {
        const next = new Map(m);
        next.set(prNumber, d);
        return next;
      });
    });
  }, []);

  const openStack = useCallback(
    (s: StackData) => {
      setStack(s);
      const cur = s.branches.findIndex((b) => b.isCurrent);
      setSelected(cur >= 0 ? cur : 0);
      setScreen("main");
      // enrich each PR with title/state/checks in parallel
      for (const b of s.branches) {
        if (b.prNumber != null) refreshDetails(b.prNumber);
      }
      // Fetch + sync detection is the slow, network-bound part of loading, so
      // it runs behind the first paint and patches the stack when it lands.
      const seq = ++syncSeq.current;
      fetchRefs()
        .then(() => annotateSync(s))
        .then((annotated) => {
          if (syncSeq.current === seq) setStack(annotated);
        })
        .catch(() => {});
    },
    [refreshDetails],
  );

  const load = useCallback(() => {
    setScreen("loading");
    setDetails(new Map());
    diffCache.current.clear();
    diffPromises.current.clear();
    syncSeq.current++;
    setDiffLines(null);
    resolveStacks()
      .then(({ stacks, error }) => {
        if (error || stacks.length === 0) {
          setFatal(error ?? "No stacks found.");
          setScreen("fatal");
        } else if (stacks.length === 1) {
          openStack(stacks[0]);
        } else {
          setStackChoices(stacks);
          setPickIdx(0);
          setScreen("pick");
        }
      })
      .catch((e: Error) => {
        setFatal(e.message);
        setScreen("fatal");
      });
  }, [openStack]);

  useEffect(load, [load]);

  // Run a confirmed action. A merge finishes here, so reload after it; a
  // rebase only *starts* here (the agent in the new pane does the work), so
  // reloading immediately would just show the pre-rebase state.
  const runAction = useCallback(
    (action: PendingAction) => {
      setPending(null);
      setActionMsg(null);
      setBusy(
        action.kind === "rebase"
          ? "starting rebase agent…"
          : action.kind === "merge"
            ? "merging stack…"
            : "approving…",
      );
      action
        .exec()
        .then(({ code, out, err }) => {
          setBusy(null);
          if (code === 0) {
            setActionMsg({
              text: `${action.kind} ok — ${firstLine(out) || "done"}`,
              color: "green",
            });
            if (action.kind === "merge") load();
            action.after?.();
            return;
          }
          setActionMsg({
            text: `${action.kind} failed — ${firstLine(err) || firstLine(out) || `exit ${code}`}`,
            color: "red",
          });
        })
        .catch((e: Error) => {
          setBusy(null);
          setActionMsg({ text: `${action.kind} failed — ${e.message}`, color: "red" });
        });
    },
    [load],
  );

  const ensureDiff = useCallback((num: number): Promise<string[]> => {
    let p = diffPromises.current.get(num);
    if (!p) {
      p = fetchDiff(num).then((lines) => {
        diffCache.current.set(num, lines);
        return lines;
      });
      diffPromises.current.set(num, p);
    }
    return p;
  }, []);

  // load the diff for the selected PR (cached per PR number)
  const sel = entries[selected];
  useEffect(() => {
    if (screen !== "main" || !sel) return;
    setScroll(sel.prNumber != null ? (scrollMemo.current.get(sel.prNumber) ?? 0) : 0);
    if (sel.prNumber == null) {
      setDiffLines(["(no PR for this branch yet — nothing to diff)"]);
    } else {
      const cached = diffCache.current.get(sel.prNumber);
      if (cached) {
        setDiffLines(cached);
      } else {
        setDiffLines(null);
        const seq = ++diffSeq.current;
        ensureDiff(sel.prNumber).then((lines) => {
          if (diffSeq.current === seq) setDiffLines(lines);
        });
      }
    }
    // prefetch the neighbors so j/k lands on an already-loaded diff
    for (const nb of [entries[selected + 1], entries[selected - 1]]) {
      if (nb?.prNumber != null && !diffCache.current.has(nb.prNumber))
        ensureDiff(nb.prNumber);
    }
  }, [screen, sel, entries, selected, ensureDiff]);

  // ----- comment --------------------------------------------------------
  const putComment = useCallback((c: CommentDraft | null) => {
    commentRef.current = c;
    setComment(c);
  }, []);

  const editComment = useCallback(
    (edit: (text: string) => string) => {
      const c = commentRef.current;
      if (!c || c.sending) return;
      putComment({ ...c, text: edit(c.text) });
    },
    [putComment],
  );

  // Open the dialog immediately and resolve the Herdr tab behind it, so typing
  // can start while the lookup runs and the destination shows up when it lands.
  const openComment = useCallback(() => {
    const branch = sel?.branch ?? stack?.currentBranch ?? "";
    const ticket = branch ? ticketFor(branch) : null;
    if (!ticket) {
      setActionMsg({
        text: branch
          ? `no Linear ticket in "${branch}" — nothing to comment on`
          : "no branch to read a ticket off",
        color: "red",
      });
      return;
    }
    putComment({
      ticket,
      branch,
      prNumber: sel?.prNumber ?? null,
      text: "",
      target: null,
      error: null,
      sending: false,
    });
    resolveCommentTarget(ticket).then(({ target, error }) => {
      const c = commentRef.current;
      if (!c || c.ticket !== ticket) return; // dialog closed or reopened since
      putComment({ ...c, target: target ?? null, error: error ?? null });
    });
  }, [sel, stack, putComment]);

  const submitComment = useCallback(() => {
    const c = commentRef.current;
    if (!c || c.sending || !c.target || !c.text.trim()) return;
    const { target } = c;
    const body = commentBody(c);
    putComment({ ...c, sending: true });
    run(["herdr", "agent", "prompt", target.agent, body])
      .then((r) => {
        putComment(null);
        setActionMsg(
          r.code === 0
            ? { text: `comment sent to ${target.tabLabel}`, color: "green" }
            : { text: `comment failed — ${herdrError(r)}`, color: "red" },
        );
      })
      .catch((e: Error) => {
        putComment(null);
        setActionMsg({ text: `comment failed — ${e.message}`, color: "red" });
      });
  }, [putComment]);

  // ----- description dialog ---------------------------------------------
  const loadDiscussion = useCallback((prNumber: number) => {
    setDesc((d) => (d && d.prNumber === prNumber ? { ...d, loading: true } : d));
    fetchDiscussion(prNumber).then(({ data, error }) => {
      if (data) discussionCache.current.set(prNumber, data);
      setDesc((d) =>
        d && d.prNumber === prNumber
          ? { ...d, data: data ?? d.data, error: error ?? null, loading: false }
          : d,
      );
    });
  }, []);

  const openDesc = useCallback(
    (b: StackBranch, showAll = false) => {
      if (b.prNumber == null) {
        setActionMsg({
          text: `no PR for ${b.branch} yet — nothing to describe`,
          color: "red",
        });
        return;
      }
      const cached = discussionCache.current.get(b.prNumber) ?? null;
      setDesc({
        prNumber: b.prNumber,
        data: cached,
        error: null,
        loading: !cached,
        scroll: 0,
        showAll,
      });
      if (!cached) loadDiscussion(b.prNumber);
    },
    [loadDiscussion],
  );

  // ----- zed ------------------------------------------------------------
  // z: check the selected branch out (when it isn't already) and open its
  // worktree in Zed. Runs as a busy action so a second z can't race the
  // checkout; the sidebar's ✦ follows HEAD once git has answered.
  const openZed = useCallback((b: StackBranch) => {
    setActionMsg(null);
    setBusy(`opening ${b.branch} in zed…`);
    openInZed(b.branch)
      .then(async (r) => {
        if (r.code !== 0) {
          setBusy(null);
          setActionMsg({
            text: `zed failed — ${firstLine(r.err) || `exit ${r.code}`}`,
            color: "red",
          });
          return;
        }
        // the checkout may have moved HEAD; re-read it rather than assume
        const cur = await currentBranch();
        setStack(
          (s) =>
            s && {
              ...s,
              currentBranch: cur,
              branches: s.branches.map((x) => ({
                ...x,
                isCurrent: x.branch === cur,
                hasLocal: x.hasLocal || x.branch === cur,
              })),
            },
        );
        setBusy(null);
        setActionMsg({ text: r.out, color: "green" });
      })
      .catch((e: Error) => {
        setBusy(null);
        setActionMsg({ text: `zed failed — ${e.message}`, color: "red" });
      });
  }, []);

  // ----- approve --------------------------------------------------------
  // a: stage an approval of the selected PR; y submits `gh pr review
  // --approve`. GitHub refuses to approve your own PR, which surfaces as the
  // failure text in the footer.
  const approvePr = useCallback(
    (b: StackBranch) => {
      if (b.prNumber == null) {
        setActionMsg({
          text: `no PR for ${b.branch} yet — nothing to approve`,
          color: "red",
        });
        return;
      }
      const n = b.prNumber;
      setPending({
        kind: "approve",
        prompt: `Approve #${n} (${details.get(n)?.title ?? b.branch})?`,
        exec: () => run(["gh", "pr", "review", String(n), "--approve"]),
        after: () => refreshDetails(n),
      });
    },
    [details, refreshDetails],
  );

  // A: the same, for every PR in the stack that is still open. One
  // confirmation, then the approvals run in order; a refusal on one (your own
  // PR, say) is reported without stopping the rest.
  const approveAll = useCallback(() => {
    if (!stack) return;
    const open = stack.branches.filter((b) => {
      if (b.prNumber == null || b.isMerged) return false;
      const state = details.get(b.prNumber)?.state ?? b.prState ?? "";
      return state !== "MERGED" && state !== "CLOSED";
    });
    if (open.length === 0) {
      setActionMsg({ text: "no open PRs in this stack to approve", color: "red" });
      return;
    }
    const nums = open.map((b) => b.prNumber!);
    setPending({
      kind: "approve",
      prompt: `Approve ${nums.length} open PR${nums.length === 1 ? "" : "s"} in ${stack.label} (${nums.map((n) => `#${n}`).join(" ")})?`,
      exec: async () => {
        const ok: number[] = [];
        const failed: string[] = [];
        for (const n of nums) {
          const r = await run(["gh", "pr", "review", String(n), "--approve"]);
          if (r.code === 0) ok.push(n);
          else failed.push(`#${n}: ${firstLine(r.err || r.out) || `exit ${r.code}`}`);
        }
        const done = `${ok.length}/${nums.length} approved`;
        return failed.length === 0
          ? { code: 0, out: done, err: "" }
          : { code: 1, out: "", err: `${done}; ${failed.join("; ")}` };
      },
      after: () => nums.forEach(refreshDetails),
    });
  }, [stack, details, refreshDetails]);

  // ----- layout ---------------------------------------------------------
  const sidebarW = Math.max(28, Math.min(46, Math.floor(cols * 0.34)));
  // OpenTUI reserves the terminal's first line and Yoga needs room for the
  // header, footer, and their separating rows. Keep the visible diff within
  // the actual flex body so its title rows never collapse under line content.
  // border rows plus destination / input / hint, when the dialog is up
  const commentH = comment ? 5 : 0;
  const bodyH = Math.max(4, rows - 5 - commentH);
  const diffViewH = Math.max(1, bodyH - 2); // pane title line + meta line

  // sidebar windowing: 2 rows per entry, plus its check rows when expanded,
  // plus the trunk row. Heights vary, so grow the window outward from the
  // selection until the row budget is spent.
  const isExpanded = (b: StackBranch) =>
    b.prNumber != null && expandedPrs.has(b.branch);
  const entryHeights = entries.map(
    (b) =>
      2 + (isExpanded(b) ? checkRowsFor(details.get(b.prNumber!)).length : 0),
  );
  const rowBudget = Math.max(2, bodyH - 1);
  let winStart = Math.min(selected, Math.max(0, entries.length - 1));
  let winEnd = entries.length === 0 ? 0 : winStart + 1;
  {
    let used = entryHeights[winStart] ?? 0;
    let up = winStart - 1;
    let down = winEnd;
    let grew = true;
    while (grew) {
      grew = false;
      if (up >= 0 && used + entryHeights[up] <= rowBudget) {
        used += entryHeights[up];
        winStart = up--;
        grew = true;
      }
      if (down < entries.length && used + entryHeights[down] <= rowBudget) {
        used += entryHeights[down];
        winEnd = ++down;
        grew = true;
      }
    }
  }
  const winEntries = entries.slice(winStart, winEnd);

  const fileMarks = useMemo(() => {
    if (!diffLines) return [] as number[];
    const marks: number[] = [];
    diffLines.forEach((l, i) => {
      if (l.startsWith("Δ ")) marks.push(i);
    });
    return marks;
  }, [diffLines]);

  const maxScroll = Math.max(0, (diffLines?.length ?? 0) - diffViewH);

  const setScrollFor = useCallback(
    (updater: (v: number) => number) => {
      setScroll((v) => {
        const next = Math.max(0, Math.min(maxScroll, updater(v)));
        if (sel?.prNumber != null) scrollMemo.current.set(sel.prNumber, next);
        return next;
      });
    },
    [maxScroll, sel],
  );

  // The description dialog replaces the body: border rows plus its two header
  // rows. Prose wraps at a readable measure; code and table rows keep the
  // full width and truncate.
  const descViewH = Math.max(1, bodyH - 4 - (desc?.error ? 1 : 0));
  const descTextW = Math.max(20, Math.min(100, cols - 5)); // border, padding, bar
  const descRender = useMemo(
    () =>
      desc?.data
        ? renderDiscussion(desc.data, descTextW, desc.showAll)
        : { lines: [] as StyledLine[], marks: [] as number[] },
    [desc?.data, desc?.showAll, descTextW],
  );
  const descMax = Math.max(0, descRender.lines.length - descViewH);
  const scrollDesc = useCallback(
    (updater: (v: number) => number) =>
      setDesc(
        (d) =>
          d && { ...d, scroll: Math.max(0, Math.min(descMax, updater(d.scroll))) },
      ),
    [descMax],
  );

  // ----- mouse ----------------------------------------------------------
  const { stdin } = useStdin();

  const onMouse = useRef<(button: number, x: number, y: number) => void>(() => {});
  onMouse.current = (button, x, y) => {
    if (comment) return; // the dialog owns the screen while it is open
    if (button === 64 || button === 65) {
      // wheel: over the sidebar it moves the selection, elsewhere it scrolls
      const dir = button === 64 ? -1 : 1;
      if (desc) scrollDesc((v) => v + dir * 3);
      else if (screen === "pick")
        setPickIdx((i) => Math.max(0, Math.min(stackChoices.length - 1, i + dir)));
      else if (screen !== "main") return;
      else if (x < sidebarW)
        setSelected((i) => Math.max(0, Math.min(entries.length - 1, i + dir)));
      else setScrollFor((v) => v + dir * 3);
      return;
    }
    // Geometry, 0-based like x/y and measured with injected clicks rather than
    // assumed: OpenTUI draws with a one-cell margin, so terminal row 0 and
    // column 0 stay blank, the header is row 1, the body starts at row 2
    // (sidebar border / diff title / dialog border), and the rightmost drawn
    // column is cols - 2. A scrollbar is one column wide, so its hit zone is
    // widened by a column either side.
    const DIFF_TOP = 4; // body + diff title + meta
    const DIFF_BAR_X = cols - 2; // last drawn column
    const DESC_BAR_X = cols - 4; // inside the dialog's border + padding
    // a click (or left drag, 32) on a scrollbar column jumps to that spot
    if ((button === 0 || button === 32) && screen === "main") {
      if (desc) {
        const top = 5 + (desc.error ? 1 : 0); // body + border + title + meta[, error]
        if (
          Math.abs(x - DESC_BAR_X) <= 1 &&
          y >= top &&
          y < top + descViewH &&
          descMax > 0
        ) {
          scrollDesc(() =>
            Math.round(((y - top) / Math.max(1, descViewH - 1)) * descMax),
          );
          return;
        }
      } else if (
        Math.abs(x - DIFF_BAR_X) <= 1 &&
        y >= DIFF_TOP &&
        y < DIFF_TOP + diffViewH &&
        maxScroll > 0
      ) {
        setScrollFor(() =>
          Math.round(((y - DIFF_TOP) / Math.max(1, diffViewH - 1)) * maxScroll),
        );
        return;
      }
    }
    if (button !== 0) return; // left click only
    if (desc) return; // nothing else to click in the description dialog

    if (screen === "pick") {
      // padding row + title + subtitle + margin row, then 2 rows per stack
      const i = Math.floor((y - 4) / 2);
      if (y >= 4 && i < stackChoices.length) openStack(stackChoices[i]);
      return;
    }
    if (screen !== "main" || x >= sidebarW) return;
    // blank row, header, border, trunk row, plus the "↑ N more" line when windowed
    const top = 4 + (winStart > 0 ? 1 : 0);
    let rem = y - top;
    if (rem < 0) return;
    for (let i = winStart; i < winEnd; i++) {
      rem -= entryHeights[i];
      if (rem < 0) {
        setSelected(i);
        return;
      }
    }
  };

  useEffect(() => {
    if (!stdin) return;
    const onData = (data: Buffer | string) => {
      // SGR mouse reports: \x1b[<button;col;row then M (press) / m (release)
      const re = /\x1b\[<(\d+);(\d+);(\d+)M/g;
      const s = data.toString();
      let m: RegExpExecArray | null;
      while ((m = re.exec(s)))
        onMouse.current(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 1);
    };
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
    };
  }, [stdin]);

  // ----- input ----------------------------------------------------------
  useInput((input, key) => {
    if (input.includes("[<")) return; // mouse reports, handled above

    // The comment dialog owns the keyboard while it is open: every printable
    // key is text, so nothing here may fall through to the keys below — "q"
    // types a q rather than quitting, and escape closes the dialog only.
    const draft = commentRef.current;
    if (draft) {
      if (key.escape) putComment(null);
      else if (draft.sending) return; // in flight; only escape gets out
      else if (key.return) submitComment();
      else if (key.backspace || key.delete) editComment((t) => t.slice(0, -1));
      else if (key.ctrl && input === "u") editComment(() => "");
      else if (key.ctrl && input === "w")
        editComment((t) => t.replace(/\s*\S+\s*$/, ""));
      else if (input && !key.ctrl && !key.meta)
        // a paste arrives as one chunk; flatten it onto the single input line
        editComment((t) => t + input.replace(/\s+/g, " "));
      return;
    }

    // A staged rebase/merge swallows every key until it is answered, so a
    // stray keystroke can't trigger it and can't be lost behind it either.
    if (pending) {
      if (input === "y" || input === "Y") runAction(pending);
      else setPending(null);
      return;
    }
    if (busy) return; // an action is in flight; ignore input until it settles
    // Clear a finished action's result on the next key, but still let that key
    // do its job — dismissing shouldn't cost a keystroke.
    if (actionMsg) setActionMsg(null);

    // The description dialog is modal: it reads like the diff pane (same
    // scroll keys), adds a few of its own, and nothing falls through to the
    // main view — q closes it rather than quitting.
    if (desc) {
      if (key.escape || input === "q") setDesc(null);
      else if (key.upArrow || input === "k") scrollDesc((v) => v - 1);
      else if (key.downArrow || input === "j") scrollDesc((v) => v + 1);
      else if (key.pageDown || input === " " || input === "f")
        scrollDesc((v) => v + descViewH);
      else if (key.pageUp || input === "b") scrollDesc((v) => v - descViewH);
      else if (input === "d") scrollDesc((v) => v + Math.ceil(descViewH / 2));
      else if (input === "u") scrollDesc((v) => v - Math.ceil(descViewH / 2));
      else if (input === "g") scrollDesc(() => 0);
      else if (input === "G") scrollDesc(() => descMax);
      else if (input === "n")
        scrollDesc((v) => descRender.marks.find((m) => m > v) ?? v);
      else if (input === "p")
        scrollDesc((v) => [...descRender.marks].reverse().find((m) => m < v) ?? 0);
      else if (input === "x") setDesc((d) => d && { ...d, showAll: !d.showAll });
      else if (key.tab || input === "J" || input === "K") {
        // step to the neighboring PR without leaving the dialog
        const dir = (key.tab && key.shift) || input === "K" ? -1 : 1;
        for (let i = selected + dir; i >= 0 && i < entries.length; i += dir) {
          if (entries[i].prNumber != null) {
            setSelected(i);
            openDesc(entries[i], desc.showAll);
            break;
          }
        }
      } else if (input === "c") openComment();
      else if (input === "o")
        Bun.spawn(["gh", "pr", "view", String(desc.prNumber), "--web"], {
          stdout: "ignore",
          stderr: "ignore",
        });
      else if (input === "r") loadDiscussion(desc.prNumber);
      else if (input === "z" && sel) openZed(sel);
      else if (input === "a" && sel) approvePr(sel);
      else if (input === "A") approveAll();
      return;
    }

    if (input === "q" || key.escape) {
      exit();
      return;
    }

    if (screen === "pick") {
      if (key.upArrow || input === "k") setPickIdx((i) => Math.max(0, i - 1));
      else if (key.downArrow || input === "j")
        setPickIdx((i) => Math.min(stackChoices.length - 1, i + 1));
      else if (key.return) openStack(stackChoices[pickIdx]);
      return;
    }

    if (screen !== "main") return;

    // j/k move between PRs. Line-at-a-time diff scrolling is gone on purpose:
    // the diff moves by half a page (d/u) or a whole one (space/b).
    if (key.upArrow || input === "k" || (key.tab && key.shift))
      setSelected((i) => Math.max(0, i - 1));
    else if (key.downArrow || input === "j" || key.tab)
      setSelected((i) => Math.min(entries.length - 1, i + 1));
    else if (/^[1-9]$/.test(input)) {
      const n = parseInt(input, 10) - 1;
      if (n < entries.length) setSelected(n);
    } else if (input === "l" || key.rightArrow) {
      // expand the selected PR into its CI checks
      const b = sel;
      if (b?.prNumber != null) {
        setExpandedPrs((s) => {
          if (s.has(b.branch)) return s;
          const next = new Set(s);
          next.add(b.branch);
          return next;
        });
        // re-fetch so the check list reflects CI right now, not load time
        refreshDetails(b.prNumber);
      }
    } else if (input === "h" || key.leftArrow) {
      const b = sel;
      if (b && expandedPrs.has(b.branch))
        setExpandedPrs((s) => {
          const next = new Set(s);
          next.delete(b.branch);
          return next;
        });
    } else if (key.pageDown || input === "f") setScrollFor((v) => v + diffViewH);
    else if (key.pageUp || input === "b") setScrollFor((v) => v - diffViewH);
    else if (input === "d") setScrollFor((v) => v + Math.ceil(diffViewH / 2));
    else if (input === "u") setScrollFor((v) => v - Math.ceil(diffViewH / 2));
    else if (input === "g") setScrollFor(() => 0);
    else if (input === "G") setScrollFor(() => maxScroll);
    else if (input === "n")
      setScrollFor((v) => fileMarks.find((m) => m > v) ?? v);
    else if (input === "p")
      setScrollFor((v) => [...fileMarks].reverse().find((m) => m < v) ?? 0);
    else if (input === " " && sel) openDesc(sel);
    else if (input === "z" && sel) openZed(sel);
    else if (input === "a" && sel) approvePr(sel);
    else if (input === "A") approveAll();
    else if (input === "c") openComment();
    else if (input === "o" && sel?.prNumber != null)
      Bun.spawn(["gh", "pr", "view", String(sel.prNumber), "--web"], {
        stdout: "ignore",
        stderr: "ignore",
      });
    else if (input === "r") load();
    else if (input === "R") {
      const s = stack;
      if (!s) return;
      const stale = staleBranches(s);
      const drift = driftedBranches(s);
      const what =
        stale.length > 0
          ? `${stale.length} branch${stale.length === 1 ? "" : "es"} behind their base`
          : "nothing looks stale";
      setPending({
        kind: "rebase",
        prompt:
          `Hand the rebase to a Claude agent in a new pane on the right? (${what}` +
          (drift.length > 0 ? `; ${drift.length} with local drift` : "") +
          `) — it rebases onto ${s.trunk}, resolves conflicts itself, and force-pushes for review.`,
        exec: () => launchRebaseAgent(s),
      });
    } else if (input === "M") {
      const n = stack?.stackNumber;
      const open = stack ? stack.branches.filter((b) => !b.isMerged).length : 0;
      // Pass the stack number when we have it so this also works for a
      // linked stack with no local tracking.
      const cmd = n
        ? ["gh", "stack", "merge", String(n), "--yes", "--squash"]
        : ["gh", "stack", "merge", "--yes", "--squash"];
      setPending({
        kind: "merge",
        prompt:
          `Squash-merge ${open} PR${open === 1 ? "" : "s"} in ${stack?.label ?? "this stack"} into ${stack?.trunk ?? "trunk"}? ` +
          "This is irreversible.",
        exec: () => run(cmd),
      });
    }
  });

  // ----- screens --------------------------------------------------------
  if (screen === "loading") {
    return (
      <Box padding={1}>
        <Text color="cyan">loading stack…</Text>
      </Box>
    );
  }

  if (screen === "fatal") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">{fatal}</Text>
        <Text dimColor>press q to quit</Text>
      </Box>
    );
  }

  if (screen === "pick") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">
          Pick a stack
        </Text>
        <Text dimColor>current branch isn't in any stack — tracked stacks in this repo:</Text>
        <Box flexDirection="column" marginTop={1}>
          {stackChoices.map((s, i) => (
            <Box key={i} flexDirection="column">
              <Text color={i === pickIdx ? "cyan" : undefined}>
                {i === pickIdx ? "❯ " : "  "}
                <Text bold={i === pickIdx}>{s.label}</Text>
                <Text dimColor>
                  {"  "}
                  {s.branches.length} branch{s.branches.length === 1 ? "" : "es"} · trunk{" "}
                  {s.trunk}
                </Text>
              </Text>
              <Text dimColor>
                {"    "}
                {s.branches
                  .map((b) => b.branch)
                  .join(", ")
                  .slice(0, cols - 6)}
              </Text>
            </Box>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>↑↓ choose · enter open · q quit</Text>
        </Box>
      </Box>
    );
  }

  if (!stack || !sel) return null;

  // ----- main -----------------------------------------------------------
  const stale = staleBranches(stack);
  const drift = driftedBranches(stack);
  const selDetails = sel.prNumber != null ? details.get(sel.prNumber) : undefined;
  const baseBranch =
    stack.branches[stack.branches.indexOf(sel) - 1]?.branch ?? stack.trunk;

  const pct =
    maxScroll === 0 ? 100 : Math.round((Math.min(scroll, maxScroll) / maxScroll) * 100);
  const diffBar = scrollbar(diffLines?.length ?? 0, diffViewH, scroll);
  const descBar = desc ? scrollbar(descRender.lines.length, descViewH, desc.scroll) : null;
  const descPct =
    descMax === 0 ? 100 : Math.round((Math.min(desc?.scroll ?? 0, descMax) / descMax) * 100);
  const visible = (diffLines ?? []).slice(scroll, scroll + diffViewH);

  // The Text shim truncates at the end, so window the draft by hand and keep
  // the tail — where the cursor is — visible on a long comment.
  const inputW = Math.max(12, cols - 8);
  const draft = comment?.text ?? "";
  const shownDraft =
    draft.length > inputW ? `…${draft.slice(-(inputW - 1))}` : draft;

  return (
    <Box flexDirection="column" width={cols} height={rows} overflow="hidden">
      {/* header: one row always — the mouse math below counts on it */}
      <Box paddingX={1} flexShrink={0}>
        <Text wrap="truncate-end">
          <Text bold color="cyan">
            {stack.label}
          </Text>
          <Text dimColor>
            {" "}
            · {entries.length} PR{entries.length === 1 ? "" : "s"} · trunk {stack.trunk}
          </Text>
          {stale.length > 0 ? (
            <Text color="yellow">
              {"  "}⚠ {stale.length} behind base ({stale
                .map((b) => (b.prNumber != null ? `#${b.prNumber}` : b.branch))
                .join(" ")}) — R to rebase
            </Text>
          ) : null}
          {drift.length > 0 ? (
            <Text color="red">
              {"  "}⇅ {drift.length} local drift
            </Text>
          ) : null}
          {stale.length === 0 && drift.length === 0 ? (
            stack.synced ? (
              <Text color="green">{"  "}✓ in sync</Text>
            ) : (
              <Text dimColor>{"  "}⟳ checking sync…</Text>
            )
          ) : null}
        </Text>
      </Box>

      {desc ? (
        /* description dialog: the PR body and its conversation, in place of
           the sidebar + diff. esc closes. */
        <Box
          flexDirection="column"
          flexGrow={1}
          minHeight={0}
          borderStyle="round"
          borderColor="cyan"
          paddingX={1}
          overflow="hidden"
        >
          <Text wrap="truncate-end" flexShrink={0}>
            <Text bold color="cyan">
              #{desc.prNumber}{" "}
            </Text>
            <Text bold>{desc.data?.title ?? selDetails?.title ?? sel.branch}</Text>
          </Text>
          <Text dimColor wrap="truncate-end" flexShrink={0}>
            {desc.data
              ? `${desc.data.author} · opened ${ago(desc.data.createdAt)} · ${desc.data.items.length} comment${desc.data.items.length === 1 ? "" : "s"}`
              : sel.branch}
            {desc.loading ? " · ⟳ loading…" : ""}
            {desc.showAll ? " · unfolded" : ""}
            {" · "}
            {descPct}%
          </Text>
          {desc.error ? (
            <Text color="red" wrap="truncate-end" flexShrink={0}>
              {desc.error}
            </Text>
          ) : null}
          {!desc.data && !desc.error ? (
            <Text dimColor>loading description…</Text>
          ) : (
            descRender.lines
              .slice(desc.scroll, desc.scroll + descViewH)
              .map((line, i) => (
                <Box
                  key={desc.scroll + i}
                  width="100%"
                  flexDirection="row"
                  flexShrink={0}
                  overflow="hidden"
                >
                  <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
                    <Text wrap="truncate-end">
                      {line.length === 0
                        ? " "
                        : line.map((s, si) => (
                            <Text
                              key={si}
                              color={s.color}
                              bold={s.bold}
                              dimColor={s.dim}
                              italic={s.italic}
                              underline={s.underline}
                              strikethrough={s.strike}
                            >
                              {s.text}
                            </Text>
                          ))}
                    </Text>
                  </Box>
                  <ScrollCell bar={descBar} row={i} />
                </Box>
              ))
          )}
        </Box>
      ) : (
      <Box flexDirection="row" flexGrow={1} minHeight={0} overflow="hidden">
        {/* sidebar */}
        <Box
          flexDirection="column"
          width={sidebarW}
          height="100%"
          flexShrink={0}
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
          overflow="hidden"
        >
          <Text dimColor> ○ {stack.trunk}</Text>
          {winStart > 0 ? <Text dimColor>↑ {winStart} more</Text> : null}
          {winEntries.map((b, wi) => {
            const i = winStart + wi;
            const active = i === selected;
            const d = b.prNumber != null ? details.get(b.prNumber) : undefined;
            const dot = dotFor(b, d);
            const badge = badgeFor(b, d);
            const innerW = sidebarW - 4; // border + padding
            const titleW = Math.max(4, innerW - 3 - badge.text.length - 1);
            const title = truncate(d?.title ?? b.branch, titleW).padEnd(titleW);
            const tags = syncTags(b, stack.synced ?? false);
            const tagW = tags.reduce((n, t) => n + t.text.length + 1, 0);
            const meta = truncate(
              `${b.prNumber != null ? `#${b.prNumber} · ` : ""}${b.branch}${b.isCurrent ? " ✦" : ""}`,
              Math.max(4, innerW - 4 - tagW),
            );
            return (
              <Box key={b.branch} flexDirection="column">
                <Text wrap="truncate-end">
                  <Text color="blue">{active ? "▎" : " "}</Text>
                  <Text color={dot.color}>{dot.text}</Text>{" "}
                  <Text bold={active} color={active ? "white" : undefined}>
                    {title}
                  </Text>{" "}
                  <Text color={badge.color}>{badge.text}</Text>
                </Text>
                <Text wrap="truncate-end">
                  <Text dimColor>
                    {"  │ "}
                    {meta}
                  </Text>
                  {tags.map((t, ti) => (
                    <Text key={ti} color={t.color}>
                      {" "}
                      {t.text}
                    </Text>
                  ))}
                </Text>
                {isExpanded(b)
                  ? checkRowsFor(d).map((r, ri) => (
                      <Text key={ri} wrap="truncate-end">
                        <Text dimColor>{"  │  "}</Text>
                        <Text color={r.color} dimColor={r.dim}>
                          {r.icon} {truncate(r.text, Math.max(4, innerW - 7))}
                        </Text>
                      </Text>
                    ))
                  : null}
              </Box>
            );
          })}
          {winEnd < entries.length ? (
            <Text dimColor>↓ {entries.length - winEnd} more</Text>
          ) : null}
        </Box>

        {/* diff pane */}
        <Box
          flexDirection="column"
          flexGrow={1}
          flexShrink={1}
          minWidth={0}
          paddingLeft={1}
          overflow="hidden"
        >
          <Text wrap="truncate-end" flexShrink={0}>
            {sel.prNumber != null ? (
              <Text bold color="cyan">
                #{sel.prNumber}{" "}
              </Text>
            ) : null}
            <Text bold>{selDetails?.title ?? sel.branch}</Text>
          </Text>
          <Text dimColor wrap="truncate-end" flexShrink={0}>
            {sel.branch} → {baseBranch}
            {selDetails ? (
              <>
                {" · "}
                <Text color={DIFF_ADD_COLOR}>+{selDetails.additions}</Text>{" "}
                <Text color={DIFF_DELETE_COLOR}>−{selDetails.deletions}</Text>
                {selDetails.checks.fail > 0 ? (
                  <Text color={DIFF_DELETE_COLOR}> · ✗ {selDetails.checks.fail} checks</Text>
                ) : selDetails.checks.pending > 0 ? (
                  <Text color="yellow"> · ◌ {selDetails.checks.pending} pending</Text>
                ) : selDetails.checks.pass > 0 ? (
                  <Text color={DIFF_ADD_COLOR}> · ✓ checks</Text>
                ) : null}
              </>
            ) : null}
            {" · "}
            {pct}%
            {sel.needsRebase && !sel.isMerged ? (
              <Text color="yellow"> · ⚠ behind {baseBranch}</Text>
            ) : null}
            {sel.localBehind > 0 ? (
              <Text color="red"> · local ↓{sel.localBehind} behind origin</Text>
            ) : null}
            {sel.localAhead > 0 ? (
              <Text color="cyan"> · local ↑{sel.localAhead} unpushed</Text>
            ) : null}
          </Text>
          {diffLines === null ? (
            <Text dimColor>loading diff…</Text>
          ) : (
            visible.map((line, i) => {
              const s = diffLineStyle(line);
              return (
                <Box
                  key={scroll + i}
                  width="100%"
                  flexDirection="row"
                  flexShrink={0}
                  overflow="hidden"
                >
                  <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
                    <Text color={s.color} bold={s.bold} dimColor={s.dim} wrap="truncate-end">
                      {line.length ? line : " "}
                    </Text>
                  </Box>
                  <ScrollCell bar={diffBar} row={i} />
                </Box>
              );
            })
          )}
        </Box>
      </Box>
      )}

      {/* comment dialog: esc closes, enter hands the text to the ticket's agent */}
      {comment ? (
        <Box
          flexDirection="column"
          flexShrink={0}
          borderStyle="round"
          borderColor={comment.error ? "red" : "cyan"}
          paddingX={1}
        >
          <Text wrap="truncate-end">
            <Text bold color="cyan">
              comment
            </Text>
            <Text dimColor>
              {" "}
              {comment.ticket}
              {comment.prNumber != null ? ` · #${comment.prNumber}` : ""}
              {" → "}
            </Text>
            {comment.target ? (
              <Text>
                {comment.target.tabLabel}
                <Text dimColor>
                  {" · "}
                  {comment.target.agent}
                  {comment.target.status ? ` (${comment.target.status})` : ""}
                </Text>
              </Text>
            ) : comment.error ? (
              <Text color="red">{comment.error}</Text>
            ) : (
              <Text dimColor>finding the herdr tab…</Text>
            )}
          </Text>
          <Text wrap="truncate-end">
            <Text color="cyan">{"❯ "}</Text>
            <Text>{shownDraft}</Text>
            {comment.sending ? null : <Text inverse>{" "}</Text>}
          </Text>
          <Text dimColor wrap="truncate-end">
            {comment.sending
              ? "sending…"
              : comment.target
                ? "enter send · esc cancel · ctrl+w word · ctrl+u clear"
                : "esc cancel"}
          </Text>
        </Box>
      ) : null}

      {/* footer: confirmation and action status take over the key hints */}
      <Box paddingX={1} flexShrink={0}>
        {pending ? (
          <Text wrap="truncate-end">
            <Text
              bold
              color={
                pending.kind === "merge"
                  ? "red"
                  : pending.kind === "approve"
                    ? "green"
                    : "yellow"
              }
            >
              {pending.kind.toUpperCase()}
            </Text>
            <Text> {pending.prompt} </Text>
            <Text bold color="white">
              y
            </Text>
            <Text dimColor>/any other key cancels</Text>
          </Text>
        ) : busy ? (
          <Text color="cyan" wrap="truncate-end">
            {busy}
          </Text>
        ) : actionMsg ? (
          <Text color={actionMsg.color} wrap="truncate-end">
            {actionMsg.text}
            <Text dimColor> · any key to dismiss</Text>
          </Text>
        ) : desc ? (
          <Text dimColor wrap="truncate-end">
            ↑↓/j/k scroll · space/b page · d/u half · g/G top/bot · n/p comment · tab next pr · x {desc.showAll ? "fold" : "unfold"} · a/A approve one/all · c comment · o open · z zed · r refresh · esc close
          </Text>
        ) : (
          <Text dimColor wrap="truncate-end">
            ↑↓/j/k/click pr · space discussion · l/h checks · f/b page · d/u half · g/G top/bot · n/p file · a/A approve one/all · z zed · c comment · o open · R rebase · M merge · r refresh · q quit
          </Text>
        )}
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

if (argv.includes("--dump")) {
  // headless mode for debugging: print resolved stack data as JSON, with the
  // sync annotation the TUI defers to the background applied inline
  await fetchRefs();
  const { stacks, source, error } = await resolveStacks();
  if (error) {
    console.error(error);
    process.exit(1);
  }
  const first = await annotateSync(stacks[0]);
  const enriched = await Promise.all(
    first.branches.map(async (b) => ({
      ...b,
      details: b.prNumber != null ? await fetchPrDetails(b.prNumber) : null,
    })),
  );
  console.log(JSON.stringify({ source, stackCount: stacks.length, ...first, branches: enriched }, null, 2));
  process.exit(0);
}

if (argv.includes("--zed")) {
  // headless z: check the branch out and open its worktree in Zed from the
  // shell, and the way the key's checkout logic gets exercised without a TTY
  const branch = argv[argv.indexOf("--zed") + 1];
  if (!branch) {
    console.error("usage: stacks --zed <branch>");
    process.exit(2);
  }
  const r = await openInZed(branch);
  if (r.code !== 0) {
    console.error(r.err);
    process.exit(r.code || 1);
  }
  console.log(r.out);
  process.exit(0);
}

if (argv.includes("--discussion")) {
  // headless mode for the description dialog: render a PR's body + comments
  // as plain text, at the given width, so the markdown pass can be checked
  // without a terminal
  const n = Number(argv[argv.indexOf("--discussion") + 1]);
  const width = Number(argv[argv.indexOf("--width") + 1]) || 80;
  if (!Number.isInteger(n)) {
    console.error("usage: stacks --discussion <pr-number> [--width N] [--all]");
    process.exit(2);
  }
  const { data, error } = await fetchDiscussion(n);
  if (!data) {
    console.error(error);
    process.exit(1);
  }
  const { lines, marks } = renderDiscussion(data, width, argv.includes("--all"));
  lines.forEach((l, i) =>
    console.log(`${marks.includes(i) ? "▶" : " "} ${l.map((s) => s.text).join("")}`),
  );
  process.exit(0);
}

if (argv.includes("-h") || argv.includes("--help")) {
  console.log(`stacks — browse a gh stack: PRs on the left, gh pr diff on the right

usage: stacks [--dump] [--discussion <pr> [--width N] [--all]] [--zed <branch>]

keys: ↑↓/j/k/tab pick PR · space PR description + comments · l/h (or ←→)
      expand/collapse a PR's CI checks · f/b page · d/u half page · g/G
      top/bottom · n/p next/prev file · 1-9 jump · a approve · A approve every
      open PR in the stack · z check out + open in Zed · c comment to the
      ticket's agent · o open in browser · R rebase via a claude agent ·
      M squash-merge stack · r refresh · q quit
mouse: click a PR to select it · wheel scrolls the diff (over the sidebar it
       moves the selection) · click the scrollbar to jump

space opens the selected PR's description with its whole conversation under
it: issue comments, reviews, and inline review threads (where Greptile leaves
its findings), oldest first, rendered as terminal markdown. Inside it: j/k,
space/b, d/u, g/G scroll like the diff · n/p jump between comments · tab /
shift-tab step to the next/previous PR · x unfolds resolved threads and bot
comments (Vercel, Linear), which fold to one line by default · a approves ·
c comments to the ticket's agent · o opens the PR in the browser · z opens it
in Zed · r re-fetches · esc closes. Images show as a "⧉ alt" placeholder (o for the real
thing).

z checks the selected branch out — creating the local tracking branch from
origin when it has never been checked out here — and opens the worktree in
Zed. A branch already checked out in another worktree opens there instead
(git won't check it out twice), and a checkout git refuses (dirty tree) is
reported, never stashed or forced.

c opens a comment box for the selected PR. The Linear ticket comes off the
branch name (miguel/prod-3083-hide-officer-ssn -> PROD-3083), the Herdr tab
labeled with that ticket is looked up in the current workspace, and enter hands
the text to the agent running in it via \`herdr agent prompt\`. esc closes the box
without sending. Needs a Herdr pane (HERDR_ENV=1) and exactly one matching tab
with one agent in it — anything else is reported in the box instead of guessed.

l expands the selected PR into its CI checks — failures and pending ones get a
row each (worst first), passes roll up into a single "✓ N passed" line, and
expanding re-fetches the PR so the list reflects CI right now. h collapses.

sync: each PR shows whether it has fallen behind its base ("⚠ rebase", the same
      condition as GitHub's "This stack is out-of-date"), and whether the local
      checkout has drifted from origin ("↓N" behind — e.g. after someone hit
      Rebase stack in the web UI, "↑N" unpushed). The stack renders immediately;
      the ref fetch + drift detection run behind it ("⟳ checking sync…" in the
      header until they land), so the answers still reflect the remote.

a, A, R and M all stage a confirmation first and only run on "y". a submits
\`gh pr review <n> --approve\` for the selected PR (from the main view or the
description dialog) and refreshes its badge; A does the same for every PR in
the stack that is still open, in order, and reports any that GitHub refused
(your own, for one) without stopping on them. R splits a new
Herdr pane on the right and hands the whole rebase to a Claude agent there —
rebase onto the trunk, resolve merge conflicts itself, force-push with
--force-with-lease — so you review a finished rebase instead of the conflicts
(needs HERDR_ENV=1). M runs \`gh stack merge <n> --yes --squash\`, which works by
stack number either way.`);
  process.exit(0);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("stacks requires an interactive terminal (or use --dump).");
  process.exit(1);
}

const app = await render(<App />);
await app.waitUntilExit();
