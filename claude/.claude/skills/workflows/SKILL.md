---
name: workflows
description: Spin up a dynamic Claude Code workflow — a JS harness that orchestrates focused subagents — when a Porio task wants real parallelism, adversarial verification, or scale a single context can't hold. Use when the user types `/workflows`, says "ultracode", "fan out agents", "spin up a workflow", "use a workflow to…", or describes a task that fits the patterns (verify every claim in a doc, QA every flow, audit every webhook handler, refactor across N templates, mine 50 sessions for recurring corrections). Also use when the user explicitly says they want the workflow harness instead of single-context iteration. This skill teaches WHEN to reach for `Workflow`, the Porio-specific gotchas (agent-browser is a singleton; `wrangler.jsonc` DO migrations don't merge across worktrees; Stripe `plans:sync` is not safe to fan out), and ships two template scripts (`docs-verify.workflow.js`, `qa-flow.workflow.js`) you can adapt rather than rewrite from scratch.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Workflow
---

# /workflows — dynamic harnesses for Porio tasks

Workflows are JavaScript orchestrators that spawn focused subagents with their own context windows. Source: Thariq's article ["A harness for every task"](https://www.anthropic.com/news/dynamic-workflows-claude-code). The Porio-specific take: most coding work doesn't need them, but the work that does need them needs them *a lot* — QA every flow, verify every file:line in a `docs/` entry, audit every Stripe webhook handler, refactor every template, mine 50 sessions for recurring CLAUDE.md rules.

This file teaches when to reach for `Workflow`, what Porio-shaped harnesses look like, and the gotchas that have already bitten us. The templates in this folder (`*.workflow.js`) are starting points, not gospel — adapt them.

## When to spin one up

Triggers (user-side):

- Explicit: `/workflows`, "ultracode", "use a workflow to…", "fan out agents", "spin up a harness", "spawn agents to verify…".
- Task shape: "verify every X", "QA all the flows", "for each <docs file | template | webhook handler | session log>", "tournament / bracket / rank the top N", "loop until no new findings", "different perspectives".

Triggers (judgment-side) — even without the magic words, reach for it when:

- The work is **embarrassingly parallel** and the per-item context is large. One context window can't hold all of `docs/`, but 10 parallel agents each reading one file can.
- The work needs **adversarial separation**. Claude prefers its own answers; spawning a fresh skeptic in a clean context is structurally honest in a way "now critique yourself" is not.
- The total scale is **>30 minutes wall-clock** if done serially. Workflows pay their token premium back in throughput.
- The task is **structured but non-trivial**: "for each item, do A, then B, then verify, then synthesize." That's a pipeline — write the pipeline, don't ask one agent to do it 50 times.

## When NOT to

- Quick bug fixes, single-file edits, anything you'd finish in <5 minutes single-context. Workflows have token overhead.
- Tasks where the steps depend on each other in non-decomposable ways. If step 2 needs the *full* understanding of step 1's prose, not just a structured output, stay in one context.
- One-shot exploration where you don't know the shape yet — scout inline first, then promote to a workflow once the work-list is clear. The Workflow tool description calls this "hybrid" and it's the right default.

## The mental model

A workflow is a JS file that begins with `export const meta = {...}` (pure literal — no template strings, no spreads) and then drives subagents through five primitives:

- `agent(prompt, {schema?, label?, phase?, model?, isolation?, agentType?})` — spawns one subagent. With `schema`, returns a validated JSON object (the model is forced to call `StructuredOutput` and retries on mismatch). Without `schema`, returns the final text. Returns `null` if the user skips it mid-run — always `.filter(Boolean)`.
- `pipeline(items, stage1, stage2, …)` — **the default**. Each item flows through all stages independently; no barrier between stages. Item A can be in stage 3 while item B is still in stage 1. Wall-clock = slowest single-item chain.
- `parallel(thunks)` — barrier. Awaits all. Use only when stage N+1 genuinely needs all of stage N's results together (dedup, early-exit on zero, "compare against the other findings").
- `phase(title)` / `log(msg)` — progress display.
- `workflow(name, args)` — nest a saved workflow as a sub-step. One level only.

