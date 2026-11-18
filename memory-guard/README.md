# Memory Guard

A native Swift menu bar app that watches the current macOS user’s Node processes and the regular Google Chrome app. Click the memory chip icon for live usage, **Memory Limits**, **Pause Monitoring**, or **Open Event Log**.

Run `./memory-guard/install.sh` from the dotfiles root. It builds and signs `~/Applications/Memory Guard.app`, starts the per-user LaunchAgent, and installs the recovery instructions for Codex and Claude Code. Launchd starts Memory Guard at login and brings it back after a crash. A normal quit lasts until the next login or until you reopen the app.

| Target | Default limit | Recovery |
| --- | --- | --- |
| Node | One quarter of installed RAM per PID, rounded down, minimum 4 GiB | Send SIGTERM, then SIGKILL after five seconds if the same process is still running. Log the PID and cwd so the server can be restarted from its original tab. |
| Chrome | One third of installed RAM per browser instance with its helpers, rounded down, minimum 6 GiB | Ask Chrome to quit, force it to stop after eight seconds if needed, then reopen the same bundle with `--restore-last-session`. Wait at least five minutes before another Chrome restart. |

The monitor samples macOS physical footprint every five seconds and acts on the third consecutive reading at or above a limit. Pausing and changing a limit both reset the current readings above the limit. Events are stored in `~/Library/Logs/Memory Guard/events.log`. Chrome may show its restore prompt after a forced quit.

Allow Memory Guard notifications when macOS prompts you. Each successful Chrome restart sends a notification with the memory usage that triggered it.
