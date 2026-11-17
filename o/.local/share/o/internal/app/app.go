// Package app is o's state, keys and the mouse. One prompt, as `claude >`
// has, named for the configuration ⏎ starts (`claude(opus) >`; ⇧tab the
// next one, ^1…^9 the Nth): write it (as many lines as it takes, images
// pasted in), ⏎ starts that agent with it in a new Rex tab, and the prompt
// empties for the next one. A pasted image is an `[Image #N]` tag in the
// text, its file listed at the end of what's sent; it isn't drawn. ⌥c copies
// the text without them, its spaces and blank lines tidied.
//
// Drafts: ^s saves the prompt as one and clears the input; editing a draft
// saves as it's written (esc leaves it, ⏎ sends it and it goes). ^g goes through this
// session's drafts, a list in the prompt's place with al's keys: j k, ⏎
// sends, e edits, x deletes, u brings it back, d a new one. ⇧↑ ⇧↓ mark
// drafts (space one, a all): ⏎ then sends the marked ones as one prompt, a
// preamble over them as tasks; x deletes them. Drafts stay on this computer.
//
// Caps+N / ⌥⌘N (Rex) shows the images big, in a floating pane (package
// viewer): o keeps the ones the prompt tags now as this pane's, and the
// ones each send took as its agent's pane's (package panes).
package app

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"o/internal/config"
	"o/internal/drafts"
	"o/internal/field"
	"o/internal/gfx"
	"o/internal/panes"
	"o/internal/spawn"
	"o/internal/theme"
	"o/internal/tui"
)

const (
	// multiClick: presses on one cell this close together count up: 2 takes a word, 3 a line.
	multiClick = 400 * time.Millisecond
	toastFor   = 2500 * time.Millisecond
	// escAgain: a second esc this soon after the first clears the prompt.
	escAgain = 2 * time.Second
	// saveAfter: a draft is saved once the keys have paused this long.
	saveAfter = 300 * time.Millisecond
	// The drafts list shows at most listRows drafts, and previewRows of the
	// selected one under them.
	listRows    = 8
	previewRows = 10
	// imgRows: the selected draft's images over the list, at most this many
	// rows tall (a label under each takes one more).
	imgRows = 8
	// The draft being written's images, over its text: all in a row and all
	// as tall, editImgRows rows or as tall as they can all be side by side,
	// down to editImgMin.
	editImgRows = 8
	editImgMin  = 2
	// history is the prompts kept for ↑.
	history = 500
	// namedMinText: narrower than this many columns of text, the prompt shows
	// `>` only, not the configuration's name.
	namedMinText = 20
)

type Act int

const (
	ActNone Act = iota
	ActQuit
	// ActClearScreen is ^l: clear the screen, the prompt at its top.
	ActClearScreen
)

// Sent is a prompt sent: its agent (the configuration's name, or ↳tab for a
// reply), its text, and how the start went (nil while it's starting).
type Sent struct {
	Name    string
	Text    string
	Plan    bool
	Outcome *spawn.Outcome
	// Images is the images it took: its agent's pane's, once it's there.
	Images []drafts.Tagged
	// again keeps the complete prompt and image paths, even when Text is a summary.
	again hist
	// agent is the configuration it started; -1 for a reply.
	agent int
}

// Lay is where things are, in lines from the prompt's first.
type Lay struct {
	// Width and ScreenH are the terminal's size (Width capped).
	Width, ScreenH int
	// Text is where the text's rows go (the prompt's name is left of them).
	Text tui.Rect
	// Height is all of it: the text, a toast, what's starting.
	Height int
}

// ListView is the drafts list (^g), as laid out.
type ListView struct {
	// Top is the first draft in view, Shown how many are.
	Top, Shown int
	// Rows is the selected draft's text, wrapped: Preview of them show, More don't.
	Rows          []field.Range
	Preview, More int
	// Strip is the rows over the list kept for the selected draft's images
	// (their labels included); 0: none, when no draft has any.
	Strip  int
	Thumbs []Thumb
	// Note is said where there's no picture: "no images", "loading…", "+2 more".
	Note string
}

// Strip is the draft being written's images, over its text: Height rows,
// their labels included (0: none).
type Strip struct {
	Height int
	Thumbs []Thumb
	Note   string
}

// Thumb is one image over the list or a draft: Kitty image ID, Cols×Rows
// cells from column X, `[Image #N]`.
type Thumb struct {
	X    int
	ID   uint32
	Cols int
	Rows int
	N    int
}

// picState is an image file readied for the terminal (loading while it loads).
type picState struct {
	pic     gfx.Pic
	err     error
	loading bool
}

type picDone struct {
	path string
	pic  gfx.Pic
	err  error
}

type Opts struct {
	// Cwd is where the agents start.
	Cwd string
	// Text is what the prompt starts with.
	Text string
	// Label is the first tab's label (a note's name); "" leaves it to Rex.
	Label string
	// Agents are the configurations, and Start the one to start on.
	Agents []config.Agent
	Start  int
	// Profiles are this computer's Claude profiles, and Profile the one to
	// start on. Empty: the main one only.
	Profiles []config.Profile
	Profile  int
	// Notice is said in a toast at the start: what was wrong with the config file.
	Notice string
	// MaxWidth is the most columns o draws in; 0: the terminal's width.
	MaxWidth int
}

type Toast struct {
	Msg string
	OK  bool
	at  time.Time
}

type kept struct {
	f       field.Field
	images  []string
	literal string
}

func (a *App) keep() *kept {
	return &kept{a.Field, append([]string(nil), a.Images...), a.slash.literal}
}

type asideState struct {
	kept
	agent int
	plan  bool
}

type hist struct {
	text   string
	images []string
}

type App struct {
	Pal   theme.Palette
	Field field.Field
	slash slashState
	// Images is the file behind each tag: `[Image #N]` is Images[N-1].
	Images   []string
	Cwd      string
	Label    string
	Agents   []config.Agent
	Agent    int
	Profiles []config.Profile
	Profile  int
	// Plan (^p): it goes as `/plan …`.
	Plan bool
	// cleared is what ^c or esc esc cleared, or ⏎ sent: ^z brings it back.
	cleared *kept
	// killed is what ^u ^k ^w ⌥d ⌥⌫ deleted last: ^y puts it back.
	killed string
	// history is the sent prompts, oldest first (read at the first ↑).
	history       []hist
	historyLoaded bool
	// histAt is the entry ↑ is on, counting back from the newest (0); -1:
	// the prompt being written, kept in draft meanwhile.
	histAt int
	draft  *kept
	escAt  time.Time
	// Drafts is this session's drafts, newest first.
	Drafts      []drafts.Draft
	draftsSeen  time.Time
	draftsKnown bool
	// scope is this Rex session's id and name, asked for at the first draft.
	scope *[2]string
	// Editing is the draft the prompt is writing, as last saved.
	Editing *drafts.Draft
	// List is the selected draft, going through them (^g); -1: not.
	List     int
	View     ListView
	Pictures Strip
	fromList bool
	// aside is the prompt that was being written when a draft took its
	// place. Back when the draft is left.
	aside *asideState
	// undo is the drafts x deleted last: u brings them back.
	undo []drafts.Draft
	// Marked is the drafts marked in the list, by id.
	Marked []string
	// markFrom is a run of ⇧↑ ⇧↓: the draft it started on, and what was marked before.
	markFrom *markRun
	// Gfx is set when the terminal draws Kitty images.
	Gfx     *gfx.Gfx
	pics    map[string]*picState
	picCh   chan picDone
	imgs    gfx.Images
	lastKey time.Time
	Toast   *Toast
	Sent    []Sent
	// SentAt is the send selected with ↑ on an empty prompt; -1: none.
	SentAt int
	// focusNext: ⏎ on a send still starting focuses its tab the moment it exists.
	focusNext int
	done      []int
	sentCh    chan spawn.Done
	maxWidth  int
	Lay       Lay
	// Rows is the text's rows, as Lay.Text wraps them.
	Rows []field.Range
	// Scroll is the first of Rows in view.
	Scroll    int
	followed  *[5]int
	press     *pressState
	lastPress *lastPress
	// Block is this pane (REX_BLOCK), whose images Caps+N shows; "": tests.
	Block     string
	published *[]drafts.Tagged
	// Live is false for --snapshot: nothing is sent or copied, only noted.
	Live      bool
	WouldSend *string
	WouldCopy *string
}

type markRun struct {
	from   int
	marked []string
}

type pressState struct {
	span field.Range
	n    int
}

type lastPress struct {
	at   time.Time
	x, y int
	n    int
}

