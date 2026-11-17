package main

import (
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	tea "charm.land/bubbletea/v2"
)

const (
	// The list is re-read this often, so tabs opened or closed in Chrome show up.
	refreshEvery = time.Second
	flashFor     = 3 * time.Second
	// Closes `u` can still reopen.
	undoDepth = 50
	// No tab: Chrome's own tab ids are never negative.
	none int64 = -1
)

// browser is what the list needs from Chrome (the browser-use host; a fake in tests).
type browser interface {
	name() string
	list() (snapshot, error)
	closeTabs(ids []int64) error
	reopen(tabs []gone) (opened []int64, failed int, err error)
}

type order int

const (
	// Windows, then left to right, with window and tab-group headings.
	orderStrip order = iota
	// Grouped by site, the sites with the most tabs first.
	orderSite
	// The tabs you haven't looked at in longest first.
	orderAge
)

func (o order) next() order { return (o + 1) % 3 }

func (o order) String() string {
	switch o {
	case orderSite:
		return "by site"
	case orderAge:
		return "least recently used first"
	}
	return "tab strip"
}

// row is a line of the list: a heading (window, tab group, site or age) or a tab.
type row struct {
	header string
	// A tab group heading's Chrome color ("blue", …); empty for the other headings.
	color string
	// The tab's place in view; -1 for a heading.
	k int
}

type tickMsg struct{}

type loadedMsg struct {
	snap snapshot
	err  error
	gen  int
}

type closedMsg struct {
	gone []gone
	err  error
}

type reopenedMsg struct {
	gone   []gone
	opened []int64
	failed int
	err    error
	snap   *snapshot
}

type model struct {
	api  browser
	snap snapshot
	// Tabs shown, as indices into snap.Tabs, in the current order.
	view []int
	rows []row
	// The selected tab's place in view, and the first row the list shows.
	cur, top      int
	width, height int
	// A vim count being typed (5j, 12G, 5x); 0 when none.
	count int
	// closed: closed here and not yet gone from Chrome's list. marks: what the next `;` closes.
	closed, marks map[int64]bool
	// Visual mode's other end (a tab id); the range runs from it to the cursor.
	visual int64
	// The `/` filter: every word has to be in the title or the URL.
	query  string
	typing bool
	order  order
	help   bool
	// How many open tabs share each URL (tab.dupKey).
	dups map[string]int
	// Closes that worked, newest last: what `u` reopens.
	undo   [][]gone
	msg    string
	msgBad bool
	msgAt  time.Time
	// False for --snapshot: nothing is closed, reopened or re-read.
	live       bool
	refreshing bool
	// Bumped by a reopen, so a list read that started before it can't hide the new tabs.
	gen      int
	quitting bool
	cmds     []tea.Cmd
}

func newModel(api browser, snap snapshot) *model {
	m := &model{
		api: api, snap: snap, closed: map[int64]bool{}, marks: map[int64]bool{}, visual: none,
		dups: map[string]int{}, live: true, width: 100, height: 30,
	}
	// Start on the tab you were last looking at.
	here, best := none, -1.0
	for _, t := range snap.Tabs {
		if t.Active && t.Last >= best {
			here, best = t.ID, t.Last
		}
	}
	m.setView(here)
	return m
}

func tick() tea.Cmd {
	return tea.Tick(refreshEvery, func(time.Time) tea.Msg { return tickMsg{} })
}

func (m *model) Init() tea.Cmd {
	if !m.live {
		return nil
	}
	return tick()
}

func (m *model) tab(k int) tab { return m.snap.Tabs[m.view[k]] }

func (m *model) selectedID() int64 {
	if m.cur < len(m.view) {
		return m.tab(m.cur).ID
	}
	return none
}

func (m *model) pos(id int64) int {
	for k, i := range m.view {
		if m.snap.Tabs[i].ID == id {
			return k
		}
	}
	return -1
}

// ids are the tabs at view places [from, to).
func (m *model) ids(from, to int) []int64 {
	var out []int64
	for k := max(0, from); k < min(to, len(m.view)); k++ {
		out = append(out, m.tab(k).ID)
	}
	return out
}

func (m *model) openCount() int {
	n := 0
	for _, t := range m.snap.Tabs {
		if !m.closed[t.ID] {
			n++
		}
	}
	return n
}

