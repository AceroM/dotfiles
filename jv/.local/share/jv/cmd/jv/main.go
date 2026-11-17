package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

func main() {
	os.Exit(run(aliasArgs(filepath.Base(os.Args[0]), os.Args[1:])))
}

func run(args []string) int {
	if len(args) > 0 {
		switch args[0] {
		case "--jv-fetch", "--jv-meta":
			return serveSource(args)
		case "--start-agent", "--commit":
			return viewer(args...)
		}
	}
	c, err := parse(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, "jv:", err)
		return 2
	}
	switch c.action {
	case "help":
		switch {
		case c.view.Net:
			fmt.Print(netHelp)
		case c.view.PRs:
			fmt.Print(prsHelp)
		default:
			fmt.Print(viewerHelp)
		}
		return 0
	case "themes":
		return viewer("--themes")
	}
	options, err := json.Marshal(c.view)
	if err != nil {
		fmt.Fprintln(os.Stderr, "jv:", err)
		return 1
	}
	return viewer(append([]string{"--view", string(options), c.source}, c.args...)...)
}

// Replace the foreground process so the viewer keeps its tty, stdin and Rex
// process name. It calls this same Go binary when it needs another diff.
func viewer(args ...string) int {
	renderer := os.Getenv("_JV_VIEWER")
	if renderer == "" {
		// A direct Go build (including go run) can use the stowed viewer.
		home, err := os.UserHomeDir()
		if err != nil {
			fmt.Fprintln(os.Stderr, "jv: locating viewer:", err)
			return 1
		}
		renderer = filepath.Join(home, ".local", "share", "jv", "viewer.sh")
	}
	os.Unsetenv("_JV_VIEWER")
	exe, err := os.Executable()
	if err == nil {
		if err = os.Setenv("_JV_DRIVER", exe); err == nil {
			err = syscall.Exec(renderer, append([]string{renderer}, args...), os.Environ())
		}
	}
	fmt.Fprintln(os.Stderr, "jv: starting viewer:", err)
	return 1
}
