package main

import (
	"cmp"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	tea "charm.land/bubbletea/v2"
)

type tabsAPI interface {
	snapshot() (snapshot, error)
	closeTab(string) error
	focusPane(tab) error
	copyID(tab, bool) error
}

type tickMsg struct{}
type loadedMsg struct {
	snap snapshot
	err  error
	gen  int
}
type closedMsg struct {
	snap   *snapshot
	closed []string
	err    error
}
type selectedMsg struct{ err error }
type copiedMsg struct {
	what string
	err  error
}

type model struct {
	api                           tabsAPI
	snap                          snapshot
	rows                          []tab
	cursor, offset, width, height int
	query, oldQuery, anchor       string
	marked                        map[string]bool
	searching, help, busy         bool
	refreshing                    bool
	count, generation             int
	message                       string
	failed                        bool
	refreshError                  bool
}

func newModel(api tabsAPI, snap snapshot) *model {
	m := &model{api: api, snap: snap, marked: map[string]bool{}, width: 100, height: 30}
	m.filter("")
	return m
}

func tick() tea.Cmd {
	return tea.Tick(time.Second, func(time.Time) tea.Msg { return tickMsg{} })
}

func (m *model) Init() tea.Cmd { return tick() }

func (m *model) currentID() string {
	if len(m.rows) == 0 {
		return ""
	}
	return m.rows[m.cursor].ID
}

func (m *model) filter(keep string) {
	m.rows = nil
	terms := strings.Fields(strings.ToLower(m.query))
	for _, t := range m.snap.Tabs {
		haystack := strings.ToLower(t.Session + " " + t.Label + " " + t.Detail + " " + t.pane.label + " " + t.activity.App)
		match := true
		for _, q := range terms {
			if !strings.Contains(haystack, q) {
				match = false
				break
			}
		}
		if match {
			m.rows = append(m.rows, t)
		}
	}
	slices.SortStableFunc(m.rows, func(a, b tab) int {
		group := a.activity.group()
		if order := cmp.Compare(group, b.activity.group()); order != 0 {
			return order
		}
		if group == done {
			return b.activity.UpdatedAt.Compare(a.activity.UpdatedAt)
		}
		return 0
	})
	anchorFound := false
	for i, t := range m.rows {
		if t.ID == keep {
			m.cursor = i
		}
		anchorFound = anchorFound || t.ID == m.anchor
	}
	if !anchorFound {
		m.anchor = ""
	}
	m.clamp()
}

func (m *model) apply(snap snapshot) {
	keep := m.currentID()
	m.snap = snap
	live := map[string]bool{}
	for _, t := range snap.Tabs {
		live[t.ID] = true
	}
	for id := range m.marked {
		if !live[id] {
			delete(m.marked, id)
		}
	}
	m.filter(keep)
}

func (m *model) pageRows() int { return max(2, m.height-3) }

func (m *model) sectionStart(i, start int) bool {
	return i == start || m.rows[i].activity.group() != m.rows[i-1].activity.group()
}

func (m *model) listLines(start, end int) int {
	lines := end - start
	for i := start; i < end; i++ {
		if m.sectionStart(i, start) {
			lines++
		}
	}
	return lines
}

func (m *model) clamp() {
	m.cursor = max(0, min(m.cursor, len(m.rows)-1))
	m.offset = min(m.offset, m.cursor)
	for m.offset < m.cursor && m.listLines(m.offset, m.cursor+1) > m.pageRows() {
		m.offset++
	}
	for m.offset > 0 && m.listLines(m.offset-1, len(m.rows)) <= m.pageRows() {
		m.offset--
	}
}

func (m *model) visualRange() (int, int) {
	a := m.cursor
	for i, t := range m.rows {
		if t.ID == m.anchor {
			a = i
			break
		}
	}
	return min(a, m.cursor), max(a, m.cursor)
}

func (m *model) targets(count int) []string {
	var ids []string
	if len(m.rows) == 0 && len(m.marked) == 0 {
		return nil
	}
	if m.anchor != "" {
		first, last := m.visualRange()
		for _, t := range m.rows[first : last+1] {
			ids = append(ids, t.ID)
		}
	} else if len(m.marked) > 0 {
		for _, t := range m.snap.Tabs {
			if m.marked[t.ID] {
				ids = append(ids, t.ID)
			}
		}
	} else {
		for _, t := range m.rows[m.cursor:min(len(m.rows), m.cursor+count)] {
			ids = append(ids, t.ID)
		}
	}
	return ids
}

