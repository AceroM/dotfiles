// Package viewer is `o --images BLOCK`: the images behind a pane's
// `[Image #N]` tags (package panes), each as big as the pane lets it be (no
// bigger than the file itself), its tag under it. Caps+N / ⌥⌘N opens it in
// a floating pane over that pane (float-here in Rex's config). Over o's
// prompt it follows the prompt: an image pasted in shows up, one deleted
// goes.
//
// 1…9 show that image alone (again, or 0: all of them), ← → step through
// them one at a time; esc, q, ⏎ or space close it, and the pane it was
// opened over gets the focus back.
package viewer

import (
	"fmt"

	"os"
	"os/exec"
	"strings"
	"time"

	"o/internal/drafts"
	"o/internal/gfx"
	"o/internal/panes"
	"o/internal/probe"
	"o/internal/term"
	"o/internal/theme"
	"o/internal/tui"
)

// poll is how often the pane's file is looked at for changes.
const poll = 250 * time.Millisecond

// Columns between images side by side, rows between rows of them.
const gapX, gapY = 2, 1

// Title is the pane's title: Rex's pane label, and how Rex's config tells a viewer.
const Title = "o images"

// ready is a file readied for the terminal, and how many times bigger the
// file itself is (a 5K screenshot goes shrunk, and may be drawn bigger).
type ready struct {
	pic gfx.Pic
	up  float64
	err error
}

type loaded struct {
	path string
	r    ready
}

type Viewer struct {
	pal  theme.Palette
	Gfx  *gfx.Gfx
	file string
	// seen is the file's time when last read; zero: not there.
	seen   time.Time
	kind   string
	Images []drafts.Tagged
	// pics is each file, readied (nil while it loads).
	pics map[string]*ready
	done chan loaded
	imgs gfx.Images
	// One is one image alone: its place in Images (-1: all of them).
	One int
	// live is false in tests: images load at once, on this goroutine.
	live bool
}

func New(pal theme.Palette, file string) *Viewer {
	v := &Viewer{pal: pal, file: file, kind: panes.Prompt, pics: map[string]*ready{}, done: make(chan loaded, 16), One: -1, live: true}
	v.reread()
	return v
}

// reread reads the pane's file again if it changed. Gone (the prompt sent
// or emptied, o quit), what was shown stays. True when it changed.
func (v *Viewer) reread() bool {
	var stamp time.Time
	if fi, err := os.Stat(v.file); err == nil {
		stamp = fi.ModTime()
	}
	if stamp.Equal(v.seen) {
		return false
	}
	v.seen = stamp
	kind, images, ok := panes.Read(v.file)
	if !ok || (kind == v.kind && sameTagged(images, v.Images)) {
		return false
	}
	// Still showing one alone: the same tag, if it's still there.
	one := -1
	if v.One >= 0 && v.One < len(v.Images) {
		n := v.Images[v.One].N
		for i, t := range images {
			if t.N == n {
				one = i
			}
		}
	}
	v.One, v.kind, v.Images = one, kind, images
	return true
}

func sameTagged(a, b []drafts.Tagged) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// tick: images loaded, the file changed. True when the screen did.
func (v *Viewer) tick() bool {
	changed := v.reread()
	for {
		select {
		case l := <-v.done:
			r := l.r
			v.pics[l.path] = &r
			changed = true
		default:
			return changed
		}
	}
}

// load starts readying the files not seen yet.
func (v *Viewer) load() {
	for _, t := range v.Images {
		if _, seen := v.pics[t.Path]; seen {
			continue
		}
		if !v.live {
			r := readyPic(t.Path)
			v.pics[t.Path] = &r
			continue
		}
		v.pics[t.Path] = nil
		go func(path string) { v.done <- loaded{path, readyPic(path)} }(t.Path)
	}
}

// key handles a key: false to close; changed when the screen did.
func (v *Viewer) key(k tui.Key) (keep, changed bool) {
	count := len(v.Images)
	switch {
	case k.Code == tui.KeyEsc || k.Code == tui.KeyEnter || k.Is('q') || k.Is(' '):
		return false, false
	case (k.Is('c') || k.Is('d')) && k.Has(tui.ModCtrl):
		return false, false
	case k.Is('0'):
		v.One = -1
	case k.Code == tui.KeyRune && k.Rune >= '1' && k.Rune <= '9':
		n := int(k.Rune - '0')
		at := -1
		for i, t := range v.Images {
			if t.N == n {
				at = i
				break
			}
		}
		switch {
		case v.One >= 0 && v.One == at:
			v.One = -1
		case at >= 0:
			v.One = at
		}
	case k.Code == tui.KeyRight && count > 0:
		v.One = (v.One + 1) % count
		if v.One < 0 {
			v.One = 0
		}
	case k.Code == tui.KeyLeft && count > 0:
		if v.One < 0 {
			v.One = count - 1
		} else {
			v.One = (v.One + count - 1) % count
		}
	default:
		return true, false
	}
	return true, true
}

