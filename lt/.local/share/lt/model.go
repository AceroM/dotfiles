package main

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	tea "charm.land/bubbletea/v2"
)

const (
	tickEvery = time.Second
	// The list is re-read this often, so changes made elsewhere show up.
	refreshEvery = 45 * time.Second
	flashFor     = 4 * time.Second
	// Changes `u` can still undo.
	undoDepth = 50
)

type order int

const (
	// Grouped by status: triage, in progress, todo, backlog (Linear's list order).
	orderStatus order = iota
	// Grouped by priority, urgent first.
	orderPriority
	// The issues nobody has touched in longest first.
	orderStale
	// Grouped by project, the biggest first.
	orderProject
)

func (o order) next() order { return (o + 1) % 4 }

func (o order) String() string {
	switch o {
	case orderPriority:
		return "by priority"
	case orderStale:
		return "least recently updated first"
	case orderProject:
		return "by project"
	}
	return "by status"
}

// row is a line of the list: a heading or an issue.
type row struct {
	header string
	// A status heading's state and team, for its glyph.
	state *state
	team  string
	// The issue's place in view; -1 for a heading.
	k int
}

// Fields lt changes, as Linear's IssueUpdateInput names them.
const (
	fieldState    = "stateId"
	fieldPriority = "priority"
	fieldAssignee = "assigneeId"
	fieldTitle    = "title"
)

type change struct{ before, after issue }

// undoEntry is one thing `u` takes back: an update, a delete or a create.
type undoEntry struct {
	kind    string
	field   string
	changes []change
	issues  []issue
}

type option struct {
	// The digit that picks it at once; -1 when none.
	num   int
	label string
	state *state
	prio  int
	// The assignee picker's choice; nil is "unassigned".
	who     *person
	current bool
}

// picker is the status, priority or assignee menu, drawn above the status line.
type picker struct {
	kind    string
	title   string
	targets []string
	// Where the targets came from ("visual", "marks" or ""), used up by the pick.
	src  string
	opts []option
	// Assignee only: names typed to narrow the list.
	filter string
	sel    int
	// Status: the states are this team's.
	teamID string
}

func (p *picker) shown() []int {
	words := strings.Fields(strings.ToLower(p.filter))
	var out []int
	for i, o := range p.opts {
		ok := true
		for _, w := range words {
			ok = ok && strings.Contains(strings.ToLower(o.label), w)
		}
		if ok {
			out = append(out, i)
		}
	}
	return out
}

// prompt is a title or comment typed in the status line.
type prompt struct {
	kind  string
	label string
	text  string
	id    string
	input map[string]any
	// Comments keep the prompt open until Linear confirms the post.
	posting bool
	err     error
}

func (p *prompt) hasCommentStatus() bool {
	return p != nil && (p.posting || p.err != nil)
}

type (
	tickMsg struct{}
	metaMsg struct {
		meta meta
		err  error
	}
	loadedMsg struct {
		key    string
		issues []issue
		err    error
		gen    int
	}
	peopleMsg struct {
		people []person
		err    error
	}
	descWantMsg struct{ id string }
	descMsg     struct {
		id, text string
		err      error
	}
	updatedMsg struct {
		field   string
		changes []change
		issues  []issue
		err     error
		undo    bool
		// Said with the result: issues the change skipped.
		note string
	}
	removedMsg struct {
		issues []issue
		err    error
		// It undid a create.
		undo bool
	}
	restoredMsg struct {
		issues []issue
		err    error
	}
	createdMsg struct {
		issue issue
		err   error
	}
	commentedMsg struct{ err error }
	flashMsg     struct {
		text string
		err  error
	}
)

type model struct {
	api    api
	meta   meta
	scopes []scope
	at     int
	// The scope's issues (and ones you changed that no longer belong in it).
	all []issue
	// Issues shown, as indices into all, in the current order.
	view []int
	rows []row
	// The selected issue's place in view, and the first row the list shows.
	cur, top      int
	width, height int
	// A vim count being typed (5j, 12G, 3x); 0 when none.
	count int
	// `d` waiting for its second key, with the count typed before it.
	pending      string
	pendingCount int
	// The issue before the last g jump, so gx can still open that issue.
	beforeG string
	marks   map[string]bool
	// Visual mode's other end (an issue id); the range runs from it to the cursor.
	visual      string
	query       string
	typing      bool
	order       order
	showBacklog bool
	hideTriage  bool
	help        bool
	helpTop     int
	// The detail pane (⏎): the issue's description under the list, scrolled by J/K.
	detail    bool
	detailTop int
	descs     map[string]string
	picker    *picker
	prompt    *prompt
	// Deleted here: hidden at once, whatever a list read still says.
	deleted map[string]bool
	// Changed this session: kept in the list (in its new state) until R.
	touched map[string]bool
	undo    []undoEntry
	people  []person
	// People are being read; the assignee picker fills in when they arrive.
	peopleWait bool
	msg        string
	msgBad     bool
	msgAt      time.Time
	// False for --snapshot: nothing is read, changed or opened.
	live    bool
	loading bool
	loaded  time.Time
	// Shown from the cache; the list read hasn't answered yet.
	stale bool
	// Bumped by every change sent, so a list read that started before it is dropped.
	gen      int
	inflight int
	quitting bool
	cmds     []tea.Cmd
	// Outside effects, swapped out in tests.
	opener func(string) error
	copier func(string) error
	// How long the cursor rests before its description is read.
	descDelay time.Duration
}

func newModel(a api, mt meta, scopeKey string) *model {
	m := &model{
		api: a, meta: mt, marks: map[string]bool{}, deleted: map[string]bool{}, touched: map[string]bool{},
		descs: map[string]string{}, live: true, width: 100, height: 30,
		opener: openURL, copier: copyText, descDelay: 150 * time.Millisecond,
	}
	m.scopes = mt.scopes()
	for i, s := range m.scopes {
		if s.key() == scopeKey {
			m.at = i
		}
	}
	return m
}

func (m *model) scope() scope { return m.scopes[m.at] }

func tick() tea.Cmd {
	return tea.Tick(tickEvery, func(time.Time) tea.Msg { return tickMsg{} })
}

func (m *model) Init() tea.Cmd {
	if !m.live {
		return nil
	}
	a := m.api
	return tea.Batch(tick(), m.loadCmd(), func() tea.Msg {
		mt, err := a.meta()
		if err == nil {
			writeCache("meta", mt)
		}
		return metaMsg{mt, err}
	})
}

