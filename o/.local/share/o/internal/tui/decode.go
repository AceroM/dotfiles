package tui

import (
	"bytes"
	"strconv"
	"strings"
	"unicode/utf8"
)

// decode reads the first event from b, as crossterm's parser does: the
// event (nil for bytes that mean nothing to o, such as the terminal's
// replies), how many bytes it took, and whether b ends before the event
// does (more bytes are needed; nothing was taken).
func decode(b []byte) (ev Event, n int, incomplete bool) {
	if len(b) == 0 {
		return nil, 0, true
	}
	switch c := b[0]; {
	case c == 0x1b:
		return decodeEsc(b)
	case c == '\r':
		return Key{Code: KeyEnter}, 1, false
	case c == '\t':
		return Key{Code: KeyTab}, 1, false
	case c == 0x7f:
		return Key{Code: KeyBackspace}, 1, false
	case c == 0:
		return Key{Code: KeyRune, Rune: ' ', Mod: ModCtrl}, 1, false
	case c >= 0x01 && c <= 0x1a:
		// ^a … ^z; in raw mode \n is ^j and \b is ^h.
		return Key{Code: KeyRune, Rune: rune(c-1) + 'a', Mod: ModCtrl}, 1, false
	case c >= 0x1c && c <= 0x1f:
		return Key{Code: KeyRune, Rune: rune(c-0x1c) + '4', Mod: ModCtrl}, 1, false
	}
	if !utf8.FullRune(b) {
		return nil, 0, true
	}
	r, size := utf8.DecodeRune(b)
	if r == utf8.RuneError && size <= 1 {
		return nil, 1, false
	}
	return Ch(r), size, false
}

func decodeEsc(b []byte) (Event, int, bool) {
	if len(b) == 1 {
		return nil, 0, true
	}
	switch b[1] {
	case '[':
		return decodeCSI(b)
	case 'O':
		if len(b) < 3 {
			return nil, 0, true
		}
		switch b[2] {
		case 'A':
			return Key{Code: KeyUp}, 3, false
		case 'B':
			return Key{Code: KeyDown}, 3, false
		case 'C':
			return Key{Code: KeyRight}, 3, false
		case 'D':
			return Key{Code: KeyLeft}, 3, false
		case 'H':
			return Key{Code: KeyHome}, 3, false
		case 'F':
			return Key{Code: KeyEnd}, 3, false
		case 'P', 'Q', 'R', 'S':
			return Key{Code: KeyF, F: int(b[2]-'P') + 1}, 3, false
		}
		return Key{Code: KeyRune, Rune: 'O', Mod: ModAlt | ModShift}, 2, false
	case 0x1b:
		return Key{Code: KeyEsc}, 2, false
	case '_':
		// A Kitty graphics reply (ESC _ G … ESC \): o asks for none after
		// the probe, but a late one mustn't come in as keys.
		if len(b) < 3 {
			return nil, 0, true
		}
		if b[2] == 'G' {
			end := bytes.Index(b, []byte("\x1b\\"))
			if end < 0 {
				return nil, 0, true
			}
			return nil, end + 2, false
		}
	}
	ev, n, inc := decode(b[1:])
	if inc {
		return nil, 0, true
	}
	if k, ok := ev.(Key); ok {
		k.Mod |= ModAlt
		ev = k
	}
	return ev, n + 1, false
}

var pasteStart, pasteEnd = []byte("\x1b[200~"), []byte("\x1b[201~")

