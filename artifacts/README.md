# Artifacts server

One local server for every code path, write-up and page agents make: <http://localhost:4620>.
It replaces Claude Artifacts for anything that doesn't need to be shared. Pages are stored in
one SQLite file (`~/.local/share/artifacts/artifacts.db`), render in milliseconds, and reload
themselves when an agent updates them.

- **Home** lists recent pages, newest first, grouped by day. Filter by kind or slot, or search
  titles, tickets, branches and source: `/` focuses the search box and the list filters as you type.
- **Each page** (`/a/<slug>/`) has a context bar showing where it was written: the slot, branch,
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

## Build and run

```bash
cd ~/.dotfiles/artifacts && cargo build --release
ln -sf ~/.dotfiles/artifacts/target/release/artifacts ~/.local/bin/artifacts
```

It runs in herdr `servers`, tab `artifacts :4620`. After a rebuild, close that tab and run
`artifacts up`. It binds 127.0.0.1 only.

## Config

All optional, read from the environment:

| Variable | Default | What |
| --- | --- | --- |
| `ARTIFACTS_PORT` / `--port` | `4620` | server port |
| `ARTIFACTS_DB` / `--db` | `~/.local/share/artifacts/artifacts.db` | the SQLite store (`$XDG_DATA_HOME` if set) |
| `ARTIFACTS_URL` | `http://localhost:4620` | where the CLI sends pages |
| `ARTIFACTS_SLOT_REPO` | unset | worktree slots: a checkout named `<name>` is slot 1, `<name>.<N>` is slot N |
| `ARTIFACTS_TICKET_URL` | unset | links the ticket chip, e.g. `https://linear.app/<workspace>/issue/{ticket}` |

The ticket is read from the branch name (`me/abc-123-fix-login` → `ABC-123`). Without
`ARTIFACTS_TICKET_URL` it shows as plain text. Branch and SHA chips link to GitHub when `origin`
is a GitHub remote.
