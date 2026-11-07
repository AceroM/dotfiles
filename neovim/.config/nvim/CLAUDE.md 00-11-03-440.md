# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a LazyVim-based Neovim configuration that extends the LazyVim starter template with custom plugins, themes, and configurations.

## Architecture

- **Plugin Manager**: Uses Lazy.nvim for plugin management
- **Base Framework**: Built on LazyVim with custom overrides
- **Configuration Structure**:
  - `init.lua`: Entry point that loads lazy.nvim configuration
  - `lua/config/`: Core configuration files (options, keymaps, autocmds)
  - `lua/plugins/`: Custom plugin configurations that override/extend LazyVim defaults
  - `lua/snippets/`: Custom snippet definitions

## Key Configuration Files

- `lua/config/lazy.lua`: Lazy.nvim setup and plugin specification
- `lua/config/options.lua`: Custom Neovim options (relative numbers, command height, etc.)
- `lua/config/keymaps.lua`: Custom key mappings and overrides
- `lazyvim.json`: LazyVim extras configuration (neo-tree, biome formatting)

## Development Commands

### Formatting
- **Stylua**: Lua code formatting configured via `stylua.toml`
  - Settings: 2 spaces indentation, 120 column width
  - Run with: `stylua .`

### Environment Management
- **Mise**: Tool version management via `mise.toml`
  - Node.js: Latest version

## Plugin Architecture

### Custom Plugin Overrides
The configuration follows LazyVim's plugin override pattern where plugins in `lua/plugins/` extend or replace default LazyVim behavior:

- `theme.lua`: Dynamic theme loading with fallback to rose-pine
- `completion.lua`: Blink.cmp configuration with LuaSnip integration  
- `typescript.lua`: VTSLS language server setup with TypeScript-specific keybindings
- `neo-tree.lua`: File explorer customizations
- `statusbar.lua`: Custom status line configuration

### Theme System
Uses a dynamic theme system that checks for external theme configuration at `/home/miguel/.config/omarchy/current/theme/neovim.lua` and falls back to rose-pine theme.

### Completion System  
Uses Blink.cmp for completion with:
- LuaSnip snippet engine integration
- Reduced trigger sensitivity (3+ character minimum)
- Custom keybindings for snippet navigation

### Language Server Configuration
- TypeScript: Uses VTSLS with enhanced features (move to file refactoring, import management)
- Formatting: Biome for JavaScript/TypeScript projects
- Inlay hints disabled by default

## Custom Key Mappings

- `<BS>`: Delete line to void register (normal/visual)
- `<CR>`: Insert new line below (normal)
- `<S-CR>`: Insert new line above
- `<C-a>`: Select entire file
- `'`: Close current buffer
- `<C-/>`: Toggle comment
- `<C-p>`: File picker (Snacks.picker)

## Configuration Patterns

When modifying this configuration:

1. **Plugin Overrides**: Add new plugins or override existing ones in `lua/plugins/`
2. **Options**: Extend options in `lua/config/options.lua` 
3. **Keymaps**: Add custom keymaps in `lua/config/keymaps.lua`
4. **LazyVim Extras**: Enable LazyVim extras via `lazyvim.json`
5. **Snippets**: Custom snippets go in `lua/snippets/`

## File Structure Notes

- `lazy-lock.json`: Plugin version lock file (auto-generated)
- `plugin/after/`: Neovim's after directory for late-loading configurations
- `mise.toml`: Development environment configuration
