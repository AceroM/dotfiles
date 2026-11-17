// ct — chrome tabs. Every browser tab in one list, by title and URL, for deciding what stays
// and closing the rest fast. `;` closes the tab under the cursor, or every marked tab, or a
// visual range. Marks come from space, `*` (same site), `D` (duplicates) and `a` (whatever a
// `/` filter shows). `u` reopens what was closed. ⏎ shows the tab in the browser. No preview
// (ctab does that).
package main

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

const help = `ct — chrome tabs: every browser tab by title and URL; close what you don't need

usage:
  ct                   open the list
  ct ls                print every tab as title<TAB>url, in tab-strip order

move:
  j k  ↓ ↑             next / previous (5j, 3k: counts, by the relative numbers)
  ^d ^u                half a page down / up
  g G  12G             first / last / tab 12
  ⏎                    show the tab in the browser (ct stays open)

close:
  ; x                  close the tab (5x: five), or every marked tab, or the visual range
  space m              mark / unmark, then move down
  v                    visual: j/k stretch a range; ; closes it, space marks it
  *                    mark every tab on this site
  D                    mark duplicates (keeps the copy you used last)
  a                    mark everything shown (after / : every match)
  u                    reopen what the last close closed (again: the one before)

view:
  /                    filter by title and URL (⏎ keeps it, esc drops it)
  s                    order: tab strip → by site → least recently used
  ?                    these keys
  esc                  leave visual / clear marks / drop the filter / quit
  q                    quit

options:
  --browser NAME       pick a connected browser when several are (also $BROWSER_USE_BROWSER)
  -h, --help

Talks to the browser-use extension (` + "`browser-use status`" + `), like ctab and tg.
`

func main() { os.Exit(run(os.Args[1:])) }

func run(args []string) int {
	browserName := os.Getenv("BROWSER_USE_BROWSER")
	ls := false
	snapW, snapH := 0, 0
	keys := ""
	for i := 0; i < len(args); i++ {
		switch a := args[i]; a {
		case "-h", "--help":
			fmt.Print(help)
			return 0
		case "ls":
			ls = true
		case "--browser":
			if i++; i >= len(args) {
				fmt.Fprintln(os.Stderr, "ct: --browser needs a name")
				return 2
			}
			browserName = args[i]
		// Hidden: render one frame as plain text, for UI work without a terminal.
		case "--snapshot":
			ok := false
			if i++; i < len(args) {
				w, h, found := strings.Cut(args[i], "x")
				var e1, e2 error
				snapW, e1 = strconv.Atoi(w)
				snapH, e2 = strconv.Atoi(h)
				ok = found && e1 == nil && e2 == nil && snapW > 0 && snapH > 0
			}
			if !ok {
				fmt.Fprintln(os.Stderr, "ct: --snapshot needs WxH")
				return 2
			}
		// Hidden, with --snapshot: keys to press first (`jj v j`, `<esc>`, `<c-d>`). Nothing is
		// closed or reopened.
		case "--keys":
			if i++; i < len(args) {
				keys = args[i]
			}
		default:
			fmt.Fprintf(os.Stderr, "ct: unknown argument %s (ct -h)\n", a)
			return 2
		}
	}
	h, err := pickHost(browserName)
	if err != nil {
		fmt.Fprintln(os.Stderr, "ct:", err)
		return 1
	}
	snap, err := h.list()
	if err != nil {
		fmt.Fprintln(os.Stderr, "ct:", err)
		return 1
	}
	if ls {
		printList(snap)
		return 0
	}
	m := newModel(h, snap)
	if snapW > 0 {
		fmt.Print(snapshotFrame(m, snapW, snapH, parseKeys(keys)))
		return 0
	}
	if _, err := tea.NewProgram(m).Run(); err != nil {
		fmt.Fprintln(os.Stderr, "ct:", err)
		return 1
	}
	return 0
}

// printList is `ct ls`: title<TAB>url per tab, for grep and friends.
func printList(s snapshot) {
	out := bufio.NewWriter(os.Stdout)
	for _, t := range s.Tabs {
		// A closed pipe (`ct ls | head`) is fine.
		if _, err := fmt.Fprintf(out, "%s\t%s\n", t.displayTitle(), t.URL); err != nil {
			return
		}
	}
	_ = out.Flush()
}

// snapshotFrame presses keys with nothing sent to the browser, then draws one frame as text.
func snapshotFrame(m *model, w, h int, keys []tea.KeyPressMsg) string {
	m.live = false
	m.Update(tea.WindowSizeMsg{Width: w, Height: h})
	for _, k := range keys {
		if m.Update(k); m.quitting {
			break
		}
	}
	var b strings.Builder
	for _, l := range strings.Split(ansi.Strip(m.render()), "\n") {
		b.WriteString(strings.TrimRight(l, " ") + "\n")
	}
	return b.String()
}

// parseKeys turns `jj v j<esc>` into key presses: `<esc> <cr> <bs> <tab> <up> <down> <space>
// <c-x>`; anything else is itself.
func parseKeys(s string) []tea.KeyPressMsg {
	var out []tea.KeyPressMsg
	named := map[string]tea.Key{
		"esc": {Code: tea.KeyEscape}, "cr": {Code: tea.KeyEnter}, "bs": {Code: tea.KeyBackspace},
		"tab": {Code: tea.KeyTab}, "up": {Code: tea.KeyUp}, "down": {Code: tea.KeyDown},
		"space": {Code: tea.KeySpace, Text: " "},
	}
	for s != "" {
		if s[0] == '<' {
			if end := strings.IndexByte(s, '>'); end > 0 {
				name := s[1:end]
				k, ok := named[name]
				if c, isCtrl := strings.CutPrefix(name, "c-"); isCtrl && len([]rune(c)) == 1 {
					k, ok = tea.Key{Code: []rune(c)[0], Mod: tea.ModCtrl}, true
				}
				if ok {
					out = append(out, tea.KeyPressMsg(k))
					s = s[end+1:]
					continue
				}
			}
		}
		r := []rune(s)[0]
		out = append(out, tea.KeyPressMsg(tea.Key{Code: r, Text: string(r)}))
		s = s[len(string(r)):]
	}
	return out
}
