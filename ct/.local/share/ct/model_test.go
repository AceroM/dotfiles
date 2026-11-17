package main

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

type fakeBrowser struct {
	snap     snapshot
	closed   [][]int64
	reopened [][]gone
	focused  []int64
	failNext bool
	nextID   int64
}

func (f *fakeBrowser) name() string            { return "Chrome" }
func (f *fakeBrowser) list() (snapshot, error) { return f.snap, nil }

func (f *fakeBrowser) closeTabs(ids []int64) error {
	if f.failNext {
		f.failNext = false
		return errors.New("boom")
	}
	f.closed = append(f.closed, ids)
	gone := map[int64]bool{}
	for _, id := range ids {
		gone[id] = true
	}
	var keep []tab
	for _, t := range f.snap.Tabs {
		if !gone[t.ID] {
			keep = append(keep, t)
		}
	}
	f.snap.Tabs = keep
	return nil
}

func (f *fakeBrowser) focus(id int64) error {
	if f.failNext {
		f.failNext = false
		return errors.New("no tab with id")
	}
	f.focused = append(f.focused, id)
	return nil
}

func (f *fakeBrowser) reopen(gs []gone) ([]int64, int, error) {
	f.reopened = append(f.reopened, gs)
	var ids []int64
	for _, g := range gs {
		f.nextID++
		f.snap.Tabs = append(f.snap.Tabs, tab{ID: f.nextID, Window: g.Window, Index: g.Index, Title: g.Title, URL: g.URL, Group: g.Group})
		ids = append(ids, f.nextID)
	}
	f.snap.sortStrip()
	return ids, 0, nil
}

// Two windows; window 1 has a group. Tab 3 duplicates tab 1; 1, 2 and 3 share a site.
func fixture() (*model, *fakeBrowser) {
	f := &fakeBrowser{nextID: 100, snap: snapshot{
		Windows: []window{{ID: 1, Focused: true}, {ID: 2}},
		Groups:  map[int64]group{7: {Title: "work", Color: "blue", Window: 1}},
		Tabs: []tab{
			{ID: 1, Window: 1, Index: 0, Title: "Repo", URL: "https://github.com/a/b", Group: 7, Last: 1000},
			{ID: 2, Window: 1, Index: 1, Title: "Pull 12", URL: "https://github.com/a/b/pull/12", Group: 7, Last: 3000, Active: true},
			{ID: 3, Window: 1, Index: 2, Title: "Repo again", URL: "https://github.com/a/b#readme", Group: -1, Last: 2000},
			{ID: 4, Window: 2, Index: 0, Title: "Docs", URL: "https://go.dev/doc", Group: -1, Last: 500, Active: true},
			{ID: 5, Window: 2, Index: 1, Title: "Mail", URL: "https://mail.example.com/", Group: -1, Last: 100},
		},
	}}
	m := newModel(f, f.snap)
	m.width, m.height = 120, 20
	return m, f
}

func key(k string) tea.KeyPressMsg {
	switch k {
	case "esc":
		return tea.KeyPressMsg{Code: tea.KeyEscape}
	case "enter":
		return tea.KeyPressMsg{Code: tea.KeyEnter}
	case "backspace":
		return tea.KeyPressMsg{Code: tea.KeyBackspace}
	case "space":
		return tea.KeyPressMsg{Code: tea.KeySpace, Text: " "}
	}
	if c, ok := strings.CutPrefix(k, "ctrl+"); ok {
		return tea.KeyPressMsg{Code: []rune(c)[0], Mod: tea.ModCtrl}
	}
	return tea.KeyPressMsg{Code: []rune(k)[0], Text: k}
}

// press sends keys one at a time and runs whatever commands they start (closes, reopens),
// feeding their results back in.
func press(m *model, keys ...string) {
	for _, k := range keys {
		_, cmd := m.Update(key(k))
		drain(m, cmd)
	}
}

func drain(m *model, cmd tea.Cmd) {
	if cmd == nil {
		return
	}
	switch msg := cmd().(type) {
	case tea.BatchMsg:
		for _, c := range msg {
			drain(m, c)
		}
	case nil, tickMsg, tea.QuitMsg:
	default:
		_, next := m.Update(msg)
		drain(m, next)
	}
}

func typeText(m *model, s string) {
	for _, r := range s {
		press(m, string(r))
	}
}

func shown(m *model) []int64 { return m.ids(0, len(m.view)) }

