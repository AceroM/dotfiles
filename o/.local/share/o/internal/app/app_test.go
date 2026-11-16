package app

import (
	"reflect"
	"strings"
	"testing"

	"o/internal/config"
	"o/internal/drafts"
	"o/internal/field"
	"o/internal/gfx"
	"o/internal/term"
	"o/internal/theme"
	"o/internal/tui"
)

func newApp(text string) *App {
	a := New(theme.NewPalette(theme.OneDark(theme.RGB{R: 0x28, G: 0x2c, B: 0x34})), Opts{Cwd: "/tmp", Text: text, Agents: config.Defaults()})
	a.Live = false
	return a
}

func press(a *App, code tui.KeyCode, r rune, mod tui.Mod) bool {
	return a.Handle(tui.Key{Code: code, Rune: r, Mod: mod}) == ActQuit
}

func ch(a *App, r rune, mod tui.Mod) bool { return press(a, tui.KeyRune, r, mod) }

func typeIn(a *App, text string) {
	for _, c := range text {
		a.Handle(tui.Ch(c))
	}
}

const (
	ctrl  = tui.ModCtrl
	shift = tui.ModShift
	alt   = tui.ModAlt
)

func str(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return *p
}

func row(b *tui.Buffer, y int) string { return term.Plain(b, y) }

func TestEnterSendsAndEmptiesTheBox(t *testing.T) {
	a := newApp("fix the header")
	a.Plan = true
	press(a, tui.KeyEnter, 0, 0)
	if str(a.WouldSend) != "/plan fix the header" || a.Field.Text != "" || len(a.Sent) != 1 {
		t.Fatal(str(a.WouldSend))
	}
	if !a.Tick() || !reflect.DeepEqual(a.TakeDone(), []int{0}) || len(a.TakeDone()) != 0 {
		t.Fatal("done")
	}
	ch(a, 'z', ctrl)
	if a.Field.Text != "fix the header" {
		t.Fatal(a.Field.Text)
	}
}

func TestSelectingASentSessionFocusesWithoutResending(t *testing.T) {
	a := newApp("first")
	press(a, tui.KeyEnter, 0, 0)
	a.Tick()
	typeIn(a, "second")
	press(a, tui.KeyEnter, 0, 0)
	a.Tick()
	press(a, tui.KeyUp, 0, 0)
	if a.SentAt != 1 {
		t.Fatal(a.SentAt)
	}
	press(a, tui.KeyUp, 0, 0)
	a.Layout(80, 24)
	if a.SentAt != 0 || a.CursorCell() != nil || !strings.Contains(row(Draw(a), 0), "first") {
		t.Fatal(row(Draw(a), 0))
	}
	press(a, tui.KeyEnter, 0, 0)
	if len(a.Sent) != 2 || a.Toast.Msg != "focused tab snapshot" {
		t.Fatal(a.Toast.Msg)
	}
	press(a, tui.KeyDown, 0, 0)
	press(a, tui.KeyDown, 0, 0)
	if a.SentAt != -1 || a.Field.Text != "" {
		t.Fatal(a.SentAt)
	}
	press(a, tui.KeyUp, 0, 0)
	if press(a, tui.KeyEsc, 0, 0) || a.SentAt != -1 {
		t.Fatal("esc")
	}
}

func TestEditingASentPromptRestoresImagesConfigurationAndPlan(t *testing.T) {
	a := newApp("fix the [Image #1] header")
	a.Images = []string{"/tmp/shot.png"}
	ch(a, '2', ctrl)
	a.Plan = true
	press(a, tui.KeyEnter, 0, 0)
	a.Tick()
	ch(a, '1', ctrl)
	a.Plan = false
	press(a, tui.KeyUp, 0, 0)
	a.Layout(100, 24)
	if !strings.Contains(row(Draw(a), 2), "e edit") {
		t.Fatal(row(Draw(a), 2))
	}
	ch(a, 'e', 0)
	if a.SentAt != -1 || a.Field.Text != "fix the [Image #1] header" || a.Field.Cur != len(a.Field.Text) {
		t.Fatal(a.SentAt, a.Field)
	}
	if !reflect.DeepEqual(a.Images, []string{"/tmp/shot.png"}) || a.Current().Name != "claude(fable)" || !a.Plan {
		t.Fatal(a.Images, a.Current().Name, a.Plan)
	}
	typeIn(a, " again")
	press(a, tui.KeyEnter, 0, 0)
	if str(a.WouldSend) != "/plan fix the [Image #1] header again\n\n[Image #1]: /tmp/shot.png" || len(a.Sent) != 2 {
		t.Fatal(str(a.WouldSend), len(a.Sent))
	}
}

