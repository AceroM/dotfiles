package main

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

type call struct {
	ids   []string
	input map[string]any
}

type fakeLinear struct {
	m        meta
	lists    map[string][]issue
	updates  []call
	removed  [][]string
	restored [][]string
	created  []map[string]any
	failNext bool
	ppl      []person
	next     int
}

func (f *fakeLinear) meta() (meta, error) { return f.m, nil }
func (f *fakeLinear) issues(s scope) ([]issue, error) {
	return append([]issue(nil), f.lists[s.key()]...), nil
}
func (f *fakeLinear) people() ([]person, error)             { return f.ppl, nil }
func (f *fakeLinear) description(id string) (string, error) { return "about " + id, nil }

func (f *fakeLinear) stateByID(id string) state {
	for _, t := range f.m.Teams {
		for _, s := range t.States {
			if s.ID == id {
				return s
			}
		}
	}
	return state{}
}

func (f *fakeLinear) update(ids []string, input map[string]any) ([]issue, error) {
	if f.failNext {
		f.failNext = false
		return nil, errors.New("boom")
	}
	f.updates = append(f.updates, call{ids, input})
	var out []issue
	for _, id := range ids {
		for k, i := range f.lists["mine"] {
			if i.ID != id {
				continue
			}
			for field, v := range input {
				switch field {
				case fieldState:
					i.State = f.stateByID(v.(string))
				case fieldPriority:
					i.Priority = v.(int)
				case fieldAssignee:
					i.Assignee = nil
					if v != nil {
						i.Assignee = &person{ID: v.(string), Name: v.(string)}
					}
				case fieldTitle:
					i.Title = v.(string)
				}
			}
			i.Updated = time.Now()
			f.lists["mine"][k] = i
			out = append(out, i)
		}
	}
	return out, nil
}

func (f *fakeLinear) remove(ids []string) error {
	if f.failNext {
		f.failNext = false
		return errors.New("boom")
	}
	f.removed = append(f.removed, ids)
	return nil
}

func (f *fakeLinear) restore(ids []string) error {
	f.restored = append(f.restored, ids)
	return nil
}

func (f *fakeLinear) create(input map[string]any) (issue, error) {
	f.created = append(f.created, input)
	f.next++
	return issue{
		ID: fmt.Sprintf("new%d", f.next), Identifier: fmt.Sprintf("ENG-%d", 100+f.next), Title: input["title"].(string),
		State: f.stateByID(fmt.Sprint(input["stateId"])), TeamID: input["teamId"].(string), Updated: time.Now(),
	}, nil
}

// Two teams. ENG has no triage and a later started state (review); OPS has triage, a started
// state named differently, and duplicate.
func testMeta() meta {
	return meta{
		Viewer: person{ID: "me", Name: "me"},
		Teams: []team{
			{ID: "eng", Key: "ENG", Name: "Engineering", Mine: true, States: []state{
				{ID: "e-backlog", Name: "Backlog", Type: "backlog", Position: 0},
				{ID: "e-todo", Name: "Todo", Type: "unstarted", Position: 1},
				{ID: "e-prog", Name: "In Progress", Type: "started", Position: 2},
				{ID: "e-review", Name: "In Review", Type: "started", Position: 1000},
				{ID: "e-done", Name: "Done", Type: "completed", Position: 3},
				{ID: "e-cancel", Name: "Canceled", Type: "canceled", Position: 4},
			}},
			{ID: "ops", Key: "OPS", Name: "Operations", Mine: true, States: []state{
				{ID: "o-triage", Name: "Triage", Type: "triage", Position: 0},
				{ID: "o-backlog", Name: "Backlog", Type: "backlog", Position: 0},
				{ID: "o-todo", Name: "Todo", Type: "unstarted", Position: 1},
				{ID: "o-doing", Name: "Doing", Type: "started", Position: 2},
				{ID: "o-done", Name: "Done", Type: "completed", Position: 3},
				{ID: "o-cancel", Name: "Canceled", Type: "canceled", Position: 4},
				{ID: "o-dup", Name: "Duplicate", Type: "duplicate", Position: 5},
			}},
		},
	}
}

