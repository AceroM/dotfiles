"""Public o: exercise the real launcher with isolated config, state, and cache."""

from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "o/.local/share/o"
LAUNCHER = ROOT / "o/.local/bin/o"
AGENTS = ["claude(opus)", "claude(fable)", "codex(sol)", "codex(astra)"]


class PublicOTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which("go"):
            raise unittest.SkipTest("Go is required")
        cls.scratch = tempfile.TemporaryDirectory(prefix="public-o-test-")
        cls.addClassCleanup(cls.scratch.cleanup)
        cls.base = Path(cls.scratch.name)
        cls.env = dict(os.environ, O_HOME=str(SOURCE),
                       XDG_CONFIG_HOME=str(cls.base / "config"),
                       XDG_STATE_HOME=str(cls.base / "state"),
                       XDG_CACHE_HOME=str(cls.base / "cache"),
                       O_AGENT=AGENTS[0], O_PROFILE="main", O_BG="#000000")
        result = cls.run_o("--build-only")
        if result.returncode:
            raise AssertionError(result.stderr)

    @classmethod
    def run_o(cls, *args, **overrides):
        return subprocess.run([str(LAUNCHER), *args], cwd=cls.base,
                              env={**cls.env, **overrides}, text=True,
                              capture_output=True, timeout=120)

    def test_config_and_defaults_contain_the_four_shortcuts(self):
        for config_home in (self.env["XDG_CONFIG_HOME"], str(ROOT / "o/.config")):
            result = self.run_o("--config", XDG_CONFIG_HOME=config_home)
            self.assertEqual(result.returncode, 0, result.stderr)
            rows = [line.split() for line in result.stdout.splitlines()
                    if line.strip().startswith("^") and line.strip()[1:2].isdigit()]
            self.assertEqual([(r[0], r[1]) for r in rows],
                             [(f"^{i}", name) for i, name in enumerate(AGENTS, 1)])
            self.assertIn("Drafts are stored locally", result.stdout)

    def test_slash_preview_edit_expand_and_literal_escape(self):
        result = self.run_o("--snapshot", "80x24", "--keys",
                            "/save review Check correctness.<CR>")
        self.assertEqual(result.returncode, 0, result.stderr)
        saved = self.base / ".o/commands/review.md"
        self.assertIn("would save /review", result.stdout)
        self.assertFalse(saved.exists())
        saved.parent.mkdir(parents=True)
        saved.write_text("Check correctness.\n")
        expanded = self.run_o("--snapshot", "80x24", "--keys", "/review focus here<CR>")
        self.assertIn("Check correctness.", expanded.stdout)
        self.assertIn("focus here", expanded.stdout)
        self.assertNotIn("sent:", expanded.stderr)
        sent = self.run_o("--snapshot", "80x24", "--keys", "/review focus here<CR><CR>")
        self.assertIn('sent: "Check correctness.\\n\\nfocus here"', sent.stderr)
        edit = self.run_o("--snapshot", "80x24", "--keys", "/edit review<CR>")
        self.assertIn("/save review", edit.stdout)
        literal = self.run_o("--snapshot", "80x24", "--keys", "//review native<CR>")
        self.assertIn('sent: "/review native"', literal.stderr)

    def test_shortcuts_select_each_agent_and_cycle(self):
        for i, name in enumerate(AGENTS, 1):
            result = self.run_o("--snapshot", "80x24", "--keys", f"<C-{i}>")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(f"{name} >", result.stdout)
        wrapped = self.run_o("--snapshot", "80x24", "--keys", "<C-4><BackTab>")
        self.assertIn("claude(opus) >", wrapped.stdout)

    def test_ctrl_s_saves_clears_and_reopens_a_draft(self):
        text = "save this prompt for later"
        cleared = self.run_o("--snapshot", "80x24", "--keys", f"{text}<C-s>")
        self.assertEqual(cleared.returncode, 0, cleared.stderr)
        self.assertIn("claude(opus) >\n", cleared.stdout)
        self.assertIn("saved as a draft", cleared.stdout)
        self.assertNotIn(text, cleared.stdout)
        reopened = self.run_o("--snapshot", "80x24", "--keys", f"{text}<C-s><C-g>e")
        self.assertEqual(reopened.returncode, 0, reopened.stderr)
        self.assertIn(f"claude(opus) ◇ {text}", reopened.stdout)
        self.assertNotIn("sent:", reopened.stderr)

    def test_no_network_dependencies_or_account_commands(self):
        deps = subprocess.run(["go", "list", "-deps", "."], cwd=SOURCE,
                              capture_output=True, text=True, timeout=60)
        self.assertEqual(deps.returncode, 0, deps.stderr)
        self.assertFalse(any(p == "net" or p.startswith("net/")
                             for p in deps.stdout.splitlines()), deps.stdout)
        for flag in ("--sync", "--sign-in", "--sign-out"):
            result = self.run_o(flag)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertIn("unknown option", result.stderr)

    def test_launcher_uses_its_own_cache_and_reuses_the_build(self):
        binary = self.base / "cache/o-public/o"
        self.assertTrue(binary.is_file())
        stamp = binary.stat().st_mtime_ns
        result = self.run_o("--build-only")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(binary.stat().st_mtime_ns, stamp)
        self.assertFalse((self.base / "state").exists())


if __name__ == "__main__":
    unittest.main()
