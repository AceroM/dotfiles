package main

import (
	_ "embed"
	"errors"
	"os"
	"strconv"
	"strings"
)

//go:embed usage/jv.txt
var viewerHelp string

//go:embed usage/jp.txt
var prsHelp string

//go:embed usage/jn.txt
var netHelp string

// Only display options cross to the renderer as JSON. Git revisions, paths
// and shell commands stay separate argv entries all the way to their program.
type viewOptions struct {
	Split    *bool      `json:"split"`
	Wrap     bool       `json:"wrap"`
	Tests    *bool      `json:"tests"`
	Theme    *string    `json:"theme"`
	Popup    bool       `json:"popup"`
	Snapshot *[2]uint16 `json:"snapshot"`
	Keys     string     `json:"keys"`
	Out      *string    `json:"out"`
	PRs      bool       `json:"prs"`
	Net      bool       `json:"net"`
	Flat     bool       `json:"flat"`
}

type invocation struct {
	view   viewOptions
	source string
	args   []string
	action string
}

func aliasArgs(name string, args []string) []string {
	switch name {
	case "jf":
		return append([]string{"--flat"}, args...)
	case "jg":
		return append([]string{"-g"}, args...)
	case "jp":
		return append([]string{"--prs"}, args...)
	case "jn":
		return append([]string{"--net"}, args...)
	default:
		return args
	}
}

func parse(args []string) (invocation, error) {
	c := invocation{source: "pr", view: viewOptions{Wrap: true}}
	if theme, ok := os.LookupEnv("JV_THEME"); ok {
		c.view.Theme = &theme
	}
	var command *string
	var stack bool
	for len(args) > 0 {
		arg := args[0]
		args = args[1:]
		switch arg {
		case "-h", "--help":
			c.action = "help"
			return c, nil
		case "--themes":
			c.action = "themes"
			return c, nil
		case "--prs":
			c.view.PRs = true
		case "--net":
			c.view.Net = true
		case "--stack":
			stack = true
		case "--flat", "--no-tree":
			c.view.Flat = true
		case "-s", "--split", "-u", "--unified":
			split := arg == "-s" || arg == "--split"
			c.view.Split = &split
		case "--no-wrap", "--nowrap":
			c.view.Wrap = false
		case "--tests", "--no-tests":
			show := arg == "--tests"
			c.view.Tests = &show
		case "--popup":
			c.view.Popup = true
		case "-l", "--local", ".":
			c.source = "local"
		case "-g", "--git":
			// Git owns every remaining argument, including -s, -- and --help.
			c.source, c.args, args = "git", args, nil
		case "--":
			c.args = append(c.args, args...)
			args = nil
		case "--theme", "-c", "--cmd", "--snapshot", "--keys", "--out":
			if len(args) == 0 {
				return c, errors.New(missingValue[arg])
			}
			value := args[0]
			args = args[1:]
			switch arg {
			case "--theme":
				c.view.Theme = &value
			case "-c", "--cmd":
				command = &value
			case "--snapshot":
				size, err := dimensions(value)
				if err != nil {
					return c, err
				}
				c.view.Snapshot = &size
			case "--keys":
				c.view.Keys = value
			case "--out":
				c.view.Out = &value
			}
		default:
			if theme, ok := strings.CutPrefix(arg, "--theme="); ok {
				c.view.Theme = &theme
			} else {
				c.args = append(c.args, arg)
			}
		}
	}
	// An explicit command wins over git and local. Local ignores PR selectors.
	if command != nil {
		c.source, c.args = "cmd", []string{*command}
	} else if c.source == "local" {
		c.args = nil
	}
	if stack {
		if c.source != "pr" || len(c.args) != 0 || c.view.PRs || c.view.Net {
			return c, errors.New("--stack shows the current branch's stack and takes no diff source or PR selector")
		}
		c.source = "stack"
	}
	return c, nil
}

var missingValue = map[string]string{
	"--theme":    "--theme needs a name",
	"-c":         "--cmd needs a command",
	"--cmd":      "--cmd needs a command",
	"--snapshot": "--snapshot needs WxH",
	"--keys":     "--keys needs keys",
	"--out":      "--out needs a path",
}

func dimensions(value string) ([2]uint16, error) {
	width, height, ok := strings.Cut(value, "x")
	if !ok {
		return [2]uint16{}, errors.New("--snapshot needs WxH")
	}
	w, err := strconv.ParseUint(strings.TrimPrefix(width, "+"), 10, 16)
	if err != nil {
		return [2]uint16{}, errors.New("bad width")
	}
	h, err := strconv.ParseUint(strings.TrimPrefix(height, "+"), 10, 16)
	if err != nil {
		return [2]uint16{}, errors.New("bad height")
	}
	return [2]uint16{uint16(w), uint16(h)}, nil
}
