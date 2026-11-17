## Memory Guard on macOS

Keep the Memory Guard menu bar app running during local development. If a local Node process disappears or a dev port stops responding, check `tail -n 40 "$HOME/Library/Logs/Memory Guard/events.log"` for a matching timestamp, PID, and working directory.

If Memory Guard stopped a server your task still needs, check its existing Rex tab in the `servers` session and verify the listener is down. Restart that server with its original command and cwd in the same tab, then verify the port or health endpoint before continuing. A supervisor may already have brought it back. If Chrome restarted during browser work, wait for it to reopen and check `browser-use status` before resuming.