func New(pal theme.Palette, o Opts) *App {
	f := field.New(o.Text)
	f.End()
	a := &App{
		Pal: pal, Field: f, Cwd: o.Cwd, Label: o.Label, histAt: -1, List: -1, SentAt: -1, focusNext: -1,
		pics: map[string]*picState{}, picCh: make(chan picDone, 32), lastKey: time.Now(),
		sentCh: make(chan spawn.Done, 32), maxWidth: o.MaxWidth, Live: true,
	}
	a.Agents = o.Agents
	if len(a.Agents) == 0 {
		a.Agents = config.Defaults()
	}
	a.Agent = min(o.Start, len(a.Agents)-1)
	a.Profiles = o.Profiles
	if len(a.Profiles) == 0 {
		a.Profiles = config.FindMain()
	}
	a.Profile = min(o.Profile, len(a.Profiles)-1)
	if o.Notice != "" {
		a.Toast = &Toast{o.Notice, false, time.Now()}
	}
	return a
}

// Current is the configuration ⏎ starts.
func (a *App) Current() config.Agent { return a.Agents[a.Agent] }

// launch is ag as it starts: on the Claude profile o is on.
func (a *App) launch(ag config.Agent) config.Agent {
	var p *config.Profile
	if a.Profile < len(a.Profiles) {
		p = &a.Profiles[a.Profile]
	}
	return ag.On(p)
}

// Prefix is what's left of the text on its first row: the configuration ⏎
// starts, then `>` (`◇` in a draft). A reply, which goes to an agent
// already running, is `◇` only; so is a terminal too narrow for the name.
func (a *App) Prefix() string { return a.prefixAt(a.Lay.Width) }

func (a *App) prefixAt(width int) string {
	glyph := ">"
	if a.Editing != nil {
		glyph = "◇"
	}
	name := a.launch(a.Current()).Name
	reply := a.Editing != nil && a.Editing.Reply != nil
	if reply || width < field.StrWidth(name)+4+namedMinText {
		return glyph
	}
	return name + " " + glyph
}

// Say shows a toast.
func (a *App) Say(msg string, ok bool) { a.Toast = &Toast{msg, ok, time.Now()} }

// ---- layout ------------------------------------------------------------------

// Cap is the columns o draws in on a terminal w wide: at most max_width,
// from the left, so a wide pane doesn't stretch the text across it.
func (a *App) Cap(w int) int {
	if a.maxWidth == 0 {
		return w
	}
	return min(w, a.maxWidth)
}

// textWidth is the columns the text wraps to on a terminal w wide: less the
// `claude(opus) > ` gutter, a column for the cursor past a full row, and the
// last column, left alone (writing there leaves the terminal waiting to wrap).
func (a *App) textWidth(w int) int {
	gutter := field.StrWidth(a.prefixAt(w)) + 1
	return max(w-(gutter+2), 4)
}

// Layout lays the prompt out for a width×screenH terminal: its text's rows,
// as many as there are up to the screen, scrolled to keep the cursor in
// view; under them a toast and what's starting, when there are.
func (a *App) Layout(width, screenH int) {
	width = a.Cap(width)
	tw := a.textWidth(width)
	starting := 0
	for _, s := range a.Sent {
		if s.Outcome == nil {
			starting++
		}
	}
	extra := starting
	if a.Toast != nil {
		extra++
	}
	// A line of what was there before stays in view.
	room := max(screenH-(extra+1), 1)
	a.slash.height = 0
	if len(a.Drafts) == 0 {
		a.List = -1
	}
	a.Pictures = Strip{}
	if a.List >= 0 {
		sel := min(a.List, len(a.Drafts)-1)
		a.List = sel
		var marked []string
		for _, id := range a.Marked {
			for _, d := range a.Drafts {
				if d.ID == id {
					marked = append(marked, id)
					break
				}
			}
		}
		a.Marked = marked
		// The list has no name on the left: its text is as wide as `> `'s.
		tw := max(width-4, 4)
		// The selected draft's images on top. The room is kept while any
		// draft has one, so the list stays put as the selection moves; it's
		// the first thing to go on a short screen.
		strip := min(imgRows+1, max(room-(min(len(a.Drafts), listRows)+2), 0))
		pictures := false
		if a.Gfx != nil {
			for _, d := range a.Drafts {
				if len(drafts.TaggedImages(d.Text, d.Images)) > 0 {
					pictures = true
					break
				}
			}
		}
		if !pictures || strip < 4 {
			strip = 0
		}
		room := room - strip
		shown := min(len(a.Drafts), listRows, max(room-2, 1))
		top := min(a.View.Top, len(a.Drafts)-shown)
		if sel < top {
			top = sel
		} else if sel >= top+shown {
			top = sel + 1 - shown
		}
		text := a.Drafts[sel].Text
		var rows []field.Range
		if strings.TrimSpace(text) != "" {
			rows = field.WordRows(text, max(tw-2, 4))
		}
		fits := min(max(room-(shown+1), 0), previewRows)
		preview := len(rows)
		if len(rows) > fits {
			preview = max(fits-1, 0)
		}
		more := len(rows) - preview
		var thumbs []Thumb
		note := ""
		if strip > 0 {
			thumbs, note = a.thumbs(sel, tw, strip-1)
		}
		body := strip + shown + preview + 1
		if more > 0 && fits > 0 {
			body++
		}
		a.View = ListView{Top: top, Shown: shown, Rows: rows, Preview: preview, More: more, Strip: strip, Thumbs: thumbs, Note: note}
		a.Rows = nil
		a.Lay = Lay{Width: width, ScreenH: screenH, Text: tui.Rect{X: 2, Y: 0, W: tw, H: body}, Height: body + extra}
		return
	}
	if a.SentAt >= 0 {
		a.Rows = nil
		body := min(room, 3)
		a.Lay = Lay{Width: width, ScreenH: screenH, Text: tui.Rect{X: 2, Y: 0, W: tw, H: body}, Height: body + extra}
		return
	}
	slashHeight := a.layoutSlash(room)
	room = max(room-slashHeight, 1)
	a.Rows = field.WordRows(a.Field.Text, tw)
	// A draft's images over its text, staying there as it scrolls.
	a.Pictures = a.draftPictures(tw, room)
	top := a.Pictures.Height
	view := max(min(len(a.Rows), room-top), 1)
	gutter := field.StrWidth(a.prefixAt(width)) + 1
	a.Lay = Lay{Width: width, ScreenH: screenH, Text: tui.Rect{X: gutter, Y: top, W: tw, H: view}, Height: top + view + slashHeight + extra}
	a.follow(view, tw)
}

// busy: something will change without a key (a send starting, a toast to
// take down, an image loading). The loop wakes more often then.
func (a *App) busy() bool {
	if a.Toast != nil {
		return true
	}
	for _, s := range a.Sent {
		if s.Outcome == nil {
			return true
		}
	}
	for _, p := range a.pics {
		if p.loading {
			return true
		}
	}
	return false
}

// CursorRow is the row the cursor is on.
func (a *App) CursorRow() int {
	cr := 0
	for i, r := range a.Rows {
		if r.Start <= a.Field.Cur {
			cr = i
		}
	}
	return cr
}

// CursorCell is where the terminal's cursor goes, from the prompt's first
// line: on the cursor's cell, when its row is in view.
func (a *App) CursorCell() *[2]int {
	if a.List >= 0 || a.SentAt >= 0 || len(a.Rows) == 0 {
		return nil
	}
	cr := a.CursorRow()
	t := a.Lay.Text
	if cr < a.Scroll || cr >= a.Scroll+t.H {
		return nil
	}
	x := t.X + field.StrWidth(a.Field.Text[a.Rows[cr].Start:a.Field.Cur])
	return &[2]int{x, t.Y + (cr - a.Scroll)}
}

// follow keeps the cursor's row in view when it moved or the text changed
// since last time.
func (a *App) follow(view, tw int) {
	now := [5]int{a.Field.Cur, len(a.Field.Text), a.Field.Anchor, tw, view}
	if a.followed == nil || *a.followed != now {
		a.followed = &now
		cr := a.CursorRow()
		if cr < a.Scroll {
			a.Scroll = cr
		} else if cr >= a.Scroll+view {
			a.Scroll = cr + 1 - view
		}
	}
	a.Scroll = min(a.Scroll, max(len(a.Rows)-view, 0))
}

// ---- images ------------------------------------------------------------------

// thumbs is draft sel's images, side by side in width columns, each at
// most rows tall (its label under it), and what to say where there's no
// picture. The ones not readied yet start loading.
func (a *App) thumbs(sel, width, rows int) ([]Thumb, string) {
	if a.Gfx == nil {
		return nil, ""
	}
	d := a.Drafts[sel]
	tagged := drafts.TaggedImages(d.Text, d.Images)
	if len(tagged) == 0 {
		return nil, "no images"
	}
	return a.rowOfThumbs(*a.Gfx, tagged, width, rows, rows, false)
}

