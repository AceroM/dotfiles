// Package config is o's configurations: the agents ⏎ can start, each named
// as the prompt shows it (`claude(opus) >`). They're listed, in order, in
//
//	$XDG_CONFIG_HOME/o/config.toml    (else ~/.config/o/config.toml)
//
// as [[agent]] tables: kind is the command (claude, codex); model goes
// to it as --model MODEL and into its name; args are its own arguments;
// name is shown instead of kind(model). ⇧tab goes to the next one, ^1…^9
// straight to the Nth, and o remembers the one picked last, for the next
// time it starts:
//
//	$XDG_STATE_HOME/o/last-agent    (else ~/.local/state/o), its name
//
// $O_AGENT, when set, names the one to start on instead. Without the
// config file, Defaults().
//
// max_width, at the top, is the most columns o draws in (the
// `claude(opus) > ` included): DefaultMaxWidth when it's left out, 0 for
// the pane's whole width.
//
// Apart from them, the Claude profile: which Claude Code config folder, so
// which account, the claude configurations start on. o finds this
// computer's own; with only ~/.claude there's nothing to pick.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/BurntSushi/toml"
)

// DefaultMaxWidth is the columns o draws in at most, without max_width:
// the text wraps at about 80, after `claude(opus) > `.
const DefaultMaxWidth = 100

// minMaxWidth: a max_width under this (but not 0) is refused: the prompt's
// name and the list's keys need the room.
const minMaxWidth = 40

// Config is what the config file says.
type Config struct {
	Agents []Agent
	// MaxWidth is the most columns o draws in; 0: the terminal's width.
	MaxWidth int
}

func Default() Config {
	return Config{Agents: Defaults(), MaxWidth: DefaultMaxWidth}
}

type Agent struct {
	// Name is what the prompt shows: name, else kind(model), else kind.
	Name string
	// Kind is the command: claude, codex.
	Kind string
	// Args are the agent's own arguments, --model MODEL last when there's a model.
	Args []string
	// Env is set for its process alone: a Claude profile's CLAUDE_CONFIG_DIR (On).
	Env [][2]string
}

func newAgent(kind, model string, args []string, name string) Agent {
	a := Agent{Kind: kind, Args: append([]string(nil), args...)}
	if model != "" {
		a.Args = append(a.Args, "--model", model)
	}
	switch {
	case name != "":
		a.Name = name
	case model != "":
		a.Name = kind + "(" + model + ")"
	default:
		a.Name = kind
	}
	return a
}

// On is this configuration on Claude profile p: a claude one gets the
// profile's CLAUDE_CONFIG_DIR, and its name after its own (claude(opus)·2).
// On the main profile, and for other kinds, it's as it is.
func (a Agent) On(p *Profile) Agent {
	out := a
	out.Args = append([]string(nil), a.Args...)
	out.Env = append([][2]string(nil), a.Env...)
	if p != nil && !p.IsMain() && a.Kind == "claude" {
		out.Name = a.Name + "·" + p.Name
		out.Env = append(out.Env, [2]string{"CLAUDE_CONFIG_DIR", p.Dir})
	}
	return out
}

// Argv is what runs: `env K=V… kind args…`, or `kind args…` with no env.
func (a Agent) Argv() []string {
	var v []string
	if len(a.Env) > 0 {
		v = append(v, "env")
		for _, kv := range a.Env {
			v = append(v, kv[0]+"="+kv[1])
		}
	}
	return append(append(v, a.Kind), a.Args...)
}

// Command is the command it runs, as a shell would read it (paths under
// $HOME as ~).
func (a Agent) Command() string {
	var parts []string
	for _, kv := range a.Env {
		parts = append(parts, kv[0]+"="+Shorten(kv[1]))
	}
	parts = append(append(parts, a.Kind), a.Args...)
	return strings.Join(parts, " ")
}

// Profile is a Claude Code profile: a config folder with its own sign-in
// (so its own subscription and limits), as c2 runs Claude Code with
// CLAUDE_CONFIG_DIR=~/.claude-2. ^n goes to the next; o remembers the one
// picked last ($XDG_STATE_HOME/o/last-profile), and $O_PROFILE names one
// instead (O_PROFILE=2, O_PROFILE=main).
type Profile struct {
	// Name is main for ~/.claude; NAME for ~/.claude-NAME.
	Name string
	// Dir is its folder: CLAUDE_CONFIG_DIR, for all but the main one.
	Dir string
}

const Main = "main"

func (p Profile) IsMain() bool { return p.Name == Main }

// Usage is its limits as its status line last saw them (rate-limits.json
// in its folder): `5h 12% · 7d 67%`. A window past its reset is left out.
// "" without the file, or with nothing in it.
func (p Profile) Usage() string {
	b, err := os.ReadFile(filepath.Join(p.Dir, "rate-limits.json"))
	if err != nil {
		return ""
	}
	return usage(b, float64(time.Now().UnixNano())/1e9)
}

