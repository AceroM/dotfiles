// Package field is the prompt's text: a multi-line field with a cursor and
// a selection (al's agent box, the same keys), its `[Image #N]` tags, and
// the images behind them: pasted (^v, or ⌘V with only an image on the
// clipboard) or dropped in from Finder or a file manager.
//
// Like Claude Code, the prompt keeps the tags, and what's sent lists each
// one's file at the end, so the agent opens them with its own file tools.
// A long paste is a `[Pasted text #N +M lines]` tag the same way (Collapse
// says when), its text in a file, put back in its place as it's sent.
package field

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/rivo/uniseg"

	"o/internal/tui"
)

// TmpDir is where pasted images go: $TMPDIR/o.
func TmpDir() string { return filepath.Join(os.TempDir(), "o") }

// Stamp is milliseconds since the epoch, for file names.
func Stamp() int64 { return time.Now().UnixMilli() }

// Which reports whether bin is on $PATH.
func Which(bin string) bool {
	for _, d := range filepath.SplitList(os.Getenv("PATH")) {
		if fi, err := os.Stat(filepath.Join(d, bin)); err == nil && !fi.IsDir() {
			return true
		}
	}
	return false
}

// FirstLine is a prompt's first line with words in it, its spaces
// squeezed: what the sent list shows.
func FirstLine(text string) string {
	for _, l := range lines(text) {
		if s := strings.Join(strings.Fields(l), " "); s != "" {
			return s
		}
	}
	return ""
}

// lines splits as Rust's str::lines: on \n, a \r before it dropped, no
// empty last line for a trailing \n.
func lines(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, "\n")
	if parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	for i, p := range parts {
		parts[i] = strings.TrimSuffix(p, "\r")
	}
	return parts
}

// Range is a span of bytes, [Start, End).
type Range struct{ Start, End int }

func (r Range) Contains(i int) bool { return r.Start <= i && i < r.End }

// StrWidth is the columns s takes, a character at a time (unicode-width's
// str::width).
func StrWidth(s string) int {
	w := 0
	for _, r := range s {
		w += tui.RuneWidth(r)
	}
	return w
}

// WordRows is text's rows as the box shows them: each line wrapped at its
// spaces to w columns, a word longer than a row cut, as byte ranges. A row
// wrapped mid-line ends where the next one starts; a line's last row ends
// at its \n (or the text's end), one byte short of the next.
func WordRows(text string, w int) []Range {
	var out []Range
	start := 0
	for _, line := range strings.Split(text, "\n") {
		for _, r := range wordWrap(line, w) {
			out = append(out, Range{start + r.Start, start + r.End})
		}
		start += len(line) + 1
	}
	return out
}

func wordWrap(text string, w int) []Range {
	var out []Range
	start, col := 0, 0
	// Where this row may break: just past its last space.
	brk := -1
	for i, c := range text {
		cw := tui.RuneWidth(c)
		if col+cw > w && col > 0 {
			if brk > start {
				out = append(out, Range{start, brk})
				start = brk
				col = StrWidth(text[brk:i])
			} else {
				out = append(out, Range{start, i})
				start = i
				col = 0
			}
			brk = -1
		}
		col += cw
		if c == ' ' {
			brk = i + 1
		}
	}
	return append(out, Range{start, len(text)})
}

// ---- images ------------------------------------------------------------------

var imageExt = []string{"png", "jpg", "jpeg", "gif", "webp"}

// ImagePaths is a paste that's nothing but image files (a drag from Finder
// pastes their shell-escaped paths): those files. Nil otherwise.
func ImagePaths(s string) []string {
	words := shellWords(strings.TrimSpace(s))
	if len(words) == 0 {
		return nil
	}
	var out []string
	for _, w := range words {
		p := strings.TrimPrefix(w, "file://")
		ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(p), "."))
		ok := false
		for _, e := range imageExt {
			ok = ok || ext == e
		}
		if fi, err := os.Stat(p); !ok || err != nil || fi.IsDir() {
			return nil
		}
		out = append(out, p)
	}
	return out
}

