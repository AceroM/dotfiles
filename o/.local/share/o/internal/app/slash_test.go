package app

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"o/internal/drafts"
	"o/internal/field"
	"o/internal/prompts"
	"o/internal/tui"
)

func slashApp(t *testing.T, text string) *App {
	t.Helper()
	a := newApp(text)
	a.Cwd = t.TempDir()
	if _, err := prompts.Save(a.Cwd, "review", "Review correctness and edge cases."); err != nil {
		t.Fatal(err)
	}
	if _, err := prompts.Save(a.Cwd, "tests", "Write focused tests."); err != nil {
		t.Fatal(err)
	}
	a.Layout(90, 24)
	return a
}

func TestSlashPickerFiltersPreviewsAndExpandsBeforeSending(t *testing.T) {
	a := slashApp(t, "/")
	b := Draw(a)
	if !strings.Contains(row(b, 1), "/review") || !strings.Contains(row(b, 5), ".o/commands/review.md") {
		t.Fatal(row(b, 1), row(b, 5))
	}
	press(a, tui.KeyDown, 0, 0)
	a.Layout(90, 24)
	if a.slash.at != 1 {
		t.Fatal(a.slash.at)
	}
	press(a, tui.KeyTab, 0, 0)
	if a.Field.Text != "Write focused tests.\n\n" || a.WouldSend != nil {
		t.Fatal(a.Field.Text)
	}
	press(a, tui.KeyEnter, 0, 0)
	if str(a.WouldSend) != "Write focused tests." {
		t.Fatal(str(a.WouldSend))
	}

	a = slashApp(t, "/rev")
	press(a, tui.KeyEnter, 0, 0)
	if !strings.HasPrefix(a.Field.Text, "Review correctness") || a.WouldSend != nil {
		t.Fatal(a.Field.Text)
	}
	ch(a, 'z', ctrl)
	if a.Field.Text != "/rev" {
		t.Fatal(a.Field.Text)
	}
}

func TestSlashPreambleTaskImagesAndAllSendKeys(t *testing.T) {
	for _, key := range []tui.Key{{Code: tui.KeyEnter}, {Code: tui.KeyEnter, Mod: ctrl}, {Code: tui.KeyRune, Rune: 'o', Mod: ctrl}, {Code: tui.KeyTab}} {
		a := slashApp(t, "/review focus on auth [Image #1]")
		a.Images = []string{"/tmp/screenshot.png"}
		a.Agent = 2 // Codex receives the same expansion as Claude.
		a.Handle(key)
		want := "Review correctness and edge cases.\n\nfocus on auth [Image #1]"
		if a.Field.Text != want || a.WouldSend != nil || len(a.Images) != 1 {
			t.Fatal(a.Field.Text, a.WouldSend, a.Images)
		}
		press(a, tui.KeyEnter, 0, 0)
		if !strings.Contains(str(a.WouldSend), want) || !strings.Contains(str(a.WouldSend), "/tmp/screenshot.png") {
			t.Fatal(str(a.WouldSend))
		}
	}
}

func TestNativeSlashEscapeDismissalAndNonrecursiveExpansion(t *testing.T) {
	a := slashApp(t, "/plan explain this")
	press(a, tui.KeyEnter, 0, 0)
	if str(a.WouldSend) != "/plan explain this" {
		t.Fatal(str(a.WouldSend))
	}
	a = slashApp(t, "//review native")
	press(a, tui.KeyEnter, 0, 0)
	if str(a.WouldSend) != "/review native" {
		t.Fatal(str(a.WouldSend))
	}
	a = slashApp(t, "/")
	if press(a, tui.KeyEsc, 0, 0) {
		t.Fatal("quit")
	}
	a.Layout(80, 24)
	if a.slash.height != 0 || a.Field.Text != "/" {
		t.Fatal(a.slash)
	}
	typeIn(a, "rev")
	a.Layout(80, 24)
	if a.slash.height == 0 {
		t.Fatal("typing should reopen menu")
	}

	a = slashApp(t, "/tests")
	prompts.Save(a.Cwd, "tests", "/review literal body")
	press(a, tui.KeyEnter, 0, 0)
	press(a, tui.KeyEnter, 0, 0)
	if str(a.WouldSend) != "/review literal body" {
		t.Fatal(str(a.WouldSend))
	}
}