func fixture(t *testing.T) (*model, *fakeLinear) {
	t.Helper()
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	now := time.Now()
	f := &fakeLinear{m: testMeta()}
	st := func(id string) state { return f.stateByID(id) }
	me := &person{ID: "me", Name: "me"}
	f.lists = map[string][]issue{"mine": {
		{ID: "e1", Identifier: "ENG-1", Title: "Fix login", State: st("e-prog"), TeamID: "eng", Priority: 2, Updated: now.Add(-time.Hour), Assignee: me, URL: "https://linear.app/x/issue/ENG-1", Branch: "me/eng-1-fix-login"},
		{ID: "e2", Identifier: "ENG-2", Title: "Write docs", State: st("e-todo"), TeamID: "eng", Priority: 0, Updated: now.Add(-48 * time.Hour), Assignee: me},
		{ID: "e3", Identifier: "ENG-3", Title: "Ship billing", State: st("e-review"), TeamID: "eng", Priority: 1, Updated: now.Add(-3 * time.Hour), Assignee: me, Project: "Billing"},
		{ID: "o1", Identifier: "OPS-1", Title: "Rotate keys", State: st("o-triage"), TeamID: "ops", Priority: 3, Updated: now.Add(-5 * time.Hour), Assignee: me},
		{ID: "o2", Identifier: "OPS-2", Title: "Clean bucket", State: st("o-backlog"), TeamID: "ops", Priority: 4, Updated: now.Add(-10 * time.Hour), Assignee: me, Labels: []string{"chore"}},
		{ID: "e4", Identifier: "ENG-4", Title: "Old idea", State: st("e-backlog"), TeamID: "eng", Priority: 0, Updated: now.Add(-60 * 24 * time.Hour), Assignee: me},
	}}
	f.ppl = []person{{ID: "me", Name: "me"}, {ID: "zoe", Name: "zoe"}, {ID: "ann", Name: "ann", Full: "Ann Lee"}}
	m := newModel(f, f.m, "mine")
	m.all = append([]issue(nil), f.lists["mine"]...)
	m.setView("")
	m.width, m.height = 120, 24
	m.descDelay = 0
	m.opener = func(string) error { return nil }
	m.copier = func(string) error { return nil }
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
	case "tab":
		return tea.KeyPressMsg{Code: tea.KeyTab}
	case "shift+tab":
		return tea.KeyPressMsg{Code: tea.KeyTab, Mod: tea.ModShift}
	}
	if c, ok := strings.CutPrefix(k, "ctrl+"); ok {
		return tea.KeyPressMsg{Code: []rune(c)[0], Mod: tea.ModCtrl}
	}
	return tea.KeyPressMsg{Code: []rune(k)[0], Text: k}
}

// press sends keys one at a time and runs whatever commands they start, feeding their results
// back in.
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

func shown(m *model) []string {
	var out []string
	for k := range m.view {
		out = append(out, m.issue(k).Identifier)
	}
	return out
}

func get(m *model, id string) issue { return m.all[m.find(id)] }

func TestStatusOrderAndHeadings(t *testing.T) {
	m, _ := fixture(t)
	want := []string{"OPS-1", "ENG-3", "ENG-1", "ENG-2", "OPS-2", "ENG-4"}
	if got := shown(m); !reflect.DeepEqual(got, want) {
		t.Fatalf("order: %v", got)
	}
	var heads []string
	for _, r := range m.rows {
		if r.k < 0 {
			heads = append(heads, r.header)
		}
	}
	// Backlog spans both teams in one group.
	if want := []string{"Triage · 1", "In Review · 1", "In Progress · 1", "Todo · 1", "Backlog · 2"}; !reflect.DeepEqual(heads, want) {
		t.Fatalf("headings: %v", heads)
	}
	press(m, "s")
	if got := shown(m); !reflect.DeepEqual(got, []string{"ENG-3", "ENG-1", "OPS-1", "OPS-2", "ENG-2", "ENG-4"}) {
		t.Fatalf("by priority: %v", got)
	}
	press(m, "s")
	if got := shown(m); got[0] != "ENG-4" || got[5] != "ENG-1" {
		t.Fatalf("least recently updated first: %v", got)
	}
}