// shellWords splits on unescaped whitespace, honoring \ escapes and quotes.
func shellWords(s string) []string {
	var out []string
	var cur strings.Builder
	var quote rune
	rs := []rune(s)
	for i := 0; i < len(rs); i++ {
		c := rs[i]
		switch {
		case c == '\\' && quote != '\'':
			if i+1 < len(rs) {
				i++
				cur.WriteRune(rs[i])
			}
		case (c == '\'' || c == '"') && quote == 0:
			quote = c
		case quote != 0 && c == quote:
			quote = 0
		case quote == 0 && unicode.IsSpace(c):
			if cur.Len() > 0 {
				out = append(out, cur.String())
				cur.Reset()
			}
		default:
			cur.WriteRune(c)
		}
	}
	if cur.Len() > 0 {
		out = append(out, cur.String())
	}
	return out
}

// Tag is an attachment's tag in a text: its bytes and N. `[Image #N]`, or
// (Paste) `[Pasted text #N +M lines]` for text pasted in whole, as Claude
// Code has it: M (Lines) is its line breaks, and with none it's
// `[Pasted text #N]`. Both kinds count from one list, the Nth file.
type Tag struct {
	R     Range
	N     int
	Paste bool
	Lines int
}

const (
	imageOpen = "[Image #"
	pasteOpen = "[Pasted text #"
)

// Tags is the tags in text, images' and pasted texts', in order.
func Tags(text string) []Tag {
	var out []Tag
	i := 0
	for {
		p := strings.IndexByte(text[i:], '[')
		if p < 0 {
			return out
		}
		s := i + p
		if t, ok := tagAt(text, s); ok {
			out = append(out, t)
			i = t.R.End
		} else {
			i = s + 1
		}
	}
}

// tagAt is the tag starting at byte s of text, if one does.
func tagAt(text string, s int) (Tag, bool) {
	rest, paste := text[s:], false
	switch {
	case strings.HasPrefix(rest, imageOpen):
		rest = rest[len(imageOpen):]
	case strings.HasPrefix(rest, pasteOpen):
		rest, paste = rest[len(pasteOpen):], true
	default:
		return Tag{}, false
	}
	n, d := number(rest)
	if d == 0 {
		return Tag{}, false
	}
	rest = rest[d:]
	lines := 0
	if paste && strings.HasPrefix(rest, " +") {
		if m, md := number(rest[2:]); md > 0 && strings.HasPrefix(rest[2+md:], " lines") {
			lines, rest = m, rest[2+md+len(" lines"):]
		}
	}
	if !strings.HasPrefix(rest, "]") {
		return Tag{}, false
	}
	return Tag{Range{s, len(text) - len(rest) + 1}, n, paste, lines}, true
}

// number is the digits s starts with, read (0 if too big), and how many.
func number(s string) (int, int) {
	d := 0
	for d < len(s) && s[d] >= '0' && s[d] <= '9' {
		d++
	}
	n, err := strconv.Atoi(s[:d])
	if err != nil {
		n = 0
	}
	return n, d
}

// ImageTags is the `[Image #N]` tags in text.
func ImageTags(text string) []Tag {
	var out []Tag
	for _, t := range Tags(text) {
		if !t.Paste {
			out = append(out, t)
		}
	}
	return out
}

// PasteTag is the tag for pasted text n of lines line breaks, Claude Code's:
// `[Pasted text #3 +187 lines]`, `[Pasted text #3]` for one line.
func PasteTag(n, lines int) string {
	if lines == 0 {
		return fmt.Sprintf("[Pasted text #%d]", n)
	}
	return fmt.Sprintf("[Pasted text #%d +%d lines]", n, lines)
}

// PasteLines is the line breaks in s, as a paste's tag counts them.
func PasteLines(s string) int { return strings.Count(s, "\n") }

// Collapse reports whether a paste of s goes in as a tag rather than as
// itself: Claude Code's rule, more than 800 characters or more line breaks
// than min(screen rows - 10, 2).
func Collapse(s string, screenRows int) bool {
	return utf8.RuneCountInString(s) > 800 || PasteLines(s) > max(0, min(screenRows-10, 2))
}