// draftPictures is the draft being written's images, over its text in
// width columns: all of them in a row, all editImgRows tall, or shorter
// when that's what it takes to fit them all across. The text keeps a few
// rows of room (its own, when it has fewer); none when there's no room.
func (a *App) draftPictures(width, room int) Strip {
	if a.Gfx == nil || a.Editing == nil {
		return Strip{}
	}
	tagged := drafts.TaggedImages(a.Field.Text, a.Images)
	if len(tagged) == 0 {
		return Strip{}
	}
	keep := max(min(len(a.Rows), 4), 1)
	rows := min(editImgRows, max(room-(keep+1), 0))
	if rows < editImgMin {
		return Strip{}
	}
	thumbs, note := a.rowOfThumbs(*a.Gfx, tagged, width, editImgMin, rows, true)
	tallest := 0
	for _, t := range thumbs {
		tallest = max(tallest, t.Rows+1)
	}
	if note != "" {
		tallest = max(tallest, 1)
	}
	return Strip{Height: tallest, Thumbs: thumbs, Note: note}
}

// rowOfThumbs is tagged's images side by side in width columns, a label
// under each: as tall as lo…hi rows allow with every one of them in the row
// (the shortest, with as many as fit and `+N more`, when none does). Each
// keeps its shape: no bigger than itself, the last one squeezed into what's
// left; or, even, all exactly as tall.
func (a *App) rowOfThumbs(g gfx.Gfx, tagged []drafts.Tagged, width, lo, hi int, even bool) ([]Thumb, string) {
	for _, t := range tagged {
		if _, ok := a.pics[t.Path]; !ok {
			a.loadPic(t.Path)
		}
	}
	size := func(p string) (int, int, bool) {
		if s, ok := a.pics[p]; ok && !s.loading && s.err == nil {
			return s.pic.W, s.pic.H, true
		}
		return 0, 0, false
	}
	label := func(n int) int { return len(fmt.Sprintf("[Image #%d]", n)) }
	// A picture's cells at r rows with left columns left; false when it doesn't fit.
	cells := func(w, h, left, r int) (int, int, bool) {
		if even {
			c := gfx.ColsAt(w, h, g, r)
			return c, r, c <= left
		}
		if left < 6 {
			return 0, 0, false
		}
		c, rr := gfx.Fit(w, h, g, left, r)
		return c, rr, true
	}
	// The tallest that fits them all: the columns they take, the gaps between included.
	across := func(r int) int {
		sum := 0
		for _, t := range tagged {
			w, h, ok := size(t.Path)
			if !ok {
				continue
			}
			c, _, fits := cells(w, h, 1<<30, r)
			if !fits {
				c = 0
			}
			sum += max(c, label(t.N)) + 2
		}
		return max(sum-2, 0)
	}
	rows := lo
	for r := hi; r >= lo; r-- {
		if across(r) <= width {
			rows = r
			break
		}
	}
	var out []Thumb
	x, full := 0, false
	loading, more := 0, 0
	var failed []string
	for _, t := range tagged {
		s, ok := a.pics[t.Path]
		switch {
		case !ok || s.loading:
			loading++
		case s.err != nil:
			failed = append(failed, fmt.Sprintf("[Image #%d]", t.N))
		default:
			// The first that doesn't fit, and the ones after it, are `+N more`.
			cols, r, fits := 0, 0, false
			if !full {
				cols, r, fits = cells(s.pic.W, s.pic.H, max(width-x, 0), rows)
			}
			if !fits {
				full = true
				more++
				continue
			}
			id := a.imgs.IDFor(gfx.Key{Path: t.Path, Cols: cols, Rows: r}, s.pic.B64)
			out = append(out, Thumb{X: x, ID: id, Cols: cols, Rows: r, N: t.N})
			x += max(cols, label(t.N)) + 2
		}
	}
	var note []string
	if loading > 0 {
		note = append(note, "loading…")
	}
	if more > 0 {
		note = append(note, fmt.Sprintf("+%d more", more))
	}
	if len(failed) > 0 {
		note = append(note, "couldn't show "+strings.Join(failed, " "))
	}
	return out, strings.Join(note, " · ")
}

// imagesMoved: the draft's images were copied beside it (KeepImages): what
// was readied for the terminal, and what it was sent, go under the copies'
// names, so the pictures stay put rather than load again.
func (a *App) imagesMoved(from, to []string) {
	for i := 0; i < len(from) && i < len(to); i++ {
		if from[i] == to[i] {
			continue
		}
		if p, ok := a.pics[from[i]]; ok {
			cp := *p
			a.pics[to[i]] = &cp
		}
		a.imgs.Rename(from[i], to[i])
	}
}

// loadPic readies path for the terminal, off the UI goroutine (Tick picks
// it up); --snapshot waits for it.
func (a *App) loadPic(path string) {
	if !a.Live {
		pic, err := gfx.LoadPic(path)
		a.pics[path] = &picState{pic: pic, err: err}
		return
	}
	a.pics[path] = &picState{loading: true}
	go func() {
		pic, err := gfx.LoadPic(path)
		a.picCh <- picDone{path, pic, err}
	}()
}

// SetPic is a readied picture, as a test or --snapshot gives it.
func (a *App) SetPic(path string, w, h int) {
	a.pics[path] = &picState{pic: gfx.Pic{W: w, H: h, B64: "AAAA"}}
}

// TakeGfx is bytes for the terminal (images to send or free), to write before the frame.
func (a *App) TakeGfx() []byte { return a.imgs.Take() }

// ClearImages frees every image o sent, for quitting.
func (a *App) ClearImages() []byte { return a.imgs.Clear() }

// ---- the loop's hooks ----------------------------------------------------------

// Tick: sends finished, images loaded, a toast gone. True when the screen changed.
func (a *App) Tick() bool {
	changed := false
	for {
		select {
		case d := <-a.sentCh:
			if d.N < len(a.Sent) {
				s := &a.Sent[d.N]
				// Caps+N in the agent's pane shows the images it was sent.
				if a.Live && d.Out.OK && d.Out.Target != "" && len(s.Images) > 0 {
					panes.Write(d.Out.Target, panes.Sent, s.Images)
				}
				out := d.Out
				s.Outcome = &out
				a.done = append(a.done, d.N)
			}
			if a.focusNext == d.N {
				a.focusSent(d.N)
			}
			changed = true
			continue
		case p := <-a.picCh:
			a.pics[p.path] = &picState{pic: p.pic, err: p.err}
			changed = true
			continue
		default:
		}
		break
	}
	if a.Toast != nil && time.Since(a.Toast.at) > toastFor {
		a.Toast = nil
		changed = true
	}
	return changed
}

// Idle: no key for a while. The draft being written is saved once the
// typing has paused, and the list brought up to date with the file (another
// local prompt may have changed it). True when the screen changed.
func (a *App) Idle() bool {
	toasted := a.Toast != nil
	if time.Since(a.lastKey) >= saveAfter {
		a.saveDraft()
	}
	changed := (a.Toast != nil) != toasted
	if a.List >= 0 && a.Live && !a.seen(drafts.Stamp()) {
		id := ""
		if a.List < len(a.Drafts) {
			id = a.Drafts[a.List].ID
		}
		a.reloadDrafts()
		a.selectDraft(id)
		if len(a.Drafts) == 0 {
			a.closeList()
		}
		changed = true
	}
	return changed
}

func (a *App) seen(stamp time.Time) bool {
	if stamp.IsZero() {
		return !a.draftsKnown
	}
	return a.draftsKnown && stamp.Equal(a.draftsSeen)
}

// Wait is how long the loop may sleep: short while something changes on
// its own, or a draft waits to be saved.
func (a *App) Wait() time.Duration {
	switch {
	case a.busy():
		return 50 * time.Millisecond
	case a.unsaved():
		return saveAfter
	}
	return time.Second
}

// Showing is the images Caps+N shows over this pane now: the selected
// draft's in the list, else the ones the prompt tags.
func (a *App) Showing() []drafts.Tagged {
	if a.List >= 0 && a.List < len(a.Drafts) {
		d := a.Drafts[a.List]
		return drafts.TaggedImages(d.Text, d.Images)
	}
	return drafts.TaggedImages(a.Field.Text, a.Images)
}

// Publish keeps this pane's images as Showing has them, when they changed.
func (a *App) Publish() {
	if a.Block == "" {
		return
	}
	now := a.Showing()
	if a.published == nil || !sameTagged(*a.published, now) {
		panes.Write(a.Block, panes.Prompt, now)
		a.published = &now
	}
}

func sameTagged(x, y []drafts.Tagged) bool {
	if len(x) != len(y) {
		return false
	}
	for i := range x {
		if x[i] != y[i] {
			return false
		}
	}
	return true
}

// Unpublish: quitting, none here any more.
func (a *App) Unpublish() {
	if a.Block != "" {
		panes.Write(a.Block, panes.Prompt, nil)
	}
}

// Flush: leaving o, the draft being written saved (an empty one dropped).
func (a *App) Flush() {
	if a.Editing == nil {
		return
	}
	if strings.TrimSpace(a.Field.Text) == "" {
		a.dropDrafts(a.Editing.ID)
	} else {
		a.saveDraft()
	}
}

// TakeDone is the sends that finished since last time, to print above.
func (a *App) TakeDone() []int {
	d := a.done
	a.done = nil
	return d
}

// ---- events ------------------------------------------------------------------