func TestEditingDraftsSentTogetherRestoresTheCompletePrompt(t *testing.T) {
	a := withDrafts("second", "first")
	a.Drafts[0].Plan = true
	ch(a, 'g', ctrl)
	ch(a, 'a', 0)
	press(a, tui.KeyEnter, 0, 0)
	sent := str(a.WouldSend)
	a.Tick()
	press(a, tui.KeyUp, 0, 0)
	ch(a, 'e', 0)
	if a.List != -1 || a.Editing != nil || !strings.HasPrefix(a.Field.Text, "Here are 2 tasks") || !a.Plan {
		t.Fatal(a.List, a.Editing, a.Field.Text, a.Plan)
	}
	press(a, tui.KeyEnter, 0, 0)
	if str(a.WouldSend) != sent || len(a.Sent) != 2 {
		t.Fatal(str(a.WouldSend), len(a.Sent))
	}
}

func TestEditingASentReplyStartsANewAgent(t *testing.T) {
	a := withDrafts("follow up")
	a.Drafts[0].Reply = &drafts.ReplyTo{Pane: "block:1", Label: "auth"}
	ch(a, 'g', ctrl)
	press(a, tui.KeyEnter, 0, 0)
	a.Tick()
	if !strings.HasPrefix(str(a.WouldSend), "[to auth block:1]") {
		t.Fatal(str(a.WouldSend))
	}
	ch(a, '3', ctrl)
	press(a, tui.KeyUp, 0, 0)
	ch(a, 'e', 0)
	if a.Current().Name != "codex(sol)" || !strings.Contains(a.Toast.Msg, "not as a reply") {
		t.Fatal(a.Current().Name, a.Toast.Msg)
	}
	press(a, tui.KeyEnter, 0, 0)
	if str(a.WouldSend) != "follow up" || a.Sent[1].Name != "codex(sol)" {
		t.Fatal(str(a.WouldSend), a.Sent[1].Name)
	}
}

func TestEditingASentLiteralSlashDoesNotRunALocalCommand(t *testing.T) {
	a := newApp("//save native command")
	a.Cwd = t.TempDir()
	press(a, tui.KeyEnter, 0, 0)
	a.Tick()
	press(a, tui.KeyUp, 0, 0)
	ch(a, 'e', 0)
	press(a, tui.KeyEnter, 0, 0)
	if str(a.WouldSend) != "/save native command" || len(a.Sent) != 2 {
		t.Fatal(str(a.WouldSend), len(a.Sent))
	}
}

func TestPendingSessionsFocusOnceStarted(t *testing.T) {
	a := newApp("first")
	press(a, tui.KeyEnter, 0, 0)
	press(a, tui.KeyUp, 0, 0)
	press(a, tui.KeyEnter, 0, 0)
	if !strings.Contains(a.Toast.Msg, "as soon as it opens") {
		t.Fatal(a.Toast.Msg)
	}
	a.Tick()
	if a.Toast.Msg != "focused tab snapshot" || a.focusNext != -1 {
		t.Fatal(a.Toast.Msg)
	}
	a.Sent[0].Outcome.OK, a.Sent[0].Outcome.Target = false, ""
	press(a, tui.KeyEnter, 0, 0)
	if !strings.Contains(a.Toast.Msg, "no agent") {
		t.Fatal(a.Toast.Msg)
	}
	typeIn(a, "new prompt")
	if a.SentAt != -1 || a.Field.Text != "new prompt" || len(a.Sent) != 1 {
		t.Fatal(a.Field.Text)
	}
}

