---
name: doppler
description: Manage secrets for the Porio (void-starter) app via Doppler — the single source of truth for env/secrets across dev + prod. Use when adding/rotating a secret, changing dev vs prod values, wiring a script to Doppler, debugging "why does the deployed worker have the wrong (sandbox/localhost) value", or setting up a new machine. Triggers: "doppler", "set a secret", "prod keys", "sandbox keys", "STRIPE key dev vs prod", ".env.local", "why is prod using the test key".
allowed-tools: Bash, Read, Edit
---

# doppler — Porio secrets

Doppler project **`porio`** is the single source of truth for `~/porio/void-starter` env/secrets. Configs: **`dev`** (sandbox/local values) · **`prd`** (production) · `dev_personal`. Dashboard: dashboard.doppler.com → porio.

## The model (READ THIS — it's non-obvious)

Void's `vp build` **embeds `.env.local` into `dist/ssr/wrangler.json` as worker `vars`**, and `wrangler deploy` ships them. Env precedence Void resolves at build/dev: **`.env.local` > `.dev.vars` > `env.ts` defaults**. So whatever is in `.env.local` at build time becomes the deployed worker's config. `.env.local` is **gitignored** and **materialized from Doppler** — never hand-edit it (it's overwritten).

`scripts/doppler-env.sh [dev|prd]` does `doppler secrets download -p porio -c <cfg> --no-file --format env > .env.local`. That's the whole mechanism.

## package.json (already wired)

- `dev` / `dev:app-only` / `preview` → `bash scripts/doppler-env.sh dev && <cmd>` (dev config → `.env.local`).
- `deploy` → `doppler-env.sh prd && rm -rf dist && vp build && wrangler deploy && doppler-env.sh dev` (build with **prd** values, deploy, then restore dev). **`rm -rf dist` is required** — Void caches the resolved env in `dist`, so a stale build re-ships old values.
- `stripe:sync[:prod]`, `seed:local-auth` → `doppler run -p porio -c <cfg> -- <node script>` (injects `process.env`).
- `env:pull` / `env:pull:prod` → just materialize `.env.local` from dev/prd.

## Adding / rotating a secret

```bash
doppler secrets set KEY=value -p porio -c dev      # or -c prd (or use the dashboard)
npm run env:pull                                    # refresh local .env.local
# deploy picks up prd automatically on next `npm run deploy`
```
Add the key to `void-starter/env.ts` too (typed schema) if the app reads it via `import { env } from "void/env"`.

## dev vs prd value split (the point of the two configs)

| key | dev | prd |
|---|---|---|
| STRIPE_SECRET_KEY / PUBLISHABLE | `sk_test`/`pk_test` (sandbox) | `sk_live` (⚠ publishable is still `pk_test` in app/.env — fix at launch) |
| APP_BASE_URL / PORIO_AUTH_BROKER_URL | `http://localhost:5173` | `https://porio.ai` |
| VPS_HUB_URL | `http://127.0.0.1:8790` (mac hub) | `https://hub.porio.ai` (Hetzner box) |
| VPS_HUB_TOKEN | mac dev hub token (`projects/state/hub.env`) | box hub token (app/.env) |
| AUTH_GOOGLE_CLIENT_ID/SECRET | shared client `594331870926` | same |
| BETTER_AUTH_SECRET / APP_AUTH_SIGNING_SECRET | per-config random | per-config random |
| ADMIN_EMAILS | `miguel@porio.ai,miguelacero528@gmail.com` | same |

Source of truth for the actual secret VALUES when bootstrapping: `~/porio/app/.dev.vars` (sandbox) + `~/porio/app/.env` (prod). Note the app uses `GOOGLE_CLIENT_ID` where porio uses `AUTH_GOOGLE_CLIENT_ID`.

## ⚠ Launch hardening (secrets as plaintext vars)

`wrangler deploy` ships `.env.local` as **plaintext worker `vars`, NOT encrypted secrets** — so `sk_live` etc. are readable in the CF dashboard. Fine pre-launch; **before going live**, either:
1. Set up Doppler's **Cloudflare Workers Sync** (Integrations → Cloudflare) so prd secrets land as encrypted worker **secrets**, and build with no secret vars; or
2. Keep sensitive keys out of the build and `wrangler secret put` them (encrypted). `BETTER_AUTH_SECRET`, `AUTH_GOOGLE_CLIENT_SECRET`, `APP_AUTH_SIGNING_SECRET` were already set as real secrets this way.

## Gotchas

- **`doppler run --mount .env.local` doesn't work here**: it refuses to overwrite an existing file AND cleans up on exit (breaks `dev.sh`'s backgrounded tmux servers). That's why we use `secrets download` → a persistent `.env.local` instead.
- Every command needs `-p porio -c <cfg>` (no `.doppler.yaml` is committed, to keep configs explicit). Run `doppler login` once per machine.
- `.env.local` + `.dev.vars` are gitignored. If you see the deployed worker using sandbox/localhost values, someone deployed with a stale dev `.env.local` (or skipped `rm -rf dist`).
