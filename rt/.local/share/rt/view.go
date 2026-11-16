package main

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
)

var (
	muted  = lipgloss.NewStyle().Foreground(lipgloss.Color("8"))
	accent = lipgloss.NewStyle().Foreground(lipgloss.Color("6"))
	strong = lipgloss.NewStyle().Bold(true)
)

func fit(s string, width int) string {
	s = ansi.Truncate(s, max(0, width), "…")
	return s + strings.Repeat(" ", max(0, width-ansi.StringWidth(s)))
}

func (m *model) View() tea.View {
	var content string
	if m.width < 28 || m.height < 9 {
		content = ansi.Truncate("rt · enlarge pane · q quits", max(1, m.width), "")
	} else if m.help {
		lines := []string{
			"rt · keys", "",
			"j k / arrows    move · 5j, 3k",
			"g gg / G / 12G  first / last / tab 12",
			"ctrl+d / ctrl+u half a page",
			"/               filter tabs and pane titles",
			"Enter           switch tab and dismiss",
			"; / x           close tab / marks / range",
			"Space / m       mark and move down",
			"v               visual range, then ;",
			"a               mark all matches",
			"Esc             cancel range / marks / filter",
			"q / ctrl+c      quit", "",
			"Closing a tab ends all its panes.",
			"? / Esc / Enter returns to the list",
		}
		w := min(58, m.width-4)
		for i := range lines {
			lines[i] = fit(lines[i], w)
		}
		content = m.center(strings.Join(lines[:min(len(lines), m.height-4)], "\n"))
	} else {
		w := m.width - 4
		var lines []string
		title := fmt.Sprintf("Tabs · %s   %d", m.snap.Label, len(m.rows))
		if m.query != "" {
			title += fmt.Sprintf(" of %d", len(m.snap.Tabs))
		}
		if len(m.marked) > 0 {
			title += fmt.Sprintf("   %d marked", len(m.marked))
		}
		if m.anchor != "" {
			title += "   VISUAL"
		}
		lines = append(lines, strong.Render(fit(title, w)))
		search := "/ filter by session, tab or directory"
		if m.query != "" || m.searching {
			search = "/ " + m.query
		}
		if m.searching {
			search += "▏"
		}
		lines = append(lines, muted.Render(fit(search, w)), "")
		first, last := m.visualRange()
		shown := max(1, min(m.pageRows(), len(m.rows)))
		for i := m.offset; i < m.offset+shown; i++ {
			if i >= len(m.rows) {
				text := "No other tabs"
				if m.query != "" {
					text = "No matching tabs"
				}
				lines = append(lines, muted.Render(fit(text, w)))
				continue
			}
			t := m.rows[i]
			pointer, mark := " ", " "
			if i == m.cursor {
				pointer = "›"
			}
			if m.marked[t.ID] || (m.anchor != "" && i >= first && i <= last) {
				mark = "●"
			}
			relative := i - m.cursor
			if relative < 0 {
				relative = -relative
			}
			prefix := fmt.Sprintf("%s %2d %s %2d ", pointer, relative, mark, t.Index)
			sessionWidth := min(16, max(6, w/10))
			labelWidth := min(32, max(10, w/4))
			left := prefix + fit(t.Session, sessionWidth) + "  "
			name := fit(t.Label, labelWidth)
			detail := t.Detail
			if t.Panes > 1 {
				detail = fmt.Sprintf("%d panes · %s", t.Panes, detail)
			}
			row := muted.Render(left) + name + muted.Render("  "+detail)
			if i == m.cursor {
				row = accent.Bold(true).Render(left+name) + muted.Render("  "+detail)
			} else if mark == "●" {
				row = accent.Render(left+name) + muted.Render("  "+detail)
			}
			lines = append(lines, fit(row, w))
		}
		status := "j/k move · / filter · Enter switch · ; close · ? keys · q quit"
		if m.count > 0 {
			status = fmt.Sprintf("%d…", m.count)
		} else if m.message != "" {
			status = clean(m.message)
		}
		style := muted
		if m.failed {
			style = lipgloss.NewStyle().Foreground(lipgloss.Color("1"))
		}
		lines = append(lines, "", style.Render(fit(status, w)))
		content = m.center(strings.Join(lines, "\n"))
	}
	v := tea.NewView(content)
	v.AltScreen = true
	return v
}

func (m *model) center(content string) string {
	// Rex already frames the floating pane. Leave the terminal background alone
	// and give the list just a little breathing room, without a nested border.
	return lipgloss.Place(m.width, m.height, lipgloss.Center, lipgloss.Center, content)
}