func TestUpAndDownGoThroughWhatWasSent(t *testing.T) {
	a := newApp("first")
	a.Layout(60, 30)
	press(a, tui.KeyEnter, 0, 0)
	typeIn(a, "second")
	press(a, tui.KeyEnter, 0, shift)
	typeIn(a, "line")
	press(a, tui.KeyEnter, 0, 0)
	typeIn(a, "draft")
	press(a, tui.KeyUp, 0, 0)
	if a.Field.Text != "second\nline" {
		t.Fatal(a.Field.Text)
	}
	press(a, tui.KeyUp, 0, 0)
	if a.Field.Text != "second\nline" || a.Field.Cur != 4 {
		t.Fatal(a.Field.Cur)
	}
	press(a, tui.KeyUp, 0, 0)
	if a.Field.Text != "first" {
		t.Fatal(a.Field.Text)
	}
	press(a, tui.KeyUp, 0, 0)
	if a.Field.Text != "first" || a.Field.Cur != 0 {
		t.Fatal(a.Field.Cur)
	}
	press(a, tui.KeyDown, 0, 0)
	if a.Field.Text != "second\nline" {
		t.Fatal(a.Field.Text)
	}
	press(a, tui.KeyDown, 0, 0)
	press(a, tui.KeyDown, 0, 0)
	if a.Field.Text != "draft" {
		t.Fatal(a.Field.Text)
	}
}

func TestCtrlSKeepsADraftAndCtrlGGoesThroughThem(t *testing.T) {
	a := newApp("fix the header")
	ch(a, 's', ctrl)
	if len(a.Drafts) != 1 {
		t.Fatal(a.Drafts)
	}
	typeIn(a, " now")
	a.saveDraft()
	if a.Drafts[0].Text != "fix the header now" {
		t.Fatal(a.Drafts[0].Text)
	}
	if press(a, tui.KeyEsc, 0, 0) || a.Field.Text != "" || a.Editing != nil || len(a.Drafts) != 1 {
		t.Fatal("esc")
	}
	typeIn(a, "second")
	ch(a, 's', ctrl)
	press(a, tui.KeyEsc, 0, 0)
	typeIn(a, "being written")
	ch(a, 'g', ctrl)
	if a.List != 0 {
		t.Fatal(a.List)
	}
	a.Layout(60, 30)
	if a.View.Shown != 2 || a.View.Preview != 1 || a.CursorCell() != nil {
		t.Fatal(a.View)
	}
	ch(a, 'j', 0)
	ch(a, 'e', 0)
	if a.Field.Text != "fix the header now" || a.List != -1 {
		t.Fatal(a.Field.Text)
	}
	typeIn(a, "!")
	press(a, tui.KeyEsc, 0, 0)
	if a.List != 1 || a.Drafts[1].Text != "fix the header now!" {
		t.Fatal(a.List, a.Drafts[1].Text)
	}
	press(a, tui.KeyEsc, 0, 0)
	if a.Field.Text != "being written" || a.List != -1 {
		t.Fatal(a.Field.Text)
	}
}

func TestADraftIsSentDeletedAndBroughtBack(t *testing.T) {
	a := newApp("one")
	ch(a, 'p', ctrl)
	ch(a, 's', ctrl)
	press(a, tui.KeyEsc, 0, 0)
	typeIn(a, "two")
	ch(a, 's', ctrl)
	press(a, tui.KeyEnter, 0, 0)
	if str(a.WouldSend) != "two" || len(a.Drafts) != 1 || a.Field.Text != "" {
		t.Fatal(str(a.WouldSend))
	}
	ch(a, 'g', ctrl)
	ch(a, 'x', 0)
	if len(a.Drafts) != 0 || a.List != -1 {
		t.Fatal(a.List)
	}
	ch(a, 'g', ctrl)
	if a.List != -1 {
		t.Fatal(a.List)
	}
	a.Drafts = append(a.Drafts, a.undo[0])
	ch(a, 'g', ctrl)
	press(a, tui.KeyEnter, 0, 0)
	if str(a.WouldSend) != "/plan one" || len(a.Drafts) != 0 || a.List != -1 {
		t.Fatal(str(a.WouldSend))
	}
}

func TestAnEmptiedDraftGoesAndHistoryStaysOutOfOne(t *testing.T) {
	a := newApp("sent before")
	a.Layout(60, 30)
	press(a, tui.KeyEnter, 0, 0)
	typeIn(a, "x")
	ch(a, 's', ctrl)
	press(a, tui.KeyUp, 0, 0)
	if a.Field.Text != "x" {
		t.Fatal(a.Field.Text)
	}
	ch(a, 'k', ctrl)
	press(a, tui.KeyEsc, 0, 0)
	if len(a.Drafts) != 0 || a.Editing != nil {
		t.Fatal(a.Drafts)
	}
}

