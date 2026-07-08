---
name: helium-cdp
description: Drive the user's already-running Helium browser (a Chromium 150 fork) over the Chrome DevTools Protocol — with all their live logins intact (Cloudflare dashboard, Google Cloud console, registrar panels, Porio app, etc). Use when a task needs to read or act inside an authenticated web dashboard the user is already signed into and no API token exists or the token lacks scope: completing a Cloudflare DNS/Workers/for-SaaS setup, reading a Google OAuth client config, checking a registrar's domain panel, or any "continue the browser stuff / do it in my browser / look at the Cloudflare dashboard" request. Prefer this over agent-browser when the value is the user's EXISTING session (agent-browser launches its own fresh, logged-out Chrome). Triggers: "in my browser", "the Cloudflare dashboard", "helium", "CDP", "remote debugging", "continue the domain/cloudflare stuff".
allowed-tools: Bash, Read
---

# helium-cdp

Connect to the user's running **Helium** browser (imput.co's Chromium 150 fork)
over CDP and drive it with `puppeteer-core`. Because you attach to the *existing*
browser, every logged-in session is available — this is the tool when the task is
"finish the thing in my Cloudflare / Google / registrar dashboard".

## Prerequisite: remote debugging must be ON (user does this once)

Helium ships CDP off. The user enables it at **`helium://inspect/#remote-debugging`**
→ check *"Allow remote debugging for this browser instance"*. The page then shows
`Server running at: 127.0.0.1:9222`. If a connect attempt fails with
`Could not connect`, ask the user to confirm that toggle is on (screenshot in
`references/` shows the page). It survives across tabs but resets per browser launch.

## The gotcha: legacy `/json` discovery is DEAD in Chromium 150

Do **NOT** try `curl http://127.0.0.1:9222/json/version` — it returns **404** for
every `/json*` and `/devtools/browser` path (Chromium 150 hardening; the toggle is
built for `chrome-devtools-mcp`, which reads the port file instead). So you can't
discover the WebSocket URL over HTTP. Instead read it from the **`DevToolsActivePort`**
file in Helium's user-data-dir:

```
~/Library/Application Support/net.imput.helium/DevToolsActivePort
```

Two lines: `9222` and `/devtools/browser/<guid>`. The browser WS endpoint is
`ws://127.0.0.1:<line1><line2>`. puppeteer-core's `connect({ browserWSEndpoint })`
attaches to it directly (skip `browserURL` — that path hits the dead `/json/version`).

## Usage — the bundled driver

`scripts/helium-cdp.mjs` does the port-file read + connect for you. Run with plain
`node` (it auto-discovers `puppeteer-core`; installed at
`~/porio/vibesdk/node_modules/puppeteer-core`, else set `PUPPETEER_CORE`):

```bash
S=~/.claude/skills/helium-cdp/scripts/helium-cdp.mjs
node $S list                                  # every tab: title | url
node $S shot <url-substr> [out.png]           # screenshot the first tab whose URL matches
node $S eval <url-substr> "<js expr>"         # run JS in that tab, print JSON result
node $S goto <url-substr|any> <url>           # navigate a tab (any = first tab)
node $S newtab <url>                          # open a new tab
node $S click <url-substr> "<css-selector>"   # click first match (or use eval for text-matching)
node $S type  <url-substr> "<css>" "<text>"   # focus + type into an input
node $S waitfor <url-substr> "<css>" [ms]     # wait for a selector
```

Match tabs by a stable URL substring (e.g. `porio.ai/dns/records`,
`custom-hostnames`, `console.cloud.google`). Screenshot into your scratchpad and
`Read` the PNG to see state. Coordinates in Read's image note are retina (×dpr);
puppeteer mouse/`page` coords are CSS pixels (≈ the "displayed at NxN" numbers), so
prefer selector/`eval`-driven clicks over pixel math.

## Reading dashboards reliably

Dashboards are SPA-heavy. Prefer `eval` to extract text/state over screenshotting
+ OCR when you need exact values:

```bash
node $S eval "porio.ai/dns/records" "[...document.querySelectorAll('table tr')].map(r=>r.innerText).join('\n')"
```

To expand a row / open a menu, `eval` a click by matching visible text rather than
brittle nth-child selectors:

```bash
node $S eval "custom-hostnames" "[...document.querySelectorAll('button,a,[role=button]')].find(e=>e.textContent.trim()==='Edit')?.click() ?? 'no match'"
```

## Safety — this is the user's real browser

You are driving a live, fully-authenticated session. Reads/screenshots are free.
Before anything **consequential or hard to reverse** — changing production DNS,
deleting records, cutting a live domain over, submitting billing/registrar forms,
revoking OAuth clients — screenshot the target state, state exactly what you'll
change, and get the user's OK first. Approval for one change is not a standing
approval for the next. Never touch tabs unrelated to the task.

## When NOT to use this

- A scoped API/CLI exists and works (Cloudflare API token, `wrangler`, `gh`, `li`).
  Prefer it — it's auditable and doesn't depend on a browser being open. Reach for
  helium-cdp when the token is missing/expired or lacks the needed scope (the
  wrangler OAuth token, for instance, has only `zone:read` — no DNS-records read).
- You need a clean, logged-out browser or parallel isolated sessions → use
  `agent-browser` instead (it launches its own Chrome).
