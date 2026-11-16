// Package drafts is o's drafts: prompts kept for later (^s), gone through
// with ^g.
//
//	$XDG_STATE_HOME/o/drafts.json        (else ~/.local/state/o)
//	$XDG_STATE_HOME/o/drafts/<id>/N.png  the file behind `[Image #N]`
//
// A draft belongs to the Rex session it was written in. The file is read
// fresh before each write and written whole (to a temp file, then renamed)
// under a lock, so two local prompts don't lose each other's drafts.
// The format is al's.
package drafts

import (
	"bytes"
	"encoding/json"

	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"o/internal/field"
)

// ReplyTo is the agent a reply goes to: its block, the tab it was in and
// what that tab was called, and its session ("" when unknown).
type ReplyTo struct {
	Pane, Tab, Label, Session string
}

type Draft struct {
	ID string
	// Workspace is the Rex session it was written in, Space its name (a new
	// session with the same name gets them too).
	Workspace, Space string
	// Cwd is where its agent starts.
	Cwd string
	// Text is the prompt, `[Image #N]` tags and all.
	Text string
	// Images is the file behind each tag: `[Image #N]` is Images[N-1].
	Images []string
	// Created is seconds since the epoch.
	Created int64
	// Reply: ⏎ sends it to this agent. Nil starts a new one in Cwd.
	Reply *ReplyTo
	// Kind is the kind of agent a new one is (claude, codex); "": the default.
	Kind string
	// Config is its configuration, by name (claude(fable)); without it, the
	// first configuration of Kind.
	Config string
	// Plan: it goes as `/plan …`.
	Plan bool
}

// Belongs reports whether it shows in the session ws named space.
func (d Draft) Belongs(ws, space string) bool {
	return d.Workspace == ws || (space != "" && d.Space == space)
}

// Equal compares every field.
func (d Draft) Equal(o Draft) bool {
	if d.ID != o.ID || d.Workspace != o.Workspace || d.Space != o.Space || d.Cwd != o.Cwd || d.Text != o.Text ||
		d.Created != o.Created || d.Kind != o.Kind || d.Config != o.Config || d.Plan != o.Plan || len(d.Images) != len(o.Images) {
		return false
	}
	for i := range d.Images {
		if d.Images[i] != o.Images[i] {
			return false
		}
	}
	if (d.Reply == nil) != (o.Reply == nil) {
		return false
	}
	return d.Reply == nil || *d.Reply == *o.Reply
}

// Clone is a copy that shares nothing with d.
func (d Draft) Clone() Draft {
	d.Images = append([]string(nil), d.Images...)
	if d.Reply != nil {
		r := *d.Reply
		d.Reply = &r
	}
	return d
}

// The JSON, keys in order as serde_json writes them.
type replyJSON struct {
	Label   string  `json:"label"`
	Pane    string  `json:"pane"`
	Session *string `json:"session"`
	Tab     string  `json:"tab"`
}

type draftJSON struct {
	Config    *string    `json:"config"`
	Created   int64      `json:"created"`
	Cwd       string     `json:"cwd"`
	ID        string     `json:"id"`
	Images    []string   `json:"images"`
	Kind      *string    `json:"kind"`
	Plan      bool       `json:"plan"`
	Reply     *replyJSON `json:"reply"`
	Space     string     `json:"space"`
	Text      string     `json:"text"`
	Workspace string     `json:"workspace"`
}

