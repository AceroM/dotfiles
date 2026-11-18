package app

// What o draws: the configuration ⏎ starts and `>` (`claude(opus) >`,
// yellow in plan mode), then the text in the terminal's own color,
// `[Image #N]` tags in blue; under it a toast and what's starting, only when
// there are. The drafts list (^g) draws the selected draft's images over
// it, as Kitty placeholders (package gfx); a draft being written, its
// images over its text, in a row. Nothing else, so a key changes as few
// cells as it can (package term writes only those). Each send, once
// started, is printed above in the scrollback: the prompt as it went, and
// the tab it went to.

import (
	"fmt"
	"path/filepath"
	"strings"

	"o/internal/field"
	"o/internal/gfx"
	"o/internal/tui"
)

// echoRows is the most rows a sent prompt's echo shows.
const echoRows = 4

func put(buf *tui.Buffer, x, y, maxX int, s string, st tui.Style) int {
	if x >= maxX || s == "" || y >= buf.Area.Bottom() {
		return x
	}
	return buf.SetStringN(x, y, s, maxX-x, st)
}

func fg(c tui.Color) tui.Style { return tui.FgStyle(c) }

func truncate(s string, w int) string {
	if field.StrWidth(s) <= w {
		return s
	}
	if w <= 0 {
		return ""
	}
	var out strings.Builder
	cw := 0
	for _, c := range s {
		x := tui.RuneWidth(c)
		if cw+x+1 > w {
			break
		}
		out.WriteRune(c)
		cw += x
	}
	out.WriteString("…")
	return out.String()
}

// textRow draws row r of text at (x, y) in st, its `[Image #N]` and
// `[Pasted text #N …]` tags in tag. Returns the column after it.
func textRow(buf *tui.Buffer, x, y, maxX int, text string, r field.Range, st tui.Style, tag tui.Color) int {
	tags := field.Tags(text)
	end := put(buf, x, y, maxX, text[r.Start:r.End], st)
	cx := x
	for bi, c := range text[r.Start:r.End] {
		cw := tui.RuneWidth(c)
		if cx+cw > maxX {
			break
		}
		for _, t := range tags {
			if t.R.Contains(r.Start + bi) {
				if cell := buf.Cell(cx, y); cell != nil {
					cell.Fg = tag
				}
				break
			}
		}
		cx += cw
	}
	return end
}

// Draw is the prompt's lines, Lay.Height of them, one column short of the
// terminal's width (package term leaves the last alone).
func Draw(a *App) *tui.Buffer {
	w := max(a.Lay.Width-1, 1)
	buf := tui.NewBuffer(tui.Rect{W: w, H: a.Lay.Height})
	switch {
	case a.SentAt >= 0:
		a.drawSentSelection(buf, a.SentAt)
	case a.List >= 0:
		a.drawList(buf, a.List)
	default:
		a.drawLines(buf)
	}
	y := a.Lay.Text.Bottom()
	y = a.drawSlash(buf, y)
	if a.drawToast(buf, y) {
		y++
	}
	a.drawStarting(buf, y)
	return buf
}

func (a *App) drawSentSelection(buf *tui.Buffer, sel int) {
	s := a.Sent[sel]
	mx := buf.Area.W
	p := a.Pal
	put(buf, 0, 0, mx, "▸", fg(p.Accent))
	title := s.Name + " · " + field.FirstLine(s.Text)
	put(buf, 2, 0, mx, truncate(title, max(mx-2, 0)), tui.NewStyle())
	if a.Lay.Text.H > 1 {
		dest, color := "starting…", p.Yellow
		if s.Outcome != nil {
			dest, color = s.Outcome.Msg, p.Red
			if s.Outcome.OK {
				color = p.Accent
			}
		}
		put(buf, 2, 1, mx, dest, fg(color))
	}
	if a.Lay.Text.H > 2 {
		keys := fmt.Sprintf("%d/%d · ↑ ↓ sessions · ⏎ focus · e edit · esc compose", sel+1, len(a.Sent))
		put(buf, 2, 2, mx, keys, fg(p.Dim))
	}
}

