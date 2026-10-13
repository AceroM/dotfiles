#!/usr/bin/env python3
"""Route a clicked code location to a registered Neovim in the source tab."""
import hashlib
import json
import os
from pathlib import Path
import re
import socket as sockets
import subprocess
import sys
from urllib.parse import parse_qs, unquote, urlsplit


def run(argv, timeout=5):
    return subprocess.run(argv, text=True, capture_output=True, check=True, timeout=timeout).stdout.strip()


def rpc(server, expression, argument=None):
    if argument is not None:
        encoded = json.dumps(argument).replace("'", "''")
        expression = f"luaeval('{expression}', json_decode('{encoded}'))"
    else:
        expression = f"luaeval('{expression}')"
    result = subprocess.run(["nvim", "--headless", "--server", server, "--remote-expr", f"json_encode({expression})"],
                            text=True, capture_output=True, check=True, timeout=5)
    try:
        # Neovim writes remote-expr results to stderr when stdin is a terminal.
        return json.loads(result.stdout.strip() or result.stderr.strip())
    except ValueError as error:
        raise ValueError(f"Neovim RPC returned no JSON: {result.stderr.strip() or repr(result.stdout)}") from error


def herdr_call(method, params):
    socket_path = os.environ.get("HERDR_SOCKET_PATH", str(Path.home() / ".config/herdr/herdr.sock"))
    with sockets.socket(sockets.AF_UNIX) as connection:
        connection.settimeout(5)
        connection.connect(socket_path)
        request = {"id": f"nvim-links-{os.getpid()}", "method": method, "params": params}
        connection.sendall((json.dumps(request) + "\n").encode())
        with connection.makefile("rb") as reader:
            response = json.loads(reader.readline())
    if "error" in response:
        raise ValueError(response["error"]["message"])
    return response["result"]


def parse_location(value):
    line, column = 1, 1
    if value.startswith("file://"):
        uri = urlsplit(value)
        if uri.netloc not in ("", "localhost"):
            raise ValueError("Remote file links cannot be opened in a local editor")
        value = unquote(uri.path)
        anchor = re.fullmatch(r"L?(\d+)(?::(\d+))?(?:-L?\d+)?", uri.fragment)
        query = parse_qs(uri.query)
        if anchor:
            line, column = int(anchor[1]), int(anchor[2] or 1)
        elif query.get("line"):
            line = int(query["line"][0])
            column = int(query.get("column", [1])[0])
    match = re.fullmatch(r"(.+?):(\d+)(?::(\d+))?(?:-\d+)?", value)
    if match:
        value, line, column = match[1], int(match[2]), int(match[3] or 1)
    elif not value.startswith("/"):
        raise ValueError("Expected a file location with a line number")
    if value.startswith("@"):
        value = value[1:]
    if not value or "\x00" in value or line < 1 or column < 1:
        raise ValueError("Invalid file location")
    return Path(value).expanduser(), line, column


def existing_path(path, cwd):
    if not cwd:
        return None
    candidate = (Path(cwd) / path).resolve()
    if candidate.is_file():
        return candidate
    try:
        root = run(["git", "-C", str(cwd), "rev-parse", "--show-toplevel"])
    except (subprocess.SubprocessError, OSError):
        return None
    candidate = (Path(root) / path).resolve()
    return candidate if candidate.is_file() else None


def choose_editor(path, source_cwd, editors):
    if not editors:
        raise ValueError("No registered Neovim sibling in this tab; open Neovim beside the agent")
    source_path = path.resolve() if path.is_absolute() and path.is_file() else None
    if not path.is_absolute():
        source_path = existing_path(path, source_cwd)
    if path.is_absolute() and source_path is None:
        raise ValueError(f"File does not exist: {path}")
    if source_path is not None:
        matching = [editor for editor in editors if existing_path(path, editor["cwd"]) == source_path]
        if len(matching) == 1:
            return matching[0], source_path
        if len(editors) == 1:
            return editors[0], source_path
        raise ValueError("Multiple Neovim siblings can open this file; keep one editor in this tab")
    matching = [(editor, existing_path(path, editor["cwd"])) for editor in editors]
    matching = [(editor, candidate) for editor, candidate in matching if candidate is not None]
    if len(matching) == 1:
        return matching[0]
    if matching:
        raise ValueError("File exists in multiple sibling checkouts; use an absolute path")
    raise ValueError(f"File was not found in the agent or sibling editor checkout: {path}")


def main():
    context = json.loads(os.environ.get("HERDR_PLUGIN_CONTEXT_JSON", "{}"))
    clicked = context.get("clicked_url") or os.environ.get("HERDR_PLUGIN_CLICKED_URL", "")
    path, line, column = parse_location(clicked)
    source_id = context.get("focused_pane_id") or os.environ.get("HERDR_PANE_ID")
    panes = herdr_call("pane.list", {})["panes"]
    source = next((pane for pane in panes if pane["pane_id"] == source_id), None)
    if source is None:
        raise ValueError("The source pane is no longer available")
    socket = os.environ.get("HERDR_SOCKET_PATH", str(Path.home() / ".config/herdr/herdr.sock"))
    key = hashlib.sha256(socket.encode()).hexdigest()[:12]
    state = Path(os.environ.get("XDG_STATE_HOME", str(Path.home() / ".local/state")))
    directory = state / "nvim/herdr-nvim" / key
    editors = []
    failures = []
    for pane in panes:
        if pane["pane_id"] == source_id or pane["tab_id"] != source["tab_id"]:
            continue
        registration = directory / (re.sub(r"[^\w-]", "_", pane["pane_id"]) + ".json")
        try:
            entry = json.loads(registration.read_text())
            if entry["herdr_socket"] != socket or entry["pane_id"] != pane["pane_id"]:
                continue
            live = rpc(entry["server"], '{pid=vim.fn.getpid(), pane_id=vim.env.HERDR_PANE_ID, cwd=vim.fn.getcwd()}')
            if live["pid"] == entry["pid"] and live["pane_id"] == pane["pane_id"]:
                editors.append({**entry, "cwd": live["cwd"]})
        except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
            failures.append(f"{pane['pane_id']}: {error}")
            continue
    if not editors:
        detail = "; ".join(failures) or "no sibling panes"
        raise ValueError(f"No registered Neovim sibling in this tab ({detail}); restart the sibling Neovim")
    editor, target = choose_editor(path, source.get("foreground_cwd") or source.get("cwd"), editors)
    result = rpc(editor["server"], 'require("config.herdr_links").open(_A)', {
        "path": str(target), "line": line, "column": column,
    })
    if not result.get("ok"):
        raise ValueError(result.get("error", "Neovim could not open this file"))
    herdr_call("pane.focus", {"pane_id": editor["pane_id"]})
    print(f"Opened {result['path']}:{result['line']} in {editor['pane_id']}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        message = f"Herdr file link: {error}"
        print(message, file=sys.stderr)
        try:
            run([os.environ.get("HERDR_BIN_PATH", "herdr"), "notification", "show", message])
        except (OSError, subprocess.SubprocessError):
            pass
        sys.exit(1)
