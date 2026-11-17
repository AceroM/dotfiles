// rt is a Rex tab picker. Its UI and Rex CLI integration are written in Go.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"

	tea "charm.land/bubbletea/v2"
)

const help = `rt — switch and close tabs across every Rex session

  rt                   browse Rex tabs in this terminal
  rt ls [--json]       list tabs in session and tab-strip order

  j k / ↓ ↑           move (5j, 3k work too)
  g / gg / G / 12G    first / first / last / tab 12
  ctrl+d / ctrl+u     half a page down / up
  /                   filter by session, tab name and pane titles/directories
  Enter               focus the selected pane and dismiss the picker
  y / Y               copy its Rex block ID / agent session ID
  ; or x              close selected tab, marked tabs, or visual range
  Space / m           mark or unmark, then move down
  v                   select a visual range with j/k
  a                   mark all filtered tabs
  Esc                 cancel range / marks / filter / picker
  q / ctrl+c          quit
  ?                   show keys

Closing a tab ends all its panes. The tab hosting the picker is excluded.
--session ID selects a session; --client ID selects the Rex app to switch.
--current-session restricts the list to the invoking session.
`

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "rt:", err)
		os.Exit(1)
	}
}

func run() error {
	args := os.Args[1:]
	list := len(args) > 0 && args[0] == "ls"
	if list {
		args = args[1:]
	}
	flags := flag.NewFlagSet("rt", flag.ContinueOnError)
	flags.Bool("inline", true, "compatibility flag; rt always draws in this terminal")
	asJSON := flags.Bool("json", false, "print the list as JSON")
	session := flags.String("session", os.Getenv("REX_SESSION"), "Rex session")
	client := flags.String("client", os.Getenv("REX_CLIENT"), "Rex app")
	current := flags.Bool("current-session", false, "list only the invoking session")
	flags.Usage = func() { fmt.Fprint(flags.Output(), help) }
	if err := flags.Parse(args); err != nil {
		if err == flag.ErrHelp {
			return nil
		}
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unknown argument %q (rt --help)", flags.Arg(0))
	}
	if *session == "" {
		return fmt.Errorf("run inside Rex, or pass --session ID")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := &rexCLI{ctx: ctx, session: *session, client: *client, block: os.Getenv("REX_BLOCK"), current: *current}
	snap, err := r.listTabs()
	if err != nil {
		return err
	}
	if list {
		if *asJSON {
			return json.NewEncoder(os.Stdout).Encode(snap)
		}
		for _, t := range snap.Tabs {
			fmt.Printf("%d\t%s\t%s\t%s\t%s\n", t.Index, t.ID, t.Session, t.Label, t.Detail)
		}
		return nil
	}
	tty, _, err := tea.OpenTTY()
	if err != nil {
		return err
	}
	defer tty.Close()
	r.addActivity(&snap)
	_, err = tea.NewProgram(newModel(r, snap), tea.WithInput(tty), tea.WithContext(ctx)).Run()
	return err
}