// loadCmd reads the scope's issues (and caches them).
func (m *model) loadCmd() tea.Cmd {
	m.loading, m.loaded = true, time.Now()
	a, s, gen := m.api, m.scope(), m.gen
	return func() tea.Msg {
		is, err := a.issues(s)
		if err == nil {
			writeCache("scope-"+s.key(), is)
		}
		return loadedMsg{s.key(), is, err, gen}
	}
}

func (m *model) issue(k int) issue { return m.all[m.view[k]] }

func (m *model) selected() (issue, bool) {
	if m.cur < len(m.view) {
		return m.issue(m.cur), true
	}
	return issue{}, false
}

func (m *model) selectedID() string {
	if i, ok := m.selected(); ok {
		return i.ID
	}
	return ""
}

func (m *model) find(id string) int {
	for n, i := range m.all {
		if i.ID == id {
			return n
		}
	}
	return -1
}

func (m *model) pos(id string) int {
	for k, n := range m.view {
		if m.all[n].ID == id {
			return k
		}
	}
	return -1
}

// ids are the issues at view places [from, to).
func (m *model) ids(from, to int) []string {
	var out []string
	for k := max(0, from); k < min(to, len(m.view)); k++ {
		out = append(out, m.issue(k).ID)
	}
	return out
}

func (m *model) visualRange() (lo, hi int, ok bool) {
	if m.visual == "" || len(m.view) == 0 {
		return 0, 0, false
	}
	a := m.pos(m.visual)
	if a < 0 {
		a = m.cur
	}
	return min(a, m.cur), max(a, m.cur), true
}

// targets are what an action works on: the visual range, else the marked issues (shown or
// not), else n issues from the cursor down. src says which, for consume.
func (m *model) targets(n int) (ids []string, src string) {
	if lo, hi, ok := m.visualRange(); ok {
		return m.ids(lo, hi+1), "visual"
	}
	if len(m.marks) > 0 {
		for _, i := range m.all {
			if m.marks[i.ID] && !m.deleted[i.ID] {
				ids = append(ids, i.ID)
			}
		}
		return ids, "marks"
	}
	return m.ids(m.cur, m.cur+n), ""
}

// consume ends the selection an action used.
func (m *model) consume(src string) {
	switch src {
	case "visual":
		m.visual = ""
	case "marks":
		clear(m.marks)
	}
}

func (m *model) flash(s string) { m.msg, m.msgBad, m.msgAt = s, false, time.Now() }

func (m *model) flashErr(s string) { m.msg, m.msgBad, m.msgAt = s, true, time.Now() }

// layout splits the available lines between the list and the picker or detail pane.
func (m *model) layout() (list, pick, detail int) {
	n := max(1, m.height-2)
	if m.prompt.hasCommentStatus() {
		n = max(1, n-1)
	}
	switch {
	case m.picker != nil:
		pick = min(len(m.picker.shown())+1, 12, max(2, n/2))
		pick = max(pick, 2)
	case m.detail && n >= 8:
		detail = max(4, n*45/100)
	}
	return max(1, n-pick-detail), pick, detail
}

func (m *model) listH() int { l, _, _ := m.layout(); return l }

func (m *model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	was := m.selectedID()
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		if m.help {
			m.scrollHelp(0)
		}
	case tickMsg:
		m.cmds = append(m.cmds, tick())
		if m.msg != "" && time.Since(m.msgAt) > flashFor {
			m.msg = ""
		}
		if m.live && !m.loading && m.inflight == 0 && time.Since(m.loaded) >= refreshEvery {
			m.cmds = append(m.cmds, m.loadCmd())
		}
	case metaMsg:
		if msg.err == nil {
			m.setMeta(msg.meta)
		} else if len(m.meta.Teams) == 0 {
			m.flashErr(msg.err.Error())
		}
	case loadedMsg:
		m.onLoaded(msg)
	case peopleMsg:
		m.peopleWait = false
		if msg.err != nil {
			m.flashErr("couldn't read people: " + msg.err.Error())
		} else {
			m.people = msg.people
			if m.picker != nil && m.picker.kind == "assignee" {
				m.picker.opts = m.assigneeOptions(m.picker.targets)
			}
		}
	case descWantMsg:
		if _, have := m.descs[msg.id]; m.detail && msg.id == m.selectedID() && !have && m.live {
			a, id := m.api, msg.id
			m.cmds = append(m.cmds, func() tea.Msg {
				text, err := a.description(id)
				return descMsg{id, text, err}
			})
		}
	case descMsg:
		if msg.err != nil {
			m.flashErr("couldn't read the description: " + msg.err.Error())
		} else {
			m.descs[msg.id] = msg.text
		}
	case updatedMsg:
		m.onUpdated(msg)
	case removedMsg:
		m.onRemoved(msg)
	case restoredMsg:
		m.onRestored(msg)
	case createdMsg:
		m.onCreated(msg)
	case commentedMsg:
		m.landed()
		if msg.err != nil {
			m.prompt.posting, m.prompt.err = false, msg.err
		} else {
			m.prompt = nil
			m.flash("comment posted")
		}
	case flashMsg:
		if msg.err != nil {
			m.flashErr(msg.err.Error())
		} else if msg.text != "" {
			m.flash(msg.text)
		}
	case tea.PasteMsg:
		m.paste(oneLine(msg.Content))
	case tea.KeyPressMsg:
		m.key(msg)
	}
	if now := m.selectedID(); now != was {
		m.detailTop = 0
		m.wantDesc()
	}
	m.scroll()
	cmds := m.cmds
	m.cmds = nil
	if m.quitting {
		return m, tea.Quit
	}
	return m, tea.Batch(cmds...)
}

// wantDesc asks for the selected issue's description once the cursor rests on it.
func (m *model) wantDesc() {
	id := m.selectedID()
	if _, have := m.descs[id]; !m.detail || id == "" || have || !m.live {
		return
	}
	if m.descDelay <= 0 {
		m.cmds = append(m.cmds, func() tea.Msg { return descWantMsg{id} })
		return
	}
	m.cmds = append(m.cmds, tea.Tick(m.descDelay, func(time.Time) tea.Msg { return descWantMsg{id} }))
}

