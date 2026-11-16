// Package term draws inline, as a shell's line editor does: no alternate
// screen, and only what changed. The prompt's lines sit under whatever the
// terminal showed; each frame is compared cell by cell with the last one,
// and only the cells that differ are written, with the shortest cursor
// moves. Typing a character at the end of a line writes that character and
// nothing else; ⌫ there writes `\b\x1b[K`. Every byte goes through Rex's
// parser before it's drawn, so fewer is faster.
//
// What's finished goes above the prompt, into the scrollback, for good.
package term

import (
	"fmt"
	"strings"

	"o/internal/tui"
)

// pen is a cell's look: what the terminal writes with.
type pen struct {
	fg, bg tui.Color
	mod    tui.Modifier
}

var defaultPen = pen{}

type Inline struct {
	// Top is the screen row (0-based) of the prompt's first line.
	Top int
	// The lines drawn from there last time; nil when nothing of the prompt
	// is on the screen (rows from Top down are blank).
	prev *tui.Buffer
	// The terminal's size.
	Width, Rows int
	// Where the terminal's cursor is, on the screen.
	atX, atY int
	// What the terminal writes with now; nil: not known.
	pen   *pen
	shown bool
}

// New starts at the cursor (x, y) (the line after the command, as the
// terminal reported it) on a width×rows terminal.
func New(width, rows, x, y int) *Inline {
	// Not at a line's start (output that ended without a newline): the next
	// line, which the first frame makes room for.
	top := y
	if x > 0 {
		top++
	}
	return &Inline{Top: top, Width: width, Rows: rows, atX: x, atY: y, shown: true}
}

// Draw brings the screen from the last frame to buf: scroll up first when
// it no longer fits under Top, write the cells that changed, clear what's
// left of a taller frame, and put the cursor at cursor (from the first
// line), or hide it (nil).
func (t *Inline) Draw(s *[]byte, buf *tui.Buffer, cursor *[2]int) {
	start := len(*s)
	h := min(buf.Area.H, t.Rows)
	oldH := 0
	if t.prev != nil {
		oldH = t.prev.Area.H
	}
	big := false
	if t.Top+h > t.Rows {
		// A line feed on the last row scrolls the screen up a line (a blank
		// one, in the pen's background: the default).
		d := t.Top + h - t.Rows
		t.go_(s, min(t.atX, max(t.Width-1, 0)), t.Rows-1)
		t.penTo(s, defaultPen)
		*s = append(*s, strings.Repeat("\n", d)...)
		t.Top = max(t.Top-d, 0)
		big = true
	}
	rowsChanged := 0
	for y := 0; y < h; y++ {
		var prev *tui.Buffer
		if t.prev != nil && y < t.prev.Area.H {
			prev = t.prev
		}
		newEnd := end(buf, y)
		oldEnd := 0
		if prev != nil {
			oldEnd = end(prev, y)
		}
		fx := -1
		for x := 0; x < max(newEnd, oldEnd); x++ {
			if !same(at(buf, x, y), at(prev, x, y)) {
				fx = x
				break
			}
		}
		if fx < 0 {
			continue
		}
		rowsChanged++
		// Start on a character, not inside a wide one.
		if fx < newEnd {
			best := fx
			for _, x := range starts(buf, y, newEnd) {
				if x > fx {
					break
				}
				best = x
			}
			fx = best
		}
		t.go_(s, fx, t.Top+y)
		x := t.cells(s, buf, y, fx, newEnd)
		if oldEnd > x {
			t.penTo(s, defaultPen)
			*s = append(*s, "\x1b[K"...)
		}
	}
	if oldH > h {
		t.go_(s, 0, t.Top+h)
		t.penTo(s, defaultPen)
		*s = append(*s, "\x1b[J"...)
		rowsChanged++
	}
	cp := *buf
	cp.Cells = append([]tui.Cell(nil), buf.Cells...)
	t.prev = &cp
	switch {
	case cursor != nil && cursor[1] < h:
		x, y := cursor[0], cursor[1]
		// A space typed at a line's end: written, rather than a move over the
		// blank cells (the same, in fewer bytes).
		cx, cy := t.atX, t.atY
		blankRun := cy == t.Top+y && x > cx && x-cx <= 3 && t.pen != nil && *t.pen == defaultPen
		if blankRun {
			for bx := cx; bx < x; bx++ {
				c := at(buf, bx, y)
				if c != nil && !(c.Sym == " " && c.Fg == tui.Reset && c.Bg == tui.Reset && c.Mod == 0) {
					blankRun = false
					break
				}
			}
		}
		if blankRun {
			*s = append(*s, strings.Repeat(" ", x-cx)...)
			t.atX = x
		}
		t.go_(s, x, t.Top+y)
		if !t.shown {
			*s = append(*s, "\x1b[?25h"...)
			t.shown = true
		}
	case t.shown:
		*s = append(*s, "\x1b[?25l"...)
		t.shown = false
	}
	// More than a line's worth: let it land whole.
	if big || rowsChanged > 1 {
		out := append([]byte("\x1b[?2026h"), (*s)[start:]...)
		*s = append(append((*s)[:start], out...), "\x1b[?2026l"...)
	}
}

