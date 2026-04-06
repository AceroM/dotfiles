local selected_files = ya.sync(function()
	local tab, paths = cx.active, {}
	for _, u in pairs(tab.selected) do
		paths[#paths + 1] = tostring(u)
	end
	if #paths == 0 and tab.current.hovered then
		paths[1] = tostring(tab.current.hovered.url)
	end
	return paths
end)

local function notify(str)
	ya.notify({
		title = "ijcopy",
		content = str,
		timeout = 3,
		level = "info",
	})
end

local function entry()
	local files = selected_files()
	if #files == 0 then
		return
	end

	local target = files[1]
	local ijcopy = (os.getenv("HOME") or "") .. "/bin/ijcopy"
	local cmd = string.format("%s %q", ijcopy, target)
	local ok, _, code = os.execute(cmd)

	if ok == true or code == 0 then
		-- notify("Ran ijcopy for " .. target)
	else
		-- notify("ijcopy failed with exit code " .. tostring(code))
	end
end

return {
	setup = function() end,
	entry = entry,
}