func TestCtrlYAndCtrlL(t *testing.T) {
	a := newApp("one two three")
	ch(a, 'w', ctrl)
	if a.Field.Text != "one two " {
		t.Fatal(a.Field.Text)
	}
	ch(a, 'a', ctrl)
	ch(a, 'y', ctrl)
	if a.Field.Text != "threeone two " {
		t.Fatal(a.Field.Text)
	}
	ch(a, 'k', ctrl)
	if a.Field.Text != "three" {
		t.Fatal(a.Field.Text)
	}
	ch(a, 'y', ctrl)
	if a.Field.Text != "threeone two " {
		t.Fatal(a.Field.Text)
	}
	if a.Handle(tui.Key{Code: tui.KeyRune, Rune: 'l', Mod: ctrl}) != ActClearScreen || a.Field.Text != "threeone two " {
		t.Fatal("^l")
	}
}

func TestOptionCCopiesTheTextWithoutItsImages(t *testing.T) {
	a := newApp("  look at [Image #1] .\n[Image #2]\n\n\nthen   fix it  ")
	ch(a, 'c', alt)
	if str(a.WouldCopy) != "  look at.\n\nthen fix it" || a.Field.Text != "  look at [Image #1] .\n[Image #2]\n\n\nthen   fix it  " {
		t.Fatal(str(a.WouldCopy))
	}
	press(a, tui.KeyLeft, 0, shift|alt)
	press(a, tui.KeyLeft, 0, shift|alt)
	ch(a, 'c', alt)
	if str(a.WouldCopy) != "fix it" {
		t.Fatal(str(a.WouldCopy))
	}
	a = newApp("[Image #1] [Image #2]")
	ch(a, 'c', alt)
	if a.WouldCopy != nil {
		t.Fatal(str(a.WouldCopy))
	}
	a = newApp("a draft  [Image #1]")
	ch(a, 's', ctrl)
	press(a, tui.KeyEsc, 0, 0)
	ch(a, 'g', ctrl)
	ch(a, 'c', alt)
	if str(a.WouldCopy) != "a draft" || a.List != 0 {
		t.Fatal(str(a.WouldCopy))
	}
}

func TestShiftEnterIsANewlineAndEscTwiceClears(t *testing.T) {
	a := newApp("one")
	press(a, tui.KeyEnter, 0, shift)
	ch(a, 't', 0)
	if a.Field.Text != "one\nt" {
		t.Fatal(a.Field.Text)
	}
	if press(a, tui.KeyEsc, 0, 0) || a.Field.Text != "one\nt" {
		t.Fatal("first esc")
	}
	if press(a, tui.KeyEsc, 0, 0) || a.Field.Text != "" {
		t.Fatal("second esc")
	}
	if !press(a, tui.KeyEsc, 0, 0) {
		t.Fatal("quit")
	}
}

func TestLaysOutTheTextAndItsCursor(t *testing.T) {
	a := newApp("")
	a.Field = field.New("look at [Image #1] here\nand this")
	a.Layout(60, 30)
	if a.Prefix() != "claude(opus) >" || a.Lay.Text != (tui.Rect{X: 15, Y: 0, W: 43, H: 2}) || a.Lay.Height != 2 {
		t.Fatal(a.Lay)
	}
	if c := a.CursorCell(); c == nil || *c != [2]int{15, 0} {
		t.Fatal(c)
	}
	a.Field.End()
	a.Layout(60, 30)
	if c := a.CursorCell(); c == nil || *c != [2]int{23, 1} {
		t.Fatal(c)
	}
	a.Layout(30, 30)
	if a.Prefix() != ">" || a.Lay.Text != (tui.Rect{X: 2, Y: 0, W: 26, H: 2}) {
		t.Fatal(a.Lay)
	}
	a.Say("hi", true)
	a.Layout(60, 30)
	if a.Lay.Height != 3 {
		t.Fatal(a.Lay.Height)
	}
}

func TestMaxWidthKeepsAWidePaneFromStretchingTheText(t *testing.T) {
	a := newApp(strings.Repeat("word ", 60))
	a.maxWidth = 100
	a.Layout(300, 30)
	if a.Lay.Width != 100 || a.Lay.Text.W != 83 || Draw(a).Area.W != 99 {
		t.Fatal(a.Lay)
	}
	for _, r := range a.Rows {
		if len(strings.TrimRight(a.Field.Text[r.Start:r.End], " ")) > 83 {
			t.Fatal(r)
		}
	}
	a.Layout(60, 30)
	if a.Lay.Text.W != 43 {
		t.Fatal(a.Lay.Text)
	}
	a.maxWidth = 0
	a.Layout(300, 30)
	if a.Lay.Width != 300 {
		t.Fatal(a.Lay.Width)
	}
}

