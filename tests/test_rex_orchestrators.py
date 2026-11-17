"""Opt-in checks against Rex, using only temporary sessions and directories.

Run: REX_ORCHESTRATORS_INTEGRATION=1 python3 -m unittest discover -s tests -p test_rex_orchestrators.py -v
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest
import uuid


CONFIG = Path(__file__).resolve().parents[1] / "rex/.config/rex"
TERMINAL = "com.superlogical.terminal.shell"
# Load the real action without starting watchers or writing the user's focus
# history. Its pane, process and layout operations still go to the real server.
RUN_ACTION = """
package.path = rex.args.config .. '/?.lua;' .. package.path
require('focus').save = function() end
rex.exec.start = function() end
dofile(rex.args.config .. '/init.lua')
local result, err = rex.invoke('orchestrators', rex.args)
if err then error(err, 0) end
return result
"""


@unittest.skipUnless(os.environ.get("REX_ORCHESTRATORS_INTEGRATION") == "1"
                     and shutil.which("rex"), "needs opt-in and a running Rex server")
class OrchestratorsTests(unittest.TestCase):
    def command(self, *args, check=True):
        result = subprocess.run(["rex", "--autostart=false", *args],
                                capture_output=True, text=True, timeout=20)
        if check:
            self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def api(self, api_method, **args):
        if api_method != "session.create":
            args.setdefault("session_id", self.sid)
        return json.loads(self.command("api", "call", api_method, json.dumps(args)).stdout)

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="rex-orchestrators-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.dirs = [self.root / name for name in
                     ("foo", "bar's workspace", "foo/subdirectory", "four", "five")]
        for directory in self.dirs:
            directory.mkdir(parents=True, exist_ok=True)
        created = self.api("session.create", label="cmd-e-qa-" + uuid.uuid4().hex[:8])
        self.sid = created["session_id"]
        self.addCleanup(self.command, "kill", self.sid)
        self.api("session.attach")
        # A busy first tab must survive, with orchestrators inserted before it.
        self.busy = self.window(self.dirs[0], "busy", ["/bin/cat"])
        self.sources = [self.window(directory, "source") for directory in self.dirs]

    def layout(self, directory, command=None):
        return {"block": {"flavor": TERMINAL, "options": {
            "cwd": str(directory), "command": command or ["/bin/zsh", "-f"],
        }}}

    def window(self, directory, label, command=None):
        return self.api("session.new_window", focus=False, window_label=label,
                        layout=self.layout(directory, command))

    def action(self, source, dry_run=False, check=True):
        result = self.command("do", "-s", self.sid, "-b", source["block_ids"][0],
                              "-e", RUN_ACTION, "--args", json.dumps({
                                  "config": str(CONFIG), "session": self.sid,
                                  "quiet": True, "dry_run": dry_run,
                              }), "--json", check=check)
        return json.loads(result.stdout) if result.returncode == 0 else result

    def process(self, block):
        return self.api("block.method", block_id=block, method="process").get("foreground", {})

    def wait_program(self, block, program):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            process = self.process(block)
            if Path(process.get("argv0", "")).name.lstrip("-") == program:
                return process
            time.sleep(0.05)
        self.fail(f"{block} never ran {program}: {process}")

    def orchestrators(self):
        windows = self.api("session.view")["windows"]
        self.assertEqual(windows[0]["label"], "orchestrators")
        return windows[0]

    def tiles(self):
        tab = self.orchestrators()
        return next(layer for layer in tab["layers"] if layer["kind"] == "tiled")

    def rectangles(self):
        rectangles = {}

        def walk(node):
            if "block_id" in node:
                rectangles[node["block_id"]] = node["rect"]
            else:
                walk(node["split"]["before"])
                walk(node["split"]["after"])

        walk(self.tiles()["layout"])
        return rectangles

    def test_directories_focus_grid_limit_and_closed_slot(self):
        panes, pids = [], {}
        for index, source in enumerate(self.sources[:4]):
            preview = self.action(source, dry_run=True)
            self.assertEqual(preview["pane"], "new_tab" if index == 0 else "new_pane")
            result = self.action(source)
            block = result["block_id"]
            panes.append(block)
            process = self.wait_program(block, "o")
            self.assertEqual(process["cwd"], str(self.dirs[index]))
            pids[block] = process["pid"]
            self.assertEqual(len(self.tiles()["blocks"]), index + 1)
            self.assertEqual(self.orchestrators()["focused_block_id"], block)

            # A repeated request must select the same process, even when a
            # different directory was focused last and when all four are full.
            for previous, target in zip(self.sources, panes):
                repeated = self.action(previous)
                self.assertEqual((repeated["pane"], repeated["block_id"]), ("running", target))
                self.assertEqual(self.orchestrators()["focused_block_id"], target)
                self.assertEqual(self.process(target)["pid"], pids[target])

            if index == 1:
                self.assertEqual(self.rectangles(), {
                    panes[0]: [0, 0, 0.5, 1], panes[1]: [0.5, 0, 0.5, 1],
                })

        self.assertEqual(self.rectangles(), {
            panes[0]: [0, 0, 0.5, 0.5], panes[1]: [0.5, 0, 0.5, 0.5],
            panes[2]: [0, 0.5, 0.5, 0.5], panes[3]: [0.5, 0.5, 0.5, 0.5],
        })
        # Floating scratch shells must not be reused or counted as grid slots.
        self.api("session.new_layer", window_id=self.orchestrators()["window_id"],
                 bounds=[0.1, 0.1, 0.8, 0.8], focus=False,
                 layout=self.layout(self.dirs[4]))
        self.assertEqual(self.action(self.sources[4], dry_run=True)["pane"], "full")
        full = self.action(self.sources[4], check=False)
        self.assertNotEqual(full.returncode, 0)
        self.assertIn("already has four panes", full.stderr)
        self.assertEqual(set(self.rectangles()), set(panes))
        for block in panes:
            self.assertEqual(self.process(block)["pid"], pids[block])
        self.assertEqual(self.process(self.busy["block_ids"][0])["argv0"], "/bin/cat")

        self.api("block.close", block_id=panes.pop(2))
        result = self.action(self.sources[4])
        self.wait_program(result["block_id"], "o")
        self.assertEqual(len(self.rectangles()), 4)
        self.assertEqual(set(tuple(rect) for rect in self.rectangles().values()), {
            (0, 0, 0.5, 0.5), (0.5, 0, 0.5, 0.5),
            (0, 0.5, 0.5, 0.5), (0.5, 0.5, 0.5, 0.5),
        })
        for block in panes:
            self.assertEqual(self.process(block)["pid"], pids[block])

    def test_matching_idle_shell_and_restart(self):
        shell = self.window(self.dirs[0], "orchestrators")
        second = self.api("session.new_split", anchor_id=shell["block_ids"][0],
                          direction="horizontal", side="after",
                          layout=self.layout(self.dirs[1]))
        target = second["block_ids"][0]
        self.wait_program(target, "zsh")
        result = self.action(self.sources[1])
        self.assertEqual((result["pane"], result["block_id"]), ("typed_in_shell", target))
        self.assertEqual(self.wait_program(target, "o")["cwd"], str(self.dirs[1]))
        self.assertEqual(self.process(shell["block_ids"][0])["argv0"], "/bin/zsh")
        self.assertEqual(len(self.tiles()["blocks"]), 2)

        self.command("send-key", "-s", self.sid, "-b", target, "ctrl+c")
        self.wait_program(target, "zsh")
        restarted = self.action(self.sources[1])
        self.assertEqual(restarted["block_id"], target)
        self.wait_program(target, "o")
        self.assertEqual(len(self.tiles()["blocks"]), 2)


if __name__ == "__main__":
    unittest.main()