// Expand is text with each `[Pasted text #N …]` tag put back as the text
// pasted (the Nth of files holds it). A tag whose file can't be read stays
// as it is, and the error says which.
func Expand(text string, files []string) (string, error) {
	var out strings.Builder
	var lost error
	at := 0
	for _, t := range Tags(text) {
		if !t.Paste {
			continue
		}
		var body []byte
		err := fmt.Errorf("no file")
		if t.N >= 1 && t.N <= len(files) && files[t.N-1] != "" {
			body, err = os.ReadFile(files[t.N-1])
		}
		if err != nil {
			if lost == nil {
				lost = fmt.Errorf("pasted text #%d is gone", t.N)
			}
			continue
		}
		out.WriteString(text[at:t.R.Start])
		out.Write(body)
		at = t.R.End
	}
	if at == 0 {
		return text, lost
	}
	out.WriteString(text[at:])
	return out.String(), lost
}

// Prompt is text as it goes to an agent: its pasted texts put back in
// place, then the file behind each `[Image #N]` it has (WithImages). An
// error when a pasted text is gone, so it isn't sent without it.
func Prompt(text string, files []string) (string, error) {
	body, err := Expand(text, files)
	if err != nil {
		return "", err
	}
	// The images text tags, not ones a pasted text happens to name.
	listed := WithImages(text, files)
	return body + listed[len(text):], nil
}

// TagNums is the numbers text's image tags have, sorted, each once.
func TagNums(text string) []int {
	var nums []int
	for _, t := range ImageTags(text) {
		nums = append(nums, t.N)
	}
	sort.Ints(nums)
	out := nums[:0]
	for i, n := range nums {
		if i == 0 || n != nums[i-1] {
			out = append(out, n)
		}
	}
	return out
}

// WithImages is the prompt as sent: the text, then the file behind each
// tag it still has.
func WithImages(text string, images []string) string {
	var files []string
	for _, n := range TagNums(text) {
		if n >= 1 && n <= len(images) && images[n-1] != "" {
			files = append(files, fmt.Sprintf("[Image #%d]: %s", n, images[n-1]))
		}
	}
	if len(files) == 0 {
		return text
	}
	return text + "\n\n" + strings.Join(files, "\n")
}

// Plain is the text alone, as ⌥c copies it: no `[Image #N]` tags, each
// line's spaces run together and its end trimmed (its indent kept),
// punctuation back against the word a tag stood after (`see [Image #1] .`
// reads `see.`), a line that held only tags gone, and blank lines one at
// most, none at either end.
func Plain(text string) string {
	var out []string
	for _, line := range lines(text) {
		tags := ImageTags(line)
		var s strings.Builder
		last, afterTag := 0, false
		ends := make([]Range, 0, len(tags)+1)
		for _, t := range tags {
			ends = append(ends, t.R)
		}
		ends = append(ends, Range{len(line), len(line)})
		for _, r := range ends {
			for _, w := range strings.Fields(line[last:r.Start]) {
				stick := afterTag && strings.ContainsAny(w[:1], ",.;:!?)")
				if s.Len() > 0 && !stick {
					s.WriteByte(' ')
				}
				s.WriteString(w)
				afterTag = false
			}
			afterTag = true
			last = r.End
		}
		if s.Len() == 0 {
			if len(tags) == 0 && len(out) > 0 && out[len(out)-1] != "" {
				out = append(out, "")
			}
			continue
		}
		indent := line[:len(line)-len(strings.TrimLeftFunc(line, unicode.IsSpace))]
		out = append(out, indent+s.String())
	}
	for len(out) > 0 && out[len(out)-1] == "" {
		out = out[:len(out)-1]
	}
	return strings.Join(out, "\n")
}

func isWord(c rune) bool { return unicode.IsLetter(c) || unicode.IsNumber(c) || c == '_' }

// ---- the field ---------------------------------------------------------------