func decodeCSI(b []byte) (Event, int, bool) {
	if len(b) < 3 {
		return nil, 0, true
	}
	if bytes.HasPrefix(b, pasteStart) {
		end := bytes.Index(b[len(pasteStart):], pasteEnd)
		if end < 0 {
			return nil, 0, true
		}
		text := b[len(pasteStart) : len(pasteStart)+end]
		return Paste(string(text)), len(pasteStart) + end + len(pasteEnd), false
	}
	if len(pasteStart) > len(b) && bytes.HasPrefix(pasteStart, b) {
		return nil, 0, true
	}
	switch b[2] {
	case 'M':
		// X10 mouse: ESC [ M and three bytes.
		if len(b) < 6 {
			return nil, 0, true
		}
		ev := mouseFrom(int(b[3])-32, int(b[4])-32-1, int(b[5])-32-1, false)
		return ev, 6, false
	case '[':
		// The Linux console's F1–F5.
		if len(b) < 4 {
			return nil, 0, true
		}
		if b[3] >= 'A' && b[3] <= 'E' {
			return Key{Code: KeyF, F: int(b[3]-'A') + 1}, 4, false
		}
		return nil, 4, false
	}
	// Parameters (0x30–0x3f), intermediates (0x20–0x2f), then the final byte.
	i := 2
	for i < len(b) && b[i] >= 0x20 && b[i] <= 0x3f {
		i++
	}
	if i == len(b) {
		return nil, 0, true
	}
	final := b[i]
	n := i + 1
	if final < 0x40 || final > 0x7e {
		// Not a CSI sequence after all: drop the ESC [.
		return nil, 2, false
	}
	params := string(b[2:i])
	return csiEvent(params, final), n, false
}

// csiEvent is what CSI params final means.
func csiEvent(params string, final byte) Event {
	if strings.HasPrefix(params, "?") || strings.HasPrefix(params, ">") || strings.HasPrefix(params, "=") {
		// Replies: the keyboard flags (?…u), device attributes (?…c).
		return nil
	}
	if strings.HasPrefix(params, "<") {
		if final != 'M' && final != 'm' {
			return nil
		}
		p := ints(params[1:], ';')
		if len(p) < 3 {
			return nil
		}
		return mouseFrom(p[0], p[1]-1, p[2]-1, final == 'm')
	}
	switch final {
	case 'u':
		return kittyKey(params)
	case '~':
		return specialKey(params)
	case 'R':
		p := ints(params, ';')
		if len(p) == 2 {
			return CursorPos{X: p[1] - 1, Y: p[0] - 1}
		}
		return nil
	case 'Z':
		return Key{Code: KeyBackTab, Mod: ModShift}
	case 'I', 'O':
		// Focus in and out.
		return nil
	}
	code, ok := map[byte]KeyCode{'A': KeyUp, 'B': KeyDown, 'C': KeyRight, 'D': KeyLeft, 'H': KeyHome, 'F': KeyEnd, 'P': KeyF, 'Q': KeyF, 'S': KeyF}[final]
	if !ok {
		return nil
	}
	k := Key{Code: code}
	if code == KeyF {
		k.F = map[byte]int{'P': 1, 'Q': 2, 'S': 4}[final]
	}
	// ESC [ 1 ; MODS A
	if parts := strings.Split(params, ";"); len(parts) == 2 {
		k.Mod, k.Release = modsOf(parts[1])
	}
	return k
}

// modsOf reads a modifier parameter, `MASK[:EVENT]`: the mask is one more
// than the bits (shift 1, alt 2, ctrl 4, super 8, hyper 16, meta 32), and
// event 3 is a release.
func modsOf(s string) (Mod, bool) {
	mask, ev, _ := strings.Cut(s, ":")
	n, err := strconv.Atoi(mask)
	if err != nil || n < 1 {
		return 0, false
	}
	return Mod(n - 1), ev == "3"
}

func specialKey(params string) Event {
	parts := strings.Split(params, ";")
	n, err := strconv.Atoi(parts[0])
	if err != nil {
		return nil
	}
	var k Key
	switch {
	case n == 1 || n == 7:
		k.Code = KeyHome
	case n == 2:
		k.Code = KeyInsert
	case n == 3:
		k.Code = KeyDelete
	case n == 4 || n == 8:
		k.Code = KeyEnd
	case n == 5:
		k.Code = KeyPageUp
	case n == 6:
		k.Code = KeyPageDown
	case n >= 11 && n <= 15:
		k.Code, k.F = KeyF, n-10
	case n >= 17 && n <= 21:
		k.Code, k.F = KeyF, n-11
	case n >= 23 && n <= 26:
		k.Code, k.F = KeyF, n-12
	case n >= 28 && n <= 29:
		k.Code, k.F = KeyF, n-15
	case n >= 31 && n <= 34:
		k.Code, k.F = KeyF, n-17
	default:
		return nil
	}
	if len(parts) > 1 {
		k.Mod, k.Release = modsOf(parts[1])
	}
	return k
}

