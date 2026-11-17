package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const sampleView = `{"session_id":"session:test","label":"code","windows":[
 {"window_id":"window:a","label":"current","layers":[
  {"kind":"tiled","blocks":[{"block_id":"block:origin","label":"shell"}]},
  {"kind":"floating","blocks":[{"block_id":"block:picker","label":"rt"}]}]},
 {"window_id":"window:b","label":"work\u2063","layers":[
  {"kind":"tiled","blocks":[{"block_id":"block:b","creator_name":"com.superlogical.terminal","label":"~/Code  fix\nlogin"},
   {"block_id":"block:c","creator_name":"com.superlogical.terminal","label":"\u001b[31mred\u001b[0m"}]},
  {"kind":"floating","blocks":[{"block_id":"block:other","label":"scratch"}]}]},
 {"window_id":"window:c","label":"","layers":[{"kind":"tiled","blocks":[
  {"block_id":"block:d","label":"shell"}]}]}]}`

func TestSnapshotExcludesHostAndKeepsShellTabs(t *testing.T) {
	for _, block := range []string{"block:origin", "block:picker"} {
		s, err := parseSnapshot([]byte(sampleView), block)
		if err != nil {
			t.Fatal(err)
		}
		if len(s.Tabs) != 2 || s.Tabs[0].ID != "window:b" || s.Tabs[0].Index != 2 {
			t.Fatal(s)
		}
		if s.Tabs[0].Label != "work" || s.Tabs[0].Detail != "~/Code fix login · red" || s.Tabs[0].Panes != 2 {
			t.Fatal(s.Tabs[0])
		}
		if s.Tabs[1].Label != "Tab 3" {
			t.Fatal("shell tab was lost")
		}
	}
}

