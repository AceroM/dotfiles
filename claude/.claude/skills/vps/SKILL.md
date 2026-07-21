---
name: vps
description: SSH into and operate the Porio VPS (the "migz" Hetzner box, 178.156.146.209 / hub.porio.ai) that runs the porio-hub Bun daemon — the gateway serving Void app previews, agent chat sessions, WfP/Cloudflare publishes, and the trusted front for optional per-app E2B runtimes. Use when checking/restarting the hub, deploying an updated porio-hub.ts (+ its sibling modules), inspecting per-app repos / seed templates / SQLite, wiring *.porio.site preview + Caddy TLS, reading logs, running the doctor/watchdog, or debugging "the preview won't load / app won't seed / publish failed / chat won't send" on the box. Triggers: "vps", "the hub box", "porio-hub", "ssh into the server", "hub.porio.ai", "migz", "po " (the SSH alias), "/admin/vps".
allowed-tools: Bash
---

# vps — the Porio hub box

`migz`, a Hetzner node at **178.156.146.209**, TLS at **hub.porio.ai** (+ `178-156-146-209.sslip.io`) via Caddy. Runs the **porio-hub** Bun daemon: the trusted gateway that hosts `vps`-runtime apps (TanStack Start + Vite in a Git working tree), drives their agent chat sessions (`tmux -L porio`), serves previews, runs Cloudflare/WfP publishes, and reverse-proxies to optional per-app E2B sandboxes. The prod app Worker (`app.porio.ai`) is the only intended client.

**Source of truth for the daemon itself is the repo: `hub/README.md`** (HTTP contract, every route, the full lifecycle/eviction/pressure model, E2B boundary). This skill is the *operational* layer README can't hold: how to reach the box, where things live on disk, how to deploy safely, and hard-won ops facts. When they disagree, trust `hub/README.md` for behavior and this file for access/ops.

## Access

- **`po`** = `ssh -t root@178.156.146.209 "su - porio"` — interactive shell as the **porio** user (owns the hub + `/srv/porio`). Use for hub/app inspection, tmux, git.
- **root**: `ssh root@178.156.146.209 '<cmd>'` — for systemd/journalctl (hub runs as `porio`, but service control + `hub-doctor` need root). Scripted checks: add `-o BatchMode=yes -o ConnectTimeout=10`.
- The box **has `curl`** (bootstrap installs it; the doctor uses it) — health checks over ssh are fine here. (The "curl is absent" note in CLAUDE.md is about the local Cloudflare deploy context, not this box.)
- tmux agent sockets are owned by **porio**: from a root ssh use `sudo -u porio tmux -L porio ls`. The `-L bg` socket is the legacy dev-server socket; agent chats live on `-L porio`.

## Box layout

- **Hub source**: `/srv/porio/hub/` — `porio-hub.ts` + all sibling `*.ts` modules + `package.json`. systemd unit **`porio-hub`** (`User=porio`, `WorkingDirectory=/srv/porio/hub`, `ExecStart=bun run …/porio-hub.ts`, `EnvironmentFile=/srv/porio/state/hub.env`, `OOMScoreAdjust=-500`). Binds **127.0.0.1:8790**.
- **State**: `/srv/porio/state/` — `hub.env` (`HUB_TOKEN=…`, chmod 600), `porio-hub.sqlite` (apps, task leases/archives, events; WAL), `logs/app-<id>.log`, `watchdog.json` (doctor heartbeat), `repository-backups/` (transient bundles, always cleaned).
- **Apps**: `/srv/porio/apps/<appId>/repo/` — the app's git working tree (`bun run dev` runs here). `/srv/porio/repositories/<appId>.git/` — Porio-owned bare origins (GitHub-connected apps skip these). `/srv/porio/{git,bin}` reserved. `/srv/porio/templates/` — clone/seed sources.
- **Dev worktrees**: `/home/porio/porio-{miguel,harri}` — void-starter/app checkouts fronted at `miguel-dev.porio.ai:3433` / `harri-dev.porio.ai:3434` (basic-auth), served by a separate `porio-dev.service`.
- **Toolchain (porio user)**: bun `/home/porio/.bun/bin/bun`, node `/home/porio/.vite-plus/bin/node`, wrangler `/usr/local/bin/wrangler`. **CF creds for publish**: `/home/porio/.config/cloudflare/wrangler.env` (`CLOUDFLARE_ACCOUNT_ID` / `API_TOKEN`).
- **Caddy** `/etc/caddy/Caddyfile`: `hub.porio.ai` + sslip.io → `:8790`; the two `*-dev.porio.ai` blocks; and the `*.porio.site` preview/publish path (edge wildcard cert; capability hostnames stay out of per-host ACME).
- **Box-only unit config** (NOT in any repo, so invisible from the codebase): both units set `KillMode=process` so a restart does **not** SIGKILL the tmux server (that used to nuke every live session). For `porio-dev.service` this lives in a drop-in `…/porio-dev.service.d/killmode.conf`; `porio-hub.service` already carries it. Preserve this when reworking units.

