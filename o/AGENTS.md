# Public o

This package is a standalone Go prompt with local draft storage. Keep the
checked-in config and built-in defaults to Claude Opus/Fable and Codex Sol/Astra.
Changes from other checkouts must be selected and reviewed before copying:
do not bring in private services, account pairing, uploaders, credentials,
runtime state, or personal drafts.

The currently installed `o` may point at another checkout. Preserve its symlinks
and binary. Test this package with `O_HOME` set to its source directory and
isolated `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, and `XDG_CACHE_HOME` directories.

Run `go test ./...` and `go vet ./...` from `.local/share/o` after Go changes.