func TestMovesWithCountsAndPrefixes(t *testing.T) {
	m, _ := fixture(t)
	press(m, "3", "j")
	if m.cur != 3 {
		t.Fatalf("3j: %d", m.cur)
	}
	press(m, "g", "g")
	if m.cur != 0 {
		t.Fatal("gg goes to the top")
	}
	press(m, "G")
	if m.cur != 5 {
		t.Fatal("G goes to the bottom")
	}
	press(m, "2", "g", "g")
	if m.cur != 1 {
		t.Fatalf("2gg: %d", m.cur)
	}
	press(m, "4", "G")
	if m.cur != 3 {
		t.Fatalf("4G: %d", m.cur)
	}
	press(m, "g", "j")
	if m.cur != 4 || m.pending != "" {
		t.Fatalf("g then j: the prefix drops and j moves (%d %q)", m.cur, m.pending)
	}
	var opened string
	m.opener = func(u string) error { opened = u; return nil }
	press(m, "g", "g", "j", "j", "g", "x")
	if opened != "https://linear.app/x/issue/ENG-1" {
		t.Fatalf("gx opens the issue: %q", opened)
	}
	press(m, "9", "esc")
	if m.count != 0 || m.quitting {
		t.Fatal("esc drops a half-typed count and nothing else")
	}
}

func TestDeleteMovesOnAndUndoRestores(t *testing.T) {
	m, f := fixture(t)
	press(m, "j", "x")
	if !reflect.DeepEqual(f.removed, [][]string{{"e3"}}) {
		t.Fatalf("removed %v", f.removed)
	}
	if m.selectedID() != "e1" || len(m.view) != 5 {
		t.Fatalf("cursor lands on the next issue, got %s", m.selectedID())
	}
	if !strings.Contains(m.msg, "deleted ENG-3") {
		t.Fatalf("flash: %q", m.msg)
	}
	press(m, "u")
	if !reflect.DeepEqual(f.restored, [][]string{{"e3"}}) || len(m.view) != 6 || m.selectedID() != "e3" {
		t.Fatalf("u restores and goes to it: %v %v %s", f.restored, shown(m), m.selectedID())
	}
	press(m, "u")
	if m.msg != "nothing to undo" {
		t.Fatalf("flash: %q", m.msg)
	}
}

func TestDeleteCountsDdVisualAndMarks(t *testing.T) {
	m, f := fixture(t)
	press(m, "2", "x")
	if !reflect.DeepEqual(f.removed[0], []string{"o1", "e3"}) {
		t.Fatalf("2x: %v", f.removed)
	}
	m, f = fixture(t)
	press(m, "2", "d", "d")
	if !reflect.DeepEqual(f.removed[0], []string{"o1", "e3"}) {
		t.Fatalf("2dd: %v", f.removed)
	}
	m, f = fixture(t)
	press(m, "d", "j")
	if len(f.removed) != 0 || m.cur != 1 {
		t.Fatal("d then j deletes nothing and moves")
	}
	m, f = fixture(t)
	press(m, "v", "j", "j", "d")
	if !reflect.DeepEqual(f.removed[0], []string{"o1", "e3", "e1"}) || m.visual != "" {
		t.Fatalf("d deletes the visual range: %v", f.removed)
	}
	m, f = fixture(t)
	press(m, "space", "j", "space", ";")
	if !reflect.DeepEqual(f.removed[0], []string{"e1", "o1"}) || len(m.marks) != 0 {
		t.Fatalf("; deletes the marks: %v", f.removed)
	}
}

func TestFailedDeleteComesBack(t *testing.T) {
	m, f := fixture(t)
	f.failNext = true
	press(m, "x")
	if len(m.view) != 6 || !m.msgBad || len(m.undo) != 0 {
		t.Fatalf("a failed delete shows the issue again: %v %q", shown(m), m.msg)
	}
}

