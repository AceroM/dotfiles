---
name: chrome
description: Alias for the browser-use skill. Use whenever the user says "chrome", "use chrome", "open chrome", "in chrome", or asks to drive, open or check something in the browser. Read ~/.agents/skills/browser-use/SKILL.md and follow it; drive the browser only through the `browser-use` CLI, never a Chrome plugin, chrome-devtools MCP or computer use.
---

# chrome → browser-use

"Chrome" means the user's real Chrome, driven through the shared **Agents** tab group with the
`browser-use` CLI. Read `~/.agents/skills/browser-use/SKILL.md` and follow it.

```bash
browser-use status
browser-use open <url>
browser-use snap
```
