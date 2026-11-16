package field

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

var (
	desktopOnce sync.Once
	desktopEnv  []string
)

// Desktop gives c the desktop's display where o's terminal has none (Linux).
// Rex's server can start at boot, before the desktop, and then its
// terminals have no WAYLAND_DISPLAY; this reads the desktop's from systemd,
// as the interactive shell's `_dots_agent_env` does for agents.
func Desktop(c *exec.Cmd) *exec.Cmd {
	if runtime.GOOS != "linux" {
		return c
	}
	desktopOnce.Do(func() {
		unset := func(k string) bool { return os.Getenv(k) == "" }
		if !unset("WAYLAND_DISPLAY") && !unset("DISPLAY") {
			return
		}
		out, err := exec.Command("systemctl", "--user", "show-environment").Output()
		if err != nil {
			return
		}
		for _, l := range strings.Split(string(out), "\n") {
			k, v, ok := strings.Cut(l, "=")
			if ok && (k == "WAYLAND_DISPLAY" || k == "DISPLAY" || k == "XDG_RUNTIME_DIR") && unset(k) {
				desktopEnv = append(desktopEnv, k+"="+v)
			}
		}
	})
	if len(desktopEnv) > 0 {
		if c.Env == nil {
			c.Env = os.Environ()
		}
		c.Env = append(c.Env, desktopEnv...)
	}
	return c
}

// ClipboardImage saves the clipboard's image under $TMPDIR/o: "" when
// there's no image. On Linux it's this machine's clipboard (wl-paste), so a
// Mac's Rex showing an Linux pane pastes Linux's, not the Mac's.
func ClipboardImage() string {
	dir := TmpDir()
	if os.MkdirAll(dir, 0o755) != nil {
		return ""
	}
	if runtime.GOOS == "darwin" {
		return macClipboardImage(dir)
	}
	return waylandClipboardImage(dir)
}

func macClipboardImage(dir string) string {
	path := filepath.Join(dir, fmt.Sprintf("paste-%d-%d.png", os.Getpid(), Stamp()))
	var c *exec.Cmd
	// pngpaste answers in ~60ms; AppleScript takes about a second.
	if Which("pngpaste") {
		c = exec.Command("pngpaste", path)
	} else {
		args := []string{}
		for _, l := range []string{
			"on run argv", "try", "set img to the clipboard as «class PNGf»", "on error", "error number 1", "end try",
			"set f to open for access (POSIX file (item 1 of argv)) with write permission", "set eof f to 0",
			"write img to f", "close access f", "end run",
		} {
			args = append(args, "-e", l)
		}
		c = exec.Command("osascript", append(args, path)...)
	}
	if c.Run() == nil {
		if fi, err := os.Stat(path); err == nil && fi.Size() > 0 {
			return path
		}
	}
	_ = os.Remove(path)
	return ""
}

func waylandClipboardImage(dir string) string {
	out, err := Desktop(exec.Command("wl-paste", "--list-types")).Output()
	if err != nil {
		return ""
	}
	types := strings.Split(string(out), "\n")
	// PNG if it's offered (screenshots and browsers offer it), else the first image o can read.
	ext := ""
	for _, e := range []string{"png", "jpeg", "gif", "webp"} {
		for _, t := range types {
			if strings.TrimSpace(t) == "image/"+e {
				ext = e
				break
			}
		}
		if ext != "" {
			break
		}
	}
	if ext == "" {
		return ""
	}
	name := ext
	if ext == "jpeg" {
		name = "jpg"
	}
	path := filepath.Join(dir, fmt.Sprintf("paste-%d-%d.%s", os.Getpid(), Stamp(), name))
	f, err := os.Create(path)
	if err != nil {
		return ""
	}
	c := Desktop(exec.Command("wl-paste", "--no-newline", "--type", "image/"+ext))
	c.Stdout = f
	err = c.Run()
	f.Close()
	if fi, e := os.Stat(path); err == nil && e == nil && fi.Size() > 0 {
		return path
	}
	_ = os.Remove(path)
	return ""
}