func (a *App) drawLines(buf *tui.Buffer) {
	p := a.Pal
	t := a.Lay.Text
	mx := buf.Area.W
	// A draft's images, over its text and lined up with it.
	if a.Pictures.Height > 0 {
		a.drawStrip(buf, t.X, a.Pictures.Thumbs, a.Pictures.Note)
	}
	text := a.Field.Text
	sel, hasSel := a.Field.Selection(), a.Field.HasSelection()
	for r := a.Scroll; r < len(a.Rows) && r < a.Scroll+t.H; r++ {
		row := a.Rows[r]
		y := t.Y + (r - a.Scroll)
		if r == 0 {
			// `claude(opus) >`; a draft's glyph is al's ◇.
			c := p.Muted
			if a.Plan {
				c = p.Yellow
			}
			put(buf, 0, y, mx, a.Prefix(), fg(c))
		}
		xEnd := textRow(buf, t.X, y, mx, text, row, tui.NewStyle(), p.Accent)
		if !hasSel {
			continue
		}
		// The selection lit; a selected line break shows as a cell past the
		// row's text.
		x := t.X
		for bi, c := range text[row.Start:row.End] {
			cw := max(tui.RuneWidth(c), 1)
			if x+cw > mx {
				break
			}
			if sel.Contains(row.Start + bi) {
				for cx := x; cx < x+cw; cx++ {
					if cell := buf.Cell(cx, y); cell != nil {
						cell.Bg = p.Sel
					}
				}
			}
			x += cw
		}
		breaks := row.End < len(text) && text[row.End] == '\n'
		if breaks && sel.Contains(row.End) && xEnd < mx {
			if cell := buf.Cell(xEnd, y); cell != nil {
				cell.Bg = p.Sel
			}
		}
	}
}

// drawList is the drafts list (^g), in the prompt's place: the selected
// draft's images on top, then a draft a row (▸ the selected one, ◆ a
// marked one, a reply's agent before its first line, its folder at the
// right), the selected one's text under them, then the keys.
func (a *App) drawList(buf *tui.Buffer, sel int) {
	p := a.Pal
	mx := buf.Area.W
	v := a.View
	y := 0
	if v.Strip > 0 {
		a.drawStrip(buf, 2, v.Thumbs, v.Note)
		y = v.Strip
	}
	for i := v.Top; i < len(a.Drafts) && i < v.Top+v.Shown; i++ {
		d := a.Drafts[i]
		on := i == sel
		marked := contains(a.Marked, d.ID)
		if on {
			put(buf, 0, y, mx, "▸", fg(p.Accent))
		}
		// Its folder (and its configuration, when it isn't the first), at the
		// right, when there's room.
		folder := filepath.Base(d.Cwd)
		if folder == "/" || folder == "." {
			folder = ""
		}
		side := folder
		if name, ok := a.DraftAgent(d); ok && d.Reply == nil && name != a.Agents[0].Name {
			side = name + " · " + folder
		}
		sideW := field.StrWidth(side)
		textMax := mx
		if mx > sideW+24 {
			textMax = mx - sideW - 2
		}
		glyph, gc := "◇ ", p.Dim
		if marked {
			glyph, gc = "◆ ", p.Accent
		}
		if d.Plan {
			gc = p.Yellow
		}
		x := put(buf, 2, y, textMax, glyph, fg(gc))
		if d.Reply != nil {
			x = put(buf, x, y, textMax, "↳"+d.Reply.Label+" ", fg(p.Accent))
		}
		first := field.FirstLine(d.Text)
		room := max(textMax-x, 0)
		if first == "" {
			put(buf, x, y, textMax, "(empty)", fg(p.Dim))
		} else {
			st := fg(p.Muted)
			if on || marked {
				st = tui.NewStyle()
			}
			put(buf, x, y, textMax, truncate(first, room), st)
		}
		if textMax < mx {
			put(buf, mx-sideW, y, mx, side, fg(p.Dim))
		}
		if marked {
			for cx := 2; cx < mx; cx++ {
				buf.At(cx, y).Bg = p.Sel
			}
		}
		y++
	}
	text := ""
	if sel < len(a.Drafts) {
		text = a.Drafts[sel].Text
	}
	for i, r := range v.Rows {
		if i >= v.Preview {
			break
		}
		put(buf, 2, y, mx, "│", fg(p.Dim))
		textRow(buf, 4, y, mx, text, r, fg(p.Muted), p.Accent)
		y++
	}
	if v.More > 0 && y+1 < a.Lay.Text.Bottom() {
		s := "s"
		if v.More == 1 {
			s = ""
		}
		put(buf, 2, y, mx, fmt.Sprintf("│ … +%d line%s", v.More, s), fg(p.Dim))
		y++
	}
	var keys string
	switch n := len(a.Marked); n {
	case 0:
		keys = fmt.Sprintf("%d/%d · j k · ⇧↑↓ mark · ⏎ send · e edit · x delete · u undo · d new · esc back", sel+1, len(a.Drafts))
	case 1:
		keys = "1 marked · ⇧↑↓ space a mark · ⏎ send it · x delete · esc unmark"
	default:
		keys = fmt.Sprintf("%d marked · ⇧↑↓ space a mark · ⏎ send as one prompt · x delete · esc unmark", n)
	}
	put(buf, 2, y, mx, truncate(keys, max(mx-2, 0)), fg(p.Dim))
}

