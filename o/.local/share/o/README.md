# o (Go)

`o` is a prompt for starting agents in new Rex tabs. It keeps drafts and images
locally in `$XDG_STATE_HOME/o` (default `~/.local/state/o`). Drafts use the same
JSON format as the previous Rust version. There is no network draft storage,
account pairing, or background uploader.

`stow o` installs the launcher, Go source, and config. Go 1.24 or newer must be on
`PATH`. The launcher builds on first run and after source changes, caching the
binary in `$XDG_CACHE_HOME/o-public/o` (default `~/.cache/o-public/o`).
`o --help` lists the keys; `o --config` shows the agents and local draft path.

The checked-in config and built-in defaults contain exactly these shortcuts:

| Shortcut | Agent | Reasoning |
| --- | --- | --- |
| Ctrl+1 | `claude(opus)` | Claude default |
| Ctrl+2 | `claude(fable)` | Claude default |
| Ctrl+3 | `codex(sol)` (`gpt-6.2-sol`) | xhigh |
| Ctrl+4 | `codex(astra)` (`gpt-6.2-astra`) | max |

Codex uses `--yolo`, with normal and plan-mode effort both pinned. Shift+Tab
cycles through the four agents. Claude profiles remain available with Ctrl+N.

Up on an empty prompt selects a previous send. Enter focuses its tab; `e`
restores its full prompt, images, configuration, and plan mode for editing and
sending to a new agent. This also works for drafts sent together and replies.

An existing installation from another dotfiles checkout can stay installed.
Working on this package does not require restowing it or replacing those links.
To try the public version directly without changing installed links:

```sh
O_HOME="$PWD/o/.local/share/o" \
  XDG_CONFIG_HOME="$PWD/o/.config" ./o/.local/bin/o --config
```

## Long pastes

As in Claude Code, a paste over 800 characters, or with more than two line
breaks (fewer in a terminal under 13 rows), goes in as one tag:
`[Pasted text #1 +187 lines]` (`[Pasted text #1]` for a single long line). The
number counts with `[Image #N]` tags. Backspace deletes the whole tag, and the
cursor never lands inside it. The send has the pasted text back in place of its
tag. Ctrl+C, Ctrl+X and Alt+C copy the text too.

The text is kept in `$XDG_STATE_HOME/o/pastes` until it is sent, and up to a
month after that for ↑ history. A draft keeps its own copy beside its images.
A prompt whose pasted text has gone isn't sent. `/save` writes the pasted text
into the preset.

## Slash presets

Presets work with every agent. In the composer, enter:

```text
/save review Review the changes for correctness, regressions, and missing tests.
```

Enter saves `.o/commands/review.md` in the working directory and clears the
composer. Shift+Enter, Alt+Enter, or Ctrl+J adds lines. `/save NAME PROMPT`
replaces an existing local preset. Files are plain UTF-8 Markdown, up to 1 MiB;
edit or delete them with any editor.

Type `/` to browse saved prompts and a prefix to filter. Up/Down chooses, Tab or
Enter expands into editable text, and Esc closes the picker. `/review TASK`
expands the preset, a blank line, and TASK. Enter again sends to the agent.
Ctrl+Z restores the invocation. Expansion preserves attachments and happens once.

`/edit review` loads `/save review` followed by its text. Change it and press
Enter to save locally. Management commands never start an agent; image tags
must be removed before saving a preset.

Each directory inherits `.o/commands/*.md` from its ancestors; the nearest
definition wins. Saving or editing writes in the current directory, so editing
an inherited preset creates a local override. Drafts resolve presets against
their own folder and open unexpanded presets for review before sending. Expand
presets before combining marked drafts.

Names are 1–64 lowercase letters/digits, with hyphens and underscores allowed
after the first character. `save` and `edit` are reserved. Unknown commands pass
through to the agent; `//review` sends literal `/review`.

No preset files are created until you save one. Presets belong to their directory
and are independent of drafts and the agents' own commands.

## Drafts

Ctrl+S saves the prompt as a local draft and clears the composer for the next
prompt. Ctrl+G opens this session's drafts; `e` edits the selected draft, which
saves as you type (the prompt reads ◇). Ctrl+S saves and leaves that draft, as
Esc does, returning to the list or the prompt set aside for it. Enter sends the
draft and removes it. If saving fails, Ctrl+S keeps the input and shows the error.

## Checks

```sh
cd o/.local/share/o
go test ./...
go vet ./...
CGO_ENABLED=0 GOOS=linux go build -o /dev/null .
```

`o --snapshot WxH --keys '…'` renders frames as text without a terminal or sending
to an agent. Set `XDG_CONFIG_HOME` and `XDG_STATE_HOME` to temporary directories
when checking behavior without using your installed configuration or state.
