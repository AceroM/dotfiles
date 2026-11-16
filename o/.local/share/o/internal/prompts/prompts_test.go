package prompts

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDirectoryInheritanceAndLocalOverride(t *testing.T) {
	root := t.TempDir()
	child := filepath.Join(root, "app", "src")
	sibling := filepath.Join(root, "other")
	for _, d := range []string{child, sibling} {
		if err := os.MkdirAll(d, 0755); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := Save(root, "review", "Parent review"); err != nil {
		t.Fatal(err)
	}
	if _, err := Save(child, "review", "Local review"); err != nil {
		t.Fatal(err)
	}
	if _, err := Save(child, "test", "Run relevant tests"); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		dir, want string
		count     int
	}{
		{child, "Local review", 2}, {sibling, "Parent review", 1}, {root, "Parent review", 1},
	} {
		cs, err := Load(tc.dir)
		if err != nil || len(cs) != tc.count || cs[0].Name != "review" || cs[0].Body != tc.want {
			t.Fatalf("%s: %+v, %v", tc.dir, cs, err)
		}
	}
}

func TestSaveValidationAtomicReplacementAndPlainMarkdown(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"", "../oops", "/tmp/oops", "nested/name", "Upper", "save", "edit", ".hidden", strings.Repeat("a", 65)} {
		if _, err := Save(dir, name, "body"); err == nil {
			t.Fatalf("accepted %q", name)
		}
	}
	for _, body := range []string{" \n", "\x00", "\xff", strings.Repeat("a", MaxBytes+1)} {
		if _, err := Save(dir, "review", body); err == nil {
			t.Fatal("accepted invalid body")
		}
	}
	path, err := Save(dir, "review-2", "  # Review\r\n\r\nKeep **Markdown**.  ")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	if string(b) != "# Review\n\nKeep **Markdown**.\n" {
		t.Fatal(string(b))
	}
	if _, err := Save(dir, "review-2", "Updated"); err != nil {
		t.Fatal(err)
	}
	cs, err := Load(dir)
	if err != nil || len(cs) != 1 || cs[0].Body != "Updated" {
		t.Fatal(cs, err)
	}
	entries, _ := os.ReadDir(Dir(dir))
	if len(entries) != 1 {
		t.Fatal("temporary files leaked", entries)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0600 {
		t.Fatal(info.Mode())
	}
}

func TestBadLocalFileShadowsParentAndNeverExpandsAsEmpty(t *testing.T) {
	root := t.TempDir()
	child := filepath.Join(root, "child")
	Save(root, "review", "parent")
	Save(child, "review", "child")
	if err := os.WriteFile(filepath.Join(Dir(child), "review.md"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	cs, err := Load(child)
	if err != nil || len(cs) != 1 || cs[0].Err == nil || cs[0].Body != "" {
		t.Fatal(cs, err)
	}
	// A broken symlink is also a local definition, not a reason to fall back.
	os.Remove(filepath.Join(Dir(child), "review.md"))
	os.Symlink(filepath.Join(child, "missing"), filepath.Join(Dir(child), "review.md"))
	cs, _ = Load(child)
	if len(cs) != 1 || cs[0].Err == nil {
		t.Fatal(cs)
	}
	// Saving replaces the link, leaving the target alone.
	if _, err := Save(child, "review", "fixed"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(child, "missing")); !os.IsNotExist(err) {
		t.Fatal(err)
	}
}

func TestSplitAndExpand(t *testing.T) {
	for _, tc := range []struct {
		text, name, rest string
		ok               bool
	}{
		{"/", "", "", true}, {"/review", "review", "", true},
		{"/review focus on auth\nthen tests", "review", "focus on auth\nthen tests", true},
		{"/save review\nPrompt\n\nMore", "save", "review\nPrompt\n\nMore", true},
		{"/tmp/file", "", "", false}, {"//review", "", "", false}, {"text /review", "", "", false},
	} {
		n, r, ok := Split(tc.text)
		if n != tc.name || r != tc.rest || ok != tc.ok {
			t.Fatalf("%q: %q %q %v", tc.text, n, r, ok)
		}
	}
	c := Command{Body: "Preamble"}
	if c.Expand("task") != "Preamble\n\ntask" || c.Expand("") != "Preamble\n\n" {
		t.Fatal(c)
	}
}

func TestMaxSizePresetRoundTripsAndOversizedFilesStayErrors(t *testing.T) {
	dir := t.TempDir()
	if _, err := Save(dir, "large", strings.Repeat("x", MaxBytes)); err != nil {
		t.Fatal(err)
	}
	cs, err := Load(dir)
	if err != nil || len(cs) != 1 || cs[0].Err != nil || len(cs[0].Body) != MaxBytes {
		t.Fatal("maximum prompt did not round trip", err)
	}
	if err := os.WriteFile(cs[0].Path, []byte(strings.Repeat("x", MaxBytes+2)), 0600); err != nil {
		t.Fatal(err)
	}
	cs, _ = Load(dir)
	if cs[0].Err == nil {
		t.Fatal("oversized prompt accepted")
	}
}
