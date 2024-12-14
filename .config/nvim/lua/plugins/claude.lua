return {
	{
		"pasky/claude.vim",
		config = function()
			vim.g.claude_api_key = os.getenv("CLAUDE_API_KEY")
		end,
	},
}
