package main

// Drawing: plain terminal lines, no box, like ct. A title line (scope, count, order; the
// scopes on the right), the list, then the picker or the detail pane when open, and a vim-style
// status line where `/`, titles and messages go. Colors are the terminal's own ANSI palette.

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

var (
	plain   = lipgloss.NewStyle()
	bold    = lipgloss.NewStyle().Bold(true)
	muted   = lipgloss.NewStyle().Foreground(lipgloss.Color("8"))
	accent  = lipgloss.NewStyle().Foreground(lipgloss.Color("6"))
	yellow  = lipgloss.NewStyle().Foreground(lipgloss.Color("3"))
	red     = lipgloss.NewStyle().Foreground(lipgloss.Color("1"))
	green   = lipgloss.NewStyle().Foreground(lipgloss.Color("2"))
	blue    = lipgloss.NewStyle().Foreground(lipgloss.Color("4"))
	magenta = lipgloss.NewStyle().Foreground(lipgloss.Color("5"))
)

// glyph is a state's icon, as Linear draws it: ◇ triage, ◌ backlog, ○ todo, ◐ in progress
// (◕ for a later started state, like review), ● done, ✕ canceled.
func (m *model) glyph(s state, teamID string) string {
	switch s.Type {
	case "triage":
		return magenta.Render("◇")
	case "backlog":
		return muted.Render("◌")
	case "unstarted":
		return plain.Render("○")
	case "started":
		if t, ok := m.meta.team(teamID); ok {
			for _, x := range t.States {
				if x.Type == "started" && x.Position < s.Position {
					return green.Render("◕")
				}
			}
		}
		return yellow.Render("◐")
	case "completed":
		return blue.Render("●")
	case "canceled", "duplicate":
		return muted.Render("✕")
	}
	return muted.Render("·")
}

func prioLabel(p int) string {
	switch p {
	case 1:
		return red.Bold(true).Render("urg")
	case 2:
		return yellow.Render("high")
	case 3:
		return plain.Render("med")
	case 4:
		return muted.Render("low")
	}
	return ""
}

func (m *model) View() tea.View {
	v := tea.NewView(m.render())
	v.AltScreen = true
	return v
}

func (m *model) render() string {
	w, h := m.width, m.height
	if w < 30 || h < 5 {
		return ansi.Truncate("lt · make the pane bigger · q quits", max(1, w), "")
	}
	listH, pickH, detailH := m.layout()
	lines := make([]string, 0, h)
	lines = append(lines, m.titleLine(w))
	lines = append(lines, m.list(w, listH)...)
	if pickH > 0 {
		lines = append(lines, m.pickerLines(w, pickH)...)
	}
	if detailH > 0 {
		lines = append(lines, m.detailLines(w, detailH)...)
	}
	if p := m.prompt; p != nil && p.kind == "comment" {
		switch {
		case p.posting:
			lines = append(lines, " "+yellow.Render("posting comment…"))
		case p.err != nil:
			lines = append(lines, " "+red.Render("couldn't post: "+oneLine(p.err.Error())))
		default:
			lines = append(lines, " "+muted.Render("⏎ post  esc cancel"))
		}
	}
	lines = append(lines, m.statusLine(w))
	for i, l := range lines {
		lines[i] = ansi.Truncate(l, w, "")
	}
	return strings.Join(lines, "\n")
}

// titleLine: the scope, how many issues, the order and whether it's fresh; the scopes on the
// right, the current one lit.
func (m *model) titleLine(w int) string {
	rest := fmt.Sprintf(" · %d issue%s", len(m.view), plural(len(m.view)))
	if len(m.all) >= maxIssues {
		rest = fmt.Sprintf(" · the %d updated last", len(m.view))
	}
	if m.query != "" {
		rest = fmt.Sprintf(" · %d of %d", len(m.view), m.visibleCount())
	}
	if m.order != orderStatus {
		rest += " · " + m.order.String()
	}
	switch {
	case m.loading && len(m.all) == 0:
		rest = " · loading…"
	case m.loading && m.stale:
		rest += " · cached, refreshing…"
	case m.loading:
		rest += " · refreshing…"
	}
	var right, rightPlain string
	if len(m.marks) > 0 {
		s := fmt.Sprintf("%d marked", len(m.marks))
		right, rightPlain = accent.Bold(true).Render(s)+"   ", s+"   "
	}
	if len(m.scopes) > 1 {
		var parts, partsPlain []string
		for i, s := range m.scopes {
			name := s.key()
			if s.Kind == scopeTeam {
				name = s.Team.Key
			}
			partsPlain = append(partsPlain, name)
			if i == m.at {
				parts = append(parts, accent.Bold(true).Render(name))
			} else {
				parts = append(parts, muted.Render(name))
			}
		}
		bar, barPlain := strings.Join(parts, "  "), strings.Join(partsPlain, "  ")
		// The scopes go first when there's no room for both.
		if w-ansi.StringWidth(rightPlain+barPlain) >= 40 {
			right, rightPlain = right+bar, rightPlain+barPlain
		}
	}
	name := m.scope().String()
	room := w - 2 - ansi.StringWidth(rightPlain)
	if rightPlain != "" {
		room -= 2
	}
	name = ansi.Truncate(name, max(4, room), "…")
	rest = ansi.Truncate(rest, max(0, room-ansi.StringWidth(name)), "…")
	left := " " + bold.Render(name) + muted.Render(rest)
	if right == "" {
		return left
	}
	gap := w - 1 - ansi.StringWidth(left) - ansi.StringWidth(rightPlain)
	return left + strings.Repeat(" ", max(1, gap)) + right
}

