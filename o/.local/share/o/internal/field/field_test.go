package field

import (
	"reflect"
	"testing"

	"o/internal/tui"
)

func fld(text string, cur int) *Field { f := New(text); f.Cur = cur; return &f }

func press(f *Field, code tui.KeyCode, r rune, mod tui.Mod) {
	f.Key(tui.Key{Code: code, Rune: r, Mod: mod})
}

const (
	ctrl     = tui.ModCtrl
	shift    = tui.ModShift
	altShift = tui.ModAlt | tui.ModShift
)

func sel(f *Field) string { s, _ := f.Selected(); return s }

func TestCtrlAEAndUK(t *testing.T) {
	f := fld("one\ntwo three\nfour", 8)
	press(f, tui.KeyRune, 'a', ctrl)
	if f.Cur != 4 {
		t.Fatal(f.Cur)
	}
	press(f, tui.KeyRune, 'e', ctrl)
	if f.Cur != 13 {
		t.Fatal(f.Cur)
	}
	f = fld("one\ntwo three\nfour", 8)
	press(f, tui.KeyRune, 'u', ctrl)
	if f.Text != "one\nthree\nfour" || f.Cur != 4 {
		t.Fatal(f.Text, f.Cur)
	}
	press(f, tui.KeyRune, 'u', ctrl)
	if f.Text != "onethree\nfour" || f.Cur != 3 {
		t.Fatal(f.Text, f.Cur)
	}
	f = fld("one\ntwo three\nfour", 8)
	press(f, tui.KeyRune, 'k', ctrl)
	press(f, tui.KeyRune, 'k', ctrl)
	if f.Text != "one\ntwo four" {
		t.Fatal(f.Text)
	}
}

func TestSelecting(t *testing.T) {
	f := fld("hello brave world", 6)
	press(f, tui.KeyRight, 0, altShift)
	if sel(f) != "brave" {
		t.Fatal(sel(f))
	}
	press(f, tui.KeyRight, 0, shift)
	if sel(f) != "brave " {
		t.Fatal(sel(f))
	}
	press(f, tui.KeyLeft, 0, altShift)
	if f.HasSelection() {
		t.Fatal(sel(f))
	}
	press(f, tui.KeyLeft, 0, altShift)
	if sel(f) != "hello " {
		t.Fatal(sel(f))
	}
	f.Key(tui.Ch('X'))
	if f.Text != "Xbrave world" || f.Cur != 1 || f.HasSelection() {
		t.Fatal(f.Text, f.Cur)
	}
	f = fld("one\ntwo three\nfour", 8)
	press(f, tui.KeyDown, 0, altShift)
	press(f, tui.KeyDown, 0, altShift)
	if sel(f) != "three\nfour" {
		t.Fatal(sel(f))
	}
	f = fld("one\ntwo three\nfour", 8)
	press(f, tui.KeyUp, 0, tui.ModSuper|shift)
	if sel(f) != "one\ntwo " {
		t.Fatal(sel(f))
	}
	f = fld("abc def", 7)
	press(f, tui.KeyRune, 'a', ctrl|shift)
	press(f, tui.KeyLeft, 0, 0)
	press(f, tui.KeyRight, 0, shift)
	press(f, tui.KeyRight, 0, shift)
	press(f, tui.KeyBackspace, 0, 0)
	if f.Text != "c def" || f.Cur != 0 {
		t.Fatal(f.Text)
	}
}

func TestClicksAndRows(t *testing.T) {
	f := fld("hello brave world\nnext", 0)
	rows := []Range{{0, 12}, {12, 17}, {18, 22}}
	for _, c := range []struct{ row, col, want int }{{0, 1, 1}, {0, 40, 11}, {1, 40, 17}, {2, 2, 20}, {9, 0, 22}} {
		if got := f.PosAt(rows, c.row, c.col); got != c.want {
			t.Errorf("%v: %d", c, got)
		}
	}
	if got := fld("see [Image #1] here", 0).PosAt([]Range{{0, 19}}, 0, 8); got != 4 {
		t.Error(got)
	}
	f = fld("one two-three\n[Image #2] four", 0)
	for at, want := range map[int]string{5: "two", 3: " ", 13: "three", 17: "[Image #2]"} {
		r := f.WordAt(at)
		if got := f.Text[r.Start:r.End]; got != want {
			t.Errorf("word at %d: %q", at, got)
		}
	}
	if r := f.LineAt(26); f.Text[r.Start:r.End] != "[Image #2] four" {
		t.Error(r)
	}
	f = fld("abcd\nefgh", 1)
	f.VerticalBy([]Range{{0, 4}, {5, 9}}, 1, true)
	if sel(f) != "bcd\ne" {
		t.Fatal(sel(f))
	}
}

func TestTransposeAndKills(t *testing.T) {
	f := fld("abc", 1)
	press(f, tui.KeyRune, 't', ctrl)
	if f.Text != "bac" || f.Cur != 2 {
		t.Fatal(f.Text)
	}
	f = fld("ab\ncd", 5)
	press(f, tui.KeyRune, 't', ctrl)
	if f.Text != "ab\ndc" {
		t.Fatal(f.Text)
	}
	f = fld("ab\ncd", 3)
	press(f, tui.KeyRune, 't', ctrl)
	if f.Text != "ab\ncd" {
		t.Fatal(f.Text)
	}
	f = fld("one two three", 13)
	press(f, tui.KeyRune, 'w', ctrl)
	if f.Text != "one two " {
		t.Fatal(f.Text)
	}
	f = fld("a ~/x/yz", 8)
	press(f, tui.KeyRune, 'w', ctrl)
	if f.Text != "a ~/x/" {
		t.Fatal(f.Text)
	}
}

func TestWrapsTagsAndPlain(t *testing.T) {
	rows := func(text string, w int) []string {
		var out []string
		for _, r := range WordRows(text, w) {
			out = append(out, text[r.Start:r.End])
		}
		return out
	}
	for _, c := range []struct {
		text string
		w    int
		want []string
	}{
		{"and the JPEG [Image #2] too", 14, []string{"and the JPEG ", "[Image #2] too"}},
		{"one\ntwo three", 5, []string{"one", "two ", "three"}},
		{"ab abcdefgh", 4, []string{"ab ", "abcd", "efgh"}},
		{"", 4, []string{""}},
	} {
		if got := rows(c.text, c.w); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%q: %q", c.text, got)
		}
	}
	images := []string{"/a/1.png", "/a/2.png"}
	if got := WithImages("see [Image #2]", images); got != "see [Image #2]\n\n[Image #2]: /a/2.png" {
		t.Error(got)
	}
	if got := FirstLine("\n  \n  fix   the header\nand more"); got != "fix the header" {
		t.Error(got)
	}
	for in, want := range map[string]string{
		"see [Image #1] here": "see here",
		"look at [Image #1] . and [Image #2], then [Image #3]": "look at. and, then",
		"a[Image #1]b": "a b",
		"\n\n  fix   the    header   \n[Image #1] [Image #2]\n\n\n\nand more\n\n": "  fix the header\n\nand more",
		"one\n[Image #1]\ntwo":  "one\ntwo",
		"- a\n    - b\t c":      "- a\n    - b c",
		"[Image #1] [Image #2]": "",
		"[Image #x] stays":      "[Image #x] stays",
	} {
		if got := Plain(in); got != want {
			t.Errorf("Plain(%q) = %q", in, got)
		}
	}
}
