// Package gfx is the drafts list's images (and `o --images`'s), with the
// Kitty graphics protocol's unicode placeholders. A PNG goes to the
// terminal once (a=T,U=1, a virtual placement cols×rows cells big), then
// ordinary cells draw it: U+10EEEE with the cell's row and column in two
// diacritics and the image's id in the foreground color. So the picture is
// text to package term: diffed, moved and cleared like any other cell.
//
// The probe asks whether the terminal draws them (Ghostty, Rex and kitty
// do) in its one round trip at startup. O_IMAGES=0 turns them off.
package gfx

import (
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"

	"o/internal/drafts"
	"o/internal/field"
	"o/internal/tui"
)

// Gfx is the terminal's cell, in pixels.
type Gfx struct{ CellW, CellH int }

// Query is what the probe sends: answered `ESC _ G i=31;OK ESC \` where
// images work.
const Query = "\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\"

// Wanted: O_IMAGES=0 (off, no, false) turns images off.
func Wanted() bool {
	switch os.Getenv("O_IMAGES") {
	case "0", "off", "no", "false":
		return false
	}
	return true
}

// Supported reports whether the replies say the terminal draws Kitty images.
func Supported(reply string) bool { return regexp.MustCompile("\x1b_Gi=31;OK").MatchString(reply) }

var cellReply = regexp.MustCompile(`\x1b\[6;(\d+);(\d+)t`)

// CellFromReply reads `ESC [ 6 ; height ; width t`: a cell's size in pixels.
func CellFromReply(s string) (Gfx, bool) {
	for _, m := range cellReply.FindAllStringSubmatch(s, -1) {
		h, _ := strconv.Atoi(m[1])
		w, _ := strconv.Atoi(m[2])
		if w > 0 && h > 0 {
			return Gfx{w, h}, true
		}
	}
	return Gfx{}, false
}

// CellFromIoctl is the same from the tty's size in pixels, when the
// terminal didn't say.
func CellFromIoctl() (Gfx, bool) {
	cols, rows, w, h, err := tui.Size()
	if err != nil || cols == 0 || rows == 0 || w == 0 || h == 0 {
		return Gfx{}, false
	}
	return Gfx{w / cols, h / rows}, true
}

// ---- PNGs --------------------------------------------------------------------

// Pic is an image readied for the terminal: its size in pixels, and the
// PNG in base64.
type Pic struct {
	W, H int
	B64  string
}

// Max is the biggest side sent to the terminal, and the biggest PNG sent
// as it is.
type Max struct{ Side, Bytes int }

// Thumb: the list draws thumbnails, a few hundred pixels tall (8 rows), so
// a 5K screenshot goes shrunk, not through the pty whole.
var Thumb = Max{640, 400_000}

// Big: `o --images` draws them as big as a floating pane.
var Big = Max{2000, 4_000_000}

// LoadPic is path as a PNG no bigger than Thumb.
func LoadPic(path string) (Pic, error) { return LoadPicAt(path, Thumb) }

// LoadPicAt is path as a PNG whose longer side is m.Side at most. A PNG
// that small (and no more than m.Bytes) goes as it is; sips (macOS) or
// ImageMagick (Linux) turns anything else into one. Slow-ish: call it off
// the UI goroutine.
func LoadPicAt(path string, m Max) (Pic, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return Pic{}, err
	}
	if w, h, ok := PNGSize(b); ok && w <= m.Side && h <= m.Side && len(b) <= m.Bytes {
		return Pic{w, h, base64.StdEncoding.EncodeToString(b)}, nil
	}
	dir := field.TmpDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return Pic{}, err
	}
	out := filepath.Join(dir, fmt.Sprintf("thumb-%d-%s.png", os.Getpid(), drafts.NewID()))
	defer os.Remove(out)
	var c *exec.Cmd
	tool := "sips"
	if runtime.GOOS == "darwin" {
		// -Z scales up as well as down: given only when it's bigger.
		args := []string{"-s", "format", "png"}
		if w, h, ok := PNGFileSize(path); !ok || max(w, h) > m.Side {
			args = append(args, "-Z", strconv.Itoa(m.Side))
		}
		c = exec.Command("sips", append(args, path, "--out", out)...)
	} else {
		// [0]: a GIF's first frame. `>` only shrinks.
		tool = "ImageMagick"
		c = exec.Command("magick", path+"[0]", "-auto-orient", "-resize", fmt.Sprintf("%dx%d>", m.Side, m.Side), "png:"+out)
	}
	if c.Run() != nil {
		return Pic{}, fmt.Errorf("%s couldn't read it", tool)
	}
	png, err := os.ReadFile(out)
	if err != nil {
		return Pic{}, err
	}
	w, h, ok := PNGSize(png)
	if !ok {
		return Pic{}, errors.New("not an image")
	}
	return Pic{w, h, base64.StdEncoding.EncodeToString(png)}, nil
}

// PNGFileSize is a PNG file's width and height, from its header alone.
func PNGFileSize(path string) (int, int, bool) {
	f, err := os.Open(path)
	if err != nil {
		return 0, 0, false
	}
	defer f.Close()
	head := make([]byte, 24)
	if _, err := f.Read(head); err != nil {
		return 0, 0, false
	}
	return PNGSize(head)
}

// PNGSize is a PNG's width and height, from its IHDR chunk.
func PNGSize(b []byte) (int, int, bool) {
	if len(b) < 24 || string(b[:8]) != "\x89PNG\r\n\x1a\n" || string(b[12:16]) != "IHDR" {
		return 0, 0, false
	}
	return int(binary.BigEndian.Uint32(b[16:])), int(binary.BigEndian.Uint32(b[20:])), true
}