func (a *App) Handle(ev tui.Event) Act {
	switch e := ev.(type) {
	case tui.Key:
		if !e.Release {
			return a.key(e)
		}
	case tui.Paste:
		a.paste(string(e))
	case tui.Mouse:
		a.mouse(e)
	}
	return ActNone
}

func (a *App) key(k tui.Key) Act {
	ctrl, alt, shift, sup := k.Has(tui.ModCtrl), k.Has(tui.ModAlt), k.Has(tui.ModShift), k.Has(tui.ModSuper)
	if k.Code != tui.KeyEsc {
		a.escAt = time.Time{}
	}
	a.lastKey = time.Now()
	if a.List >= 0 {
		return a.listKey(k)
	}
	if sel := a.SentAt; sel >= 0 {
		plain := !shift && !alt && !ctrl && !sup
		switch {
		case k.Code == tui.KeyUp && plain:
			a.SentAt = max(sel-1, 0)
		case k.Code == tui.KeyDown && plain:
			a.SentAt = -1
			if sel+1 < len(a.Sent) {
				a.SentAt = sel + 1
			}
		case k.Code == tui.KeyEnter && !shift && !alt:
			a.focusSent(sel)
		case k.Is('e') && !alt && !ctrl && !sup:
			a.editSent(sel)
		case k.Code == tui.KeyEsc:
			a.SentAt = -1
		default:
			a.SentAt = -1
			return a.key(k)
		}
		return ActNone
	}
	if a.slashKey(k) {
		return ActNone
	}
	ch := func(r rune) bool { return k.Is(r) }
	switch {
	case k.Code == tui.KeyUp && k.Mod == 0 && a.Field.Text == "" && a.Editing == nil && len(a.Sent) > 0:
		a.SentAt = len(a.Sent) - 1
	// Esc drops a selection, then (twice) clears the prompt, then quits. Out
	// of a draft it just leaves: the draft stays, as saved.
	case k.Code == tui.KeyEsc && a.Field.HasSelection():
		a.Field.Anchor = -1
	case k.Code == tui.KeyEsc && a.Editing != nil:
		a.leaveDraft()
	case k.Code == tui.KeyEsc && a.Field.Text == "":
		return ActQuit
	case k.Code == tui.KeyEsc && !a.escAt.IsZero() && time.Since(a.escAt) < escAgain:
		a.escAt = time.Time{}
		a.clearBox("cleared · ^z brings it back")
	case k.Code == tui.KeyEsc:
		a.escAt = time.Now()
		a.Say("esc again to clear", true)
	// ^c copies the selection; with none it clears the prompt, and on an
	// empty one it quits. ^x cuts, ^z brings back what was cleared (or sent).
	case ch('c') && ctrl:
		return a.ctrlC()
	// ⌥c copies the text alone: the selection's, else the prompt's.
	case ch('c') && alt:
		text, ok := a.Field.Selected()
		if !ok {
			text = a.Field.Text
		}
		a.copyPlain(text)
	case ch('d') && ctrl && a.Field.Text == "" && a.Editing != nil:
		a.leaveDraft()
	case ch('d') && ctrl && a.Field.Text == "":
		return ActQuit
	// ^s saves and leaves the prompt as a draft; ^g goes through the drafts.
	case ch('s') && ctrl:
		a.keepAsDraft()
	case ch('g') && ctrl:
		a.openList()
	case ch('x') && ctrl:
		a.cut()
	case ch('z') && ctrl:
		a.unclear()
	// Newline: shift+Enter (the kitty keyboard protocol tells it from
	// Enter), alt+Enter, or ^j anywhere.
	case k.Code == tui.KeyEnter && (alt || shift):
		a.Field.Insert("\n")
	case ch('j') && ctrl:
		a.Field.Insert("\n")
	// ^⏎ or ^o: send it, and go to its tab.
	case k.Code == tui.KeyEnter && ctrl:
		a.send(true)
	case ch('o') && ctrl:
		a.send(true)
	case k.Code == tui.KeyEnter:
		a.send(false)
	// ⇧tab: the next configuration (round to the first after the last);
	// ^1…^9 the Nth, as config.toml lists them.
	case k.Code == tui.KeyBackTab:
		a.pickAgent(a.Agent + 1)
	case k.Code == tui.KeyTab && shift:
		a.pickAgent(a.Agent + 1)
	case k.Code == tui.KeyRune && k.Rune >= '1' && k.Rune <= '9' && ctrl && !alt:
		n := int(k.Rune - '1')
		if n < len(a.Agents) {
			a.pickAgent(n)
		} else {
			a.Say(fmt.Sprintf("there's no configuration %d · o --config lists them", n+1), false)
		}
	// ^n: the next Claude profile (account), round to the main one.
	case ch('n') && ctrl:
		a.nextProfile()
	case ch('p') && ctrl:
		a.Plan = !a.Plan
		if a.Plan {
			a.Say("plan mode: sends `/plan …`", true)
		} else {
			a.Say("plan mode off", true)
		}
	case ch('v') && ctrl:
		a.pasteImage()
	// ^l: as in a shell, the screen cleared and the prompt at its top.
	case ch('l') && ctrl:
		return ActClearScreen
	// ^y: what ^u ^k ^w ⌥d ⌥⌫ deleted last, back at the cursor.
	case ch('y') && ctrl:
		a.Field.Insert(a.killed)
	// ↑↓: a row up or down, as the prompt wraps the text; from its first row
	// ↑ goes back through what was sent (from its last, ↓ comes forward
	// again), as a shell's history does. ⇧↑ ⇧↓ select along.
	case (k.Code == tui.KeyUp || k.Code == tui.KeyDown) && !alt && !sup:
		up := k.Code == tui.KeyUp
		rows := field.WordRows(a.Field.Text, a.textWidth(a.Lay.Width))
		row := 0
		for i, r := range rows {
			if r.Start <= a.Field.Cur {
				row = i
			}
		}
		edge := row+1 == len(rows)
		if up {
			edge = row == 0
		}
		// (Not in a draft: what's recalled would be saved over it.)
		recalled := false
		if !shift && edge && a.Editing == nil {
			if up {
				recalled = a.historyBack()
			} else {
				recalled = a.historyForward()
			}
		}
		if !recalled {
			dir := 1
			if up {
				dir = -1
			}
			a.Field.VerticalBy(rows, dir, shift)
		}
	// The deleting keys keep what they deleted, for ^y.
	case (ch('u') || ch('k') || ch('w')) && ctrl:
		a.kill(k)
	case (ch('d') || ch('D')) && alt:
		a.kill(k)
	case k.Code == tui.KeyBackspace && alt:
		a.kill(k)
	default:
		a.Field.Key(k)
	}
	return ActNone
}

// kill is a deleting key: what it took (from where the cursor lands, as
// long as the text got shorter) kept for ^y.
func (a *App) kill(k tui.Key) {
	before := a.Field.Text
	a.Field.Key(k)
	if n := len(before) - len(a.Field.Text); n > 0 {
		at := a.Field.Cur
		a.killed = before[at : at+n]
	}
}

// ---- history -----------------------------------------------------------------

func (a *App) loadedHistory() []hist {
	if !a.historyLoaded {
		a.historyLoaded = true
		if a.Live {
			a.history = loadHistory()
		}
	}
	return a.history
}

// historyBack is ↑ on the first row: the sent prompt before the one shown
// (the prompt being written kept aside). False when there's none further.
func (a *App) historyBack() bool {
	to := a.histAt + 1
	all := a.loadedHistory()
	if to >= len(all) {
		return false
	}
	h := all[len(all)-1-to]
	if a.histAt < 0 {
		a.draft = a.keep()
		a.Field, a.Images = field.New(""), nil
	}
	a.histAt = to
	a.show(h.text, h.images)
	return true
}

// historyForward is ↓ on the last row: the next newer prompt, or past the
// newest the one being written. False when not going through them.
func (a *App) historyForward() bool {
	if a.histAt < 0 {
		return false
	}
	if a.histAt == 0 {
		a.histAt = -1
		if a.draft != nil {
			a.Field, a.Images = a.draft.f, a.draft.images
			a.slash.literal = a.draft.literal
		} else {
			a.Field, a.Images = field.New(""), nil
		}
		a.draft = nil
		a.Field.End()
		return true
	}
	all := a.history
	i := a.histAt - 1
	if i >= len(all) {
		return false
	}
	h := all[len(all)-1-i]
	a.histAt = i
	a.show(h.text, h.images)
	return true
}

func (a *App) show(text string, images []string) {
	a.slash.literal, a.slash.query = "", ""
	a.Field = field.New(text)
	a.Field.End()
	a.Images = append([]string(nil), images...)
}

// remember puts a sent prompt into the history (and its file), unless it's
// the newest already.
func (a *App) remember(text string, images []string) {
	a.histAt, a.draft = -1, nil
	all := a.loadedHistory()
	if n := len(all); n > 0 && all[n-1].text == text && equalStrings(all[n-1].images, images) {
		return
	}
	a.history = append(all, hist{text, append([]string(nil), images...)})
	if len(a.history) > history {
		a.history = a.history[len(a.history)-history:]
	}
	if a.Live {
		appendHistory(text, images)
	}
}

