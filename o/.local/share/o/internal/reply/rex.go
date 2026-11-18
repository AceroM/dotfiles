package reply

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"

	"o/internal/spawn"
)

type target struct {
	session, block string
	pid            int
	agent          string
}

// Run opens the float or runs the composer process inside it.
func Run(args []string) error {
	session, block := os.Getenv("REX_SESSION"), os.Getenv("REX_BLOCK")
	switch args[0] {
	case "--reply":
		switch len(args) {
		case 1:
		case 3:
			session, block = args[1], args[2]
		default:
			return errors.New("usage: o --reply [SESSION BLOCK]")
		}
		if session == "" || block == "" {
			return errors.New("open a reply from a Rex agent pane")
		}
		_, err := spawn.Rex("do", "-s", session, "-b", block, "agent_reply")
		return err
	case "--reply-compose":
		if len(args) != 4 || session == "" || block == "" || block == args[1] {
			return errors.New("reply composer needs a separate Rex pane and an agent target")
		}
		pid, err := strconv.Atoi(args[2])
		if err != nil || pid <= 0 || (args[3] != "codex" && args[3] != "claude") {
			return errors.New("invalid reply target")
		}
		return compose(target{session: session, block: args[1], pid: pid, agent: args[3]})
	}
	return errors.New("unknown reply command")
}

type submission struct {
	Pasted bool   `json:"pasted"`
	Error  string `json:"error"`
}

func (t target) submit(prompt string, pasted bool) (submission, error) {
	var result submission
	args, err := json.Marshal(struct {
		PID    int    `json:"pid"`
		Agent  string `json:"agent"`
		Prompt string `json:"prompt"`
		Pasted bool   `json:"pasted"`
	}{t.pid, t.agent, prompt, pasted})
	if err != nil {
		return result, err
	}
	data, err := spawn.RexWithInput(string(args), "do", "-s", t.session, "-b", t.block,
		"agent_reply_send", "--args", "-", "--json")
	if err != nil {
		return result, fmt.Errorf("send reply: %w", err)
	}
	if err := json.Unmarshal([]byte(data), &result); err != nil {
		return result, fmt.Errorf("read reply result: %w", err)
	}
	return result, nil
}