func TestALongPromptScrollsToKeepTheCursorInView(t *testing.T) {
	a := newApp(strings.Repeat("line\n", 40))
	a.Layout(60, 10)
	if a.Lay.Text.H != 9 || a.Scroll != 32 {
		t.Fatal(a.Lay.Text.H, a.Scroll)
	}
	if c := a.CursorCell(); c == nil || *c != [2]int{15, 8} {
		t.Fatal(c)
	}
}

func TestShiftTabAndCtrlDigitsPickTheConfiguration(t *testing.T) {
	a := newApp("fix it")
	a.Layout(80, 30)
	for _, want := range []struct {
		name string
		x    int
	}{{"claude(fable) >", 16}, {"codex(sol) >", 13}, {"codex(astra) >", 15}} {
		press(a, tui.KeyBackTab, 0, shift)
		a.Layout(80, 30)
		if a.Prefix() != want.name || a.Lay.Text.X != want.x {
			t.Fatal(a.Prefix(), a.Lay.Text.X)
		}
	}
	press(a, tui.KeyBackTab, 0, shift)
	if a.Current().Name != "claude(opus)" {
		t.Fatal(a.Current().Name)
	}
	ch(a, '3', ctrl)
	if a.Current().Name != "codex(sol)" {
		t.Fatal(a.Current().Name)
	}
	ch(a, '7', ctrl)
	if a.Current().Name != "codex(sol)" || a.Field.Text != "fix it" || a.Toast.OK {
		t.Fatal(a.Current().Name)
	}
	ch(a, '4', ctrl)
	press(a, tui.KeyEnter, 0, 0)
	if a.Sent[0].Name != "codex(astra)" {
		t.Fatal(a.Sent[0].Name)
	}
}

func TestCtrlNGoesThroughTheClaudeProfiles(t *testing.T) {
	a := newApp("fix it")
	ch(a, 'n', ctrl)
	if a.Toast == nil || a.Toast.OK {
		t.Fatal("one profile")
	}
	a.Profiles = []config.Profile{{Name: config.Main, Dir: "/h/.claude"}, {Name: "2", Dir: "/h/.claude-2"}}
	ch(a, 'n', ctrl)
	a.Layout(80, 30)
	if a.Prefix() != "claude(opus)·2 >" || a.Lay.Text.X != 17 || !strings.HasPrefix(a.Toast.Msg, "Claude profile 2 (/h/.claude-2)") {
		t.Fatal(a.Prefix(), a.Lay.Text.X, a.Toast.Msg)
	}
	ch(a, '3', ctrl)
	a.Layout(80, 30)
	if a.Prefix() != "codex(sol) >" {
		t.Fatal(a.Prefix())
	}
	ch(a, '1', ctrl)
	press(a, tui.KeyEnter, 0, 0)
	if a.Sent[0].Name != "claude(opus)·2" {
		t.Fatal(a.Sent[0].Name)
	}
	typeIn(a, "later")
	ch(a, 's', ctrl)
	if a.Drafts[0].Config != "claude(opus)" {
		t.Fatal(a.Drafts[0].Config)
	}
	press(a, tui.KeyEsc, 0, 0)
	ch(a, 'n', ctrl)
	a.Layout(80, 30)
	if a.Prefix() != "claude(opus) >" {
		t.Fatal(a.Prefix())
	}
}

func TestADraftKeepsItsConfiguration(t *testing.T) {
	a := newApp("on fable")
	ch(a, '2', ctrl)
	ch(a, 's', ctrl)
	if a.Drafts[0].Kind != "claude" || a.Drafts[0].Config != "claude(fable)" {
		t.Fatal(a.Drafts[0])
	}
	a.Layout(80, 30)
	if a.Prefix() != "claude(fable) ◇" {
		t.Fatal(a.Prefix())
	}
	ch(a, '3', ctrl)
	a.saveDraft()
	if a.Drafts[0].Config != "codex(sol)" {
		t.Fatal(a.Drafts[0].Config)
	}
	ch(a, '2', ctrl)
	press(a, tui.KeyEsc, 0, 0)
	ch(a, '1', ctrl)
	ch(a, 'g', ctrl)
	ch(a, 'e', 0)
	if a.Current().Name != "claude(fable)" {
		t.Fatal(a.Current().Name)
	}
	a.Drafts[0].Config, a.Drafts[0].Kind = "", "codex"
	if a.agentOf(a.Drafts[0]) != 2 {
		t.Fatal(a.agentOf(a.Drafts[0]))
	}
}