Scripts run in an async context. Standard `JSON`, `Math`, `Array` are available. **`Date.now()`, `Math.random()`, argless `new Date()` are blocked** (they'd break resume) — pass timestamps via `args`, stamp results after the workflow returns, and vary agent prompts by index, not RNG.

`budget.remaining()` is a hard ceiling when the user passed a `+500k` directive; use it for loop-until-budget patterns.

## Patterns mapped to Porio use cases

| Pattern                       | Porio use case                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| Fan-out-and-synthesize        | Verify every file:line claim in `docs/stripe.md`. Audit every event in `scripts/hook.sh`.        |
| Pipeline                      | For each template in `prisma/templates/`: lint → regen seed → screenshot → diff for regressions. |
| Tackle-ticket-with-subissues  | `/do POR-20` when the tree has ≥3 independent leaves. One agent per leaf (worktree-isolated if they touch overlapping files), synthesize the walkthrough at the end. See dedicated section below. |
| Adversarial verify            | Diff review: fan out per-dimension finders, then skeptics that *try to refute* each finding.     |
| Generate-and-filter           | Brainstorm 12 names for a new agent product, dedupe, rank against a rubric.                      |
| Tournament                    | Three independent UI redesigns of `/settings/billing`, judge panel picks one + grafts ideas.     |
| Loop-until-done               | Reproduce a flaky chat test in worktrees, form theories, adversarially test until one survives.  |
| Classify-and-act              | Triage `BuildIssue`s in the integration-chat queue: fix vs. escalate vs. dedupe.                 |
| Loop-until-budget             | `vp run +500k workflows` style: keep finding new corrections in old sessions until budget drains. |

### Tackling a ticket with sub-issues (pairs with `/do`)

`/do <ID>` now walks the full sub-issue tree (via the `linear` skill's recursive `children` fetch) before deciding scope. When the tree has ≥3 **independent** open leaves, promote to a workflow. Shape:

```js
export const meta = {
  name: 'do-subissues',
  description: 'Tackle a Linear ticket and its nested sub-issues in parallel',
  phases: [{ title: 'Plan' }, { title: 'Implement' }, { title: 'Synthesize' }],
}

const ROOT = args?.root            // e.g. 'POR-20'
const LEAVES = args?.leaves        // [{identifier, title, description, files?}, ...]

phase('Plan')
const plan = await agent(
  `Read the root ticket ${ROOT} and the ${LEAVES.length} leaves. For each leaf, return {identifier, scope, files, risk}. Risk is 'isolated' or 'overlaps:<other-id>'.`,
  { schema: PLAN_SCHEMA }
)

phase('Implement')
const results = await parallel(plan.leaves.map(leaf => () =>
  agent(
    `Implement ${leaf.identifier}: ${leaf.scope}. Files in scope: ${leaf.files.join(', ')}. Make the edits, run \`vp check\` on the touched workspace, return {identifier, summary, files_touched, verification}.`,
    {
      schema: LEAF_RESULT_SCHEMA,
      label: `leaf:${leaf.identifier}`,
      // Only worktree-isolate if leaves overlap. Isolated leaves should NOT pay the worktree tax.
      isolation: leaf.risk.startsWith('overlaps') ? 'worktree' : undefined,
    }
  )
))

