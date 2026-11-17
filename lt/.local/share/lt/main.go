// lt — linear tickets. Your open Linear issues in one terminal list, for going through them
// fast: change status (c), priority (p) or assignee (A) on one issue, a count, a visual range
// or every marked issue; delete (x ; dd) to Linear's trash; rename (r), create (n); `u` undoes.
// Tab switches between your issues, the ones you created, and each of your teams.
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

const help = `lt — linear tickets: your open Linear issues; triage them fast

usage:
  lt                   your issues (assigned to you, not done or canceled)
  lt created           the ones you created
  lt KEY               a team's (lt ENG)
  lt ls [scope]        print identifier<TAB>status<TAB>title<TAB>url

move:
  j k  ↓ ↑             next / previous (5j, 3k: counts, by the relative numbers)
  ^d ^u                half a page down / up
  gg G  12G            first / last / issue 12
  ⇥ ⇧⇥                 next / previous scope: mine, created, each team

change (the issue, a count from it, the visual range, or every marked issue):
  c                    status: 0-9 picks (triage 0, backlog 1, todo 2, …), j/k ⏎
  ^1 ^2 ^3             status at once, in every team: done / in progress / todo
  ^4-^7 ^0             in review, backlog, canceled, duplicate; triage
  p                    priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low
  A                    assignee: 0 nobody, 1 me, or type a name
  x ; dd               delete (Linear's trash; 3x: three)
  r                    rename (the issue's title, typed below)
  n                    new issue in this issue's team and status
  u                    undo the last change, delete or create (again: the one before)

select:
  space m              mark / unmark, then move down
  v                    visual: j/k stretch a range; c p A d act on it, space marks it
  *                    mark every issue in this status
  a                    mark everything shown (after / : every match)

view:
  ⏎                    details: the description under the list (J K scroll it)
  /                    filter by id, title, status, project, label, assignee
  s                    order: status → priority → least recently updated → project
  o gx                 open in Linear
  y Y B                copy the id / URL / git branch name
  R                    reload (issues you changed that left the list go too)
  ?                    these keys
  esc                  leave visual / clear marks / drop the filter / close details / quit
  q                    quit

options:
  -h, --help

Needs $LINEAR_API_KEY (a personal API key). Lists are cached in ~/.cache/lt so lt opens at
once and refreshes behind; the list re-reads every 45s.
`

func main() { os.Exit(run(os.Args[1:])) }

func run(args []string) int {
	ls := false
	want := ""
	snapW, snapH := 0, 0
	keys := ""
	for i := 0; i < len(args); i++ {
		switch a := args[i]; a {
		case "-h", "--help", "help":
			fmt.Print(help)
			return 0
		case "ls":
			ls = true
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
				fmt.Fprintln(os.Stderr, "lt: --snapshot needs WxH")
				return 2
			}
		// Hidden, with --snapshot: keys to press first (`jj v j`, `<esc>`, `<c-d>`). Nothing is
		// changed in Linear.
		case "--keys":
			if i++; i < len(args) {
				keys = args[i]
			}
		default:
			if strings.HasPrefix(a, "-") || want != "" {
				fmt.Fprintf(os.Stderr, "lt: unknown argument %s (lt -h)\n", a)
				return 2
			}
			want = a
		}
	}
	c, err := newClient()
	if err != nil {
		fmt.Fprintln(os.Stderr, "lt:", err)
		return 1
	}
	var mt meta
	if !readCache("meta", &mt) || mt.Viewer.ID == "" {
		if mt, err = c.meta(); err != nil {
			fmt.Fprintln(os.Stderr, "lt:", err)
			return 1
		}
		writeCache("meta", mt)
	}
	key, ok := scopeKey(mt, want)
	if !ok {
		var names []string
		for _, s := range mt.scopes() {
			names = append(names, strings.TrimPrefix(s.key(), "team-"))
		}
		fmt.Fprintf(os.Stderr, "lt: no scope %q (try: %s)\n", want, strings.Join(names, ", "))
		return 2
	}
	m := newModel(c, mt, key)
	if ls {
		is, err := c.issues(m.scope())
		if err != nil {
			fmt.Fprintln(os.Stderr, "lt:", err)
			return 1
		}
		writeCache("scope-"+key, is)
		m.all = is
		m.setView("")
		printList(m)
		return 0
	}
	var cached []issue
	if readCache("scope-"+key, &cached) {
		m.all, m.stale = cached, true
	} else if snapW > 0 {
		if m.all, err = c.issues(m.scope()); err != nil {
			fmt.Fprintln(os.Stderr, "lt:", err)
			return 1
		}
	}
	m.setView("")
	if snapW > 0 {
		fmt.Print(snapshotFrame(m, snapW, snapH, parseKeys(keys)))
		return 0
	}
	if _, err := tea.NewProgram(m).Run(); err != nil {
		fmt.Fprintln(os.Stderr, "lt:", err)
		return 1
	}
	return 0
}

// scopeKey resolves `lt created`, `lt ENG`: "" is your issues.
func scopeKey(mt meta, want string) (string, bool) {
	w := strings.ToLower(want)
	switch w {
	case "", "mine", "me", "my":
		return "mine", true
	case "created", "c":
		return "created", true
	}
	for _, s := range mt.scopes() {
		if s.Kind == scopeTeam && strings.ToLower(s.Team.Key) == w {
			return s.key(), true
		}
	}
	return "", false
}

// printList is `lt ls`, in the list's order.
func printList(m *model) {
	out := bufio.NewWriter(os.Stdout)
	for k := range m.view {
		i := m.issue(k)
		// A closed pipe (`lt ls | head`) is fine.
		if _, err := fmt.Fprintf(out, "%s\t%s\t%s\t%s\n", i.Identifier, i.State.Name, oneLine(i.Title), i.URL); err != nil {
			return
		}
	}
	_ = out.Flush()
}

// snapshotFrame presses keys with nothing sent to Linear, then draws one frame as text.
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

// parseKeys turns `jj v j<esc>` into key presses: `<esc> <cr> <bs> <tab> <s-tab> <up> <down>
// <space> <c-x>`; anything else is itself.
func parseKeys(s string) []tea.KeyPressMsg {
	var out []tea.KeyPressMsg
	named := map[string]tea.Key{
		"esc": {Code: tea.KeyEscape}, "cr": {Code: tea.KeyEnter}, "bs": {Code: tea.KeyBackspace},
		"tab": {Code: tea.KeyTab}, "s-tab": {Code: tea.KeyTab, Mod: tea.ModShift},
		"up": {Code: tea.KeyUp}, "down": {Code: tea.KeyDown}, "space": {Code: tea.KeySpace, Text: " "},
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
