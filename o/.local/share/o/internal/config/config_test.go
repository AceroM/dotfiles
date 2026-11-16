package config

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func TestNamesComeFromKindAndModel(t *testing.T) {
	c, err := Parse(`
[[agent]]
kind = "claude"
model = "opus"
args = ["--dangerously-skip-permissions"]

[[agent]]
kind = "codex"
args = ["--yolo"]

[[agent]]
kind = "claude"
model = "claude-fable-5-2"
name = "fable"
`)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, a := range c.Agents {
		names = append(names, a.Name)
	}
	if !reflect.DeepEqual(names, []string{"claude(opus)", "codex", "fable"}) {
		t.Fatal(names)
	}
	if c.Agents[0].Command() != "claude --dangerously-skip-permissions --model opus" {
		t.Fatal(c.Agents[0].Command())
	}
	if !reflect.DeepEqual(c.Agents[2].Args, []string{"--model", "claude-fable-5-2"}) {
		t.Fatal(c.Agents[2].Args)
	}
}

func TestSaysWhatIsWrong(t *testing.T) {
	errOf := func(s string) string {
		_, err := Parse(s)
		if err == nil {
			t.Fatalf("no error for %q", s)
		}
		return err.Error()
	}
	if errOf("") != "no [[agent]] in it" {
		t.Error(errOf(""))
	}
	for s, want := range map[string]string{
		"[[agent]]\nkind = \"claude\"\nmodle = \"opus\"":           "unknown key `modle`",
		"[[agent]]\nmodel = \"opus\"":                              "no `kind`",
		"[[agent]]\nkind = \"codex --yolo\"":                       "one word",
		"[[agent]]\nkind = \"codex\"\nargs = \"--yolo\"":           "isn't a list",
		"[[agent]]\nkind = \"codex\"\n[[agent]]\nkind = \"codex\"": "two agents are named codex",
		"max_width = 20\n[[agent]]\nkind = \"codex\"":              "40 or more",
		"max_width = \"wide\"\n[[agent]]\nkind = \"codex\"":        "number of columns",
		"[sync]\noff = true\n[[agent]]\nkind = \"codex\"":          "unknown key `sync`",
	} {
		if got := errOf(s); !strings.Contains(got, want) {
			t.Errorf("%q: %q", s, got)
		}
	}
	if errOf("[[agent]\n") == "" {
		t.Error("empty")
	}
}

func TestMaxWidth(t *testing.T) {
	width := func(s string) int {
		c, err := Parse(s + "\n[[agent]]\nkind = \"codex\"")
		if err != nil {
			t.Fatal(err)
		}
		return c.MaxWidth
	}
	if width("") != DefaultMaxWidth || width("max_width = 120") != 120 || width("max_width = 0") != 0 {
		t.Fatal("max_width")
	}
}

func TestPicksWhereToStart(t *testing.T) {
	all := Defaults()
	for _, c := range []struct {
		env, last string
		i         int
		why       Why
	}{
		{"", "", 0, WhyFirst},
		{"", "codex\n", 2, WhyLast},
		{"", "codex(astra)", 3, WhyLast},
		{"unknown", "codex", 2, WhyLast},
		{"", "gone", 0, WhyFirst},
	} {
		if i, why := pickStart(all, c.env, c.last); i != c.i || why != c.why {
			t.Errorf("%+v: %d %v", c, i, why)
		}
	}
}

func TestProfiles(t *testing.T) {
	h := t.TempDir()
	for _, d := range []string{".claude", ".claude-2", ".claude-work", ".claude-nothing"} {
		os.MkdirAll(filepath.Join(h, d), 0o755)
	}
	os.WriteFile(filepath.Join(h, ".claude-2/.claude.json"), []byte("{}"), 0o644)
	os.WriteFile(filepath.Join(h, ".claude-work/.claude.json"), []byte("{}"), 0o644)
	ps := findProfiles(h)
	if len(ps) != 3 || ps[0].Name != Main || ps[1].Name != "2" || ps[2].Name != "work" {
		t.Fatal(ps)
	}
	if i, why := pickProfile(ps, "", "work"); i != 2 || why != WhyLast {
		t.Fatal(i, why)
	}
	if i, why := pickProfile(ps, "main", "work"); i != 0 || why != WhyEnv {
		t.Fatal(i, why)
	}
	on2 := Defaults()[0].On(&ps[1])
	if on2.Name != "claude(opus)·2" || on2.Argv()[0] != "env" || on2.Argv()[1] != "CLAUDE_CONFIG_DIR="+ps[1].Dir {
		t.Fatal(on2.Argv())
	}
	if codex := Defaults()[2].On(&ps[1]); codex.Name != "codex(sol)" || len(codex.Env) != 0 {
		t.Fatal(codex)
	}
	if got := usage([]byte(`{"five_hour":{"used_percentage":12.4,"resets_at":2000},"seven_day":{"used_percentage":67,"resets_at":500}}`), 1000); got != "5h 12%" {
		t.Fatal(got)
	}
}

func TestDefaultsPerPlatform(t *testing.T) {
	d := Defaults()
	var names []string
	for _, agent := range d {
		names = append(names, agent.Name)
	}
	if !reflect.DeepEqual(names, []string{"claude(opus)", "claude(fable)", "codex(sol)", "codex(astra)"}) {
		t.Fatal(names)
	}
	want := "claude --dangerously-skip-permissions --model opus"
	if runtime.GOOS == "linux" {
		want = "claude --dangerously-skip-permissions --no-chrome --model opus"
	}
	if d[0].Command() != want {
		t.Fatal(d[0].Command())
	}
	for i, effort := range []string{"xhigh", "max"} {
		args := d[i+2].Args
		if !strings.Contains(" "+strings.Join(args, " ")+" ", " --yolo ") {
			t.Fatal(args)
		}
		for _, key := range []string{"model_reasoning_effort", "plan_mode_reasoning_effort"} {
			if !strings.Contains(strings.Join(args, " "), key+`="`+effort+`"`) {
				t.Fatal(args)
			}
		}
	}
}