func TestStartsOnTheTabUsedLastAndMovesWithCounts(t *testing.T) {
	m, _ := fixture()
	if m.selectedID() != 2 {
		t.Fatalf("start on the active tab used last, got %d", m.selectedID())
	}
	press(m, "2", "j")
	if m.selectedID() != 4 {
		t.Fatalf("2j: got %d", m.selectedID())
	}
	press(m, "g")
	if m.cur != 0 {
		t.Fatal("g goes to the first tab")
	}
	press(m, "G")
	if m.selectedID() != 5 {
		t.Fatal("G goes to the last tab")
	}
	press(m, "3", "G")
	if m.selectedID() != 3 {
		t.Fatalf("3G goes to tab 3, got %d", m.selectedID())
	}
	press(m, "9", "esc")
	if m.count != 0 || m.quitting {
		t.Fatal("esc drops a half-typed count and nothing else")
	}
}

func TestCloseMovesToTheNextTabAndUndoReopens(t *testing.T) {
	m, f := fixture()
	press(m, "g", "x")
	if !reflect.DeepEqual(f.closed, [][]int64{{1}}) {
		t.Fatalf("closed %v", f.closed)
	}
	if m.selectedID() != 2 {
		t.Fatalf("cursor should land on the next tab, got %d", m.selectedID())
	}
	if !strings.Contains(m.msg, "closed Repo") {
		t.Fatalf("flash: %q", m.msg)
	}
	press(m, "u")
	if len(f.reopened) != 1 || f.reopened[0][0].URL != "https://github.com/a/b" || f.reopened[0][0].Group != 7 {
		t.Fatalf("reopen: %+v", f.reopened)
	}
	if m.selectedID() != 101 {
		t.Fatalf("cursor goes to the reopened tab, got %d", m.selectedID())
	}
	press(m, "u")
	if m.msg != "nothing to reopen" {
		t.Fatalf("flash: %q", m.msg)
	}
}

func TestEnterShowsTheTabAndStaysOpen(t *testing.T) {
	m, f := fixture()
	press(m, "j", "enter")
	if !reflect.DeepEqual(f.focused, []int64{3}) {
		t.Fatalf("focused %v", f.focused)
	}
	if m.quitting || m.msg != "showing Repo again" {
		t.Fatalf("quitting=%v flash %q", m.quitting, m.msg)
	}
	// ⏎ while typing a filter only keeps it; the next ⏎ shows the match.
	press(m, "/")
	typeText(m, "docs")
	press(m, "enter")
	if len(f.focused) != 1 || m.typing {
		t.Fatalf("first ⏎ keeps the filter: focused %v typing %v", f.focused, m.typing)
	}
	press(m, "enter")
	if !reflect.DeepEqual(f.focused, []int64{3, 4}) {
		t.Fatalf("focused %v", f.focused)
	}
	f.failNext = true
	press(m, "enter")
	if !m.msgBad || !strings.Contains(m.msg, "couldn't show it") {
		t.Fatalf("flash %q bad=%v", m.msg, m.msgBad)
	}
}

func TestCountCloseMarksAndVisual(t *testing.T) {
	m, f := fixture()
	press(m, "g", "2", "x")
	if !reflect.DeepEqual(f.closed[0], []int64{1, 2}) {
		t.Fatalf("2x: %v", f.closed)
	}
	m, f = fixture()
	press(m, "g", "space", "j", "space")
	if !m.marks[1] || !m.marks[3] || len(m.marks) != 2 {
		t.Fatalf("marks: %v", m.marks)
	}
	press(m, ";")
	if !reflect.DeepEqual(f.closed[0], []int64{1, 3}) || len(m.marks) != 0 {
		t.Fatalf("; closes the marks: %v", f.closed)
	}
	m, f = fixture()
	press(m, "g", "v", "j", "j", ";")
	if !reflect.DeepEqual(f.closed[0], []int64{1, 2, 3}) || m.visual != none {
		t.Fatalf("; closes the visual range: %v", f.closed)
	}
}

func TestNeverClosesEveryTab(t *testing.T) {
	m, f := fixture()
	press(m, "a", ";")
	if len(f.closed) != 0 || !strings.Contains(m.msg, "every tab") {
		t.Fatalf("closed %v, flash %q", f.closed, m.msg)
	}
}

func TestFailedCloseShowsTheTabsAgain(t *testing.T) {
	m, f := fixture()
	f.failNext = true
	press(m, "g", "x")
	if len(m.view) != 5 || !m.msgBad {
		t.Fatalf("view %v, flash %q", shown(m), m.msg)
	}
}

func TestSiteDuplicatesAndAll(t *testing.T) {
	m, _ := fixture()
	press(m, "g", "*")
	if len(m.marks) != 3 {
		t.Fatalf("* marks the site's 3 tabs: %v", m.marks)
	}
	press(m, "*")
	if len(m.marks) != 0 {
		t.Fatal("* again unmarks them")
	}
	press(m, "D")
	if !reflect.DeepEqual(m.marks, map[int64]bool{1: true}) {
		t.Fatalf("D keeps the copy used last (3): %v", m.marks)
	}
	press(m, "esc", "a")
	if len(m.marks) != 5 {
		t.Fatal("a marks everything shown")
	}
}

