-- cmd+alt+x stops every server in the `servers` session properly, then closes
-- the session, so the stack starts clean (`rex new servers`, then
-- scripts/juno/dev-up-rex.sh, which needs the session to exist).
-- "Properly" is servers-down (cli/.local/bin): Ctrl-C first, servers others
-- are connected to (Temporal) last, TERM/KILL only for what outlasts the
-- grace, attached Docker containers stopped, ports checked free. A plain tab
-- close would SIGHUP and kill everything at once.
--
-- It runs detached, so the key returns at once; a Hammerspoon promise toast
-- shows a spinner while it works, then ✓ or ✕ with whatever is still up.
--
--   rex do servers_down dry_run=1 --json   what it would stop, touching nothing
--   rex do servers_down keep_tabs=1        stop the servers, keep the session
--   rex do servers_down session=other      another session's servers

local HOME = os.getenv("HOME") or ""
local BIN = HOME .. "/.local/bin/servers-down"
-- The server's PATH is minimal; servers-down finds rex itself.
local PATH = "PATH=" .. HOME .. "/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

local function on(v)
  return v ~= nil and v ~= false and v ~= "" and v ~= "0" and v ~= "false"
end

rex.action{
  name = "servers_down",
  title = "Stop All Servers",
  category = "Session",
  keywords = "servers stop kill close quit shutdown restart dev juno temporal ports down",
  run = function(_, args)
    local argv = { "/usr/bin/env", PATH, BIN }
    if args.session and args.session ~= "" then
      argv[#argv + 1] = "--session"
      argv[#argv + 1] = tostring(args.session)
    end
    if on(args.keep_tabs) then argv[#argv + 1] = "--keep-tabs" end
    if on(args.dry_run) then
      argv[#argv + 1] = "--dry-run"
      local r = rex.exec(argv, { timeout = 30 })
      if not r then error("servers-down didn't run: is " .. BIN .. " stowed?", 0) end
      return { ok = r.ok, plan = r.stdout, err = r.stderr ~= "" and r.stderr or nil }
    end
    local h, err = rex.exec.start(argv, { detach = true })
    if not h then error("servers-down didn't start: " .. tostring(err), 0) end
    return { pid = h.pid }
  end,
}
rex.bind("cmd+alt+x", "servers_down")