func (m *model) visualRange() (lo, hi int, ok bool) {
	if m.visual == none || len(m.view) == 0 {
		return 0, 0, false
	}
	a := m.pos(m.visual)
	if a < 0 {
		a = m.cur
	}
	return min(a, m.cur), max(a, m.cur), true
}

func (m *model) flash(s string) { m.msg, m.msgBad, m.msgAt = s, false, time.Now() }

func (m *model) flashErr(s string) { m.msg, m.msgBad, m.msgAt = s, true, time.Now() }

// listH is how many rows the list gets: all but the title line and the status line.
func (m *model) listH() int { return max(1, m.height-2) }

func (m *model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
	case tickMsg:
		m.cmds = append(m.cmds, tick())
		if m.msg != "" && time.Since(m.msgAt) > flashFor {
			m.msg = ""
		}
		if m.live && !m.refreshing {
			m.refreshing = true
			api, gen := m.api, m.gen
			m.cmds = append(m.cmds, func() tea.Msg {
				s, err := api.list()
				return loadedMsg{s, err, gen}
			})
		}
	case loadedMsg:
		m.refreshing = false
		if msg.gen != m.gen {
			break
		}
		if msg.err != nil {
			m.flashErr(msg.err.Error())
		} else {
			m.apply(msg.snap, m.selectedID())
		}
	case closedMsg:
		m.onClosed(msg)
	case reopenedMsg:
		m.onReopened(msg)
	case tea.PasteMsg:
		if m.typing {
			m.query += oneLine(msg.Content)
			m.queryChanged()
		}
	case tea.KeyPressMsg:
		m.key(msg)
	}
	m.scroll()
	cmds := m.cmds
	m.cmds = nil
	if m.quitting {
		return m, tea.Quit
	}
	return m, tea.Batch(cmds...)
}

// apply takes a fresh list; the cursor goes to tab keep when it's there.
func (m *model) apply(s snapshot, keep int64) {
	m.snap = s
	live := map[int64]bool{}
	for _, t := range s.Tabs {
		live[t.ID] = true
	}
	for id := range m.closed {
		if !live[id] {
			delete(m.closed, id)
		}
	}
	for id := range m.marks {
		if !live[id] {
			delete(m.marks, id)
		}
	}
	if m.visual != none && !live[m.visual] {
		m.visual = none
	}
	m.setView(keep)
}

func (m *model) onClosed(msg closedMsg) {
	if msg.err != nil {
		// Show them again: they're still open.
		for _, g := range msg.gone {
			delete(m.closed, g.ID)
		}
		m.setView(m.selectedID())
		m.flashErr("couldn't close: " + msg.err.Error())
		return
	}
	if len(msg.gone) == 1 {
		m.flash(fmt.Sprintf("closed %s · u reopens", msg.gone[0].Title))
	} else {
		m.flash(fmt.Sprintf("closed %d tabs · u reopens", len(msg.gone)))
	}
	m.undo = append(m.undo, msg.gone)
	if len(m.undo) > undoDepth {
		m.undo = m.undo[1:]
	}
}

func (m *model) onReopened(msg reopenedMsg) {
	if msg.err != nil {
		m.undo = append(m.undo, msg.gone)
		m.flashErr("couldn't reopen: " + msg.err.Error())
		return
	}
	if msg.snap != nil {
		focus := m.selectedID()
		if len(msg.opened) > 0 {
			focus = msg.opened[0]
		}
		m.apply(*msg.snap, focus)
	}
	text := fmt.Sprintf("reopened %d tab%s", len(msg.opened), plural(len(msg.opened)))
	if len(msg.opened) == 1 && len(msg.gone) == 1 {
		text = "reopened " + msg.gone[0].Title
	}
	if msg.failed > 0 {
		text += fmt.Sprintf(" · %d wouldn't open", msg.failed)
	}
	m.flash(text)
}