func (m *model) visibleCount() int {
	n := 0
	for _, i := range m.all {
		if !m.deleted[i.ID] {
			n++
		}
	}
	return n
}

// list is exactly n lines: the issues (or the keys, for `?`).
func (m *model) list(w, n int) []string {
	lines := make([]string, 0, n)
	switch {
	case m.help:
		lines = append(lines, helpView(w, n)...)
	case len(m.view) == 0:
		text := "nothing open here"
		switch {
		case m.query != "":
			text = fmt.Sprintf("nothing matches “%s”", m.query)
		case m.loading && len(m.all) == 0:
			text = "loading…"
		}
		lines = append(lines, "   "+muted.Render(text))
	default:
		lo, hi, vis := m.visualRange()
		c := m.columns(w)
		now := time.Now()
		for i := m.top; i < min(len(m.rows), m.top+n); i++ {
			r := m.rows[i]
			if r.k >= 0 {
				lines = append(lines, m.issueLine(r.k, c, vis && r.k >= lo && r.k <= hi, now))
				continue
			}
			head := muted.Bold(true).Render(ansi.Truncate(r.header, w-6, "…"))
			if r.state != nil {
				head = m.glyph(*r.state, r.team) + " " + head
			}
			lines = append(lines, "  "+head)
		}
	}
	for len(lines) < n {
		lines = append(lines, "")
	}
	return lines[:n]
}

// cols are the list's column widths for this width; 0 is a column left out.
type cols struct {
	num, id, title, project, prio, who, age int
}

// columns: the title gets what's left after the identifier and whichever of priority, age,
// assignee and project fit (dropped in the reverse order when narrow).
func (m *model) columns(w int) cols {
	c := cols{num: len(strconv.Itoa(len(m.view)))}
	projW, whoW := 0, 0
	mine := m.scope().Kind == scopeMine
	for _, n := range m.view {
		i := m.all[n]
		c.id = max(c.id, ansi.StringWidth(i.Identifier))
		projW = max(projW, ansi.StringWidth(i.Project))
		if i.Assignee != nil && (!mine || i.Assignee.ID != m.meta.Viewer.ID) {
			whoW = max(whoW, ansi.StringWidth(firstName(i.Assignee.Name)))
		} else if i.Assignee == nil && !mine {
			whoW = max(whoW, 1)
		}
	}
	c.id = min(c.id, 12)
	// marks stripe, cursor, number, space, glyph, space, identifier, gap
	rest := w - (c.num + 5) - c.id - 2 - 1
	want := []struct {
		w   *int
		val int
	}{{&c.prio, 4}, {&c.age, 4}, {&c.who, min(whoW, 12)}, {&c.project, min(projW, 22)}}
	for _, x := range want {
		if x.val > 0 && rest-(x.val+2) >= 28 {
			*x.w = x.val
			rest -= x.val + 2
		}
	}
	c.title = max(8, rest)
	return c
}

func firstName(s string) string {
	if f, _, ok := strings.Cut(s, " "); ok && f != "" {
		return f
	}
	return s
}

