package main

// The browser-use native host, straight over its unix socket: one JSON request per
// connection. The host relays to the browser-use extension, whose `switcher.*` commands
// (extension/switcher.js, shared with ctab, tk and tg) work on any tab and never attach the
// debugger. ct lists, closes and reopens.

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type host struct {
	socket string
	// "Google Chrome", "Helium", … as the extension reports it.
	browser string
}

func hostsDir() string {
	state := os.Getenv("XDG_STATE_HOME")
	if state == "" {
		home, _ := os.UserHomeDir()
		state = filepath.Join(home, ".local", "state")
	}
	return filepath.Join(state, "browser-use", "hosts")
}

// pickHost finds the browser to talk to: the newest host that answers, or the newest whose
// browser name contains want (--browser, $BROWSER_USE_BROWSER).
func pickHost(want string) (*host, error) {
	type found struct {
		started float64
		h       host
	}
	var all []found
	entries, _ := os.ReadDir(hostsDir())
	for _, e := range entries {
		if filepath.Ext(e.Name()) != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(hostsDir(), e.Name()))
		if err != nil {
			continue
		}
		var v struct {
			Socket  string  `json:"socket"`
			Browser string  `json:"browser"`
			Started float64 `json:"started"`
		}
		if json.Unmarshal(data, &v) != nil || v.Socket == "" {
			continue
		}
		if v.Browser == "" {
			v.Browser = "browser"
		}
		all = append(all, found{v.Started, host{v.Socket, v.Browser}})
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].started > all[j].started })
	var names []string
	for _, f := range all {
		names = append(names, f.h.browser)
		if want != "" && !strings.Contains(strings.ToLower(f.h.browser), strings.ToLower(want)) {
			continue
		}
		// A browser that quit without cleaning up leaves its files: skip what doesn't answer.
		c, err := net.DialTimeout("unix", f.h.socket, time.Second)
		if err != nil {
			continue
		}
		c.Close()
		h := f.h
		return &h, nil
	}
	if want != "" && len(names) > 0 {
		return nil, fmt.Errorf("no connected browser matches %q (connected: %s)", want, strings.Join(names, ", "))
	}
	return nil, errors.New("no browser connected: is the browser-use extension loaded? (`browser-use status`)")
}