// setMeta takes fresh teams; the scope stays the one you're on.
func (m *model) setMeta(mt meta) {
	key := m.scope().key()
	m.meta = mt
	m.scopes = mt.scopes()
	m.at = 0
	for i, s := range m.scopes {
		if s.key() == key {
			m.at = i
		}
	}
	m.setView(m.selectedID())
}

// onLoaded takes a fresh list. Issues changed here and no longer in it (done, handed to
// someone else) stay until R; deleted ones stay hidden.
func (m *model) onLoaded(msg loadedMsg) {
	if msg.key != m.scope().key() {
		return
	}
	m.loading = false
	if msg.gen != m.gen {
		// A change went out after this read started: read again.
		m.loaded = time.Time{}
		return
	}
	if msg.err != nil {
		m.flashErr(msg.err.Error())
		return
	}
	m.stale = false
	keep := m.selectedID()
	seen := map[string]bool{}
	all := make([]issue, 0, len(msg.issues))
	for _, i := range msg.issues {
		seen[i.ID] = true
		all = append(all, i)
	}
	for _, i := range m.all {
		if m.touched[i.ID] && !seen[i.ID] {
			all = append(all, i)
		}
	}
	m.all = all
	for id := range m.marks {
		if m.find(id) < 0 {
			delete(m.marks, id)
		}
	}
	if m.visual != "" && m.find(m.visual) < 0 {
		m.visual = ""
	}
	m.setView(keep)
}

func (m *model) key(k tea.KeyPressMsg) {
	s := k.String()
	if s == "ctrl+c" {
		m.quitting = true
		return
	}
	if m.help {
		switch s {
		case "j", "down":
			m.scrollHelp(1)
		case "k", "up":
			m.scrollHelp(-1)
		default:
			m.help = false
		}
		return
	}
	switch {
	case m.picker != nil:
		m.pickerKey(k, s)
		return
	case m.prompt != nil:
		m.promptKey(k, s)
		return
	case m.typing:
		m.filterKey(k, s)
		return
	}
	if id := m.beforeG; id != "" {
		m.beforeG = ""
		switch s {
		case "g":
			return
		case "x":
			if at := m.pos(id); at >= 0 {
				m.moveTo(at)
				m.open()
			}
			return
		}
	}
	if len(s) == 1 && s[0] >= '0' && s[0] <= '9' && (s != "0" || m.count > 0) && m.pending == "" {
		m.count = min(99_999, m.count*10+int(s[0]-'0'))
		return
	}
	count := m.count
	m.count = 0
	if p := m.pending; p != "" {
		count = m.pendingCount
		m.pending = ""
		if p+s == "dd" {
			m.remove(max(1, count))
			return
		}
		// Anything else drops the prefix and is itself.
	}
	n := max(1, count)
	switch s {
	case "esc":
		if count == 0 {
			m.escape()
		}
	case "q":
		m.quitting = true
	case "ctrl+d", "pgdown":
		m.halfPage(1)
	case "ctrl+u", "pgup":
		m.halfPage(-1)
	case "j", "down", "ctrl+n":
		m.moveBy(n)
	case "k", "up", "ctrl+p":
		m.moveBy(-n)
	case "g":
		m.beforeG = m.selectedID()
		m.moveTo(max(0, count-1))
	case "home":
		m.moveTo(0)
	case "G", "end":
		m.moveTo(len(m.view) - 1)
		if count > 0 {
			m.moveTo(count - 1)
		}
	case "enter":
		m.detail = !m.detail
		m.detailTop = 0
		m.wantDesc()
	case "J":
		if m.detail {
			m.detailTop += n
		}
	case "K":
		if m.detail {
			m.detailTop = max(0, m.detailTop-n)
		}
	case "d":
		if _, _, ok := m.visualRange(); ok {
			m.remove(n)
		} else {
			m.pending, m.pendingCount = "d", count
		}
	case "x", ";", "delete":
		m.remove(n)
	case "c":
		m.openStatus(n)
	case "C":
		if cur, ok := m.selected(); ok {
			m.prompt = &prompt{kind: "comment", label: "comment on " + cur.Identifier + ": ", id: cur.ID}
		}
	case "p":
		m.openPriority(n)
	case "A":
		m.openAssignee(n)
	case "r":
		m.rename()
	case "n":
		m.newIssue()
	case "space", "m":
		m.mark(n)
	case "v", "V":
		if m.visual != "" {
			m.visual = ""
		} else {
			m.visual = m.selectedID()
		}
	case "*":
		m.markStatus()
	case "a":
		m.markAll()
	case "u":
		m.undoLast()
	case "/":
		m.typing, m.visual = true, ""
	case "b":
		m.showBacklog = !m.showBacklog
		m.setView(m.selectedID())
	case "t":
		m.hideTriage = !m.hideTriage
		m.setView(m.selectedID())
	case "s":
		m.order = m.order.next()
		m.setView(m.selectedID())
	case "tab":
		m.switchScope(m.at + n)
	case "shift+tab":
		m.switchScope(m.at - n)
	case "R", "ctrl+r":
		m.reload()
	case "o":
		m.open()
	case "y":
		m.copyField("identifier")
	case "Y":
		m.copyField("url")
	case "B":
		m.copyField("branch")
	case "?":
		m.help, m.helpTop = true, 0
	default:
		if d, ok := strings.CutPrefix(s, "ctrl+"); ok && len(d) == 1 && d[0] >= '0' && int(d[0]-'0') < len(statusSlots) {
			m.setStatus(int(d[0]-'0'), n)
		}
	}
}

func (m *model) scrollHelp(d int) {
	n := max(1, m.height-2)
	m.helpTop = max(0, min(m.helpTop+d, len(helpView(m.width, n))-n))
}

// escape undoes the most recent kind of state, one at a time, then quits.
func (m *model) escape() {
	switch {
	case m.visual != "":
		m.visual = ""
	case len(m.marks) > 0:
		clear(m.marks)
	case m.query != "":
		m.query = ""
		m.setView(m.selectedID())
	case m.detail:
		m.detail = false
	default:
		m.quitting = true
	}
}

// editLine is the line editing the filter and prompts share. ok is false for a key it
// doesn't handle.
func editLine(text string, k tea.KeyPressMsg, s string) (string, bool) {
	switch s {
	case "backspace", "ctrl+h":
		_, size := utf8.DecodeLastRuneInString(text)
		return text[:len(text)-size], true
	case "ctrl+u":
		return "", true
	case "ctrl+w", "alt+backspace":
		text = strings.TrimRightFunc(text, unicode.IsSpace)
		return text[:strings.LastIndex(text, " ")+1], true
	}
	if k.Text == "" || k.Mod&(tea.ModCtrl|tea.ModAlt|tea.ModSuper) != 0 {
		return text, false
	}
	return text + strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, k.Text), true
}

