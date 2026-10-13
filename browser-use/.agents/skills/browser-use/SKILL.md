---
name: browser-use
description: Drive the user's own, already-running browser (their Chrome window, with their logins) through the shared "Agents" tab group via the local `browser-use` CLI — open tabs, snapshot elements, click/type/fill, screenshot, read console + network, run JS. TRIGGER on phrasing that names the user's browser - "use my browser", "open the browser", "in my browser", "open it in the browser", "pull it up in the browser", "show me in the browser", "check it in the browser", "browser-use". Works the same from Claude Code and Codex, and every agent session (any herdr pane) sees the same Agents tabs, so agents can hand tabs to each other. Distinct from /chrome (claude-in-chrome), /cd (chrome-devtools MCP) and agent-browser (headless) - use those only when the user names them.
argument-hint: "[url | what to do] — optional"
allowed-tools: Bash, Read
---

# browser-use

`browser-use` is a CLI that talks to a small extension in the user's browser through a native
messaging host — no account, no cloud, no MCP server. Agent tabs live in one tab group titled
**Agents**, shared by every Claude/Codex session and the human.

## Reuse the existing browser setup

This drives the same browser you already use: same window, same logins. Don't launch another
browser or profile. If the project you're in has browser-testing instructions (test accounts,
impersonation, read-only rules for production, where screenshots go), follow them. Only the
driver changes: wherever they mention chrome-devtools MCP, claude-in-chrome or agent-browser,
use `browser-use`.

## First: is it connected?

```bash
browser-use status
```

- `connected` → go.
- `no browser connected` → the extension isn't loaded/enabled. Tell the user to run
  `browser-use install` (once per machine) and load the unpacked extension it prints
  (`chrome://extensions` → Developer mode → Load unpacked). Don't try to work around it.
- Several browsers connected → add `--browser chrome|helium` (or export `BROWSER_USE_BROWSER`).

## The loop

```bash
browser-use open http://localhost:3000/login      # new Agents tab; becomes YOUR current tab
browser-use snap                                   # interactive elements with refs (e1, e2, …)
browser-use click e12                              # act by ref
browser-use fill e4 "you@example.com"
browser-use type "$PASSWORD" --into e7 --submit
browser-use wait --text "Dashboard"
browser-use shot                                   # prints a PNG path → Read it to see the page
```

- **Snapshot before acting**, and again after anything that changes the page. Refs are stamped
  into the DOM, so they survive across commands but not across reloads/navigations — a
  `target e12 not found` means take a fresh `snap`.
- `snap` is cheap and textual; prefer it over screenshots for deciding what to click. Use
  `shot` when layout/visuals matter or to show the user. Screenshot pixels = CSS pixels, so
  `click 640,312` hits exactly what you see in the image.
- Commands act on **your current tab** (the last one you opened/used). Pass `-t <id>` to act on
  another; `browser-use use -t <id>` switches. "Your" is keyed by herdr pane
  (`$HERDR_PANE_ID`), so parallel agents don't steal each other's current tab.

## Commands

| Need | Command |
| --- | --- |
| List Agents tabs (owner in brackets) | `browser-use tabs` · every tab: `tabs --all` |
| New tab / navigate | `open <url> [--bg]` · `nav <url\|back\|forward\|reload>` |
| Structure | `snap` · `snap --all` (incl. hidden) · `snap --ref e40` (subtree) · `--urls` (link hrefs) |
| Text | `text` (main/body) · `text "table.results"` |
| Screenshot | `shot [path] [--full] [--hires]` |
| Click / hover | `click <target> [--double] [--right]` · `hover <target>` |
| Type | `type "text" [--into <target>] [--clear] [--submit]` |
| Set a field directly | `fill <target> <value>` (input, textarea, select by value/label, checkbox `true/false`) |
| Keys | `key Enter` · `key cmd+a Backspace` · `key Tab --repeat 3` |
| Scroll | `scroll down\|up\|<px> [--at <target>]` |
| JS | `eval 'document.title'` · top-level `await` works · `eval - <<'EOF' … EOF` |
| Console | `console [--errors] [--grep re] [--clear]` |
| Network | `network [--grep trpc] [--failed] [--clear]` · body: `network --body <requestId>` |
| Wait | `wait 500` · `wait --for css` · `--text t` · `--gone css` · `--url substr` · `--timeout ms` |
| Dialogs | `dialog accept\|dismiss [--text answer]` |
| Viewport | `resize 390 844 --mobile` · `resize --reset` (emulated; doesn't move the window) |
| Tab handoff | `adopt -t <id>` (pull a human tab in) · `release` (give it back) · `focus` (show the human) · `close` |
| Add `--json` to any command for machine-readable output |

**Targets:** `e12` (ref from snap) · `text=Save changes` (visible text on a button/link/tab) ·
any CSS selector (`'#email'`, `'[data-testid=submit]'`) · `x,y` CSS-pixel coordinates.

`alert`/`confirm` dialogs generally don't block (Chrome auto-accepted `confirm` in testing), so
check the result after clicking anything that might ask "are you sure?". Never click
destructive buttons assuming a confirm will stop you.

Console and network capture start the first time any agent touches a tab; `nav reload` to
catch page-load traffic.

## Collaborating across agents

- `browser-use tabs` shows who owns each tab (`claude@w1:p3`, `codex@w2:p1`). **Don't drive
  another agent's tab** unless you were asked to pick it up — then `use -t <id>` and say so.
- To hand a tab to the user or another agent, just tell them its id; it stays in the group.
- Close tabs you opened when done (`browser-use close`), unless the user should look at them.
- The user can drag any tab into the Agents group to share it; `adopt -t <id>` does the same.

## Safety

This is the user's real, logged-in browser. Reading, snapshotting and screenshotting are free.
Anything that sends, buys, deletes, submits on someone's behalf, or mutates production data
needs the user's explicit go-ahead — the same rules as CLAUDE.md's production/impersonation
guidance. Only Agents-group tabs are drivable; never `adopt` a tab the user didn't point you to.

## Maintenance

Source: `~/.dotfiles/browser-use/.local/share/browser-use/` (stowed to `~/.local/share/browser-use`).
`extension/background.js` = the commands; `host.ts` = native relay; `cli.ts` = this CLI.
After editing the extension, `browser-use reload`. Host log: `~/.local/state/browser-use/host.log`.
