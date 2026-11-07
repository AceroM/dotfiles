"""Find the local socket used by the Herdr client running in Ghostty."""

import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys


def processes():
    output = subprocess.check_output(
        ["/bin/ps", "-axo", "pid=,ppid=,args="], text=True
    )
    rows = {}
    for line in output.splitlines():
        fields = line.strip().split(None, 2)
        if len(fields) == 3:
            rows[int(fields[0])] = (int(fields[1]), fields[2])
    return rows


def client_socket(pid, command):
    # Never print the process environment: it can contain credentials.
    output = subprocess.check_output(
        ["/bin/ps", "eww", "-p", str(pid), "-o", "command="], text=True
    )
    env = dict(re.findall(
        r"(?:^|\s)(HERDR_SOCKET_PATH|HERDR_SESSION|XDG_CONFIG_HOME)=([^\s]+)",
        output,
    ))
    args = shlex.split(command)
    session = env.get("HERDR_SESSION", "default")
    explicit = False
    for i, arg in enumerate(args):
        if arg == "--session" and i + 1 < len(args):
            session, explicit = args[i + 1], True
        elif arg.startswith("--session="):
            session, explicit = arg.split("=", 1)[1], True
    if args[1:3] == ["session", "attach"] and len(args) > 3:
        session, explicit = args[3], True
    if not explicit and env.get("HERDR_SOCKET_PATH"):
        return env["HERDR_SOCKET_PATH"]
    root = Path(env.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "herdr"
    if session != "default":
        root = root / "sessions" / session
    return str(root / "herdr.sock")


def find_socket(ghostty_pid):
    rows = processes()
    clients = []
    for pid, (parent, command) in rows.items():
        if Path(command.split(None, 1)[0]).name != "herdr":
            continue
        # A client owns a shell below Ghostty; exclude headless servers and
        # commands launched from inside managed panes.
        seen = {pid}
        while parent in rows and parent not in seen:
            if parent == ghostty_pid:
                clients.append((pid, command))
                break
            seen.add(parent)
            parent, ancestor = rows[parent]
            if Path(ancestor.split(None, 1)[0]).name == "herdr":
                break
    paths = {client_socket(pid, command) for pid, command in clients}
    paths = {path for path in paths if os.path.exists(path) and stat.S_ISSOCK(os.stat(path).st_mode)}
    return next(iter(paths)) if len(paths) == 1 else None


if __name__ == "__main__":
    path = find_socket(int(sys.argv[1]))
    if path:
        print(path)