func withDrafts(texts ...string) *App {
	a := newApp("")
	for _, s := range texts {
		typeIn(a, s)
		ch(a, 's', ctrl)
		press(a, tui.KeyEsc, 0, 0)
	}
	return a
}

func texts(ds []drafts.Draft) []string {
	var out []string
	for _, d := range ds {
		out = append(out, d.Text)
	}
	return out
}

func TestShiftArrowsMarkAndEnterSendsTheMarkedAsOnePrompt(t *testing.T) {
	a := withDrafts("third", "second", "first")
	ch(a, 'g', ctrl)
	press(a, tui.KeyDown, 0, shift)
	press(a, tui.KeyDown, 0, shift)
	if a.List != 2 || len(a.Marked) != 3 {
		t.Fatal(a.List, a.Marked)
	}
	press(a, tui.KeyUp, 0, shift)
	if a.List != 1 || len(a.Marked) != 2 {
		t.Fatal(a.List, a.Marked)
	}
	a.Layout(100, 30)
	if keys := row(Draw(a), a.Lay.Text.Bottom()-1); !strings.HasPrefix(keys, "  2 marked · ") {
		t.Fatal(keys)
	}
	press(a, tui.KeyEnter, 0, 0)
	sent := str(a.WouldSend)
	if !strings.HasPrefix(sent, "Here are 2 tasks") || !strings.HasSuffix(sent, "## Task 1 of 2\n\nfirst\n\n## Task 2 of 2\n\nsecond") {
		t.Fatal(sent)
	}
	if a.Sent[0].Text != "2 drafts as one prompt\n1. first\n2. second" {
		t.Fatal(a.Sent[0].Text)
	}
	if len(a.Drafts) != 1 || a.Drafts[0].Text != "third" || a.List != 0 || len(a.Marked) != 0 {
		t.Fatal(texts(a.Drafts), a.List)
	}
}

func TestSpaceMarksOneXDeletesTheMarkedAndUBringsThemBack(t *testing.T) {
	a := withDrafts("c", "b", "a")
	ch(a, 'g', ctrl)
	ch(a, ' ', 0)
	ch(a, 'j', 0)
	ch(a, 'j', 0)
	ch(a, ' ', 0)
	ch(a, 'x', 0)
	if !reflect.DeepEqual(texts(a.Drafts), []string{"b"}) {
		t.Fatal(texts(a.Drafts))
	}
	ch(a, 'u', 0)
	if !reflect.DeepEqual(texts(a.Drafts), []string{"a", "c", "b"}) {
		t.Fatal(texts(a.Drafts))
	}
	ch(a, 'a', 0)
	if len(a.Marked) != 3 {
		t.Fatal(a.Marked)
	}
	ch(a, 'a', 0)
	if len(a.Marked) != 0 {
		t.Fatal(a.Marked)
	}
	ch(a, ' ', 0)
	press(a, tui.KeyEsc, 0, 0)
	if len(a.Marked) != 0 || a.List < 0 {
		t.Fatal(a.Marked)
	}
	press(a, tui.KeyEsc, 0, 0)
	if a.List != -1 {
		t.Fatal(a.List)
	}
}

func TestOneMarkedGoesAsItselfAndRepliesDontGoWithOthers(t *testing.T) {
	a := withDrafts("two", "one")
	ch(a, 'g', ctrl)
	ch(a, 'j', 0)
	ch(a, ' ', 0)
	ch(a, 'k', 0)
	press(a, tui.KeyEnter, 0, 0)
	if str(a.WouldSend) != "two" || a.Drafts[0].Text != "one" {
		t.Fatal(str(a.WouldSend))
	}
	a = withDrafts("two", "one")
	a.Drafts[0].Reply = &drafts.ReplyTo{Pane: "block:1", Label: "auth"}
	ch(a, 'g', ctrl)
	ch(a, 'a', 0)
	press(a, tui.KeyEnter, 0, 0)
	if a.WouldSend != nil || len(a.Drafts) != 2 || !strings.Contains(a.Toast.Msg, "its own agent") {
		t.Fatal(str(a.WouldSend))
	}
}

