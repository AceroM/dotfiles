package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The oversized-PR fallback must use the pushed commits, even when the head
// is absent locally. Exercise the fetch against a local origin.
func TestOversizedPR(t *testing.T) {
	// A caller running from a git hook may have exported its own worktree or index.
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(name, "GIT_") {
			t.Setenv(name, "") // restore the original value after the test
			if err := os.Unsetenv(name); err != nil {
				t.Fatal(err)
			}
		}
	}
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	origin := t.TempDir()
	git := func(dir string, args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-c", "user.name=Test", "-c", "user.email=test@example.org"}, args...)...)
		cmd.Dir = dir
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %q: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	git(origin, "init", "-q", "-b", "main")
	git(origin, "commit", "-q", "--allow-empty", "-m", "base")
	base := git(origin, "rev-parse", "HEAD")
	git(origin, "checkout", "-qb", "topic")
	if err := os.WriteFile(filepath.Join(origin, "file with spaces"), []byte("from the PR\n"), 0644); err != nil {
		t.Fatal(err)
	}
	git(origin, "add", ".")
	git(origin, "commit", "-qm", "change")
	head := git(origin, "rev-parse", "HEAD")
	git(origin, "update-ref", "refs/pull/7/head", head)
	checkout := t.TempDir()
	git(checkout, "clone", "-q", "--no-local", "--single-branch", "-b", "main", origin, ".")
	t.Setenv("GIT_DIR", filepath.Join(checkout, ".git"))
	t.Setenv("GIT_WORK_TREE", checkout)
	if err := exec.Command("git", "cat-file", "-e", head).Run(); err == nil {
		t.Fatal("test clone already contains the PR head")
	}

	bin := t.TempDir()
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("PR_REFS", strings.Join([]string{"7", "main", base, head}, "\t"))
	t.Setenv("PR_ERROR", "HTTP 406: too_large")
	gh := `#!/bin/sh
case "$1 $2" in
  "pr diff") echo "$PR_ERROR" >&2; exit 1 ;;
  "pr view")
    [ "$#" -eq 9 ] && [ "$3" = 7 ] && [ "$4" = -R ] && [ "$5" = org/repo ] && [ "$6" = --json ] || exit 2
    printf '%s\n' "$PR_REFS" ;;
  *) exit 2 ;;
esac
`
	if err := os.WriteFile(filepath.Join(bin, "gh"), []byte(gh), 0755); err != nil {
		t.Fatal(err)
	}
	args := []string{"7", "--patch", "-R", "org/repo"}
	diff, note, err := fetch("pr", args)
	if err != nil || !bytes.Contains(diff, []byte("+from the PR")) || !strings.Contains(note, "built locally") {
		t.Fatalf("large PR: got %q, %q, %v", diff, note, err)
	}
	if got := git(checkout, "rev-parse", "HEAD"); got != base {
		t.Fatalf("checkout moved to %s", got)
	}
	t.Setenv("PR_ERROR", "authentication failed")
	if _, _, err := fetch("pr", args); err == nil || err.Error() != "authentication failed" {
		t.Fatalf("wrong error for an ordinary gh failure: %v", err)
	}
}