func opt(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func (d Draft) toJSON() draftJSON {
	j := draftJSON{Config: opt(d.Config), Created: d.Created, Cwd: d.Cwd, ID: d.ID, Images: d.Images, Kind: opt(d.Kind), Plan: d.Plan, Space: d.Space, Text: d.Text, Workspace: d.Workspace}
	if j.Images == nil {
		j.Images = []string{}
	}
	if d.Reply != nil {
		j.Reply = &replyJSON{Label: d.Reply.Label, Pane: d.Reply.Pane, Session: opt(d.Reply.Session), Tab: d.Reply.Tab}
	}
	return j
}

// fromJSON reads one draft as al writes it: an id, a cwd and a text at
// least; nil for anything else.
func fromJSON(raw json.RawMessage) *Draft {
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil {
		return nil
	}
	str := func(k string) (string, bool) {
		var s string
		if v, ok := m[k]; ok && json.Unmarshal(v, &s) == nil {
			return s, true
		}
		return "", false
	}
	id, ok1 := str("id")
	cwd, ok2 := str("cwd")
	text, ok3 := str("text")
	if !ok1 || !ok2 || !ok3 {
		return nil
	}
	d := &Draft{ID: id, Cwd: cwd, Text: text}
	d.Workspace, _ = str("workspace")
	d.Space, _ = str("space")
	d.Kind, _ = str("kind")
	d.Config, _ = str("config")
	if v, ok := m["images"]; ok {
		var list []any
		if json.Unmarshal(v, &list) == nil {
			for _, p := range list {
				if s, ok := p.(string); ok {
					d.Images = append(d.Images, s)
				}
			}
		}
	}
	if v, ok := m["created"]; ok {
		var n float64
		if json.Unmarshal(v, &n) == nil && n >= 0 {
			d.Created = int64(n)
		}
	}
	if v, ok := m["plan"]; ok {
		_ = json.Unmarshal(v, &d.Plan)
	}
	if v, ok := m["reply"]; ok {
		var r map[string]any
		if json.Unmarshal(v, &r) == nil && r != nil {
			if pane, ok := r["pane"].(string); ok {
				rt := &ReplyTo{Pane: pane}
				rt.Tab, _ = r["tab"].(string)
				rt.Label, _ = r["label"].(string)
				rt.Session, _ = r["session"].(string)
				d.Reply = rt
			}
		}
	}
	return d
}

// StateDir is o's state folder.
func StateDir() string {
	base := os.Getenv("XDG_STATE_HOME")
	if base == "" {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, ".local/state")
	}
	return filepath.Join(base, "o")
}

// File is the drafts file.
func File() string { return filepath.Join(StateDir(), "drafts.json") }

// ImageDir is where draft id keeps its images.
func ImageDir(id string) string { return filepath.Join(StateDir(), "drafts", id) }

// Stamp is when the file last changed (zero when it isn't there): it's
// read again when this moves.
func Stamp() time.Time {
	fi, err := os.Stat(File())
	if err != nil {
		return time.Time{}
	}
	return fi.ModTime()
}

// Load is every draft, newest first.
func Load() []Draft {
	b, err := os.ReadFile(File())
	if err != nil {
		return nil
	}
	return parse(b)
}

func parse(b []byte) []Draft {
	var v struct {
		Drafts []json.RawMessage `json:"drafts"`
	}
	if json.Unmarshal(b, &v) != nil {
		return nil
	}
	var out []Draft
	for _, raw := range v.Drafts {
		if d := fromJSON(raw); d != nil {
			out = append(out, *d)
		}
	}
	return out
}

