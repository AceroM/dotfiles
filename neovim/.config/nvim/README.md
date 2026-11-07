# 💤 LazyVim

A starter template for [LazyVim](https://github.com/LazyVim/LazyVim).
Refer to the [documentation](https://lazyvim.github.io/installation) to get started.

## Rust

Rust support uses LazyVim's Rust and DAP extras: rust-analyzer through rustaceanvim,
Rust syntax highlighting, Cargo.toml dependency completion/actions through crates.nvim,
and CodeLLDB with the debugger UI. rustaceanvim stays on v8 for Neovim 0.11 compatibility.

Install the toolchain components on each machine (and for any project-pinned toolchain):

```sh
rustup component add rust-analyzer rust-src rustfmt clippy
```

Restart Neovim after changing the config; Lazy installs the plugins and Mason installs
CodeLLDB. Rust formatting on save uses rust-analyzer's rustfmt integration and respects
the project's rustfmt.toml. Clippy checks on save include tests and skip dependency lints.
Editor checks use a separate target directory to avoid blocking terminal Cargo builds;
this uses extra disk space. Cargo's default features are respected instead of enabling
every optional feature. Existing inlay-hint preferences still apply (`<leader>uh` toggles).

Rust buffer shortcuts (`<leader>` is Space):

| Shortcut | Action |
| --- | --- |
| `<leader>cr` | Choose a runnable (binary, example, test) |
| `<leader>ct` | Choose a test |
| `<leader>cm` | Expand macro under cursor |
| `<leader>cR` | Rust code actions |
| `<leader>dr` | Choose a target to debug |
| `<leader>db` | Toggle breakpoint |
| `<leader>dc` | Start/continue debugging |
| `<leader>du` | Toggle debugger UI |

Use `:checkhealth rustaceanvim` to check the Rust setup and `:ConformInfo` to inspect
formatting. For project-specific analyzer settings, see `:help rustaceanvim.config`.