phase('Synthesize')
return {
  root: ROOT,
  results: results.filter(Boolean),
  // Caller writes ./issues/<ROOT>/index.html with one Changes section per result.
}
```

Rules specific to this pattern:

- **Don't worktree-isolate leaves that touch disjoint files.** Worktrees cost ~200-500ms + disk per agent; they're only worth it when leaves race on the same file. Pass `risk` through the schema so the workflow can decide per-leaf.
- **Never fan out leaves that all edit `wrangler.jsonc`** (DO migrations) or all run `plans:sync` — see the gotchas section. Detect these in the planning phase and serialize them (or do them in the main loop, not a leaf agent).
- **Don't update Linear state from leaf agents.** Closing sub-issues / posting comments must happen in the main loop after the user reviews the walkthrough — the `linear` skill's "confirm destructive intent" convention applies.
- **The walkthrough is the synthesis surface.** Each leaf returns structured data; the main loop writes `./issues/<ROOT>/index.html` with one "Changes" section per leaf. Don't have leaves edit the HTML directly — they'll fight over the file.

## Porio gotchas — read before fanning out

These have already bitten. Encode them in the workflow script, don't rely on Claude remembering.

### `agent-browser` is a singleton

`agent-browser` drives one Chromium via CDP. Spawning multiple agents that all call `agent-browser open …` will fight over the same browser session — clicks land in the wrong tab, screenshots overwrite each other, cookies clear under another agent's feet. Two safe shapes:

- **Sequential walk, parallel analysis.** One agent walks a flow and saves screenshots; downstream agents *read* the PNGs in parallel and write report sections. The `qa-flow.workflow.js` template shows this.
- **Worktree-isolated browsers.** Only safe if each worktree boots its own dev server on a different port and you wire `agent-browser` to it explicitly. Expensive. Don't reach for it unless the sequential version is a real bottleneck.

For pure read-only screenshotting of static marketplace pages (`porio.ai/agent/<id>`), parallel `agent-browser screenshot` calls *may* work since each is a one-shot; still serialize through a pipeline if you see flake.

### `wrangler.jsonc` migrations don't merge across worktrees

`isolation: 'worktree'` is tempting for parallel refactors in `app/`. But DO classes are versioned via the `migrations` array in `wrangler.jsonc`, and a parallel rename of two DO classes in two worktrees produces two conflicting `migrations` entries that can't be auto-merged. Either:

- Keep migration edits in a single agent (no worktree for that step), or
- Reserve migration tag names ahead of time and have each worktree only edit the migration body, not append to the array.

### `plans:sync` is not idempotent under concurrency

`vp run plans:sync` (and `plans:sync:prod`) writes back to `prisma/plans-snapshot{,.sandbox}.json` and creates Stripe Prices (which are immutable; re-runs mint new ones). Never fan out agents that each call `plans:sync`. If a workflow needs the catalog state, run `plans:diff` once in a setup phase and pass the result down.

### D1 local writes serialize anyway

`app/`'s local D1 is a single SQLite file. Fanning out N agents that all `vp run db:push --target=local` doesn't speed anything up and may corrupt the WAL. Do schema/seed work in one agent and only parallelize the read-side.

### tmux dev sessions are shared state

The `app` and `web` tmux panes hold warm Vite servers. Don't have workflow agents restart them — write the rule into the workflow prompt explicitly ("the dev server in tmux `app` is already running; do not `vp run dev`"). The `qa-porio` skill has the same rule; reuse its preamble.

### `docs/` is the authoritative source-of-truth pointer

Every Porio system has a `docs/<system>.md` with file:line refs (see `docs/stripe.md`, `docs/billing.md`, `docs/tg-bridge.md`, etc.). Workflow agents should `Read` the relevant docs file *first* before grepping the code — it's a much higher-density context than the code itself. The `docs-verify.workflow.js` template inverts this: it takes a docs file as input and checks its own claims.

## Writing a workflow

Two paths:

### 1. Adapt a template in this folder

```bash
ls /Users/miguel/porio/.claude/skills/workflows/*.workflow.js
```

Read the template that matches your shape, copy it to a fresh path under `/tmp/` or the session dir, edit, and call `Workflow({ scriptPath: "/tmp/your.workflow.js" })`. Or pass it inline as the `script` parameter on the first run; the runtime persists it and returns a path you can iterate on.

### 2. Write inline from scratch

Stick to the canonical shape:

```js
export const meta = {
  name: 'kebab-name',
  description: 'one line, shown in permission dialog',
  phases: [
    { title: 'Discover' },
    { title: 'Verify' },
  ],
}

const TARGET = args?.target ?? 'docs/stripe.md'

phase('Discover')
const items = await agent(`Read ${TARGET} and extract …`, { schema: ITEMS_SCHEMA })

phase('Verify')
const verdicts = await parallel(
  items.list.map((it, i) => () =>
    agent(`Verify ${it.thing}.`, { schema: VERDICT_SCHEMA, label: `verify:${i}` })
  )
)

return { items: items.list.length, drifted: verdicts.filter(Boolean).filter(v => !v.holds) }
```

Rules of thumb:

- **Default to `pipeline`**, not `parallel`. Barriers cost wall-clock. Only barrier when the next stage needs all prior results together (dedup, "0 → skip", cross-item comparison).
- **Always pass a `schema`** for anything you'll act on downstream. The runtime forces structured output and retries on mismatch — way more reliable than parsing prose.
- **Cap finder agents** with `dry++` / `seen` sets for unknown-size discovery. Don't trust counters.
- **Label every agent** (`{label: 'verify:stripe.ts:412'}`) so the `/workflows` progress tree is readable.
- **Don't reach for `model: 'opus'`** unless you've measured the task needs it. Default to inheriting the main-loop model; Haiku is usually fine for structured extractors and verifiers.

## Combining with other harness primitives

- **`/loop`**: pair with workflows that have a clear "is there new work?" signal — triage, doc-drift detection, build-issue resolution. `/loop 30m /workflows triage`.
- **`/goal`**: hard completion gate. "Don't stop until one theory reproduces the flake." The model treats it as a contract.
- **`/code-review ultra`**: this is already a multi-agent cloud review; don't reinvent it inside a workflow.
- **`/qa-porio`**: the buyer/seller end-to-end audit. If you want parallel coverage of more flows (widget runtime, admin panel, /sell, /settings/billing variants), wrap it in a workflow that fans out per-flow.

## Templates in this folder

- **`docs-verify.workflow.js`** — fan-out-and-synthesize. Input: a `docs/<topic>.md` path. Extracts every file:line claim, verifies each in parallel against current code, optionally re-skeptics drifted ones, returns a structured drift report. Use when `docs/` rot is suspected (refactors landed since the doc was written).
- **`qa-flow.workflow.js`** — pipeline. Input: a flow name (`buyer`, `seller`, `widget`). Walks the flow with `agent-browser` (sequentially — see the singleton gotcha), then fans out per-screenshot analyst agents that write report sections, then synthesizes. Use when one of the standard flows feels broken and you want a thorough, multi-perspective audit.

Both are templates — read the script, copy, edit, run. Don't try to call them with random `args` and hope.

## Saving and sharing

Inside the `/workflows` menu, press `s` after a successful run to save. Two destinations:

- `~/.claude/workflows/<name>.workflow.js` — user-global, available in every project.
- `/Users/miguel/porio/.claude/skills/workflows/<name>.workflow.js` — Porio-scoped, lives in this skill folder, checked into the repo.

Prefer the project location for anything Porio-shaped (Porio docs paths, Porio Stripe schema, Porio agent-browser quirks). Prefer the global location for truly portable patterns (generic adversarial review, generic deep-research).

When you save here, also add a one-line bullet under "Templates in this folder" above so future Claude knows it exists without `ls`-ing.

## Anti-patterns

- **A "panel of 5 reviewers" for a 20-line bug fix.** Workflows are not a quality multiplier on small work; they're a scale multiplier on large work.
- **Fan-out where a `Grep` would do.** If the question is "which files import `stripe.v2.core`?", `Grep` is the answer, not 30 reader agents.
- **Workflow inside a workflow.** Nesting is one level only; deeper throws. Compose by returning data from one workflow and feeding it to the next.
- **Long-lived loops without a budget guard.** `while (true) { agent(...) }` is bounded by the 1000-agent ceiling, but you'll spend a lot of tokens hitting it. Always `if (budget.total && budget.remaining() < 50_000) break;`.
- **Skipping the structured output schema** to "just parse the prose later." The prose will vary; the schema enforces a contract. Use it.

## Reporting back

When a workflow run finishes, summarize in one or two sentences: which template you used (or wrote), the input shape, and the structured result. Example: "Ran `docs-verify.workflow.js` against `docs/stripe.md` (47 claims, 6 drifted — patch attached). Two of the drifted refs are in `workers/rpc/stripe.ts` where line numbers moved after the seller-trial refactor; the rest look like real behavior changes." Don't paste the full per-agent transcript — link to `/workflows` for that.