// Draw is the frame for a w×h pane. Images it draws go to the terminal
// first (imgs.Take).
func (v *Viewer) Draw(w, h int) *tui.Buffer {
	v.load()
	buf := tui.NewBuffer(tui.Rect{W: w, H: h})
	accent, dim, muted, red := v.pal.Accent, v.pal.Dim, v.pal.Muted, v.pal.Red
	total := len(v.Images)
	var shown []int
	if v.One >= 0 && v.One < total {
		shown = []int{v.One}
	} else {
		for i := range v.Images {
			shown = append(shown, i)
		}
	}
	whose := "in o's prompt"
	if v.kind == panes.Sent {
		whose = "sent with this tab's prompt"
	}
	many := fmt.Sprintf("%d images", total)
	if total == 1 {
		many = "1 image"
	}
	put(buf, 1, 0, many+" "+whose, dim)
	keys := "esc closes"
	switch {
	case v.One >= 0 && total > 1:
		keys = fmt.Sprintf("%d of %d · ← → · 0 all · esc closes", v.One+1, total)
	case v.One < 0 && total > 1:
		keys = "1–9 one alone · ← → · esc closes"
	}
	put(buf, 1, max(h-1, 0), keys, dim)
	if total == 0 {
		centered(buf, "no images", dim)
		return buf
	}
	if v.Gfx == nil {
		// A terminal that doesn't draw images: where they are, at least.
		for j, i := range shown {
			y := 2 + j
			if y >= h-2 {
				break
			}
			x := put(buf, 1, y, fmt.Sprintf("[Image #%d]", v.Images[i].N), accent)
			put(buf, x+2, y, drafts.Tilde(v.Images[i].Path), muted)
		}
		put(buf, 1, max(h-2, 0), "(this terminal doesn't draw images)", dim)
		return buf
	}
	type item struct {
		i, n int
		w, h int
		up   float64
	}
	var items []item
	var failed []string
	for _, i := range shown {
		t := v.Images[i]
		r, ok := v.pics[t.Path]
		switch {
		case !ok || r == nil:
			centered(buf, "loading…", dim)
			return buf
		case r.err != nil:
			failed = append(failed, fmt.Sprintf("#%d", t.N))
		default:
			items = append(items, item{i, t.N, r.pic.W, r.pic.H, r.up})
		}
	}
	if len(failed) > 0 {
		msg := "✗ can't read " + strings.Join(failed, " ")
		put(buf, max(w-2-tui.Width(msg), 1), 0, msg, red)
	}
	// Between the title row and the keys' row, a column spare each side.
	aw, ah := max(w-2, 0), max(h-2, 0)
	sizes := make([]size, len(items))
	for j, it := range items {
		sizes[j] = size{it.n, it.w, it.h, it.up}
	}
	for j, place := range grid(sizes, *v.Gfx, aw, ah) {
		it := items[j]
		x, y := place.x+1, place.y+1
		path := v.Images[it.i].Path
		id := v.imgs.IDFor(gfx.Key{Path: path, Cols: place.cols, Rows: place.rows}, v.pics[path].pic.B64)
		for r := 0; r < place.rows; r++ {
			for c := 0; c < place.cols; c++ {
				if cell := buf.Cell(x+c, y+r); cell != nil {
					gfx.Placeholder(cell, id, r, c)
				}
			}
		}
		end := put(buf, x, y+place.rows, fmt.Sprintf("[Image #%d]", it.n), accent)
		// Alone: where it is, too.
		if v.One >= 0 {
			put(buf, end+2, y+place.rows, drafts.Tilde(path), dim)
		}
	}
	return buf
}

// readyPic is path readied for the terminal, big.
func readyPic(path string) ready {
	pic, err := gfx.LoadPicAt(path, gfx.Big)
	if err != nil {
		return ready{err: err}
	}
	up := 1.0
	if fw, _, ok := gfx.PNGFileSize(path); ok {
		up = float64(fw) / float64(max(pic.W, 1))
	}
	return ready{pic: pic, up: up}
}

type size struct {
	n, w, h int
	up      float64
}

type place struct{ x, y, cols, rows int }

