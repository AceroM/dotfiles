package main

import (
	"strings"
	"testing"
)

func TestAccountAndUploadCommandsAreUnavailable(t *testing.T) {
	for _, flag := range []string{"--sign-in", "--sign-out", "--sync"} {
		if _, err := parseCLI([]string{flag}); err == nil || !strings.Contains(err.Error(), "unknown option") {
			t.Fatalf("%s: %v", flag, err)
		}
	}
}

func TestLiteralAgentPromptsCanFollowDoubleDash(t *testing.T) {
	c, err := parseCLI([]string{"--", "--sync", "a literal task"})
	if err != nil || strings.Join(c.words, " ") != "--sync a literal task" {
		t.Fatal(c, err)
	}
}
