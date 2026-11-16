package tui

import "strings"

// Mod is the modifier keys held with a key or a click.
type Mod uint8

const (
	ModShift Mod = 1 << iota
	ModAlt
	ModCtrl
	ModSuper
	ModHyper
	ModMeta
)

// KeyCode is which key: KeyRune for a character (Key.Rune), else a named one.
type KeyCode uint8

const (
	KeyRune KeyCode = iota
	KeyEnter
	KeyEsc
	KeyTab
	KeyBackTab
	KeyBackspace
	KeyDelete
	KeyInsert
	KeyUp
	KeyDown
	KeyLeft
	KeyRight
	KeyHome
	KeyEnd
	KeyPageUp
	KeyPageDown
	KeyF
	KeyOther
)

// Key is a key pressed (or, with the kitty protocol's event types, repeated
// or released).
type Key struct {
	Code    KeyCode
	Rune    rune // KeyRune
	F       int  // KeyF: its number
	Mod     Mod
	Release bool
}

// Ch is a character key, as typed: an uppercase letter comes with shift, as
// crossterm reports it.
func Ch(r rune) Key {
	k := Key{Code: KeyRune, Rune: r}
	if strings.ToLower(string(r)) != string(r) {
		k.Mod = ModShift
	}
	return k
}

func (k Key) Has(m Mod) bool { return k.Mod&m != 0 }

// Is reports a character key r, whatever the modifiers.
func (k Key) Is(r rune) bool { return k.Code == KeyRune && k.Rune == r }

// MouseKind is what the mouse did.
type MouseKind uint8

const (
	MouseDown MouseKind = iota
	MouseUp
	MouseDrag
	MouseMoved
	ScrollUp
	ScrollDown
	ScrollLeft
	ScrollRight
)

type MouseButton uint8

const (
	ButtonLeft MouseButton = iota
	ButtonMiddle
	ButtonRight
	ButtonNone
)

// Mouse is a mouse event at cell (X, Y), 0-based.
type Mouse struct {
	Kind   MouseKind
	Button MouseButton
	X, Y   int
	Mod    Mod
}

// Paste is a bracketed paste, whole.
type Paste string

// Resize is the terminal's new size.
type Resize struct{ W, H int }

// CursorPos answers a cursor position request (ESC [ 6 n), 0-based.
type CursorPos struct{ X, Y int }

// Event is a Key, Mouse, Paste, Resize or CursorPos.
type Event any