func TestSlashSaveEditAndSnapshotHasNoWrites(t *testing.T) {
	a := slashApp(t, "/save build\nBuild and verify.\n\nKeep changes focused.")
	press(a, tui.KeyEnter, 0, 0)
	if _, err := os.Stat(filepath.Join(prompts.Dir(a.Cwd), "build.md")); !os.IsNotExist(err) {
		t.Fatal("snapshot wrote preset")
	}
	if a.WouldSend != nil || a.Field.Text != "" {
		t.Fatal(a.Field.Text)
	}
	a.show("/save build Build and verify.", nil)
	a.Live = true
	press(a, tui.KeyEnter, 0, ctrl)
	cs, err := prompts.Load(a.Cwd)
	if err != nil || len(cs) != 3 || cs[0].Name != "build" || cs[0].Body != "Build and verify." {
		t.Fatal(cs, err)
	}
	if a.Field.Text != "" || a.WouldSend != nil {
		t.Fatal("saving should clear the input without sending", a.Field.Text)
	}
	a.Live = false
	a.show("/edit bu", nil)
	press(a, tui.KeyTab, 0, 0)
	if a.Field.Text != "/save build\nBuild and verify." || a.WouldSend != nil {
		t.Fatal(a.Field.Text)
	}
	a.Field.Insert(" Updated.")
	a.Scroll = 5
	a.Live = true
	press(a, tui.KeyEnter, 0, 0)
	cs, _ = prompts.Load(a.Cwd)
	if cs[0].Body != "Build and verify. Updated." {
		t.Fatal(cs)
	}
	if a.Field.Text != "" || a.Field.Cur != 0 || a.Scroll != 0 || len(a.Images) != 0 || a.WouldSend != nil {
		t.Fatal("saving an edit should reset the input without sending", a.Field, a.Scroll, a.Images)
	}
	ch(a, 'z', ctrl)
	if a.Field.Text != "/save build\nBuild and verify. Updated." {
		t.Fatal("undo should restore the saved edit", a.Field.Text)
	}
}

func TestPresetEditCreatesOverrideInDraftDirectory(t *testing.T) {
	a := slashApp(t, "")
	child := filepath.Join(a.Cwd, "child")
	if err := os.MkdirAll(child, 0755); err != nil {
		t.Fatal(err)
	}
	a.Editing = &drafts.Draft{ID: "draft", Cwd: child, Text: "/edit review"}
	a.show("/edit review", nil)
	press(a, tui.KeyEnter, 0, 0)
	a.Field.Insert(" Local.")
	a.Live = true
	press(a, tui.KeyEnter, 0, 0)
	parent, _ := prompts.Load(a.Cwd)
	local, _ := prompts.Load(child)
	if parent[0].Body != "Review correctness and edge cases." || local[0].Body != parent[0].Body+" Local." {
		t.Fatal(parent, local)
	}
}

func TestSlashErrorsKeepTextAndNeverSend(t *testing.T) {
	for _, text := range []string{"/save ../bad body", "/save missing", "/save bad body [Image #1]", "/edit absent"} {
		a := slashApp(t, text)
		press(a, tui.KeyEnter, 0, 0)
		if a.WouldSend != nil || a.Field.Text != text || a.Toast == nil || a.Toast.OK {
			t.Fatal(text, a.Field.Text, a.Toast)
		}
	}
	a := slashApp(t, "/review")
	os.WriteFile(filepath.Join(prompts.Dir(a.Cwd), "review.md"), nil, 0600)
	press(a, tui.KeyEnter, 0, 0)
	if a.WouldSend != nil || a.Field.Text != "/review" || a.Toast.OK {
		t.Fatal(a.Field.Text)
	}
}