// Fit is the cells a w×h pixel image fills: its own size at most, else as
// big as cols×rows cells allow, its shape kept.
func Fit(w, h int, g Gfx, cols, rows int) (int, int) { return FitUpto(w, h, g, cols, rows, 1) }

// FitUpto is Fit, drawn up to up times its own size (a shrunk copy of a
// bigger file, as big as the file is).
func FitUpto(w, h int, g Gfx, cols, rows int, up float64) (int, int) {
	fw, fh := float64(max(w, 1)), float64(max(h, 1))
	cw, ch := float64(max(g.CellW, 1)), float64(max(g.CellH, 1))
	s := math.Min(math.Min(math.Max(up, 1), float64(max(cols, 1))*cw/fw), float64(max(rows, 1))*ch/fh)
	c := clamp(int(math.Round(fw*s/cw)), 1, max(cols, 1))
	r := clamp(int(math.Round(fh*s/ch)), 1, max(rows, 1))
	return min(c, MaxCells), min(r, MaxCells)
}

// ColsAt is the columns a w×h pixel image takes drawn exactly rows cells
// tall, its shape kept: bigger than itself too (the terminal scales it).
func ColsAt(w, h int, g Gfx, rows int) int {
	px := float64(rows) * float64(max(g.CellH, 1)) * float64(max(w, 1)) / float64(max(h, 1))
	return clamp(int(math.Round(px/float64(max(g.CellW, 1)))), 1, MaxCells)
}

func clamp(v, lo, hi int) int { return max(lo, min(v, hi)) }

// ---- writing images ----------------------------------------------------------

// ImageID is an id o hands out: under 2^24, so the id fits the foreground
// color alone, and apart from al's (0xA1xxxx) and ctab's (0xC7Axxx).
func ImageID(n uint32) uint32 { return 0x00B0_0000 + n%0x1000 }

// Transmit sends a PNG (base64) and makes it a cols×rows virtual placement,
// replacing any image with the same id. q=2: the terminal answers nothing
// (an answer would come in as keys).
func Transmit(id uint32, pngB64 string, cols, rows int) []byte {
	data := []byte(pngB64)
	var out []byte
	for i := 0; i < len(data) || i == 0; i += 4096 {
		end := min(i+4096, len(data))
		more := 0
		if end < len(data) {
			more = 1
		}
		if i == 0 {
			out = fmt.Appendf(out, "\x1b_Ga=T,U=1,f=100,t=d,i=%d,c=%d,r=%d,q=2,m=%d;", id, cols, rows, more)
		} else {
			out = fmt.Appendf(out, "\x1b_Gm=%d;", more)
		}
		out = append(out, data[i:end]...)
		out = append(out, "\x1b\\"...)
		if len(data) == 0 {
			break
		}
	}
	return out
}

// Delete frees an image and its placements.
func Delete(id uint32) []byte { return fmt.Appendf(nil, "\x1b_Ga=d,d=I,i=%d,q=2;\x1b\\", id) }

// keepImages is the images kept in the terminal for going back to; older
// ones are freed.
const keepImages = 16

// Key is an image sent: its file and placement size.
type Key struct {
	Path       string
	Cols, Rows int
}

type sentImage struct {
	Key Key
	ID  uint32
}

// Images is the images o has sent the terminal, newest first (one per file
// and size), and the bytes not written yet.
type Images struct {
	Sent []sentImage
	out  []byte
	next uint32
}

// IDFor is the id of key's image, sending the PNG when the terminal hasn't got it.
func (im *Images) IDFor(key Key, png string) uint32 {
	for i, e := range im.Sent {
		if e.Key == key {
			im.Sent = append(im.Sent[:i], im.Sent[i+1:]...)
			im.Sent = append([]sentImage{e}, im.Sent...)
			return e.ID
		}
	}
	im.next++
	id := ImageID(im.next)
	im.out = append(im.out, Transmit(id, png, key.Cols, key.Rows)...)
	im.Sent = append([]sentImage{{key, id}}, im.Sent...)
	for len(im.Sent) > keepImages {
		old := im.Sent[len(im.Sent)-1]
		im.Sent = im.Sent[:len(im.Sent)-1]
		im.out = append(im.out, Delete(old.ID)...)
	}
	return id
}

// Rename: the images sent for file from are now file to's (a draft's
// images copied beside it).
func (im *Images) Rename(from, to string) {
	for i := range im.Sent {
		if im.Sent[i].Key.Path == from {
			im.Sent[i].Key.Path = to
		}
	}
}

// Take is bytes for the terminal (images to send or free), to write before the frame.
func (im *Images) Take() []byte {
	out := im.out
	im.out = nil
	return out
}

// Clear frees every image sent, for quitting.
func (im *Images) Clear() []byte {
	for _, e := range im.Sent {
		im.out = append(im.out, Delete(e.ID)...)
	}
	im.Sent = nil
	return im.Take()
}

// MaxCells is the largest row or column a placeholder can name.
const MaxCells = len(diacritics)

// Placeholder turns cell into the placeholder for (row, col) of image id.
func Placeholder(cell *tui.Cell, id uint32, row, col int) {
	cell.Sym = string([]rune{tui.Placeholder, diacritic(row), diacritic(col)})
	cell.Fg = tui.RGB(uint8(id>>16), uint8(id>>8), uint8(id))
	cell.Bg = tui.Reset
}

func diacritic(n int) rune { return diacritics[clamp(n, 0, len(diacritics)-1)] }