// Field is a text field with a cursor (a byte offset into Text): the
// prompt box. It edits as a multi-line text box does: ^a ^e (⌘← ⌘→) and
// Home End go to the ends of the cursor's line, ^u ^k delete to them, ⌘↑ ⌘↓
// (and fn↑ fn↓, PgUp PgDn) go to the ends of the whole text, and shift with
// a move (⌥⇧ for a word, ⌥⇧↑↓ for the line) marks a selection that typing,
// a paste or ⌫ replaces.
type Field struct {
	Text string
	Cur  int
	// Anchor is where a selection started (-1: none): it runs from here to Cur.
	Anchor int
}

// New is a field holding text, the cursor at its start.
func New(text string) Field { return Field{Text: text, Anchor: -1} }

// Key handles the editing keys every input shares, readline's and macOS's.
// True when the text changed; a move only moves the cursor.
func (f *Field) Key(k tui.Key) bool {
	ctrl, alt, shift, sup := k.Has(tui.ModCtrl), k.Has(tui.ModAlt), k.Has(tui.ModShift), k.Has(tui.ModSuper)
	before := f.Text
	ch := func(rs ...rune) bool {
		if k.Code != tui.KeyRune {
			return false
		}
		for _, r := range rs {
			if k.Rune == r {
				return true
			}
		}
		return false
	}
	switch c := k.Code; {
	// Word jumps: alt/ctrl+←→ arrive as modified arrows, or as ESC b / ESC f
	// (⌥← ⌥→ in some terminals). With shift they select.
	case c == tui.KeyLeft && (alt || ctrl):
		f.go_(f.wordLeftPos(), shift)
	case c == tui.KeyRight && (alt || ctrl):
		f.go_(f.wordEnd(), shift)
	case ch('b', 'B') && alt:
		f.go_(f.wordLeftPos(), shift)
	case ch('f', 'F') && alt:
		f.go_(f.wordEnd(), shift)
	// ⌘←→ (when the terminal sends them as such) and Home / End: the line's ends.
	case c == tui.KeyLeft && sup:
		f.go_(f.lineStart(f.Cur), shift)
	case c == tui.KeyRight && sup:
		f.go_(f.lineEnd(f.Cur), shift)
	case c == tui.KeyHome && (ctrl || sup):
		f.go_(0, shift)
	case c == tui.KeyEnd && (ctrl || sup):
		f.go_(len(f.Text), shift)
	case c == tui.KeyHome:
		f.go_(f.lineStart(f.Cur), shift)
	case c == tui.KeyEnd:
		f.go_(f.lineEnd(f.Cur), shift)
	// ⌘↑ ⌘↓, as on macOS: the very start (end) of the text; ⇧⌘ selects to it.
	case c == tui.KeyUp && sup:
		f.go_(0, shift)
	case c == tui.KeyDown && sup:
		f.go_(len(f.Text), shift)
	// fn↑ fn↓ (PgUp PgDn) too.
	case c == tui.KeyPageUp:
		f.go_(0, shift)
	case c == tui.KeyPageDown:
		f.go_(len(f.Text), shift)
	// ⌥↑ ⌥↓, as on macOS: to the start (end) of the line, then the one before (after).
	case c == tui.KeyUp && alt:
		f.go_(f.paragraph(-1), shift)
	case c == tui.KeyDown && alt:
		f.go_(f.paragraph(1), shift)
	case ch('d', 'D') && alt:
		f.KillWordRight()
	case ch('a', 'A') && ctrl:
		f.go_(f.lineStart(f.Cur), shift)
	case ch('e', 'E') && ctrl:
		f.go_(f.lineEnd(f.Cur), shift)
	case ch('b') && ctrl:
		f.go_(f.left(), false)
	case ch('f') && ctrl:
		f.go_(f.right(), false)
	case ch('d') && ctrl:
		f.Delete()
	case ch('u') && ctrl:
		f.KillStart()
	case ch('k') && ctrl:
		f.KillEnd()
	case ch('w') && ctrl:
		f.KillWord()
	// ^h is ⌫ (some terminals send it for ⌫); ^t swaps the characters around
	// the cursor, as readline's does.
	case ch('h') && ctrl:
		f.Backspace()
	case ch('t') && ctrl:
		f.Transpose()
	case c == tui.KeyBackspace && alt:
		f.KillWord()
	// ← → with a selection and no shift: to its edge, as a text box does.
	case c == tui.KeyLeft && !shift && f.hasSelection():
		f.go_(f.Selection().Start, false)
	case c == tui.KeyRight && !shift && f.hasSelection():
		f.go_(f.Selection().End, false)
	case c == tui.KeyLeft:
		f.go_(f.left(), shift)
	case c == tui.KeyRight:
		f.go_(f.right(), shift)
	case c == tui.KeyBackspace:
		f.Backspace()
	case c == tui.KeyDelete:
		f.Delete()
	case c == tui.KeyRune && !ctrl:
		f.Insert(string(k.Rune))
	}
	return f.Text != before
}