// grid is where each image goes in w×h cells, drawn as big as they all can
// be: a label row under each (its `[Image #n]`). The images go in rows, as
// many to a row as makes them biggest together; each row is centered, and
// the whole of them.
func grid(items []size, g gfx.Gfx, w, h int) []place {
	n := len(items)
	label := func(n int) int { return len(fmt.Sprintf("[Image #%d]", n)) }
	bestArea, bestPer := -1, 0
	var bestCells [][2]int
	for perRow := 1; perRow <= n; perRow++ {
		rows := (n + perRow - 1) / perRow
		slotW := max(w-gapX*(perRow-1), 0) / perRow
		slotH := max(h-gapY*(rows-1), 0) / rows
		if slotW < 4 || slotH < 2 {
			continue
		}
		cells := make([][2]int, n)
		area := 0
		for i, it := range items {
			c, r := gfx.FitUpto(it.w, it.h, g, slotW, slotH-1, it.up)
			cells[i] = [2]int{c, r}
			area += c * r
		}
		if area > bestArea {
			bestArea, bestPer, bestCells = area, perRow, cells
		}
	}
	if bestArea < 0 {
		return nil
	}
	type cell struct {
		n          int
		cols, rows int
	}
	var rows [][]cell
	for i := 0; i < n; i += bestPer {
		var row []cell
		for j := i; j < min(i+bestPer, n); j++ {
			row = append(row, cell{items[j].n, bestCells[j][0], bestCells[j][1]})
		}
		rows = append(rows, row)
	}
	rowH := make([]int, len(rows))
	total := 0
	for i, r := range rows {
		for _, c := range r {
			rowH[i] = max(rowH[i], c.rows)
		}
		rowH[i]++
		total += rowH[i]
	}
	y := max(h-(total+gapY*(len(rows)-1)), 0) / 2
	var out []place
	for i, row := range rows {
		width := func(c cell) int { return max(c.cols, label(c.n)) }
		across := gapX * (len(row) - 1)
		for _, c := range row {
			across += width(c)
		}
		x := max(w-across, 0) / 2
		for _, c := range row {
			out = append(out, place{x, y, c.cols, c.rows})
			x += width(c) + gapX
		}
		y += rowH[i] + gapY
	}
	return out
}

func put(buf *tui.Buffer, x, y int, s string, c tui.Color) int {
	max := buf.Area.W - 1
	if x >= max || y >= buf.Area.H || y < 0 {
		return x
	}
	return buf.SetStringN(x, y, s, max-x, tui.FgStyle(c))
}

func centered(buf *tui.Buffer, s string, c tui.Color) {
	put(buf, max(buf.Area.W-tui.Width(s), 0)/2, buf.Area.H/2, s, c)
}

// Run is `o --images BLOCK`: show block's images until a key closes it,
// then hand the focus back to that block.
func Run(block string, pal theme.Palette) int {
	v := New(pal, panes.File(block))
	tty, err := tui.OpenTty()
	if err == nil {
		err = tty.Raw()
	}
	if err != nil {
		// No terminal: say where they are.
		for _, t := range v.Images {
			fmt.Printf("[Image #%d] %s\n", t.N, t.Path)
		}
		return 0
	}
	in := tui.NewInput(tty)
	v.Gfx = probe.Run(in).Gfx
	// The alternate screen, no cursor, and a title (Rex's pane label).
	fmt.Fprintf(os.Stdout, "\x1b[?1049h\x1b[?25l\x1b]2;%s\x07", Title)
	w, h, _, _, err := tui.Size()
	if err != nil {
		w, h = 80, 24
	}
	t := term.New(w, h, 0, 0)
	loop(v, in, t)
	s := v.imgs.Clear()
	s = append(s, "\x1b[0m\x1b[?25h\x1b[?1049l"...)
	os.Stdout.Write(s)
	tty.Restore()
	giveBack(block)
	return 0
}

func loop(v *Viewer, in *tui.Input, t *term.Inline) {
	dirty := true
	for {
		if v.tick() {
			dirty = true
		}
		if dirty {
			buf := v.Draw(t.Width, t.Rows)
			s := v.imgs.Take()
			t.Draw(&s, buf, nil)
			os.Stdout.Write(s)
			dirty = false
		}
		ev, ok := in.Next(poll)
		if !ok {
			continue
		}
		switch e := ev.(type) {
		case tui.Resize:
			*t = *term.New(e.W, e.H, 0, 0)
			var s []byte
			t.ClearScreen(&s)
			os.Stdout.Write(s)
			dirty = true
		case tui.Key:
			if e.Release {
				continue
			}
			keep, changed := v.key(e)
			if !keep {
				return
			}
			dirty = dirty || changed
		}
	}
}

// giveBack: closing, the focus goes back on the pane the viewer was opened
// over (Rex would otherwise pick a pane of the tab itself), when that's
// another one.
func giveBack(block string) {
	ses, here := os.Getenv("REX_SESSION"), os.Getenv("REX_BLOCK")
	if ses == "" || here == block || !strings.HasPrefix(block, "block:") {
		return
	}
	_ = exec.Command("rex", "focus", "-s", ses, block).Run()
}
