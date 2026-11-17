package main

// Drawing: plain terminal lines, no box. A title line, the list, and a vim-style status line
// at the bottom (the `/` filter is typed there). Colors are the terminal's own ANSI palette
// and its background, so ct follows whatever theme the terminal (or Rex) has.

import (
	"fmt"
	"strconv"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

var (
	plain  = lipgloss.NewStyle()
	bold   = lipgloss.NewStyle().Bold(true)
	muted  = lipgloss.NewStyle().Foreground(lipgloss.Color("8"))
	accent = lipgloss.NewStyle().Foreground(lipgloss.Color("6"))
	yellow = lipgloss.NewStyle().Foreground(lipgloss.Color("3"))
	red    = lipgloss.NewStyle().Foreground(lipgloss.Color("1"))
	green  = lipgloss.NewStyle().Foreground(lipgloss.Color("2"))
)

// groupStyle is a Chrome tab-group color in the nearest ANSI color.
func groupStyle(c string) lipgloss.Style {
	ansiColor := map[string]string{
		"grey": "8", "blue": "4", "red": "1", "yellow": "3", "green": "2",
		"pink": "13", "purple": "5", "cyan": "6", "orange": "9",
	}[c]
	if ansiColor == "" {
		return muted
	}
	return lipgloss.NewStyle().Foreground(lipgloss.Color(ansiColor))
}

func (m *model) View() tea.View {
	v := tea.NewView(m.render())
	v.AltScreen = true
	return v
}

func (m *model) render() string {
	w, h := m.width, m.height
	if w < 24 || h < 4 {
		return ansi.Truncate("ct · make the pane bigger · q quits", max(1, w), "")
	}
	lines := make([]string, 0, h)
	lines = append(lines, m.titleLine(w))
	lines = append(lines, m.body(w, h-2)...)
	lines = append(lines, m.statusLine(w))
	for i, l := range lines {
		lines[i] = ansi.Truncate(l, w, "")
	}
	return strings.Join(lines, "\n")
}

// titleLine: the browser, how many tabs, duplicates and the order; marks on the right.
func (m *model) titleLine(w int) string {
	rest := fmt.Sprintf(" · %d tabs", m.openCount())
	dupes := 0
	for _, n := range m.dups {
		dupes += n - 1
	}
	if dupes > 0 {
		rest += fmt.Sprintf(" · %d duplicate%s", dupes, plural(dupes))
	}
	if m.order != orderStrip {
		rest += " · " + m.order.String()
	}
	right := ""
	if len(m.marks) > 0 {
		right = fmt.Sprintf("%d marked", len(m.marks))
	}
	room := w - 2 - ansi.StringWidth(right)
	if right != "" {
		room -= 2
	}
	name := ansi.Truncate(m.api.name(), room, "…")
	rest = ansi.Truncate(rest, max(0, room-ansi.StringWidth(name)), "…")
	left := " " + bold.Render(name) + muted.Render(rest)
	if right == "" {
		return left
	}
	gap := w - 1 - ansi.StringWidth(left) - ansi.StringWidth(right)
	return left + strings.Repeat(" ", max(1, gap)) + red.Bold(true).Render(right)
}

// body is exactly n lines: the list (or the keys, for `?`).
func (m *model) body(w, n int) []string {
	lines := make([]string, 0, n)
	switch {
	case m.help:
		for _, l := range helpLines() {
			if strings.HasPrefix(l, "  ") && len([]rune(l)) > 23 {
				r := []rune(l)
				keys, what := strings.TrimRight(string(r[2:23]), " "), string(r[23:])
				lines = append(lines, "   "+plain.Render(fit(keys, 21))+muted.Render(what))
			} else if l != "" {
				lines = append(lines, " "+accent.Bold(true).Render(l))
			} else {
				lines = append(lines, "")
			}
		}
	case len(m.view) == 0:
		text := "no tabs left"
		if m.query != "" {
			text = fmt.Sprintf("nothing matches “%s”", m.query)
		}
		lines = append(lines, "   "+muted.Render(text))
	default:
		lo, hi, vis := m.visualRange()
		nw := len(strconv.Itoa(len(m.view)))
		now := nowMs()
		for i := m.top; i < min(len(m.rows), m.top+n); i++ {
			r := m.rows[i]
			if r.k >= 0 {
				lines = append(lines, m.tabLine(r.k, w, nw, vis && r.k >= lo && r.k <= hi, now))
				continue
			}
			st := muted.Bold(true)
			if r.color != "" {
				st = groupStyle(r.color).Bold(true)
			}
			lines = append(lines, "  "+st.Render(ansi.Truncate(r.header, w-3, "…")))
		}
	}
	for len(lines) < n {
		lines = append(lines, "")
	}
	return lines[:n]
}

// tabLine: group stripe, cursor, relative number, state, then title | URL | age in fixed
// columns so the URLs line up.
func (m *model) tabLine(k, w, nw int, inRange bool, now float64) string {
	t := m.tab(k)
	on := k == m.cur
	// Marked, or in the visual range: the next `;` closes it.
	doomed := m.marks[t.ID] || inRange
	var b strings.Builder
	if g, ok := m.snap.Groups[t.Group]; ok && t.Group != -1 {
		b.WriteString(groupStyle(g.Color).Render("▎"))
	} else {
		b.WriteByte(' ')
	}
	if on {
		b.WriteString(accent.Bold(true).Render("›"))
	} else {
		b.WriteByte(' ')
	}
	// Relative numbers, as in vim: the cursor row its own number, the rest their distance
	// (5j gets there, 5x closes that many).
	if on {
		b.WriteString(yellow.Bold(true).Render(fmt.Sprintf("%*d", nw, k+1)))
	} else {
		b.WriteString(muted.Render(fmt.Sprintf("%*d", nw, abs(k-m.cur))))
	}
	b.WriteByte(' ')
	switch {
	case doomed:
		b.WriteString(red.Render("✕"))
	case t.Loading:
		b.WriteString(yellow.Render("●"))
	case t.Audible && !t.Muted:
		b.WriteString(yellow.Render("♪"))
	case t.Discarded:
		b.WriteString(muted.Render("○"))
	case t.Active:
		b.WriteString(green.Render("●"))
	default:
		b.WriteByte(' ')
	}
	b.WriteByte(' ')

	titleSt := plain
	switch {
	case doomed && on:
		titleSt = red.Bold(true)
	case doomed:
		titleSt = red
	case on:
		titleSt = bold
	}
	urlSt := muted
	if n := m.dups[t.dupKey()]; n > 1 {
		urlSt = yellow
	} else if on {
		urlSt = plain
	}

	avail := w - (nw + 5) - 1
	age := ""
	rest := avail
	if avail >= 40 {
		age = ageLabel(t.Last, now)
		rest = avail - 6
	}
	if rest >= 48 {
		titleW := rest * 11 / 20
		urlW := rest - titleW - 2
		b.WriteString(titleSt.Render(fit(t.displayTitle(), titleW)) + "  ")
		b.WriteString(urlSt.Render(fit(t.shortURL(), urlW)))
	} else {
		// Narrow: the title, and the site on the right when there's room.
		site := truncateLeft(t.host(), max(8, min(24, rest/3)))
		sw := ansi.StringWidth(site)
		if rest >= sw+2+14 {
			b.WriteString(titleSt.Render(fit(t.displayTitle(), rest-sw-2)) + "  ")
			b.WriteString(urlSt.Render(site))
		} else {
			b.WriteString(titleSt.Render(fit(t.displayTitle(), rest)))
		}
	}
	if avail >= 40 {
		b.WriteString("  " + muted.Render(fmt.Sprintf("%4s", age)))
	}
	return b.String()
}

// statusLine: the filter being typed, a message, a count, or what the keys do now.
func (m *model) statusLine(w int) string {
	room := w - 2
	open := m.openCount()
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
		return hints("", [2]string{"any key", "back to the tabs"})
	case m.typing:
		counts := fmt.Sprintf("  %d of %d", len(m.view), open)
		q := truncateLeft(m.query, max(1, room-2-ansi.StringWidth(counts)))
		return " " + accent.Render("/") + q + accent.Render("▏") + muted.Render(counts)
	case m.msg != "":
		st := yellow
		if m.msgBad {
			st = red
		}
		return " " + st.Render(ansi.Truncate(m.msg, room, "…"))
	case m.count > 0:
		return " " + yellow.Render(strconv.Itoa(m.count))
	}
	if lo, hi, ok := m.visualRange(); ok {
		return hints(accent.Render(fmt.Sprintf("-- VISUAL %d --", hi-lo+1)),
			[2]string{";", "close them"}, [2]string{"space", "mark them"}, [2]string{"esc", "cancel"})
	}
	if len(m.marks) > 0 {
		return hints("", [2]string{";", fmt.Sprintf("close %d", len(m.marks))}, [2]string{"u", "undo"}, [2]string{"esc", "unmark"})
	}
	if m.query != "" {
		lead := accent.Render(fmt.Sprintf("/%s · %d of %d", ansi.Truncate(m.query, 30, "…"), len(m.view), open))
		return hints(lead, [2]string{"a", "mark all"}, [2]string{";", "close"}, [2]string{"esc", "drop filter"})
	}
	return hints("", [2]string{"space", "mark"}, [2]string{";", "close"}, [2]string{"u", "undo"},
		[2]string{"/", "filter"}, [2]string{"s", "sort"}, [2]string{"?", "keys"}, [2]string{"q", "quit"})
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

// truncateLeft keeps the end: `…acme-4289.chatgpt.site`.
func truncateLeft(s string, w int) string {
	sw := ansi.StringWidth(s)
	if sw <= w {
		return s
	}
	return ansi.TruncateLeft(s, sw-w+1, "…")
}

// ageLabel is `now`, `12m`, `3h`, `5d`, `2w` or `4mo` from a unix-ms time.
func ageLabel(then, now float64) string {
	if then <= 0 {
		return ""
	}
	s := int64(max(0, (now-then)/1000))
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
