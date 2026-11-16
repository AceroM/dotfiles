// Command o is a prompt for starting agents in new Rex tabs, with local drafts
// and directory-scoped slash presets. See o --help.
package main

import (
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"runtime/debug"
	"strconv"
	"strings"
	"syscall"
	"time"

	"o/internal/app"
	"o/internal/config"
	"o/internal/drafts"
	"o/internal/field"
	"o/internal/gfx"
	"o/internal/panes"
	"o/internal/probe"
	"o/internal/spawn"
	"o/internal/term"
	"o/internal/theme"
	"o/internal/tui"
	"o/internal/viewer"
)

const help = `o — a ` + "`claude(opus) >`" + ` prompt made to type into fast: ⏎ starts that agent with it in a
new Rex tab, and the prompt empties for the next one. Drawn in place, writing only the
cells a key changes; each send is printed above it.

usage:
  o                    write a prompt
  o NOTE               start from a note: its path and contents, the tab named after it
  o TEXT…              start from TEXT
  o -d, --drafts       start in the drafts list
  o --config           the configurations and the keys to them
  o --images BLOCK     the images behind Rex pane BLOCK's [Image #N] tags, big (⌥⌘N)
  --cwd DIR            where the agents start (default: here)
  -h, --help

Runs inside a Rex terminal. The keys:
  ⏎ sends (to a new tab, in the background) · ^⏎ or ^o sends and goes to the tab
  ⇧⏎ ⌥⏎ ^j newline · ^p plan mode (sends ` + "`/plan …`" + `)
  ↑ on an empty prompt selects a created session · ↑ ↓ choose · ⏎ focus · esc compose
  · e edit: restore its prompt, images, configuration and plan mode, then send to a new agent
  ⇧tab the next configuration (round to the first) · ^1 … ^9 the Nth
  ^n the next Claude profile (account), when there's more than ~/.claude: see below
  ^v pastes the clipboard's image (pngpaste on the Mac, wl-paste on Linux; ⌘V too, with
  only an image on it); a file dragged in is attached. Either is an [Image #N] tag, its
  file listed at the end of what's sent (not drawn).
  ⌥⌘N (Rex) shows them big, each over its tag, in a floating pane in the middle
  of the tab, following the prompt as images come and go (the selected draft's, in the
  list); in a tab o started an agent in, the images it was sent. 1…9 one alone, ← →
  through them, esc closes. o keeps them in ~/.local/state/o/panes, one file a pane.
  The mouse is the terminal's (its own selecting and scrolling); O_MOUSE=1 gives it
  to o: a click puts the cursor there, a drag selects, the wheel scrolls a long prompt.
  Before ` + "`>`" + ` is the configuration ⏎ starts; yellow is plan mode.
  As in a shell: ^l clears the screen (the prompt kept), ↑ on the first row goes back
  through what was sent (↓ forward again), ^a ^e the line's start / end, ^u ^k ^w ⌥d
  delete (^y puts it back), ^b ^f ^h ^d ^t, ⌥← ⌥→ by word; ⌘↑ ⌘↓ (fn↑ fn↓) the text's
  ends; shift (⌥⇧ a word) with the arrows selects
  ^c copies the selection, else clears the prompt (^z brings it back, or what ⏎ sent);
  esc esc clears it too; ^c, ^d or esc on an empty prompt quits
  ⌥c copies the text alone (the selection's, else the prompt's; in ^g's list the
  selected draft's): no [Image #N] tags, spaces run together, a blank line at most
  When an agent exits, its tab is left at a shell in the agent's folder.
Slash presets (for every agent, stored as plain Markdown):
  / opens a filtered picker: ↑ ↓ choose · tab or ⏎ expands · esc closes.
  /review TASK expands .o/commands/review.md, a blank line, then TASK; tab or ⏎
  leaves the full text to edit. A second ⏎ sends. ^z restores the invocation.
  /save NAME PROMPT saves/replaces .o/commands/NAME.md here and clears the input; ⇧⏎ adds lines.
  /edit NAME loads a preset as /save NAME followed by its text; ⏎ saves locally.
  Presets apply to their directory and descendants; the nearest NAME wins.
  Drafts use their own directory. Editing an inherited preset creates a local copy.
  Names: lowercase letters/digits, then also - or _ (64 characters; save/edit reserved).
  Unknown slash commands go to the agent; //name sends literal /name, bypassing o.
  Presets contain text, expand once, and travel with their directory, independent of drafts.
Drafts (local, per Rex session, in ~/.local/state/o/drafts.json):
  ^s keeps the prompt as a draft, saved as you type from then on (the prompt reads ◇);
  esc leaves it for later, ⏎ sends it (from the folder it was written in) and it goes
  ^g goes through this session's drafts: j k move · ⏎ sends (^⏎ ^o and goes there) ·
  e (l, r) edits · x ; deletes · u brings it back · d a new one · esc back to the prompt.
  The selected draft's images show over the list, small (Kitty graphics; O_IMAGES=0 off);
  a draft being written shows its images over its text, all in one row, 8 rows tall.
  ⇧↑ ⇧↓ (J K) mark drafts as they go, space marks one, a all (again: none); with some
  marked, ⏎ sends them as ONE prompt to one new agent: a preamble, then each draft as
  a task (images numbered across them), from the first one's folder on its configuration
  (plan mode if any is); x deletes them all (u brings them back); esc unmarks.
  Drafts and attached images stay on this computer.
Configurations: ~/.config/o/config.toml lists them, in order, as [[agent]] tables:
  kind = "claude"     the command (claude, codex)
  model = "fable"     passed as --model fable; shown as claude(fable)
  args = ["…"]        the agent's own arguments
  name = "…"          shown instead of kind(model)
Without the file: provider pairs, everyday then deeper reasoning:
  ^1 claude(opus)   ^2 claude(fable)   (--dangerously-skip-permissions; --no-chrome on Linux)
  ^3 codex(sol)    Sol 6.1 xhigh      ^4 codex(astra)  Astra 6 max  (--yolo; --no-daemon on the Mac)
o starts on the one picked last (kept in ~/.local/state/o/last-agent), else the first;
$O_AGENT names one instead (O_AGENT=codex). Above the tables, max_width = 100 (the
default) keeps o in the pane's first 100 columns, so the text wraps at about 80 on a
wide pane; 0 uses the whole width.
Claude profiles: ~/.claude, then each ~/.claude-NAME Claude Code has run in (a
.claude.json in it), as ` + "`CLAUDE_CONFIG_DIR=~/.claude-2 claude`" + ` makes one for a second
account. ^n picks the one the claude configurations start on, shown after the name
(claude(opus)·2) and run with its CLAUDE_CONFIG_DIR; the toast says its limits as its
status line last saw them. Kept in ~/.local/state/o/last-profile; $O_PROFILE names one
instead (O_PROFILE=2, O_PROFILE=main). With ~/.claude alone there's nothing to pick.
`