// PrintAbove prints buf where the prompt is, for good, and moves the prompt
// under it (the next Draw writes it again).
func (t *Inline) PrintAbove(s *[]byte, buf *tui.Buffer) {
	t.go_(s, 0, t.Top)
	t.penTo(s, defaultPen)
	*s = append(*s, "\x1b[J"...)
	for y := 0; y < buf.Area.H; y++ {
		t.cells(s, buf, y, 0, end(buf, y))
		t.penTo(s, defaultPen)
		*s = append(*s, "\r\n"...)
		// On the last row the line feed scrolled the screen instead.
		t.atX, t.atY = 0, min(t.atY+1, max(t.Rows-1, 0))
	}
	t.Top = t.atY
	t.prev = nil
}

// Resize: the terminal changed size. Find the prompt again by the cursor
// (pos asks the terminal where it is), and clear from there. A narrower
// terminal (Ghostty, Rex) rewraps the lines already drawn, so the cursor
// sits as many rows below Top as the lines over it take now.
func (t *Inline) Resize(s *[]byte, width, rows int, pos func() (int, int, bool)) {
	var widths []int
	if t.prev != nil {
		for y := 0; y < t.prev.Area.H; y++ {
			widths = append(widths, end(t.prev, y))
		}
	}
	cx, cy := t.atX, max(t.atY-t.Top, 0)
	t.Width, t.Rows = width, rows
	px, py, ok := pos()
	if !ok {
		px, py = t.atX, t.atY
	}
	t.Top = min(max(py-rowsAbove(widths, cx, cy, width), 0), max(rows-1, 0))
	t.atX, t.atY = px, py
	t.go_(s, 0, t.Top)
	t.penTo(s, defaultPen)
	*s = append(*s, "\x1b[J"...)
	t.prev = nil
}

// ClearScreen is ^l, as a shell's clear-screen: the screen blank, the
// prompt (drawn whole by the next Draw) at its top.
func (t *Inline) ClearScreen(s *[]byte) {
	*s = append(*s, "\x1b[0m\x1b[H\x1b[2J"...)
	p := defaultPen
	t.Top, t.atX, t.atY, t.pen, t.prev = 0, 0, 0, &p, nil
}

// Clear is for quitting: the prompt's lines gone, the cursor where they
// started, for the shell's prompt.
func (t *Inline) Clear(s *[]byte) {
	t.go_(s, 0, t.Top)
	*s = append(*s, "\x1b[0m\x1b[J\x1b[?25h"...)
	t.prev = nil
}

// go_ moves the cursor to (x, y) on the screen, the short way.
func (t *Inline) go_(s *[]byte, x, y int) {
	cx, cy := t.atX, t.atY
	switch {
	case cx == x && cy == y:
	case cy == y && x == 0:
		*s = append(*s, '\r')
	case cy == y && x+1 == cx:
		*s = append(*s, 0x08)
	case cy == y && x < cx:
		*s = fmt.Appendf(*s, "\x1b[%dD", cx-x)
	case cy == y:
		*s = fmt.Appendf(*s, "\x1b[%dC", x-cx)
	case x == 0 && y == cy+1:
		*s = append(*s, "\r\n"...)
	default:
		*s = fmt.Appendf(*s, "\x1b[%d;%dH", y+1, x+1)
	}
	t.atX, t.atY = x, y
}

