# Artifacts server

One local server for every code path, write-up and page agents make: <http://localhost:4620>.
It replaces Claude Artifacts for anything that doesn't need to be shared. Pages are stored in
one SQLite file (`~/.local/share/artifacts/artifacts.db`), render in milliseconds, and reload
themselves when an agent updates them.

- **Home** lists recent pages, newest first, grouped by day. Filter by kind or tag, or search
  titles, tickets, branches and source: `/` focuses the search box and the list filters as you type.
- **Each page** (`/a/<slug>/`) has a context bar showing where it was written: the checkout, branch,
  SHA (marked dirty if the tree was), ticket, herdr tab, and the agent session. Clicking the
  session chip copies a `claude --resume` command. Earlier versions stay at `/a/<slug>/r/<n>/`, and
  the source is at `/a/<slug>/source`.

## Use

```bash
artifacts up                          # start it in the herdr `servers` workspace if it's down
artifacts add spec.json               # detailed code path (the code-path skill's JSON spec)
artifacts add notes.md                # markdown: mermaid, tables, click-to-copy path:line
artifacts add report.html             # a page; full documents render in a frame
artifacts add spec.json --check       # print every highlighted line and value, save nothing
artifacts ls                          # recent pages
artifacts get <slug> > x.md           # pull the source back down to edit
artifacts rm <slug>
```

`add` prints the page URL. Useful flags:
- `--title`, `--summary` and `--question` (what was asked).
- `--slug` to write to a named page, `--new` to force a new page.
- `--cwd ~/src/repo.3` when you're writing about a checkout other than the one you're in.
- `--asset file` for extra files.

Re-adding the same file updates its page and keeps the old version. A temp file (scratchpad,
`/tmp`) only updates its page from the same agent session. Relative images in markdown or HTML
(`![](shots/a.png)`, `<img src="shots/a.png">`) are uploaded with the page, so they resolve.

## Keys

Every page has vim-style keys (turn Vimium off for `http://localhost:4620/*`). `?` lists them all.
- **Scroll:** `j`/`k` move 100px instantly, `d`/`u` half a page, `gg`/`G` go to the top or bottom,
  and `}`/`{` jump between sections, hops and days.
- **Index:** `j`/`k` move to the next or previous item instead of scrolling, and more rows load as
  you near the end (100 per fetch, also on mouse scroll). There `J`/`K` scroll 100px, and `gg`/`G`
  select the first or last loaded item.
- **Move between pages:** `h` goes back, or up a level. `l` goes forward: on the index it opens the
  selected item, and elsewhere it opens the next page.
  `[`/`]` step through the list you came from.
- **Find:** on a page, `/` searches its text as you type (a capital makes it case-sensitive), and
  opens any folded hop a match is in. Enter keeps the matches, `n`/`N` step through them, Esc
  clears them. `gi` goes to the index search from anywhere.
- **Link hints:** `f`, or `F` to open in a new tab.
- **Code paths:** `za`/`zR`/`zM` fold hops; `yl` copies the `path:line` at the top of the screen.
- **Copy:** `yy` the URL, `yr` the resume command, `ys` the slug.
- **Other:** `m`/`'` set and jump to marks, `t` cycles the theme, `r` reloads, and counts work
  (`5j`, `3n`).
The keys live in `src/keys.js`.

## Kinds

| Kind | From | Rendered |
| --- | --- | --- |
| `code-path` | `.json` spec, same format as `~/.claude/skills/code-path/scripts/detailed_code_path.py` | one accordion per hop, pulled with `git show <sha>:<path>`. Highlighted lines, a GitHub permalink when the commit is on `origin/main` or its branch's remote, a click-to-copy `path:line`, In/Out panels from inlined captures. |
| `md` | `.md` | markdown with mermaid. Every `path/to/file.ts:123` copies itself when clicked. |
| `html` | `.html` | as sent. A full document gets a frame, a fragment is shown inline. |

A spec side may leave out `checkout` and `ref`. They default to the checkout `add` ran in and its HEAD.

## Run

