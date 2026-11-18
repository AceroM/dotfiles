// Package spawn is sending: a new Rex tab (a window) in this session,
// running the agent with the prompt as its first message. The Rex call runs
// in a child process, `o --start-agent …`, in its own process group, so
// quitting o right after ⏎ still gets the agent started.
//
// On the Mac the tab runs `sh -c '"$@"; exec $SHELL -l' o AGENT ARGS… --
// PROMPT`, interactive so
// the agent sees ~/.zshrc's environment. On Linux it runs `bash -ic …`,
// so `claude` and `codex` are the interactive shell's functions (the desktop's display
// and clipboard, Claude's startup typing). The agent gets the prompt as an
// argument, with no waiting for a shell to be ready to type into. When it
// exits, the tab is left at a shell in its folder.
package spawn

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"syscall"

	"o/internal/config"
)

// ChildFlag is internal: `o --start-agent CWD PROMPT LABEL FOCUS COMMAND…`
// does the Rex call; COMMAND is the agent's (Agent.Argv).
const ChildFlag = "--start-agent"

func session() string { return os.Getenv("REX_SESSION") }

// InRex reports a Rex session to open tabs in.
func InRex() bool { return session() != "" }

// Outcome is one send: its display line, whether it worked, and its focus
// target (the agent's block; "" for none).
type Outcome struct {
	Msg    string
	OK     bool
	Target string
}

// Done is an outcome, tagged with its send's number.
type Done struct {
	N   int
	Out Outcome
}

func (o Outcome) MarshalJSON() ([]byte, error) {
	var target any
	if o.Target != "" {
		target = o.Target
	}
	return json.Marshal([]any{o.Msg, o.OK, target})
}

func (o *Outcome) UnmarshalJSON(b []byte) error {
	var v []any
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	if len(v) != 3 {
		return errors.New("expected three values")
	}
	msg, ok1 := v[0].(string)
	good, ok2 := v[1].(bool)
	if !ok1 || !ok2 {
		return errors.New("bad outcome")
	}
	target, _ := v[2].(string)
	*o = Outcome{msg, good, target}
	return nil
}

// Send starts agent with prompt in a new tab in cwd, in the background.
// label names the tab ("": Rex's own name for it); focus goes there. The
// outcome comes back on tx, tagged n.
func Send(n int, agent config.Agent, prompt, cwd, label string, focus bool, tx chan<- Done) {
	f := "0"
	if focus {
		f = "1"
	}
	args := append([]string{ChildFlag, cwd, prompt, label, f}, agent.Argv()...)
	kind := agent.Name
	go func() {
		exe, err := os.Executable()
		if err != nil {
			tx <- Done{n, Outcome{Msg: fmt.Sprintf("couldn't start %s: %v", kind, err)}}
			return
		}
		c := exec.Command(exe, args...)
		var out bytes.Buffer
		c.Stdout = &out
		// Its own process group: nothing aimed at o's job reaches it.
		c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		err = c.Run()
		msg := strings.TrimSpace(out.String())
		var res Outcome
		switch {
		case err == nil:
			if e := json.Unmarshal([]byte(msg), &res); e != nil {
				res = Outcome{Msg: "invalid start result: " + e.Error()}
			}
		case msg != "":
			res = Outcome{Msg: msg}
		default:
			var exit *exec.ExitError
			if errors.As(err, &exit) {
				res = Outcome{Msg: kind + " didn't start"}
			} else {
				res = Outcome{Msg: fmt.Sprintf("couldn't start %s: %v", kind, err)}
			}
		}
		tx <- Done{n, res}
	}()
}

// Child is the --start-agent process: one line on stdout says how it went.
func Child(args []string) int {
	if len(args) < 5 {
		return 2
	}
	cwd, prompt, label, focus, command := args[0], args[1], args[2], args[3], args[4:]
	res, err := start(command, prompt, cwd, label, focus == "1")
	if err != nil {
		fmt.Println(err.Error())
		return 1
	}
	b, _ := json.Marshal(res)
	fmt.Println(string(b))
	return 0
}