// call sends one request and returns its `result`, or the error's message.
func (h *host) call(cmd string, args any, timeout time.Duration) (json.RawMessage, error) {
	c, err := net.DialTimeout("unix", h.socket, timeout)
	if err != nil {
		return nil, fmt.Errorf("browser-use host: %w", err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(timeout))
	req, _ := json.Marshal(map[string]any{"cmd": cmd, "args": args, "owner": "ct"})
	if _, err := c.Write(append(req, '\n')); err != nil {
		return nil, fmt.Errorf("browser-use host: %w", err)
	}
	line, err := bufio.NewReader(c).ReadBytes('\n')
	if err != nil && len(line) == 0 {
		return nil, fmt.Errorf("%s: %w", cmd, err)
	}
	var resp struct {
		Result json.RawMessage `json:"result"`
		Error  *string         `json:"error"`
	}
	if err := json.Unmarshal(line, &resp); err != nil {
		return nil, fmt.Errorf("%s: %w", cmd, err)
	}
	if resp.Error != nil {
		if strings.HasPrefix(*resp.Error, "unknown command: switcher.") {
			return nil, errors.New("the browser-use extension is older than ct: run `browser-use reload`")
		}
		return nil, errors.New(*resp.Error)
	}
	return resp.Result, nil
}

func (h *host) name() string { return h.browser }

// list reads every tab, in tab-strip order: windows oldest first, then left to right.
func (h *host) list() (snapshot, error) {
	raw, err := h.call("switcher.tabs", map[string]any{}, 2*time.Second)
	if err != nil {
		return snapshot{}, err
	}
	var v struct {
		Windows []struct {
			ID        int64 `json:"id"`
			Focused   bool  `json:"focused"`
			Incognito bool  `json:"incognito"`
		} `json:"windows"`
		Groups []struct {
			ID       int64  `json:"id"`
			Title    string `json:"title"`
			Color    string `json:"color"`
			WindowID int64  `json:"windowId"`
		} `json:"groups"`
		Tabs []struct {
			ID           int64   `json:"id"`
			WindowID     int64   `json:"windowId"`
			Index        int64   `json:"index"`
			Title        string  `json:"title"`
			URL          string  `json:"url"`
			Active       bool    `json:"active"`
			Pinned       bool    `json:"pinned"`
			Audible      bool    `json:"audible"`
			Muted        bool    `json:"muted"`
			Discarded    bool    `json:"discarded"`
			Status       string  `json:"status"`
			GroupID      *int64  `json:"groupId"`
			LastAccessed float64 `json:"lastAccessed"`
		} `json:"tabs"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		return snapshot{}, fmt.Errorf("switcher.tabs: %w", err)
	}
	s := snapshot{Groups: map[int64]group{}}
	for _, w := range v.Windows {
		s.Windows = append(s.Windows, window{ID: w.ID, Focused: w.Focused, Incognito: w.Incognito})
	}
	sort.Slice(s.Windows, func(i, j int) bool { return s.Windows[i].ID < s.Windows[j].ID })
	for _, g := range v.Groups {
		s.Groups[g.ID] = group{Title: g.Title, Color: g.Color, Window: g.WindowID}
	}
	for _, t := range v.Tabs {
		g := int64(-1)
		if t.GroupID != nil {
			g = *t.GroupID
		}
		s.Tabs = append(s.Tabs, tab{
			ID: t.ID, Window: t.WindowID, Index: t.Index, Title: t.Title, URL: t.URL,
			Active: t.Active, Pinned: t.Pinned, Audible: t.Audible, Muted: t.Muted,
			Discarded: t.Discarded, Loading: t.Status == "loading", Group: g, Last: t.LastAccessed,
		})
	}
	s.sortStrip()
	return s, nil
}

// closeTabs closes them all in one call. Tabs that are already gone count as closed.
func (h *host) closeTabs(ids []int64) error {
	_, err := h.call("switcher.close", map[string]any{"tabs": ids}, 5*time.Second)
	return err
}

// reopen opens closed tabs again where they were: the new tabs' ids, and how many couldn't
// be opened.
func (h *host) reopen(tabs []gone) ([]int64, int, error) {
	want := make([]map[string]any, 0, len(tabs))
	for _, t := range tabs {
		want = append(want, map[string]any{"url": t.URL, "windowId": t.Window, "index": t.Index, "groupId": t.Group, "pinned": t.Pinned})
	}
	raw, err := h.call("switcher.reopen", map[string]any{"tabs": want}, 15*time.Second)
	if err != nil {
		return nil, 0, err
	}
	var v struct {
		Opened []int64           `json:"opened"`
		Failed []json.RawMessage `json:"failed"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, 0, fmt.Errorf("switcher.reopen: %w", err)
	}
	return v.Opened, len(v.Failed), nil
}

type tab struct {
	ID, Window, Index int64
	Title, URL        string
	// The tab its window is showing.
	Active, Pinned, Audible, Muted bool
	// Unloaded by Chrome to save memory.
	Discarded, Loading bool
	// -1 when ungrouped.
	Group int64
	// When it was last the active tab (ms since the epoch; 0 when unknown).
	Last float64
}

type group struct {
	Title, Color string
	Window       int64
}

type window struct {
	ID                 int64
	Focused, Incognito bool
}

type snapshot struct {
	Tabs    []tab
	Groups  map[int64]group
	Windows []window
}

func (s *snapshot) sortStrip() {
	pos := map[int64]int{}
	for i, w := range s.Windows {
		pos[w.ID] = i
	}
	at := func(id int64) int {
		if p, ok := pos[id]; ok {
			return p
		}
		return len(s.Windows)
	}
	sort.SliceStable(s.Tabs, func(i, j int) bool {
		a, b := s.Tabs[i], s.Tabs[j]
		if pa, pb := at(a.Window), at(b.Window); pa != pb {
			return pa < pb
		}
		return a.Index < b.Index
	})
}

// gone is a closed tab as it was: enough to put it back.
type gone struct {
	// The id it had (a reopened tab gets a new one).
	ID                   int64
	Title, URL           string
	Window, Index, Group int64
	Pinned               bool
}

func (t tab) displayTitle() string {
	if strings.TrimSpace(t.Title) == "" {
		return oneLine(t.URL)
	}
	return oneLine(t.Title)
}

// host is `github.com`, `localhost:3038`, `file` or `chrome://settings`.
func (t tab) host() string {
	u := t.URL
	if strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "http://") {
		h := u[strings.Index(u, "//")+2:]
		if i := strings.IndexAny(h, "/?#"); i >= 0 {
			h = h[:i]
		}
		return strings.TrimPrefix(h, "www.")
	}
	if strings.HasPrefix(u, "file://") {
		return "file"
	}
	if i := strings.IndexAny(u, "?#"); i >= 0 {
		u = u[:i]
	}
	segs := strings.SplitN(u, "/", 4)
	return strings.Join(segs[:min(3, len(segs))], "/")
}

// shortURL drops `https://`, `www.` and a bare trailing slash: `github.com/owner/repo/pull/12`.
func (t tab) shortURL() string {
	u := strings.TrimPrefix(strings.TrimPrefix(t.URL, "https://"), "http://")
	return oneLine(strings.TrimSuffix(strings.TrimPrefix(u, "www."), "/"))
}

// dupKey is the same for duplicates: the URL without its #fragment.
func (t tab) dupKey() string {
	k, _, _ := strings.Cut(t.URL, "#")
	return k
}

func (t tab) gone() gone {
	return gone{ID: t.ID, Title: t.displayTitle(), URL: t.URL, Window: t.Window, Index: t.Index, Group: t.Group, Pinned: t.Pinned}
}

// matches: every word is in the title or the URL, ignoring case.
func (t tab) matches(words []string) bool {
	if len(words) == 0 {
		return true
	}
	title, url := strings.ToLower(t.Title), strings.ToLower(t.URL)
	for _, w := range words {
		if !strings.Contains(title, w) && !strings.Contains(url, w) {
			return false
		}
	}
	return true
}
