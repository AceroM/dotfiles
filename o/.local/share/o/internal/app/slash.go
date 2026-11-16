package app

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"o/internal/drafts"
	"o/internal/field"
	"o/internal/prompts"
	"o/internal/tui"
)

type slashItem struct {
	name, summary string
	command       *prompts.Command
}

type slashState struct {
	cwd, query, literal     string
	commands                []prompts.Command
	err                     error
	loaded                  time.Time
	items                   []slashItem
	at, top, shown, height  int
	hidden, active, editing bool
	hint                    string
}

func slashHead(text string) string {
	if !strings.HasPrefix(text, "/") {
		return ""
	}
	if i := strings.IndexFunc(text, unicode.IsSpace); i >= 0 {
		return text[:i]
	}
	return text
}

func (a *App) promptCwd() string {
	if a.Editing != nil && a.Editing.Cwd != "" {
		return a.Editing.Cwd
	}
	return a.Cwd
}

func (a *App) loadCommands(force bool) {
	s := &a.slash
	cwd := a.promptCwd()
	if force || s.cwd != cwd || time.Since(s.loaded) > time.Second {
		s.commands, s.err = prompts.Load(cwd)
		s.cwd, s.loaded = cwd, time.Now()
	}
}

// refreshSlash prepares the menu independently of terminal size. It only opens
// at the first token, keeping multiline editing and the history keys familiar.
func (a *App) refreshSlash() {
	s := &a.slash
	name, rest, ok := prompts.Split(a.Field.Text)
	if slashHead(a.Field.Text) != s.literal {
		s.literal = ""
	}
	s.items, s.hint, s.active, s.editing = nil, "", false, false
	if !ok || s.literal != "" || a.List >= 0 || a.SentAt >= 0 {
		s.query = ""
		return
	}
	if name == "save" && strings.ContainsAny(a.Field.Text, " \t\n") {
		s.hint = "⏎ save locally · ⇧⏎ newline · /save NAME PROMPT · replaces local NAME"
		return
	}
	query := name
	if name == "edit" && strings.ContainsAny(a.Field.Text, " \t") {
		if strings.ContainsAny(rest, " \t\n") {
			return
		}
		query, s.editing = rest, true
	} else if rest != "" || strings.ContainsAny(a.Field.Text, " \t\n") {
		return
	}
	if a.Field.HasSelection() || a.Field.Cur != len(a.Field.Text) {
		return
	}
	a.loadCommands(false)
	key := fmt.Sprintf("%s:%t:%s", s.cwd, s.editing, query)
	if s.query != key {
		s.at, s.top, s.hidden = 0, 0, false
		s.query = key
	}
	if s.hidden {
		return
	}
	s.active = true
	for i := range s.commands {
		c := &s.commands[i]
		if !strings.HasPrefix(c.Name, query) {
			continue
		}
		summary := field.FirstLine(c.Body)
		if c.Err != nil {
			summary = "couldn't read: " + c.Err.Error()
		}
		s.items = append(s.items, slashItem{c.Name, summary, c})
	}
	if !s.editing {
		for _, item := range []slashItem{
			{name: "save", summary: "save a preset here: /save NAME PROMPT"},
			{name: "edit", summary: "edit a preset: /edit NAME"},
		} {
			if strings.HasPrefix(item.name, query) {
				s.items = append(s.items, item)
			}
		}
	}
	s.at = min(s.at, max(len(s.items)-1, 0))
	if len(s.items) == 0 {
		s.hint = "no saved command · ⏎ passes through to agent · //name sends literal /name"
		if s.editing {
			s.hint = "no matching preset · esc closes"
		}
		if s.err != nil {
			s.hint = "couldn't list presets: " + s.err.Error()
		}
	} else {
		s.hint = "↑ ↓ choose · tab / ⏎ expand · esc close · //name sends literal /name"
		if s.editing {
			s.hint = "↑ ↓ choose · tab / ⏎ edit locally · esc close"
		}
		if len(s.items) > 5 {
			s.hint = fmt.Sprintf("%d/%d · %s", s.at+1, len(s.items), s.hint)
		}
	}
}

