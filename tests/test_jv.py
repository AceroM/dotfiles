"""Exercise the public diff commands and a reload through the renderer."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


BIN = Path(__file__).resolve().parents[1] / "jv/.local/bin"


class DiffCommandsTest(unittest.TestCase):
    def test_staged_diff_and_reload(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            env = {k: v for k, v in os.environ.items() if not k.startswith(("GIT_", "_JV_"))}
            env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
                       TUI_THEME="onedark", JV_THEME="TwoDark", XDG_STATE_HOME=tmp)

            def run(*args):
                return subprocess.run(args, cwd=repo, env=env, stdin=subprocess.DEVNULL,
                                      text=True, capture_output=True, check=True, timeout=300)

            run("git", "init", "-q")
            path = "file with spaces.txt"
            (repo / path).write_text("renderproof\n")
            run("git", "add", "--", path)

            snapshot = ("--snapshot", "100x20")
            staged = ("-g", "--staged", "--", path)
            flat = run(BIN / "jf", *snapshot, *staged).stdout
            self.assertIn("renderproof", flat)
            self.assertEqual(flat, run(BIN / "jv", "--flat", *snapshot, *staged).stdout)
            self.assertIn("everything is staged", run(BIN / "jg").stderr)

            reloaded = run(BIN / "jf", *snapshot, "--keys", "r",
                           "-c", "printf x >> loads && git diff --staged")
            self.assertIn("renderproof", reloaded.stdout)
            self.assertEqual((repo / "loads").read_text(), "xx")

    def test_stack_diff_search_across_prs(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            env = {k: v for k, v in os.environ.items() if not k.startswith(("GIT_", "_JV_"))}
            env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
                       TUI_THEME="onedark", JV_THEME="TwoDark", XDG_STATE_HOME=tmp)

            def run(*args):
                return subprocess.run(args, cwd=repo, env=env, stdin=subprocess.DEVNULL,
                                      text=True, capture_output=True, check=True, timeout=300).stdout

            run("git", "init", "-qb", "main")
            run("git", "config", "user.name", "Stack Test")
            run("git", "config", "user.email", "stack@example.com")
            run("git", "remote", "add", "origin", str(repo))

            def commit(message, files):
                for name, contents in files.items():
                    (repo / name).write_text(contents + "\n")
                run("git", "add", "--", *files)
                run("git", "commit", "-qm", message)
                return run("git", "rev-parse", "HEAD").strip()

            commit("fork point", {"reverted.txt": "original"})
            run("git", "switch", "-qc", "bottom")
            bottom = commit("bottom PR", {"bottom.txt": "stackneedle from bottom", "reverted.txt": "transient edit"})
            run("git", "switch", "-qc", "top")
            top = commit("top PR", {"top.test.txt": "stackneedle from top", "reverted.txt": "original"})
            run("git", "switch", "-q", "main")
            commit("trunk moved", {"reverted.txt": "new trunk edit"})
            run("git", "switch", "-q", "bottom")

            def entry(number, base, head, oid):
                return {"position": number, "pullRequest": {
                    "number": number, "state": "OPEN", "baseRefName": base,
                    "headRefName": head, "headRefOid": oid,
                }}

            stack = {"id": "stack-id", "number": 7, "baseRefName": "main", "entries": {
                "nodes": [entry(1, "main", "bottom", bottom), entry(2, "bottom", "top", top)],
                "pageInfo": {"hasNextPage": False},
            }}
            response = {"data": {"repository": {"pullRequests": {"nodes": [
                {"isCrossRepository": False, "stack": stack},
            ]}}}}
            fake_bin = repo / "bin"
            fake_bin.mkdir()
            gh = fake_bin / "gh"
            gh.write_text("#!/bin/sh\nif [ \"$1\" = repo ]; then\n"
                          "  echo example/repo\nelse\n"
                          f"  cat <<'EOF'\n{json.dumps(response)}\nEOF\nfi\n")
            gh.chmod(0o755)
            env["PATH"] = str(fake_bin) + os.pathsep + env["PATH"]

            args = (BIN / "jf", "--stack", "--snapshot", "100x24")
            frame = run(*args)
            self.assertIn("Stack #7 · 2 PRs → main", frame)
            self.assertIn("bottom.txt", frame)
            self.assertIn("top.test.txt", frame)
            self.assertNotIn("reverted.txt", frame)
            hit = run(*args, "--keys", "/stackneedle<CR>n")
            self.assertIn("2/2", hit)
