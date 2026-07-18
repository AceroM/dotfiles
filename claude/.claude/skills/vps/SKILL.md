---
name: vps
description: SSH into and operate the Porio VPS (the "migz" Hetzner box, 178.156.146.209 / hub.porio.ai) that runs the porio-hub daemon serving Void app previews + WfP builds. Use when checking/restarting the hub, deploying an updated porio-hub.ts / wfp-publish.ts, inspecting per-app repos or the seed templates, wiring *.porio.site preview serving + Caddy TLS, or debugging "the preview won't load / app won't seed on the box". Triggers: "vps", "the hub box", "porio-hub", "ssh into the server", "hub.porio.ai", "migz", "po " (the SSH alias).
allowed-tools: Bash
---

# vps — the Porio hub box

`migz`, a Hetzner node at **178.156.146.209**, TLS at **hub.porio.ai** (+ `178-156-146-209.sslip.io`) via Caddy. Runs the **porio-hub** Bun daemon that seeds/serves Void app previews (and, once updated, WfP builds).

## Access

- **`po`** = `ssh -t root@178.156.146.209 "su - porio"` — interactive shell as the **porio** user (owns the hub + `/srv/porio`). Add to your shell rc; use for hub/app inspection.
- **root**: `ssh root@178.156.146.209 'systemctl …'` — for systemd (the hub runs as `porio`, but service control needs root). `BatchMode=yes -o ConnectTimeout=10` for scripted checks.

## Layout

- **Hub**: `/srv/porio/hub/porio-hub.ts` (+ `package.json`). systemd unit **`porio-hub`** — `User=porio`, `WorkingDirectory=/srv/porio/hub`, `ExecStart=/home/porio/.bun/bin/bun run …/porio-hub.ts`, `EnvironmentFile=/srv/porio/state/hub.env`. Listens **127.0.0.1:8790**; health `GET /health` → `{"ok":true}`. Auth: `HUB_TOKEN` in `/srv/porio/state/hub.env` (Bearer).
- `/srv/porio/apps/<appId>/` — per-app git repo + dev server (dedicated VPS-runtime apps). `/srv/porio/templates/` — clone/seed sources. `/srv/porio/git/` — bare repos. `/srv/porio/bin`, `/srv/porio/state`.
- `/home/porio/porio-{miguel,harri}` — void-starter/app worktree checkouts.
- Toolchain (porio user): bun `/home/porio/.bun/bin/bun`, node `/home/porio/.vite-plus/bin/node`, wrangler `/usr/local/bin/wrangler`. **CF creds for WfP deploy**: `/home/porio/.config/cloudflare/wrangler.env` (CLOUDFLARE_ACCOUNT_ID/API_TOKEN).
- **Caddy** `/etc/caddy/Caddyfile`: `hub.porio.ai` + sslip.io → `:8790`; `miguel-dev.porio.ai`→`:3433`, `harri-dev.porio.ai`→`:3434` (basic-auth). **No `*.porio.site` block yet.**

## Deploy an updated hub

The box hub can lag the local `~/porio/void-starter/hub/porio-hub.ts`. To push:
```bash
scp ~/porio/void-starter/hub/porio-hub.ts ~/porio/void-starter/hub/wfp-publish.ts root@178.156.146.209:/srv/porio/hub/
ssh root@178.156.146.209 'systemctl restart porio-hub && sleep 2 && curl -s localhost:8790/health'
```
⚠ A restart drops warm app dev-server caches (brief preview interruption). The box hub may hold local edits (look for `porio-hub.ts.bak-*`) — **diff before overwriting** so you don't clobber divergent changes.

## Known state (2026-07-07) + MVP gaps

Hub daemon + Caddy **healthy** (`/health` ok). But for the create-app → `*.porio.site` preview loop:
- **`/srv/porio/templates/` is EMPTY** — no `void-boilerplate` seed source, so the box can't seed new Void apps. Copy the template up.
- **Box `porio-hub.ts` is STALE** — missing the preview-subdomain router (`PREVIEW_DOMAIN`/`resolveAppIdBySlug`) and WfP publish (`publishAppToWfp`) that exist locally. Deploy the updated hub (above).
- **`*.porio.site` not served** — needs the porio.site NS flip to Cloudflare (or Namecheap wildcard) → this box, plus a Caddy `*.porio.site` block (on-demand TLS or CF-proxied). See [[porio-domains-plan]].

## Related

- The prod worker's `VPS_HUB_URL` must point here (`https://hub.porio.ai`) with the box's `HUB_TOKEN` as `VPS_HUB_TOKEN` (managed in Doppler prd — see the `doppler` skill).
- Future: a **VS Code server per app** (openvscode-server in each app dir, proxied same-origin) surfaced as another tab on `/apps/:id` — the sibling `~/porio/app` did this (`memory app-vscode-in-browser`); port that pattern here.
