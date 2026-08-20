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

type PrDetails = {
  title: string;
  state: string;
  isDraft: boolean;
  reviewDecision: string; // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ""
  additions: number;
  deletions: number;
  checks: { pass: number; fail: number; pending: number };
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
};

type Screen = "loading" | "pick" | "main" | "fatal";

// Rebase rewrites history and merge is irreversible, so neither fires on a bare
// keypress — both stage a PendingAction that a second key has to confirm.
type PendingAction = {
  kind: "rebase" | "merge";
  prompt: string;
  cmd: string[];
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

async function refExists(ref: string): Promise<boolean> {
  const { code } = await run(["git", "rev-parse", "--verify", "--quiet", ref]);
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
async function annotateSync(data: StackData): Promise<StackData> {
  const branches = await Promise.all(
    data.branches.map(async (b, i) => {
      // bottom branch measures against the trunk; the rest against the one below
      const base = i === 0 ? data.trunk : data.branches[i - 1].branch;

      const [hasLocal, hasRemote, hasRemoteBase] = await Promise.all([
        refExists(b.branch),
        refExists(`origin/${b.branch}`),
        refExists(`origin/${base}`),
      ]);

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
  return { ...data, branches };
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
  await fetchRefs();

  const view = await run(["gh", "stack", "view", "--json"]);
  if (view.code === 0) {
    return {
      stacks: [await annotateSync(parseViewJson(view.out))],
      source: "tracked",
    };
  }
  const remote = await readRemoteStack();
  if (remote) return { stacks: [await annotateSync(remote)], source: "github" };
  const tracked = await readTrackingFile();
  if (tracked.length > 0)
    return {
      stacks: await Promise.all(tracked.map(annotateSync)),
      source: "file",
    };
  return {
    stacks: [],
    source: "none",
    error:
      (view.err || view.out).trim() ||
      "No stack found. Run this from a branch that is part of a gh stack.",
  };
}

function summarizeChecks(rollup: unknown): PrDetails["checks"] {
  const checks = { pass: 0, fail: 0, pending: 0 };
  if (!Array.isArray(rollup)) return checks;
  for (const c of rollup as Array<Record<string, string>>) {
    const s = (c.conclusion || c.state || c.status || "").toUpperCase();
    if (s === "SUCCESS" || s === "NEUTRAL" || s === "SKIPPED") checks.pass++;
    else if (
      ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(s)
    )
      checks.fail++;
    else checks.pending++;
  }
  return checks;
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
  return {
    title: String(j.title ?? ""),
    state: String(j.state ?? ""),
    isDraft: Boolean(j.isDraft),
    reviewDecision: String(j.reviewDecision ?? ""),
    additions: Number(j.additions ?? 0),
    deletions: Number(j.deletions ?? 0),
    checks: summarizeChecks(j.statusCheckRollup),
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
function syncTags(b: StackBranch): Badge[] {
  const tags: Badge[] = [];
  if (b.isMerged) return tags;
  if (b.needsRebase) tags.push({ text: "⚠ rebase", color: "yellow" });
  if (b.localBehind > 0) tags.push({ text: `↓${b.localBehind}`, color: "red" });
  if (b.localAhead > 0) tags.push({ text: `↑${b.localAhead}`, color: "cyan" });
  if (b.hasLocal && b.prNumber != null && b.localAhead === 0 && b.localBehind === 0)
    return tags;
  if (!b.hasLocal && b.prNumber != null)
    tags.push({ text: "no local", color: "gray" });
  return tags;
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

  // display order: top of stack first, like the GitHub stack UI
  const entries = useMemo(
    () => (stack ? [...stack.branches].reverse() : []),
    [stack],
  );

  const [selected, setSelected] = useState(0);
  const [diffLines, setDiffLines] = useState<string[] | null>(null);
  const [scroll, setScroll] = useState(0);

  const diffCache = useRef(new Map<number, string[]>());
  const scrollMemo = useRef(new Map<number, number>());
  const diffSeq = useRef(0);

  const openStack = useCallback((s: StackData) => {
    setStack(s);
    const rev = [...s.branches].reverse();
    const cur = rev.findIndex((b) => b.isCurrent);
    setSelected(cur >= 0 ? cur : 0);
    setScreen("main");
    // enrich each PR with title/state/checks in parallel
    for (const b of s.branches) {
      if (b.prNumber == null) continue;
      fetchPrDetails(b.prNumber).then((d) => {
        if (!d) return;
        setDetails((m) => {
          const next = new Map(m);
          next.set(b.prNumber!, d);
          return next;
        });
      });
    }
  }, []);

  const load = useCallback(() => {
    setScreen("loading");
    setDetails(new Map());
    diffCache.current.clear();
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

  // Run a confirmed rebase/merge, then reload so the panel reflects reality
  // rather than what we hoped happened.
  const runAction = useCallback(
    (action: PendingAction) => {
      setPending(null);
      setActionMsg(null);
      setBusy(action.kind === "rebase" ? "rebasing stack…" : "merging stack…");
      run(action.cmd)
        .then(({ code, out, err }) => {
          setBusy(null);
          if (code === 0) {
            setActionMsg({
              text: `${action.kind} ok — ${firstLine(out) || "done"}`,
              color: "green",
            });
            load();
            return;
          }
          // `gh stack rebase` needs local tracking, which `gh stack link`
          // never writes — so a linked stack fails here. Say so plainly
          // instead of leaving a bare non-zero exit.
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

  // load the diff for the selected PR (cached per PR number)
  const sel = entries[selected];
  useEffect(() => {
    if (screen !== "main" || !sel) return;
    setScroll(sel.prNumber != null ? (scrollMemo.current.get(sel.prNumber) ?? 0) : 0);
    if (sel.prNumber == null) {
      setDiffLines(["(no PR for this branch yet — nothing to diff)"]);
      return;
    }
    const cached = diffCache.current.get(sel.prNumber);
    if (cached) {
      setDiffLines(cached);
      return;
    }
    setDiffLines(null);
    const seq = ++diffSeq.current;
    const num = sel.prNumber;
    fetchDiff(num).then((lines) => {
      diffCache.current.set(num, lines);
      if (diffSeq.current === seq) setDiffLines(lines);
    });
  }, [screen, sel]);

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

  // ----- layout ---------------------------------------------------------
  const sidebarW = Math.max(28, Math.min(46, Math.floor(cols * 0.34)));
  // OpenTUI reserves the terminal's first line and Yoga needs room for the
  // header, footer, and their separating rows. Keep the visible diff within
  // the actual flex body so its title rows never collapse under line content.
  // border rows plus destination / input / hint, when the dialog is up
  const commentH = comment ? 5 : 0;
  const bodyH = Math.max(4, rows - 5 - commentH);
  const diffViewH = Math.max(1, bodyH - 2); // pane title line + meta line

  // sidebar windowing: 2 rows per entry, plus the trunk row
  const slots = Math.max(1, Math.floor((bodyH - 1) / 2));
  let winStart = 0;
  if (entries.length > slots) {
    winStart = Math.min(
      Math.max(0, selected - Math.floor(slots / 2)),
      entries.length - slots,
    );
  }
  const winEntries = entries.slice(winStart, winStart + slots);

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

  // ----- mouse ----------------------------------------------------------
  const { stdin } = useStdin();

  const onMouse = useRef<(button: number, x: number, y: number) => void>(() => {});
  onMouse.current = (button, x, y) => {
    if (comment) return; // the dialog owns the screen while it is open
    if (button === 64 || button === 65) {
      // wheel: over the sidebar it moves the selection, elsewhere it scrolls
      const dir = button === 64 ? -1 : 1;
      if (screen === "pick")
        setPickIdx((i) => Math.max(0, Math.min(stackChoices.length - 1, i + dir)));
      else if (screen !== "main") return;
      else if (x < sidebarW)
        setSelected((i) => Math.max(0, Math.min(entries.length - 1, i + dir)));
      else setScrollFor((v) => v + dir * 3);
      return;
    }
    if (button !== 0) return; // left click only

    if (screen === "pick") {
      // padding row + title + subtitle + margin row, then 2 rows per stack
      const i = Math.floor((y - 4) / 2);
      if (y >= 4 && i < stackChoices.length) openStack(stackChoices[i]);
      return;
    }
    if (screen !== "main" || x >= sidebarW) return;
    // header row + border row, plus the "↑ N more" line when windowed
    const top = 2 + (winStart > 0 ? 1 : 0);
    const wi = Math.floor((y - top) / 2);
    if (y >= top && wi < winEntries.length) setSelected(winStart + wi);
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
    } else if (key.pageDown || input === " ") setScrollFor((v) => v + diffViewH);
    else if (key.pageUp || input === "b") setScrollFor((v) => v - diffViewH);
    else if (input === "d") setScrollFor((v) => v + Math.ceil(diffViewH / 2));
    else if (input === "u") setScrollFor((v) => v - Math.ceil(diffViewH / 2));
    else if (input === "g") setScrollFor(() => 0);
    else if (input === "G") setScrollFor(() => maxScroll);
    else if (input === "n")
      setScrollFor((v) => fileMarks.find((m) => m > v) ?? v);
    else if (input === "p")
      setScrollFor((v) => [...fileMarks].reverse().find((m) => m < v) ?? 0);
    else if (input === "c") openComment();
    else if (input === "o" && sel?.prNumber != null)
      Bun.spawn(["gh", "pr", "view", String(sel.prNumber), "--web"], {
        stdout: "ignore",
        stderr: "ignore",
      });
    else if (input === "r") load();
    else if (input === "R") {
      const stale = stack ? staleBranches(stack) : [];
      const drift = stack ? driftedBranches(stack) : [];
      const what =
        stale.length > 0
          ? `${stale.length} branch${stale.length === 1 ? "" : "es"} behind their base`
          : "nothing looks stale";
      setPending({
        kind: "rebase",
        prompt:
          `Rebase the whole stack onto ${stack?.trunk ?? "trunk"}? (${what}` +
          (drift.length > 0 ? `; ${drift.length} with local drift` : "") +
          ") — rewrites history and force-pushes each branch.",
        cmd: ["gh", "stack", "rebase"],
      });
    } else if (input === "M") {
      const n = stack?.stackNumber;
      const open = stack ? stack.branches.filter((b) => !b.isMerged).length : 0;
      setPending({
        kind: "merge",
        prompt:
          `Squash-merge ${open} PR${open === 1 ? "" : "s"} in ${stack?.label ?? "this stack"} into ${stack?.trunk ?? "trunk"}? ` +
          "This is irreversible.",
        // Pass the stack number when we have it so this also works for a
        // linked stack with no local tracking.
        cmd: n
          ? ["gh", "stack", "merge", String(n), "--yes", "--squash"]
          : ["gh", "stack", "merge", "--yes", "--squash"],
      });
    }
  });

  // ----- screens --------------------------------------------------------
  if (screen === "loading") {
    return (
      <Box padding={1}>
        <Text color="cyan">loading stack… (fetching refs)</Text>
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
  const visible = (diffLines ?? []).slice(scroll, scroll + diffViewH);

  // The Text shim truncates at the end, so window the draft by hand and keep
  // the tail — where the cursor is — visible on a long comment.
  const inputW = Math.max(12, cols - 8);
  const draft = comment?.text ?? "";
  const shownDraft =
    draft.length > inputW ? `…${draft.slice(-(inputW - 1))}` : draft;

  return (
    <Box flexDirection="column" width={cols} height={rows} overflow="hidden">
      {/* header */}
      <Box paddingX={1} flexShrink={0}>
        <Text>
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
            <Text color="green">{"  "}✓ in sync</Text>
          ) : null}
        </Text>
      </Box>

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
            const tags = syncTags(b);
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
              </Box>
            );
          })}
          {winStart + slots < entries.length ? (
            <Text dimColor>↓ {entries.length - winStart - slots} more</Text>
          ) : null}
          <Text dimColor> ○ {stack.trunk}</Text>
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
                  flexShrink={0}
                  overflow="hidden"
                >
                  <Text color={s.color} bold={s.bold} dimColor={s.dim} wrap="truncate-end">
                    {line.length ? line : " "}
                  </Text>
                </Box>
              );
            })
          )}
        </Box>
      </Box>

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
            <Text bold color={pending.kind === "merge" ? "red" : "yellow"}>
              {pending.kind === "merge" ? "MERGE" : "REBASE"}
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
        ) : (
          <Text dimColor wrap="truncate-end">
            ↑↓/j/k/click pr · space/b page · d/u half · g/G top/bot · n/p file · c comment · o open · R rebase · M merge · r refresh · q quit
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
  // headless mode for debugging: print resolved stack data as JSON
  const { stacks, source, error } = await resolveStacks();
  if (error) {
    console.error(error);
    process.exit(1);
  }
  const first = stacks[0];
  const enriched = await Promise.all(
    first.branches.map(async (b) => ({
      ...b,
      details: b.prNumber != null ? await fetchPrDetails(b.prNumber) : null,
    })),
  );
  console.log(JSON.stringify({ source, stackCount: stacks.length, ...first, branches: enriched }, null, 2));
  process.exit(0);
}

if (argv.includes("-h") || argv.includes("--help")) {
  console.log(`stacks — browse a gh stack: PRs on the left, gh pr diff on the right

usage: stacks [--dump]

keys: ↑↓/j/k/tab pick PR · space/b page · d/u half page · g/G top/bottom ·
      n/p next/prev file · 1-9 jump · c comment to the ticket's agent ·
      o open in browser · R rebase stack · M squash-merge stack · r refresh · q quit
mouse: click a PR to select it · wheel scrolls the diff (over the sidebar it
       moves the selection)

c opens a comment box for the selected PR. The Linear ticket comes off the
branch name (miguel/prod-3083-hide-officer-ssn -> PROD-3083), the Herdr tab
labeled with that ticket is looked up in the current workspace, and enter hands
the text to the agent running in it via \`herdr agent prompt\`. esc closes the box
without sending. Needs a Herdr pane (HERDR_ENV=1) and exactly one matching tab
with one agent in it — anything else is reported in the box instead of guessed.

sync: each PR shows whether it has fallen behind its base ("⚠ rebase", the same
      condition as GitHub's "This stack is out-of-date"), and whether the local
      checkout has drifted from origin ("↓N" behind — e.g. after someone hit
      Rebase stack in the web UI, "↑N" unpushed). Refs are fetched on load so
      those answers reflect the remote, not a stale origin/*.

R and M both stage a confirmation first and only run on "y". R runs
\`gh stack rebase\`, which needs gh's local stack tracking — a stack created with
\`gh stack link\` has none, and the error says so. M runs
\`gh stack merge <n> --yes --squash\`, which works by stack number either way.`);
  process.exit(0);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("stacks requires an interactive terminal (or use --dump).");
  process.exit(1);
}

const app = await render(<App />);
await app.waitUntilExit();