func (t *Inline) penTo(s *[]byte, p pen) {
	if t.pen == nil || *t.pen != p {
		sgr(s, p)
		t.pen = &p
	}
}

// cells writes row y's cells from x to end, from the cursor (on x).
// Returns the column it ends on.
func (t *Inline) cells(s *[]byte, buf *tui.Buffer, y, x, end int) int {
	for x < end {
		c := buf.At(x, y)
		t.penTo(s, pen{c.Fg, c.Bg, c.Mod})
		*s = append(*s, c.Sym...)
		x += max(tui.Width(c.Sym), 1)
	}
	t.atX = x
	return x
}

func at(buf *tui.Buffer, x, y int) *tui.Cell {
	if buf == nil || x >= buf.Area.W || y >= buf.Area.H {
		return nil
	}
	return buf.At(x, y)
}

// same: two cells look the same (a missing one is blank).
func same(a, b *tui.Cell) bool {
	switch {
	case a != nil && b != nil:
		return a.Sym == b.Sym && a.Fg == b.Fg && a.Bg == b.Bg && a.Mod == b.Mod
	case a != nil:
		return blank(a)
	case b != nil:
		return blank(b)
	}
	return true
}

func blank(c *tui.Cell) bool {
	return c.Sym == " " && c.Bg == tui.Reset && c.Mod&(tui.Reversed|tui.Underlined) == 0
}

// end is the columns row y takes: up to its last cell that isn't blank.
func end(buf *tui.Buffer, y int) int {
	for x := buf.Area.W - 1; x >= 0; x-- {
		if !blank(buf.At(x, y)) {
			return x + 1
		}
	}
	return 0
}

// starts is where row y's characters start, up to end.
func starts(buf *tui.Buffer, y, end int) []int {
	var out []int
	for x := 0; x < end; {
		out = append(out, x)
		x += max(tui.Width(buf.At(x, y).Sym), 1)
	}
	return out
}

// Plain is row y of buf as plain text (--snapshot), an image's cells `▒`.
func Plain(buf *tui.Buffer, y int) string {
	var b strings.Builder
	for x := 0; x < buf.Area.W; x++ {
		sym := buf.At(x, y).Sym
		if strings.HasPrefix(sym, string(tui.Placeholder)) {
			sym = "▒"
		}
		b.WriteString(sym)
	}
	return strings.TrimRight(b.String(), " \t\n")
}

// rowsAbove is the screen rows between the first line drawn and the cursor
// at (curX, curY), once lines widths wide are rewrapped to width.
func rowsAbove(widths []int, curX, curY, width int) int {
	width = max(width, 1)
	over := 0
	for i, w := range widths {
		if i >= curY {
			break
		}
		over += max((w+width-1)/width, 1)
	}
	return over + curX/width
}

func sgr(s *[]byte, p pen) {
	*s = append(*s, "\x1b[0"...)
	for _, m := range []struct {
		bit  tui.Modifier
		code string
	}{{tui.Bold, ";1"}, {tui.Dim, ";2"}, {tui.Italic, ";3"}, {tui.Underlined, ";4"}, {tui.Reversed, ";7"}, {tui.CrossedOut, ";9"}} {
		if p.mod&m.bit != 0 {
			*s = append(*s, m.code...)
		}
	}
	color(s, p.fg, 38)
	color(s, p.bg, 48)
	*s = append(*s, 'm')
}

func color(s *[]byte, c tui.Color, base int) {
	if c == tui.Reset {
		return
	}
	if r, g, b, ok := c.IsRGB(); ok {
		*s = fmt.Appendf(*s, ";%d;2;%d;%d;%d", base, r, g, b)
		return
	}
	if i, ok := c.IsIndexed(); ok {
		*s = fmt.Appendf(*s, ";%d;5;%d", base, i)
		return
	}
	if n, ok := c.Named(); ok {
		code := base - 8 + int(n)
		if n >= 8 {
			code = base + 52 + int(n) - 8
		}
		*s = fmt.Appendf(*s, ";%d", code)
	}
}