func TestStatusPickerDigitsAndUndo(t *testing.T) {
	m, f := fixture(t)
	press(m, "2", "j", "c")
	if m.picker == nil || m.picker.opts[2].label != "In Progress" || !m.picker.opts[2].current || m.picker.sel != 2 {
		t.Fatalf("c opens ENG's workflow on the current state: %+v", m.picker)
	}
	press(m, "4")
	if m.picker != nil {
		t.Fatal("a digit picks at once")
	}
	if !reflect.DeepEqual(f.updates, []call{{[]string{"e1"}, map[string]any{fieldState: "e-done"}}}) {
		t.Fatalf("updates: %+v", f.updates)
	}
	if got := get(m, "e1"); got.State.Name != "Done" || !m.touched["e1"] {
		t.Fatalf("ENG-1 is done and stays shown: %+v", got.State)
	}
	if !strings.Contains(m.msg, "ENG-1 → Done") {
		t.Fatalf("flash: %q", m.msg)
	}
	press(m, "u")
	if last := f.updates[len(f.updates)-1]; !reflect.DeepEqual(last, call{[]string{"e1"}, map[string]any{fieldState: "e-prog"}}) {
		t.Fatalf("undo puts it back: %+v", last)
	}
	if get(m, "e1").State.Name != "In Progress" || len(m.undo) != 0 {
		t.Fatal("undone, and an undo isn't itself undoable")
	}
}

func TestStatusAcrossTeamsMapsByNameThenType(t *testing.T) {
	m, f := fixture(t)
	// Mark ENG-1 (In Progress) and OPS-2 (Backlog); the cursor's on ENG-1, so ENG's workflow.
	press(m, "2", "j", "space", "j", "space", "k", "k", "k")
	if m.selectedID() != "e1" {
		t.Fatalf("cursor: %s", m.selectedID())
	}
	press(m, "c", "1")
	if len(f.updates) != 2 {
		t.Fatalf("one batch per team's Todo: %+v", f.updates)
	}
	if get(m, "e1").State.ID != "e-todo" || get(m, "o2").State.ID != "o-todo" || len(m.marks) != 0 {
		t.Fatal("Todo in each team, marks used up")
	}
	// In Review has no OPS twin by name: the first started state (Doing) it is.
	press(m, "space")
	m.marks["o2"] = true
	press(m, "c", "3")
	if get(m, "o2").State.ID != "o-doing" {
		t.Fatalf("by type: %+v", get(m, "o2").State)
	}
}

func TestStatusPickerSkipsTeamsWithoutTheState(t *testing.T) {
	m, f := fixture(t)
	// Cursor on OPS-2 (OPS has triage); mark ENG-2 too: ENG has no triage.
	m.cur = m.pos("o2")
	m.marks["o2"], m.marks["e2"] = true, true
	press(m, "c", "0")
	if len(f.updates) != 1 || !reflect.DeepEqual(f.updates[0].ids, []string{"o2"}) {
		t.Fatalf("only OPS-2 can go to triage: %+v", f.updates)
	}
	if !m.msgBad || !strings.Contains(m.msg, "without “Triage”") {
		t.Fatalf("flash: %q", m.msg)
	}
}

func TestCtrlDigitsSetStatus(t *testing.T) {
	m, f := fixture(t)
	// ^1 is Done in every team, though ENG's picker would call it 4.
	m.cur = m.pos("e1")
	press(m, "ctrl+1")
	if m.picker != nil || get(m, "e1").State.ID != "e-done" {
		t.Fatalf("^1 → Done at once: %+v", get(m, "e1").State)
	}
	press(m, "u")
	if get(m, "e1").State.ID != "e-prog" {
		t.Fatal("u undoes it")
	}
	press(m, "ctrl+3")
	if get(m, "e1").State.ID != "e-todo" {
		t.Fatalf("^3 → Todo: %+v", get(m, "e1").State)
	}
	// Marks across teams: ^2 is In Progress by name in ENG, Doing by type in OPS.
	f.updates = nil
	m.marks["e2"], m.marks["o2"] = true, true
	press(m, "ctrl+2")
	if get(m, "e2").State.ID != "e-prog" || get(m, "o2").State.ID != "o-doing" || len(m.marks) != 0 || len(f.updates) != 2 {
		t.Fatalf("marks: %+v %+v %+v", get(m, "e2").State, get(m, "o2").State, f.updates)
	}
	// ^4 In Review only by name: OPS has none, so OPS-1 stays (not In Progress by type).
	m.marks["e2"], m.marks["o1"] = true, true
	press(m, "ctrl+4")
	if get(m, "e2").State.ID != "e-review" || get(m, "o1").State.ID != "o-triage" {
		t.Fatalf("review: %+v %+v", get(m, "e2").State, get(m, "o1").State)
	}
	if !m.msgBad || !strings.Contains(m.msg, "without “In Review”") {
		t.Fatalf("flash: %q", m.msg)
	}
	// 2^6 cancels two from the cursor; ^8 and ^9 do nothing.
	m.cur = m.pos("e1")
	two := m.ids(m.cur, m.cur+2)
	press(m, "2", "ctrl+6")
	for _, id := range two {
		if get(m, id).State.Type != "canceled" {
			t.Fatalf("2^6 cancels two: %s is %+v", id, get(m, id).State)
		}
	}
	n := len(f.updates)
	press(m, "ctrl+8", "ctrl+9")
	if len(f.updates) != n {
		t.Fatal("^8 ^9 aren't slots")
	}
}