func (m *model) key(k tea.KeyPressMsg) {
	s := k.String()
	if s == "ctrl+c" {
		m.quitting = true
		return
	}
	if m.help {
		// Any key puts the list back.
		m.help = false
		return
	}
	if m.typing {
		m.filterKey(k, s)
		return
	}
	if len(s) == 1 && s[0] >= '0' && s[0] <= '9' && (s != "0" || m.count > 0) {
		m.count = min(99_999, m.count*10+int(s[0]-'0'))
		return
	}
	count := m.count
	m.count = 0
	n := max(1, count)
	half := max(1, m.listH()/2)
	switch s {
	case "esc":
		// Esc drops a half-typed count before anything else.
		if count == 0 {
			m.escape()
		}
	case "q":
		m.quitting = true
	case "ctrl+d", "pgdown":
		m.moveBy(half)
	case "ctrl+u", "pgup":
		m.moveBy(-half)
	case "j", "down", "ctrl+n":
		m.moveBy(n)
	case "k", "up", "ctrl+p":
		m.moveBy(-n)
	case "g", "home":
		m.moveTo(0)
		if count > 0 {
			m.moveTo(count - 1)
		}
	case "G", "end":
		m.moveTo(len(m.view) - 1)
		if count > 0 {
			m.moveTo(count - 1)
		}
	case ";", "x":
		m.closeKey(n)
	case "space", "m":
		m.mark(n)
	case "v":
		if m.visual != none {
			m.visual = none
		} else {
			m.visual = m.selectedID()
		}
	case "*":
		m.markSite()
	case "D":
		m.markDups()
	case "a":
		m.markAll()
	case "u":
		m.reopen()
	case "/":
		m.typing, m.visual = true, none
	case "s":
		m.order = m.order.next()
		m.setView(m.selectedID())
	case "?":
		m.help = true
	}
}

// escape undoes the most recent kind of state, one at a time, then quits.
func (m *model) escape() {
	switch {
	case m.visual != none:
		m.visual = none
	case len(m.marks) > 0:
		clear(m.marks)
	case m.query != "":
		m.query = ""
		m.setView(m.selectedID())
	default:
		m.quitting = true
	}
}

// filterKey types into `/`: the list narrows as you type and the cursor goes to the first
// match; ↑↓ (^p ^n) move, ⏎ keeps the filter, esc drops it.
func (m *model) filterKey(k tea.KeyPressMsg, s string) {
	switch s {
	case "esc":
		m.typing, m.query = false, ""
		m.setView(m.selectedID())
		return
	case "enter", "tab":
		m.typing = false
		return
	case "down", "ctrl+n":
		m.moveBy(1)
		return
	case "up", "ctrl+p":
		m.moveBy(-1)
		return
	case "backspace":
		if m.query == "" {
			m.typing = false
			return
		}
		_, size := utf8.DecodeLastRuneInString(m.query)
		m.query = m.query[:len(m.query)-size]
	case "ctrl+u":
		m.query = ""
	case "ctrl+w":
		m.query = strings.TrimRightFunc(m.query, unicode.IsSpace)
		m.query = m.query[:strings.LastIndex(m.query, " ")+1]
	default:
		if k.Text == "" || k.Mod&(tea.ModCtrl|tea.ModAlt|tea.ModSuper) != 0 {
			return
		}
		m.query += strings.Map(func(r rune) rune {
			if unicode.IsControl(r) {
				return -1
			}
			return r
		}, k.Text)
	}
	m.queryChanged()
}

func (m *model) queryChanged() {
	m.setView(none)
	m.cur, m.top = 0, 0
}

func (m *model) moveBy(d int) { m.moveTo(m.cur + d) }

func (m *model) moveTo(k int) {
	if len(m.view) > 0 {
		m.cur = max(0, min(k, len(m.view)-1))
	}
}

// toggleMarks marks them all, or unmarks them all when they already are. True when it marked.
func (m *model) toggleMarks(ids []int64) bool {
	all := len(ids) > 0
	for _, id := range ids {
		all = all && m.marks[id]
	}
	for _, id := range ids {
		if all {
			delete(m.marks, id)
		} else {
			m.marks[id] = true
		}
	}
	return !all
}

// mark (space) flips the mark on n tabs from the cursor down and moves past them. In visual
// mode it marks the range instead.
func (m *model) mark(n int) {
	if lo, hi, ok := m.visualRange(); ok {
		m.visual = none
		m.toggleMarks(m.ids(lo, hi+1))
		return
	}
	for _, id := range m.ids(m.cur, m.cur+n) {
		if m.marks[id] {
			delete(m.marks, id)
		} else {
			m.marks[id] = true
		}
	}
	m.moveBy(n)
}

// markSite (`*`): every shown tab on the cursor tab's site.
func (m *model) markSite() {
	if m.cur >= len(m.view) {
		return
	}
	site := m.tab(m.cur).host()
	var ids []int64
	for _, i := range m.view {
		if t := m.snap.Tabs[i]; t.host() == site {
			ids = append(ids, t.ID)
		}
	}
	if m.toggleMarks(ids) {
		m.flash(fmt.Sprintf("marked %d on %s · ; closes", len(ids), site))
	} else {
		m.flash("unmarked " + site)
	}
}