func (f *Field) hasSelection() bool { _, ok := f.sel(); return ok }

func (f *Field) sel() (Range, bool) {
	if f.Anchor < 0 {
		return Range{}, false
	}
	a := min(f.Anchor, len(f.Text))
	if a == f.Cur {
		return Range{}, false
	}
	return Range{min(a, f.Cur), max(a, f.Cur)}, true
}

// Selection is the selected bytes (empty when there's none: HasSelection).
func (f *Field) Selection() Range { r, _ := f.sel(); return r }

// HasSelection reports a selection.
func (f *Field) HasSelection() bool { return f.hasSelection() }

// Selected is the selected text, and whether there is any.
func (f *Field) Selected() (string, bool) {
	r, ok := f.sel()
	if !ok {
		return "", false
	}
	return f.Text[r.Start:r.End], true
}

// DeleteSelection takes the selection out of the text. False when there
// was none.
func (f *Field) DeleteSelection() bool {
	r, ok := f.sel()
	f.Anchor = -1
	if !ok {
		return false
	}
	f.Text = f.Text[:r.Start] + f.Text[r.End:]
	f.Cur = r.Start
	return true
}

// go_ moves the cursor to to; extend (shift) carries the selection along,
// starting one where the cursor was, and without it the selection goes.
func (f *Field) go_(to int, extend bool) {
	if extend {
		if f.Anchor < 0 {
			f.Anchor = f.Cur
		}
	} else {
		f.Anchor = -1
	}
	f.Cur = to
}

func (f *Field) lineStart(i int) int { return strings.LastIndexByte(f.Text[:i], '\n') + 1 }

func (f *Field) lineEnd(i int) int {
	if p := strings.IndexByte(f.Text[i:], '\n'); p >= 0 {
		return i + p
	}
	return len(f.Text)
}

// paragraph is ⌥↑ / ⌥↓: the line's start (end), or the previous line's start
// (the next one's end) when the cursor is already there.
func (f *Field) paragraph(dir int) int {
	if dir < 0 {
		s := f.lineStart(f.Cur)
		if s < f.Cur || s == 0 {
			return s
		}
		return f.lineStart(s - 1)
	}
	e := f.lineEnd(f.Cur)
	if e > f.Cur || e == len(f.Text) {
		return e
	}
	return f.lineEnd(e + 1)
}

// VerticalBy is ↑ / ↓ in the wrapped, multi-line box: the same column on
// the screen row dir away (rows as the box draws them); up from the first
// row goes to the start, down from the last to the end. With extend (⇧↑ ⇧↓)
// the selection comes along.
func (f *Field) VerticalBy(rows []Range, dir int, extend bool) {
	f.go_(f.rowTarget(rows, dir), extend)
}

func (f *Field) rowTarget(rows []Range, dir int) int {
	cr := -1
	for i, r := range rows {
		if r.Start <= f.Cur {
			cr = i
		}
	}
	if cr < 0 {
		return f.Cur
	}
	col := StrWidth(f.Text[rows[cr].Start:f.Cur])
	to := cr + dir
	switch {
	case to >= 0 && to < len(rows):
		return f.PosAt(rows, to, col)
	case dir < 0:
		return 0
	}
	return len(f.Text)
}

