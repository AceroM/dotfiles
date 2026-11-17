# rt

A terminal tab browser for Rex. Install with `stow rt`.
The launcher builds on first use and after source changes (Go 1.26+).

Run `rt` in a Rex shell or press `;` in `jv`. The browser opens in your terminal,
with one row per tab across all sessions. Tabs use Rex's live pane activity to
group into Needs attention, Working, Done and Other tabs. Done shows the latest
finishes first. Shell and tool tabs stay in the list.

- `j` / `k`, arrows, counts (`5j`), `g` / `gg`, `G`, `12G`, Ctrl+D / Ctrl+U.
- `/` filters session names, tab names and pane titles/directories. Enter keeps the filter;
  Escape cancels editing. Enter in the list focuses the selected row's pane.
- `y` copies that pane's Rex block ID. `Y` copies the Claude Code or Codex
  session ID for the agent running there, using `rex-agent-id` from `stow cli`.
- `;` or `x` closes a tab. Space marks, `v` starts a visual range, `a` marks
  all matches; `;` closes the range or marked tabs. `5x` closes five tabs.
- Escape clears the visual range, marks, then filter; otherwise it quits.
  `q` quits immediately. `?` shows help.

The selected row shows the position used by `12G`. Other rows show their distance
from the cursor for `5j` and `3k`. The list refreshes once a second and preserves
selection by ID as activity changes. Closing ends every pane in the tab. The
hosting tab is excluded and checked again before closing.

`rt ls` prints position, ID, session, name and pane details as TSV in session and
tab-strip order. `rt ls --json` prints a JSON snapshot. `--current-session` limits
the list to one session. `--session ID` and `--client ID` choose explicit Rex targets.

Each row targets the pane whose activity it shows. For tabs without reported
activity, the row targets the tab's focused pane. Enter opens that pane in
Rex.app and dismisses the picker.
Rex requires **Settings → Rex Server → Remote Control** for app selection. If
disabled, the picker stays open and displays the app's error.

Validate with `cd rt/.local/share/rt && go test ./... && go vet ./...`.
