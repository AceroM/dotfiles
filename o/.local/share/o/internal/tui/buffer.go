// Package tui is what o draws with and reads keys through: a grid of styled
// cells (ratatui's Buffer, the part o used), the terminal's keys and mouse
// decoded into events (crossterm's), raw mode and the window's size.
package tui

import (
	"strings"
	"unicode"

	"github.com/rivo/uniseg"
)

// Color is a cell's foreground or background: Reset (the terminal's own),
// one of the 16 named colors, an indexed one, or RGB.
type Color uint32

const Reset Color = 0

// The named colors, in SGR order: Black is 30/40, DarkGray 90/100.
const (
	Black Color = iota + 1
	Red
	Green
	Yellow
	Blue
	Magenta
	Cyan
	Gray
	DarkGray
	LightRed
	LightGreen
	LightYellow
	LightBlue
	LightMagenta
	LightCyan
	White
)

const (
	rgbFlag     Color = 1 << 24
	indexedFlag Color = 1 << 25
)

func RGB(r, g, b uint8) Color { return rgbFlag | Color(r)<<16 | Color(g)<<8 | Color(b) }
func Indexed(i uint8) Color   { return indexedFlag | Color(i) }

// IsRGB reports an RGB color and its parts.
func (c Color) IsRGB() (r, g, b uint8, ok bool) {
	if c&rgbFlag == 0 {
		return 0, 0, 0, false
	}
	return uint8(c >> 16), uint8(c >> 8), uint8(c), true
}

// IsIndexed reports an indexed color and its index.
func (c Color) IsIndexed() (uint8, bool) {
	if c&indexedFlag == 0 {
		return 0, false
	}
	return uint8(c), true
}

// Named is a named color's number, 0 (Black) to 15 (White).
func (c Color) Named() (uint8, bool) {
	if c >= Black && c <= White {
		return uint8(c - Black), true
	}
	return 0, false
}

// Modifier is a cell's text attributes.
type Modifier uint16

const (
	Bold Modifier = 1 << iota
	Dim
	Italic
	Underlined
	SlowBlink
	RapidBlink
	Reversed
	Hidden
	CrossedOut
)

// Style changes a cell's look: the colors it sets, the modifiers it adds and
// takes away. The zero Style changes nothing.
type Style struct {
	fg, bg       Color
	hasFg, hasBg bool
	add, sub     Modifier
}

func NewStyle() Style                   { return Style{} }
func FgStyle(c Color) Style             { return Style{fg: c, hasFg: true} }
func (s Style) Fg(c Color) Style        { s.fg, s.hasFg = c, true; return s }
func (s Style) Bg(c Color) Style        { s.bg, s.hasBg = c, true; return s }
func (s Style) Add(m Modifier) Style    { s.add |= m; s.sub &^= m; return s }
func (s Style) Remove(m Modifier) Style { s.sub |= m; s.add &^= m; return s }

// Cell is one place on the grid: its symbol (a grapheme; " " when blank) and
// how it's drawn.
type Cell struct {
	Sym string
	Fg  Color
	Bg  Color
	Mod Modifier
}

var blankCell = Cell{Sym: " "}

func (c *Cell) Reset() { *c = blankCell }

func (c *Cell) SetStyle(s Style) {
	if s.hasFg {
		c.Fg = s.fg
	}
	if s.hasBg {
		c.Bg = s.bg
	}
	c.Mod = (c.Mod | s.add) &^ s.sub
}

// Rect is an area of the grid.
type Rect struct{ X, Y, W, H int }

func (r Rect) Bottom() int { return r.Y + r.H }
func (r Rect) Right() int  { return r.X + r.W }

// Buffer is a grid of cells over Area (o's are always at 0,0).
type Buffer struct {
	Area  Rect
	Cells []Cell
}

// NewBuffer is a blank grid over area.
func NewBuffer(area Rect) *Buffer {
	if area.W < 0 {
		area.W = 0
	}
	if area.H < 0 {
		area.H = 0
	}
	cells := make([]Cell, area.W*area.H)
	for i := range cells {
		cells[i] = blankCell
	}
	return &Buffer{Area: area, Cells: cells}
}

// Cell is the cell at (x, y), nil outside the grid.
func (b *Buffer) Cell(x, y int) *Cell {
	x, y = x-b.Area.X, y-b.Area.Y
	if x < 0 || y < 0 || x >= b.Area.W || y >= b.Area.H {
		return nil
	}
	return &b.Cells[y*b.Area.W+x]
}

// At is the cell at (x, y), which must be on the grid.
func (b *Buffer) At(x, y int) *Cell {
	c := b.Cell(x, y)
	if c == nil {
		panic("tui: cell outside the buffer")
	}
	return c
}

// SetString writes s from (x, y) to the grid's right edge (SetStringN).
func (b *Buffer) SetString(x, y int, s string, st Style) int {
	return b.SetStringN(x, y, s, 1<<30, st)
}

// SetStringN writes s from (x, y), at most maxWidth columns and no further
// than the grid's right edge, as ratatui's set_stringn does: a grapheme a
// cell, control characters and zero-width ones left out, the cells a wide
// one covers blanked. Returns the column after the last one written.
func (b *Buffer) SetStringN(x, y int, s string, maxWidth int, st Style) int {
	if y < b.Area.Y || y >= b.Area.Bottom() {
		return x
	}
	remaining := b.Area.Right() - x
	if remaining < 0 {
		remaining = 0
	}
	if maxWidth < remaining {
		remaining = maxWidth
	}
	state := -1
	for len(s) > 0 {
		var g string
		g, s, _, state = uniseg.FirstGraphemeClusterInString(s, state)
		if hasControl(g) {
			continue
		}
		w := Width(g)
		if w == 0 {
			continue
		}
		if remaining < w {
			break
		}
		remaining -= w
		c := b.Cell(x, y)
		if c == nil {
			break
		}
		c.Sym = g
		c.SetStyle(st)
		next := x + w
		x++
		for x < next {
			if c := b.Cell(x, y); c != nil {
				c.Reset()
			}
			x++
		}
	}
	return x
}

func hasControl(s string) bool {
	for _, r := range s {
		if unicode.IsControl(r) {
			return true
		}
	}
	return false
}

// Placeholder is the character Kitty reserves for image placeholders: one
// column wide, whatever diacritics follow it.
const Placeholder = '\U0010EEEE'

// Width is the columns s takes on the terminal.
func Width(s string) int {
	if strings.HasPrefix(s, string(Placeholder)) {
		// A placeholder and its diacritics: one cell (gfx.go).
		return 1
	}
	return uniseg.StringWidth(s)
}

// RuneWidth is the columns r takes on its own: 0 for control characters and
// combining marks.
func RuneWidth(r rune) int {
	if r < 0x20 || (r >= 0x7f && r < 0xa0) {
		return 0
	}
	if r < 0x7f {
		return 1
	}
	if r == Placeholder {
		return 1
	}
	return uniseg.StringWidth(string(r))
}
