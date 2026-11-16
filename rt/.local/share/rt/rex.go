package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"
	"unicode"

	"github.com/charmbracelet/x/ansi"
)

type tab struct {
	ID        string `json:"id"`
	SessionID string `json:"session_id"`
	Session   string `json:"session"`
	Index     int    `json:"index"`
	Label     string `json:"label"`
	Detail    string `json:"detail"`
	Panes     int    `json:"panes"`
}

type snapshot struct {
	Label string `json:"label"`
	Tabs  []tab  `json:"tabs"`
}

type rexCLI struct {
	ctx                            context.Context
	session, client, block, source string
	current                        bool
}

func (r *rexCLI) call(args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(r.ctx, 6*time.Second)
	defer cancel()
	prefix := []string{"--autostart=false", "--timeout", "5s"}
	if r.client != "" {
		prefix = append(prefix, "-C", r.client)
	}
	cmd := exec.CommandContext(ctx, "rex", append(prefix, args...)...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("Rex: %w", ctx.Err())
		}
		return nil, fmt.Errorf("Rex: %s (%w)", clean(stderr.String()), err)
	}
	return out, nil
}

func (r *rexCLI) popup() error {
	args := []string{"do", "-s", r.session}
	if r.block != "" {
		args = append(args, "-b", r.block)
	}
	options, _ := json.Marshal(map[string]any{"client": r.client, "current_session": r.current})
	_, err := r.call(append(args, "tabs", "--args", string(options))...)
	return err
}

func (r *rexCLI) snapshot() (snapshot, error) {
	if r.current {
		return r.sessionSnapshot(r.session)
	}
	out, err := r.call("ls", "--json")
	if err != nil {
		return snapshot{}, err
	}
	var list struct {
		Sessions []struct {
			ID string `json:"session_id"`
		}
	}
	if err := json.Unmarshal(out, &list); err != nil {
		return snapshot{}, fmt.Errorf("read Rex sessions: %w", err)
	}
	result := snapshot{Label: "All sessions", Tabs: []tab{}}
	for _, s := range list.Sessions {
		snap, err := r.sessionSnapshot(s.ID)
		if err != nil {
			return snapshot{}, err
		}
		for _, t := range snap.Tabs {
			t.Index = len(result.Tabs) + 1
			result.Tabs = append(result.Tabs, t)
		}
	}
	return result, nil
}

func (r *rexCLI) sessionSnapshot(id string) (snapshot, error) {
	out, err := r.call("session", "inspect", id, "--json")
	if err != nil {
		return snapshot{}, err
	}
	return parseSnapshot(out, r.block, r.source)
}

func parseSnapshot(data []byte, block, source string) (snapshot, error) {
	var view struct {
		ID      string `json:"session_id"`
		Label   string
		Windows []struct {
			ID     string `json:"window_id"`
			Label  string
			Layers []struct {
				Kind   string
				Blocks []struct {
					ID    string `json:"block_id"`
					Label string
				}
			}
		}
	}
	if err := json.Unmarshal(data, &view); err != nil {
		return snapshot{}, fmt.Errorf("read Rex tabs: %w", err)
	}
	result := snapshot{Label: clean(view.Label), Tabs: []tab{}}
	for i, w := range view.Windows {
		mine := w.ID == source
		var details []string
		panes := 0
		for _, layer := range w.Layers {
			for _, b := range layer.Blocks {
				mine = mine || (block != "" && b.ID == block)
				if layer.Kind == "tiled" {
					panes++
					if label := clean(b.Label); label != "" && label != "shell" {
						details = append(details, label)
					}
				}
			}
		}
		if mine {
			continue
		}
		label := clean(w.Label)
		if label == "" {
			label = fmt.Sprintf("Tab %d", i+1)
		}
		result.Tabs = append(result.Tabs, tab{ID: w.ID, SessionID: view.ID, Session: clean(view.Label),
			Index: i + 1, Label: label, Detail: strings.Join(details, " · "), Panes: panes})
	}
	return result, nil
}

// Strip terminal escapes, control characters and the directory-focus mark.
func clean(s string) string {
	s = strings.Map(func(r rune) rune {
		if r == '\u2063' {
			return -1
		}
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, ansi.Strip(s))
	return strings.Join(strings.Fields(s), " ")
}

func (r *rexCLI) closeTab(id string) error {
	// Re-check ownership at the destructive boundary, including the current
	// pane if it moved since the picker opened. Never infer a target by number.
	snap, err := r.snapshot()
	if err != nil {
		return err
	}
	for _, t := range snap.Tabs {
		if t.ID == id {
			_, err = r.call("window", "close", "-s", t.SessionID, id)
			return err
		}
	}
	return fmt.Errorf("tab disappeared or hosts this picker; refreshed the list")
}

func (r *rexCLI) selectTab(id string) error {
	snap, err := r.snapshot()
	if err != nil {
		return err
	}
	for _, t := range snap.Tabs {
		if t.ID != id {
			continue
		}
		// Show the actual app tab first. If Remote Control is off, retain the
		// picker and show Rex's error instead of changing only server focus.
		args, _ := json.Marshal(map[string]string{"session_id": t.SessionID, "window_id": id})
		if _, err = r.call("do", "session.select", "--args", string(args), "--json"); err != nil {
			return err
		}
		_, err = r.call("focus", "-s", t.SessionID, id)
		return err
	}
	return fmt.Errorf("tab disappeared; select another tab")
}