// drawStrip draws images side by side from column left of the top row
// (the selected draft's over the list, or the draft being written's over
// its text), each with its `[Image #N]` under it; or what's said instead.
func (a *App) drawStrip(buf *tui.Buffer, left int, thumbs []Thumb, note string) {
	p := a.Pal
	mx := buf.Area.W
	end := left
	for _, t := range thumbs {
		x0 := left + t.X
		for r := 0; r < t.Rows; r++ {
			for c := 0; c < t.Cols; c++ {
				if cell := buf.Cell(x0+c, r); cell != nil {
					gfx.Placeholder(cell, t.ID, r, c)
				}
			}
		}
		label := put(buf, x0, t.Rows, mx, fmt.Sprintf("[Image #%d]", t.N), fg(p.Accent))
		end = max(end, x0+t.Cols, label)
	}
	if note != "" {
		x := left
		if len(thumbs) > 0 {
			x = end + 2
		}
		put(buf, x, 0, mx, note, fg(p.Dim))
	}
}

// drawToast draws a toast, under the text for a moment: green when it
// worked, red when it didn't. False when there's none.
func (a *App) drawToast(buf *tui.Buffer, y int) bool {
	if a.Toast == nil {
		return false
	}
	p := a.Pal
	mx := buf.Area.W
	mark, c := "✗ ", p.Red
	if a.Toast.OK {
		mark, c = "✓ ", p.Green
	}
	x := put(buf, 2, y, mx, mark, fg(c))
	put(buf, x, y, mx, truncate(a.Toast.Msg, max(mx-x, 0)), fg(p.Dim))
	return true
}

// drawStarting draws the sends still starting, under the text.
func (a *App) drawStarting(buf *tui.Buffer, y int) {
	p := a.Pal
	mx := buf.Area.W
	for _, s := range a.Sent {
		if s.Outcome != nil {
			continue
		}
		if y >= buf.Area.Bottom() {
			return
		}
		x := put(buf, 2, y, mx, "• ", fg(p.Yellow))
		x = put(buf, x, y, mx, s.Name, fg(p.Accent))
		x = put(buf, x, y, mx, " · ", fg(p.Dim))
		room := max(mx-(x+14), 0)
		x = put(buf, x, y, mx, truncate(field.FirstLine(s.Text), room), fg(p.Muted))
		put(buf, x+2, y, mx, "starting…", fg(p.Dim))
		y++
	}
}

// Entry is a started (or failed) send, for printing above the prompt: the
// prompt as it went (its first rows), then where it went, then a blank line.
func Entry(a *App, s *Sent, width int) *tui.Buffer {
	p := a.Pal
	w := max(a.Cap(width)-1, 1)
	tw := max(w-3, 4)
	rows := field.WordRows(s.Text, tw)
	shown := min(len(rows), echoRows)
	more := len(rows) - shown
	h := shown + 2
	if more > 0 {
		h++
	}
	buf := tui.NewBuffer(tui.Rect{W: w, H: h})
	for i := 0; i < shown; i++ {
		if i == 0 {
			put(buf, 0, 0, w, ">", fg(p.Muted))
		}
		textRow(buf, 2, i, w, s.Text, rows[i], fg(p.Muted), p.Accent)
	}
	y := shown
	if more > 0 {
		pl := "s"
		if more == 1 {
			pl = ""
		}
		put(buf, 2, y, w, fmt.Sprintf("… +%d line%s", more, pl), fg(p.Dim))
		y++
	}
	x := put(buf, 2, y, w, "⎿  ", fg(p.Dim))
	switch {
	case s.Outcome != nil && s.Outcome.OK:
		x := put(buf, x, y, w, s.Name, fg(p.Accent))
		if s.Plan {
			x = put(buf, x, y, w, " · plan", fg(p.Yellow))
		}
		put(buf, x+1, y, w, s.Outcome.Msg, fg(p.Dim))
	case s.Outcome != nil:
		put(buf, x, y, w, "✗ "+s.Outcome.Msg, fg(p.Red))
	}
	return buf
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