type cli struct {
	cwd      string
	words    []string
	snapshot *[2]int
	cell     *[2]int
	keys     string
	drafts   bool
	config   bool
	images   string
}

func parseCLI(args []string) (cli, error) {
	var c cli
	wh := func(v string) (*[2]int, error) {
		w, h, ok := strings.Cut(v, "x")
		wi, e1 := strconv.Atoi(w)
		hi, e2 := strconv.Atoi(h)
		if !ok || e1 != nil || e2 != nil {
			return nil, errors.New("needs WxH")
		}
		return &[2]int{wi, hi}, nil
	}
	for i := 0; i < len(args); i++ {
		a := args[i]
		next := func(what string) (string, error) {
			if i+1 >= len(args) {
				return "", errors.New(a + " needs " + what)
			}
			i++
			return args[i], nil
		}
		var err error
		switch a {
		case "-h", "--help":
			fmt.Print(help)
			os.Exit(0)
		case "-d", "--drafts":
			c.drafts = true
		case "--config":
			c.config = true
		case "--images":
			c.images, err = next("a Rex block (block:…)")
		case "--cwd":
			c.cwd, err = next("a folder")
		// Hidden: render one frame as plain text after --keys, for UI work
		// without a terminal. Nothing is sent.
		case "--snapshot", "--cell":
			var v string
			if v, err = next("WxH"); err == nil {
				var p *[2]int
				if p, err = wh(v); err == nil {
					if a == "--snapshot" {
						c.snapshot = p
					} else {
						c.cell = p
					}
				}
			}
		case "--keys":
			c.keys, err = next("keys")
		case "--":
			c.words = append(c.words, args[i+1:]...)
			i = len(args)
		default:
			if strings.HasPrefix(a, "-") && len(a) > 1 {
				return c, fmt.Errorf("unknown option %s (o -h)", a)
			}
			c.words = append(c.words, a)
		}
		if err != nil {
			return c, err
		}
	}
	return c, nil
}

