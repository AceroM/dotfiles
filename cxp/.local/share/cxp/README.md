# cxp

`cxp` is a keyboard-first OpenTUI reader for local Codex and Claude JSONL chats.

```sh
stow cxp
cxp
cxp 01a067a2-3807-7571-97cb-b5dd4a13cab9
cxp claude:88ba459a
cxp ~/.claude/projects/example/session.jsonl
```

It requires Bun 1.3 or newer. The launcher installs its pinned production
dependencies on first use, so stowing the package is enough on a fresh machine.

It searches `~/.codex/sessions` and `~/.claude/projects` by default. Set
`CODEX_HOME` or `CLAUDE_CONFIG_DIR` to use another local data directory.
Injected `AGENTS.md` instruction and environment envelopes are omitted from
user turns; genuine tool calls that read those files remain in the transcript.

With no session argument, `cxp` lists local conversations from both providers,
sorted by JSONL modification time (newest first). Each row shows the title or
first user prompt, provider, project directory, timestamp, and session ID.
Use `j`/`k` or arrows to select, `d`/`u` to page, `g`/`G` for the ends,
`/` to filter, and Enter to open. Escape returns from the reader to the list
(after clearing any active search); `q` quits. `--provider claude` or
`--provider codex` limits the list. `cxp --plain` prints the list instead.

## Keys

| Key | Action |
| --- | --- |
| `j` / `k`, arrows | Scroll |
| `d` / `u`, Page Down / Up | Scroll half a page |
| `g` / `G` | Top / bottom |
| `/` | Search |
| `n` / `N` | Next / previous search result |
| `t` | Toggle detailed tool input and output |
| `r` | Toggle reasoning summaries |
| `s` | Toggle system and developer messages |
| `q` | Quit |

Use `--plain` to print a normalized transcript instead of opening the TUI. Output
also switches to plain mode automatically when stdout is redirected.
