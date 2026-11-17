"""Exercise rt in a disposable Rex session; never close a user's tabs.

REX_TABS_INTEGRATION=1 python3 -m unittest discover -s tests -p test_rex_tabs.py -v
"""
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(os.environ.get("REX_TABS_INTEGRATION") == "1" and shutil.which("rex"),
                     "needs opt-in and a running Rex server")
class RexTabsIntegration(unittest.TestCase):
    def rex(self, *args, json_output=False):
        result = subprocess.run(["rex", "--autostart=false", "--timeout", "5s", *args],
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        return json.loads(result.stdout) if json_output else result.stdout

    def until(self, fn, description):
        end = time.monotonic() + 10
        while time.monotonic() < end:
            result = fn()
            if result:
                return result
            time.sleep(0.1)
        self.fail(description)

    def launch(self, sid, block, *args):
        command = shlex.join([str(ROOT / "rt/.local/bin/rt"), *args])
        self.rex("send", "-s", sid, "-b", block, command)
        self.rex("send-key", "-s", sid, "-b", block, "enter")
        self.until(lambda: self.in_picker(sid, block), "rt did not take over the terminal")

    def in_picker(self, sid, block):
        modes = self.rex("block", "call", "-s", sid, "-b", block, "modes", json_output=True)
        return modes["screen"] == "alternate"

    @unittest.skipUnless(os.environ.get("REX_TABS_SWITCH_INTEGRATION") == "1",
                         "switch test briefly displays a disposable tab in the app")
    def test_enter_switches_and_dismisses(self):
        here = self.rex("whoami", "--json", json_output=True)
        apps = [c for c in self.rex("client", "ls", "--json", json_output=True)["clients"]
                if c.get("info", {}).get("kind") == "app"]
        self.assertEqual(len(apps), 1, "switch test requires exactly one app")
        client = apps[0]["client_id"]
        created = self.rex("new", "rt_switch_check", "--json", json_output=True)
        sid = created["session_id"]
        self.addCleanup(lambda: self.rex("kill", sid))
        # Run before killing the test session, even on assertion failure.
        self.addCleanup(lambda: self.rex("-C", client, "do", "session.select", "--args",
                                         json.dumps({"session_id": here["session_id"],
                                                     "window_id": here["window_id"]})))
        block = created["initial_windows"][0]["block_ids"][0]
        target = self.rex("window", "new", "-s", sid, "rt_switch_target", "--focus=false",
                          "--json", "--", "/bin/sleep", "600", json_output=True)
        self.launch(sid, block, "--client", client, "--current-session")
        self.rex("send-key", "-s", sid, "-b", block, "enter")

        def switched():
            view = self.rex("session", "inspect", sid, "--json", json_output=True)
            return not self.in_picker(sid, block) and view["active_window_id"] == target["window_id"]

        self.until(switched, "Enter did not switch and return to the shell")

    def test_terminal_close_refresh_and_return_to_shell(self):
        created = self.rex("new", "rt_integration_check", "--window", "rt_origin", "--json",
                           json_output=True)
        sid = created["session_id"]
        self.addCleanup(lambda: self.rex("kill", sid))
        origin = created["initial_windows"][0]
        block = origin["block_ids"][0]
        origin_id = origin["window_id"]

        def view():
            return self.rex("session", "inspect", sid, "--json", json_output=True)

        def add_tab(label):
            return self.rex("window", "new", "-s", sid, label, "--focus=false", "--json",
                            "--", "/bin/sleep", "600", json_output=True)

        first, second = add_tab("rt_one"), add_tab("rt_two")
        # The protected tab is the one running rt, regardless of server focus.
        self.rex("focus", "-s", sid, second["window_id"])
        self.launch(sid, block, "--current-session")

        def capture():
            return self.rex("capture", "-s", sid, "-b", block, "--trim")

        self.until(lambda: "rt_two" in capture(), "picker did not draw")
        screen = capture()
        self.assertIn("rt_one", screen)
        self.assertNotIn("rt_origin", screen)
        window = next(w for w in view()["windows"] if w["window_id"] == origin_id)
        self.assertEqual([b["block_id"] for layer in window["layers"] for b in layer["blocks"]], [block])

        self.rex("send-key", "-s", sid, "-b", block, ";")
        self.until(lambda: len(view()["windows"]) == 2, "; did not close a tab")
        self.assertNotIn(first["window_id"], [w["window_id"] for w in view()["windows"]])
        self.assertIn(origin_id, [w["window_id"] for w in view()["windows"]])
        third = add_tab("rt_three")
        self.until(lambda: "rt_three" in capture(), "new tabs were not refreshed")

        self.rex("send-key", "-s", sid, "-b", block, "q")
        self.until(lambda: not self.in_picker(sid, block), "quitting did not restore the terminal")
        self.assertEqual({w["window_id"] for w in view()["windows"]},
                         {origin_id, second["window_id"], third["window_id"]})

        # The public listing also excludes its hosting tab.
        env = dict(os.environ, REX_SESSION=sid, REX_BLOCK=block)
        listed = subprocess.run([str(ROOT / "rt/.local/bin/rt"), "ls", "--current-session", "--json"],
                                env=env, capture_output=True, text=True, timeout=15)
        self.assertEqual(listed.returncode, 0, listed.stderr)
        self.assertEqual({t["id"] for t in json.loads(listed.stdout)["tabs"]},
                         {second["window_id"], third["window_id"]})


if __name__ == "__main__":
    unittest.main()
