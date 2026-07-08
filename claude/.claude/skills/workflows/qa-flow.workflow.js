// qa-flow.workflow.js
//
// Pipeline pattern, tuned for `agent-browser`'s single-Chromium constraint:
//
//   1. WALK    — one driver agent walks the named flow sequentially and saves
//                numbered screenshots to agents/flows/<purpose>/NN-step.png.
//   2. ANALYZE — N analyst agents read the PNGs in PARALLEL (read-only, no
//                browser access) and each writes a structured finding set for
//                one step.
//   3. SKEPTIC — for every finding the analysts flagged as a bug, a fresh
//                skeptic re-reads the PNG and tries to refute it (kills the
//                self-preferential bias of "agent likes its own findings").
//   4. SYNTH   — one synthesizer produces the final REPORT.md following the
//                qa-porio Obsidian-style layout.
//
// Why a workflow vs. just `/flow` or `/qa-porio`:
//   - You want multi-perspective adversarial review of the SAME screenshot
//     trail, not just a walk-through.
//   - You want each step looked at by a fresh context that hasn't seen the
//     other steps (cleaner gap detection).
//
// Usage:
//   Workflow({ scriptPath: "/Users/miguel/porio/.claude/skills/workflows/qa-flow.workflow.js",
//              args: { flow: "buyer", outDir: "agents/flows/buyer-2026-06-06" } })
//
// Prereqs (see the qa-porio skill — this workflow piggybacks on it):
//   - tmux session `app` is running `vp run t:dev` on :5173.
//   - tmux session `web` is running Astro dev on :4321.
//   - agent-browser CLI is on PATH.
//   - You're OK with this workflow logging the dev account in. It doesn't reset the DB.

export const meta = {
  name: 'porio-qa-flow',
  description: 'Walk a named Porio flow, then fan out analysts + skeptics on the screenshots, synthesize REPORT.md',
  phases: [
    { title: 'Walk' },
    { title: 'Analyze' },
    { title: 'Skeptic' },
    { title: 'Synth' },
  ],
}

const flow = args?.flow ?? 'buyer'
const outDir = args?.outDir ?? `agents/flows/${flow}`
const REPO = '/Users/miguel/porio'
const absOut = outDir.startsWith('/') ? outDir : `${REPO}/${outDir}`

// ----- schemas -----