func thumbsOf(ts []Thumb) [][4]int {
	var out [][4]int
	for _, t := range ts {
		out = append(out, [4]int{t.X, t.Cols, t.Rows, t.N})
	}
	return out
}

func TestTheSelectedDraftsImagesGoOverTheList(t *testing.T) {
	a := withDrafts("no pictures")
	typeIn(a, "look ")
	a.Attach("/wide.png")
	a.Attach("/square.png")
	ch(a, 's', ctrl)
	press(a, tui.KeyEsc, 0, 0)
	a.Gfx = &gfx.Gfx{CellW: 10, CellH: 20}
	a.SetPic("/wide.png", 900, 450)
	a.SetPic("/square.png", 90, 90)
	ch(a, 'g', ctrl)
	a.Layout(100, 40)
	if a.View.Strip != 9 || !reflect.DeepEqual(thumbsOf(a.View.Thumbs), [][4]int{{0, 32, 8, 1}, {34, 9, 5, 2}}) {
		t.Fatal(a.View.Strip, thumbsOf(a.View.Thumbs))
	}
	b := Draw(a)
	if !strings.HasPrefix(row(b, 0), "  "+strings.Repeat("▒", 32)+"  "+strings.Repeat("▒", 9)) {
		t.Fatal(row(b, 0))
	}
	if !strings.Contains(row(b, 5), "[Image #2]") || !strings.HasPrefix(row(b, 8), "  [Image #1]") || !strings.HasPrefix(row(b, 9), "▸ ◇ look [Image #1] [Image #2]") {
		t.Fatal(row(b, 5), row(b, 8), row(b, 9))
	}
	if n := strings.Count(string(a.TakeGfx()), "\x1b_Ga"); n != 2 {
		t.Fatal(n)
	}
	a.Layout(100, 40)
	if len(a.TakeGfx()) != 0 {
		t.Fatal("resent")
	}
	ch(a, 'j', 0)
	a.Layout(100, 40)
	if a.View.Strip != 9 || len(a.View.Thumbs) != 0 || a.View.Note != "no images" {
		t.Fatal(a.View)
	}
	a.Layout(100, 12)
	if a.View.Strip != 7 {
		t.Fatal(a.View.Strip)
	}
	a.Layout(100, 8)
	if a.View.Strip != 0 {
		t.Fatal(a.View.Strip)
	}
	a.Gfx = nil
	a.Layout(100, 40)
	if a.View.Strip != 0 || !strings.Contains(string(a.ClearImages()), "a=d,d") {
		t.Fatal(a.View.Strip)
	}
}

