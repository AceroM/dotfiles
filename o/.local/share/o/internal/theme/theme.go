// Package theme is the colors o draws with, so it reads as part of the
// terminal it runs in (the shared rex-theme the other TUIs use).
//
// Inside Rex they are Rex's own: the theme Rex's settings name for the
// current macOS appearance (Workspace.darkThemeID / Workspace.lightThemeID),
// read from the design tokens in Rex's app bundle. o then draws on the
// terminal's own background, with Rex's terminal text and ANSI colors and
// its UI accent, border and selection. Anywhere else, and on Linux (no Rex
// app bundle or macOS preferences): Zed's One Dark on the first *_BG
// variable that is set, #282c34 by default.
//
// TUI_THEME overrides the choice: onedark, rex, or a Rex theme id
// (merino-light).
package theme

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"o/internal/tui"
)

type RGB struct{ R, G, B uint8 }

// ParseRGB reads #e6edf3 or e6edf3.
func ParseRGB(s string) (RGB, bool) {
	s = strings.TrimPrefix(strings.TrimSpace(s), "#")
	if len(s) != 6 {
		return RGB{}, false
	}
	v, err := strconv.ParseUint(s, 16, 32)
	if err != nil {
		return RGB{}, false
	}
	return RGB{uint8(v >> 16), uint8(v >> 8), uint8(v)}, true
}

// Mix is t of the way from c to o.
func (c RGB) Mix(o RGB, t float64) RGB {
	f := func(a, b uint8) uint8 {
		v := math.Round(float64(a) + (float64(b)-float64(a))*t)
		return uint8(math.Max(0, math.Min(255, v)))
	}
	return RGB{f(c.R, o.R), f(c.G, o.G), f(c.B, o.B)}
}

func (c RGB) C() tui.Color { return tui.RGB(c.R, c.G, c.B) }

// Theme is the base colors; o mixes the rest.
type Theme struct {
	Name     string
	Rex      bool
	Light    bool
	Bg       RGB
	Panel    tui.Color
	Fg       RGB
	Bright   RGB
	Muted    RGB
	Dim      RGB
	Border   RGB
	Accent   RGB
	Sel      RGB
	DangerBg RGB
	Green    RGB
	Yellow   RGB
	Red      RGB
	Blue     RGB
}

// Load is the tool's colors: Rex's inside Rex, One Dark on the first set
// bgVars elsewhere.
func Load(bgVars ...string) Theme {
	forced := strings.TrimSpace(os.Getenv("TUI_THEME"))
	if forced != "onedark" && (forced != "" || InRex()) {
		id := ""
		if forced != "rex" {
			id = forced
		}
		t, err := rex(id)
		if err == nil {
			return t
		}
		if forced != "" {
			fmt.Fprintf(os.Stderr, "no Rex theme (%v); using One Dark\n", err)
		}
	}
	bg := RGB{0x28, 0x2c, 0x34}
	for _, k := range bgVars {
		if c, ok := ParseRGB(os.Getenv(k)); ok {
			bg = c
			break
		}
	}
	return OneDark(bg)
}

// InRex: running in a Rex pane.
func InRex() bool { return os.Getenv("TERM_PROGRAM") == "rex" || os.Getenv("REX_BLOCK") != "" }

// OneDark is Zed's One Dark, the shades the tools always used.
func OneDark(bg RGB) Theme {
	fg := RGB{0xab, 0xb2, 0xbf}
	accent := RGB{0x74, 0xad, 0xe8}
	red := RGB{0xe0, 0x6c, 0x75}
	return Theme{
		Name: "one dark", Bg: bg, Panel: bg.Mix(fg, 0.055).C(), Fg: fg,
		Bright: RGB{0xdc, 0xe0, 0xe5}, Muted: bg.Mix(fg, 0.62), Dim: bg.Mix(fg, 0.40),
		Border: bg.Mix(fg, 0.16), Accent: accent, Sel: bg.Mix(accent, 0.24),
		DangerBg: bg.Mix(red, 0.14), Green: RGB{0x98, 0xc3, 0x79}, Yellow: RGB{0xe5, 0xc0, 0x7b},
		Red: red, Blue: RGB{0x61, 0xaf, 0xef},
	}
}

// rex is a Rex theme: the one Rex shows now, or id.
func rex(id string) (Theme, error) {
	if id == "" {
		dark := pref("AppleInterfaceStyle", "") == "Dark"
		key, fallback := "Workspace.lightThemeID", "merino-light"
		if dark {
			key, fallback = "Workspace.darkThemeID", "merino-dark"
		}
		id = pref(key, "com.superlogical.rex")
		if id == "" {
			id = fallback
		}
	}
	path := themesJSON()
	if path == "" {
		return Theme{}, errors.New("Rex's themes.json isn't in /Applications/Rex*.app")
	}
	vars, err := tokens(path, id)
	if err != nil {
		return Theme{}, err
	}
	var bad error
	get := func(k string, over *RGB) RGB {
		c, ok := css(vars, k, over)
		if !ok && bad == nil {
			bad = fmt.Errorf("%s has no %s", id, k)
		}
		return c
	}
	bg := get("--super-term-bg", nil)
	if bad != nil {
		return Theme{}, bad
	}
	tok := func(k string) RGB { return get(k, &bg) }
	term := func(tt, ui string) RGB {
		if c, ok := css(vars, tt, &bg); ok {
			return c
		}
		return tok(ui)
	}
	bright := term("--super-tt-fg", "--super-text")
	appearance, _ := vars["appearance"].(string)
	t := Theme{
		Name: "rex " + id, Rex: true, Light: appearance == "light", Bg: bg, Panel: tui.Reset,
		Fg: bg.Mix(bright, 0.84), Bright: bright,
		Muted: tok("--super-text-secondary"), Dim: tok("--super-text-tertiary"),
		Border: tok("--super-border-strong"), Accent: tok("--super-accent"),
		Sel: tok("--super-accent-container"), DangerBg: tok("--super-danger-container"),
		Green: term("--super-tt-2", "--super-success"), Yellow: term("--super-tt-3", "--super-warning"),
		Red: term("--super-tt-1", "--super-danger"), Blue: term("--super-tt-4", "--super-info"),
	}
	return t, bad
}