func (m *model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		m.clamp()
	case tickMsg:
		if m.refreshing || m.busy {
			return m, tick()
		}
		m.refreshing = true
		api, gen := m.api, m.generation
		return m, tea.Batch(tick(), func() tea.Msg {
			snap, err := api.snapshot()
			return loadedMsg{snap, err, gen}
		})
	case loadedMsg:
		m.refreshing = false
		if msg.gen != m.generation {
			break // An action began after this read; ignore stale rows.
		}
		if msg.err != nil {
			m.message, m.failed = msg.err.Error(), true
			m.refreshError = true
		} else {
			m.apply(msg.snap)
			if m.refreshError {
				m.message, m.failed = "", false
				m.refreshError = false
			}
		}
	case closedMsg:
		m.busy = false
		m.refreshError = false
		for _, id := range msg.closed {
			delete(m.marked, id)
			for i, t := range m.snap.Tabs {
				if t.ID == id {
					m.snap.Tabs = append(m.snap.Tabs[:i], m.snap.Tabs[i+1:]...)
					break
				}
			}
		}
		m.anchor = ""
		if msg.snap != nil {
			m.apply(*msg.snap)
		} else {
			m.filter("")
		}
		m.message, m.failed = fmt.Sprintf("Closed %d", len(msg.closed)), false
		if msg.err != nil {
			m.message, m.failed = msg.err.Error(), true
		}
	case selectedMsg:
		m.busy = false
		m.refreshError = false
		if msg.err == nil {
			return m, tea.Quit
		}
		m.message, m.failed = msg.err.Error(), true
	case copiedMsg:
		m.busy, m.refreshError = false, false
		m.message, m.failed = "Copied "+msg.what, false
		if msg.err != nil {
			m.message, m.failed = msg.err.Error(), true
		}
	case tea.PasteMsg:
		if m.searching {
			m.query += clean(msg.Content)
			m.cursor = 0
			m.filter("")
		}
	case tea.KeyPressMsg:
		return m.key(msg)
	}
	return m, nil
}

func (m *model) key(key tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	k := key.String()
	if k == "ctrl+c" {
		return m, tea.Quit
	}
	if m.searching {
		switch k {
		case "esc":
			m.query, m.searching = m.oldQuery, false
		case "enter":
			m.searching = false
		case "backspace":
			_, size := utf8.DecodeLastRuneInString(m.query)
			m.query = m.query[:len(m.query)-size]
		case "ctrl+u":
			m.query = ""
		default:
			m.query += clean(key.Text)
			if key.Text == " " {
				m.query += " "
			}
		}
		m.cursor = 0
		m.filter("")
		return m, nil
	}
	if k == "q" {
		return m, tea.Quit
	}
	if m.help {
		if k == "esc" || k == "?" || k == "enter" {
			m.help = false
		}
		return m, nil
	}
	if m.busy {
		return m, nil
	}
	if len(k) == 1 && k[0] >= '0' && k[0] <= '9' && (k != "0" || m.count > 0) {
		m.count = min(99999, m.count*10+int(k[0]-'0'))
		return m, nil
	}
	count, explicit := max(1, m.count), m.count > 0
	m.count = 0
	switch k {
	case "j", "down":
		m.cursor += count
	case "k", "up":
		m.cursor -= count
	case "ctrl+d", "pgdown":
		m.cursor += max(1, m.pageRows()/2) * count
	case "ctrl+u", "pgup":
		m.cursor -= max(1, m.pageRows()/2) * count
	case "g", "home", "0":
		m.cursor = 0
	case "G", "end":
		m.cursor = len(m.rows) - 1
		if explicit {
			for i, t := range m.rows {
				if t.Index == count {
					m.cursor = i
					break
				}
			}
		}
	case "/":
		m.searching, m.oldQuery, m.anchor = true, m.query, ""
	case "?":
		m.help = true
	case "esc":
		switch {
		case m.anchor != "":
			m.anchor = ""
		case len(m.marked) > 0:
			clear(m.marked)
		case m.query != "":
			m.query = ""
			m.filter(m.currentID())
		default:
			return m, tea.Quit
		}
	case "v":
		if m.anchor == "" {
			m.anchor = m.currentID()
		} else {
			m.anchor = ""
		}
	case "space", " ", "m":
		if m.anchor != "" {
			for _, id := range m.targets(1) {
				m.marked[id] = true
			}
			m.anchor = ""
		} else if id := m.currentID(); id != "" {
			if m.marked[id] {
				delete(m.marked, id)
			} else {
				m.marked[id] = true
			}
			m.cursor++
		}
	case "a":
		for _, t := range m.rows {
			m.marked[t.ID] = true
		}
	case ";", "x":
		ids := m.targets(count)
		if len(ids) == 0 {
			break
		}
		m.busy, m.message, m.failed = true, "Closing tabs…", false
		m.generation++
		api := m.api
		return m, func() tea.Msg {
			result := closedMsg{}
			for _, id := range ids {
				if err := api.closeTab(id); err != nil {
					result.err = err
					break
				}
				result.closed = append(result.closed, id)
			}
			snap, err := api.snapshot()
			if err == nil {
				result.snap = &snap
			} else if result.err == nil {
				result.err = err
			}
			return result
		}
	case "enter":
		if len(m.rows) > 0 {
			m.busy, m.message, m.failed = true, "Focusing pane…", false
			m.generation++
			api, target := m.api, m.rows[m.cursor]
			return m, func() tea.Msg { return selectedMsg{api.focusPane(target)} }
		}
	case "y", "Y", "shift+y":
		if len(m.rows) > 0 {
			agent, what := k != "y", "block ID"
			if agent {
				what = "agent session ID"
			}
			m.busy, m.message, m.failed = true, "Copying "+what+"…", false
			m.generation++
			api, target := m.api, m.rows[m.cursor]
			return m, func() tea.Msg { return copiedMsg{what, api.copyID(target, agent)} }
		}
	}
	m.clamp()
	return m, nil
}