// slug is a note's tab label, as the shell's _h_slug: lowercase, runs of
// anything but [a-z0-9] one _, none at the ends, at most 28 characters.
func slug(s string) string {
	var out strings.Builder
	for _, c := range strings.ToLower(s) {
		if c < 128 && (c >= 'a' && c <= 'z' || c >= '0' && c <= '9') {
			out.WriteRune(c)
		} else if !strings.HasSuffix(out.String(), "_") {
			out.WriteByte('_')
		}
	}
	r := []rune(strings.Trim(out.String(), "_"))
	if len(r) > 28 {
		r = r[:28]
	}
	return strings.TrimRight(string(r), "_")
}

// startText is what the box starts with, and the first tab's label: a
// note's path and contents (and its name), or the words as they are.
func startText(words []string) (string, string, error) {
	if len(words) == 1 {
		if fi, err := os.Stat(words[0]); err == nil && fi.Mode().IsRegular() {
			abs, err := filepath.Abs(words[0])
			if err == nil {
				abs, err = filepath.EvalSymlinks(abs)
			}
			if err != nil {
				return "", "", fmt.Errorf("%s: %w", words[0], err)
			}
			body, err := os.ReadFile(abs)
			if err != nil {
				return "", "", fmt.Errorf("%s: %w", words[0], err)
			}
			label := slug(strings.TrimSuffix(filepath.Base(abs), filepath.Ext(abs)))
			return fmt.Sprintf("Source Obsidian note: %s\n\n%s", abs, strings.TrimRight(string(body), " \t\r\n")), label, nil
		}
	}
	return strings.Join(words, " "), "", nil
}

func main() { os.Exit(run()) }

func run() int {
	if len(os.Args) > 1 && os.Args[1] == spawn.ChildFlag {
		return spawn.Child(os.Args[2:])
	}
	c, err := parseCLI(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, "o:", err)
		return 2
	}
	cfg, notice := config.Load()
	if c.images != "" {
		return viewer.Run(c.images, theme.NewPalette(theme.Load("O_BG", "AL_BG", "JV_BG")))
	}
	profiles := config.Profiles()
	if c.config {
		return showConfig(cfg, profiles, notice)
	}
	text, label, err := startText(c.words)
	if err != nil {
		fmt.Fprintln(os.Stderr, "o:", err)
		return 1
	}
	cwd := c.cwd
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	if abs, err := filepath.Abs(cwd); err == nil {
		cwd = abs
	}
	if real, err := filepath.EvalSymlinks(cwd); err == nil {
		cwd = real
	}
	start, _ := config.Start(cfg.Agents)
	profile, _ := config.StartProfile(profiles)
	a := app.New(theme.NewPalette(theme.Load("O_BG", "AL_BG", "JV_BG")), app.Opts{
		Cwd: cwd, Text: text, Label: label, Agents: cfg.Agents, Start: start,
		Profiles: profiles, Profile: profile, Notice: notice, MaxWidth: cfg.MaxWidth,
	})
	if c.snapshot != nil {
		if c.cell != nil {
			a.Gfx = &gfx.Gfx{CellW: c.cell[0], CellH: c.cell[1]}
		}
		return snapshot(a, c.snapshot[0], c.snapshot[1], c.keys)
	}
	if !spawn.InRex() {
		fmt.Fprintln(os.Stderr, "o: not inside a Rex terminal (REX_SESSION isn't set)")
		return 1
	}
	go func() {
		drafts.Sweep()
		panes.Sweep()
	}()
	a.Block = os.Getenv("REX_BLOCK")
	if c.drafts {
		a.StartInList()
	}
	err = loop(a)
	if err != nil {
		fmt.Fprintln(os.Stderr, "o:", err)
		return 1
	}
	return 0
}