// Encode is the file's body for all, as serde_json's to_string_pretty
// writes it.
func Encode(all []Draft) ([]byte, error) {
	list := make([]draftJSON, 0, len(all))
	for _, d := range all {
		list = append(list, d.toJSON())
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(map[string]any{"drafts": list}); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

func store(all []Draft) error {
	path := File()
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("%s: %w", dir, err)
	}
	body, err := Encode(all)
	if err != nil {
		return err
	}
	tmp := filepath.Join(dir, fmt.Sprintf(".drafts.json.%d", os.Getpid()))
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return fmt.Errorf("%s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	return nil
}

// lock holds drafts.lock while the file is read and written again. A lock
// that can't be taken (no folder yet, an odd filesystem) doesn't stop the
// write: the file is still written whole, as it always was.
func lock() func() {
	dir := StateDir()
	_ = os.MkdirAll(dir, 0o755)
	f, err := os.OpenFile(filepath.Join(dir, "drafts.lock"), os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return func() {}
	}
	if syscall.Flock(int(f.Fd()), syscall.LOCK_EX) != nil {
		f.Close()
		return func() {}
	}
	return func() {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		f.Close()
	}
}

// Update reads every draft fresh, lets change rewrite the list, and writes
// it back, all under the lock. change returning false writes nothing.
func Update(change func([]Draft) ([]Draft, bool)) error {
	defer lock()()
	all, ok := change(Load())
	if !ok {
		return nil
	}
	return store(all)
}

// Put adds d, or replaces the draft with its id where it stands.
func Put(d Draft) error {
	return Update(func(all []Draft) ([]Draft, bool) {
		for i := range all {
			if all[i].ID == d.ID {
				all[i] = d
				return all, true
			}
		}
		return append([]Draft{d}, all...), true
	})
}

// Remove takes drafts ids out, in one write. Their images stay a while
// (Sweep takes the folders after three days): `u` brings a deleted draft
// back, and a draft's agent reads them after it runs.
func Remove(ids ...string) error {
	err := Update(func(all []Draft) ([]Draft, bool) {
		out := all[:0]
		for _, d := range all {
			if !contains(ids, d.ID) {
				out = append(out, d)
			}
		}
		return out, true
	})
	if err != nil {
		return err
	}
	for _, id := range ids {
		MarkLeft(id)
	}
	return nil
}

// MarkLeft touches a removed draft's image folder: a sweep counts its days
// from now.
func MarkLeft(id string) { _ = os.WriteFile(filepath.Join(ImageDir(id), ".left"), nil, 0o644) }

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// Tagged is an image the text still tags: `[Image #N]` and its file.
type Tagged struct {
	N    int
	Path string
}

// TaggedImages is the images text still tags, by number.
func TaggedImages(text string, images []string) []Tagged {
	var out []Tagged
	for _, n := range field.TagNums(text) {
		if n >= 1 && n <= len(images) && images[n-1] != "" {
			out = append(out, Tagged{n, images[n-1]})
		}
	}
	return out
}

// ---- several as one ----------------------------------------------------------

// preamble goes before the tasks when marked drafts go as one prompt
// ({n}: how many there are).
const preamble = `Here are {n} tasks, drafted one at a time and sent together. Do all of them in this session.

- Read every task before starting. Where two touch the same code, or one depends on another, plan them together and pick the order; otherwise go in the order given.
- Treat each as its own piece of work: finish it and check it before moving to the next.
- Don't stop between tasks to ask. If one is blocked or unclear, make the reasonable call (or skip it and say why) and keep going.
- Finish with a short report, a few lines per task: what changed and where, how you checked it, and anything left open.`

// elsewhere is said too when a task was written in another folder than
// the first's, where the agent starts.
const elsewhere = "- A task written in another folder names it in its heading: do that one there."

// Combine is drafts ds as one prompt, for one agent started in the first
// one's folder: the preamble, then each as `## Task i of n`. Their
// `[Image #N]` tags are numbered again across all of them; the files come
// back in that order (a tag with no file reads `[missing image]`).
func Combine(ds []Draft) (string, []string) {
	if len(ds) == 0 {
		return "", nil
	}
	first := ds[0]
	var images []string
	var out strings.Builder
	out.WriteString(strings.ReplaceAll(preamble, "{n}", fmt.Sprint(len(ds))))
	for _, d := range ds {
		if d.Cwd != first.Cwd {
			out.WriteString("\n" + elsewhere)
			break
		}
	}
	for i, d := range ds {
		fmt.Fprintf(&out, "\n\n## Task %d of %d", i+1, len(ds))
		if d.Cwd != first.Cwd {
			fmt.Fprintf(&out, " (in %s)", Tilde(d.Cwd))
		}
		out.WriteString("\n\n")
		out.WriteString(renumber(strings.TrimSpace(d.Text), d.Images, &images))
	}
	return out.String(), images
}

// renumber is text with each `[Image #N]` (the Nth of own) numbered as it
// lands in all, which it's added to.
func renumber(text string, own []string, all *[]string) string {
	var out strings.Builder
	seen := map[int]int{}
	at := 0
	for _, t := range field.ImageTags(text) {
		out.WriteString(text[at:t.R.Start])
		to, ok := seen[t.N]
		if !ok && t.N >= 1 && t.N <= len(own) {
			*all = append(*all, own[t.N-1])
			to, ok = len(*all), true
			seen[t.N] = to
		}
		if ok {
			fmt.Fprintf(&out, "[Image #%d]", to)
		} else {
			out.WriteString("[missing image]")
		}
		at = t.R.End
	}
	out.WriteString(text[at:])
	return out.String()
}

// Summary is how a combined send is echoed: how many, then each one's
// first line.
func Summary(ds []Draft) string {
	s := fmt.Sprintf("%d drafts as one prompt", len(ds))
	for i, d := range ds {
		s += fmt.Sprintf("\n%d. %s", i+1, field.FirstLine(d.Text))
	}
	return s
}

// Tilde is path with the home folder as `~`.
func Tilde(path string) string {
	home, _ := os.UserHomeDir()
	if home == "" {
		return path
	}
	if path == home {
		return "~"
	}
	if strings.HasPrefix(path, home+"/") {
		return "~/" + path[len(home)+1:]
	}
	return path
}

// Untilde is Tilde undone, with this computer's home.
func Untilde(path string) string {
	home, _ := os.UserHomeDir()
	if path == "~" {
		return home
	}
	if strings.HasPrefix(path, "~/") {
		return filepath.Join(home, path[2:])
	}
	return path
}

var seq atomic.Uint64

// NewID is a new draft's id: the time and this o's count, in base 36.
func NewID() string {
	ms := uint64(time.Now().UnixMilli())
	return base36(ms) + "-" + base36(uint64(os.Getpid())) + "-" + base36(seq.Add(1)-1)
}

func base36(n uint64) string {
	const digits = "0123456789abcdefghijklmnopqrstuvwxyz"
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{digits[n%36]}, b...)
		n /= 36
	}
	return string(b)
}