func TestChangesKeepTheCursorRow(t *testing.T) {
	m, _ := fixture(t)
	// OPS-1, ENG-3, ENG-1, ENG-2, …: ENG-1 done drops to the end, ENG-2 slides up under the
	// cursor, and Linear's reply doesn't move it.
	m.cur = m.pos("e1")
	press(m, "ctrl+1")
	if m.cur != 2 || m.selectedID() != "e2" {
		t.Fatalf("row %d on %s; want row 2 on ENG-2", m.cur, m.selectedID())
	}
	// Undo brings ENG-1 back to its row, under the cursor.
	press(m, "u")
	if m.cur != 2 || m.selectedID() != "e1" {
		t.Fatalf("after undo: row %d on %s", m.cur, m.selectedID())
	}
	// Same through the picker, and for marks elsewhere in the list.
	press(m, "c", "4")
	if m.cur != 2 || m.selectedID() != "e2" {
		t.Fatalf("picker: row %d on %s", m.cur, m.selectedID())
	}
	m.marks["o1"] = true
	press(m, "ctrl+5")
	if m.cur != 2 || get(m, "o1").State.Name != "Backlog" {
		t.Fatalf("marks: row %d, OPS-1 %s", m.cur, get(m, "o1").State.Name)
	}
}

func TestHalfPageKeepsTheScreenRow(t *testing.T) {
	m, _ := fixture(t)
	// 6 rows of list, so half is 3. Rows: Triage, OPS-1, In Review, ENG-3, In Progress, ENG-1,
	// Todo, ENG-2, Backlog, OPS-2, ENG-4: 11, so the list scrolls at most to row 5.
	m.height = 8
	m.cur = m.pos("e2")
	press(m, "ctrl+u", "ctrl+u")
	if m.top != 0 {
		t.Fatalf("top %d", m.top)
	}
	m.cur = m.pos("e3") // row 3, screen row 3
	press(m, "ctrl+d")
	if m.top != 3 || m.selectedID() != "e2" {
		t.Fatalf("^d: top %d on %s; want 3, ENG-2 (row 6 is a heading: the issue under it)", m.top, m.selectedID())
	}
	press(m, "ctrl+d")
	if m.top != 5 || m.selectedID() != "e4" {
		t.Fatalf("^d at the end: the list stops, the cursor goes on: top %d on %s", m.top, m.selectedID())
	}
	press(m, "ctrl+u")
	if m.top != 2 || m.selectedID() != "e2" || m.rowOf(m.cur)-m.top != 5 {
		t.Fatalf("^u keeps screen row 5: top %d on %s", m.top, m.selectedID())
	}
}

func TestPickerKeys(t *testing.T) {
	m, f := fixture(t)
	press(m, "j", "c", "d")
	if m.picker.opts[m.picker.shown()[m.picker.sel]].label != "Done" {
		t.Fatal("a letter jumps to the next choice starting with it")
	}
	press(m, "j", "k", "esc")
	if m.picker != nil || len(f.updates) != 0 {
		t.Fatal("esc cancels")
	}
	press(m, "c", "k", "enter")
	if get(m, "e3").State.ID != "e-prog" {
		t.Fatalf("k then ⏎: %+v", get(m, "e3").State)
	}
}

