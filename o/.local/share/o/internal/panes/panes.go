// Package panes is what Caps+N / ⌥⌘N shows over a pane (float-here in Rex's
// config): the images behind its `[Image #N]` tags, one small JSON file per
// Rex block in ~/.local/state/o/panes, always there (not $XDG_STATE_HOME)
// since Rex's config reads it too:
//
//	{"images":[{"n":1,"path":"/…/paste-….png"},…],"kind":"prompt"}
//
// prompt: o's own pane, the images the prompt tags now (the selected
// draft's, in the list), rewritten as they change and gone when there are
// none or o quits. sent: an agent's tab, the images o last sent it.
// `o --images BLOCK` (package viewer) draws them.
package panes

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"o/internal/drafts"
)

const (
	Prompt = "prompt"
	Sent   = "sent"
)

func Dir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local/state/o/panes")
}

// File is block's file: its ID without `block:` (Rex's config names it the
// same way), nothing that would leave the folder.
func File(block string) string {
	var id strings.Builder
	for _, c := range strings.TrimPrefix(block, "block:") {
		if c == '-' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') {
			id.WriteRune(c)
		}
	}
	return filepath.Join(Dir(), id.String()+".json")
}

// Write keeps images as block's, of kind; none: its file goes.
func Write(block, kind string, images []drafts.Tagged) { writeTo(File(block), kind, images) }

type entry struct {
	N    int    `json:"n"`
	Path string `json:"path"`
}

func writeTo(path, kind string, images []drafts.Tagged) {
	if len(images) == 0 {
		_ = os.Remove(path)
		return
	}
	list := make([]entry, len(images))
	for i, t := range images {
		list[i] = entry{t.N, t.Path}
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(struct {
		Images []entry `json:"images"`
		Kind   string  `json:"kind"`
	}{list, kind})
	// Whole or not at all: the viewer reads it as it changes.
	tmp := fmt.Sprintf("%s.%d.tmp", strings.TrimSuffix(path, ".json"), os.Getpid())
	if os.MkdirAll(filepath.Dir(path), 0o755) == nil && os.WriteFile(tmp, bytes.TrimSuffix(buf.Bytes(), []byte("\n")), 0o644) == nil {
		_ = os.Rename(tmp, path)
	}
}

// Read is a pane's file: its kind and images. False when it isn't there
// (or isn't one).
func Read(path string) (string, []drafts.Tagged, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", nil, false
	}
	var v struct {
		Kind   *string           `json:"kind"`
		Images []json.RawMessage `json:"images"`
	}
	if json.Unmarshal(b, &v) != nil || v.Images == nil {
		return "", nil, false
	}
	kind := Prompt
	if v.Kind != nil {
		kind = *v.Kind
	}
	var out []drafts.Tagged
	for _, raw := range v.Images {
		var e struct {
			N    *int    `json:"n"`
			Path *string `json:"path"`
		}
		if json.Unmarshal(raw, &e) == nil && e.N != nil && e.Path != nil && *e.N >= 0 {
			out = append(out, drafts.Tagged{N: *e.N, Path: *e.Path})
		}
	}
	return kind, out, true
}

// Sweep removes the files of panes long closed: three days untouched.
func Sweep() {
	entries, err := os.ReadDir(Dir())
	if err != nil {
		return
	}
	for _, e := range entries {
		if fi, err := e.Info(); err == nil && time.Since(fi.ModTime()) > 3*24*time.Hour {
			_ = os.Remove(filepath.Join(Dir(), e.Name()))
		}
	}
}