func usage(b []byte, now float64) string {
	var v map[string]map[string]any
	if json.Unmarshal(b, &v) != nil {
		return ""
	}
	var parts []string
	for _, w := range [][2]string{{"five_hour", "5h"}, {"seven_day", "7d"}} {
		pct, ok := v[w[0]]["used_percentage"].(float64)
		if !ok {
			continue
		}
		resets, ok := v[w[0]]["resets_at"].(float64)
		if !ok {
			resets = math.MaxFloat64
		}
		if resets > now {
			parts = append(parts, fmt.Sprintf("%s %.0f%%", w[1], pct))
		}
	}
	return strings.Join(parts, " · ")
}

func home() string { h, _ := os.UserHomeDir(); return h }

// Profiles is this computer's Claude profiles: the main one first, then
// the others by name.
func Profiles() []Profile { return findProfiles(home()) }

// FindMain is the main profile alone (~/.claude), without looking for others.
func FindMain() []Profile { return []Profile{{Name: Main, Dir: filepath.Join(home(), ".claude")}} }

func findProfiles(home string) []Profile {
	var more []Profile
	entries, _ := os.ReadDir(home)
	for _, e := range entries {
		name, ok := strings.CutPrefix(e.Name(), ".claude-")
		dir := filepath.Join(home, e.Name())
		if !ok || name == "" || name == Main || strings.IndexFunc(name, unicode.IsSpace) >= 0 {
			continue
		}
		if fi, err := os.Stat(filepath.Join(dir, ".claude.json")); err == nil && !fi.IsDir() {
			more = append(more, Profile{Name: name, Dir: dir})
		}
	}
	sort.Slice(more, func(i, j int) bool { return more[i].Name < more[j].Name })
	return append([]Profile{{Name: Main, Dir: filepath.Join(home, ".claude")}}, more...)
}

// Why o starts on the configuration it does.
type Why int

const (
	WhyFirst Why = iota
	WhyEnv
	WhyLast
)

// StartProfile is the profile o starts on: the one $O_PROFILE names, else
// the one picked last, else the main one.
func StartProfile(profiles []Profile) (int, Why) {
	return pickProfile(profiles, os.Getenv("O_PROFILE"), readState("last-profile"))
}

func pickProfile(profiles []Profile, env, last string) (int, Why) {
	at := func(n string) int {
		for i, p := range profiles {
			if p.Name == strings.TrimSpace(n) {
				return i
			}
		}
		return -1
	}
	if e := strings.TrimSpace(env); e != "" {
		if i := at(e); i >= 0 {
			return i, WhyEnv
		}
	}
	if last != "" {
		if i := at(last); i >= 0 {
			return i, WhyLast
		}
	}
	return 0, WhyFirst
}

// RememberProfile remembers profile name as the one picked last (^n).
func RememberProfile(name string) { writeState("last-profile", name) }

// Defaults is the configurations without a config file: provider pairs,
// everyday then deeper reasoning. Claude Opus / Fable, Codex Sol 6.1 xhigh
// / Astra 6 max. The Mac
// runs Codex in its own process (--no-daemon); Linux's Claude skips its
// Chrome integration (--no-chrome), as its shell wrappers do.
func Defaults() []Agent {
	skip := []string{"--dangerously-skip-permissions"}
	claude := skip
	codexHead := []string{"--no-daemon", "--yolo"}
	if runtime.GOOS == "linux" {
		claude = []string{"--dangerously-skip-permissions", "--no-chrome"}
		codexHead = []string{"--yolo"}
	}
	effort := func(e string) []string {
		return append(append([]string(nil), codexHead...), "-c", `model_reasoning_effort="`+e+`"`, "-c", `plan_mode_reasoning_effort="`+e+`"`)
	}
	return []Agent{
		newAgent("claude", "opus", claude, ""),
		newAgent("claude", "fable", claude, ""),
		newAgent("codex", "gpt-6.1-sol", effort("xhigh"), "codex(sol)"),
		newAgent("codex", "gpt-6-astra", effort("max"), "codex(astra)"),
	}
}

// File is the config file's path.
func File() string {
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		base = filepath.Join(home(), ".config")
	}
	return filepath.Join(base, "o/config.toml")
}

// Load is the config, and what was wrong with the file when it couldn't
// be used (the defaults are used then).
func Load() (Config, string) {
	path := File()
	shown := Shorten(path)
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return Default(), ""
	}
	if err != nil {
		return Default(), fmt.Sprintf("%s: %v · using the defaults", shown, err)
	}
	c, err := Parse(string(b))
	if err != nil {
		return Default(), fmt.Sprintf("%s: %v · using the defaults", shown, err)
	}
	return c, ""
}

// Shorten is path with $HOME as ~.
func Shorten(path string) string {
	h := home()
	if h != "" && (path == h || strings.HasPrefix(path, h+"/")) {
		return "~/" + strings.TrimPrefix(strings.TrimPrefix(path, h), "/")
	}
	return path
}