// issueLine: mark stripe, cursor, relative number, status, identifier, title, then project,
// assignee, priority and age in fixed columns.
func (m *model) issueLine(k int, c cols, inRange bool, now time.Time) string {
	i := m.issue(k)
	on := k == m.cur
	picked := m.marks[i.ID] || inRange
	var b strings.Builder
	if picked {
		b.WriteString(accent.Render("▌"))
	} else {
		b.WriteByte(' ')
	}
	if on {
		b.WriteString(accent.Bold(true).Render("›"))
	} else {
		b.WriteByte(' ')
	}
	// Relative numbers, as in vim: 5j gets there, 5x deletes that many.
	if on {
		b.WriteString(yellow.Bold(true).Render(fmt.Sprintf("%*d", c.num, k+1)))
	} else {
		b.WriteString(muted.Render(fmt.Sprintf("%*d", c.num, abs(k-m.cur))))
	}
	b.WriteString(" " + m.glyph(i.State, i.TeamID) + " ")
	idSt := muted
	if on {
		idSt = plain
	}
	b.WriteString(idSt.Render(fit(i.Identifier, c.id)) + "  ")

	titleSt := plain
	switch {
	case picked && on:
		titleSt = accent.Bold(true)
	case picked:
		titleSt = accent
	case i.State.closed():
		titleSt = muted
		if i.State.Type != "completed" {
			titleSt = muted.Strikethrough(true)
		}
	case on:
		titleSt = bold
	}
	title := oneLine(i.Title)
	if m.touched[i.ID] && i.State.closed() {
		title += " (" + i.State.Name + ")"
	}
	b.WriteString(titleSt.Render(fit(title, c.title)))
	if c.project > 0 {
		b.WriteString("  " + muted.Render(fit(i.Project, c.project)))
	}
	if c.who > 0 {
		who := ""
		switch {
		case i.Assignee == nil:
			who = muted.Render(fit("–", c.who))
		case i.Assignee.ID == m.meta.Viewer.ID:
			who = accent.Render(fit(firstName(i.Assignee.Name), c.who))
		default:
			who = plain.Render(fit(firstName(i.Assignee.Name), c.who))
		}
		b.WriteString("  " + who)
	}
	if c.prio > 0 {
		b.WriteString("  " + fitStyled(prioLabel(i.Priority), c.prio))
	}
	if c.age > 0 {
		b.WriteString("  " + muted.Render(fmt.Sprintf("%4s", ageLabel(i.Updated, now))))
	}
	return b.String()
}

// pickerLines: a rule with the picker's title, then its choices around the selected one.
func (m *model) pickerLines(w, n int) []string {
	p := m.picker
	lines := []string{muted.Render("─── ") + accent.Bold(true).Render(p.title) + " " + muted.Render(strings.Repeat("─", max(0, w)))}
	shown := p.shown()
	room := n - 1
	top := 0
	if p.sel >= room {
		top = p.sel - room + 1
	}
	if len(shown) == 0 {
		text := "nobody matches"
		if m.peopleWait {
			text = "reading people…"
		}
		lines = append(lines, "   "+muted.Render(text))
	}
	for at := top; at < min(len(shown), top+room); at++ {
		o := p.opts[shown[at]]
		on := at == p.sel
		var b strings.Builder
		if on {
			b.WriteString(" " + accent.Bold(true).Render("›") + " ")
		} else {
			b.WriteString("   ")
		}
		if o.num >= 0 {
			b.WriteString(yellow.Render(strconv.Itoa(o.num)) + " ")
		} else {
			b.WriteString("  ")
		}
		switch {
		case o.state != nil:
			b.WriteString(m.glyph(*o.state, p.teamID) + " ")
		case p.kind == "priority":
			b.WriteString(fitStyled(prioLabel(o.prio), 4) + " ")
		}
		st := plain
		if on {
			st = bold
		}
		b.WriteString(st.Render(o.label))
		if o.current {
			b.WriteString(muted.Render("  (now)"))
		}
		lines = append(lines, b.String())
	}
	if m.peopleWait && p.kind == "assignee" && len(shown) > 0 && len(lines) < n {
		lines = append(lines, "     "+muted.Render("reading people…"))
	}
	for len(lines) < n {
		lines = append(lines, "")
	}
	return lines[:n]
}