## Deploy an updated hub — the #1 way to take the box down

The box hub can lag the repo. **Never ship `porio-hub.ts` alone.** It imports many sibling modules (`dev-vars-file`, `source-store`, `git-version`, `repository-store`, `files-store`, `source-map-resolver`, `runtime-auth`, `e2b-webhook`, `e2b-runtime`, `void-broker-patch`, `wfp-publish`, `public-demo-agent`, …). A missing sibling fails bun's import resolution at boot, and `Restart=always` turns that into a **crash loop that takes the whole hub API down**. Ship the whole set:

```bash
# from the repo root (/Users/miguel/porioHQ/porio) — sync every hub module, skip tests + the E2B image dir
rsync -avz --exclude='*.test.ts' --exclude='e2b-template' \
  hub/ root@178.156.146.209:/srv/porio/hub/
ssh root@178.156.146.209 'systemctl restart porio-hub && sleep 2 && curl -s localhost:8790/health'
# expect: {"ok":true,...}
```

- ⚠ **Diff before overwriting.** The box may hold local edits (look for `porio-hub.ts.bak-*`); confirm you're not clobbering divergent hotfixes before rsync.
- ⚠ A restart drops warm dev-server caches (brief preview interruption). Running apps keep their PIDs (they live outside the daemon) — the restarted hub **re-adopts live PIDs and marks dead ones stopped**; it does not kill running apps.
- ⚠ Verify it's actually live: `ssh root@… 'systemctl status porio-hub --no-pager | head'` + `curl -s localhost:8790/api/health` (needs no bearer for `/health`; `/api/health` and everything else need `authorization: Bearer $HUB_TOKEN`).

## Ops

- **Logs**: `ssh root@… 'journalctl -u porio-hub -f'` (single-line JSON). Per-app dev-server + `bun install` output: `/srv/porio/state/logs/app-<id>.log`.
- **hub-doctor** (`/usr/local/bin/hub-doctor`, source `hub/doctor.sh`): root check/recovery. Plain run reports; `hub-doctor --repair` restarts wedged hub/caddy, vacuums the journal + oversized app logs, and sheds memory via `POST /api/doctor/shed` (only kills the `-L porio` agent tmux server as a last resort at critical pressure with the hub unreachable — never touches `-L bg`). **After a full box crash/reboot, `hub-doctor --repair` is the one-command bring-everything-back-up.**
- **porio-watchdog.timer** runs `hub-doctor --repair --quiet` every 2 min, so a wedged hub / dead caddy / swap creep self-heals unattended. Its heartbeat lands in `state/watchdog.json` and surfaces in `GET /api/doctor`.
- **prestart** (`/usr/local/bin/prestart`, source `hub/prestart`): restart one app's dev server. `prestart <app>` resolves by partial name / id prefix / `<slug>-<id8>` session name and stop+starts through the hub API (works for either the tmux or setsid boot path). No args → lists known apps.
- **Doctor endpoint**: `GET /api/doctor` → structured checklist (mem/swap/disk/load, caddy+TLS, tmux sockets, session counts, stray/stuck procs, watchdog heartbeat) — this feeds the **/admin/vps** Doctor UI. `POST /api/doctor/shed {level?}` triggers a manual load shed.
- **First-time box setup**: `sudo ./bootstrap.sh <domain>` (idempotent) installs caddy/bun, mints `HUB_TOKEN`, writes the unit + Caddyfile, opens ufw 22/80/443, installs `prestart` + `hub-doctor`.

## Disk & session topology (learned the hard way)

