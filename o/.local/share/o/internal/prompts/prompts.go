// Package prompts stores agent-independent slash prompts as directory-local Markdown.
package prompts

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

const MaxBytes = 1 << 20

type Command struct {
	Name, Body, Path string
	Err              error
}

func Dir(cwd string) string { return filepath.Join(cwd, ".o", "commands") }

// ValidName deliberately excludes paths and the two management commands.
func ValidName(name string) bool {
	if name == "" || len(name) > 64 || name == "save" || name == "edit" {
		return false
	}
	for i, c := range name {
		if c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || i > 0 && (c == '-' || c == '_') {
			continue
		}
		return false
	}
	return true
}

// Split takes only a slash at the start of the prompt. Absolute paths, // escapes,
// and slashes elsewhere are ordinary text. Rest is the task after the preamble.
func Split(text string) (name, rest string, ok bool) {
	if !strings.HasPrefix(text, "/") || strings.HasPrefix(text, "//") {
		return "", "", false
	}
	head, tail, _ := strings.Cut(text[1:], "\n")
	if i := strings.IndexFunc(head, unicode.IsSpace); i >= 0 {
		tail = head[i:] + "\n" + tail
		head = head[:i]
	}
	if head != "" && head != "save" && head != "edit" && !ValidName(head) {
		return "", "", false
	}
	return head, strings.TrimSpace(tail), true
}

func (c Command) Expand(task string) string {
	if task = strings.TrimSpace(task); task != "" {
		return c.Body + "\n\n" + task
	}
	return c.Body + "\n\n"
}

// Load walks outward, so the nearest definition wins (even if unreadable).
// Files stay plain Markdown: no provider frontmatter or executable templates.
func Load(cwd string) ([]Command, error) {
	abs, err := filepath.Abs(cwd)
	if err != nil {
		return nil, err
	}
	if real, e := filepath.EvalSymlinks(abs); e == nil {
		abs = real
	}
	seen := map[string]bool{}
	var commands []Command
	var issues []error
	for dir := abs; ; dir = filepath.Dir(dir) {
		entries, err := os.ReadDir(Dir(dir))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			issues = append(issues, fmt.Errorf("%s: %w", Dir(dir), err))
		}
		for _, entry := range entries {
			name := strings.TrimSuffix(entry.Name(), ".md")
			if entry.IsDir() || entry.Name() != name+".md" || !ValidName(name) || seen[name] {
				continue
			}
			seen[name] = true
			c := Command{Name: name, Path: filepath.Join(Dir(dir), entry.Name())}
			c.Body, c.Err = read(c.Path)
			commands = append(commands, c)
		}
		if parent := filepath.Dir(dir); parent == dir {
			break
		}
	}
	sort.Slice(commands, func(i, j int) bool { return commands[i].Name < commands[j].Name })
	return commands, errors.Join(issues...)
}

func read(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", errors.New("not a regular file")
	}
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	if info, err := f.Stat(); err != nil {
		return "", err
	} else if !info.Mode().IsRegular() {
		return "", errors.New("not a regular file")
	} else if info.Size() > MaxBytes+1 {
		return "", errors.New("prompt exceeds 1 MiB")
	}
	b, err := io.ReadAll(io.LimitReader(f, MaxBytes+2))
	if err != nil {
		return "", err
	}
	return body(strings.TrimSuffix(string(b), "\n"))
}

func body(text string) (string, error) {
	if len(text) > MaxBytes {
		return "", errors.New("prompt exceeds 1 MiB")
	}
	if !utf8.ValidString(text) || strings.ContainsRune(text, 0) {
		return "", errors.New("prompt must be UTF-8 text")
	}
	text = strings.TrimSpace(strings.ReplaceAll(text, "\r\n", "\n"))
	if text == "" {
		return "", errors.New("prompt is empty")
	}
	return text, nil
}

// Save atomically replaces a local command. Editing an inherited command creates
// a local override; its parent's file is never changed. Rename replaces symlinks.
func Save(cwd, name, text string) (string, error) {
	if !ValidName(name) {
		return "", errors.New("use 1–64 lowercase letters, digits, - or _; save and edit are reserved")
	}
	text, err := body(text)
	if err != nil {
		return "", err
	}
	dir := Dir(cwd)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", err
	}
	f, err := os.CreateTemp(dir, ".prompt-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(f.Name())
	if _, err = f.WriteString(text + "\n"); err != nil {
		f.Close()
		return "", err
	}
	if err = f.Close(); err != nil {
		return "", err
	}
	path := filepath.Join(dir, name+".md")
	if err = os.Rename(f.Name(), path); err != nil {
		return "", err
	}
	return path, nil
}
