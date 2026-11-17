-- cmd+shift+o opens the focused pane's GitHub page in the default browser: the
-- current branch's pull request when it has one (`gh pr view -w`), else the
-- directory: the repo's page at its root, else /tree/<branch>/<path>.
--
-- The directory link uses the branch the current branch tracks, so the page is
-- what was pushed. A branch that tracks nothing (or a detached HEAD) links the
-- default branch instead (GitHub reads HEAD in a URL as the default branch),
-- since the branch itself isn't on GitHub to show.
--
-- Asking GitHub for the PR takes ~0.4s, so on a feature branch that runs
-- detached and the key returns at once. On the default branch (or a detached
-- HEAD) there's no PR to look for, and the directory opens straight away.
--
-- Try it without opening anything (this one waits for gh, to report the PR):
--   rex do github_open dry_run=1 --json

local dirfocus = require("dir-focus")

-- The server's PATH is minimal; these are the git and gh the shell uses.
local PATH = "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

local function git(dir, ...)
  local argv = { "/usr/bin/env", PATH, "git", "-C", dir }
  for _, a in ipairs({ ... }) do argv[#argv + 1] = a end
  local r = rex.exec(argv, { timeout = 3 })
  if not (r and r.ok) then return nil end
  return (r.stdout or ""):gsub("%s+$", "")
end

-- git@github.com:o/r.git, ssh://git@github.com:22/o/r, https://u@github.com/o/r.git
-- and SSH host aliases such as github.com-work all come out as https://github.com/o/r.
local function web_url(remote)
  local rest = remote:gsub("^%a[%w+.-]*://", ""):gsub("^[^@/]+@", "")
  local host, path = rest:match("^([^:/]+)[:/](.+)$")
  if not host then return nil end
  path = path:gsub("^%d+/", ""):gsub("/+$", ""):gsub("%.git$", "")
  if host:match("^github%.com") then host = "github.com" end
  return "https://" .. host .. "/" .. path
end

-- Percent-encode everything but unreserved characters and slashes.
local function encode(s)
  return (s:gsub("[^%w%-._~/]", function(c) return string.format("%%%02X", c:byte()) end))
end

rex.action{
  name = "github_open",
  title = "Open PR or Directory on GitHub",
  category = "Pane",
  keywords = "github browser web remote repo url open path folder pull request pr",
  run = function(ctx, args)
    local cwd = ctx.block_id and dirfocus.pane_cwd(ctx.block_id)
    if not cwd then error("GitHub: can't tell which directory the focused pane is in", 0) end

    -- The path from the repo root ("" at the root, "sub/dir/" below it).
    local prefix = git(cwd, "rev-parse", "--show-prefix")
    if not prefix then error("GitHub: " .. cwd .. " isn't in a git repo", 0) end
    prefix = prefix:gsub("/$", "")

    -- origin/feature -> remote origin, branch feature.
    local remotes = git(cwd, "remote") or ""
    local upstream = git(cwd, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
    local remote, branch
    if upstream and upstream ~= "" then
      for name in remotes:gmatch("[^\n]+") do
        if upstream:sub(1, #name + 1) == name .. "/" and (not remote or #name > #remote) then
          remote, branch = name, upstream:sub(#name + 2)
        end
      end
    end
    if not remote then -- origin, else the first remote
      for name in remotes:gmatch("[^\n]+") do
        if name == "origin" or not remote then remote = name end
      end
    end
    local remote_url = remote and git(cwd, "remote", "get-url", remote)
    if not remote_url or remote_url == "" then error("GitHub: the repo at " .. cwd .. " has no remote", 0) end
    local base = web_url(remote_url)
    if not base then error("GitHub: can't read remote URL " .. remote_url, 0) end

    -- The default branch, when the remote's HEAD is known locally.
    local default = (git(cwd, "symbolic-ref", "--short", "refs/remotes/" .. remote .. "/HEAD") or "")
      :sub(#remote + 2)

    local url
    if prefix == "" and (not branch or branch == default) then
      url = base
    else
      url = base .. "/tree/" .. encode(branch or "HEAD") .. (prefix ~= "" and "/" .. encode(prefix) or "")
    end

    -- Only a feature branch can have a PR: not the default branch, not a detached HEAD.
    local current = git(cwd, "rev-parse", "--abbrev-ref", "HEAD") or "HEAD"
    local check_pr = current ~= "HEAD" and current ~= default

    local result = { cwd = cwd, remote = remote, branch = branch or "HEAD", url = url, check_pr = check_pr }
    if args.dry_run then
      if check_pr then
        local r = rex.exec({ "/bin/sh", "-c", 'cd "$1" && exec /usr/bin/env "$2" gh pr view --json url -q .url',
          "sh", cwd, PATH }, { timeout = 10 })
        result.pr = r and r.ok and (r.stdout or ""):gsub("%s+$", "") or nil
      end
      return result
    end

    if check_pr then
      -- gh opens the PR itself; with no PR for the branch it fails, and the
      -- directory opens instead.
      rex.exec.start({ "/bin/sh", "-c",
        'cd "$1" && /usr/bin/env "$2" gh pr view -w >/dev/null 2>&1 || exec /usr/bin/open "$3"',
        "sh", cwd, PATH, url }, { detach = true })
    else
      local r = rex.exec{ "/usr/bin/open", url }
      if not (r and r.ok) then error("GitHub: open failed for " .. url, 0) end
    end
    return result
  end,
}
rex.bind("cmd+shift+o", "github_open")
