# Ctrl-click file locations in Herdr

Hold **Control** and click a printed `path:line` or `path:line:column` in a
Codex or Claude pane. The file opens in a Neovim sibling in that same tab,
at the requested position, and Herdr focuses the editor. Line ranges jump
to their first line. Local OSC 8 `file://` hyperlinks also work.

Neovim registers its RPC socket during startup through
`lua/config/herdr_links.lua`. Existing editors can register without restarting:

```vim
:lua require("config.herdr_links").setup()
```

The plugin validates the live editor PID and pane identity before opening a
file. Relative paths first use the source pane's working directory, then a
sibling editor's working directory or Git root. This handles an agent in
`~/Numeral` beside an editor in `~/Numeral/tax-holiday`. Multiple matching
sibling checkouts produce an error rather than choosing a worktree arbitrarily.
Neovim preserves unsaved buffers and uses its usual rules when switching files.
Errors appear in Herdr notifications and `herdr plugin log list`.

## Local Herdr build

Stock Herdr v0.9.0 only recognizes HTTP URLs and explicit terminal hyperlinks
under Control-click. `file-links-v0.9.0.patch` adds file-location detection to
the existing click endpoint. It adds no protocol fields, scans only on a click,
retains HTTP behavior, and leaves non-link gestures alone.

The patched source is at `~/Code/herdr-custom`, pinned to upstream commit
`b99002ac99b09e00b4ca692436cb15a6b0d676f1` (v0.9.0). Rebuild with:

```sh
sh ~/.dotfiles/herdr/.config/herdr/plugins/nvim-links/build-herdr.sh
```

The build needs Rust 1.96.1 and Zig 0.15.2. Zig was installed locally at
`~/.local/share/herdr-build-tools/zig-aarch64-macos-0.15.2/zig`; `ZIG` can point
at another compatible installation. The script refuses a different source
revision and never resets the checkout or stops a server.

The installed patched binary is `~/.local/bin/herdr`. The original binary
is backed up at `~/.local/share/herdr-build-tools/herdr-0.9.0-original`.
Activation used the supported `server.live_handoff` socket API with protocol
22, after testing it in an isolated session. No manual server stop is required.

An ordinary `herdr update` can replace the custom binary. A newer upstream
release needs this feature built in or the patch reviewed and ported before
replacing the local build. Do not blindly apply this patch to a newer version.

The plugin is linked with:

```sh
herdr plugin link ~/.dotfiles/herdr/.config/herdr/plugins/nvim-links
```

Validation: three Rust file-location tests, existing URL/plugin and Ctrl-click
tests, Rust formatting and Clippy, four Python tests including live Neovim RPC,
and an isolated Herdr click/handoff test. The real sibling editor was also
verified opening `PhysicalPresence.tsx:709`, then restored to its original view.
