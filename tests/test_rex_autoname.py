"""Exercise the shared Rex autoname hook against a fake `rex`, without calling a model."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
HOOK = ROOT / "claude/.claude/hooks/rex-autoname.sh"

FAKE_REX = """#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
env = os.environ
panes, chats = int(env['TEST_PANES']), int(env['TEST_CHATS'])
blocks = [f'block:{i+1}' for i in range(panes)]

def opt(name):
    return args[args.index(name) + 1] if name in args else None

if args[:2] == ['block', 'inspect']:
    print(json.dumps({'block': {'block_id': 'block:1', 'window_id': 'window:1'}}))
elif args[:2] == ['window', 'inspect']:
    print(json.dumps({'window_id': 'window:1', 'label': env['TEST_LABEL'], 'layers': [
        {'blocks': [{'block_id': b, 'label': env['TEST_PANE_LABEL'] if b == 'block:1' else 'shell'}
                    for b in blocks]}]}))
elif args[:2] == ['block', 'call'] and args[-1] == 'process':
    b = opt('-b')
    if env['TEST_INVENTORY'] == '0' and b != 'block:1':
        sys.exit(1)
    idx = blocks.index(b) if b in blocks else 0
    fg = {'argv0': 'claude' if idx < chats else 'nvim', 'cwd': env['TEST_AGENT_CWD'], 'pid': 10 + idx}
    print(json.dumps({'foreground': fg, 'ancestors': [{'argv0': '-zsh', 'cwd': env['TEST_PANE_CWD']}]}))
elif args[:2] == ['block', 'call'] and args[-1] == 'title':
    title = '' if env['TEST_UNTITLED'] == '1' else '\\u2733 Determine blocked-step unblocking | app.9'
    print(json.dumps({'title': title}))
elif args[1:2] == ['rename']:
    with open(env['TEST_COMMANDS'], 'a') as stream:
        stream.write(json.dumps([a for a in args if a not in ('-s', env['REX_SESSION'])]) + '\\n')
else:
    sys.exit(1)
