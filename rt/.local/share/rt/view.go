package main

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
	muted    = lipgloss.NewStyle().Foreground(lipgloss.Color("8"))
	strong   = lipgloss.NewStyle().Bold(true)
	selected = lipgloss.NewStyle().Reverse(true)
	red      = lipgloss.NewStyle().Foreground(lipgloss.Color("1"))
	green    = lipgloss.NewStyle().Foreground(lipgloss.Color("2"))
	yellow   = lipgloss.NewStyle().Foreground(lipgloss.Color("3"))
	cyan     = lipgloss.NewStyle().Foreground(lipgloss.Color("6"))
)

var sectionNames = [...]string{"Needs attention", "Working", "Done", "Other tabs"}

func fit(s string, width int) string {
	s = ansi.Truncate(s, max(0, width), "…")
	return s + strings.Repeat(" ", max(0, width-ansi.StringWidth(s)))
}

func (m *model) View() tea.View {
	v := tea.NewView(m.render())
	v.AltScreen = true
	return v
}

func (m *model) render() string {
	w, h := m.width, m.height
	if w < 24 || h < 5 {
		return ansi.Truncate("rt · enlarge pane · q quits", max(1, w), "")
	}
	var lines []string
	if m.help {
		lines = []string{
			" Rex tabs · keys", "",
			" j k / arrows     move · 5j, 3k",
			" g / G / 12G      first / last / tab 12",
			" ctrl+d / ctrl+u  half a page",
			" /                filter tabs and pane titles",
			" Enter            focus pane and quit",
			" y / Y            copy block ID / agent session ID",
			" ; / x            close tab / marks / range",
			" Space / m        mark and move down",
			" v                visual range, then ;",
			" a                mark all matches",
			" Esc              cancel range / marks / filter",
			" q / ctrl+c       quit", "",
			" Closing a tab ends all its panes.",
			" ? / Esc / Enter returns to the list",
		}
	} else {
		lines = append(lines, m.searchLine(), m.titleLine())
		lines = append(lines, m.body(w)...)
		for len(lines) < h-1 {
			lines = append(lines, "")
		}
		lines = append(lines, m.statusLine())
	}
	lines = lines[:min(len(lines), h)]
	for i, line := range lines {
		lines[i] = ansi.Truncate(line, w, "")
	}
	return strings.Join(lines, "\n")
}

func (m *model) searchLine() string {
	if m.searching {
		return " " + strong.Render("/  "+m.query+"▏")
	}
	if m.query != "" {
		return " " + muted.Render("/  "+m.query)
	}
	return " " + muted.Render("/  Filter by tab, session or directory")
}

func (m *model) titleLine() string {
	count := strconv.Itoa(len(m.rows))
	if m.query != "" {
		count += fmt.Sprintf(" of %d", len(m.snap.Tabs))
	}
	line := " " + strong.Render("Rex tabs") + muted.Render("  "+count+" · "+m.snap.Label)
	if len(m.marked) > 0 {
		line += red.Render(fmt.Sprintf("  %d marked", len(m.marked)))
	}
	if m.anchor != "" {
		line += cyan.Render("  VISUAL")
	}
	return line
}

func (m *model) body(w int) []string {
	if len(m.rows) == 0 {
		if m.query != "" {
			return []string{muted.Render("  No matching tabs")}
		}
		return []string{muted.Render("  No other tabs")}
	}
	room := m.pageRows()
	lines := make([]string, 0, room)
	lo, hi := m.visualRange()
	now := time.Now()
	digits := len(strconv.Itoa(len(m.snap.Tabs)))
	for i := m.offset; i < len(m.rows) && len(lines) < room; i++ {
		t := m.rows[i]
		if m.sectionStart(i, m.offset) {
			if len(lines)+1 == room {
				break
			}
			lines = append(lines, muted.Bold(true).Render("  "+sectionNames[t.activity.group()]))
		}
		marked := m.marked[t.ID] || (m.anchor != "" && i >= lo && i <= hi)
		lines = append(lines, m.tabLine(i, w, digits, marked, now))
	}
	return lines
}

func (m *model) tabLine(i, w, digits int, marked bool, now time.Time) string {
	t := m.rows[i]
	on := i == m.cursor
	n := max(i-m.cursor, m.cursor-i)
	if on {
		n = t.Index
	}
	numbers := fmt.Sprintf(" %*d ", digits, n)
	icon, iconStyle := "·", muted
	switch t.activity.State {
	case "blocked":
		icon, iconStyle = "!", yellow
	case "error":
		icon, iconStyle = "×", red
	case "working":
		icon, iconStyle = "●", cyan
	case "done":
		icon, iconStyle = "✓", green
	}
	if marked {
		icon, iconStyle = "✕", red
	}
	icon += "  "

	sessionWidth := min(20, w/5)
	right := "  " + fit(t.Session, sessionWidth) + " "
	if w >= 48 {
		age := ""
		if group := t.activity.group(); group == done || group == attention {
			age = activityAge(t.activity.UpdatedAt, now)
		}
		right += fit(age, 5) + " "
	}
	room := w - ansi.StringWidth(numbers+icon+right)
	title, detail := t.titleAndDetail()
	title = ansi.Truncate(title, room, "…")
	if detail != "" {
		detail = "  " + detail
	}
	detail = fit(detail, room-ansi.StringWidth(title))
	if on {
		return selected.Render(numbers + icon + title + detail + right)
	}
	return muted.Render(numbers) + iconStyle.Render(icon) + title + muted.Render(detail+right)
}

func (t tab) titleAndDetail() (string, string) {
	detail := t.pane.label
	if detail == "shell" {
		detail = ""
	}
	// A pane title is more recognizable than Rex's generated Window <short ID>.
	if short, ok := strings.CutPrefix(t.Label, "Window "); ok && len(short) == 8 && strings.HasSuffix(t.ID, short) && detail != "" {
		return detail, ""
	}
	if detail == t.Label {
		detail = ""
	}
	return t.Label, detail
}

func activityAge(at, now time.Time) string {
	d := now.Sub(at)
	switch {
	case at.IsZero():
		return ""
	case d < time.Minute:
		return "now"
	case d < time.Hour:
		return fmt.Sprintf("%dm", d/time.Minute)
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh", d/time.Hour)
	default:
		return fmt.Sprintf("%dd", d/(24*time.Hour))
	}
}

func (m *model) statusLine() string {
	switch {
	case m.searching:
		return muted.Render(" Enter apply filter   Esc cancel")
	case m.count > 0:
		return muted.Render(fmt.Sprintf(" %d…", m.count))
	case m.failed:
		return red.Render(" " + clean(m.message))
	case m.message != "":
		return muted.Render(" " + clean(m.message))
	case m.snap.activityUnavailable:
		return yellow.Render(" Activity unavailable   ? keys")
	default:
		return muted.Render(" j/k move   / filter   ↵ focus   y/Y copy IDs   ; close   Space mark   ? keys")
	}
}
