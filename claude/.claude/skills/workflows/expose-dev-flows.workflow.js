export const meta = {
  name: 'expose-dev-flows',
  description: 'Expose dev/test-only oRPC procedures + UI buttons so agent-browser can drive Stripe-blocked flows end-to-end',
  phases: [
    { title: 'Discover' },
    { title: 'Design' },
    { title: 'Build backend' },
    { title: 'Build UI' },
    { title: 'Verify' },
  ],
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const DISCOVERY_SCHEMA = {
  type: 'object',
  required: ['flows', 'gating', 'existingPatterns'],
  additionalProperties: false,
  properties: {
    flows: {
      type: 'array',
      description: 'Every flow blocked by an external Stripe surface that agent-browser cannot drive in test mode',
      items: {
        type: 'object',
        required: ['name', 'blocker', 'entryRoute', 'gatingProcedure', 'whatToSimulate'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', description: 'short slug like "stripe_connect_onboarding"' },
          blocker: { type: 'string', description: 'what external surface blocks agent-browser (e.g. "Stripe Connect hosted onboarding")' },
          entryRoute: { type: 'string', description: 'app/src/routes/* file path that triggers the flow' },
          gatingProcedure: { type: 'string', description: 'oRPC procedure or DB column that gates downstream UI (e.g. "stripe.getAccountStatus → readyToProcessPayments")' },
          whatToSimulate: { type: 'string', description: 'what state mutation a dev simulator must produce to mark this flow as "complete"' },
        },
      },
    },
    gating: {
      type: 'object',
      required: ['envVar', 'envVarValueForDev', 'adminCheck'],
      additionalProperties: false,
      properties: {
        envVar: { type: 'string', description: 'env binding that distinguishes dev from prod (likely ENVIRONMENT)' },
        envVarValueForDev: { type: 'string', description: 'what value ENVIRONMENT takes locally vs prod' },
        adminCheck: { type: 'string', description: 'how to check if the current user is admin/system' },
      },
    },
    existingPatterns: {
      type: 'object',
      required: ['orpcRouterIndex', 'middlewareFile', 'sampleHandlerFile', 'rootRouteFile'],
      additionalProperties: false,
      properties: {
        orpcRouterIndex: { type: 'string', description: 'file path where all oRPC routers are mounted' },
        middlewareFile: { type: 'string', description: 'file path containing authed/org middleware' },
        sampleHandlerFile: { type: 'string', description: 'file path of a clean handler we can mimic' },
        rootRouteFile: { type: 'string', description: 'TanStack Router root route file path' },
      },
    },
  },
}

const PLAN_SCHEMA = {
  type: 'object',
  required: ['procedures', 'ui', 'gatingStrategy'],
  additionalProperties: false,
  properties: {
    procedures: {
      type: 'array',
      description: 'Every oRPC procedure to add to workers/rpc/dev.ts',
      items: {
        type: 'object',
        required: ['name', 'input', 'effect', 'returns'],
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          input: { type: 'string', description: 'Zod input shape, written as code' },
          effect: { type: 'string', description: 'what DB / Stripe / KV mutations the handler performs' },
          returns: { type: 'string', description: 'shape returned to caller' },
        },
      },
    },
    ui: {
      type: 'object',
      required: ['componentPath', 'mountStrategy', 'sections'],
      additionalProperties: false,
      properties: {
        componentPath: { type: 'string', description: 'absolute path to the new DevToolsPanel component' },
        mountStrategy: { type: 'string', description: 'how the panel is rendered globally (root route? layout?)' },
        sections: {
          type: 'array',
          items: {
            type: 'object',
            required: ['label', 'procedures'],
            additionalProperties: false,
            properties: {
              label: { type: 'string' },
              procedures: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
    gatingStrategy: {
      type: 'object',
      required: ['serverSide', 'clientSide', 'failClosedNote'],
      additionalProperties: false,
      properties: {
        serverSide: { type: 'string', description: 'middleware code shape' },
        clientSide: { type: 'string', description: 'env check shape' },
        failClosedNote: { type: 'string', description: 'why the gate is "allowlist dev" not "denylist prod"' },
      },
    },
  },
}

const BUILD_RESULT_SCHEMA = {
  type: 'object',
  required: ['filesCreated', 'filesEdited', 'summary'],
  additionalProperties: false,
  properties: {
    filesCreated: { type: 'array', items: { type: 'string' } },
    filesEdited: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  required: ['verdict', 'findings'],
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail', 'concerns'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'description'],
        additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['blocker', 'high', 'medium', 'low', 'info'] },
          description: { type: 'string' },
          file: { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
  },
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

const REPO_ROOT = '/Users/miguel/porio'
const APP_DIR = `${REPO_ROOT}/app`

const PREAMBLE = `
You are working inside the Porio repo. The app under \`${APP_DIR}/\` is a React 19 SPA + Cloudflare Workers backend with oRPC.

CRITICAL CONTEXT:
- Do NOT restart tmux dev sessions (\`app\`, \`web\`, \`tail\`, \`web-tail\`). They hold warm caches and stateful local D1. They're already running.
- The goal is to expose DEV/TEST-ONLY procedures and UI affordances so that \`agent-browser\` QA flows can skip Stripe-hosted surfaces (Connect onboarding, Checkout, billing portal).
- SECURITY IS THE #1 CONSIDERATION. These procedures mutate state in ways a malicious user could weaponize (granting platform subs, marking onboarding complete). They MUST be unreachable in production.
- Gating is "allowlist dev", not "denylist prod" — \`if (env.ENVIRONMENT !== "development") throw\`, never \`if (env.ENVIRONMENT === "production")\`. An unset env should fail closed.
- Also require admin role (\`role === "admin" || role === "system"\`) on top of the env check. Defense in depth.
- Use \`vp\` not raw npm/vite. The codebase uses oRPC (\`@orpc/server\`), Prisma on D1, better-auth.
- Read \`${APP_DIR}/CLAUDE.md\` for repo conventions if you need them.
`.trim()

phase('Discover')
const discovery = await agent(
  `${PREAMBLE}

TASK — DISCOVER.

Survey every user-facing flow in \`${APP_DIR}/\` that gets blocked by an external Stripe surface in test mode. The known suspects:
1. **Stripe Connect onboarding** for sellers (\`stripe.createAccountLink\` → hosted onboarding)
2. **Platform subscription checkout** for sellers (\`stripe.createSubscriptionCheckout\`) — required to publish agents
3. **Buyer plan checkout** (\`stripe.createBuyerPlanCheckout\`) — buyer subscription
4. **Agent purchase** (one-time Checkout for a marketplace template)
5. **Billing portal** (\`stripe.createBillingPortalSession\`)

For each, find:
- The entry route file (where the user clicks the button that triggers it)
- The oRPC procedure or DB column that downstream UI checks to know "this flow is complete" (e.g. \`getAccountStatus → readyToProcessPayments\`, \`organization.platformSubscriptionStatus === "active"\`, \`TemplateOwnership\` row exists)
- Exactly what DB / Stripe mutation a dev simulator would have to perform to pretend the user completed the flow

Also map the existing oRPC structure:
- Where are routers mounted into the root tree?
- What does \`authed\` / \`org\` middleware look like?
- A sample clean handler we can mimic in style.
- The TanStack Router root route file (so we know where to mount a global DevToolsPanel).

Output structured per the schema. Do NOT make changes yet — this is read-only discovery.`,
  { schema: DISCOVERY_SCHEMA, label: 'discover' }
)

if (!discovery) {
  return { error: 'Discovery phase was skipped or failed' }
}

log(`Discovered ${discovery.flows.length} Stripe-blocked flows`)
discovery.flows.forEach(f => log(`  • ${f.name} (${f.blocker})`))

phase('Design')
const plan = await agent(
  `${PREAMBLE}

TASK — DESIGN.

You have a discovery report on Stripe-blocked flows in the Porio app. Design the implementation:

DISCOVERY REPORT:
${JSON.stringify(discovery, null, 2)}

Produce a concrete spec for:

1. **\`workers/rpc/dev.ts\`** — a new oRPC router with one procedure per simulator. For each procedure:
   - Name (e.g. \`completeStripeOnboarding\`, \`resetStripeOnboarding\`, \`grantPlatformSubscription\`, \`grantBuyerPlan\`, \`simulateAgentPurchase\`, \`clearAllDevState\`)
   - Zod input shape (org-scoped procedures pull orgId from context; cross-org admin procedures take it as input)
   - What it mutates (DB column updates, Stripe API calls, KV cache invalidation)
   - Return shape

   For \`completeStripeOnboarding\`: the procedure must use Stripe's test-mode update APIs to set the V2 account's identity, accept ToS, and attach \`btok_us_verified\` as the external account so \`stripe.getAccountStatus\` returns \`readyToProcessPayments: true\`. Reference: https://docs.stripe.com/api/v2/core/accounts/update — but be pragmatic; in test mode you can also just directly toggle the org's gating DB columns if the V2 API dance is too fiddly. Both options are fine; pick the simpler one and note the tradeoff.

2. **\`src/components/dev/DevToolsPanel.tsx\`** — a floating bottom-right panel, only rendered when \`import.meta.env.DEV === true\` (so it's tree-shaken out of prod). Organized into collapsible sections (Seller, Buyer, Reset). Each button calls one dev procedure and shows a toast on success/error.

3. **Mounting strategy** — where to mount \`<DevToolsPanel />\` so it's visible on every authed page. Likely the root route or an authed layout. Identify the exact file.

4. **Gating strategy** — server side (middleware code shape) and client side (env check). Explain in one sentence why allowlist-dev is safer than denylist-prod.

Output structured per the schema.`,
  { schema: PLAN_SCHEMA, label: 'design' }
)

if (!plan) {
  return { error: 'Design phase was skipped or failed', discovery }
}

log(`Designed ${plan.procedures.length} dev procedures, UI mounts at ${plan.ui.mountStrategy}`)

phase('Build backend')
const backend = await agent(
  `${PREAMBLE}

TASK — BUILD BACKEND.

You have a discovery report and a design spec. Implement the backend.

DISCOVERY:
${JSON.stringify(discovery, null, 2)}

DESIGN:
${JSON.stringify(plan, null, 2)}

Concretely:
1. Create \`${APP_DIR}/workers/rpc/dev.ts\` with the oRPC router. Each procedure must:
   - Use the same middleware chain pattern as the existing \`authed\` / \`org\` procedures (read \`${APP_DIR}/workers/rpc/middleware.ts\` to mimic).
   - Layer on a \`devOnly\` middleware that throws unless \`context.env.ENVIRONMENT === "development"\` AND the user is admin/system. THIS IS NON-NEGOTIABLE.
   - Be commented sparingly — one-line WHY comments only where the intent is non-obvious (e.g. on Stripe test-mode shortcuts).
2. Wire \`dev\` into the root router (the file identified in discovery). Use the exact same registration pattern as the other routers.
3. For \`completeStripeOnboarding\`: also invalidate the relevant KV cache keys (\`stripeCacheKeys.accountStatus(orgId)\` etc.) so the next \`getAccountStatus\` call reflects the new state.
4. Use existing helpers (\`getDb\`, \`getStripe\`, \`stripeCacheKeys\`, etc.) — do not re-implement them.
5. After implementing, run \`cd ${APP_DIR} && vp check 2>&1 | tail -50\` and confirm there are no new type errors related to your changes. Iterate until clean.

Do NOT touch the UI in this phase. Do NOT commit. Report files created/edited + summary.`,
  { schema: BUILD_RESULT_SCHEMA, label: 'build-backend' }
)

if (!backend) {
  return { error: 'Backend build phase was skipped or failed', discovery, plan }
}

log(`Backend: created ${backend.filesCreated.length}, edited ${backend.filesEdited.length}`)

phase('Build UI')
const ui = await agent(
  `${PREAMBLE}

TASK — BUILD UI.

The backend is done. Now build the dev-only UI that calls those procedures.

DESIGN:
${JSON.stringify(plan, null, 2)}

BACKEND RESULT (procedures are now live on the oRPC client):
${JSON.stringify(backend, null, 2)}

Concretely:
1. Create \`${plan.ui.componentPath}\` — a floating bottom-right panel.
   - Gate the ENTIRE component (including the import) behind \`import.meta.env.DEV\`. The component file itself can ship normally; the *consumer* must check the env flag before rendering. (Vite tree-shakes \`if (import.meta.env.DEV)\` branches in prod builds.)
   - Style with the existing Tailwind + Base UI + shadcn primitives used in the app — read a couple of existing components first to match.
   - Sections per the design spec, each with buttons that call the dev procedures via the oRPC client (import path matches existing usage in the app).
   - Use \`@tanstack/react-query\` \`useMutation\` for each button. On success/error, surface a toast using the app's existing toast pattern (grep for \`toast.success\` or similar).
   - Show the current "simulated state" inline (e.g. "Stripe: ✓ ready" / "Stripe: ✗ not connected") so the QA agent / user can see what's set.

2. Mount it. Per the design's \`mountStrategy\`, edit the identified route file to render \`{import.meta.env.DEV && <DevToolsPanel />}\`. Do NOT do this at module-import time — render-time guard so SSR/build-time doesn't trip.

3. Run \`cd ${APP_DIR} && vp check 2>&1 | tail -50\` and clean up any type errors.

Report files created/edited + summary.`,
  { schema: BUILD_RESULT_SCHEMA, label: 'build-ui' }
)

if (!ui) {
  return { error: 'UI build phase was skipped or failed', discovery, plan, backend }
}

log(`UI: created ${ui.filesCreated.length}, edited ${ui.filesEdited.length}`)

phase('Verify')
const allFiles = [...backend.filesCreated, ...backend.filesEdited, ...ui.filesCreated, ...ui.filesEdited]

const [security, typecheck, guide] = await parallel([
  () => agent(
    `${PREAMBLE}

TASK — ADVERSARIAL SECURITY REVIEW.

A new \`workers/rpc/dev.ts\` router was just added with procedures that mutate Stripe state and grant subscriptions. These MUST be unreachable in production.

Files touched:
${allFiles.map(f => `- ${f}`).join('\n')}

Read each touched file. Try to find ANY way a production user could:
- Call one of these procedures from \`app.porio.ai\` in prod (env binding misconfigured? middleware order wrong? gate inverted?)
- Render the DevToolsPanel in a prod build (gate at module-import time instead of render-time? \`import.meta.env.DEV\` check missing? bundler-time vs runtime check mistake?)
- Escalate via the admin check (system role abused? \`isAdmin\` checked correctly?)
- Bypass via a webhook, public-api route, or other oRPC procedure that lacks the same middleware.

Also verify:
- The dev procedures aren't accidentally exposed via the REST sister routes (Hono \`/api/cli/...\` etc).
- KV cache invalidation actually fires (otherwise a "simulated complete" state will be hidden by the 1-day cache TTL).
- The \`ENVIRONMENT\` env var is actually \`"development"\` locally — check \`.dev.vars\` or \`wrangler.jsonc\` to confirm.

Report verdict: pass / concerns / fail. List findings by severity.`,
    { schema: VERIFY_SCHEMA, label: 'verify:security' }
  ),
  () => agent(
    `${PREAMBLE}

TASK — TYPECHECK + LINT.

Run \`cd ${APP_DIR} && vp check 2>&1 | tail -80\` and report:
- Are there any type errors or lint warnings in the files touched by this work?
  Touched files:
${allFiles.map(f => `  - ${f}`).join('\n')}
- If yes, list each one. Otherwise verdict pass.
- Also confirm the existing \`tail\` tmux session (app worker logs) doesn't show new errors when the dev server hot-reloads. Run \`tmux capture-pane -t tail -p | tail -30\` to check.

DO NOT modify any files — this is verification only.`,
    { schema: VERIFY_SCHEMA, label: 'verify:typecheck' }
  ),
  () => agent(
    `${PREAMBLE}

TASK — WRITE THE USAGE GUIDE.

The new dev procedures + UI are live. Write a concise guide for a future Claude / human picking this up cold. It should cover:

1. Which dev procedures exist and what each one simulates.
2. How agent-browser flows can use them — both via clicking the DevToolsPanel buttons AND via direct fetch calls to the oRPC endpoint (so headless flows don't need to render the React app).
3. The exact gating: env var, role check, why allowlist-dev.
4. Reset procedure — how to wipe simulated state between QA runs.

Save the guide to \`${REPO_ROOT}/docs/dev-flow-simulators.md\`. Follow the existing \`docs/\` style — file:line references where useful, terse, written for someone with no recent context.

Files touched (for your reference):
${allFiles.map(f => `- ${f}`).join('\n')}

Plan/design context:
${JSON.stringify(plan, null, 2)}

Report the file path written and a one-paragraph summary.`,
    { schema: BUILD_RESULT_SCHEMA, label: 'verify:guide' }
  ),
])

return {
  discovery: {
    flowsFound: discovery.flows.length,
    flowNames: discovery.flows.map(f => f.name),
  },
  plan: {
    procedureCount: plan.procedures.length,
    procedures: plan.procedures.map(p => p.name),
    uiPath: plan.ui.componentPath,
  },
  build: {
    backend,
    ui,
  },
  verify: {
    security,
    typecheck,
    guide,
  },
}