func equalStrings(x, y []string) bool {
	if len(x) != len(y) {
		return false
	}
	for i := range x {
		if x[i] != y[i] {
			return false
		}
	}
	return true
}

// pickAgent makes configuration n (round the list) what ⏎ starts, and
// where o starts next time. The prompt's name says so; no toast.
func (a *App) pickAgent(n int) {
	if a.Editing != nil && a.Editing.Reply != nil {
		a.Say("a reply goes to the agent it answers", false)
		return
	}
	n %= len(a.Agents)
	if n != a.Agent && a.Live {
		config.Remember(a.Agents[n].Name)
	}
	a.Agent = n
}

// nextProfile is ^n: the next Claude profile (round to the main one) is the
// one the claude configurations start on, and where o starts next time.
func (a *App) nextProfile() {
	if a.Editing != nil && a.Editing.Reply != nil {
		a.Say("a reply goes to the agent it answers", false)
		return
	}
	if len(a.Profiles) < 2 {
		a.Say("one Claude profile here (~/.claude) · a ~/.claude-NAME folder Claude Code ran in is another", false)
		return
	}
	a.Profile = (a.Profile + 1) % len(a.Profiles)
	p := a.Profiles[a.Profile]
	if a.Live {
		config.RememberProfile(p.Name)
	}
	usage := ""
	if a.Live {
		if u := p.Usage(); u != "" {
			usage = " · " + u
		}
	}
	only := ""
	if a.Current().Kind != "claude" {
		only = " · for the claude configurations"
	}
	a.Say(fmt.Sprintf("Claude profile %s (%s)%s%s", p.Name, config.Shorten(p.Dir), usage, only), true)
}

// agentOf is which configuration draft d starts: the one it names, else
// the first of its kind. -1 when neither is configured.
func (a *App) agentOf(d drafts.Draft) int {
	if d.Config != "" {
		for i, ag := range a.Agents {
			if ag.Name == d.Config {
				return i
			}
		}
	}
	if d.Kind != "" {
		for i, ag := range a.Agents {
			if ag.Kind == d.Kind {
				return i
			}
		}
	}
	return -1
}

// DraftAgent is the name of the configuration draft d starts, for the list.
func (a *App) DraftAgent(d drafts.Draft) (string, bool) {
	if i := a.agentOf(d); i >= 0 {
		return a.Agents[i].Name, true
	}
	return "", false
}

// focusSent is ⏎ on a send: go to its agent's tab. One still starting is
// gone to as soon as its tab exists (Tick); the latest ⏎ wins.
func (a *App) focusSent(index int) {
	a.focusNext = -1
	if index >= len(a.Sent) {
		return
	}
	s := a.Sent[index]
	switch {
	case s.Outcome == nil:
		a.focusNext = index
		a.Say("focusing its tab as soon as it opens…", true)
		return
	case !s.Outcome.OK || s.Outcome.Target == "":
		a.Say("this send has no agent to focus", false)
		return
	}
	shown := s.Outcome.Msg
	for strings.HasPrefix(shown, "→ ") {
		shown = strings.TrimPrefix(shown, "→ ")
	}
	var err error
	if a.Live {
		err = spawn.Focus(s.Outcome.Target)
	}
	if err != nil {
		a.Say("couldn't focus agent: "+err.Error(), false)
	} else {
		a.Say("focused "+shown, true)
	}
}

// editSent puts a sent prompt back to edit and send to a new agent.
func (a *App) editSent(index int) {
	if index < 0 || index >= len(a.Sent) {
		return
	}
	s := a.Sent[index]
	a.SentAt, a.histAt, a.draft, a.Scroll = -1, -1, nil, 0
	a.show(s.again.text, s.again.images)
	// The stored text already went through preset expansion or literal escaping.
	a.slash.literal = slashHead(s.again.text)
	if s.agent >= 0 && s.agent < len(a.Agents) {
		a.Agent = s.agent
	}
	a.Plan = s.Plan
	message := "back in the prompt · ⏎ starts a new agent with it"
	if s.agent < 0 {
		message += " (not as a reply)"
	}
	a.Say(message, true)
}

// send is ⏎: start the agent with the prompt in a new tab (focus: and go
// there). The prompt empties for the next one; ^z brings this one back.
func (a *App) send(focus bool) {
	if a.localSlash() {
		return
	}
	text := strings.TrimSpace(a.Field.Text)
	if text == "" {
		a.Say("nothing to send yet", false)
		return
	}
	if d, ok := a.current(); ok {
		// A draft: off from its own folder (or to the agent it answers), and it goes.
		images := append([]string(nil), a.Images...)
		if a.dispatch(d, text, images, focus) {
			a.cleared = a.keep()
			a.Field, a.Images = field.New(""), nil
			a.unbind(d.ID)
		}
		return
	}
	if strings.HasPrefix(text, "//") && a.slash.literal == "" {
		text = text[1:]
	}
	body := field.WithImages(text, a.Images)
	prompt := body
	if a.Plan {
		prompt = "/plan " + body
	}
	images := append([]string(nil), a.Images...)
	a.remember(text, images)
	agent := a.launch(a.Current())
	n := len(a.Sent)
	a.Sent = append(a.Sent, Sent{Name: agent.Name, Text: text, Plan: a.Plan, Images: drafts.TaggedImages(text, images), again: hist{text, images}, agent: a.Agent})
	if a.Live {
		spawn.Send(n, agent, prompt, a.Cwd, a.Label, focus, a.sentCh)
	} else {
		// --snapshot: as if it started.
		a.WouldSend = &prompt
		to := "snapshot"
		if focus {
			to = "snapshot (went there)"
		}
		a.sentCh <- spawn.Done{N: n, Out: spawn.Outcome{Msg: "→ tab " + to, OK: true, Target: fmt.Sprintf("snapshot-%d", n)}}
	}
	// A note's name labels the tab it went to, not the ones after.
	a.Label = ""
	a.cleared = a.keep()
	a.Field, a.Images = field.New(""), nil
	a.Scroll = 0
}

// ---- drafts ------------------------------------------------------------------

// scopeOf is this Rex session: its id and name, asked for once.
func (a *App) scopeOf() (string, string) {
	if a.scope == nil {
		if a.Live {
			ws, name := spawn.Space()
			a.scope = &[2]string{ws, name}
		} else {
			a.scope = &[2]string{os.Getenv("REX_SESSION"), ""}
		}
	}
	return a.scope[0], a.scope[1]
}

// reloadDrafts reads this session's drafts from the file, when it changed
// (another local prompt may have written it). --snapshot keeps its own,
// in memory.
func (a *App) reloadDrafts() {
	if !a.Live {
		return
	}
	stamp := drafts.Stamp()
	if !stamp.IsZero() && a.seen(stamp) {
		return
	}
	ws, space := a.scopeOf()
	a.draftsSeen, a.draftsKnown = stamp, !stamp.IsZero()
	a.Drafts = nil
	for _, d := range drafts.Load() {
		if d.Belongs(ws, space) {
			a.Drafts = append(a.Drafts, d)
		}
	}
}

// storeDraft saves d (a new one on top), in the file too unless --snapshot.
func (a *App) storeDraft(d drafts.Draft) bool {
	if a.Live {
		if err := drafts.Put(d); err != nil {
			a.Say("couldn't save the draft: "+err.Error(), false)
			return false
		}
		a.draftsKnown = false
		a.reloadDrafts()
		return true
	}
	for i := range a.Drafts {
		if a.Drafts[i].ID == d.ID {
			a.Drafts[i] = d
			return true
		}
	}
	a.Drafts = append([]drafts.Draft{d}, a.Drafts...)
	return true
}

// dropDrafts takes drafts ids out, in one write.
func (a *App) dropDrafts(ids ...string) bool {
	if a.Live {
		if err := drafts.Remove(ids...); err != nil {
			a.Say("couldn't delete the draft: "+err.Error(), false)
			return false
		}
	}
	out := a.Drafts[:0]
	for _, d := range a.Drafts {
		if !contains(ids, d.ID) {
			out = append(out, d)
		}
	}
	a.Drafts = out
	return true
}

// selectDraft puts the list's selection on draft id (where it was, when
// it's gone).
func (a *App) selectDraft(id string) {
	if a.List < 0 {
		return
	}
	for i, d := range a.Drafts {
		if id != "" && d.ID == id {
			a.List = i
			break
		}
	}
	a.List = min(a.List, max(len(a.Drafts)-1, 0))
}

// current is the draft being written as the prompt has it now: its text,
// images, configuration and plan mode.
func (a *App) current() (drafts.Draft, bool) {
	if a.Editing == nil {
		return drafts.Draft{}, false
	}
	d := a.Editing.Clone()
	// A reply has no agent of its own to start.
	if d.Reply == nil {
		d.Kind, d.Config = a.Current().Kind, a.Current().Name
	}
	d.Text, d.Images, d.Plan = a.Field.Text, append([]string(nil), a.Images...), a.Plan
	return d, true
}