func (a *App) slashKey(k tui.Key) bool {
	a.refreshSlash()
	s := &a.slash
	if k.Mod != 0 {
		return false
	}
	if !s.active {
		// A fully typed invocation can carry its task before expansion.
		if k.Code == tui.KeyTab {
			name, rest, ok := prompts.Split(a.Field.Text)
			if ok && rest != "" && name != "save" && name != "edit" && s.literal == "" {
				a.loadCommands(true)
				for _, c := range s.commands {
					if c.Name == name {
						a.expandCommand(c, rest)
						return true
					}
				}
			}
		}
		return false
	}
	switch k.Code {
	case tui.KeyEsc:
		s.hidden, s.active, s.hint = true, false, ""
		return true
	case tui.KeyUp, tui.KeyDown:
		if len(s.items) == 0 {
			return true
		}
		dir := 1
		if k.Code == tui.KeyUp {
			dir = -1
		}
		s.at = (s.at + dir + len(s.items)) % len(s.items)
		return true
	case tui.KeyTab, tui.KeyEnter:
		if len(s.items) == 0 {
			return k.Code == tui.KeyTab
		}
		item := s.items[s.at]
		if item.command != nil {
			if s.editing {
				a.editCommand(item.name)
			} else {
				a.expandCommand(*item.command, "")
			}
		} else {
			a.show("/"+item.name+" ", a.Images)
			a.Say("/"+item.name+" NAME"+map[string]string{"save": " PROMPT · ⇧⏎ for newline · ⏎ saves", "edit": " · ⏎ loads it for editing"}[item.name], true)
		}
		return true
	}
	return false
}

func (a *App) expandCommand(c prompts.Command, rest string) {
	// Read again on acceptance, so a file changed outside o is current.
	a.loadCommands(true)
	found := false
	for _, fresh := range a.slash.commands {
		if fresh.Name == c.Name {
			c = fresh
			found = true
			break
		}
	}
	if !found {
		a.Say("/"+c.Name+" was removed · type / to refresh", false)
		return
	}
	if c.Err != nil {
		a.Say("/"+c.Name+": "+c.Err.Error(), false)
		return
	}
	a.cleared = a.keep()
	a.show(c.Expand(rest), a.Images)
	// A template may itself begin /plan or another slash. It expands once.
	a.slash.literal = slashHead(a.Field.Text)
	a.Say("expanded /"+c.Name+" · edit, then ⏎ sends · ^z restores", true)
}

func (a *App) editCommand(name string) {
	a.loadCommands(true)
	for _, c := range a.slash.commands {
		if c.Name != name {
			continue
		}
		if c.Err != nil {
			a.Say("/"+name+": "+c.Err.Error(), false)
			return
		}
		a.cleared = a.keep()
		a.show("/save "+name+"\n"+c.Body, a.Images)
		a.Say("editing /"+name+" · ⏎ saves in "+filepath.Join(prompts.Dir(a.promptCwd()), name+".md"), true)
		return
	}
	a.Say("no saved /"+name+" in this directory", false)
}

// localSlash runs before every compose send, including ^Enter and ^o. It never
// starts an agent: expansions remain visible and editable for a second Enter.
func (a *App) localSlash() bool {
	name, rest, ok := prompts.Split(a.Field.Text)
	if !ok || a.slash.literal != "" {
		return false
	}
	switch name {
	case "save":
		parts := strings.Fields(rest)
		if len(parts) < 2 {
			a.Say("/save NAME PROMPT · ⇧⏎ for newline · ⏎ saves locally", false)
			return true
		}
		preset := parts[0]
		body := strings.TrimSpace(rest[len(preset):])
		if !prompts.ValidName(preset) {
			a.Say("name: lowercase letters, digits, - or _ (save and edit reserved)", false)
			return true
		}
		if len(field.ImageTags(body)) > 0 {
			a.Say("presets save text only · remove image tags first", false)
			return true
		}
		path := filepath.Join(prompts.Dir(a.promptCwd()), preset+".md")
		if a.Live {
			var err error
			path, err = prompts.Save(a.promptCwd(), preset, body)
			if err != nil {
				a.Say("couldn't save /"+preset+": "+err.Error(), false)
				return true
			}
		}
		a.cleared = a.keep()
		a.show("", nil)
		a.Scroll = 0
		a.slash.loaded = time.Time{}
		verb := "saved /"
		if !a.Live {
			verb = "would save /"
		}
		a.Say(verb+preset+" · "+path, true)
		return true
	case "edit":
		if !prompts.ValidName(rest) {
			a.Say("/edit NAME · load a preset, change it, ⏎ saves locally", false)
		} else {
			a.editCommand(rest)
		}
		return true
	}
	a.loadCommands(true)
	for _, c := range a.slash.commands {
		if c.Name == name {
			a.expandCommand(c, rest)
			return true
		}
	}
	return false
}

