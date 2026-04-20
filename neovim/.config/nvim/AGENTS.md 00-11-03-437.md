# AGENTS.md - Neovim Configuration

## Build/Lint/Test Commands
- **Format**: `stylua .` (if available) - formats Lua files according to stylua.toml
- **No standard test suite** - this is a Neovim configuration, not a testable codebase
- **Validation**: Start nvim and check for errors: `nvim --headless -c "q"`

## Code Style Guidelines
- **Indentation**: 2 spaces (per stylua.toml)
- **Line length**: 120 characters max
- **File structure**: Follow LazyVim plugin structure in `lua/plugins/`
- **Plugin format**: Return table with plugin spec: `return { "plugin/name", opts = {} }`
- **Comments**: Use `--` for single line, avoid unnecessary comments
- **Naming**: snake_case for variables/functions, kebab-case for files
- **Imports**: Use `require()` at top of files, lazy load plugins when possible
- **Error handling**: Use vim.notify() for user messages, pcall() for risky operations
- **Options**: Configure via `opts` table in plugin specs, not direct vim.opt calls in plugins
- **Keymaps**: Define in lua/config/keymaps.lua or plugin-specific opts.keys
- **Autocmds**: Define in lua/config/autocmds.lua or plugin-specific opts.init

## Project Structure
- `init.lua` - Entry point, loads config.lazy
- `lua/config/` - Core configuration (options, keymaps, autocmds)
- `lua/plugins/` - Plugin specifications following LazyVim conventions
- `stylua.toml` - Lua formatting configuration