// showConfig is o --config: where the configurations come from, and each
// one's key, name and command; then the Claude profiles.
func showConfig(cfg config.Config, profiles []config.Profile, notice string) int {
	path := config.Shorten(config.File())
	switch {
	case notice != "":
		fmt.Println(notice + "\n")
	case fileExists(config.File()):
		fmt.Println(path + "\n")
	default:
		fmt.Println(path + " isn't there: the defaults\n")
	}
	start, why := config.Start(cfg.Agents)
	whyS := map[config.Why]string{config.WhyEnv: " ($O_AGENT)", config.WhyLast: " (picked last)"}[why]
	w := 0
	for _, a := range cfg.Agents {
		w = max(w, field.StrWidth(a.Name))
	}
	for i, a := range cfg.Agents {
		key := "  "
		if i < 9 {
			key = fmt.Sprintf("^%d", i+1)
		}
		first := ""
		if i == start {
			first = " ← o starts here" + whyS
		}
		fmt.Printf("  %s  %s%s  %s%s\n", key, a.Name, strings.Repeat(" ", w-field.StrWidth(a.Name)), a.Command(), first)
	}
	fmt.Println("\n⇧tab goes to the next one.")
	if cfg.MaxWidth == 0 {
		fmt.Println("o draws across the whole pane (max_width = 0).")
	} else {
		fmt.Printf("o draws in at most %d columns (max_width).\n", cfg.MaxWidth)
	}
	showProfiles(profiles)
	fmt.Println("\nDrafts are stored locally in " + config.Shorten(drafts.File()) + ".")
	if notice != "" {
		return 1
	}
	return 0
}

func fileExists(p string) bool { fi, err := os.Stat(p); return err == nil && !fi.IsDir() }

func showProfiles(profiles []config.Profile) {
	if len(profiles) < 2 {
		fmt.Println("\nOne Claude profile here, ~/.claude. A ~/.claude-NAME folder Claude Code has run in")
		fmt.Println("(CLAUDE_CONFIG_DIR=~/.claude-NAME claude) is another, for ^n.")
		return
	}
	fmt.Print("\nClaude profiles, for the claude configurations (CLAUDE_CONFIG_DIR):\n\n")
	start, why := config.StartProfile(profiles)
	whyS := map[config.Why]string{config.WhyEnv: " ($O_PROFILE)", config.WhyLast: " (picked last)"}[why]
	w, wd := 0, 0
	for _, p := range profiles {
		w, wd = max(w, field.StrWidth(p.Name)), max(wd, field.StrWidth(config.Shorten(p.Dir)))
	}
	for i, p := range profiles {
		dir := config.Shorten(p.Dir)
		first := ""
		if i == start {
			first = "  ← o starts here" + whyS
		}
		fmt.Printf("  %s%s  %s%s  %s%s\n", p.Name, strings.Repeat(" ", w-field.StrWidth(p.Name)), dir, strings.Repeat(" ", wd-field.StrWidth(dir)), p.Usage(), first)
	}
	fmt.Println("\n^n goes to the next one.")
}

// ---- the terminal --------------------------------------------------------------

// modes turns on (or off again) bracketed paste (a pasted newline mustn't
// send the prompt); where the terminal has it, the kitty keyboard
// protocol's first level, so shift+Enter and ^⏎ arrive as themselves; and
// with O_MOUSE=1, mouse buttons and drags.
func modes(on, kitty, mouse bool) {
	var s string
	if on {
		s = "\x1b[?2004h"
		if mouse {
			s += "\x1b[?1000h\x1b[?1002h\x1b[?1006h"
		}
		if kitty {
			s += "\x1b[>1u"
		}
	} else {
		if kitty {
			s += "\x1b[<1u"
		}
		if mouse {
			s += "\x1b[?1006l\x1b[?1002l\x1b[?1000l"
		}
		s += "\x1b[?2004l"
	}
	os.Stdout.WriteString(s)
}

