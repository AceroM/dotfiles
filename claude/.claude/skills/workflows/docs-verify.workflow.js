// docs-verify.workflow.js
//
// Fan-out-and-synthesize: extract every file:line claim from a Porio docs/<topic>.md
// entry, verify each in parallel against current code, optionally re-skeptic the
// "drifted" ones, return a structured drift report.
//
// Usage:
//   Workflow({ scriptPath: "/Users/miguel/porio/.claude/skills/workflows/docs-verify.workflow.js",
//              args: { docPath: "docs/stripe.md" } })
//
// Treat this as a template, not gospel. Common adaptations:
//   - Add a Phase 3 that opens an Edit for each drift and writes the suggested correction.
//   - Cap verifier count when docs have >100 claims (budget guard, batch instead of full parallel).
//   - Pipe drifted refs through `git log -L` to find the commit that moved them.

export const meta = {
  name: 'porio-docs-verify',
  description: 'Verify every file:line claim in a Porio docs/<topic>.md entry against current code',
  phases: [
    { title: 'Extract' },
    { title: 'Verify' },
    { title: 'Skeptic' },
  ],
}

const docPath = args?.docPath ?? 'docs/stripe.md'
const REPO = '/Users/miguel/porio'
const absDoc = docPath.startsWith('/') ? docPath : `${REPO}/${docPath}`

// ----- schemas -----

const CLAIMS_SCHEMA = {
  type: 'object',
  required: ['claims'],
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'line', 'assertion'],
        properties: {
          file: { type: 'string', description: 'repo-relative path, e.g. workers/rpc/stripe.ts' },
          line: { type: 'integer', minimum: 1 },
          assertion: { type: 'string', description: 'what the doc claims is at this location' },
          section: { type: 'string', description: 'doc section the claim appears under' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['status', 'evidence'],
  properties: {
    status: { type: 'string', enum: ['holds', 'drifted', 'missing'] },
    evidence: { type: 'string', description: '1-3 lines from the actual code at or near the cited line' },
    actualLine: { type: 'integer', description: 'if drifted, where the referenced symbol/behavior lives now' },
    correction: { type: 'string', description: 'one-line fix the doc should adopt; empty if status=holds' },
  },
}

const SKEPTIC_SCHEMA = {
  type: 'object',
  required: ['confirmedDrift', 'reasoning'],
  properties: {
    confirmedDrift: { type: 'boolean', description: 'true if the drift is real after re-reading' },
    reasoning: { type: 'string' },
  },
}

// ----- Phase 1: extract -----

phase('Extract')
log(`extracting claims from ${docPath}`)

const extracted = await agent(
  `Read ${absDoc}. Extract every file:line reference and the assertion the doc makes about that location.

Include:
- Direct refs: backticked file paths with a line number (e.g. \`workers/rpc/stripe.ts:412\`).
- Refs in markdown links: [foo](path/file.ts:LINE).
- Behavioral claims tied to a ref: if the doc says "validates X" near a file:line, capture "validates X" as the assertion, not just "function exists".

For each claim, capture:
- file: repo-relative path
- line: integer
- assertion: 1-line summary of what the doc says about this location
- section: the nearest "##" heading above the claim

Don't deduplicate — if the same file:line appears with two different assertions, return both rows.`,
  { schema: CLAIMS_SCHEMA, label: 'extract' }
)

log(`found ${extracted.claims.length} claims`)

if (extracted.claims.length === 0) {
  return { docPath, total: 0, drifted: [], note: 'no file:line claims found in doc' }
}

// ----- Phase 2: verify (parallel) -----

phase('Verify')

const verdicts = await parallel(
  extracted.claims.map((c, i) => () =>
    agent(
      `Verify a claim from ${docPath}.

The doc says, in section "${c.section ?? '(unknown)'}":
  > ${c.assertion}

The claim is anchored at:
  ${c.file}:${c.line}

Read ${REPO}/${c.file} around line ${c.line} (read at least 10 lines of context on each side, more if the symbol is large). Determine:

- holds:   the cited line still contains what the doc says it does.
- drifted: the symbol/behavior exists but has moved to a different line, OR the line still exists but the behavior described has materially changed.
- missing: the file is gone, the line is past EOF, or the referenced symbol can't be found anywhere in the file.

Quote 1-3 lines of actual code as evidence. If drifted, set actualLine to where the symbol lives now. If drifted or missing, write a one-line correction the doc should adopt.

Be strict but not pedantic: "now lives 3 lines down due to an added comment" is holds, not drifted. Behavior changes (different validation, removed branch, changed default) are drifted.`,
      { schema: VERDICT_SCHEMA, label: `verify:${c.file}:${c.line}` }
    ).then(v => v && { ...c, ...v })
  )
)

const checked = verdicts.filter(Boolean)
const drifted = checked.filter(v => v.status !== 'holds')

log(`${checked.length}/${extracted.claims.length} claims verified, ${drifted.length} need attention`)

if (drifted.length === 0) {
  return {
    docPath,
    total: checked.length,
    drifted: [],
    summary: 'all claims hold against current code',
  }
}

// ----- Phase 3: skeptic pass on drifted only -----
//
// Adversarial verify — a fresh agent tries to refute each drift finding.
// Catches verifier false positives (e.g. it didn't look at the right import).

phase('Skeptic')

const skepticed = await parallel(
  drifted.map((d, i) => () =>
    agent(
      `Adversarially verify a claimed doc drift.

A prior agent says ${docPath} drifted at:
  ${d.file}:${d.line}
  doc assertion: "${d.assertion}"
  verifier verdict: ${d.status}
  verifier evidence:
    ${d.evidence}
  verifier correction: "${d.correction ?? '(none)'}"

Your job: try to *refute* the drift. Re-read ${REPO}/${d.file} (broaden your read window — look at the whole function, look at imports, look at re-exports from index files). Is it possible the doc is still correct because the behavior moved but the *cited line still does what the doc said* (e.g. via a helper invocation)? Is it possible the verifier missed a re-export?

Default to confirmedDrift=true only if you can't find a reading under which the doc is correct.`,
      { schema: SKEPTIC_SCHEMA, label: `skeptic:${d.file}:${d.line}` }
    ).then(s => s && { ...d, skeptic: s })
  )
)

const confirmed = skepticed.filter(Boolean).filter(s => s.skeptic.confirmedDrift)
const refuted = skepticed.filter(Boolean).filter(s => !s.skeptic.confirmedDrift)

log(`skeptic confirmed ${confirmed.length}/${drifted.length} drifts; refuted ${refuted.length}`)

return {
  docPath,
  total: checked.length,
  holds: checked.length - drifted.length,
  driftedRaw: drifted.length,
  driftedConfirmed: confirmed.length,
  driftedRefuted: refuted.length,
  confirmed: confirmed.map(c => ({
    file: c.file,
    line: c.line,
    assertion: c.assertion,
    status: c.status,
    actualLine: c.actualLine,
    correction: c.correction,
    evidence: c.evidence,
  })),
  refuted: refuted.map(r => ({
    file: r.file,
    line: r.line,
    why: r.skeptic.reasoning,
  })),
}
