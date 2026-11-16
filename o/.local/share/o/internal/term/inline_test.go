package term

import (
	"strings"
	"testing"

	"o/internal/tui"
)

// line is a prompt line: `> ` then text, 20 wide.
func line(text string) *tui.Buffer {
	b := tui.NewBuffer(tui.Rect{W: 20, H: 1})
	b.SetString(0, 0, "> ", tui.NewStyle())
	b.SetString(2, 0, text, tui.NewStyle())
	return b
}

func drawn(first *tui.Buffer, cursor int) *Inline {
	t := New(21, 24, 0, 5)
	var s []byte
	t.Draw(&s, first, &[2]int{cursor, 0})
	return t
}

func frame(t *Inline, b *tui.Buffer, cursor int) string {
	var s []byte
	t.Draw(&s, b, &[2]int{cursor, 0})
	return string(s)
}

func TestTypingAtTheEndWritesJustTheCharacter(t *testing.T) {
	tm := drawn(line("hell"), 6)
	for _, c := range []struct {
		text string
		cur  int
		want string
	}{{"hello", 7, "o"}, {"hello ", 8, " "}, {"hello ", 8, ""}} {
		if got := frame(tm, line(c.text), c.cur); got != c.want {
			t.Errorf("%q: got %q want %q", c.text, got, c.want)
		}
	}
}

func TestBackspaceAndMidLine(t *testing.T) {
	tm := drawn(line("hello"), 7)
	if got := frame(tm, line("hell"), 6); got != "\x08\x1b[K" {
		t.Errorf("%q", got)
	}
	tm = drawn(line("helo"), 5)
	if got := frame(tm, line("hello"), 6); got != "lo\x08" {
		t.Errorf("%q", got)
	}
}

func TestFirstFrameAndScrollAndClear(t *testing.T) {
	tm := New(21, 24, 0, 5)
	var s []byte
	tm.Draw(&s, line(""), &[2]int{2, 0})
	if string(s) != "\x1b[0m> " {
		t.Errorf("%q", s)
	}
	tm = New(21, 6, 0, 5)
	s = nil
	two := tui.NewBuffer(tui.Rect{W: 20, H: 2})
	two.SetString(0, 0, "> a", tui.NewStyle())
	two.SetString(2, 1, "b", tui.NewStyle())
	tm.Draw(&s, line("a"), &[2]int{3, 0})
	s = nil
	tm.Draw(&s, two, &[2]int{3, 1})
	if tm.Top != 4 || !strings.Contains(string(s), "\n") {
		t.Errorf("top %d %q", tm.Top, s)
	}
	tm = drawn(line("hi"), 4)
	s = nil
	tm.ClearScreen(&s)
	tm.Draw(&s, line("hi"), &[2]int{4, 0})
	if string(s) != "\x1b[0m\x1b[H\x1b[2J> hi" || tm.Top != 0 {
		t.Errorf("%q", s)
	}
}

func TestRowsAboveAndColors(t *testing.T) {
	for _, c := range []struct{ x, y, w, want int }{{60, 1, 120, 1}, {60, 1, 70, 2}, {75, 1, 70, 3}} {
		if got := rowsAbove([]int{96, 90, 96}, c.x, c.y, c.w); got != c.want {
			t.Errorf("%v: %d", c, got)
		}
	}
	if got := rowsAbove([]int{0, 0}, 0, 2, 70); got != 2 {
		t.Error(got)
	}
	var s []byte
	sgr(&s, pen{tui.Red, tui.DarkGray, tui.Bold})
	if string(s) != "\x1b[0;1;31;100m" {
		t.Errorf("%q", s)
	}
}
