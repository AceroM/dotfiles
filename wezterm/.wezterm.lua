local wezterm = require("wezterm")
local config = wezterm.config_builder()

local function get_appearance()
	if wezterm.gui then
		return wezterm.gui.get_appearance()
	end
	return "Dark"
end

local function scheme_for_appearance(appearance)
	if appearance:find("Light") then
		return "Alabaster"
	else
		return "Abernathy"
	end
end

local function window_frame_for_appearance(appearance)
	if appearance:find("Light") then
		return {
			active_titlebar_bg = "#e0e0e0",
			inactive_titlebar_bg = "#e0e0e0",
		}
	else
		return {
			active_titlebar_bg = "#1a1a1a",
			inactive_titlebar_bg = "#1a1a1a",
		}
	end
end

local function tab_bar_colors_for_appearance(appearance)
	if appearance:find("Light") then
		return {
			background = "#e0e0e0",
			active_tab = {
				bg_color = "#f0f0f0",
				fg_color = "#333333",
			},
			inactive_tab = {
				bg_color = "#d0d0d0",
				fg_color = "#666666",
			},
			inactive_tab_hover = {
				bg_color = "#c0c0c0",
				fg_color = "#333333",
			},
			new_tab = {
				bg_color = "#e0e0e0",
				fg_color = "#666666",
			},
			new_tab_hover = {
				bg_color = "#c0c0c0",
				fg_color = "#333333",
			},
		}
	else
		return nil -- use color scheme defaults for dark mode
	end
end

local function update_claude_theme(appearance)
	local home = os.getenv("HOME")
	local claude_json_path = home .. "/.claude.json"

	-- Read existing file
	local file = io.open(claude_json_path, "r")
	if not file then
		return
	end
	local content = file:read("*a")
	file:close()

	local theme = appearance:find("Light") and "light" or "dark"

	-- Update or add theme key using pattern matching
	local new_content
	if content:match('"theme"%s*:%s*"[^"]*"') then
		new_content = content:gsub('"theme"%s*:%s*"[^"]*"', '"theme": "' .. theme .. '"')
	else
		-- Add theme after opening brace
		new_content = content:gsub("^{", '{\n  "theme": "' .. theme .. '",')
	end

	-- Write back only if changed
	if new_content ~= content then
		file = io.open(claude_json_path, "w")
		if file then
			file:write(new_content)
			file:close()
		end
	end
end

-- Set initial theme
local appearance = get_appearance()
config.color_scheme = scheme_for_appearance(appearance)
config.window_frame = window_frame_for_appearance(appearance)
local tab_colors = tab_bar_colors_for_appearance(appearance)
if tab_colors then
	config.colors = { tab_bar = tab_colors }
end
update_claude_theme(appearance)

-- Watch for appearance changes
wezterm.on("window-config-reloaded", function(window, pane)
	local overrides = window:get_config_overrides() or {}
	local current_appearance = window:get_appearance()
	local scheme = scheme_for_appearance(current_appearance)

	if overrides.color_scheme ~= scheme then
		overrides.color_scheme = scheme
		overrides.window_frame = window_frame_for_appearance(current_appearance)
		local tab_colors = tab_bar_colors_for_appearance(current_appearance)
		if tab_colors then
			overrides.colors = { tab_bar = tab_colors }
		else
			overrides.colors = nil
		end
		window:set_config_overrides(overrides)
		update_claude_theme(current_appearance)
	end
end)

config.show_tab_index_in_tab_bar = true

wezterm.on("format-tab-title", function(tab, tabs, panes, cfg, hover, max_width)
	return tab.tab_index + 1
end)

config.font = wezterm.font("Berkeley Mono", { weight = "Regular", italic = false })

config.font_rules = {
	{
		intensity = "Normal",
		italic = true,
		font = wezterm.font("Berkeley Mono", { weight = "Regular", italic = false }),
	},
	{
		intensity = "Bold",
		italic = true,
		font = wezterm.font("Berkeley Mono", { weight = "DemiBold", italic = false }),
	},
	{
		intensity = "Half",
		italic = true,
		font = wezterm.font("Berkeley Mono", { weight = "ExtraLight", italic = false }),
	},
}

-- This is where you actually apply your config choices.
-- For example, changing the initial geometry for new windows:
config.initial_cols = 120
config.initial_rows = 28
-- Font size configuration
config.font_size = 15
config.window_decorations = "RESIZE"
-- Theme is now set dynamically based on system appearance (see top of file)
-- Light: Abernathy, Dark: Catppuccin Mocha
-- config.window_frame = theme.window_frame() -- needed only if using fancy tab bar

config.keys = {
	{
		key = "Enter",
		mods = "SHIFT",
		action = wezterm.action_callback(function(window, pane)
			local process = pane:get_foreground_process_name() or ""

			if process:match("(^|/)pi$") then
				window:perform_action(wezterm.action.SendKey({ key = "Enter" }), pane)
			else
				window:perform_action(wezterm.action.SendString("\x1b[13;2u"), pane)
			end
		end),
	},
	{
		key = "d",
		mods = "CMD",
		action = wezterm.action.SplitHorizontal({ domain = "CurrentPaneDomain" }),
	},
	{
		key = "d",
		mods = "CMD|SHIFT",
		action = wezterm.action.SplitVertical({ domain = "CurrentPaneDomain" }),
	},
	{
		key = "w",
		mods = "CMD",
		action = wezterm.action.CloseCurrentPane({ confirm = false }),
	},
	{
		key = "w",
		mods = "CMD|SHIFT",
		action = wezterm.action.CloseCurrentTab({ confirm = false }),
	},
	{
		key = "[",
		mods = "CMD",
		action = wezterm.action.ActivatePaneDirection("Prev"),
	},
	{
		key = "]",
		mods = "CMD",
		action = wezterm.action.ActivatePaneDirection("Next"),
	},
	{
		key = "LeftArrow",
		mods = "ALT",
		action = wezterm.action.SendString("\x1bb"),
	},
	{
		key = "RightArrow",
		action = wezterm.action.SendString("\x1bf"),
		mods = "ALT",
	},
	{
		key = "RightArrow",
		mods = "CMD|OPT",
		action = wezterm.action.ActivateTabRelative(1),
	},
	{
		key = "LeftArrow",
		mods = "CMD|OPT",
		action = wezterm.action.ActivateTabRelative(-1),
	},
	{
		key = "e",
		mods = "CMD",
		action = wezterm.action_callback(function(win, pane)
			local mux_win = win:mux_window()
			for _, item in ipairs(mux_win:tabs_with_info()) do
				if item.is_active then
					mux_win:spawn_tab({})
					win:perform_action(wezterm.action.MoveTab(item.index), pane)
					return
				end
			end
		end),
	},
	{
		key = "e",
		mods = "CMD|SHIFT",
		action = wezterm.action_callback(function(win, pane)
			local mux_win = win:mux_window()
			local home = os.getenv("HOME")
			for _, item in ipairs(mux_win:tabs_with_info()) do
				if item.is_active then
					mux_win:spawn_tab({ cwd = home })
					win:perform_action(wezterm.action.MoveTab(item.index), pane)
					return
				end
			end
		end),
	},
	{
		key = "t",
		mods = "CMD",
		action = wezterm.action_callback(function(win, pane)
			local mux_win = win:mux_window()
			for _, item in ipairs(mux_win:tabs_with_info()) do
				if item.is_active then
					mux_win:spawn_tab({})
					win:perform_action(wezterm.action.MoveTab(item.index + 1), pane)
					return
				end
			end
		end),
	},
}

-- Finally, return the configuration to wezterm:
return config