// kittyKey reads the kitty keyboard protocol's CSI CODE[:SHIFTED[:BASE]]
// [;MODS[:EVENT][;TEXT]] u.
func kittyKey(params string) Event {
	parts := strings.Split(params, ";")
	codes := strings.Split(parts[0], ":")
	cp, err := strconv.Atoi(codes[0])
	if err != nil {
		return nil
	}
	var k Key
	if len(parts) > 1 {
		k.Mod, k.Release = modsOf(parts[1])
	}
	switch {
	case cp == 27:
		k.Code = KeyEsc
	case cp == 13:
		k.Code = KeyEnter
	case cp == 9:
		k.Code = KeyTab
		if k.Has(ModShift) {
			k.Code = KeyBackTab
		}
	case cp == 127 || cp == 8:
		k.Code = KeyBackspace
	case cp >= 57344:
		code, r, ok := functional(cp)
		if !ok {
			return nil
		}
		k.Code, k.Rune = code, r
	default:
		k.Code, k.Rune = KeyRune, rune(cp)
		// With alternate keys reported, shift's character comes along.
		if k.Has(ModShift) && len(codes) > 1 && codes[1] != "" {
			if s, err := strconv.Atoi(codes[1]); err == nil {
				k.Rune = rune(s)
				k.Mod &^= ModShift
			}
		}
	}
	return k
}

// functional is the kitty protocol's private-use key codes: the keypad as
// the keys it stands for; lone modifier keys and the rest aren't keys to o.
func functional(cp int) (KeyCode, rune, bool) {
	switch {
	case cp >= 57399 && cp <= 57408:
		return KeyRune, rune('0' + cp - 57399), true
	}
	switch cp {
	case 57409:
		return KeyRune, '.', true
	case 57410:
		return KeyRune, '/', true
	case 57411:
		return KeyRune, '*', true
	case 57412:
		return KeyRune, '-', true
	case 57413:
		return KeyRune, '+', true
	case 57414:
		return KeyEnter, 0, true
	case 57415:
		return KeyRune, '=', true
	case 57416:
		return KeyRune, ',', true
	case 57417:
		return KeyLeft, 0, true
	case 57418:
		return KeyRight, 0, true
	case 57419:
		return KeyUp, 0, true
	case 57420:
		return KeyDown, 0, true
	case 57421:
		return KeyPageUp, 0, true
	case 57422:
		return KeyPageDown, 0, true
	case 57423:
		return KeyHome, 0, true
	case 57424:
		return KeyEnd, 0, true
	case 57425:
		return KeyInsert, 0, true
	case 57426:
		return KeyDelete, 0, true
	}
	return 0, 0, false
}

func mouseFrom(cb, x, y int, release bool) Event {
	button := cb&3 | (cb&0xc0)>>4
	drag := cb&0x20 != 0
	m := Mouse{X: max(x, 0), Y: max(y, 0)}
	if cb&4 != 0 {
		m.Mod |= ModShift
	}
	if cb&8 != 0 {
		m.Mod |= ModAlt
	}
	if cb&16 != 0 {
		m.Mod |= ModCtrl
	}
	switch {
	case button <= 2 && !drag:
		m.Kind, m.Button = MouseDown, MouseButton(button)
		// ButtonLeft 0, ButtonMiddle 1, ButtonRight 2: as the protocol numbers them.
	case button <= 2 && drag:
		m.Kind, m.Button = MouseDrag, MouseButton(button)
	case button == 3 && !drag:
		m.Kind, m.Button = MouseUp, ButtonLeft
	case button >= 3 && button <= 5 && drag:
		m.Kind, m.Button = MouseMoved, ButtonNone
	case button == 4:
		m.Kind = ScrollUp
	case button == 5:
		m.Kind = ScrollDown
	case button == 6:
		m.Kind = ScrollLeft
	case button == 7:
		m.Kind = ScrollRight
	default:
		return nil
	}
	if release && (m.Kind == MouseDown || m.Kind == MouseDrag) {
		m.Kind = MouseUp
	}
	return m
}

func ints(s string, sep rune) []int {
	var out []int
	for _, f := range strings.FieldsFunc(s, func(r rune) bool { return r == sep }) {
		f, _, _ = strings.Cut(f, ":")
		n, err := strconv.Atoi(f)
		if err != nil {
			return nil
		}
		out = append(out, n)
	}
	return out
}