- **Disk is dev tooling, not customer apps.** ~20G of a ~32G-used box is `/home/porio` caches (`.bun`, `.codex`, `.diffshub-homes`, `.local`, `.npm`, `.cache`, `.vite-plus`, `.agent-browser`); `/srv/porio/apps` is only ~3.7G. Prunes that target shadow checkouts aim at the wrong 11%.
- **App `node_modules` are heavily hardlinked** to each other and ~1.3G to the bun store. `du -sh` overstates reclaimable space ~4x. Deleting some trees frees ~nothing (inodes stay linked from the rest); space only releases when the *whole* set goes. Always compare `du -sh --count-links` vs `du -sh` before estimating a prune.
- **`/tmp` is tmpfs** — files there cost RAM, not disk. Clearing stale `/tmp` dirs is a memory fix.
- **Idle signal for dev sessions is the codex rollout mtime** (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`), NOT tmux `#{session_activity}` (that never updates for detached bridge sessions). Never prune those rollouts — they are the resume corpus + `providerSessionId` source.
- See memory `vps-disk-and-session-topology` for the full writeup.

## Worker-side integration

- The app Worker reaches the hub via `src/lib/hub-client.ts`: base URL `env.VPS_HUB_URL` (default `http://127.0.0.1:8790` in dev; **must be `https://hub.porio.ai` in prod**), auth `Bearer env.VPS_HUB_TOKEN` — the same secret as the box's `HUB_TOKEN`, shared both directions (managed in Doppler prd; see the `doppler` skill).
- Internal Worker↔hub callbacks (usage, content-changed, repo/app backups, template-preview, agent-jobs) live under `routes/api/internal/*` and `routes/api/admin/agent-jobs.ts`, all gated on `VPS_HUB_TOKEN`. Backups stream to the Worker's private `void/storage` R2 under `repository-backups/v1/` — no R2 creds on the box.
- **`*.porio.site` is live**: `PORIO_PREVIEW_DOMAIN=porio.site`. Published apps get `<slug>.porio.site`; public template demos arrive as `share-<uuid>.porio.site` via the **dispatch Worker** (`dispatch/`), which forwards the `share-<uuid>` capability in `x-porio-preview-alias` and authenticates the hop with a narrow `PORIO_PREVIEW_GATEWAY_TOKEN` (`x-porio-preview-token`) — never the broad `HUB_TOKEN`. The hub revalidates the link against platform D1 per request, blocks encoded secret-file paths, strips the transport headers, and forces `private, no-store` + `Referrer-Policy: no-referrer`.
- **Admin surfaces**: `/admin/vps` (Doctor checklist + box health), `/admin/vps/apps`, `/admin/vps/publishes`.

## E2B gateway boundary — fail-closed on purpose

The hub is also the trusted front for optional per-app E2B sandboxes (one sandbox **per app**, not per task; same `tmux -L porio` + agent CLIs inside; full-memory pause preserves the live VM). Two hard safety gates, both default-off, both intentional:

- **Prospect E2B provisioning is fail-closed** while the control hub and tenant processes share one Unix uid: same-uid code could read `E2B_API_KEY` out of the hub process. Do **not** add that key to the running service or set `E2B_ENABLE_UNSAFE_SHARED_UID_PILOT=true` until control + tenant run under different OS identities (or E2B sits behind a privileged local broker).
- **`PORIO_ENABLE_SAFE_PUBLIC_DEMO_AGENT_SESSIONS` stays `false`** until the public-demo agent has tenant-inaccessible auth + control-plane creds + an OS-identity boundary. It is independent of the shared-uid pilot; enabling the unsafe pilot never satisfies it. While false, public-demo agent mutations and the runtime-capabilities endpoint fail closed.
- Worker callbacks from an E2B sandbox use separate `usage`/`repository` HMAC capabilities bound to the exact sandbox ID + current D1 placement + capability epoch — never `VPS_HUB_TOKEN`. Moving/reprovisioning an app revokes the old sandbox tokens. Destructive repo cleanup + manual D1 backups remain gateway-only.

## Current state & known gaps (2026-07-20)

- Hub daemon + Caddy healthy; `*.porio.site` preview + publish loop and repo-per-app rollout are **live in prod** (two prod bugs from the rollout were fixed + verified 2026-07-19, commit 97cd8c0 — see memory `template-e2b-qa-findings-2026-07-18`).
- E2B stays fail-closed for prospect provisioning (shared-uid) — see the boundary above. Before a prospect pilot, `hub/README.md` lists the brokers still owed: agent auth, CF publish / remote-D1, external GitHub push, control-process supervision under a tenant-inaccessible uid, a vendor-inventory reconciler for the lost-create-response window, and a durable operation sweeper/cancel path.

## Related

- Repo daemon reference: `hub/README.md`. Memories: `vps-disk-and-session-topology`, `template-e2b-qa-findings-2026-07-18`. Skills: `doppler` (the shared token), `admin-qa` (QA `/admin/vps` + prod hub state), `app-remote` / `porio-edit` (drive app source through the hub).
