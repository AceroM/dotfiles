package gfx

import (
	"strings"
	"testing"

	"o/internal/tui"
)

func TestReadsTheReplies(t *testing.T) {
	r := "\x1b_Gi=31;OK\x1b\\\x1b[6;37;17t\x1b[?62;22c"
	if g, ok := CellFromReply(r); !Supported(r) || !ok || g != (Gfx{17, 37}) {
		t.Fatal(g)
	}
	if Supported("\x1b[?62;22c") {
		t.Fatal("supported")
	}
	r = "\x1b[?1u\x1b[6;1R\x1b_Gi=31;OK\x1b\\\x1b[6;16;8t\x1b[4;384;640t\x1b[?62;22c"
	if g, ok := CellFromReply(r); !ok || g != (Gfx{8, 16}) {
		t.Fatal(g)
	}
	if _, ok := CellFromReply("\x1b[6;1R\x1b[?62;22c"); ok {
		t.Fatal("cell")
	}
}

func TestFitsImagesKeepingTheirShape(t *testing.T) {
	g := Gfx{10, 20}
	check := func(c, r, wc, wr int) {
		t.Helper()
		if c != wc || r != wr {
			t.Errorf("got %d×%d want %d×%d", c, r, wc, wr)
		}
	}
	c, r := Fit(100, 100, g, 80, 30)
	check(c, r, 10, 5)
	c, r = Fit(1600, 400, g, 80, 30)
	check(c, r, 80, 10)
	c, r = Fit(400, 1600, g, 80, 30)
	check(c, r, 15, 30)
	c, r = Fit(1, 1, g, 80, 0)
	check(c, r, 1, 1)
	c, r = FitUpto(100, 100, g, 80, 30, 2)
	check(c, r, 20, 10)
	c, r = FitUpto(100, 100, g, 15, 30, 2)
	check(c, r, 15, 8)
	c, r = FitUpto(100, 100, g, 80, 30, 0.5)
	check(c, r, 10, 5)
	if ColsAt(100, 100, g, 8) != 16 || ColsAt(1600, 400, g, 2) != 16 {
		t.Fatal(ColsAt(100, 100, g, 8))
	}
}

func TestChunksThePNG(t *testing.T) {
	s := string(Transmit(ImageID(1), strings.Repeat("A", 9000), 40, 12))
	if !strings.HasPrefix(s, "\x1b_Ga=T,U=1,f=100,t=d,i=11534337,c=40,r=12,q=2,m=1;") || strings.Count(s, "\x1b_G") != 3 || strings.Count(s, "A") != 9000 {
		t.Fatal(s[:80])
	}
}

func TestAPlaceholderIsOneCellNamingItsPlaceAndImage(t *testing.T) {
	var c tui.Cell
	Placeholder(&c, ImageID(1), 2, 5)
	if rs := []rune(c.Sym); len(rs) != 3 || rs[0] != 0x10EEEE || rs[1] != 0x30E || rs[2] != 0x33D {
		t.Fatalf("%U", []rune(c.Sym))
	}
	if c.Fg != tui.RGB(0xB0, 0, 1) || tui.Width(c.Sym) != 1 {
		t.Fatal(c.Fg)
	}
}