func loop(a *app.App) (err error) {
	tty, err := tui.OpenTty()
	if err != nil {
		return err
	}
	if err := tty.Raw(); err != nil {
		return err
	}
	in := tui.NewInput(tty)
	// Before anything else reads input: the answers come back on it.
	pr := probe.Run(in)
	a.Gfx = pr.Gfx
	mouse := false
	switch os.Getenv("O_MOUSE") {
	case "1", "on", "yes", "true":
		mouse = true
	}
	modes(true, pr.KittyKeys, mouse)
	w, h, _, _, e := tui.Size()
	if e != nil {
		w, h = 80, 24
	}
	cx, cy := pr.CursorX, pr.CursorY
	if !pr.HasCursor {
		if x, y, ok := in.CursorPosition(300 * time.Millisecond); ok {
			cx, cy = x, y
		}
	}
	t := term.New(w, h, cx, cy)
	restore := func() {
		a.Flush()
		a.Unpublish()
		var s []byte
		t.Clear(&s)
		s = append(s, a.ClearImages()...)
		os.Stdout.Write(s)
		modes(false, pr.KittyKeys, mouse)
		tty.Restore()
	}
	// A panic leaves the terminal as it found it, then says what happened.
	defer func() {
		if r := recover(); r != nil {
			modes(false, true, true)
			os.Stdout.WriteString("\x1b[0m\x1b[?25h\r\n")
			tty.Restore()
			fmt.Fprintf(os.Stderr, "o: %v\n%s", r, debug.Stack())
			err = fmt.Errorf("%v", r)
		}
	}()
	// Closed or killed: the draft saved and the terminal back, as on quit.
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGHUP)
	err = eventLoop(a, in, t, sigs)
	restore()
	return err
}

func eventLoop(a *app.App, in *tui.Input, t *term.Inline, sigs chan os.Signal) error {
	dirty := true
	for {
		select {
		case <-sigs:
			return nil
		default:
		}
		if a.Tick() {
			dirty = true
		}
		// The image viewer's images: the prompt's as they are now.
		a.Publish()
		done := a.TakeDone()
		if dirty || len(done) > 0 {
			// What started printed above (the prompt drawn again under it, all
			// landing at once), then only what changed in the prompt.
			var s []byte
			printed := len(done) > 0
			if printed {
				s = append(s, "\x1b[?2026h"...)
			}
			for _, n := range done {
				t.PrintAbove(&s, app.Entry(a, &a.Sent[n], t.Width))
			}
			a.Layout(t.Width, t.Rows)
			// Images the frame draws go to the terminal first.
			s = append(s, a.TakeGfx()...)
			t.Draw(&s, app.Draw(a), a.CursorCell())
			if printed {
				s = append(s, "\x1b[?2026l"...)
			}
			if len(s) > 0 {
				if _, err := os.Stdout.Write(s); err != nil {
					return err
				}
			}
			dirty = false
		}
		// Keys wake it at once; the wait only paces what changes on its own.
		ev, ok := in.Next(a.Wait())
		if !ok {
			if a.Idle() {
				dirty = true
			}
			continue
		}
		// Drain everything queued (a paste's worth of keys, fast scrolling)
		// before redrawing.
		for ok {
			switch e := ev.(type) {
			case tui.Resize:
				var s []byte
				t.Resize(&s, e.W, e.H, func() (int, int, bool) { return in.CursorPosition(300 * time.Millisecond) })
				os.Stdout.Write(s)
			case tui.Mouse:
				// Rows counted from the prompt's first line. Above it is the
				// scrollback: only a drag from the prompt reaches there.
				if e.Y < t.Top && e.Kind != tui.MouseDrag && e.Kind != tui.MouseUp {
					break
				}
				e.Y = max(e.Y-t.Top, 0)
				a.Handle(e)
			case tui.CursorPos:
			default:
				switch a.Handle(ev) {
				case app.ActQuit:
					return nil
				case app.ActClearScreen:
					var s []byte
					t.ClearScreen(&s)
					os.Stdout.Write(s)
				}
			}
			dirty = true
			ev, ok = in.Next(0)
		}
	}
}

// ---- --snapshot ----------------------------------------------------------------