func TestADraftsImagesGoOverItsTextInOneRow(t *testing.T) {
	a := newApp("")
	a.Gfx = &gfx.Gfx{CellW: 10, CellH: 20}
	for _, p := range []string{"/wide.png", "/w2.png", "/w3.png"} {
		a.SetPic(p, 900, 450)
	}
	a.SetPic("/square.png", 90, 90)
	typeIn(a, "look ")
	a.Attach("/wide.png")
	a.Attach("/square.png")
	a.Layout(100, 40)
	if a.Pictures.Height != 0 || a.Lay.Text.Y != 0 {
		t.Fatal(a.Pictures)
	}
	ch(a, 's', ctrl)
	a.Toast = nil
	a.Layout(100, 40)
	if a.Pictures.Height != 9 || !reflect.DeepEqual(thumbsOf(a.Pictures.Thumbs), [][4]int{{0, 32, 8, 1}, {34, 16, 8, 2}}) {
		t.Fatal(a.Pictures.Height, thumbsOf(a.Pictures.Thumbs))
	}
	if a.Lay.Text != (tui.Rect{X: 15, Y: 9, W: 83, H: 1}) || a.Lay.Height != 10 {
		t.Fatal(a.Lay)
	}
	b := Draw(a)
	pad := strings.Repeat(" ", 15)
	if row(b, 0) != pad+strings.Repeat("▒", 32)+"  "+strings.Repeat("▒", 16) || row(b, 8) != pad+"[Image #1]"+strings.Repeat(" ", 24)+"[Image #2]" {
		t.Fatalf("%q\n%q", row(b, 0), row(b, 8))
	}
	if !strings.HasPrefix(row(b, 9), "claude(opus) ◇ look [Image #1] [Image #2]") || (*a.CursorCell())[1] != 9 {
		t.Fatal(row(b, 9))
	}
	cur := a.Field.Cur
	a.Handle(tui.Mouse{Kind: tui.MouseDown, Button: tui.ButtonLeft, X: 20, Y: 3})
	if a.Field.Cur != cur {
		t.Fatal("moved")
	}
	a.Field.End()
	a.Attach("/w2.png")
	a.Attach("/w3.png")
	a.Layout(100, 40)
	if !reflect.DeepEqual(thumbsOf(a.Pictures.Thumbs), [][4]int{{0, 20, 5, 1}, {22, 10, 5, 2}, {34, 20, 5, 3}, {56, 20, 5, 4}}) || a.Pictures.Height != 6 || a.Pictures.Note != "" || a.Lay.Text.Y != 6 {
		t.Fatal(thumbsOf(a.Pictures.Thumbs), a.Pictures.Height)
	}
	a.TakeGfx()
	var kept []string
	for _, p := range a.Images {
		kept = append(kept, "/kept"+p)
	}
	before := a.Images
	a.Images = kept
	a.imagesMoved(before, kept)
	a.Layout(100, 40)
	if len(a.Pictures.Thumbs) != 4 || len(a.TakeGfx()) != 0 {
		t.Fatal("moved images reloaded")
	}
	a.Layout(40, 40)
	if !reflect.DeepEqual(thumbsOf(a.Pictures.Thumbs), [][4]int{{0, 8, 2, 1}, {12, 4, 2, 2}}) || a.Pictures.Note != "+2 more" {
		t.Fatal(thumbsOf(a.Pictures.Thumbs), a.Pictures.Note)
	}
	a.Layout(100, 5)
	if a.Pictures.Height != 3 || a.Pictures.Thumbs[0].Rows != 2 {
		t.Fatal(a.Pictures.Height)
	}
	a.Layout(100, 4)
	if a.Pictures.Height != 0 || a.Lay.Text.Y != 0 {
		t.Fatal(a.Pictures.Height)
	}
	a.Gfx = nil
	a.Layout(100, 40)
	if a.Pictures.Height != 0 {
		t.Fatal(a.Pictures.Height)
	}
	a.Gfx = &gfx.Gfx{CellW: 10, CellH: 20}
	press(a, tui.KeyEsc, 0, 0)
	a.Layout(100, 40)
	if a.Pictures.Height != 0 {
		t.Fatal(a.Pictures.Height)
	}
}

func TestShowingThePromptsImagesAndASendKeepsThem(t *testing.T) {
	a := newApp("")
	typeIn(a, "see ")
	a.Attach("/one.png")
	a.Attach("/two.png")
	if !reflect.DeepEqual(a.Showing(), []drafts.Tagged{{N: 1, Path: "/one.png"}, {N: 2, Path: "/two.png"}}) {
		t.Fatal(a.Showing())
	}
	a.Field = field.New("see [Image #2]")
	a.Field.End()
	if !reflect.DeepEqual(a.Showing(), []drafts.Tagged{{N: 2, Path: "/two.png"}}) {
		t.Fatal(a.Showing())
	}
	press(a, tui.KeyEnter, 0, 0)
	if !reflect.DeepEqual(a.Sent[0].Images, []drafts.Tagged{{N: 2, Path: "/two.png"}}) || len(a.Showing()) != 0 {
		t.Fatal(a.Sent[0].Images)
	}
}

func TestAClickPutsTheCursorThere(t *testing.T) {
	a := newApp("see this\nnext")
	a.Layout(60, 30)
	tx := a.Lay.Text
	a.Handle(tui.Mouse{Kind: tui.MouseDown, Button: tui.ButtonLeft, X: tx.X + 3, Y: tx.Y})
	if a.Field.Cur != 3 {
		t.Fatal(a.Field.Cur)
	}
	a.ResetPress()
	a.Handle(tui.Mouse{Kind: tui.MouseDown, Button: tui.ButtonLeft, X: tx.X + 2, Y: tx.Y + 1})
	if a.Field.Cur != 11 {
		t.Fatal(a.Field.Cur)
	}
}
