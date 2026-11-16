package probe

import "testing"

func TestReadsTheReplies(t *testing.T) {
	r := "\x1b[?1u\x1b[12;1R\x1b[?62;22c"
	if b, ok := csiReply(r, "\x1b[?", 'u'); !ok || b != "1" {
		t.Fatal(b)
	}
	if b, ok := csiReply(r, "\x1b[?", 'c'); !ok || b != "62;22" {
		t.Fatal(b)
	}
	if x, y, ok := cursorFromReply(r); !ok || x != 0 || y != 11 {
		t.Fatal(x, y)
	}
	r = "\x1b[3;5R\x1b[?62;22c"
	if _, ok := csiReply(r, "\x1b[?", 'u'); ok {
		t.Fatal("kitty")
	}
	if x, y, _ := cursorFromReply(r); x != 4 || y != 2 {
		t.Fatal(x, y)
	}
	if _, ok := csiReply("\x1b[?62;2", "\x1b[?", 'c'); ok {
		t.Fatal("cut short")
	}
	if e := replyEnd("\x1b[?1u\x1b[?62;22cabc"); e != 14 {
		t.Fatal(e)
	}
}