// detailLines: the cursor issue in full under a rule: title, fields, then its description,
// scrolled by J/K.
func (m *model) detailLines(w, n int) []string {
	lines := []string{muted.Render(strings.Repeat("─", w))}
	i, ok := m.selected()
	if !ok {
		for len(lines) < n {
			lines = append(lines, "")
		}
		return lines
	}
	tw := max(10, w-4)
	var body []string
	for k, l := range strings.Split(ansi.Wrap(oneLine(i.Title), tw-ansi.StringWidth(i.Identifier)-2, ""), "\n") {
		if k == 0 {
			body = append(body, accent.Bold(true).Render(i.Identifier)+"  "+bold.Render(l))
		} else {
			body = append(body, strings.Repeat(" ", ansi.StringWidth(i.Identifier)+2)+bold.Render(l))
		}
	}
	fields := []string{m.glyph(i.State, i.TeamID) + " " + i.State.Name, priorityName(i.Priority)}
	if i.Assignee != nil {
		fields = append(fields, i.Assignee.Name)
	} else {
		fields = append(fields, "unassigned")
	}
	if i.Project != "" {
		fields = append(fields, i.Project)
	}
	body = append(body, strings.Join(fields, muted.Render(" · ")))
	if len(i.Labels) > 0 {
		body = append(body, muted.Render("labels: "+strings.Join(i.Labels, ", ")))
	}
	now := time.Now()
	meta := fmt.Sprintf("created %s ago · updated %s ago", ageLabel(i.Created, now), ageLabel(i.Updated, now))
	if i.Branch != "" {
		meta += " · " + i.Branch
	}
	body = append(body, muted.Render(meta), "")
	desc, have := m.descs[i.ID]
	switch {
	case !have:
		body = append(body, muted.Render("reading the description…"))
	case strings.TrimSpace(desc) == "":
		body = append(body, muted.Render("no description"))
	default:
		for _, l := range strings.Split(ansi.Wrap(strings.TrimSpace(desc), tw, ""), "\n") {
			body = append(body, plain.Render(l))
		}
	}
	room := n - 1
	m.detailTop = max(0, min(m.detailTop, len(body)-room))
	for _, l := range body[m.detailTop:min(len(body), m.detailTop+room)] {
		lines = append(lines, "  "+l)
	}
	for len(lines) < n {
		lines = append(lines, "")
	}
	return lines[:n]
}

// statusLine: a prompt or filter being typed, a message, a count, or what the keys do now.
func (m *model) statusLine(w int) string {
	room := w - 2
	hints := func(lead string, pairs ...[2]string) string {
		out, used := " "+lead, 1+ansi.StringWidth(lead)
		for i, p := range pairs {
			sep := "  "
			if i == 0 && lead == "" {
				sep = ""
			}
			cell := sep + p[0] + " " + p[1]
			if used+ansi.StringWidth(cell) > room {
				break
			}
			used += ansi.StringWidth(cell)
			out += sep + plain.Render(p[0]) + " " + muted.Render(p[1])
		}
		return out
	}
	switch {
	case m.help:
		return hints("", [2]string{"any key", "back to the issues"})
	case m.prompt != nil:
		label := m.prompt.label
		text := truncateLeft(m.prompt.text, max(1, room-ansi.StringWidth(label)-1))
		return " " + accent.Render(label) + text + accent.Render("▏")
	case m.picker != nil && m.picker.kind == "assignee" && m.picker.filter != "":
		return " " + accent.Render("@") + m.picker.filter + accent.Render("▏") + muted.Render("  ⏎ pick  esc cancel")
	case m.picker != nil:
		last := len(m.picker.opts) - 1
		if last > 9 {
			last = 9
		}
		pairs := [][2]string{{fmt.Sprintf("0-%d", last), "pick"}, {"j/k", "move"}, {"⏎", "pick"}, {"esc", "cancel"}}
		if m.picker.kind == "assignee" {
			pairs[1] = [2]string{"type", "to find someone"}
		}
		return hints("", pairs...)
	case m.typing:
		counts := fmt.Sprintf("  %d of %d", len(m.view), m.visibleCount())
		q := truncateLeft(m.query, max(1, room-2-ansi.StringWidth(counts)))
		return " " + accent.Render("/") + q + accent.Render("▏") + muted.Render(counts)
	case m.msg != "":
		st := yellow
		if m.msgBad {
			st = red
		}
		return " " + st.Render(ansi.Truncate(m.msg, room, "…"))
	case m.count > 0 || m.pending != "":
		s := ""
		if m.count > 0 {
			s = strconv.Itoa(m.count)
		} else if m.pendingCount > 0 {
			s = strconv.Itoa(m.pendingCount)
		}
		return " " + yellow.Render(s+m.pending)
	}
	if lo, hi, ok := m.visualRange(); ok {
		return hints(accent.Render(fmt.Sprintf("-- VISUAL %d --", hi-lo+1)),
			[2]string{"c", "status"}, [2]string{"p", "priority"}, [2]string{"A", "assignee"}, [2]string{"d", "delete"},
			[2]string{"space", "mark"}, [2]string{"esc", "cancel"})
	}
	if len(m.marks) > 0 {
		return hints("", [2]string{"c", "status"}, [2]string{"p", "priority"}, [2]string{"A", "assignee"},
			[2]string{"x", fmt.Sprintf("delete %d", len(m.marks))}, [2]string{"esc", "unmark"})
	}
	if m.query != "" {
		lead := accent.Render(fmt.Sprintf("/%s · %d of %d", ansi.Truncate(m.query, 30, "…"), len(m.view), m.visibleCount()))
		return hints(lead, [2]string{"a", "mark all"}, [2]string{"c", "status"}, [2]string{"esc", "drop filter"})
	}
	return hints("", [2]string{"c", "status"}, [2]string{"C", "comment"}, [2]string{"p", "priority"}, [2]string{"A", "assignee"},
		[2]string{"x", "delete"}, [2]string{"space", "mark"}, [2]string{"u", "undo"}, [2]string{"/", "filter"},
		[2]string{"⇥", "scope"}, [2]string{"⏎", "details"}, [2]string{"?", "keys"})
}

