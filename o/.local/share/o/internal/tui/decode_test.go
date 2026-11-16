package tui

import (
	"reflect"
	"testing"
)

func all(t *testing.T, s string) []Event {
	t.Helper()
	b := []byte(s)
	var out []Event
	for len(b) > 0 {
		ev, n, inc := decode(b)
		if inc {
			t.Fatalf("incomplete at %q", b)
		}
		if ev != nil {
			out = append(out, ev)
		}
		b = b[n:]
	}
	return out
}

func TestDecodesKeysAsCrosstermDoes(t *testing.T) {
	cases := []struct {
		in   string
		want []Event
	}{
		{"aB", []Event{Key{Code: KeyRune, Rune: 'a'}, Key{Code: KeyRune, Rune: 'B', Mod: ModShift}}},
		{"\r\n\t\x7f\x08", []Event{Key{Code: KeyEnter}, Key{Code: KeyRune, Rune: 'j', Mod: ModCtrl}, Key{Code: KeyTab}, Key{Code: KeyBackspace}, Key{Code: KeyRune, Rune: 'h', Mod: ModCtrl}}},
		{"\x1b[A\x1b[1;2B\x1b[1;3D\x1bOH", []Event{Key{Code: KeyUp}, Key{Code: KeyDown, Mod: ModShift}, Key{Code: KeyLeft, Mod: ModAlt}, Key{Code: KeyHome}}},
		{"\x1bb\x1b\x7f", []Event{Key{Code: KeyRune, Rune: 'b', Mod: ModAlt}, Key{Code: KeyBackspace, Mod: ModAlt}}},
		{"\x1b[Z\x1b[3~\x1b[5;5~", []Event{Key{Code: KeyBackTab, Mod: ModShift}, Key{Code: KeyDelete}, Key{Code: KeyPageUp, Mod: ModCtrl}}},
		// The kitty protocol: ⇧⏎, ^⏎, ^1, ⇧tab, esc, ⌥⌫, ⌘↑ as a modified arrow.
		{"\x1b[13;2u\x1b[13;5u\x1b[49;5u\x1b[9;2u\x1b[27u\x1b[127;3u\x1b[1;9A", []Event{
			Key{Code: KeyEnter, Mod: ModShift}, Key{Code: KeyEnter, Mod: ModCtrl}, Key{Code: KeyRune, Rune: '1', Mod: ModCtrl},
			Key{Code: KeyBackTab, Mod: ModShift}, Key{Code: KeyEsc}, Key{Code: KeyBackspace, Mod: ModAlt}, Key{Code: KeyUp, Mod: ModSuper}}},
		{"\x1b[200~a\r\nb\x1b[201~x", []Event{Paste("a\r\nb"), Key{Code: KeyRune, Rune: 'x'}}},
		{"\x1b[<0;10;3M\x1b[<32;11;3M\x1b[<0;11;3m\x1b[<64;1;1M\x1b[<4;2;2M", []Event{
			Mouse{Kind: MouseDown, Button: ButtonLeft, X: 9, Y: 2}, Mouse{Kind: MouseDrag, Button: ButtonLeft, X: 10, Y: 2},
			Mouse{Kind: MouseUp, Button: ButtonLeft, X: 10, Y: 2}, Mouse{Kind: ScrollUp, X: 0, Y: 0}, Mouse{Kind: MouseDown, Button: ButtonLeft, X: 1, Y: 1, Mod: ModShift}}},
		// Replies are nothing to o; the cursor's place is its own event.
		{"\x1b[?1u\x1b[?62;22c\x1b[12;5R\x1b_Gi=31;OK\x1b\\é", []Event{CursorPos{X: 4, Y: 11}, Key{Code: KeyRune, Rune: 'é'}}},
	}
	for _, c := range cases {
		if got := all(t, c.in); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%q:\n got %#v\nwant %#v", c.in, got, c.want)
		}
	}
}

func TestWaitsForTheRestOfASequence(t *testing.T) {
	for _, s := range []string{"\x1b", "\x1b[", "\x1b[1;2", "\x1b[200~abc", "\xc3"} {
		if _, _, inc := decode([]byte(s)); !inc {
			t.Errorf("%q should be incomplete", s)
		}
	}
}

func TestSetStringLikeRatatui(t *testing.T) {
	b := NewBuffer(Rect{0, 0, 6, 1})
	x := b.SetStringN(0, 0, "a界\tbcdef", 5, FgStyle(Red))
	if x != 5 {
		t.Fatalf("x = %d", x)
	}
	var syms []string
	for i := 0; i < 6; i++ {
		syms = append(syms, b.At(i, 0).Sym)
	}
	if want := []string{"a", "界", " ", "b", "c", " "}; !reflect.DeepEqual(syms, want) {
		t.Fatalf("%q", syms)
	}
	if b.At(0, 0).Fg != Red || b.At(5, 0).Fg != Reset {
		t.Fatal("style")
	}
}