// markDups (`D`): every shown tab whose URL another shown tab also has, except the copy you
// used last.
func (m *model) markDups() {
	byURL := map[string][]tab{}
	var keys []string
	for _, i := range m.view {
		t := m.snap.Tabs[i]
		if _, ok := byURL[t.dupKey()]; !ok {
			keys = append(keys, t.dupKey())
		}
		byURL[t.dupKey()] = append(byURL[t.dupKey()], t)
	}
	var ids []int64
	for _, key := range keys {
		copies := byURL[key]
		if len(copies) < 2 {
			continue
		}
		keep := copies[0]
		for _, t := range copies[1:] {
			if t.Last >= keep.Last {
				keep = t
			}
		}
		for _, t := range copies {
			if t.ID != keep.ID {
				ids = append(ids, t.ID)
			}
		}
	}
	if len(ids) == 0 {
		m.flash("no duplicates")
		return
	}
	if m.toggleMarks(ids) {
		m.flash(fmt.Sprintf("marked %d duplicate%s (kept the copy used last) · ; closes", len(ids), plural(len(ids))))
	} else {
		m.flash("unmarked the duplicates")
	}
}

// markAll (`a`): everything shown, which after a `/` filter is every match.
func (m *model) markAll() {
	ids := m.ids(0, len(m.view))
	if m.toggleMarks(ids) {
		m.flash(fmt.Sprintf("marked all %d · ; closes", len(ids)))
	} else {
		m.flash("unmarked all")
	}
}

// closeKey (`;`) closes the visual range if there is one, else every marked tab, else n tabs
// from the cursor down. Now, no questions: `u` brings them back.
func (m *model) closeKey(n int) {
	var ids []int64
	if lo, hi, ok := m.visualRange(); ok {
		m.visual = none
		ids = m.ids(lo, hi+1)
	} else if len(m.marks) > 0 {
		// Shown or not: the title line says how many are marked.
		for _, t := range m.snap.Tabs {
			if m.marks[t.ID] && !m.closed[t.ID] {
				ids = append(ids, t.ID)
			}
		}
	} else {
		ids = m.ids(m.cur, m.cur+n)
	}
	m.closeIDs(ids)
}

func (m *model) closeIDs(ids []int64) {
	if len(ids) == 0 {
		return
	}
	if len(ids) >= m.openCount() {
		m.flashErr("that's every tab, and Chrome would quit: leave one open")
		return
	}
	doomed := map[int64]bool{}
	for _, id := range ids {
		doomed[id] = true
	}
	// The cursor stays on its tab if that survives; otherwise it goes to the next tab down
	// that does (the one above, at the end).
	shown := m.ids(0, len(m.view))
	at := min(m.cur, len(shown))
	keep := none
	for _, id := range shown[at:] {
		if !doomed[id] {
			keep = id
			break
		}
	}
	for i := at - 1; keep == none && i >= 0; i-- {
		if !doomed[shown[i]] {
			keep = shown[i]
		}
	}
	var gs []gone
	for _, t := range m.snap.Tabs {
		if doomed[t.ID] {
			gs = append(gs, t.gone())
		}
	}
	for _, id := range ids {
		m.closed[id] = true
		delete(m.marks, id)
	}
	m.setView(keep)
	if m.live {
		api := m.api
		m.cmds = append(m.cmds, func() tea.Msg { return closedMsg{gs, api.closeTabs(ids)} })
	}
}

// reopen (`u`) opens the last batch of closed tabs again, where they were.
func (m *model) reopen() {
	if len(m.undo) == 0 {
		m.flash("nothing to reopen")
		return
	}
	gs := m.undo[len(m.undo)-1]
	m.undo = m.undo[:len(m.undo)-1]
	if !m.live {
		return
	}
	m.gen++
	m.flash(fmt.Sprintf("reopening %d tab%s…", len(gs), plural(len(gs))))
	api := m.api
	m.cmds = append(m.cmds, func() tea.Msg {
		opened, failed, err := api.reopen(gs)
		r := reopenedMsg{gone: gs, opened: opened, failed: failed, err: err}
		if err == nil {
			if s, err := api.list(); err == nil {
				r.snap = &s
			}
		}
		return r
	})
}

