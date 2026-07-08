export const meta = {
  name: 'seller-flow-capture',
  description: 'Walk the Porio seller flow end-to-end with agent-browser, capturing numbered screenshots + step-by-step insights; synthesize into an HTML report',
  phases: [
    { title: 'Walk' },
    { title: 'Synthesize' },
  ],
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const STEP_SCHEMA = {
  type: 'object',
  required: ['n', 'label', 'url', 'screenshot', 'observation', 'insight'],
  additionalProperties: false,
  properties: {
    n: { type: 'integer', description: '1-indexed step number, padded as 2 digits in filename' },
    label: { type: 'string', description: 'Short title like "Sell page (locked)" or "After Complete Connect"' },
    url: { type: 'string', description: 'URL loaded for this step (full URL)' },
    screenshot: { type: 'string', description: 'Filename relative to screenshots/ dir, e.g. "01-sell-locked.png"' },
    observation: { type: 'string', description: 'What is visible / what changed since the previous step. Concrete.' },
    insight: { type: 'string', description: 'What this step tells us about the product / what a future tester should notice. Opinionated.' },
    issues: {
      type: 'array',
      description: 'Anything weird, broken, or worth flagging. Empty if all clean.',
      items: { type: 'string' },
    },
  },
}

const WALK_SCHEMA = {
  type: 'object',
  required: ['steps', 'overallSummary'],
  additionalProperties: false,
  properties: {
    steps: { type: 'array', items: STEP_SCHEMA, minItems: 5 },
    overallSummary: { type: 'string', description: 'One paragraph summarizing the seller experience end-to-end' },
    blockingIssues: {
      type: 'array',
      description: 'Anything that genuinely blocks a seller from completing the flow (not nits)',
      items: { type: 'string' },
    },
    productInsights: {
      type: 'array',
      description: 'Higher-level observations about the seller UX worth surfacing — friction points, missing affordances, surprising defaults',
      items: { type: 'string' },
    },
  },
}

const SYNTH_SCHEMA = {
  type: 'object',
  required: ['htmlPath', 'summary'],
  additionalProperties: false,
  properties: {
    htmlPath: { type: 'string' },
    summary: { type: 'string' },
    screenshotsReferenced: { type: 'integer' },
  },
}

// ─── Constants ────────────────────────────────────────────────────────────────

const REPO_ROOT = '/Users/miguel/porio'
const FLOW_DIR = `${REPO_ROOT}/agents/flows/seller-flow`
const SCREENSHOT_DIR = `${FLOW_DIR}/screenshots`
const BASE_URL = 'https://miguels-macbook-pro.tail88635d.ts.net:8443'
const TEST_USER = { email: 'harri@email.com', password: 'password', role: 'admin' }

const COMMON_PREAMBLE = `
You are working inside the Porio repo. Repo conventions in \`${REPO_ROOT}/CLAUDE.md\`.

The local dev server is ALREADY RUNNING in tmux session \`app\` on \`http://localhost:5173\`. Do NOT restart it. Read app worker logs with \`tmux capture-pane -t app -p | tail -50\` if you need to diagnose.
`.trim()

// ─── Phase 1: Walk ────────────────────────────────────────────────────────────

phase('Walk')
const walk = await agent(
  `${COMMON_PREAMBLE}

TASK — WALK THE SELLER FLOW END-TO-END WITH \`agent-browser\` AND DOCUMENT EACH STEP.

## Target URL & auth

Drive agent-browser against **\`${BASE_URL}\`** (the configured \`BETTER_AUTH_URL\`). Do NOT use \`http://localhost:5173\` — better-auth issues \`__Secure-\` cookies that won't persist on HTTP. This was verified in a prior session.

Sign in as the seeded admin via the better-auth REST endpoint (the dev-account dropdown was just patched but the REST path is more reliable for headless work):

\`\`\`js
agent-browser open ${BASE_URL}/
agent-browser eval '(async () => { const r = await fetch("/api/auth/sign-in/email", { method: "POST", credentials: "include", headers: {"content-type": "application/json"}, body: JSON.stringify({email: "${TEST_USER.email}", password: "${TEST_USER.password}"}) }); return { status: r.status }; })()'
\`\`\`

After sign-in, the floating \`DevToolsPanel\` should be visible bottom-right (gated on \`import.meta.env.DEV\` + admin role). Verify it's there before continuing — if absent, the gating is broken and you should bail with that finding.

## State reset before walking

Before each walk-through, call \`dev.clearAllDevState\` to start from a known baseline (no Stripe Connect, no platform sub, plan=free). Remember the oRPC RPC envelope: bodies must be wrapped \`{"json": {...}}\`. For procedures with no input, an empty body \`""\` works.

\`\`\`js
agent-browser eval '(async () => (await fetch("/api/dev/clearAllDevState", { method: "POST", credentials: "include", body: "" })).json())()'
\`\`\`

## The flow to walk

You're playing a brand-new seller. **Take a numbered screenshot at every meaningful state**, save to \`${SCREENSHOT_DIR}/NN-<context>.png\` (zero-padded, e.g. \`01-sell-locked.png\`). At LEAST these steps:

1. **/sell — initial locked state.** Right after sign-in + reset, before any simulation. Capture the Stripe Connect prompt + the platform-subscription paywall. Look for: subscribe button, locked publishing affordances, what the seller actually sees first.

2. **After clicking "Grant platform sub" in the DevToolsPanel.** Or call the API directly: \`dev.grantPlatformSubscription\` with envelope \`{"json":{"status":"active"}}\`. Reload \`/sell\` and screenshot. What unlocks? Does the paywall disappear cleanly?

3. **After clicking "Complete Connect" in the DevToolsPanel** (or \`dev.completeStripeOnboarding\` API). Reload \`/sell\`. Does the Stripe Connect prompt disappear? Does the page now show seller-onboarded affordances?

4. **The new-agent / template-picker flow.** From \`/sell\` or wherever the entry point is — try clicking the obvious "Create" / "New agent" / "Sell something" CTA. Screenshot the template picker.

5. **Publishing an agent.** Pick a template, create the agent, find the publish action (could be in agent settings, on the play page, in a modal). Try to walk through publish. Screenshot any modal / pricing form. Whether or not it succeeds, screenshot the result.

6. **The marketplace view (or the seller's "My store").** Screenshot the published-agent listing if it shows up there. If there's a public \`/agent/<id>\` page (web/porio.ai marketplace) that's reachable, screenshot that too via the Tailscale URL or note that it's on a different domain.

7. **Optional but valuable**: try the seller dashboard / earnings / payout view if one exists. Note where it is or that it doesn't exist.

Cover anything else you encounter — onboarding modals, success toasts, error states. Capture everything that would matter to someone new picking up this app.

## What to record per step

For EACH step, return:
- \`n\`: integer (1, 2, 3, …)
- \`label\`: short title
- \`url\`: full URL at the time of screenshot
- \`screenshot\`: filename only (relative to \`screenshots/\`)
- \`observation\`: what's actually on screen — be concrete (button text, paywall copy, what's missing, what's grayed out)
- \`insight\`: why this step matters / what a future QA agent should look out for / what's surprising
- \`issues\`: any bugs, awkward copy, broken affordances, console errors visible in the page. Empty array if all clean.

## Wrap-up

Also return:
- \`overallSummary\`: one paragraph
- \`blockingIssues\`: real blockers, not nits
- \`productInsights\`: higher-level UX observations (e.g. "the platform sub paywall on /sell uses different copy than the marketing card on /settings/billing")

## Hard rules

- **agent-browser is a singleton** — do not spawn sub-agents that also drive it. Stay sequential.
- **Take a screenshot for every numbered step.** Files MUST live in \`${SCREENSHOT_DIR}/\` with the names you return in the schema.
- **Don't restart the dev tmux session.**
- **If you hit a real blocker** (e.g. a route 500s, sign-in cookie won't set), capture it as a step with \`issues\` populated and keep going where you can. The point of this run is to document reality, including breakage.
- **Skip Stripe-hosted surfaces.** Use the dev simulators. That's the whole point of this exercise.
- Capture screenshots at desktop viewport (the agent-browser default). If a step is invisibly stuck or fully blank, screenshot it anyway and document what you saw.`,
  { schema: WALK_SCHEMA, label: 'walk-seller-flow' }
)

if (!walk) {
  return { error: 'Walk phase was skipped or failed' }
}

log(`Walked ${walk.steps.length} steps; ${walk.blockingIssues?.length ?? 0} blockers, ${walk.productInsights?.length ?? 0} product insights`)

// ─── Phase 2: Synthesize HTML ────────────────────────────────────────────────

phase('Synthesize')
const synth = await agent(
  `${COMMON_PREAMBLE}

TASK — WRITE THE HTML REPORT.

You have a structured walkthrough of the Porio seller flow with ${walk.steps.length} numbered screenshots. Write a self-contained HTML report at:

  **\`${FLOW_DIR}/index.html\`**

The screenshots are already saved at \`${SCREENSHOT_DIR}/<filename>.png\`. The HTML must reference them as \`screenshots/<filename>.png\` (relative path) so the file opens cleanly when double-clicked.

## Style — match the existing report

There's an existing report at \`${REPO_ROOT}/agents/dev-flow-simulators-test/index.html\` — **read it first** and match its visual style: dark background (\`--bg: #0b0b0c\`), monospace for tech, badge system for status, finding callouts with colored left border, \`img.shot\` class for screenshots, max-width centered layout (~980px). Use the same CSS variable palette so it feels like part of a family of reports.

## Structure for THIS report (it's a flow walkthrough, not a test result)

1. **Header** — title "Seller flow — end-to-end capture", today's date, the test user (\`${TEST_USER.email}\`, role=${TEST_USER.role}), the base URL, and a one-sentence framing.

2. **Summary cards** at the top: steps captured, blocking issues, product insights, screenshots count. Use the same \`.grid > .card\` pattern as the dev-flow-simulators report.

3. **One section per step**, in order. Each step shows:
   - Step header: \`<h3>\${n}. \${label}</h3>\` with the URL in a smaller muted line below.
   - The screenshot, full-width, with \`class="shot"\`.
   - Observation paragraph.
   - Insight callout (use the \`.finding.info\` style — left-bordered box).
   - If \`issues\` is non-empty, render each as a \`.finding.warn\` or \`.finding.fail\` callout depending on severity (you decide based on copy — "broken" / "500" / "blocks" → fail; "awkward" / "missing" / "nit" → warn).

4. **Blocking issues section** at the end — only if non-empty. Use \`.finding.fail\` for each.

5. **Product insights section** — bullet list of the higher-level observations.

6. **Footer** noting the data source: \`agent-browser\` driven against \`${BASE_URL}\`, written by the \`seller-flow-capture\` workflow.

## Hard rules

- HTML must be **self-contained** (inline CSS in \`<style>\`, no external fonts loaded). The dev-flow-simulators report is the template.
- All screenshot \`src\` attributes must be relative paths starting with \`screenshots/\`.
- **DO NOT** add any emojis unless they were already in the input data.
- Use the exact \`observation\` and \`insight\` strings the walker returned — don't paraphrase. You're the synthesizer, not the editor.
- Verify the file was written (\`ls -la ${FLOW_DIR}/index.html\`) before returning.

## Data

\`\`\`json
${JSON.stringify(walk, null, 2)}
\`\`\`

Return \`{ htmlPath, summary, screenshotsReferenced }\`.`,
  { schema: SYNTH_SCHEMA, label: 'synth-html' }
)

return {
  walk: {
    steps: walk.steps.length,
    blockers: walk.blockingIssues?.length ?? 0,
    insights: walk.productInsights?.length ?? 0,
    overallSummary: walk.overallSummary,
  },
  synth,
}