// snapshot is o --snapshot WxH [--keys …]: play keys on a WxH terminal,
// then print what o would have printed above the prompt and the prompt
// itself, as plain text. Nothing is sent: a send counts as started, and
// what it would have sent goes to stderr, with where the terminal's cursor
// would be.
func snapshot(a *app.App, w, h int, keys string) int {
	a.Live = false
	a.Layout(w, h)
	var above []string
keys:
	for _, ev := range parseKeys(keys) {
		switch a.Handle(ev) {
		case app.ActQuit:
			fmt.Fprintln(os.Stderr, "quit")
			break keys
		case app.ActClearScreen:
			above = nil
		}
		a.Tick()
		for _, n := range a.TakeDone() {
			b := app.Entry(a, &a.Sent[n], w)
			for y := 0; y < b.Area.H; y++ {
				above = append(above, term.Plain(b, y))
			}
		}
		a.Layout(w, h)
	}
	if a.WouldSend != nil {
		fmt.Fprintf(os.Stderr, "sent: %q\n", *a.WouldSend)
	}
	if a.WouldCopy != nil {
		fmt.Fprintf(os.Stderr, "copied: %q\n", *a.WouldCopy)
	}
	if c := a.CursorCell(); c != nil {
		fmt.Fprintf(os.Stderr, "cursor: %d,%d\n", c[0], c[1])
	}
	b := app.Draw(a)
	for _, l := range above {
		fmt.Println(l)
	}
	for y := 0; y < b.Area.H; y++ {
		fmt.Println(term.Plain(b, y))
	}
	return 0
}

// mouseTok is `<P40,5>`: press the left button at column 40, row 5 (0-based
// cells, rows from the prompt's first line); D drags there, R releases,
// W/w wheel up/down.
func mouseTok(t string) (tui.Event, bool) {
	if t == "" {
		return nil, false
	}
	kinds := map[byte]tui.MouseKind{'P': tui.MouseDown, 'D': tui.MouseDrag, 'R': tui.MouseUp, 'W': tui.ScrollUp, 'w': tui.ScrollDown}
	k, ok := kinds[t[0]]
	if !ok {
		return nil, false
	}
	xs, ys, ok := strings.Cut(t[1:], ",")
	x, e1 := strconv.Atoi(xs)
	y, e2 := strconv.Atoi(ys)
	if !ok || e1 != nil || e2 != nil {
		return nil, false
	}
	return tui.Mouse{Kind: k, Button: tui.ButtonLeft, X: x, Y: y}, true
}

// parseKeys reads `abc<S-CR><C-p><BackTab>` style key sequences
// (modifiers stack: <M-S-Left>), plus mouse tokens and <paste:text>.
func parseKeys(s string) []tui.Event {
	var out []tui.Event
	rs := []rune(s)
	for i := 0; i < len(rs); i++ {
		c := rs[i]
		if c != '<' {
			out = append(out, tui.Ch(c))
			continue
		}
		j := i + 1
		for j < len(rs) && rs[j] != '>' {
			j++
		}
		tok := string(rs[i+1 : min(j, len(rs))])
		i = j
		if ev, ok := mouseTok(tok); ok {
			out = append(out, ev)
			continue
		}
		if text, ok := strings.CutPrefix(tok, "paste:"); ok {
			out = append(out, tui.Paste(strings.ReplaceAll(text, `\n`, "\n")))
			continue
		}
		// Modifiers first, vim's way: C- ctrl, M- alt, S- shift, D- super (⌘).
		name, mods := tok, tui.Mod(0)
		for len(name) > 2 && name[1] == '-' {
			m, ok := map[byte]tui.Mod{'C': tui.ModCtrl, 'M': tui.ModAlt, 'S': tui.ModShift, 'D': tui.ModSuper}[name[0]]
			if !ok {
				break
			}
			mods |= m
			name = name[2:]
		}
		codes := map[string]tui.KeyCode{"CR": tui.KeyEnter, "Enter": tui.KeyEnter, "Esc": tui.KeyEsc, "Tab": tui.KeyTab, "BackTab": tui.KeyBackTab,
			"PgUp": tui.KeyPageUp, "PgDn": tui.KeyPageDown, "BS": tui.KeyBackspace, "Del": tui.KeyDelete, "Down": tui.KeyDown, "Up": tui.KeyUp,
			"Left": tui.KeyLeft, "Right": tui.KeyRight, "Home": tui.KeyHome, "End": tui.KeyEnd}
		k := tui.Key{Mod: mods}
		switch {
		case codes[name] != 0:
			k.Code = codes[name]
		case name == "Space":
			k.Rune = ' '
		case name == "lt":
			k.Rune = '<'
		case len([]rune(name)) == 1 && mods != 0:
			k.Rune = []rune(name)[0]
		default:
			continue
		}
		out = append(out, k)
	}
	return out
}