// thenShell: after the agent exits, the tab's login shell, in the agent's folder.
const thenShell = `"$@"; exec "${SHELL:-/bin/zsh}" -l`

// thenShellRC is the same, run by an interactive shell: `command` skips its
// functions, so codex is the binary and not a zsh wrapper. (env runs the
// binary too.)
const thenShellRC = `command "$@"; exec "${SHELL:-/bin/zsh}" -l`

// thenShellBash reads ~/.bashrc for the interactive shell's desktop environment and
// Claude typeahead wrappers (Linux). It exports a profile's assignments
// in this child shell so env doesn't bypass those functions. Nothing changes
// the parent pane's environment.
const thenShellBash = `if [[ $1 == env ]]; then shift; while [[ $# -gt 0 && $1 == *=* ]]; do export "$1"; shift; done; fi; "$@"; exec "${SHELL:-/bin/bash}" -l`

// shellArgs is `sh -c`'s $0, then the command and its initial interactive prompt.
func shellArgs(command []string, prompt string) []string {
	args := append([]string{"o"}, command...)
	// A positional argument after -- preserves prompts starting with -.
	return append(args, "--", prompt)
}

func start(command []string, prompt, cwd, label string, focus bool) (Outcome, error) {
	ses := session()
	if ses == "" {
		return Outcome{}, errors.New("not in a Rex terminal (no REX_SESSION)")
	}
	head := []string{"window", "new", "-s", ses}
	if label != "" {
		head = append(head, label)
	}
	head = append(head, "-c", cwd, fmt.Sprintf("--focus=%t", focus), "--json")
	agent := shellArgs(command, prompt)
	var out string
	var err error
	if runtime.GOOS == "linux" {
		out, err = Rex(cat(head, []string{"--", "bash", "-ic", thenShellBash}, agent)...)
	} else {
		// --interactive: ~/.zshrc too, so the agent sees what a shell tab would.
		out, err = Rex(cat(head, []string{"--interactive", "--", "sh", "-c", thenShell}, agent)...)
		if err != nil && strings.Contains(err.Error(), "unknown flag: --interactive") {
			// Servers older than --interactive: the shell reads ~/.zshrc itself.
			shell := os.Getenv("SHELL")
			if shell == "" {
				shell = "/bin/zsh"
			}
			out, err = Rex(cat(head, []string{"--", shell, "-ic", thenShellRC}, agent)...)
		}
	}
	if err != nil {
		return Outcome{}, fmt.Errorf("couldn't open a tab: %w", err)
	}
	var v struct {
		BlockIDs []string `json:"block_ids"`
		WindowID string   `json:"window_id"`
	}
	if err := json.Unmarshal([]byte(out), &v); err != nil {
		return Outcome{}, fmt.Errorf("window new: %w", err)
	}
	if len(v.BlockIDs) == 0 {
		return Outcome{}, errors.New("window new returned no block")
	}
	shown := label
	if shown == "" {
		shown = windowLabel(ses, v.WindowID)
		if shown == "" {
			shown = Short(v.WindowID)
		}
	}
	return Outcome{Msg: "→ tab " + shown, OK: true, Target: v.BlockIDs[0]}, nil
}

