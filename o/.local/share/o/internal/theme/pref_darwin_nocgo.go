//go:build darwin && !cgo

package theme

import (
	"os/exec"
	"strings"
)

// pref reads a preference with defaults(1) where o was built without cgo
// (no Xcode command line tools): slower, and only at startup.
func pref(key, app string) string {
	if app == "" {
		app = "-g"
	}
	out, err := exec.Command("defaults", "read", app, key).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