// Draft list sends first open a local invocation in the composer, so a preset
// can be reviewed before any draft is removed or any agent starts.
func (a *App) reviewDraftCommand(d drafts.Draft) bool {
	name, _, ok := prompts.Split(d.Text)
	if !ok {
		return false
	}
	local := name == "save" || name == "edit"
	commands, _ := prompts.Load(d.Cwd)
	for _, c := range commands {
		local = local || name == c.Name
	}
	if !local {
		return false
	}
	a.editDraft(d, true)
	a.localSlash()
	return true
}

func (a *App) layoutSlash(room int) int {
	a.refreshSlash()
	s := &a.slash
	s.height, s.shown = 0, 0
	if s.hint == "" || room < 2 {
		return 0
	}
	s.height = 1
	if !s.active || len(s.items) == 0 {
		return 1
	}
	s.shown = min(len(s.items), 5, max(room-2, 0))
	if s.shown == 0 {
		return 1
	}
	s.top = min(s.top, len(s.items)-s.shown)
	if s.at < s.top {
		s.top = s.at
	} else if s.at >= s.top+s.shown {
		s.top = s.at + 1 - s.shown
	}
	s.height += s.shown
	if room >= s.height+3 {
		s.height += 2
	} // source and preview
	return s.height
}

func (a *App) drawSlash(buf *tui.Buffer, y int) int {
	s := &a.slash
	if s.height == 0 {
		return y
	}
	mx, start := buf.Area.W, y
	for i := s.top; i < len(s.items) && i < s.top+s.shown; i++ {
		item := s.items[i]
		st := fg(a.Pal.Muted)
		if i == s.at {
			st = tui.NewStyle()
			put(buf, 0, y, mx, "▸", fg(a.Pal.Accent))
			for x := 2; x < mx; x++ {
				buf.At(x, y).Bg = a.Pal.Sel
			}
		}
		x := put(buf, 2, y, mx, "/"+item.name, st)
		put(buf, x+2, y, mx, truncate(item.summary, max(mx-x-2, 0)), fg(a.Pal.Dim))
		y++
	}
	if s.height >= s.shown+3 && s.shown > 0 {
		item := s.items[s.at]
		source, preview := "o · directory presets", "⇧⏎ adds lines · ⏎ saves .o/commands/NAME.md here"
		if item.name == "edit" {
			preview = "Inherited presets become local overrides when saved."
		}
		if item.command != nil {
			source = item.command.Path
			cwd := a.promptCwd()
			if real, err := filepath.EvalSymlinks(cwd); err == nil {
				cwd = real
			}
			if rel, err := filepath.Rel(cwd, source); err == nil {
				source = rel
			}
			preview = strings.Join(strings.Fields(item.command.Body), " ")
		}
		put(buf, 2, y, mx, truncate(source, max(mx-2, 0)), fg(a.Pal.Accent))
		put(buf, 2, y+1, mx, truncate(preview, max(mx-2, 0)), fg(a.Pal.Muted))
		y += 2
	}
	put(buf, 2, y, mx, truncate(s.hint, max(mx-2, 0)), fg(a.Pal.Dim))
	return start + s.height
}