func cat(parts ...[]string) []string {
	var out []string
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

// windowLabel is what Rex calls window id in session ses.
func windowLabel(ses, id string) string {
	out, err := Rex("window", "ls", "-s", ses, "--json")
	if err != nil {
		return ""
	}
	var list []map[string]any
	if json.Unmarshal([]byte(out), &list) != nil {
		var wrapped struct {
			Windows []map[string]any `json:"windows"`
		}
		if json.Unmarshal([]byte(out), &wrapped) != nil {
			return ""
		}
		list = wrapped.Windows
	}
	for _, w := range list {
		if w["window_id"] == id {
			l, _ := w["label"].(string)
			return l
		}
	}
	return ""
}

// Short is an ID's last 8 characters, as Rex shortens them (Window 023f56b0).
func Short(id string) string {
	if len(id) <= 8 {
		return id
	}
	return id[len(id)-8:]
}

// Reply sends prompt to the agent in block (a reply draft's), in the
// background: pasted, then Enter, as typing it in would. The outcome comes
// back on tx, tagged n.
func Reply(n int, block, prompt string, tx chan<- Done) {
	go func() {
		if err := pasteEnter(block, prompt); err != nil {
			tx <- Done{n, Outcome{Msg: "couldn't reply: " + err.Error()}}
			return
		}
		tx <- Done{n, Outcome{Msg: "→ pane " + Short(block), OK: true, Target: block}}
	}()
}

func pasteEnter(block, prompt string) error {
	ses := session()
	if ses == "" {
		return errors.New("not in a Rex terminal (no REX_SESSION)")
	}
	if err := Paste(ses, block, prompt); err != nil {
		return err
	}
	_, err := Rex("send-key", "-s", ses, "-b", block, "enter")
	return err
}

// Paste delivers text using the terminal's paste mode. Pass the payload on
// stdin so long prompts fit and the text stays out of the CLI arguments.
func Paste(session, block, prompt string) error {
	call, _ := json.Marshal(map[string]any{"block_id": block, "event": map[string]any{"type": "paste", "payload": map[string]any{"text": prompt}}})
	_, err := RexWithInput(string(call), "api", "call", "-s", session, "block.event", "-")
	return err
}

// Space is this Rex session: its id and its name (drafts are kept per session).
func Space() (string, string) {
	ses := session()
	if ses == "" {
		return "", ""
	}
	out, err := Rex("session", "inspect", ses, "--json")
	if err != nil {
		return ses, ""
	}
	var v struct {
		Label string `json:"label"`
	}
	_ = json.Unmarshal([]byte(out), &v)
	return ses, v.Label
}

// AgentPane is the block a reply goes to now: block while it's still in
// this session; "" when it's gone.
func AgentPane(block string) string {
	ses := session()
	if ses == "" {
		return ""
	}
	if _, err := Rex("block", "inspect", "-s", ses, block, "--json"); err != nil {
		return ""
	}
	return block
}

// Focus focuses the block a send started its agent in; its tab comes up with it.
func Focus(block string) error {
	ses := session()
	if ses == "" {
		return errors.New("not in a Rex terminal (no REX_SESSION)")
	}
	_, err := Rex("focus", "-s", ses, block)
	return err
}

// Rex runs `rex ARGS`: stdout on success, else the error's message.
func Rex(args ...string) (string, error) {
	return RexWithInput("", args...)
}

// RexWithInput runs rex with input on stdin.
func RexWithInput(input string, args ...string) (string, error) {
	c := exec.Command("rex", args...)
	if input != "" {
		c.Stdin = strings.NewReader(input)
	}
	var stdout, stderr bytes.Buffer
	c.Stdout, c.Stderr = &stdout, &stderr
	if err := c.Run(); err != nil {
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			return "", fmt.Errorf("rex: %w", err)
		}
		return "", errors.New(failure(stderr.String() + stdout.String()))
	}
	return stdout.String(), nil
}

// failure is a failed rex call's error message: its first line that says
// something (a JSON error's message).
func failure(all string) string {
	for _, l := range strings.Split(all, "\n") {
		var v map[string]any
		if json.Unmarshal([]byte(l), &v) != nil {
			continue
		}
		if e, ok := v["error"].(map[string]any); ok {
			if m, ok := e["message"].(string); ok {
				return m
			}
		}
		if m, ok := v["message"].(string); ok {
			return m
		}
	}
	for _, l := range strings.Split(strings.TrimSpace(all), "\n") {
		return strings.TrimPrefix(strings.TrimSpace(l), "Error: ")
	}
	return "failed"
}