// unsaved: the draft being written has changes not saved yet.
func (a *App) unsaved() bool {
	d, ok := a.current()
	return ok && !d.Equal(*a.Editing)
}

// saveDraft saves the draft being written if it changed; its new images
// copied beside it.
func (a *App) saveDraft() {
	d, ok := a.current()
	if !ok || d.Equal(*a.Editing) {
		return
	}
	if a.Live {
		d.Images = drafts.KeepImages(d.ID, d.Text, d.Images)
		before := a.Images
		a.Images = append([]string(nil), d.Images...)
		a.imagesMoved(before, d.Images)
	}
	// Saved or not, don't try again until it changes again.
	e := d.Clone()
	a.Editing = &e
	a.storeDraft(d)
}

// keepAsDraft is ^s: save the prompt as a draft and leave it for later.
func (a *App) keepAsDraft() {
	d, editing := a.current()
	if strings.TrimSpace(a.Field.Text) == "" {
		if editing {
			a.leaveDraft()
		} else {
			a.Say("nothing written to keep yet", false)
		}
		return
	}
	if !editing {
		a.reloadDrafts()
		ws, space := a.scopeOf()
		d = drafts.Draft{ID: drafts.NewID(), Workspace: ws, Space: space, Cwd: a.Cwd, Text: a.Field.Text, Images: append([]string(nil), a.Images...), Created: drafts.Now(), Kind: a.Current().Kind, Config: a.Current().Name, Plan: a.Plan}
	}
	if a.Live {
		d.Images = drafts.KeepImages(d.ID, d.Text, d.Images)
	}
	if !a.storeDraft(d) {
		return
	}
	a.imagesMoved(a.Images, d.Images)
	a.histAt, a.draft = -1, nil
	a.unbind(d.ID)
	a.Say("saved as a draft · ^g goes through them", true)
}

// openList is ^g: go through this session's drafts.
func (a *App) openList() {
	a.saveDraft()
	a.draftsKnown = false
	a.reloadDrafts()
	if len(a.Drafts) == 0 {
		a.Say("no drafts in this session yet · ^s keeps the prompt as one", false)
		return
	}
	a.List = 0
	if a.Editing != nil {
		for i, d := range a.Drafts {
			if d.ID == a.Editing.ID {
				a.List = i
			}
		}
	}
	a.View = ListView{}
	a.Toast = nil
}

// closeList goes out of the list, back to the prompt as it was.
func (a *App) closeList() {
	a.List = -1
	a.Marked, a.markFrom = nil, nil
	if a.Editing == nil {
		a.restoreAside()
	}
}

// restoreAside brings back the prompt set aside for a draft (when there's one).
func (a *App) restoreAside() {
	if a.aside != nil {
		a.Field, a.Images, a.Agent, a.Plan = a.aside.f, a.aside.images, a.aside.agent, a.aside.plan
		a.slash.literal = a.aside.literal
		a.aside = nil
	}
}

// editDraft writes draft d in the prompt. What was being written there is
// set aside (a draft: saved and left).
func (a *App) editDraft(d drafts.Draft, fromList bool) {
	a.List = -1
	if a.Editing != nil && a.Editing.ID == d.ID {
		return
	}
	if a.Editing != nil {
		if strings.TrimSpace(a.Field.Text) == "" {
			a.dropDrafts(a.Editing.ID)
		} else {
			a.saveDraft()
		}
	} else if a.aside == nil && strings.TrimSpace(a.Field.Text) != "" {
		a.aside = &asideState{*a.keep(), a.Agent, a.Plan}
		a.Field, a.Images = field.New(""), nil
	}
	a.show(d.Text, d.Images)
	if i := a.agentOf(d); i >= 0 {
		a.Agent = i
	}
	a.Plan = d.Plan
	a.histAt, a.draft, a.cleared, a.Scroll = -1, nil, nil, 0
	a.fromList = fromList
	what := "a draft"
	if d.Reply != nil {
		what = "a reply to " + d.Reply.Label
	}
	a.Say(what+": saved as you type · ⏎ sends it · esc keeps it for later", true)
	e := d.Clone()
	a.Editing = &e
}

// leaveDraft is esc (or ^c on an empty prompt) out of a draft: it stays,
// as saved. One left empty goes.
func (a *App) leaveDraft() {
	if a.Editing == nil {
		return
	}
	id := a.Editing.ID
	if strings.TrimSpace(a.Field.Text) == "" {
		if !a.dropDrafts(id) {
			return
		}
		a.Say("dropped the empty draft", true)
	} else {
		a.saveDraft()
		a.Say("kept the draft · ^g goes through them", true)
	}
	a.unbind(id)
}

// unbind: the prompt lets go of draft id (left, or sent): back to the list
// when it was opened from there, else to what was being written before.
func (a *App) unbind(id string) {
	a.Editing = nil
	a.Field, a.Plan, a.Scroll = field.New(""), false, 0
	a.Images = nil
	fromList := a.fromList
	a.fromList = false
	if fromList && len(a.Drafts) > 0 {
		a.List = 0
		a.selectDraft(id)
		a.View = ListView{}
	} else {
		a.restoreAside()
	}
}

// dispatch sends draft d as text and images: to the agent it replies to,
// else to a new agent in its folder; and the draft goes. A reply whose
// agent is gone stays, saying so. True when it went.
func (a *App) dispatch(d drafts.Draft, text string, images []string, focus bool) bool {
	if strings.HasPrefix(text, "//") && (a.Editing == nil || a.Editing.ID != d.ID || a.slash.literal == "") {
		text = text[1:]
	}
	pane, label := "", ""
	if d.Reply != nil {
		pane = d.Reply.Pane
		if a.Live {
			pane = spawn.AgentPane(d.Reply.Pane)
		}
		if pane == "" {
			a.Say("no agent in "+d.Reply.Label+" any more · the reply stays", false)
			return false
		}
		label = d.Reply.Label
	}
	body := field.WithImages(text, images)
	prompt := body
	if d.Plan {
		prompt = "/plan " + body
	}
	if !a.dropDrafts(d.ID) {
		return false
	}
	a.remember(text, images)
	n := len(a.Sent)
	done := func(m string) spawn.Done {
		return spawn.Done{N: n, Out: spawn.Outcome{Msg: "→ " + m, OK: true, Target: fmt.Sprintf("snapshot-%d", n)}}
	}
	if d.Reply != nil {
		a.Sent = append(a.Sent, Sent{Name: "↳" + label, Text: text, Plan: d.Plan, Images: drafts.TaggedImages(text, images), again: hist{text, append([]string(nil), images...)}, agent: -1})
		if a.Live {
			spawn.Reply(n, pane, prompt, a.sentCh)
		} else {
			s := fmt.Sprintf("[to %s %s] %s", label, pane, prompt)
			a.WouldSend = &s
			a.sentCh <- done("pane snapshot")
		}
		return true
	}
	i := max(a.agentOf(d), 0)
	agent := a.launch(a.Agents[i])
	a.Sent = append(a.Sent, Sent{Name: agent.Name, Text: text, Plan: d.Plan, Images: drafts.TaggedImages(text, images), again: hist{text, append([]string(nil), images...)}, agent: i})
	if a.Live {
		spawn.Send(n, agent, prompt, d.Cwd, "", focus, a.sentCh)
	} else {
		a.WouldSend = &prompt
		to := "tab snapshot"
		if focus {
			to = "tab snapshot (went there)"
		}
		a.sentCh <- done(to)
	}
	return true
}

