// Package probe is what o asks the terminal at startup, in one round trip:
// whether it speaks the kitty keyboard protocol (so shift+Enter and ^⏎
// arrive as themselves), where the cursor is (the prompt starts there), and
// whether it draws Kitty images, with a cell's size in pixels. The primary
// device attributes go last: every terminal answers them, so they end the
// wait.
package probe

import (
	"os"
	"strconv"
	"strings"
	"time"

	"o/internal/gfx"
	"o/internal/tui"
)

type Probe struct {
	KittyKeys bool
	// Cursor is (column, row), 0-based; HasCursor when the terminal said.
	CursorX, CursorY int
	HasCursor        bool
	// Gfx is set where the terminal draws Kitty images (and O_IMAGES isn't 0).
	Gfx *gfx.Gfx
}

// Run asks. Call it in raw mode, before anything else reads input: the
// answers come back through in, which keeps whatever follows them (keys
// typed meanwhile) for its events.
func Run(in *tui.Input) Probe {
	ask := "\x1b[?u\x1b[6n"
	images := gfx.Wanted()
	if images {
		ask += gfx.Query + "\x1b[16t"
	}
	ask += "\x1b[c"
	if _, err := os.Stdout.WriteString(ask); err != nil {
		return Probe{}
	}
	end := -1
	raw := in.Raw(500*time.Millisecond, func(b []byte) bool {
		end = replyEnd(string(b))
		return end >= 0
	})
	reply := string(raw)
	if end >= 0 {
		reply = reply[:end]
		in.Drop(end)
	} else {
		in.Drop(len(raw))
	}
	p := Probe{}
	_, p.KittyKeys = csiReply(reply, "\x1b[?", 'u')
	p.CursorX, p.CursorY, p.HasCursor = cursorFromReply(reply)
	if images && gfx.Supported(reply) {
		if g, ok := gfx.CellFromReply(reply); ok {
			p.Gfx = &g
		} else if g, ok := gfx.CellFromIoctl(); ok {
			p.Gfx = &g
		}
	}
	return p
}

// replyEnd is where the device attributes' reply ends, -1 before it's all here.
func replyEnd(s string) int {
	rest, off := s, 0
	for {
		i := strings.Index(rest, "\x1b[?")
		if i < 0 {
			return -1
		}
		body := rest[i+3:]
		n := 0
		for n < len(body) && (body[n] >= '0' && body[n] <= '9' || body[n] == ';') {
			n++
		}
		if n < len(body) && body[n] == 'c' {
			return off + i + 3 + n + 1
		}
		off += i + 3
		rest = body
	}
}

// csiReply is the body of the first `start … end` reply (digits and ; between).
func csiReply(s, start string, end byte) (string, bool) {
	rest := s
	for {
		i := strings.Index(rest, start)
		if i < 0 {
			return "", false
		}
		body := rest[i+len(start):]
		n := 0
		for n < len(body) && (body[n] >= '0' && body[n] <= '9' || body[n] == ';') {
			n++
		}
		if n < len(body) && body[n] == end {
			return body[:n], true
		}
		rest = body
	}
}

// cursorFromReply reads `ESC [ row ; col R`, 1-based, as (column, row) 0-based.
func cursorFromReply(s string) (int, int, bool) {
	body, ok := csiReply(s, "\x1b[", 'R')
	if !ok {
		return 0, 0, false
	}
	r, c, ok := strings.Cut(body, ";")
	if !ok {
		return 0, 0, false
	}
	row, e1 := strconv.Atoi(r)
	col, e2 := strconv.Atoi(c)
	if e1 != nil || e2 != nil {
		return 0, 0, false
	}
	return max(col-1, 0), max(row-1, 0), true
}