func TestPriorityOnVisualRange(t *testing.T) {
	m, f := fixture(t)
	press(m, "v", "j", "p", "4")
	if !reflect.DeepEqual(f.updates, []call{{[]string{"o1", "e3"}, map[string]any{fieldPriority: 4}}}) {
		t.Fatalf("updates: %+v", f.updates)
	}
	if m.visual != "" || get(m, "e3").Priority != 4 {
		t.Fatal("the range is used up and both are low")
	}
	// Undo: one batch per old priority.
	press(m, "u")
	if len(f.updates) != 3 || get(m, "o1").Priority != 3 || get(m, "e3").Priority != 1 {
		t.Fatalf("undo: %+v", f.updates)
	}
}

func TestAssigneePicker(t *testing.T) {
	m, f := fixture(t)
	press(m, "A")
	if m.people == nil || len(m.picker.opts) != 4 || m.picker.opts[2].label != "ann · Ann Lee" {
		t.Fatalf("people load in, by name after unassigned and me: %+v", m.picker.opts)
	}
	press(m, "0")
	if !reflect.DeepEqual(f.updates[0], call{[]string{"o1"}, map[string]any{fieldAssignee: nil}}) || get(m, "o1").Assignee != nil {
		t.Fatalf("0 unassigns: %+v", f.updates)
	}
	press(m, "A", "z", "o", "enter")
	if get(m, "o1").assigneeID() != "zoe" {
		t.Fatal("typing narrows, ⏎ picks")
	}
}

func TestFailedChangeRevertsAndKeepsNoUndo(t *testing.T) {
	m, f := fixture(t)
	f.failNext = true
	press(m, "p", "1")
	if get(m, "o1").Priority != 3 || !m.msgBad || len(m.undo) != 0 {
		t.Fatalf("reverted: %d %q", get(m, "o1").Priority, m.msg)
	}
}

func TestRenameAndCreate(t *testing.T) {
	m, f := fixture(t)
	press(m, "j", "r", "ctrl+u")
	typeText(m, "Ship invoices")
	press(m, "enter")
	if !reflect.DeepEqual(f.updates[0], call{[]string{"e3"}, map[string]any{fieldTitle: "Ship invoices"}}) {
		t.Fatalf("rename: %+v", f.updates)
	}
	press(m, "n")
	typeText(m, "New thing")
	press(m, "enter")
	want := map[string]any{"title": "New thing", "teamId": "eng", "stateId": "e-review", "assigneeId": "me"}
	if len(f.created) != 1 || !reflect.DeepEqual(f.created[0], want) {
		t.Fatalf("create in the cursor's team and status, assigned to me: %+v", f.created)
	}
	if m.selectedID() != "new1" {
		t.Fatalf("cursor goes to the new issue: %s", m.selectedID())
	}
	press(m, "u")
	if !reflect.DeepEqual(f.removed, [][]string{{"new1"}}) || m.pos("new1") >= 0 {
		t.Fatalf("undoing a create deletes it: %v", f.removed)
	}
	press(m, "n")
	typeText(m, "never mind")
	press(m, "esc")
	if m.prompt != nil || len(f.created) != 1 {
		t.Fatal("esc cancels")
	}
}

func TestNewIssueFromAClosedStatusGoesToTodo(t *testing.T) {
	m, f := fixture(t)
	press(m, "2", "j", "c", "4", "n")
	typeText(m, "x")
	press(m, "enter")
	if f.created[0]["stateId"] != "e-todo" {
		t.Fatalf("todo, not done: %+v", f.created[0])
	}
}

func TestFilterMarkAllAndEscape(t *testing.T) {
	m, _ := fixture(t)
	press(m, "/")
	typeText(m, "eng")
	if len(m.view) != 4 {
		t.Fatalf("filter by id: %v", shown(m))
	}
	press(m, "ctrl+u")
	typeText(m, "chore")
	if !reflect.DeepEqual(shown(m), []string{"OPS-2"}) {
		t.Fatalf("filter by label: %v", shown(m))
	}
	press(m, "enter", "a")
	if !m.marks["o2"] || len(m.marks) != 1 {
		t.Fatal("a marks every match")
	}
	press(m, "esc")
	if len(m.marks) != 0 || m.query == "" {
		t.Fatal("esc clears the marks first")
	}
	press(m, "esc")
	if m.query != "" || len(m.view) != 6 {
		t.Fatal("then drops the filter")
	}
	press(m, "enter", "esc")
	if m.detail || m.quitting {
		t.Fatal("then closes details")
	}
	press(m, "esc")
	if !m.quitting {
		t.Fatal("then quits")
	}
}