// setView recomputes what's shown (filter, order, duplicates, headings), keeping the cursor on
// tab keep when it's still there and on the same row otherwise.
func (m *model) setView(keep int64) {
	tabs := m.snap.Tabs
	clear(m.dups)
	for _, t := range tabs {
		if !m.closed[t.ID] {
			m.dups[t.dupKey()]++
		}
	}
	words := strings.Fields(strings.ToLower(m.query))
	view := []int{}
	for i, t := range tabs {
		if !m.closed[t.ID] && t.matches(words) {
			view = append(view, i)
		}
	}
	switch m.order {
	case orderSite:
		hosts, n := map[int]string{}, map[string]int{}
		for _, i := range view {
			hosts[i] = tabs[i].host()
			n[hosts[i]]++
		}
		// Stable: within a site, tab-strip order.
		sort.SliceStable(view, func(a, b int) bool {
			ha, hb := hosts[view[a]], hosts[view[b]]
			if n[ha] != n[hb] {
				return n[ha] > n[hb]
			}
			return ha < hb
		})
	case orderAge:
		sort.SliceStable(view, func(a, b int) bool { return tabs[view[a]].Last < tabs[view[b]].Last })
	}
	m.view = view
	if at := m.pos(keep); at >= 0 {
		m.cur = at
	}
	m.cur = max(0, min(m.cur, len(m.view)-1))
	m.buildRows()
}

// buildRows puts headings between the tabs: windows and tab groups, sites, or how long ago.
func (m *model) buildRows() {
	m.rows = m.rows[:0]
	tabs := m.snap.Tabs
	switch m.order {
	case orderStrip:
		many := len(m.snap.Windows) > 1
		var prevW, prevG int64
		for k, i := range m.view {
			t := tabs[i]
			newWindow := k == 0 || prevW != t.Window
			if many && newWindow {
				s := "window"
				for n, w := range m.snap.Windows {
					if w.ID != t.Window {
						continue
					}
					s = fmt.Sprintf("window %d", n+1)
					if w.Incognito {
						s += " · incognito"
					}
					if w.Focused {
						s += " · in front"
					}
				}
				m.rows = append(m.rows, row{header: s, k: -1})
			}
			if t.Group != -1 && (newWindow || prevG != t.Group) {
				title, color := "group", ""
				if g, ok := m.snap.Groups[t.Group]; ok {
					color = g.Color
					if g.Title != "" {
						title = g.Title
					}
				}
				m.rows = append(m.rows, row{header: title, color: color, k: -1})
			}
			prevW, prevG = t.Window, t.Group
			m.rows = append(m.rows, row{k: k})
		}
	case orderSite:
		n := map[string]int{}
		for _, i := range m.view {
			n[tabs[i].host()]++
		}
		prev := ""
		for k, i := range m.view {
			if site := tabs[i].host(); k == 0 || site != prev {
				m.rows = append(m.rows, row{header: fmt.Sprintf("%s · %d", site, n[site]), k: -1})
				prev = site
			}
			m.rows = append(m.rows, row{k: k})
		}
	case orderAge:
		names := [4]string{"used over a week ago", "used over a day ago", "used over an hour ago", "used in the last hour"}
		now := nowMs()
		bucket := func(last float64) int {
			s := (now - last) / 1000
			switch {
			case last <= 0 || s >= 7*86400:
				return 0
			case s >= 86400:
				return 1
			case s >= 3600:
				return 2
			}
			return 3
		}
		var n [4]int
		for _, i := range m.view {
			n[bucket(tabs[i].Last)]++
		}
		prev := -1
		for k, i := range m.view {
			if b := bucket(tabs[i].Last); b != prev {
				m.rows = append(m.rows, row{header: fmt.Sprintf("%s · %d", names[b], n[b]), k: -1})
				prev = b
			}
			m.rows = append(m.rows, row{k: k})
		}
	}
}

// scroll keeps the cursor's tab, and the headings right above it, in view.
func (m *model) scroll() {
	h := m.listH()
	r := 0
	for i, x := range m.rows {
		if x.k == m.cur {
			r = i
			break
		}
	}
	head := r
	for head > 0 && m.rows[head-1].k < 0 {
		head--
	}
	if head < m.top {
		m.top = head
	}
	if r >= m.top+h {
		m.top = r + 1 - h
	}
	m.top = max(0, min(m.top, len(m.rows)-h))
}

func nowMs() float64 { return float64(time.Now().UnixMilli()) }

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// oneLine turns control characters (newlines, tabs) into spaces.
func oneLine(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
}