Every code block on every page (markdown, HTML fragments, full HTML documents in their frame, a
code path's source) has a copy button. Shell blocks also get ▶, which runs the block **on this
machine**, in the page's directory (the checkout `add` ran in, or `--cwd`), and streams stdout and
stderr in underneath with the exit code and time. ▶ again while it runs stops it, killing its
whole process group; so does leaving the page. So write pages with commands to press: the query
that shows the row, the curl that hits the endpoint, the test that proves the fix.

It's HTML, so mark blocks however you write them:

```html
<pre><code class="language-bash">psql "$DATABASE_URL" -c 'select 1'</code></pre>   <!-- bash, sh, shell or zsh: runnable -->
<pre data-run>pnpm test src/lib/tax.test.ts</pre>                                <!-- anything else, run with bash -->
<pre data-run data-cwd="apps/web">ls</pre>          <!-- where: absolute, ~/…, or relative to the page's directory -->
<pre data-run data-shell="zsh">print -l $path</pre> <!-- zsh instead of bash -->
<pre data-norun><code class="language-bash">rm -rf build</code></pre>       <!-- copy only -->
```

In markdown, a ` ```bash ` fence renders to the first form. A code path takes a `run` field on the
spec (shown under the intro) or on any hop (shown under its source; it runs in that side's
`checkout`): a string, `{"code", "title", "cwd", "shell"}`, or a list of them. `--check` prints
each one with the directory it will run in.

Blocks run with `bash -c` (or `zsh -c`), no rc files, so aliases and shell functions aren't there;
everything on the server's PATH is. No TTY: stdin is closed, `PAGER`/`GIT_PAGER` are `cat`,
`NO_COLOR=1`, and `$ARTIFACTS_SLUG` names the page. Each run is logged in the server's pane.
`POST /api/run` only answers this server's own pages: the Host and Origin must both be
`localhost:4620` or `127.0.0.1:4620`, so another site (or a DNS-rebinding one) can't run anything.

## Build and run

```bash
cd ~/.dotfiles/artifacts && cargo build --release
ln -sf ~/.dotfiles/artifacts/target/release/artifacts ~/.local/bin/artifacts
```

It runs in herdr `servers`, tab `artifacts :4620`. After a rebuild, close that tab and run
`artifacts up`. It binds 127.0.0.1 only.

## App

`app/` is a native window for the same server, built on GPUI: the page list (search, kind and
tag filters, grouped by day) on the left, and pages in tabs on the right, each tab a WebKit view
showing its page exactly as a browser does. It follows the server live, so new pages appear as
agents add them. Install it with `app/bundle.sh` (builds and writes
`~/Applications/Artifacts.app`); Option-A toggles it (Hammerspoon). Closing the window quits it.

The list has a cursor of its own: moving it (`j` `k`, with vim counts like `10j` against the
relative line numbers in its gutter) doesn't touch the page until `l` or `Enter` opens it in the
active tab. A click opens a page too, and ⌘-click or `⌘L` (on the row under the mouse, else the
cursor's) opens it in a new tab. Dots mark pages open in tabs: bright for the active one. Each
tab keeps its own scroll and history. The sidebar's edge drags (220–640px), and `⌘B` hides or
shows it. While it's hidden, sending the keyboard into it (`⌘T`, `⌘/`, `h`) shows it until the
keyboard is back on the page. Inside the app, pages drop their own header. Links that ask for a
new window open a new tab. The open tabs, the zoom and the sidebar (its width and whether it's
hidden) come back on the next launch (`~/.local/share/artifacts/app.json`).

`⌘T` (or `⌘N`, or the `+` button) starts a new tab by searching for its page: the search box
takes the keyboard, reads NEW TAB, and has its text selected, so typing starts a new search.
`ctrl-j` `ctrl-k` move through the results without touching the open tab; `Enter` (or a click)
opens the page in a new tab and clears the search, and `Esc` cancels and puts the keyboard back
where it was.

The **code panel** (`⌘J`, on the right) shows the file behind a page's `path:line`: in the app, a
click on one opens the whole file there, syntax-highlighted and read-only, at that line (in a
browser the click still copies). Pages keep the path as written but carry the absolute one in
`data-path` (resolved against the checkout they were written in, `data-root` on `<body>`), and the
file is read fresh on every click, so it shows the checkout as it is now. The line itself is
filled, and the panel's one editor is warmed up at launch so the first file opens quickly.

`c` (on a page, or in the app's list) opens a prompt in the middle of the page: `Enter` starts
`claude` on it in a new herdr tab (unfocused), in the checkout the page was written in and the
workspace it was written from (else the focused one). `Shift-Enter` adds a line, `Esc` cancels.

The keyboard is in one of three places, and a ring shows which: the **list**, its **search box**,
or the **page** (and the code panel, once you click into it).

| Where | Keys |
| --- | --- |
| Anywhere | `⌘B` hide / show the sidebar · `⌘J` hide / show the code panel · `⌘/` search pages · `⌘F` find in page · `⌘L` open the hovered (else cursor's) page in a new tab · `⌘[` `⌘]` back / forward · `⌘=` `⌘-` `⌘0` zoom · `⌘R` reload · `⌘O` open in browser · `⌘H` hide |
| Tabs, anywhere | `⌘T` `⌘N` new · `⌘W` close (the last one hides the app) · `⌘⇧T` reopen · `⌘⌥W` close the others · `⌘⇧[` `⌘⇧]` or `⌃⇧Tab` `⌃Tab` previous / next · `⌘1`–`⌘8` that tab · `⌘9` the last · `⌃⇧PgUp` `⌃⇧PgDn` move |
| List | `j` `k` move the cursor (`10j`, `15k`) · `gg` `G` first / last (`5G` the fifth) · `l` `→` `Enter` `Tab` open it and read · `Esc` back to the page · `/` search pages · `H` `L` previous / next tag · `c` ask Claude about the open page · `o` open in browser |
| Tabs, from the list or the page | `H` `L` previous / next (in the page) · `x` `X` close / reopen · `^` the last-used tab · `<` `>` move · `t` (list) or `yt` (page) duplicate |
| Search pages | type to filter · `ctrl-j` `ctrl-k` move the cursor as you type · `Enter` open it · `Esc` back to the list |
| Page | the page's own keys (`?` lists them) · `h` or `Esc` back to the list · `[` `]` previous / next page in the list · `/` find in page |

**Search pages** (`/` from the list, `⌘/` from anywhere) filters the list across every page:
titles, tickets, branches, source. **Find in page** (`/` in the page, or `⌘F`) searches the open
page's text. GitHub, Linear and `zed://` links open in their own apps.

## Config

All optional, read from the environment:

| Variable | Default | What |
| --- | --- | --- |
| `ARTIFACTS_PORT` / `--port` | `4620` | server port |
| `ARTIFACTS_DB` / `--db` | `~/.local/share/artifacts/artifacts.db` | the SQLite store (`$XDG_DATA_HOME` if set) |
| `ARTIFACTS_URL` | `http://localhost:4620` | where the CLI sends pages |
| `ARTIFACTS_TICKET_URL` | unset | links the ticket chip, e.g. `https://linear.app/<workspace>/issue/{ticket}` |

The ticket is read from the branch name (`me/abc-123-fix-login` → `ABC-123`). Without
`ARTIFACTS_TICKET_URL` it shows as plain text. Branch and SHA chips link to GitHub when `origin`
is a GitHub remote.

## Tags

Tags group pages by where they were written, and they're this machine's own: rules live in the
SQLite store, not in config files. A page carries every tag whose glob matches its checkout (the
repo root, else the directory `add` ran in). There are none until you add some, and changing a
rule retags old pages too.

```bash
artifacts tag add work ~/src/app*        # `*` matches anything, so worktrees like app.2 count
artifacts tag add s2 ~/src/app.2         # or one tag per worktree
artifacts tag                             # list the rules
artifacts tag rm s2                       # drop a tag (or `rm <tag> <glob>` for one rule)
```

The index and the app filter by tag (`?tag=`, `artifacts ls --tag`); in the app, `H` `L` on the
list step through them.