// helpView lays the keys out in n lines: without the blank lines when they don't fit, and in
// two columns (split at a section) when the pane is wide enough.
func helpView(w, n int) []string {
	src := helpLines()
	if len(src) > n {
		var tight []string
		for _, l := range src {
			if l != "" {
				tight = append(tight, l)
			}
		}
		src = tight
	}
	style := func(l string, width int) string {
		if strings.HasPrefix(l, "  ") && len([]rune(l)) > 23 {
			r := []rune(l)
			keys, what := strings.TrimRight(string(r[2:23]), " "), string(r[23:])
			return "   " + plain.Render(fit(keys, 21)) + muted.Render(ansi.Truncate(what, max(0, width-24), "…"))
		}
		if l != "" {
			return " " + accent.Bold(true).Render(ansi.Truncate(l, max(0, width-1), "…"))
		}
		return ""
	}
	colW := w
	if len(src) > n && w >= 140 {
		// Split before the section heading nearest the middle.
		at := len(src) / 2
		for d := 0; d < len(src)/2; d++ {
			if k := at + d; k < len(src) && src[k] != "" && !strings.HasPrefix(src[k], " ") {
				at = k
				break
			}
			if k := at - d; k > 0 && src[k] != "" && !strings.HasPrefix(src[k], " ") {
				at = k
				break
			}
		}
		colW = w / 2
		left, right := src[:at], src[at:]
		var out []string
		for k := 0; k < max(len(left), len(right)); k++ {
			l, r := "", ""
			if k < len(left) {
				l = style(left[k], colW)
			}
			if k < len(right) {
				r = style(right[k], colW)
			}
			out = append(out, l+strings.Repeat(" ", max(0, colW-ansi.StringWidth(l)))+r)
		}
		return out
	}
	var out []string
	for _, l := range src {
		out = append(out, style(l, colW))
	}
	return out
}

// helpLines are the keys `?` shows: help from `move:` up to `options:`.
func helpLines() []string {
	var out []string
	in := false
	for _, l := range strings.Split(help, "\n") {
		if strings.HasPrefix(l, "move:") {
			in = true
		}
		if strings.HasPrefix(l, "options:") {
			break
		}
		if in {
			out = append(out, l)
		}
	}
	return out
}

// fit truncates s to w cells (ending in …) and pads it to exactly w.
func fit(s string, w int) string {
	s = ansi.Truncate(s, max(0, w), "…")
	return s + strings.Repeat(" ", max(0, w-ansi.StringWidth(s)))
}

// fitStyled pads an already styled string to w cells.
func fitStyled(s string, w int) string {
	return s + strings.Repeat(" ", max(0, w-ansi.StringWidth(s)))
}

// truncateLeft keeps the end.
func truncateLeft(s string, w int) string {
	sw := ansi.StringWidth(s)
	if sw <= w {
		return s
	}
	return ansi.TruncateLeft(s, sw-w+1, "…")
}

// ageLabel is `now`, `12m`, `3h`, `5d`, `2w` or `4mo`.
func ageLabel(then, now time.Time) string {
	if then.IsZero() {
		return ""
	}
	s := int64(max(0, now.Sub(then).Seconds()))
	switch {
	case s < 60:
		return "now"
	case s < 3600:
		return fmt.Sprintf("%dm", s/60)
	case s < 86_400:
		return fmt.Sprintf("%dh", s/3600)
	case s < 604_800:
		return fmt.Sprintf("%dd", s/86_400)
	case s < 5_184_000:
		return fmt.Sprintf("%dw", s/604_800)
	}
	return fmt.Sprintf("%dmo", s/2_592_000)
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}
