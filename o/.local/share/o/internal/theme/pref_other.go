//go:build !darwin

package theme

// pref: Linux has no such store, nor Rex's app bundle, so inside Rex o
// draws in One Dark here.
func pref(key, app string) string { return "" }
