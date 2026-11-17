"""Exercise the public diff commands and a reload through the renderer."""

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