// Parse reads a config file: its max_width and its [[agent]]
// tables, in order.
func Parse(s string) (Config, error) {
	var t map[string]any
	if _, err := toml.Decode(s, &t); err != nil {
		msg := err.Error()
		var pe toml.ParseError
		if errors.As(err, &pe) {
			msg = pe.Message
		}
		return Config{}, errors.New(strings.TrimSpace(msg))
	}
	keys := sortedKeys(t)
	for _, k := range keys {
		if k != "agent" && k != "max_width" {
			return Config{}, fmt.Errorf("unknown key `%s` (max_width, then [[agent]] tables)", k)
		}
	}
	c := Config{MaxWidth: DefaultMaxWidth}
	if v, ok := t["max_width"]; ok {
		n, isInt := v.(int64)
		switch {
		case isInt && n == 0:
			c.MaxWidth = 0
		case isInt && n >= minMaxWidth && n <= math.MaxUint16:
			c.MaxWidth = int(n)
		default:
			return Config{}, fmt.Errorf("`max_width` is a number of columns, %d or more (0: the pane's width)", minMaxWidth)
		}
	}
	list, _ := t["agent"].([]map[string]any)
	if len(list) == 0 {
		return Config{}, errors.New("no [[agent]] in it")
	}
	for i, a := range list {
		n := i + 1
		for _, k := range sortedKeys(a) {
			if k != "kind" && k != "model" && k != "args" && k != "name" {
				return Config{}, fmt.Errorf("agent %d: unknown key `%s` (kind, model, args, name)", n, k)
			}
		}
		text := func(k string) (string, error) {
			v, ok := a[k]
			if !ok {
				return "", nil
			}
			s, ok := v.(string)
			if !ok {
				return "", fmt.Errorf("agent %d: `%s` isn't a string", n, k)
			}
			return strings.TrimSpace(s), nil
		}
		kind, err := text("kind")
		if err != nil {
			return Config{}, err
		}
		if kind == "" {
			return Config{}, fmt.Errorf("agent %d has no `kind` (claude, codex)", n)
		}
		if strings.IndexFunc(kind, unicode.IsSpace) >= 0 {
			return Config{}, fmt.Errorf("agent %d: `kind` is one word (claude, codex); the rest goes in `args`", n)
		}
		model, err := text("model")
		if err != nil {
			return Config{}, err
		}
		name, err := text("name")
		if err != nil {
			return Config{}, err
		}
		var args []string
		if v, ok := a["args"]; ok {
			list, isList := v.([]any)
			if !isList {
				return Config{}, fmt.Errorf("agent %d: `args` isn't a list of strings", n)
			}
			for _, x := range list {
				s, isStr := x.(string)
				if !isStr {
					return Config{}, fmt.Errorf("agent %d: `args` isn't a list of strings", n)
				}
				args = append(args, s)
			}
		}
		agent := newAgent(kind, model, args, name)
		for _, o := range c.Agents {
			if o.Name == agent.Name {
				return Config{}, fmt.Errorf("two agents are named %s (give one a `name`)", agent.Name)
			}
		}
		c.Agents = append(c.Agents, agent)
	}
	return c, nil
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// Start is where o starts: the configuration $O_AGENT names, else the one
// picked last, else the first.
func Start(agents []Agent) (int, Why) {
	return pickStart(agents, os.Getenv("O_AGENT"), readState("last-agent"))
}

// pickStart finds by name, else the first of that kind. This keeps older
// bare names such as codex on that provider's everyday choice after it
// gains a pair.
func pickStart(agents []Agent, env, last string) (int, Why) {
	at := func(name string) int {
		name = strings.TrimSpace(name)
		for i, a := range agents {
			if a.Name == name {
				return i
			}
		}
		for i, a := range agents {
			if a.Kind == name {
				return i
			}
		}
		return -1
	}
	if env != "" {
		if i := at(env); i >= 0 {
			return i, WhyEnv
		}
	}
	if last != "" {
		if i := at(last); i >= 0 {
			return i, WhyLast
		}
	}
	return 0, WhyFirst
}

// StateFile is $XDG_STATE_HOME/o/FILE (else ~/.local/state/o/FILE).
func StateFile(file string) string {
	base := os.Getenv("XDG_STATE_HOME")
	if base == "" {
		base = filepath.Join(home(), ".local/state")
	}
	return filepath.Join(base, "o", file)
}

func readState(file string) string {
	b, err := os.ReadFile(StateFile(file))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// Remember remembers name as the configuration picked last (⇧tab, ^1…^9).
func Remember(name string) { writeState("last-agent", name) }

// writeState writes whole to a temp file, then renames, so another o
// starting never reads half of it.
func writeState(file, name string) {
	path := StateFile(file)
	dir := filepath.Dir(path)
	tmp := filepath.Join(dir, fmt.Sprintf(".%s.%d", file, os.Getpid()))
	if os.MkdirAll(dir, 0o755) != nil || os.WriteFile(tmp, []byte(name+"\n"), 0o644) != nil || os.Rename(tmp, path) != nil {
		_ = os.Remove(tmp)
	}
}
