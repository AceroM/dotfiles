# rt

A Go tab picker for Rex. `stow rt rex`, then `rex config reload`.
The launcher builds on first use and after source changes (Go 1.26+).

`rt`, `rex do tabs`, or **Option+Cmd+;** opens a nearly full-window floating picker over the
invoking tab. **Cmd+R** renames the current Rex tab. `rt --inline` draws in
the current terminal; `jv` uses that for its `;` shortcut.

- `j` / `k`, arrows, counts (`5j`), `g` / `gg`, `G`, `12G`, Ctrl+D / Ctrl+U.
- `/` filters session names, tab names and pane titles/directories. Enter keeps the filter;
  Escape cancels editing. Enter in the list switches to the selected tab.
- `;` or `x` closes a tab. Space marks, `v` starts a visual range, `a` marks
  all matches; `;` closes the range or marked tabs. `5x` closes five tabs.
- Escape clears the visual range, marks, then filter; otherwise it quits.
  `q` quits immediately. `?` shows help.

Lists all other tabs across every session, including shells and tools, in
session and tab-strip order. The left numbers are relative movement counts; the right
numbers are list positions (`12G` selects tab 12). Refreshes once a second and
preserves selection by ID as tabs move. Closing ends every pane in the tab;
there is no undo. The hosting tab is excluded and checked again before closing.

`rt ls` prints position, ID, session, name and pane details as TSV. `rt ls --json`
prints a JSON snapshot. `--current-session` limits the list to one session.
`--session ID` and `--client ID` choose explicit Rex
targets. The borderless UI uses the terminal's background and ANSI palette,
so it follows the Rex theme and fits directly inside its floating pane.

Enter selects the actual session and tab in Rex.app before dismissing the picker.
Rex requires **Settings → Rex Server → Remote Control** for app selection. If
disabled, the picker stays open and displays the app's error.

Validate with `cd rt/.local/share/rt && go test ./... && go vet ./...`.