// themesJSON is Rex's design tokens: the newest themes.json among the Rex
// apps installed (Rex, Rex Beta, …).
func themesJSON() string {
	home, _ := os.UserHomeDir()
	type found struct {
		mod  int64
		path string
	}
	var all []found
	for _, d := range []string{"/Applications", filepath.Join(home, "Applications")} {
		entries, _ := os.ReadDir(d)
		for _, e := range entries {
			n := e.Name()
			if !strings.HasPrefix(n, "Rex") || !strings.HasSuffix(n, ".app") {
				continue
			}
			p := filepath.Join(d, n, "Contents/Resources/SuperUI_SuperDesignTokens.bundle/Contents/Resources/themes.json")
			if fi, err := os.Stat(p); err == nil {
				all = append(all, found{fi.ModTime().UnixNano(), p})
			}
		}
	}
	if len(all) == 0 {
		return ""
	}
	sort.Slice(all, func(i, j int) bool {
		return all[i].mod < all[j].mod || (all[i].mod == all[j].mod && all[i].path < all[j].path)
	})
	return all[len(all)-1].path
}

// tokens is one theme's CSS variables, plus its appearance. themes.json is
// 2.5 MB, so the theme is cached in ~/Library/Caches/rex-theme, keyed by
// the file's path and modification time.
func tokens(path, id string) (map[string]any, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	key := fmt.Sprintf("%s\n%d", path, fi.ModTime().UnixNano())
	home, _ := os.UserHomeDir()
	cache := ""
	if home != "" {
		cache = filepath.Join(home, "Library/Caches/rex-theme", id+".json")
		var c struct {
			Key  string         `json:"key"`
			Vars map[string]any `json:"vars"`
		}
		if b, err := os.ReadFile(cache); err == nil && json.Unmarshal(b, &c) == nil && c.Key == key && c.Vars != nil {
			return c.Vars, nil
		}
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var themes []map[string]any
	if err := json.Unmarshal(b, &themes); err != nil {
		return nil, err
	}
	for _, t := range themes {
		if t["id"] != id {
			continue
		}
		vars, ok := t["cssVariables"].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("%s has no cssVariables", id)
		}
		vars["appearance"] = t["appearance"]
		if cache != "" {
			body, _ := json.Marshal(map[string]any{"key": key, "vars": vars})
			_ = os.MkdirAll(filepath.Dir(cache), 0o755)
			// Written then renamed, so two tools starting at once never read half a file.
			tmp := fmt.Sprintf("%s.%d.tmp", strings.TrimSuffix(cache, ".json"), os.Getpid())
			if os.WriteFile(tmp, body, 0o644) == nil {
				_ = os.Rename(tmp, cache)
			}
		}
		return vars, nil
	}
	return nil, fmt.Errorf("no Rex theme %s", id)
}

// css reads one CSS variable: `13 17 23`, `rgb(52 133 250)`, `rgb(52 133 250
// / 0.151)` (blended over over), or `#e6edf3`.
func css(vars map[string]any, key string, over *RGB) (RGB, bool) {
	v, _ := vars[key].(string)
	s := strings.TrimSpace(v)
	if s == "" {
		return RGB{}, false
	}
	if strings.HasPrefix(s, "#") {
		return ParseRGB(s)
	}
	inner := s
	if strings.HasPrefix(s, "rgb(") && strings.HasSuffix(s, ")") {
		inner = s[4 : len(s)-1]
	}
	alpha := 1.0
	if c, a, ok := strings.Cut(inner, "/"); ok {
		f, err := strconv.ParseFloat(strings.TrimSpace(a), 64)
		if err != nil {
			return RGB{}, false
		}
		inner, alpha = c, f
	}
	var n []uint8
	for _, f := range strings.Fields(inner) {
		x, err := strconv.ParseUint(f, 10, 8)
		if err == nil {
			n = append(n, uint8(x))
		}
	}
	if len(n) != 3 {
		return RGB{}, false
	}
	c := RGB{n[0], n[1], n[2]}
	if over != nil && alpha < 1 {
		return over.Mix(c, alpha), true
	}
	return c, true
}

// Palette is what o draws in besides the terminal's own text color.
type Palette struct {
	Muted, Dim, Sel, Accent, Green, Red, Yellow tui.Color
}

func NewPalette(t Theme) Palette {
	return Palette{
		Muted: t.Muted.C(), Dim: t.Dim.C(), Sel: t.Sel.C(), Accent: t.Accent.C(),
		Green: t.Green.C(), Red: t.Red.C(), Yellow: t.Yellow.C(),
	}
}