// PosAt is the place at screen column col of row row (rows as drawn): on
// the character in that cell, the row's end past its text, the text's end
// below its last row. A click, and ↑↓ keeping their column.
func (f *Field) PosAt(rows []Range, row, col int) int {
	if row < 0 || row >= len(rows) {
		return len(f.Text)
	}
	r := rows[row]
	// A row wrapped mid-line ends where the next one starts, and a cursor
	// there draws on the next row: stop a character short of it.
	wrapped := row+1 < len(rows) && rows[row+1].Start == r.End
	at, w := r.Start, 0
	for i, c := range f.Text[r.Start:r.End] {
		end := r.Start + i + utf8.RuneLen(c)
		w += tui.RuneWidth(c)
		if w > col || (wrapped && end == r.End) {
			break
		}
		at = end
	}
	// Never inside a tag.
	for _, t := range Tags(f.Text) {
		if t.R.Start < at && at < t.R.End {
			return t.R.Start
		}
	}
	return at
}

// WordAt is what a double-click at at takes: the word there by Unicode's
// word bounds (a run of spaces or of punctuation is one too), the one
// ending there at a line's end; a tag whole.
func (f *Field) WordAt(at int) Range {
	for _, t := range Tags(f.Text) {
		if t.R.Start <= at && at < t.R.End {
			return t.R
		}
	}
	s, e := f.lineStart(at), f.lineEnd(at)
	var words []Range
	rest, state, pos := f.Text[s:e], -1, s
	for len(rest) > 0 {
		var w string
		w, rest, state = uniseg.FirstWordInString(rest, state)
		words = append(words, Range{pos, pos + len(w)})
		pos += len(w)
	}
	for _, r := range words {
		if r.Contains(at) {
			return r
		}
	}
	if len(words) > 0 && words[len(words)-1].End == at {
		return words[len(words)-1]
	}
	return Range{at, at}
}

// LineAt is what a triple-click at at takes: its line, without the break.
func (f *Field) LineAt(at int) Range { return Range{f.lineStart(at), f.lineEnd(at)} }

// Select selects r, the cursor at its end; an empty one is just the cursor.
func (f *Field) Select(r Range) {
	f.Anchor = -1
	if r.Start != r.End {
		f.Anchor = r.Start
	}
	f.Cur = r.End
}

// SelectFrom is a selection from anchor to cur, the cursor at cur.
func (f *Field) SelectFrom(anchor, cur int) { f.Anchor, f.Cur = anchor, cur }

// Insert types s, over the selection if there is one.
func (f *Field) Insert(s string) {
	f.DeleteSelection()
	f.Text = f.Text[:f.Cur] + s + f.Text[f.Cur:]
	f.Cur += len(s)
}

// InsertWord types word as a word of its own: a space before it when the
// cursor sits right after text, and one after it. Over the selection, as
// Insert.
func (f *Field) InsertWord(word string) {
	f.DeleteSelection()
	before, after := "", " "
	if r, _ := utf8.DecodeLastRuneInString(f.Text[:f.Cur]); f.Cur > 0 && !unicode.IsSpace(r) {
		before = " "
	}
	if strings.HasPrefix(f.Text[f.Cur:], " ") {
		after = ""
	}
	f.Insert(before + word + after)
}

func (f *Field) prev() int {
	if f.Cur == 0 {
		return 0
	}
	_, n := utf8.DecodeLastRuneInString(f.Text[:f.Cur])
	return f.Cur - n
}

func (f *Field) next() int {
	if f.Cur >= len(f.Text) {
		return f.Cur
	}
	_, n := utf8.DecodeRuneInString(f.Text[f.Cur:])
	return f.Cur + n
}

// left is ←: a character back, or over a whole tag (never into one).
func (f *Field) left() int {
	p := f.prev()
	for _, t := range Tags(f.Text) {
		if t.R.Start < p && p < t.R.End {
			return t.R.Start
		}
	}
	return p
}

// right is →: a character on, or over a whole tag.
func (f *Field) right() int {
	n := f.next()
	for _, t := range Tags(f.Text) {
		if t.R.Start < n && n < t.R.End {
			return t.R.End
		}
	}
	return n
}

// End puts the cursor at the very end of the text.
func (f *Field) End() { f.go_(len(f.Text), false) }

