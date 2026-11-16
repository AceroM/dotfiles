package spawn

import (
	"encoding/json"
	"os/exec"
	"reflect"
	"testing"

	"o/internal/config"
)

func TestInitialPromptsUseEachAgentsInteractiveArguments(t *testing.T) {
	prompt := "--help\nfix 'quotes' and $(literal)"
	for _, a := range config.Defaults() {
		cmd := a.Argv()
		args := shellArgs(cmd, prompt)
		flag := "--"
		if args[0] != "o" || !reflect.DeepEqual(args[1:len(args)-2], cmd) || args[len(args)-2] != flag || args[len(args)-1] != prompt {
			t.Fatal(args)
		}
	}
}

func TestAProfileKeepsTheShellWrapperAndLiteralPrompt(t *testing.T) {
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("no bash")
	}
	prompt := "--help\nfix 'quotes' and $(literal)"
	script := `claude() { printf '%s\n' "$CLAUDE_CONFIG_DIR" "$@"; }; ` + thenShellBash
	c := exec.Command("bash", "-c", script, "o", "env", "CLAUDE_CONFIG_DIR=/tmp/profile with spaces", "claude", "--model", "opus", "--", prompt)
	c.Env = append(c.Environ(), "SHELL=/usr/bin/true")
	out, err := c.Output()
	if err != nil {
		t.Fatal(err)
	}
	if want := "/tmp/profile with spaces\n--model\nopus\n--\n" + prompt + "\n"; string(out) != want {
		t.Fatalf("%q", out)
	}
}

func TestOutcomeIsTheRustTuple(t *testing.T) {
	b, _ := json.Marshal(Outcome{"→ tab x", true, "block:1"})
	if string(b) != `["→ tab x",true,"block:1"]` {
		t.Fatal(string(b))
	}
	var o Outcome
	if json.Unmarshal([]byte(`["no",false,null]`), &o) != nil || o != (Outcome{"no", false, ""}) {
		t.Fatal(o)
	}
	if failure("Error: boom\nmore") != "boom" || failure(`{"error":{"message":"gone"}}`) != "gone" {
		t.Fatal(failure("Error: boom"))
	}
}