func TestSlashDraftListOpensForReviewAndKeepsMarkedDrafts(t *testing.T) {
	a := slashApp(t, "")
	a.Drafts = []drafts.Draft{{ID: "one", Cwd: a.Cwd, Text: "/review task"}, {ID: "two", Cwd: a.Cwd, Text: "another task"}}
	a.List = 0
	a.Marked = []string{"one", "two"}
	press(a, tui.KeyEnter, 0, 0)
	if a.WouldSend != nil || a.List != -1 || a.Editing == nil || !strings.HasPrefix(a.Field.Text, "Review correctness") || len(a.Drafts) != 2 {
		t.Fatal(a.Field.Text, a.List, a.Editing, a.Drafts)
	}
}

func TestSlashMenuFitsSmallScreensAndSelectionKeysStillEdit(t *testing.T) {
	a := slashApp(t, "/")
	for _, w := range []int{1, 16, 40, 90} {
		for _, h := range []int{1, 2, 4, 8, 24} {
			a.Layout(w, h)
			b := Draw(a)
			if b.Area.H > h {
				t.Fatalf("%dx%d: menu height %d", w, h, b.Area.H)
			}
			if c := a.CursorCell(); c != nil && c[1] >= h {
				t.Fatal(c)
			}
		}
	}
	a.show("/review", nil)
	press(a, tui.KeyLeft, 0, shift)
	press(a, tui.KeyEnter, 0, shift)
	if a.Field.Text != "/revie\n" || a.WouldSend != nil {
		t.Fatal(a.Field)
	}
	a.Field = field.New("ordinary text")
	a.Field.End()
	press(a, tui.KeyBackTab, 0, 0)
	if a.Agent != 1 {
		t.Fatal(a.Agent)
	}
}

func TestSlashLongListScrollsAndExternalChangesAreReadOnExpansion(t *testing.T) {
	a := slashApp(t, "/")
	for i := 0; i < 9; i++ {
		if _, err := prompts.Save(a.Cwd, fmt.Sprintf("preset-%d", i), "Preset body"); err != nil {
			t.Fatal(err)
		}
	}
	a.loadCommands(true)
	for i := 0; i < 8; i++ {
		press(a, tui.KeyDown, 0, 0)
	}
	a.Layout(90, 10)
	if a.slash.top == 0 || !strings.Contains(row(Draw(a), a.Lay.Height-1), "9/13") {
		t.Fatal(a.slash)
	}
	a.show("/review", nil)
	a.Layout(90, 24)
	if _, err := prompts.Save(a.Cwd, "review", "Changed outside o"); err != nil {
		t.Fatal(err)
	}
	press(a, tui.KeyEnter, 0, 0)
	if a.Field.Text != "Changed outside o\n\n" || a.WouldSend != nil {
		t.Fatal(a.Field.Text)
	}
}

func TestDraftNativeEscapeIsRemovedOnce(t *testing.T) {
	a := slashApp(t, "///review")
	a.Editing = &drafts.Draft{ID: "one", Cwd: a.Cwd, Text: a.Field.Text}
	a.Drafts = []drafts.Draft{*a.Editing}
	press(a, tui.KeyEnter, 0, 0)
	if !strings.Contains(str(a.WouldSend), "//review") {
		t.Fatal(str(a.WouldSend))
	}
}

func TestLiteralSlashBodiesAndUndoPreserveExpansionState(t *testing.T) {
	for _, body := range []string{"/", "/review literal", "//review literal", "/save literal text"} {
		a := slashApp(t, "/review")
		if _, err := prompts.Save(a.Cwd, "review", body); err != nil {
			t.Fatal(err)
		}
		press(a, tui.KeyEnter, 0, 0)
		ch(a, 'z', ctrl)
		if a.Field.Text != "/review" {
			t.Fatal(a.Field.Text)
		}
		// Undo again restores the expanded text and its literal status.
		ch(a, 'z', ctrl)
		press(a, tui.KeyEnter, 0, 0)
		if str(a.WouldSend) != body {
			t.Fatalf("%q: %q", body, str(a.WouldSend))
		}
	}
}
