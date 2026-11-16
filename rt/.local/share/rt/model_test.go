package main

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

type fakeAPI struct {
	snap     snapshot
	closed   []string
	selected string
	fail     string
}

func (f *fakeAPI) snapshot() (snapshot, error) { return f.snap, nil }
func (f *fakeAPI) selectTab(id string) error   { f.selected = id; return nil }
func (f *fakeAPI) closeTab(id string) error {
	if id == f.fail {
		return errors.New("close failed")
	}
	f.closed = append(f.closed, id)
	var remaining []tab
	for _, t := range f.snap.Tabs {
		if t.ID != id {
			remaining = append(remaining, t)
		}
	}
	f.snap.Tabs = remaining
	return nil
}

func fixture() (*model, *fakeAPI) {
	f := &fakeAPI{snap: snapshot{Label: "code", Tabs: []tab{
		{ID: "window:a", Index: 1, Label: "first", Detail: "~/Code/a", Panes: 1},
		{ID: "window:b", Index: 3, Label: "second", Detail: "~/temp/b", Panes: 2},
		{ID: "window:c", Index: 4, Label: "third", Detail: "~/Code/c", Panes: 1},
		{ID: "window:d", Index: 5, Label: "last", Panes: 1},
	}}}
	return newModel(f, f.snap), f
}

func press(m *model, k string) tea.Cmd {
	key := tea.Key{Text: k}
	switch k {
	case "enter":
		key.Code, key.Text = tea.KeyEnter, ""
	case "esc":
		key.Code, key.Text = tea.KeyEsc, ""
	case "backspace":
		key.Code, key.Text = tea.KeyBackspace, ""
	default:
		key.Code = []rune(k)[0]
	}
	_, cmd := m.Update(tea.KeyPressMsg(key))
	return cmd
}

func TestMovementFilterAndIdentity(t *testing.T) {
	m, f := fixture()
	press(m, "2")
	press(m, "j")
	if m.currentID() != "window:c" {
		t.Fatal("counted movement", m.currentID())
	}
	press(m, "3")
	press(m, "G")
	if m.currentID() != "window:b" {
		t.Fatal("tab position must use the tab-strip index")
	}
	reordered := f.snap
	reordered.Tabs = []tab{f.snap.Tabs[2], f.snap.Tabs[0], f.snap.Tabs[1], f.snap.Tabs[3]}
	m.apply(reordered)
	if m.currentID() != "window:b" || m.cursor != 2 {
		t.Fatal("refresh lost selection")
	}
	press(m, "/")
	for _, r := range "code" {
		press(m, string(r))
	}
	press(m, "enter")
	if len(m.rows) != 2 || m.searching {
		t.Fatal("directory filtering failed", m.rows)
	}
	press(m, "esc")
	if len(m.rows) != 4 || m.query != "" {
		t.Fatal("Escape didn't clear filter")
	}
}

func TestSearchDoesNotCloseTabs(t *testing.T) {
	m, f := fixture()
	press(m, "/")
	press(m, ";")
	press(m, "x")
	press(m, "q")
	if m.query != ";xq" || len(f.closed) != 0 {
		t.Fatal("search executed list keys")
	}
	press(m, "esc")
	if m.query != "" || m.searching {
		t.Fatal("cancel search")
	}
	press(m, "/")
	press(m, "backspace") // empty UTF-8 backspace must be safe
	press(m, "界")
	press(m, "backspace")
	if m.query != "" {
		t.Fatal("UTF-8 backspace failed")
	}
}

func TestSessionFilterAndSwitchErrorSurviveRefresh(t *testing.T) {
	m, _ := fixture()
	m.snap.Tabs[1].Session = "servers"
	press(m, "/")
	for _, r := range "servers" {
		press(m, string(r))
	}
	press(m, "enter")
	if len(m.rows) != 1 || m.currentID() != "window:b" {
		t.Fatal("session filter", m.rows)
	}
	m.Update(selectedMsg{errors.New("Remote Control is off")})
	m.Update(loadedMsg{snap: m.snap, gen: m.generation})
	if !m.failed || m.message != "Remote Control is off" {
		t.Fatal("refresh hid switch failure")
	}
}

func TestCloseUsesCapturedIDsAndIgnoresStaleSnapshot(t *testing.T) {
	m, f := fixture()
	press(m, "m") // mark first, move to second
	press(m, "j")
	press(m, "m") // mark third
	cmd := press(m, ";")
	if cmd == nil || !m.busy {
		t.Fatal("no close command")
	}
	// An earlier refresh must not overwrite the list during a close.
	m.Update(loadedMsg{snap: snapshot{}, gen: 0})
	if len(m.rows) != 4 {
		t.Fatal("accepted stale refresh")
	}
	m.Update(cmd())
	if !reflect.DeepEqual(f.closed, []string{"window:a", "window:c"}) {
		t.Fatal("closed wrong IDs", f.closed)
	}
	if m.busy || len(m.marked) != 0 || len(m.rows) != 2 {
		t.Fatal("close did not settle")
	}
}

func TestVisualRangeAndPartialFailure(t *testing.T) {
	m, f := fixture()
	f.fail = "window:b"
	press(m, "v")
	press(m, "2")
	press(m, "j")
	cmd := press(m, ";")
	m.Update(cmd())
	if !reflect.DeepEqual(f.closed, []string{"window:a"}) {
		t.Fatal(f.closed)
	}
	if !m.failed || len(m.rows) != 3 {
		t.Fatal("failure hid unclosed tabs")
	}
	if m.rows[0].ID != "window:b" {
		t.Fatal("failed tab disappeared")
	}
}

func TestCountedCloseAndSelect(t *testing.T) {
	m, f := fixture()
	press(m, "2")
	m.Update(press(m, "x")())
	if len(f.closed) != 2 || m.currentID() != "window:c" {
		t.Fatal("counted close", f.closed)
	}
	cmd := press(m, "enter")
	_, quit := m.Update(cmd())
	if f.selected != "window:c" || quit == nil {
		t.Fatal("select did not dismiss")
	}
}

func TestEmptyListAndEscapeLayers(t *testing.T) {
	m, _ := fixture()
	press(m, "a")
	press(m, "v")
	if cmd := press(m, "esc"); cmd != nil || m.anchor != "" || len(m.marked) != 4 {
		t.Fatal("visual escape")
	}
	if cmd := press(m, "esc"); cmd != nil || len(m.marked) != 0 {
		t.Fatal("marks escape")
	}
	m.apply(snapshot{})
	for _, key := range []string{"j", "G", "m", "v", ";", "enter"} {
		if cmd := press(m, key); cmd != nil {
			t.Fatalf("empty list acted on %s", key)
		}
	}
	if press(m, "esc") == nil {
		t.Fatal("Escape should quit")
	}
}

func TestViewFitsTerminal(t *testing.T) {
	m, _ := fixture()
	m.snap.Label = "コード " + strings.Repeat("long", 50)
	m.rows[0].Label = "🦊" + strings.Repeat("界", 50)
	for _, help := range []bool{false, true} {
		m.help = help
		for _, size := range [][2]int{{10, 3}, {28, 9}, {60, 12}, {100, 30}} {
			m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
			text := m.View().Content
			lines := strings.Split(text, "\n")
			if len(lines) > size[1] {
				t.Fatalf("height %v: %d", size, len(lines))
			}
			for _, line := range lines {
				if ansi.StringWidth(line) > size[0] {
					t.Fatalf("width %v: %q", size, line)
				}
			}
		}
	}
}