// Backspace deletes the selection, or the character before the cursor; a
// tag (`[Image #N]`, `[Pasted text #N …]`) goes in one keystroke, like a
// single character.
func (f *Field) Backspace() {
	if f.DeleteSelection() {
		return
	}
	p := f.prev()
	for _, t := range Tags(f.Text) {
		if t.R.End == f.Cur {
			p = t.R.Start
			break
		}
	}
	f.Text = f.Text[:p] + f.Text[f.Cur:]
	f.Cur = p
}

func (f *Field) Delete() {
	if f.DeleteSelection() {
		return
	}
	n := f.next()
	for _, t := range Tags(f.Text) {
		if t.R.Start == f.Cur {
			n = t.R.End
			break
		}
	}
	f.Text = f.Text[:f.Cur] + f.Text[n:]
}

// Transpose is ^t, readline's transpose-chars: the character before the
// cursor and the one under it swap, the cursor going on past them; at a
// line's end, the two before it swap. Never across a line break.
func (f *Field) Transpose() {
	f.Anchor = -1
	mid := f.Cur
	if f.Cur == f.lineEnd(f.Cur) {
		mid = f.prev()
	}
	a, an := utf8.DecodeLastRuneInString(f.Text[:mid])
	b, bn := utf8.DecodeRuneInString(f.Text[mid:])
	if an == 0 || bn == 0 || a == '\n' || b == '\n' {
		return
	}
	end := mid + bn
	f.Text = f.Text[:mid-an] + string(b) + string(a) + f.Text[end:]
	f.Cur = end
}

// wordLeftPos is alt-←: back to the start of this word (or the previous one).
func (f *Field) wordLeftPos() int {
	pos := f.Cur
	for _, word := range []bool{false, true} {
		for pos > 0 {
			c, n := utf8.DecodeLastRuneInString(f.Text[:pos])
			if isWord(c) != word {
				break
			}
			pos -= n
		}
	}
	// A tag is one word.
	for _, t := range Tags(f.Text) {
		if t.R.Start < pos && pos < t.R.End {
			return t.R.Start
		}
	}
	return pos
}

// wordEnd is alt-→: on to the end of this word (or the next one).
func (f *Field) wordEnd() int {
	end := f.Cur
	for _, word := range []bool{false, true} {
		for end < len(f.Text) {
			c, n := utf8.DecodeRuneInString(f.Text[end:])
			if isWord(c) != word {
				break
			}
			end += n
		}
	}
	for _, t := range Tags(f.Text) {
		if t.R.Start < end && end < t.R.End {
			return t.R.End
		}
	}
	return end
}

// KillWordRight is alt-d: from the cursor to the end of the word (or the
// selection).
func (f *Field) KillWordRight() {
	if f.DeleteSelection() {
		return
	}
	e := f.wordEnd()
	f.Text = f.Text[:f.Cur] + f.Text[e:]
}

// KillWord is ^w: the word before the cursor, with the spaces after it (or
// the selection).
func (f *Field) KillWord() {
	if f.DeleteSelection() {
		return
	}
	before := f.Text[:f.Cur]
	t := len(strings.TrimRightFunc(before, unicode.IsSpace))
	cut := 0
	for i := t; i > 0; {
		c, n := utf8.DecodeLastRuneInString(before[:i])
		i -= n
		if unicode.IsSpace(c) || c == '/' {
			cut = i + n
			break
		}
	}
	f.Text = f.Text[:cut] + f.Text[f.Cur:]
	f.Cur = cut
}

// KillStart is ^u: back to the start of the cursor's line; at its start,
// the line break before it, joining the line above.
func (f *Field) KillStart() {
	if f.DeleteSelection() {
		return
	}
	s := f.lineStart(f.Cur)
	if s == f.Cur {
		s = max(s-1, 0)
	}
	f.Text = f.Text[:s] + f.Text[f.Cur:]
	f.Cur = s
}

// KillEnd is ^k: on to the end of the cursor's line; at its end, the line
// break, joining the line below (emacs's ^k).
func (f *Field) KillEnd() {
	if f.DeleteSelection() {
		return
	}
	e := f.lineEnd(f.Cur)
	if e == f.Cur && e < len(f.Text) {
		e++
	}
	f.Text = f.Text[:f.Cur] + f.Text[e:]
}