"""


class AutonameTests(unittest.TestCase):
    def run_hook(self, label="ENG-7647", panes=1, chats=1, mine="", pane_label="shell",
                 title_source="claude", cwd=None, inventory_ok=True, agent_id="",
                 coordinators="", pane_cwd="", agent_cwd="", events=("Stop",),
                 untitled_runs=0):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shutil.copy(HOOK, root / HOOK.name)
            # Deterministic shortener; only the hook's title/target decisions are tested.
            (root / "tab-short-name.py").write_text(
                "import sys\nassert sys.stdin.read() == 'Determine blocked-step unblocking'\n"
                "print('step_unblocking')\n"
            )
            commands = root / "commands"
            rex = root / "rex"
            rex.write_text(FAKE_REX)
            rex.chmod(0o755)
            cache = root / "cache/rex-autoname"
            cache.mkdir(parents=True)
            if mine:
                (cache / "block_1").write_text(mine)
            transcript = root / "transcript.jsonl"
            titled = json.dumps({"type": "ai-title", "aiTitle":
                                 "Determine blocked-step unblocking"}) + "\n"
            (root / ".codex").mkdir()
            (root / ".codex/session_index.jsonl").write_text(json.dumps({
                "id": "session", "thread_name": "Determine blocked-step unblocking"
            }) + "\n")
            env = dict(os.environ, HOME=str(root), XDG_CACHE_HOME=str(root / "cache"),
                       PATH=f"{root}:{os.environ['PATH']}",
                       REX_SESSION="session:1", REX_BLOCK="block:1", REX_AUTONAME="1",
                       CODEX_THREAD_ID="", TEST_LABEL=label, TEST_PANES=str(panes),
                       TEST_CHATS=str(chats), TEST_INVENTORY=str(int(inventory_ok)),
                       TEST_COMMANDS=str(commands), TEST_PANE_CWD=pane_cwd,
                       TEST_AGENT_CWD=agent_cwd, TEST_PANE_LABEL=pane_label,
                       REX_AUTONAME_COORDINATOR_DIRS=coordinators)
            payload = {"cwd": cwd or str(root / "work/app.9")}
            if title_source == "claude":
                payload["transcript_path"] = str(transcript)
                payload["session_id"] = "claude-session"
            elif title_source == "codex":
                payload["session_id"] = "session"
            if agent_id:
                payload["agent_id"] = agent_id
            for run, event in enumerate(events):
                untitled = run < untitled_runs
                transcript.write_text("" if untitled else titled)
                result = subprocess.run(["bash", str(root / HOOK.name)],
                                        env=dict(env, TEST_UNTITLED=str(int(untitled))),
                                        input=json.dumps(dict(payload, hook_event_name=event)),
                                        text=True, capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, "{}\n")
            return [json.loads(line) for line in commands.read_text().splitlines()] \
                if commands.exists() else []

    TAB = [["window", "rename", "window:1", "step_unblocking"]]
    PANE = [["block", "rename", "block:1", "step_unblocking"]]

    def test_claude_and_codex_use_chat_topics(self):
        for source in ("claude", "codex", "terminal"):
            with self.subTest(source=source):
                self.assertEqual(self.run_hook(title_source=source), self.TAB)

    def test_generated_ticket_and_owned_labels_migrate(self):
        for label, mine in (("Window 5562d8ea", ""), ("", ""), ("ENG-7647 · slot 9", ""),
                            ("old_topic", "old_topic")):
            with self.subTest(label=label):
                self.assertEqual(self.run_hook(label=label, mine=mine), self.TAB)

    def test_editor_split_still_names_tab(self):
        self.assertEqual(self.run_hook(panes=2, chats=1), self.TAB)

    def test_multiple_chats_name_only_current_pane(self):
        self.assertEqual(self.run_hook(panes=2, chats=2), self.PANE)

    def test_inventory_failure_names_only_current_pane(self):
        self.assertEqual(self.run_hook(panes=2, inventory_ok=False), self.PANE)

    def test_named_agent_pane_is_protected(self):
        self.assertEqual(self.run_hook(panes=2, chats=2, pane_label="prod-1234"), [])
        self.assertEqual(self.run_hook(panes=2, chats=2, pane_label="old", mine="old"), self.PANE)

    def test_manual_and_coordinator_labels_are_protected(self):
        for label in ("main", "coordinator", "salesforce", "ENG-7647 · custom topic"):
            with self.subTest(label=label):
                self.assertEqual(self.run_hook(label=label), [])

    def test_coordinator_dirs_match_exactly(self):
        self.assertEqual(self.run_hook(cwd="/work/", coordinators="/other:/work"), [])
        self.assertEqual(self.run_hook(cwd="/work/app.9", coordinators="/other:/work"), self.TAB)

    def test_coordinator_that_cd_into_a_worktree_stays_protected(self):
        # The hook's cwd follows the session's cd; the launching shell / agent process keep theirs.
        self.assertEqual(self.run_hook(cwd="/work/app.9", pane_cwd="/work",
                                       coordinators="/work"), [])
        self.assertEqual(self.run_hook(cwd="/work/app.9", agent_cwd="/work",
                                       coordinators="/work"), [])
        self.assertEqual(self.run_hook(cwd="/work/app.9", pane_cwd="/work/app.9",
                                       coordinators="/work"), self.TAB)

    def test_post_tool_use_names_once_per_session(self):
        self.assertEqual(self.run_hook(events=("PostToolUse", "PostToolUse")), self.TAB)

    def test_post_tool_use_retries_until_a_title_exists(self):
        self.assertEqual(self.run_hook(events=("PostToolUse",) * 3, untitled_runs=1), self.TAB)
        self.assertEqual(self.run_hook(events=("PostToolUse",), untitled_runs=1), [])

    def test_post_tool_use_respects_coordinators(self):
        self.assertEqual(self.run_hook(events=("PostToolUse",), cwd="/work/app.9",
                                       pane_cwd="/work", coordinators="/work"), [])

    def test_subagent_does_not_rename(self):
        self.assertEqual(self.run_hook(agent_id="child"), [])
        self.assertEqual(self.run_hook(agent_id="child", events=("PostToolUse",)), [])

    def test_outside_rex_does_nothing(self):
        env_backup = dict(os.environ)
        try:
            os.environ.pop("REX_SESSION", None)
            result = subprocess.run(["bash", str(HOOK)], input="{}", text=True,
                                    capture_output=True, timeout=5,
                                    env={k: v for k, v in os.environ.items()
                                         if not k.startswith("REX_")})
            self.assertEqual(result.stdout, "{}\n")
        finally:
            os.environ.clear(); os.environ.update(env_backup)


if __name__ == "__main__":
    unittest.main()