func (m *model) paste(s string) {
	switch {
	case m.picker != nil && m.picker.kind == "assignee":
		m.picker.filter += s
		m.picker.sel = 0
	case m.prompt != nil && !m.prompt.posting:
		m.prompt.text += s
	case m.typing:
		m.query += s
		m.queryChanged()
	}
}

// filterKey types into `/`: the list narrows as you type; ↑↓ (^p ^n) move, ⏎ keeps the
// filter, esc drops it.
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
	}
	if q, ok := editLine(m.query, k, s); ok {
		m.query = q
		m.queryChanged()
	}
}

func (m *model) queryChanged() {
	m.setView("")
	m.cur, m.top = 0, 0
}

func (m *model) moveBy(d int) { m.moveTo(m.cur + d) }

func (m *model) moveTo(k int) {
	if len(m.view) > 0 {
		m.cur = max(0, min(k, len(m.view)-1))
	}
}

// toggleMarks marks them all, or unmarks them all when they already are. True when it marked.
func (m *model) toggleMarks(ids []string) bool {
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

// mark (space) flips n marks from the cursor down and moves past them; in visual mode it
// marks the range.
func (m *model) mark(n int) {
	if lo, hi, ok := m.visualRange(); ok {
		m.visual = ""
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

// markStatus (`*`): every shown issue in the cursor issue's status.
func (m *model) markStatus() {
	cur, ok := m.selected()
	if !ok {
		return
	}
	name := strings.ToLower(cur.State.Name)
	var ids []string
	for _, n := range m.view {
		if i := m.all[n]; strings.ToLower(i.State.Name) == name {
			ids = append(ids, i.ID)
		}
	}
	if m.toggleMarks(ids) {
		m.flash(fmt.Sprintf("marked %d in %s", len(ids), cur.State.Name))
	} else {
		m.flash("unmarked " + cur.State.Name)
	}
}

// markAll (`a`): everything shown, which after a `/` filter is every match.
func (m *model) markAll() {
	ids := m.ids(0, len(m.view))
	if m.toggleMarks(ids) {
		m.flash(fmt.Sprintf("marked all %d", len(ids)))
	} else {
		m.flash("unmarked all")
	}
}

func (m *model) switchScope(to int) {
	if len(m.scopes) < 2 {
		return
	}
	m.at = ((to % len(m.scopes)) + len(m.scopes)) % len(m.scopes)
	m.all, m.stale = nil, false
	clear(m.marks)
	clear(m.touched)
	m.visual, m.query, m.cur, m.top = "", "", 0, 0
	var cached []issue
	if readCache("scope-"+m.scope().key(), &cached) {
		m.all, m.stale = cached, true
	}
	m.setView("")
	if m.live {
		m.cmds = append(m.cmds, m.loadCmd())
	}
}

// reload (R) reads the list again from scratch: issues changed here that left it go too.
func (m *model) reload() {
	clear(m.touched)
	if m.live {
		m.flash("reloading…")
		m.cmds = append(m.cmds, m.loadCmd())
	}
}

// send runs a change against Linear; list reads already under way are dropped.
func (m *model) send(cmd func() tea.Msg) {
	m.gen++
	m.inflight++
	if m.live {
		m.cmds = append(m.cmds, cmd)
	}
}

func (m *model) landed() { m.inflight = max(0, m.inflight-1) }

func (m *model) pushUndo(e undoEntry) {
	m.undo = append(m.undo, e)
	if len(m.undo) > undoDepth {
		m.undo = m.undo[1:]
	}
}

// survivor is where the cursor goes when ids leave the view: its own issue if that stays,
// else the next one down that does (the one above, at the end).
func (m *model) survivor(ids []string) string {
	gone := map[string]bool{}
	for _, id := range ids {
		gone[id] = true
	}
	shown := m.ids(0, len(m.view))
	at := min(m.cur, len(shown))
	for _, id := range shown[at:] {
		if !gone[id] {
			return id
		}
	}
	for i := at - 1; i >= 0; i-- {
		if !gone[shown[i]] {
			return shown[i]
		}
	}
	return ""
}

func (m *model) names(ids []string) string {
	if len(ids) == 1 {
		if n := m.find(ids[0]); n >= 0 {
			return m.all[n].Identifier
		}
	}
	return fmt.Sprintf("%d issues", len(ids))
}

// remove (x ; dd) moves the targets to Linear's trash. Now, no questions: `u` restores.
func (m *model) remove(n int) {
	ids, src := m.targets(n)
	if len(ids) == 0 {
		return
	}
	m.consume(src)
	keep := m.survivor(ids)
	var gone []issue
	for _, id := range ids {
		if at := m.find(id); at >= 0 {
			gone = append(gone, m.all[at])
		}
		m.deleted[id] = true
		delete(m.marks, id)
	}
	m.setView(keep)
	m.flash("deleting " + m.names(ids) + "…")
	a := m.api
	m.send(func() tea.Msg { return removedMsg{gone, a.remove(ids), false} })
}

func (m *model) onRemoved(msg removedMsg) {
	m.landed()
	ids := make([]string, len(msg.issues))
	for n, i := range msg.issues {
		ids[n] = i.ID
	}
	if msg.err != nil {
		for _, id := range ids {
			delete(m.deleted, id)
		}
		m.setView(m.selectedID())
		m.flashErr("couldn't delete: " + msg.err.Error())
		return
	}
	if msg.undo {
		m.flash("undid: deleted " + m.namesOf(msg.issues))
		return
	}
	m.flash("deleted " + m.namesOf(msg.issues))
	m.pushUndo(undoEntry{kind: "delete", issues: msg.issues})
}

func (m *model) namesOf(is []issue) string {
	if len(is) == 1 {
		return is[0].Identifier
	}
	return fmt.Sprintf("%d issues", len(is))
}

func (m *model) onRestored(msg restoredMsg) {
	m.landed()
	if msg.err != nil {
		for _, i := range msg.issues {
			m.deleted[i.ID] = true
		}
		m.setView(m.selectedID())
		m.pushUndo(undoEntry{kind: "delete", issues: msg.issues})
		m.flashErr("couldn't restore: " + msg.err.Error())
		return
	}
	m.flash("restored " + m.namesOf(msg.issues))
}

// fieldValue is what a change compares: the field as Linear stores it.
func fieldValue(field string, i issue) string {
	switch field {
	case fieldState:
		return i.State.ID
	case fieldPriority:
		return strconv.Itoa(i.Priority)
	case fieldAssignee:
		return i.assigneeID()
	}
	return i.Title
}

// setField copies the field from src.
func setField(field string, dst *issue, src issue) {
	switch field {
	case fieldState:
		dst.State = src.State
	case fieldPriority:
		dst.Priority = src.Priority
	case fieldAssignee:
		dst.Assignee = src.Assignee
	default:
		dst.Title = src.Title
	}
}

func inputFor(field string, i issue) map[string]any {
	switch field {
	case fieldState:
		return map[string]any{field: i.State.ID}
	case fieldPriority:
		return map[string]any{field: i.Priority}
	case fieldAssignee:
		if i.Assignee == nil {
			return map[string]any{field: nil}
		}
		return map[string]any{field: i.Assignee.ID}
	}
	return map[string]any{field: i.Title}
}

// change shows the changes at once and sends them, one batch per distinct value. undo: it
// takes an earlier change back, so it isn't itself undoable. note goes with the result.
func (m *model) change(field string, cs []change, undo bool, note string) {
	var real []change
	for _, c := range cs {
		if fieldValue(field, c.before) != fieldValue(field, c.after) {
			real = append(real, c)
		}
	}
	if len(real) == 0 {
		if note != "" {
			m.flashErr(note)
		} else {
			m.flash("nothing to change")
		}
		return
	}
	groups := map[string][]string{}
	inputs := map[string]map[string]any{}
	var keys []string
	now := time.Now()
	for _, c := range real {
		in := inputFor(field, c.after)
		b, _ := json.Marshal(in)
		key := string(b)
		if _, ok := groups[key]; !ok {
			keys = append(keys, key)
			inputs[key] = in
		}
		groups[key] = append(groups[key], c.after.ID)
		if at := m.find(c.after.ID); at >= 0 {
			setField(field, &m.all[at], c.after)
			// Linear will say it was just updated: sort it there now, so the reply doesn't
			// reorder the list under the cursor.
			m.all[at].Updated = now
		}
		m.touched[c.after.ID] = true
	}
	// The cursor keeps its row: a changed issue moves off to its new place and the next one
	// slides up under the cursor, ready for the next key.
	m.setView("")
	a := m.api
	m.send(func() tea.Msg {
		var got []issue
		for _, key := range keys {
			is, err := a.update(groups[key], inputs[key])
			got = append(got, is...)
			if err != nil {
				return updatedMsg{field, real, got, err, undo, note}
			}
		}
		return updatedMsg{field, real, got, nil, undo, note}
	})
}

func (m *model) onUpdated(msg updatedMsg) {
	m.landed()
	// Whatever Linear says now is the truth (a failed batch may have done some).
	done := map[string]bool{}
	for _, i := range msg.issues {
		done[i.ID] = true
		if at := m.find(i.ID); at >= 0 {
			m.all[at] = i
		}
	}
	if msg.err != nil {
		for _, c := range msg.changes {
			at := m.find(c.after.ID)
			if !done[c.after.ID] && at >= 0 && fieldValue(msg.field, m.all[at]) == fieldValue(msg.field, c.after) {
				setField(msg.field, &m.all[at], c.before)
			}
		}
		m.setView(m.selectedID())
		m.flashErr("couldn't change: " + msg.err.Error())
		return
	}
	m.setView(m.selectedID())
	ids := make([]string, len(msg.changes))
	for n, c := range msg.changes {
		ids[n] = c.after.ID
	}
	what := describe(msg.field, msg.changes[0].after)
	if msg.undo {
		m.flash("undid: " + m.names(ids) + " → " + what)
		return
	}
	if msg.note != "" {
		m.flashErr(m.names(ids) + " → " + what + " · " + msg.note)
	} else {
		m.flash(m.names(ids) + " → " + what)
	}
	m.pushUndo(undoEntry{kind: "update", field: msg.field, changes: msg.changes})
}

// describe is the new value, for the flash.
func describe(field string, i issue) string {
	switch field {
	case fieldState:
		return i.State.Name
	case fieldPriority:
		return priorityName(i.Priority)
	case fieldAssignee:
		if i.Assignee == nil {
			return "unassigned"
		}
		return i.Assignee.Name
	}
	return "“" + i.Title + "”"
}

// undoLast (u) takes back the last change, delete or create.
func (m *model) undoLast() {
	if len(m.undo) == 0 {
		m.flash("nothing to undo")
		return
	}
	e := m.undo[len(m.undo)-1]
	m.undo = m.undo[:len(m.undo)-1]
	a := m.api
	switch e.kind {
	case "update":
		var back []change
		for _, c := range e.changes {
			cur := c.after
			if at := m.find(c.after.ID); at >= 0 {
				cur = m.all[at]
			}
			prev := cur
			setField(e.field, &prev, c.before)
			back = append(back, change{before: cur, after: prev})
		}
		m.change(e.field, back, true, "")
	case "delete":
		focus := ""
		for _, i := range e.issues {
			delete(m.deleted, i.ID)
			m.touched[i.ID] = true
			if m.find(i.ID) < 0 {
				m.all = append(m.all, i)
			}
			if focus == "" {
				focus = i.ID
			}
		}
		m.setView(focus)
		ids := make([]string, len(e.issues))
		for n, i := range e.issues {
			ids[n] = i.ID
		}
		m.flash("restoring " + m.namesOf(e.issues) + "…")
		is := e.issues
		m.send(func() tea.Msg { return restoredMsg{is, a.restore(ids)} })
	case "create":
		i := e.issues[0]
		keep := m.survivor([]string{i.ID})
		m.deleted[i.ID] = true
		m.setView(keep)
		m.send(func() tea.Msg { return removedMsg{e.issues, a.remove([]string{i.ID}), true} })
	}
}

func (m *model) teamOf(i issue) team {
	t, _ := m.meta.team(i.TeamID)
	return t
}

// openStatus (c) opens the status picker with the cursor issue's team's workflow, numbered
// as Linear orders it: triage 0, backlog, todo, in progress, …, canceled, duplicate.
func (m *model) openStatus(n int) {
	cur, ok := m.selected()
	ids, src := m.targets(n)
	if !ok || len(ids) == 0 {
		return
	}
	t := m.teamOf(cur)
	states := t.sortedStates()
	if len(states) == 0 {
		m.flashErr("no workflow states for " + m.meta.teamKey(cur.TeamID) + " yet")
		return
	}
	p := &picker{kind: "status", title: "status for " + m.names(ids), targets: ids, src: src, teamID: t.ID}
	for k, s := range states {
		s := s
		num := -1
		if k < 10 {
			num = k
		}
		p.opts = append(p.opts, option{num: num, label: s.Name, state: &s, current: s.ID == cur.State.ID})
		if s.ID == cur.State.ID {
			p.sel = k
		}
	}
	m.picker = p
}

func (m *model) openPriority(n int) {
	cur, ok := m.selected()
	ids, src := m.targets(n)
	if !ok || len(ids) == 0 {
		return
	}
	p := &picker{kind: "priority", title: "priority for " + m.names(ids), targets: ids, src: src}
	for v := 0; v <= 4; v++ {
		p.opts = append(p.opts, option{num: v, label: priorityName(v), prio: v, current: v == cur.Priority})
		if v == cur.Priority {
			p.sel = v
		}
	}
	m.picker = p
}

func (m *model) openAssignee(n int) {
	ids, src := m.targets(n)
	if len(ids) == 0 {
		return
	}
	m.picker = &picker{kind: "assignee", title: "assignee for " + m.names(ids), targets: ids, src: src, opts: m.assigneeOptions(ids)}
	if m.people == nil && !m.peopleWait && m.live {
		m.peopleWait = true
		a := m.api
		m.cmds = append(m.cmds, func() tea.Msg {
			ps, err := a.people()
			return peopleMsg{ps, err}
		})
	}
}

// assigneeOptions: 0 unassigned, 1 you, then everyone else by name.
func (m *model) assigneeOptions(ids []string) []option {
	cur := ""
	if len(ids) > 0 {
		if at := m.find(ids[0]); at >= 0 {
			cur = m.all[at].assigneeID()
		}
	}
	me := m.meta.Viewer
	opts := []option{{num: 0, label: "unassigned", current: cur == ""}, {num: 1, label: me.Name + " (me)", who: &me, current: cur == me.ID}}
	others := make([]person, 0, len(m.people))
	for _, p := range m.people {
		if p.ID != me.ID {
			others = append(others, p)
		}
	}
	sort.SliceStable(others, func(a, b int) bool { return strings.ToLower(others[a].Name) < strings.ToLower(others[b].Name) })
	for k, p := range others {
		p := p
		num := -1
		if k+2 < 10 {
			num = k + 2
		}
		label := p.Name
		if p.Full != "" && !strings.EqualFold(p.Full, p.Name) && !strings.Contains(p.Full, "@") {
			label += " · " + p.Full
		}
		opts = append(opts, option{num: num, label: label, who: &p, current: cur == p.ID})
	}
	return opts
}

// pickerKey: digits pick at once; j/k (↑↓ ^n ^p) move and ⏎ picks; in the status and
// priority pickers a letter jumps to the next choice starting with it, in the assignee
// picker letters narrow the list. esc cancels.
func (m *model) pickerKey(k tea.KeyPressMsg, s string) {
	p := m.picker
	shown := p.shown()
	move := func(d int) {
		if len(shown) > 0 {
			p.sel = ((p.sel+d)%len(shown) + len(shown)) % len(shown)
		}
	}
	switch s {
	case "esc", "ctrl+c":
		m.picker = nil
		return
	case "enter":
		if p.sel < len(shown) {
			m.pick(p.opts[shown[p.sel]])
		}
		return
	case "down", "ctrl+n", "ctrl+j", "tab":
		move(1)
		return
	case "up", "ctrl+p", "ctrl+k", "shift+tab":
		move(-1)
		return
	}
	if len(s) == 1 && s[0] >= '0' && s[0] <= '9' {
		for _, o := range p.opts {
			if o.num == int(s[0]-'0') {
				m.pick(o)
				return
			}
		}
		return
	}
	if p.kind == "assignee" {
		if f, ok := editLine(p.filter, k, s); ok {
			p.filter, p.sel = f, 0
		}
		return
	}
	switch s {
	case "j":
		move(1)
	case "k":
		move(-1)
	default:
		if len([]rune(k.Text)) != 1 || k.Mod&(tea.ModCtrl|tea.ModAlt|tea.ModSuper) != 0 {
			return
		}
		want := strings.ToLower(k.Text)
		for d := 1; d <= len(shown); d++ {
			at := (p.sel + d) % len(shown)
			if strings.HasPrefix(strings.ToLower(p.opts[shown[at]].label), want) {
				p.sel = at
				return
			}
		}
	}
}

// pick applies the chosen option to the picker's issues.
func (m *model) pick(o option) {
	p := m.picker
	m.picker = nil
	m.consume(p.src)
	var cs []change
	skipped := 0
	for _, id := range p.targets {
		at := m.find(id)
		if at < 0 {
			continue
		}
		before := m.all[at]
		after := before
		switch p.kind {
		case "status":
			st, ok := m.stateFor(*o.state, p.teamID, before.TeamID)
			if !ok {
				skipped++
				continue
			}
			after.State = st
			cs = append(cs, change{before, after})
		case "priority":
			after.Priority = o.prio
			cs = append(cs, change{before, after})
		case "assignee":
			after.Assignee = o.who
			cs = append(cs, change{before, after})
		}
	}
	field := map[string]string{"status": fieldState, "priority": fieldPriority, "assignee": fieldAssignee}[p.kind]
	m.change(field, cs, false, skippedNote(skipped, o.label))
}

func skippedNote(skipped int, label string) string {
	if skipped == 0 {
		return ""
	}
	return fmt.Sprintf("%d in a team without “%s” left as %s", skipped, label, map[bool]string{true: "it was", false: "they were"}[skipped == 1])
}

// statusSlots are ^0–^7, the same in every team (the c picker's numbers shift with the team's
// workflow): the most used first under ^1 ^2 ^3. Each finds its state in the issue's own team
// by name, then by type; In Review only by name, since by type it would be In Progress.
var statusSlots = [...]struct{ name, typ string }{
	{"Triage", "triage"},
	{"Done", "completed"},
	{"In Progress", "started"},
	{"Todo", "unstarted"},
	{"In Review", ""},
	{"Backlog", "backlog"},
	{"Canceled", "canceled"},
	{"Duplicate", "duplicate"},
}

// slotState is statusSlots[slot] in the team; names match ignoring case and punctuation
// (In-progress is In Progress).
func (m *model) slotState(slot int, teamID string) (state, bool) {
	sl := statusSlots[slot]
	t, ok := m.meta.team(teamID)
	if !ok {
		return state{}, false
	}
	squash := func(s string) string {
		return strings.Map(func(r rune) rune {
			if unicode.IsLetter(r) || unicode.IsDigit(r) {
				return unicode.ToLower(r)
			}
			return -1
		}, s)
	}
	for _, x := range t.States {
		if squash(x.Name) == squash(sl.name) {
			return x, true
		}
	}
	if sl.typ != "" {
		for _, x := range t.sortedStates() {
			if x.Type == sl.typ {
				return x, true
			}
		}
	}
	return state{}, false
}

// setStatus (^0–^7) moves the targets to a status slot at once, no picker.
func (m *model) setStatus(slot, n int) {
	ids, src := m.targets(n)
	if len(ids) == 0 {
		return
	}
	m.consume(src)
	var cs []change
	skipped := 0
	for _, id := range ids {
		at := m.find(id)
		if at < 0 {
			continue
		}
		before := m.all[at]
		st, ok := m.slotState(slot, before.TeamID)
		if !ok {
			skipped++
			continue
		}
		after := before
		after.State = st
		cs = append(cs, change{before, after})
	}
	m.change(fieldState, cs, false, skippedNote(skipped, statusSlots[slot].name))
}

// stateFor is the state in team `to` that matches s from team `from`: itself, the one with the
// same name, or the first of the same type.
func (m *model) stateFor(s state, from, to string) (state, bool) {
	if from == to {
		return s, true
	}
	t, ok := m.meta.team(to)
	if !ok {
		return state{}, false
	}
	for _, x := range t.States {
		if strings.EqualFold(x.Name, s.Name) {
			return x, true
		}
	}
	for _, x := range t.sortedStates() {
		if x.Type == s.Type {
			return x, true
		}
	}
	return state{}, false
}

// rename (r) edits the cursor issue's title in the status line.
func (m *model) rename() {
	cur, ok := m.selected()
	if !ok {
		return
	}
	m.prompt = &prompt{kind: "rename", label: "title " + cur.Identifier + ": ", text: cur.Title, id: cur.ID}
}

// newIssue (n) types a title for a new issue in the cursor issue's team and status (todo when
// that's closed), assigned to you in "my issues".
func (m *model) newIssue() {
	var t team
	var st state
	if cur, ok := m.selected(); ok {
		t = m.teamOf(cur)
		if !cur.State.closed() && t.ID != "" {
			st = cur.State
		}
	}
	if t.ID == "" && m.scope().Kind == scopeTeam {
		t, _ = m.meta.team(m.scope().Team.ID)
	}
	if t.ID == "" {
		for _, x := range m.meta.Teams {
			if x.Mine {
				t = x
				break
			}
		}
	}
	if t.ID == "" {
		m.flashErr("no team to create the issue in")
		return
	}
	if st.ID == "" {
		for _, x := range t.sortedStates() {
			if x.Type == "unstarted" {
				st = x
				break
			}
		}
	}
	in := map[string]any{"teamId": t.ID}
	label := "new " + t.Key + " issue"
	if st.ID != "" {
		in["stateId"] = st.ID
		label += " in " + st.Name
	}
	if m.scope().Kind == scopeMine && m.meta.Viewer.ID != "" {
		in["assigneeId"] = m.meta.Viewer.ID
	}
	m.prompt = &prompt{kind: "new", label: label + ": ", input: in}
}

// promptKey: ⏎ saves, esc cancels.
func (m *model) promptKey(k tea.KeyPressMsg, s string) {
	p := m.prompt
	if p.posting {
		return
	}
	switch s {
	case "esc":
		m.prompt = nil
		return
	case "enter":
		if p.kind != "comment" {
			m.prompt = nil
		}
		text := strings.TrimSpace(p.text)
		if text == "" {
			return
		}
		switch p.kind {
		case "rename":
			if at := m.find(p.id); at >= 0 {
				after := m.all[at]
				after.Title = text
				m.change(fieldTitle, []change{{m.all[at], after}}, false, "")
			}
		case "new":
			in := map[string]any{"title": text}
			for k, v := range p.input {
				in[k] = v
			}
			m.flash("creating “" + text + "”…")
			a := m.api
			m.send(func() tea.Msg {
				i, err := a.create(in)
				return createdMsg{i, err}
			})
		case "comment":
			if !m.live {
				return
			}
			p.posting, p.err = true, nil
			a, id := m.api, p.id
			m.send(func() tea.Msg {
				return commentedMsg{a.comment(id, text)}
			})
		}
		return
	}
	if t, ok := editLine(p.text, k, s); ok {
		p.text = t
	}
}

func (m *model) onCreated(msg createdMsg) {
	m.landed()
	if msg.err != nil {
		m.flashErr("couldn't create: " + msg.err.Error())
		return
	}
	m.all = append(m.all, msg.issue)
	m.touched[msg.issue.ID] = true
	m.setView(msg.issue.ID)
	m.flash("created " + msg.issue.Identifier)
	m.pushUndo(undoEntry{kind: "create", issues: []issue{msg.issue}})
}

// open (o gx) opens the cursor issue in Linear.
func (m *model) open() {
	cur, ok := m.selected()
	if !ok || !m.live {
		return
	}
	open, url := m.opener, cur.URL
	m.cmds = append(m.cmds, func() tea.Msg { return flashMsg{"opened " + cur.Identifier, open(url)} })
}

// copyField (y Y B) copies the identifier, URL or git branch name.
func (m *model) copyField(what string) {
	cur, ok := m.selected()
	if !ok || !m.live {
		return
	}
	text := map[string]string{"identifier": cur.Identifier, "url": cur.URL, "branch": cur.Branch}[what]
	if text == "" {
		m.flashErr("no " + what)
		return
	}
	cp := m.copier
	m.cmds = append(m.cmds, func() tea.Msg { return flashMsg{"copied " + text, cp(text)} })
}

func openURL(url string) error { return exec.Command("open", url).Run() }

func copyText(s string) error {
	c := exec.Command("pbcopy")
	c.Stdin = strings.NewReader(s)
	return c.Run()
}

// statusRank orders states for the list: triage, then in progress (furthest along first),
// todo, backlog, then the closed ones.
func statusRank(s state) int {
	switch s.Type {
	case "triage":
		return 0
	case "started":
		return 1
	case "unstarted":
		return 2
	case "backlog":
		return 3
	case "completed":
		return 4
	case "canceled":
		return 5
	case "duplicate":
		return 6
	}
	return 7
}

func statusPos(s state) float64 {
	if s.Type == "started" {
		return -s.Position
	}
	return s.Position
}

// prioRank puts urgent first and no priority last.
func prioRank(p int) int {
	if p == 0 {
		return 5
	}
	return p
}

func (m *model) includes(i issue) bool {
	return !m.deleted[i.ID] &&
		(m.showBacklog || i.State.Type != "backlog") &&
		(!m.hideTriage || i.State.Type != "triage")
}

// setView recomputes what's shown (filter, order, headings), keeping the cursor on issue keep
// when it's still there and on the same row otherwise.
func (m *model) setView(keep string) {
	words := strings.Fields(strings.ToLower(m.query))
	view := []int{}
	for n, i := range m.all {
		if m.includes(i) && i.matches(words) {
			view = append(view, n)
		}
	}
	all := m.all
	// A status group spans teams by name; it sits where its earliest state does.
	groupPos := map[string]float64{}
	gkey := func(i issue) string { return strconv.Itoa(statusRank(i.State)) + strings.ToLower(i.State.Name) }
	for _, n := range view {
		k := gkey(all[n])
		if p, ok := groupPos[k]; !ok || statusPos(all[n].State) < p {
			groupPos[k] = statusPos(all[n].State)
		}
	}
	byStatus := func(a, b issue) int {
		if ra, rb := statusRank(a.State), statusRank(b.State); ra != rb {
			return ra - rb
		}
		ka, kb := gkey(a), gkey(b)
		if ka != kb {
			if groupPos[ka] != groupPos[kb] {
				if groupPos[ka] < groupPos[kb] {
					return -1
				}
				return 1
			}
			return strings.Compare(ka, kb)
		}
		return 0
	}
	byPrio := func(a, b issue) int { return prioRank(a.Priority) - prioRank(b.Priority) }
	newer := func(a, b issue) bool {
		if !a.Updated.Equal(b.Updated) {
			return a.Updated.After(b.Updated)
		}
		return a.Identifier < b.Identifier
	}
	projects := map[string]int{}
	for _, n := range view {
		projects[all[n].Project]++
	}
	sort.SliceStable(view, func(x, y int) bool {
		a, b := all[view[x]], all[view[y]]
		switch m.order {
		case orderPriority:
			if c := byPrio(a, b); c != 0 {
				return c < 0
			}
			if c := byStatus(a, b); c != 0 {
				return c < 0
			}
		case orderStale:
			if !a.Updated.Equal(b.Updated) {
				return a.Updated.Before(b.Updated)
			}
		case orderProject:
			if a.Project != b.Project {
				if (a.Project == "") != (b.Project == "") {
					return b.Project == ""
				}
				if projects[a.Project] != projects[b.Project] {
					return projects[a.Project] > projects[b.Project]
				}
				return a.Project < b.Project
			}
			if c := byStatus(a, b); c != 0 {
				return c < 0
			}
			if c := byPrio(a, b); c != 0 {
				return c < 0
			}
		default:
			if c := byStatus(a, b); c != 0 {
				return c < 0
			}
			if c := byPrio(a, b); c != 0 {
				return c < 0
			}
		}
		return newer(a, b)
	})
	m.view = view
	if at := m.pos(keep); at >= 0 {
		m.cur = at
	}
	m.cur = max(0, min(m.cur, len(m.view)-1))
	m.buildRows()
}

// buildRows puts headings between the issues: statuses, priorities, ages or projects.
func (m *model) buildRows() {
	m.rows = m.rows[:0]
	type group struct {
		name string
		st   *state
		team string
	}
	var groupOf func(i issue) group
	switch m.order {
	case orderPriority:
		groupOf = func(i issue) group { return group{name: priorityName(i.Priority)} }
	case orderStale:
		now := time.Now()
		groupOf = func(i issue) group {
			d := now.Sub(i.Updated)
			switch {
			case d >= 30*24*time.Hour:
				return group{name: "updated over a month ago"}
			case d >= 7*24*time.Hour:
				return group{name: "updated over a week ago"}
			case d >= 24*time.Hour:
				return group{name: "updated over a day ago"}
			}
			return group{name: "updated today"}
		}
	case orderProject:
		groupOf = func(i issue) group {
			if i.Project == "" {
				return group{name: "no project"}
			}
			return group{name: i.Project}
		}
	default:
		groupOf = func(i issue) group {
			st := i.State
			return group{name: i.State.Name, st: &st, team: i.TeamID}
		}
	}
	counts := map[string]int{}
	for _, n := range m.view {
		counts[strings.ToLower(groupOf(m.all[n]).name)]++
	}
	prev := "\x00"
	for k, n := range m.view {
		g := groupOf(m.all[n])
		if key := strings.ToLower(g.name); key != prev {
			m.rows = append(m.rows, row{header: fmt.Sprintf("%s · %d", g.name, counts[key]), state: g.st, team: g.team, k: -1})
			prev = key
		}
		m.rows = append(m.rows, row{k: k})
	}
}

// scroll keeps the cursor's issue, and the headings right above it, in view.
// rowOf is issue k's row in rows (headings included).
func (m *model) rowOf(k int) int {
	for i, x := range m.rows {
		if x.k == k {
			return i
		}
	}
	return 0
}

// halfPage (^d ^u) scrolls like vim: the list and the cursor move half a screen together, so
// the cursor keeps its screen row; at either end the list stops and the cursor goes on.
func (m *model) halfPage(dir int) {
	if len(m.rows) == 0 {
		return
	}
	h := m.listH()
	d := max(1, h/2)
	t := max(0, min(m.rowOf(m.cur)+dir*d, len(m.rows)-1))
	m.top = max(0, min(m.top+dir*d, len(m.rows)-h))
	// A heading isn't an issue: the first one under it.
	for t < len(m.rows)-1 && m.rows[t].k < 0 {
		t++
	}
	m.cur = m.rows[t].k
}

func (m *model) scroll() {
	h := m.listH()
	r := m.rowOf(m.cur)
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