func TestFilterThenMarkAllAndEscapeOrder(t *testing.T) {
	m, f := fixture()
	press(m, "/")
	typeText(m, "github pull")
	if !reflect.DeepEqual(shown(m), []int64{2}) {
		t.Fatalf("filter: %v", shown(m))
	}
	press(m, "backspace", "backspace", "backspace", "backspace", "backspace")
	if len(m.view) != 3 {
		t.Fatalf("backspace widens it: %v", shown(m))
	}
	press(m, "ctrl+w")
	if m.query != "" || len(m.view) != 5 {
		t.Fatalf("^w drops the word: %q", m.query)
	}
	typeText(m, "github")
	press(m, "enter", "a", ";")
	if !reflect.DeepEqual(f.closed[0], []int64{1, 2, 3}) {
		t.Fatalf("a after a filter marks the matches: %v", f.closed)
	}
	press(m, "v", "space")
	if len(m.marks) != 0 {
		t.Fatal("nothing left to mark under the filter")
	}
	press(m, "esc")
	if m.query != "" || m.quitting {
		t.Fatal("esc drops the filter before quitting")
	}
	press(m, "esc")
	if !m.quitting {
		t.Fatal("esc with nothing to undo quits")
	}
}

func TestOrdersAndHeadings(t *testing.T) {
	m, _ := fixture()
	var heads []string
	for _, r := range m.rows {
		if r.k < 0 {
			heads = append(heads, r.header)
		}
	}
	if !reflect.DeepEqual(heads, []string{"window 1 · in front", "work", "window 2"}) {
		t.Fatalf("strip headings: %v", heads)
	}
	press(m, "s")
	if !reflect.DeepEqual(shown(m), []int64{1, 2, 3, 4, 5}) || m.rows[0].header != "github.com · 3" {
		t.Fatalf("by site: %v %v", shown(m), m.rows[0])
	}
	press(m, "s")
	if !reflect.DeepEqual(shown(m), []int64{5, 4, 1, 3, 2}) {
		t.Fatalf("least recently used first: %v", shown(m))
	}
	if m.selectedID() != 2 {
		t.Fatal("changing the order keeps the cursor's tab")
	}
}

func TestRefreshKeepsTheCursorsTab(t *testing.T) {
	m, f := fixture()
	press(m, "G")
	s := f.snap
	s.Tabs = append([]tab{{ID: 9, Window: 1, Index: 0, URL: "https://new.example"}}, s.Tabs...)
	m.Update(loadedMsg{snap: s})
	if m.selectedID() != 5 {
		t.Fatalf("got %d", m.selectedID())
	}
}

func TestDrawsPlainLinesThatFit(t *testing.T) {
	for _, size := range [][2]int{{120, 20}, {60, 12}, {30, 6}} {
		m, _ := fixture()
		m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
		press(m, "g", "space")
		lines := strings.Split(m.render(), "\n")
		if len(lines) != size[1] {
			t.Fatalf("%v: %d lines", size, len(lines))
		}
		for _, l := range lines {
			if w := ansi.StringWidth(l); w > size[0] {
				t.Fatalf("%v: line is %d wide: %q", size, w, ansi.Strip(l))
			}
			if strings.ContainsAny(ansi.Strip(l), "╭╮╰╯│─") {
				t.Fatalf("%v: no box: %q", size, ansi.Strip(l))
			}
		}
	}
}

func TestSnapshotKeys(t *testing.T) {
	m, f := fixture()
	out := snapshotFrame(m, 100, 12, parseKeys("gx<c-d>?"))
	if len(f.closed) != 0 {
		t.Fatal("--snapshot never closes anything")
	}
	if !strings.Contains(out, "next / previous") {
		t.Fatalf("? shows the keys:\n%s", out)
	}
}

func TestHostAndShortURL(t *testing.T) {
	for url, want := range map[string]string{
		"https://www.github.com/a/b?x=1": "github.com",
		"http://localhost:3038/x":        "localhost:3038",
		"file:///Users/me/a.html":        "file",
		"chrome://settings/people":       "chrome://settings",
		"chrome://newtab?x=/y":           "chrome://newtab",
	} {
		if got := (tab{URL: url}).host(); got != want {
			t.Errorf("host(%q) = %q, want %q", url, got, want)
		}
	}
	if got := (tab{URL: "https://www.github.com/a/"}).shortURL(); got != "github.com/a" {
		t.Errorf("shortURL = %q", got)
	}
}