// Now is seconds since the epoch.
func Now() int64 { return time.Now().Unix() }

// KeepImages copies the images text still tags into draft id's folder, so
// they last as long as it does (a pasted image lives in $TMPDIR, which
// macOS empties). Returns the list with the copies in place; a file that
// can't be copied keeps its old path.
func KeepImages(id, text string, images []string) []string {
	dir := ImageDir(id)
	out := append([]string(nil), images...)
	for _, t := range field.ImageTags(text) {
		i := t.N - 1
		if i < 0 || i >= len(out) || out[i] == "" || strings.HasPrefix(out[i], dir+"/") {
			continue
		}
		ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(out[i]), "."))
		if ext == "" {
			ext = "png"
		}
		to := filepath.Join(dir, fmt.Sprintf("%d.%s", t.N, ext))
		if os.MkdirAll(dir, 0o755) == nil && copyFile(out[i], to) == nil {
			out[i] = to
		}
	}
	return out
}

func copyFile(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := to + ".tmp"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err = io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err = out.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, to)
}

// Sweep deletes image folders no draft has used for three days (al's). In
// a goroutine, at start.
func Sweep() {
	const age = 3 * 24 * time.Hour
	ids := map[string]bool{}
	for _, d := range Load() {
		ids[d.ID] = true
	}
	entries, err := os.ReadDir(filepath.Join(StateDir(), "drafts"))
	if err != nil {
		return
	}
	for _, e := range entries {
		fi, err := e.Info()
		if err == nil && time.Since(fi.ModTime()) > age && !ids[e.Name()] {
			_ = os.RemoveAll(filepath.Join(StateDir(), "drafts", e.Name()))
		}
	}
}
