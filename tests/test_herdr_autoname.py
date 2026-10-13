"""Naming and target-selection checks; never connect to the user's Herdr session."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
HOOK = ROOT / "claude/.claude/hooks/herdr-autoname.sh"
spec = importlib.util.spec_from_file_location("names", HOOK.with_name("herdr-short-name.py"))
names = importlib.util.module_from_spec(spec)
spec.loader.exec_module(names)


class NamesTest(unittest.TestCase):
    def test_pr_formats_and_multiple_prs(self):
        for title in ["Review PR 12932", "Fix pr_12932", "pull request #12932",
                      "https://github.com/Numeral/tax-holiday/pull/12932"]:
            self.assertEqual(names.pr_name(title), "pr_12932")
        self.assertEqual(names.pr_name("Compare PR 12 and PR 34"), "")

    def test_fallback_drops_actions_and_limits_length(self):
        self.assertEqual(names.fallback("Implement automatic product categorization for merchants"),
                         "product_categorization")
        self.assertEqual(names.fallback("Investigate flaky authentication tests"), "flaky_authentication")
        self.assertLessEqual(len(names.fallback("x" * 100)), 28)

    def test_cache_calls_model_once(self):
        with tempfile.TemporaryDirectory() as cache, patch.dict(os.environ, {"XDG_CACHE_HOME": cache}):
            with patch.object(names, "model_name", return_value="product_categorization") as model:
                self.assertEqual(names.short_name("Product categorization feature"), "product_categorization")
                self.assertEqual(names.short_name("Product categorization feature"), "product_categorization")
                model.assert_called_once()
            with patch.object(names, "model_name", side_effect=AssertionError("PR should skip model")):
                self.assertEqual(names.short_name("Review PR 12932"), "pr_12932")

    def test_model_failure_and_invalid_output(self):
        with patch.object(names.subprocess, "run", side_effect=subprocess.TimeoutExpired("claude", 20)):
            self.assertEqual(names.model_name("some title"), "")
        with patch.object(names.subprocess, "run", return_value=subprocess.CompletedProcess(
                "claude", 0, "Here is a long sentence describing the task", "")):
            self.assertEqual(names.model_name("some title"), "")


class HookTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.calls = self.home / "calls"
        bin_dir = self.home / "bin"
        bin_dir.mkdir()
        herdr = bin_dir / "herdr"
        herdr.write_text('''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
if args[:2] == ["tab", "get"]:
    tab = {"label": os.environ.get("TEST_LABEL", "1")}
    if os.environ.get("TEST_COUNT", "1") != "missing":
        tab["pane_count"] = int(os.environ.get("TEST_COUNT", "1"))
    print(json.dumps({"result": {"tab": tab}}))
elif args[:2] == ["pane", "get"]:
    print(json.dumps({"result": {"pane": {"terminal_title_stripped": "Review PR 12932"}}}))
elif args[1] == "rename":
    with open(os.environ["TEST_CALLS"], "a") as f:
        f.write(json.dumps(args) + "\\n")
else:
    sys.exit(1)
''')
        herdr.chmod(0o755)
        git = bin_dir / "git"
        git.write_text("#!/bin/sh\nexit 0\n")
        git.chmod(0o755)
        self.env = {**os.environ, "HOME": str(self.home), "PATH": f"{bin_dir}:{os.environ['PATH']}",
                    "HERDR_ENV": "1", "HERDR_TAB_ID": "test:tab", "HERDR_PANE_ID": "test:pane",
                    "TEST_CALLS": str(self.calls), "XDG_CACHE_HOME": str(self.home / "cache")}
        for key in ["CODEX_THREAD_ID", "HERDR_AUTONAME"]:
            self.env.pop(key, None)

    def run_hook(self, **fields):
        result = subprocess.run(["bash", str(HOOK)], env=self.env, text=True,
                                input=json.dumps({"cwd": str(self.home), "session_id": "session", **fields}),
                                capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {})
        return [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []

    def test_single_pane_tab_and_repeat(self):
        self.assertEqual(self.run_hook(), [["tab", "rename", "test:tab", "pr_12932"]])
        self.env["TEST_LABEL"] = "pr_12932"
        self.assertEqual(len(self.run_hook()), 1)

    def test_shared_tab_renames_only_pane(self):
        self.env.update(TEST_COUNT="2", TEST_LABEL="human label")
        self.assertEqual(self.run_hook(), [["pane", "rename", "test:pane", "pr_12932"]])

    def test_protected_labels_and_unknown_layout(self):
        for label in ["main", "coordinator", "human label", "PROD-3083 · human summary"]:
            self.env["TEST_LABEL"] = label
            self.assertEqual(self.run_hook(), [])
        self.env.update(TEST_LABEL="1", TEST_COUNT="missing")
        self.assertEqual(self.run_hook(), [])

    def test_ticket_label_becomes_id(self):
        self.env["TEST_LABEL"] = "PROD-3083 · slot 1"
        self.assertEqual(self.run_hook(), [["tab", "rename", "test:tab", "PROD-3083"]])

    def test_coordinator_subagent_and_disabled(self):
        self.assertEqual(self.run_hook(cwd=str(self.home / "Numeral")), [])
        self.assertEqual(self.run_hook(agent_id="child"), [])
        self.env["CODEX_THREAD_ID"] = "parent"
        self.assertEqual(self.run_hook(session_id="child"), [])
        self.env.pop("CODEX_THREAD_ID")
        self.env["HERDR_AUTONAME"] = "0"
        self.assertEqual(self.run_hook(), [])

    def test_claude_transcript_and_codex_index(self):
        transcript = self.home / "claude.jsonl"
        transcript.write_text(json.dumps({"type": "ai-title", "aiTitle": "Review PR 42"}) + "\n")
        self.assertEqual(self.run_hook(transcript_path=str(transcript)),
                         [["tab", "rename", "test:tab", "pr_42"]])
        self.calls.unlink()
        index = self.home / ".codex/session_index.jsonl"
        index.parent.mkdir()
        index.write_text(json.dumps({"id": "session", "thread_name": "Review PR 77"}) + "\n")
        self.assertEqual(self.run_hook(), [["tab", "rename", "test:tab", "pr_77"]])


if __name__ == "__main__":
    unittest.main()