// listKey is a key in the drafts list: al's, and marks: ⇧↑ ⇧↓ (J K) mark as
// they go, space one, a all; with some marked, ⏎ sends them as one prompt
// and x deletes them.
func (a *App) listKey(k tui.Key) Act {
	ctrl, alt, shift := k.Has(tui.ModCtrl), k.Has(tui.ModAlt), k.Has(tui.ModShift)
	sel := a.List
	last := max(len(a.Drafts)-1, 0)
	if len(a.Drafts) == 0 {
		a.closeList()
		return ActNone
	}
	d := a.Drafts[min(sel, last)].Clone()
	// The one being written is as the prompt has it, saved or not yet.
	if c, ok := a.current(); ok && c.ID == d.ID {
		d = c
	}
	run := -1
	switch {
	case k.Code == tui.KeyDown && shift, k.Is('J'):
		run = min(sel+1, last)
	case k.Code == tui.KeyUp && shift, k.Is('K'):
		run = max(sel-1, 0)
	}
	if run >= 0 {
		a.doMarkRun(sel, run)
		return ActNone
	}
	// Any other key ends a run: what it marked stays marked.
	a.markFrom = nil
	marked := len(a.Marked) > 0
	isAny := func(rs ...rune) bool {
		for _, r := range rs {
			if k.Is(r) {
				return true
			}
		}
		return false
	}
	switch {
	// Esc unmarks first, then leaves.
	case k.Code == tui.KeyEsc && marked:
		a.Marked = nil
	case k.Code == tui.KeyEsc || k.Is('q'):
		a.closeList()
	case k.Is(' '):
		i := index(a.Marked, d.ID)
		if i >= 0 {
			a.Marked = append(a.Marked[:i], a.Marked[i+1:]...)
		} else {
			a.Marked = append(a.Marked, d.ID)
		}
	case k.Is('a') && len(a.Marked) == len(a.Drafts):
		a.Marked = nil
	case k.Is('a'):
		a.Marked = nil
		for _, x := range a.Drafts {
			a.Marked = append(a.Marked, x.ID)
		}
	case (k.Code == tui.KeyEnter || k.Is('o')) && marked:
		a.sendMarked(ctrl)
	case isAny('x', ';') && marked:
		a.deleteMarked()
	case isAny('c', 'g', 'd') && ctrl:
		a.closeList()
	// ⌥c: the selected draft's text alone, as the prompt's.
	case k.Is('c') && alt:
		a.copyPlain(d.Text)
	case k.Is('l') && ctrl:
		return ActClearScreen
	case k.Is('n') && ctrl:
		a.List = min(sel+1, last)
	case k.Is('p') && ctrl:
		a.List = max(sel-1, 0)
	case k.Is('j') || k.Code == tui.KeyDown:
		a.List = min(sel+1, last)
	case k.Is('k') || k.Code == tui.KeyUp:
		a.List = max(sel-1, 0)
	case k.Is('g') || k.Code == tui.KeyHome:
		a.List = 0
	case k.Is('G') || k.Code == tui.KeyEnd:
		a.List = last
	// ⏎ sends it (^⏎ or ^o: and goes to its tab), and it goes.
	case k.Code == tui.KeyEnter || k.Is('o'):
		if strings.TrimSpace(d.Text) == "" {
			a.Say("the draft is empty · e writes in it", false)
		} else if a.reviewDraftCommand(d) {
			// Left in the composer for review.
		} else if a.dispatch(d, strings.TrimSpace(d.Text), d.Images, ctrl) {
			a.forget(d.ID)
		}
	case isAny('e', 'l', 'r'):
		a.editDraft(d, true)
	case isAny('x', ';'):
		if a.dropDrafts(d.ID) {
			a.forget(d.ID)
			a.undo = []drafts.Draft{d}
			a.Say("deleted the draft · u brings it back", true)
		}
	case k.Is('u'):
		a.undelete()
	// A new one, empty, to write, on the configuration the prompt is on.
	case k.Is('d'):
		ws, space := a.scopeOf()
		nd := drafts.Draft{ID: drafts.NewID(), Workspace: ws, Space: space, Cwd: a.Cwd, Created: drafts.Now(), Kind: a.Current().Kind, Config: a.Current().Name}
		if a.storeDraft(nd) {
			a.editDraft(nd, true)
		}
	}
	return ActNone
}

func index(list []string, s string) int {
	for i, x := range list {
		if x == s {
			return i
		}
	}
	return -1
}

// doMarkRun is ⇧↑ ⇧↓ from draft sel to to: the drafts from where the run
// started to to marked, on top of what was marked before it (so going back
// over the run unmarks what it marked).
func (a *App) doMarkRun(sel, to int) {
	if a.markFrom == nil {
		a.markFrom = &markRun{sel, append([]string(nil), a.Marked...)}
	}
	from := a.markFrom.from
	marked := append([]string(nil), a.markFrom.marked...)
	lo, hi := min(from, to), max(from, to)
	for i := lo; i <= hi && i < len(a.Drafts); i++ {
		if !contains(marked, a.Drafts[i].ID) {
			marked = append(marked, a.Drafts[i].ID)
		}
	}
	a.Marked = marked
	a.List = to
}

// markedDrafts is the marked drafts, in the list's order (the one being
// written as the prompt has it).
func (a *App) markedDrafts() []drafts.Draft {
	cur, ok := a.current()
	var out []drafts.Draft
	for _, d := range a.Drafts {
		if !contains(a.Marked, d.ID) {
			continue
		}
		if ok && cur.ID == d.ID {
			out = append(out, cur)
		} else {
			out = append(out, d.Clone())
		}
	}
	return out
}

// sendMarked is ⏎ with drafts marked: one alone goes as itself, more as
// one prompt. Empty ones are left out (and left).
func (a *App) sendMarked(focus bool) {
	var ds []drafts.Draft
	for _, d := range a.markedDrafts() {
		if strings.TrimSpace(d.Text) != "" {
			ds = append(ds, d)
		}
	}
	switch {
	case len(ds) == 0:
		a.Say("the marked drafts are empty", false)
	case len(ds) == 1:
		d := ds[0]
		if a.reviewDraftCommand(d) {
			return
		}
		if a.dispatch(d, strings.TrimSpace(d.Text), d.Images, focus) {
			a.Marked = nil
			a.forget(d.ID)
		}
	default:
		for _, d := range ds {
			if a.reviewDraftCommand(d) {
				a.Say("expand this preset before sending the marked drafts", true)
				return
			}
			if d.Reply != nil {
				a.Say("a reply goes to its own agent, not with others · space unmarks it", false)
				return
			}
		}
		a.sendAll(ds, focus)
	}
}

// sendAll sends drafts ds as one prompt to one new agent, in the first
// one's folder and on its configuration, in plan mode when any of them is;
// and they all go.
func (a *App) sendAll(ds []drafts.Draft, focus bool) {
	first := ds[0]
	i := max(a.agentOf(first), 0)
	agent := a.launch(a.Agents[i])
	plan := false
	ids := make([]string, len(ds))
	for i, d := range ds {
		plan = plan || d.Plan
		ids[i] = d.ID
	}
	text, images := drafts.Combine(ds)
	if !a.dropDrafts(ids...) {
		return
	}
	body := field.WithImages(text, images)
	prompt := body
	if plan {
		prompt = "/plan " + body
	}
	// ↑ brings back the whole of it, to send again.
	a.remember(text, images)
	n := len(a.Sent)
	a.Sent = append(a.Sent, Sent{Name: agent.Name, Text: drafts.Summary(ds), Plan: plan, Images: drafts.TaggedImages(text, images), again: hist{text, images}, agent: i})
	if a.Live {
		spawn.Send(n, agent, prompt, first.Cwd, "", focus, a.sentCh)
	} else {
		a.WouldSend = &prompt
		to := "→ tab snapshot"
		if focus {
			to = "→ tab snapshot (went there)"
		}
		a.sentCh <- spawn.Done{N: n, Out: spawn.Outcome{Msg: to, OK: true, Target: fmt.Sprintf("snapshot-%d", n)}}
	}
	a.Marked = nil
	for _, d := range ds {
		a.forget(d.ID)
	}
	a.Say(fmt.Sprintf("sent %d drafts as one prompt to %s", len(ds), agent.Name), true)
}

// deleteMarked is x with drafts marked: they all go (u brings them back).
func (a *App) deleteMarked() {
	ds := a.markedDrafts()
	ids := make([]string, len(ds))
	for i, d := range ds {
		ids[i] = d.ID
	}
	if !a.dropDrafts(ids...) {
		return
	}
	a.Marked = nil
	for _, d := range ds {
		a.forget(d.ID)
	}
	a.undo = ds
	if len(ds) == 1 {
		a.Say("deleted the draft · u brings it back", true)
	} else {
		a.Say(fmt.Sprintf("deleted %d drafts · u brings them back", len(ds)), true)
	}
}

// undelete is u: the drafts x deleted last, back where they were in the list.
func (a *App) undelete() {
	back := a.undo
	a.undo = nil
	if len(back) == 0 {
		a.Say("no deleted draft to bring back", false)
		return
	}
	id := back[0].ID
	// Each goes on top: in reverse, they're back in their order.
	for i := len(back) - 1; i >= 0; i-- {
		if !a.storeDraft(back[i]) {
			return
		}
	}
	a.selectDraft(id)
	if len(back) == 1 {
		a.Say("the draft is back", true)
	} else {
		a.Say(fmt.Sprintf("the %d drafts are back", len(back)), true)
	}
}

// forget: draft id left the list (sent, deleted). The prompt lets go of it
// if it was writing it, and the list closes when it was the last.
func (a *App) forget(id string) {
	if a.Editing != nil && a.Editing.ID == id {
		a.Editing = nil
		a.Field = field.New("")
		a.Images = nil
		a.Plan = false
	}
	a.selectDraft("")
	if len(a.Drafts) == 0 {
		a.closeList()
	}
}

// StartInList is `o -d`: start in the drafts list.
func (a *App) StartInList() { a.openList() }

// UndoLast is the drafts x deleted last (tests).
func (a *App) UndoLast() []drafts.Draft { return a.undo }

func (a *App) ctrlC() Act {
	if text, ok := a.Field.Selected(); ok {
		a.clip(text)
		return ActNone
	}
	if a.Field.Text == "" {
		if a.Editing != nil {
			a.leaveDraft()
			return ActNone
		}
		return ActQuit
	}
	a.clearBox("cleared · ^z brings it back · ^c again quits")
	return ActNone
}