func TestCloseRevalidatesHostAndUsesExactID(t *testing.T) {
	dir := t.TempDir()
	log := filepath.Join(dir, "calls")
	view := filepath.Join(dir, "view.json")
	if err := os.WriteFile(view, []byte(sampleView), 0600); err != nil {
		t.Fatal(err)
	}
	script := "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$RT_TEST_LOG\"\ncase \"$*\" in *'session inspect'*) cat \"$RT_TEST_VIEW\" ;; esac\n"
	if err := os.WriteFile(filepath.Join(dir, "rex"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("RT_TEST_LOG", log)
	t.Setenv("RT_TEST_VIEW", view)
	r := rexCLI{ctx: context.Background(), session: "session:test", block: "block:picker", current: true}
	if r.closeTab("window:a") == nil {
		t.Fatal("allowed closing the host")
	}
	if r.closeTab("window:missing") == nil {
		t.Fatal("allowed stale target")
	}
	if err := r.closeTab("window:b"); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(log)
	if strings.Count(string(data), "window close") != 1 || !strings.Contains(string(data), "window close -s session:test window:b") {
		t.Fatal("wrong close calls:", string(data))
	}
}

func TestAllSessionsTargetTheOwningSession(t *testing.T) {
	dir := t.TempDir()
	log := filepath.Join(dir, "calls")
	files := map[string]string{
		"sessions.json": `{"sessions":[{"session_id":"session:test"},{"session_id":"session:other"}]}`,
		"test.json":     sampleView,
		"other.json": `{"session_id":"session:other","label":"servers","windows":[
          {"window_id":"window:z","label":"web","focused_block_id":"block:editor","layers":[{"kind":"tiled","blocks":[
          {"block_id":"block:z","label":"~/Code/web"},{"block_id":"block:editor","label":"editor"}]}]}]}`,
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	script := `#!/bin/sh
printf '%s\n' "$*" >> "$RT_TEST_DIR/calls"
case "$*" in
  *'ls --json'*) cat "$RT_TEST_DIR/sessions.json" ;;
  *'session inspect session:test'*) cat "$RT_TEST_DIR/test.json" ;;
  *'session inspect session:other'*) cat "$RT_TEST_DIR/other.json" ;;
  *'do -e'*) printf '%s\n' '[{"block_id":"block:b","state":"working","effective_app":"codex","updated_at":"2026-11-17T15:00:00Z"},{"block_id":"block:c","state":"done","updated_at":"2026-11-17T16:00:00Z"}]' ;;
  *'block inspect -s session:other block:editor --json'*) printf '%s\n' '{"block":{"window_id":"window:z"}}' ;;
  *'do session.select'*)
    if [ "$RT_TEST_REFUSE" = 1 ]; then
      echo 'Rex.app is not accepting actions. Turn on Remote Control.' >&2
      exit 1
    fi ;;
esac
`
	if err := os.WriteFile(filepath.Join(dir, "rex"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("RT_TEST_DIR", dir)
	r := rexCLI{ctx: context.Background(), session: "session:test", block: "block:picker"}
	snap, err := r.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Tabs) != 3 || snap.Tabs[2].Session != "servers" || snap.Tabs[2].Index != 3 {
		t.Fatal("sessions were not combined in order", snap)
	}
	if row := snap.Tabs[0]; row.activity.State != "working" || row.activity.App != "codex" || row.pane != (pane{id: "block:b", label: "~/Code fix login"}) {
		t.Fatal("expected the working pane to represent the split tab", row)
	}
	if err := r.closeTab("window:z"); err != nil {
		t.Fatal(err)
	}
	if err := r.focusPane(snap.Tabs[2]); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(log)
	for _, expected := range []string{"window close -s session:other window:z",
		`"session_id":"session:other","window_id":"window:z"`, "focus -s session:other -w window:z block:editor"} {
		if !strings.Contains(string(data), expected) {
			t.Fatalf("missing %q in %s", expected, data)
		}
	}
	// A refused client action must not silently move only the server's focus.
	if err := os.WriteFile(log, nil, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("RT_TEST_REFUSE", "1")
	if err := r.focusPane(snap.Tabs[2]); err == nil || !strings.Contains(err.Error(), "Remote Control") {
		t.Fatal("lost client error", err)
	}
	data, _ = os.ReadFile(log)
	if strings.Contains(string(data), "focus -s") {
		t.Fatal("moved focus after refusal")
	}
}

func TestCopyIDsOnlyFromSelectedPane(t *testing.T) {
	dir := t.TempDir()
	clipboard := filepath.Join(dir, "clipboard")
	scripts := map[string]string{
		"rex":    `printf '%s\n' '{"block":{"window_id":"window:target"}}'`,
		"pbcopy": `cat > "$RT_TEST_CLIPBOARD"`,
		"rex-agent-id": `[ "$*" = '-s session:target -b block:target --json' ] || exit 1
printf '{"block_id":"%s","session_id":"example-agent-session"}\n' "$RT_TEST_AGENT_PANE"`,
	}
	for name, body := range scripts {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+body+"\n"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("RT_TEST_CLIPBOARD", clipboard)
	t.Setenv("RT_TEST_AGENT_PANE", "block:target")
	r := rexCLI{ctx: context.Background()}
	row := tab{ID: "window:target", SessionID: "session:target", pane: pane{id: "block:target"}}
	for _, test := range []struct {
		agent bool
		want  string
	}{{false, "block:target"}, {true, "example-agent-session"}} {
		if err := r.copyID(row, test.agent); err != nil {
			t.Fatal(err)
		}
		if got, err := os.ReadFile(clipboard); err != nil || string(got) != test.want {
			t.Fatalf("clipboard = %q, %v; want %q", got, err, test.want)
		}
	}
	// A helper fallback must never copy an agent from a different pane.
	t.Setenv("RT_TEST_AGENT_PANE", "block:sibling")
	if err := r.copyID(row, true); err == nil {
		t.Fatal("copied the sibling's agent session")
	}
	if got, err := os.ReadFile(clipboard); err != nil || string(got) != "example-agent-session" {
		t.Fatalf("failed copy changed the clipboard: %q, %v", got, err)
	}
}