const WALK_SCHEMA = {
  type: 'object',
  required: ['steps'],
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['n', 'name', 'screenshot', 'url'],
        properties: {
          n: { type: 'integer', minimum: 1 },
          name: { type: 'string', description: 'short step name (kebab or snake)' },
          screenshot: { type: 'string', description: 'absolute path to the PNG' },
          url: { type: 'string' },
          contextLine: { type: 'string', description: '1 line of what should be on screen' },
        },
      },
    },
    notes: { type: 'string', description: 'any walker-side blockers' },
  },
}

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind', 'title', 'detail'],
        properties: {
          kind: { type: 'string', enum: ['bug', 'ux-gap', 'a11y', 'copy', 'positive'] },
          title: { type: 'string', description: '<60 char headline' },
          detail: { type: 'string', description: '2-4 lines, includes what is visible and why it matters' },
          severity: { type: 'string', enum: ['blocker', 'high', 'med', 'low', 'note'] },
          screenshot: { type: 'string', description: 'PNG path the finding is anchored to' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['stillStands', 'reasoning'],
  properties: {
    stillStands: { type: 'boolean', description: 'true if the finding survives skeptic re-read' },
    reasoning: { type: 'string' },
  },
}

// ----- Phase 1: walk (sequential, single agent — owns the browser) -----

phase('Walk')
log(`walking flow=${flow}, screenshots → ${absOut}`)

const walk = await agent(
  `You are the SOLE driver of agent-browser this run. No other agent is using the browser.

Goal: walk the Porio "${flow}" flow end-to-end and capture numbered screenshots.

Setup:
- Create the output dir: mkdir -p ${absOut}
- Confirm tmux sessions are up:  tmux ls | grep -E '^(app|web):'
- If either is missing, STOP and report — do NOT start them yourself (they may have warm state).

Flow definitions (pick the one matching "${flow}"):

  buyer:  marketplace home → agent detail → "Get agent" → invite flow (use /admin/invites
          as the seeded dev user harri@email.com to mint, then sign in as fresh user) →
          onboarding 4 steps → activation-cliff dashboard → /templates/<id> → "Get template"
          dialog → name + create → land on /agents/<id> → send a chat message → observe
          tool pill + iframe state.

  seller: /sell → "Set up payments" → screenshot the Stripe Connect redirect
          (do NOT fill out Stripe) → back to /sell → /agents/new template picker.

  widget: load /Users/miguel/mike-ai-chat (or the deployed instance per docs/integration-chat-widgets.md)
          → trigger the floating "Ask Mike" launcher → send a query that exercises a tool call
          → observe API call + agent response.

Reference: the qa-porio skill (/Users/miguel/porio/.claude/skills/qa-porio/SKILL.md) for the
exact agent-browser invocations, the React click-handler workarounds (prefer requestSubmit()
and fiber onClick), and the prototype-setter trick for controlled inputs. Re-use those — do
NOT invent new ones.

Screenshots:
- Numbered zero-padded: ${absOut}/01-home.png, 02-agent-detail.png, …
- Capture at every meaningful state change. Be generous; analysts read pixels, not your prose.

Return a structured list of steps. Set "notes" only if you hit a real blocker (servers down,
invite system broken, etc.).`,
  { schema: WALK_SCHEMA, label: `walk:${flow}` }
)

if (walk.notes) log(`walker note: ${walk.notes}`)
log(`walked ${walk.steps.length} steps`)

if (walk.steps.length === 0) {
  return { flow, outDir: absOut, error: walk.notes ?? 'walker returned no steps' }
}

// ----- Phase 2: analyze (parallel) -----
//
// One analyst per step, each with a fresh context. They can Read the PNG but must NOT
// touch agent-browser. The PNG IS the source of truth for that step.

phase('Analyze')

const analyses = await parallel(
  walk.steps.map(step => () =>
    agent(
      `You are auditing ONE screenshot from a Porio "${flow}" flow walkthrough.

Step ${step.n}: ${step.name}
URL: ${step.url}
What should be on screen: ${step.contextLine ?? '(walker did not annotate — infer from the URL and the image)'}
Screenshot: ${step.screenshot}

Read the PNG. Look for:
- bug:      something on screen that contradicts what the URL implies should be there
            (wrong copy, broken layout, error state where there shouldn't be one,
            stale data, infinite spinner caught at capture).
- ux-gap:   the user is technically able to proceed but the path isn't obvious
            (missing CTA, confusing dual buttons, "Get template" copy when owned, etc.).
- a11y:     missing alt text in an image-heavy area, low contrast, focus rings absent,
            target sizes obviously small. Be specific to what's IN the image.
- copy:     typos, jargon, error messages that say nothing useful.
- positive: something that looks notably right — useful to highlight in the report.

Rules:
- Do NOT speculate beyond what the PNG shows. "I think the API is slow" is invalid —
  "the spinner is captured here and the layout is empty" is valid.
- One finding per real issue. Don't pad.
- Skip if the screenshot is clean. Return an empty findings array.
- Severity: blocker = user is stuck. high = user proceeds but value is lost. med = friction.
  low = polish. note = informational.

Set "screenshot" on every finding to ${step.screenshot} so the synthesizer can link it.`,
      { schema: FINDINGS_SCHEMA, label: `analyze:${step.n}-${step.name}` }
    )
  )
)

const allFindings = analyses.filter(Boolean).flatMap(a => a.findings)
const bugs = allFindings.filter(f => f.kind === 'bug' || f.severity === 'blocker' || f.severity === 'high')

log(`analysts surfaced ${allFindings.length} findings (${bugs.length} bug-class)`)

// ----- Phase 3: skeptic on bug-class findings only -----
//
// Adversarial verify. Refuter starts in a fresh context, gets ONLY the finding + the PNG.

phase('Skeptic')

const skepticed = await parallel(
  bugs.map(b => () =>
    agent(
      `Try to REFUTE a claimed Porio QA finding.

Finding:
  kind:     ${b.kind}
  title:    ${b.title}
  severity: ${b.severity ?? '(unset)'}
  detail:
${b.detail.split('\n').map(l => '    ' + l).join('\n')}

Screenshot: ${b.screenshot}

Read the PNG with fresh eyes. Default to stillStands=false unless the finding is clearly
visible AND clearly bad. Common reasons to refute:
- The "bug" is the intended design (e.g. "No agents yet" empty state — that's a real state,
  the question is whether the activation flow should have created one).
- The "bug" is a screenshot timing artifact (caught mid-animation, mid-load).
- The detail describes something not actually visible.

If the finding has a real failure mode that the screenshot supports, set stillStands=true
and briefly say what's load-bearing. Be honest — over-refuting kills the workflow's value.`,
      { schema: VERDICT_SCHEMA, label: `skeptic:${b.title.slice(0, 30)}` }
    ).then(v => v && { ...b, verdict: v })
  )
)

const confirmed = skepticed.filter(Boolean).filter(s => s.verdict.stillStands)
const refuted = skepticed.filter(Boolean).filter(s => !s.verdict.stillStands)

log(`skeptic confirmed ${confirmed.length}/${bugs.length} bug-class findings; refuted ${refuted.length}`)

// non-bug findings (ux-gap, a11y, copy, positive) pass through without skeptic
const passthrough = allFindings.filter(f => !bugs.includes(f))

// ----- Phase 4: synth -----

phase('Synth')

const reportPath = `${absOut}/REPORT.md`

const synth = await agent(
  `Write the QA report for the Porio "${flow}" flow.

Output path: ${reportPath}
Structure: follow /Users/miguel/porio/.claude/skills/qa-porio/SKILL.md → "Producing the report"
section. Specifically: numbered "## N · step name" sections with screenshots embedded inline
via plain markdown (![alt](relative-path.png) — relative to ${absOut}). Issues section after,
letter-keyed, most-impactful first, with **Symptom:**/**Why:**/**Fix:** subheads.

Walk steps (in order, every one gets a section even if it had no findings):
${walk.steps.map(s => `  ${s.n}. ${s.name} — ${s.screenshot.replace(absOut + '/', '')} — ${s.url}`).join('\n')}

Confirmed bug-class findings (each becomes an issue):
${confirmed.length === 0 ? '  (none)' : confirmed.map((c, i) => `  ${String.fromCharCode(65 + i)}. [${c.severity}] ${c.title} — anchored at ${c.screenshot.replace(absOut + '/', '')}\n     ${c.detail.split('\n').join('\n     ')}`).join('\n\n')}

Pass-through findings (ux-gap / a11y / copy / positive — include the high-signal ones in the
walkthrough prose, drop noise):
${passthrough.length === 0 ? '  (none)' : passthrough.map(p => `  - [${p.kind}/${p.severity ?? 'note'}] ${p.title} — ${p.screenshot.replace(absOut + '/', '')}`).join('\n')}

Refuted findings (do NOT include in the report; mentioned here only so you know what was
considered and dropped):
${refuted.length === 0 ? '  (none)' : refuted.map(r => `  - ${r.title}: ${r.verdict.reasoning}`).join('\n')}

Voice: terse, lowercase headings inside issues. No emoji except the occasional ✓ on a
positive-finding screenshot. The user reads this in Obsidian — keep it readable as plain text.

Write the file. Return a one-line summary of what's in it.`,
  { label: 'synth' }
)

return {
  flow,
  outDir: absOut,
  reportPath,
  steps: walk.steps.length,
  findingsTotal: allFindings.length,
  bugsConfirmed: confirmed.length,
  bugsRefuted: refuted.length,
  passthrough: passthrough.length,
  summary: synth,
}
