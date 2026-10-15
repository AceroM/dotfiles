"""Exercise the shared Stop hook without touching live Herdr or calling a model."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
HOOK = ROOT / "claude/.claude/hooks/herdr-autoname.sh"


class AutonameTests(unittest.TestCase):
    def run_hook(self, label="ENG-7647", panes=1, chats=1, mine="",
                 title_source="claude", cwd=None, inventory_ok=True, agent_id=""):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shutil.copy(HOOK, root / HOOK.name)
            # Deterministic shortener; only the hook's title/target decisions are tested.
            (root / "herdr-short-name.py").write_text(
                "import sys\nassert sys.stdin.read() == 'Determine blocked-step unblocking'\n"
                "print('step_unblocking')\n"
            )
            commands = root / "commands"
            herdr = root / "herdr"
            herdr.write_text("""#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
if args[:2] == ['tab', 'get']:
    print(json.dumps({'result': {'tab': {'label': os.environ['TEST_LABEL'],
                                       'pane_count': int(os.environ['TEST_PANES'])}}}))
elif args[:2] == ['pane', 'list']:
    if os.environ['TEST_INVENTORY'] == '0':
        sys.exit(1)
    panes = [{'tab_id': 'w1:t1', 'pane_id': f'w1:p{i+1}',
              **({'agent': 'codex'} if i < int(os.environ['TEST_CHATS']) else {})}
             for i in range(int(os.environ['TEST_PANES']))]
    print(json.dumps({'result': {'panes': panes}}))
elif args[:2] == ['pane', 'get']:
    print(json.dumps({'result': {'pane': {'terminal_title_stripped':
                     'Determine blocked-step unblocking | tax-holiday.9'}}}))
elif args[1] == 'rename':
    with open(os.environ['TEST_COMMANDS'], 'a') as stream:
        stream.write(json.dumps(args) + '\\n')
else:
    sys.exit(1)
""")
            herdr.chmod(0o755)
            cache = root / "cache/herdr-autoname"
            cache.mkdir(parents=True)
            if mine:
                (cache / "w1_p1").write_text(mine)
            transcript = root / "transcript.jsonl"
            transcript.write_text(json.dumps({"type": "ai-title", "aiTitle":
                                             "Determine blocked-step unblocking"}) + "\n")
            (root / ".codex").mkdir()
            (root / ".codex/session_index.jsonl").write_text(json.dumps({
                "id": "session", "thread_name": "Determine blocked-step unblocking"
            }) + "\n")
            env = dict(os.environ, HOME=str(root), XDG_CACHE_HOME=str(root / "cache"),
                       PATH=f"{root}:{os.environ['PATH']}", HERDR_ENV="1",
                       HERDR_PANE_ID="w1:p1", HERDR_TAB_ID="w1:t1",
                       HERDR_WORKSPACE_ID="w1", HERDR_AUTONAME="1",
                       CODEX_THREAD_ID="", TEST_LABEL=label, TEST_PANES=str(panes),
                       TEST_CHATS=str(chats), TEST_INVENTORY=str(int(inventory_ok)),
                       TEST_COMMANDS=str(commands))
            payload = {"cwd": cwd or str(root / "Numeral/tax-holiday.9")}
            if title_source == "claude":
                payload["transcript_path"] = str(transcript)
            elif title_source == "codex":
                payload["session_id"] = "session"
            if agent_id:
                payload["agent_id"] = agent_id
            result = subprocess.run(["bash", str(root / HOOK.name)], env=env,
                                    input=json.dumps(payload), text=True,
                                    capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, "{}\n")
            return [json.loads(line) for line in commands.read_text().splitlines()] \
                if commands.exists() else []

    def test_claude_and_codex_use_chat_topics(self):
        for source in ("claude", "codex", "terminal"):
            with self.subTest(source=source):
                self.assertEqual(self.run_hook(title_source=source),
                                 [["tab", "rename", "w1:t1", "step_unblocking"]])

    def test_generated_ticket_and_owned_labels_migrate(self):
        for label, mine in (("15", ""), ("ENG-7647 · slot 9", ""),
                            ("old_topic", "old_topic")):
            with self.subTest(label=label):
                self.assertEqual(self.run_hook(label=label, mine=mine),
                                 [["tab", "rename", "w1:t1", "step_unblocking"]])

    def test_editor_split_still_names_tab(self):
        self.assertEqual(self.run_hook(panes=2, chats=1),
                         [["tab", "rename", "w1:t1", "step_unblocking"]])

    def test_multiple_chats_name_only_current_pane(self):
        self.assertEqual(self.run_hook(panes=2, chats=2),
                         [["pane", "rename", "w1:p1", "step_unblocking"]])

    def test_inventory_failure_names_only_current_pane(self):
        self.assertEqual(self.run_hook(panes=2, inventory_ok=False),
                         [["pane", "rename", "w1:p1", "step_unblocking"]])

    def test_manual_and_coordinator_labels_are_protected(self):
        for label in ("main", "coordinator", "salesforce", "ENG-7647 · custom topic"):
            with self.subTest(label=label):
                self.assertEqual(self.run_hook(label=label), [])

    def test_subagent_does_not_rename(self):
        self.assertEqual(self.run_hook(agent_id="child"), [])


if __name__ == "__main__":
    unittest.main()