func (a *App) clearBox(msg string) {
	a.cleared = a.keep()
	a.Field, a.Images = field.New(""), nil
	a.Say(msg, true)
}

// cut is ^x: the selection onto the clipboard, and out of the text.
func (a *App) cut() {
	text, ok := a.Field.Selected()
	if !ok {
		return
	}
	a.clip(text)
	a.Field.DeleteSelection()
}

// unclear is ^z: what was cleared or sent, back (and what's there now kept
// for another ^z).
func (a *App) unclear() {
	if a.cleared == nil {
		return
	}
	now := a.keep()
	a.Field, a.Images = a.cleared.f, a.cleared.images
	a.slash.literal = a.cleared.literal
	a.cleared = now
	a.Field.End()
	a.Say("brought it back", true)
}

// copyPlain is ⌥c: text alone onto the clipboard, its `[Image #N]` tags and
// extra spaces and blank lines out.
func (a *App) copyPlain(text string) {
	plain := field.Plain(text)
	switch {
	case plain != "":
		a.clip(plain)
	case len(field.ImageTags(text)) == 0:
		a.Say("nothing to copy", false)
	default:
		a.Say("nothing to copy but images", false)
	}
}

// clip puts text onto the clipboard: pbcopy on the Mac. On Linux, the
// terminal's, with OSC 52, which Rex hands to the client showing this pane
// (so it reaches a Mac's Rex showing an Linux session), and the desktop's,
// with wl-copy, for a client that doesn't take OSC 52.
func (a *App) clip(text string) {
	n := len([]rune(text))
	if !a.Live {
		a.WouldCopy = &text
		return
	}
	ok := false
	if runtime.GOOS == "darwin" {
		c := exec.Command("pbcopy")
		c.Stdin = strings.NewReader(text)
		ok = c.Run() == nil
	} else {
		osc := "\x1b]52;c;" + base64Std(text) + "\x07"
		_, err := os.Stdout.WriteString(osc)
		ok = err == nil
		// wl-copy stays behind to serve the clipboard; it isn't waited for.
		c := field.Desktop(exec.Command("wl-copy"))
		c.Stdin = strings.NewReader(text)
		if c.Start() == nil {
			go c.Wait()
		}
	}
	if !ok {
		a.Say("couldn't copy", false)
		return
	}
	s := "s"
	if n == 1 {
		s = ""
	}
	a.Say(fmt.Sprintf("copied %d char%s", n, s), true)
}

// Attach adds an image as an `[Image #N]` tag.
func (a *App) Attach(path string) {
	a.Images = append(a.Images, path)
	a.Field.InsertWord(fmt.Sprintf("[Image #%d]", len(a.Images)))
}

// pasteImage is ^v: the clipboard's image, as an `[Image #N]` tag.
func (a *App) pasteImage() {
	if p := field.ClipboardImage(); p != "" {
		a.Attach(p)
	} else {
		a.Say("no image on the clipboard", false)
	}
}

// paste is a bracketed paste: the text, whole. Image files dropped in
// become tags, and an empty paste (⌘V with only an image on the clipboard)
// takes the clipboard's image.
func (a *App) paste(s string) {
	s = strings.NewReplacer("\r\n", "\n", "\r", "\n", "\t", "    ").Replace(s)
	if strings.TrimSpace(s) == "" {
		if p := field.ClipboardImage(); p != "" {
			a.Attach(p)
		} else {
			a.Field.Insert(s)
		}
		return
	}
	if files := field.ImagePaths(s); files != nil {
		for _, f := range files {
			a.Attach(f)
		}
		return
	}
	a.Field.Insert(s)
}

// ---- mouse -------------------------------------------------------------------

// mouse is a mouse event, its row counted from the prompt's first line.
func (a *App) mouse(m tui.Mouse) {
	// The drafts list is the keys'.
	if a.List >= 0 {
		return
	}
	// The lines as they are now: keys since the last frame moved them.
	a.Layout(a.Lay.Width, a.Lay.ScreenH)
	t := a.Lay.Text
	onPrompt := m.Y < a.Lay.Height
	switch {
	case m.Kind == tui.ScrollUp && onPrompt:
		a.Scroll = max(a.Scroll-3, 0)
	case m.Kind == tui.ScrollDown && onPrompt:
		a.Scroll = min(a.Scroll+3, max(len(a.Rows)-t.H, 0))
	// (The pictures over a draft's text take no presses.)
	case m.Kind == tui.MouseDown && m.Button == tui.ButtonLeft && onPrompt && m.Y >= t.Y:
		a.pressText(m.X, m.Y, m.Mod&tui.ModShift != 0)
	case m.Kind == tui.MouseDrag && m.Button == tui.ButtonLeft && a.press != nil:
		a.dragText(m.X, m.Y)
	case m.Kind == tui.MouseUp:
		a.press = nil
	}
}

// posAt is the place in the text under cell (x, y); above or below the
// text, the row past its edge when drag (so the text scrolls along).
func (a *App) posAt(x, y int, drag bool) int {
	t := a.Lay.Text
	mx := max(len(a.Rows)-t.H, 0)
	var row int
	switch {
	case y < t.Y:
		if drag {
			a.Scroll = max(a.Scroll-1, 0)
		}
		row = a.Scroll
	case y >= t.Bottom():
		if drag {
			a.Scroll = min(a.Scroll+1, mx)
		}
		row = a.Scroll + t.H - 1
	default:
		row = a.Scroll + (y - t.Y)
	}
	row = min(row, max(len(a.Rows)-1, 0))
	return a.Field.PosAt(a.Rows, row, max(x-t.X, 0))
}

// countPress is how many presses in a row this one makes, on the same cell.
func (a *App) countPress(x, y int) int {
	n := 1
	if p := a.lastPress; p != nil && time.Since(p.at) < multiClick && p.x == x && p.y == y {
		n = p.n%3 + 1
	}
	a.lastPress = &lastPress{time.Now(), x, y, n}
	return n
}

func (a *App) span(at, n int) field.Range {
	switch n {
	case 1:
		return field.Range{Start: at, End: at}
	case 2:
		return a.Field.WordAt(at)
	}
	return a.Field.LineAt(at)
}

// pressText is a press on the prompt, as in a text area: the cursor there,
// a second on the cell its word, a third its line. With shift, the
// selection runs there from the cursor.
func (a *App) pressText(x, y int, shift bool) {
	n := a.countPress(x, y)
	at := a.posAt(x, y, false)
	if shift && n == 1 {
		from := a.Field.Cur
		if a.Field.Anchor >= 0 {
			from = a.Field.Anchor
		}
		a.Field.SelectFrom(from, at)
		a.press = &pressState{field.Range{Start: from, End: from}, 1}
		return
	}
	sp := a.span(at, n)
	a.Field.Select(sp)
	a.press = &pressState{sp, n}
}

// dragText is dragging: the selection from the press to here, by its steps
// (words after a double-click), back from its end when it's above the press.
func (a *App) dragText(x, y int) {
	p := *a.press
	at := a.posAt(x, y, true)
	sp := a.span(at, p.n)
	if at < p.span.Start {
		a.Field.SelectFrom(p.span.End, sp.Start)
	} else {
		a.Field.SelectFrom(p.span.Start, max(sp.End, p.span.End))
	}
}

// ResetPress forgets the last press (tests: a second click isn't a double).
func (a *App) ResetPress() { a.lastPress = nil }

// ---- the history file ----------------------------------------------------------

// historyFile is $XDG_STATE_HOME/o/history.jsonl (else ~/.local/state/o):
// one sent prompt a line, {"images": […], "text": …}, the newest last.
func historyFile() string { return filepath.Join(drafts.StateDir(), "history.jsonl") }

type histJSON struct {
	Images []string `json:"images"`
	Text   string   `json:"text"`
}

func histLine(text string, images []string) []byte {
	if images == nil {
		images = []string{}
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(histJSON{images, text})
	return buf.Bytes()
}

func loadHistory() []hist {
	f, err := os.Open(historyFile())
	if err != nil {
		return nil
	}
	defer f.Close()
	var all []hist
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 16<<20)
	for sc.Scan() {
		var v struct {
			Text   *string `json:"text"`
			Images []any   `json:"images"`
		}
		if json.Unmarshal(sc.Bytes(), &v) != nil || v.Text == nil {
			continue
		}
		h := hist{text: *v.Text}
		for _, p := range v.Images {
			if s, ok := p.(string); ok {
				h.images = append(h.images, s)
			}
		}
		all = append(all, h)
	}
	// Twice as long as it keeps: written again with the newest only.
	if len(all) > 2*history {
		all = all[len(all)-history:]
		var body []byte
		for _, h := range all {
			body = append(body, histLine(h.text, h.images)...)
		}
		_ = os.WriteFile(historyFile(), body, 0o644)
	}
	return all
}

func appendHistory(text string, images []string) {
	path := historyFile()
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(histLine(text, images))
}
