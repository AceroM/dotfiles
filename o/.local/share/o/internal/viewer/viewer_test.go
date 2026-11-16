package viewer

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"o/internal/drafts"
	"o/internal/gfx"
	"o/internal/term"
	"o/internal/theme"
	"o/internal/tui"
)

var g = gfx.Gfx{CellW: 10, CellH: 20}

func TestOneImageAsBigAsItIsCentered(t *testing.T) {
	for _, c := range []struct {
		in   []size
		w, h int
		want []place
	}{
		{[]size{{1, 1000, 500, 1}}, 120, 40, []place{{10, 7, 100, 25}}},
		{[]size{{1, 500, 250, 2}}, 120, 40, []place{{10, 7, 100, 25}}},
		{[]size{{1, 1000, 500, 1}}, 50, 40, []place{{0, 13, 50, 13}}},
		{[]size{{1, 1000, 500, 1}, {2, 1000, 500, 1}}, 100, 40, []place{{14, 0, 72, 18}, {14, 20, 72, 18}}},
		{[]size{{1, 300, 800, 1}, {2, 300, 800, 1}}, 100, 40, []place{{20, 0, 29, 39}, {51, 0, 29, 39}}},
	} {
		if got := grid(c.in, g, c.w, c.h); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%v: %v", c.in, got)
		}
	}
	out := grid([]size{{1, 20, 400, 1}, {2, 20, 400, 1}}, g, 100, 40)
	if len(out) != 2 || out[1].x < out[0].x+12 {
		t.Fatal(out)
	}
}

func viewer(images ...[4]any) *Viewer {
	v := New(theme.NewPalette(theme.OneDark(theme.RGB{R: 0x28, G: 0x2c, B: 0x34})), "/nonexistent/o-viewer-test.json")
	v.live = false
	v.Gfx = &g
	for _, im := range images {
		n, p, w, h := im[0].(int), im[1].(string), im[2].(int), im[3].(int)
		v.Images = append(v.Images, drafts.Tagged{N: n, Path: p})
		v.pics[p] = &ready{pic: gfx.Pic{W: w, H: h, B64: "AAAA"}, up: 1}
	}
	return v
}

func rows(b *tui.Buffer) []string {
	var out []string
	for y := 0; y < b.Area.H; y++ {
		out = append(out, term.Plain(b, y))
	}
	return out
}

func TestDrawsThemWithTheirTagsAndOneAloneWithDigits(t *testing.T) {
	v := viewer([4]any{1, "/a.png", 400, 200}, [4]any{3, "/c.png", 400, 200})
	r := rows(v.Draw(60, 20))
	pad := strings.Repeat(" ", 16)
	want := map[int]string{0: " 2 images in o's prompt", 19: " 1–9 one alone · ← → · esc closes",
		1: pad + strings.Repeat("▒", 28), 8: pad + "[Image #1]", 10: pad + strings.Repeat("▒", 28), 17: pad + "[Image #3]"}
	for y, w := range want {
		if r[y] != w {
			t.Errorf("row %d: %q", y, r[y])
		}
	}
	if n := strings.Count(string(v.imgs.Take()), "a=T,"); n != 2 {
		t.Fatal(n)
	}
	three := tui.Key{Code: tui.KeyRune, Rune: '3'}
	if keep, changed := v.key(three); !keep || !changed || v.One != 1 {
		t.Fatal(v.One)
	}
	r = rows(v.Draw(60, 20))
	if r[4] != strings.Repeat(" ", 10)+strings.Repeat("▒", 40) || r[14] != strings.Repeat(" ", 10)+"[Image #3]  /c.png" || r[19] != " 2 of 2 · ← → · 0 all · esc closes" {
		t.Fatalf("%q\n%q\n%q", r[4], r[14], r[19])
	}
	v.key(three)
	if v.One != -1 {
		t.Fatal(v.One)
	}
	v.key(tui.Key{Code: tui.KeyRune, Rune: '2'})
	v.key(tui.Key{Code: tui.KeyLeft})
	if v.One != 1 {
		t.Fatal(v.One)
	}
	v.key(tui.Key{Code: tui.KeyRight})
	if v.One != 0 {
		t.Fatal(v.One)
	}
	for _, k := range []tui.Key{{Code: tui.KeyEsc}, {Code: tui.KeyRune, Rune: 'q'}, {Code: tui.KeyEnter}} {
		if keep, _ := v.key(k); keep {
			t.Fatal(k)
		}
	}
}

func TestSaysWhatItCantDraw(t *testing.T) {
	v := viewer([4]any{1, "/a.png", 400, 200})
	v.pics["/b.png"] = &ready{err: fmt.Errorf("nope")}
	v.Images = append(v.Images, drafts.Tagged{N: 2, Path: "/b.png"})
	r := rows(v.Draw(60, 20))
	if r[0] != " 2 images in o's prompt"+strings.Repeat(" ", 20)+"✗ can't read #2" {
		t.Fatalf("%q", r[0])
	}
	v.Gfx = nil
	r = rows(v.Draw(60, 20))
	if r[2] != " [Image #1]  /a.png" || r[3] != " [Image #2]  /b.png" {
		t.Fatalf("%q %q", r[2], r[3])
	}
	if got := strings.TrimSpace(rows(viewer().Draw(60, 20))[10]); got != "no images" {
		t.Fatal(got)
	}
}

func TestFollowsThePanesFile(t *testing.T) {
	file := filepath.Join(t.TempDir(), "b.json")
	write := func(body string, secs int64) {
		os.WriteFile(file, []byte(body), 0o644)
		os.Chtimes(file, time.Unix(secs, 0), time.Unix(secs, 0))
	}
	write(`{"kind":"prompt","images":[{"n":1,"path":"/a.png"},{"n":2,"path":"/b.png"}]}`, 1000)
	v := New(theme.NewPalette(theme.OneDark(theme.RGB{})), file)
	if len(v.Images) != 2 {
		t.Fatal(v.Images)
	}
	v.One = 1
	write(`{"kind":"prompt","images":[{"n":2,"path":"/b.png"}]}`, 2000)
	if !v.reread() || len(v.Images) != 1 || v.One != 0 {
		t.Fatal(v.Images, v.One)
	}
	os.Remove(file)
	if v.reread() || len(v.Images) != 1 {
		t.Fatal("gone")
	}
}