func TestMarkStatus(t *testing.T) {
	m, _ := fixture(t)
	press(m, "G", "*")
	if !m.marks["o2"] || !m.marks["e4"] || len(m.marks) != 2 {
		t.Fatalf("* marks the whole backlog, across teams: %v", m.marks)
	}
}

func TestRefreshKeepsTouchedAndDropsStaleReads(t *testing.T) {
	m, f := fixture(t)
	press(m, "2", "j", "c", "4")
	// Done issues aren't listed any more; ENG-1 stays because it was changed here.
	var rest []issue
	for _, i := range f.lists["mine"] {
		if i.ID != "e1" {
			rest = append(rest, i)
		}
	}
	f.lists["mine"] = rest
	m.Update(loadedMsg{key: "mine", issues: rest, gen: m.gen})
	if m.pos("e1") < 0 || get(m, "e1").State.Name != "Done" {
		t.Fatal("ENG-1 stays, done")
	}
	// A read that started before a change is dropped: it would put ENG-2's old priority back.
	old, before := m.gen, append([]issue(nil), f.lists["mine"]...)
	m.cur = m.pos("e2")
	press(m, "p", "1")
	m.Update(loadedMsg{key: "mine", issues: before, gen: old})
	if get(m, "e2").Priority != 1 || m.pos("e1") < 0 {
		t.Fatal("the stale read was dropped")
	}
	press(m, "R")
	if m.pos("e1") >= 0 {
		t.Fatal("R lets it go")
	}
}

func TestScopesReadTheirCache(t *testing.T) {
	m, f := fixture(t)
	f.lists["created"] = []issue{{ID: "c1", Identifier: "OPS-9", Title: "Mine to hand off", State: f.stateByID("o-todo"), TeamID: "ops"}}
	press(m, "tab")
	if m.scope().key() != "created" || !reflect.DeepEqual(shown(m), []string{"OPS-9"}) {
		t.Fatalf("tab: %s %v", m.scope().key(), shown(m))
	}
	press(m, "shift+tab", "shift+tab")
	if m.scope().key() != "team-OPS" {
		t.Fatalf("shift+tab wraps: %s", m.scope().key())
	}
	// The created list was cached on the way.
	var cached []issue
	if !readCache("scope-created", &cached) || len(cached) != 1 {
		t.Fatal("cached")
	}
}

func TestCopyAndDetail(t *testing.T) {
	m, _ := fixture(t)
	var got []string
	m.copier = func(s string) error { got = append(got, s); return nil }
	press(m, "2", "j", "y", "B")
	if !reflect.DeepEqual(got, []string{"ENG-1", "me/eng-1-fix-login"}) {
		t.Fatalf("copied %v", got)
	}
	press(m, "enter")
	if m.descs["e1"] != "about e1" {
		t.Fatal("⏎ reads the description")
	}
	out := ansi.Strip(m.render())
	if !strings.Contains(out, "about e1") || !strings.Contains(out, "In Progress · High · me") {
		t.Fatalf("detail pane:\n%s", out)
	}
}

func TestRenderFitsEveryWidth(t *testing.T) {
	for _, size := range [][2]int{{30, 5}, {50, 12}, {80, 24}, {120, 40}, {200, 50}} {
		for _, keys := range [][]string{{}, {"c"}, {"A"}, {"enter"}, {"?"}, {"v", "j"}, {"/", "x"}, {"r"}} {
			m, _ := fixture(t)
			m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
			press(m, keys...)
			lines := strings.Split(m.render(), "\n")
			if len(lines) != size[1] {
				t.Fatalf("%v %v: %d lines", size, keys, len(lines))
			}
			for _, l := range lines {
				if ansi.StringWidth(l) > size[0] {
					t.Fatalf("%v %v: too wide: %q", size, keys, ansi.Strip(l))
				}
			}
		}
	}
	m, _ := fixture(t)
	m.Update(tea.WindowSizeMsg{Width: 10, Height: 2})
	if !strings.Contains(m.render(), "lt") {
		t.Fatal("tiny panes say so")
	}
}
