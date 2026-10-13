import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "herdr/.config/herdr/plugins/nvim-links/open.py"
spec = importlib.util.spec_from_file_location("nvim_links", MODULE)
links = importlib.util.module_from_spec(spec)
spec.loader.exec_module(links)


class RoutingTests(unittest.TestCase):
    def test_locations(self):
        for value, expected in [
            ("src/[id].tsx:709", ("src/[id].tsx", 709, 1)),
            ("@src/a.ts:12:3", ("src/a.ts", 12, 3)),
            ("src/a.ts:12-19", ("src/a.ts", 12, 1)),
            ("file:///tmp/a%20b.ts#L42-L47", ("/tmp/a b.ts", 42, 1)),
            ("file:///tmp/a.ts:12:3", ("/tmp/a.ts", 12, 3)),
        ]:
            path, line, column = links.parse_location(value)
            self.assertEqual((str(path), line, column), expected)
        for value in ("file://other-host/tmp/a.ts", "src/a.ts:0", "src/a.ts"):
            with self.assertRaises(ValueError):
                links.parse_location(value)

    def test_parent_agent_cwd_resolves_against_sibling_checkout(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            checkout = root / "tax-holiday"
            (checkout / "src").mkdir(parents=True)
            target = checkout / "src/a.ts"
            target.touch()
            editor = {"cwd": str(checkout)}
            self.assertEqual(links.choose_editor(Path("src/a.ts"), str(root), [editor]), (editor, target))

    def test_agent_checkout_wins_and_ambiguity_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            editors = []
            for name in ("main", "worktree"):
                checkout = root / name
                checkout.mkdir()
                (checkout / "a.ts").touch()
                editors.append({"cwd": str(checkout)})
            editor, path = links.choose_editor(Path("a.ts"), str(root / "worktree"), editors)
            self.assertEqual(editor, editors[1])
            self.assertEqual(path, root / "worktree/a.ts")
            with self.assertRaisesRegex(ValueError, "multiple sibling checkouts"):
                links.choose_editor(Path("a.ts"), str(root), editors)
            with self.assertRaisesRegex(ValueError, "No registered Neovim"):
                links.choose_editor(Path("a.ts"), str(root), [])


class NeovimRpcTests(unittest.TestCase):
    def test_rpc_cursor_registration_and_modified_buffer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            server = str(root / "nvim.sock")
            env = dict(os.environ, HERDR_ENV="1", HERDR_PANE_ID="test:p1",
                       HERDR_SOCKET_PATH=str(root / "herdr.sock"), XDG_STATE_HOME=str(root / "state"))
            process = subprocess.Popen([
                "nvim", "--headless", "-u", "NONE", "--listen", server,
                "-c", 'lua package.path = ' + json.dumps(str(ROOT / "neovim/.config/nvim/lua/?.lua;")) + ' .. package.path; require("config.herdr_links").setup()',
            ], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            try:
                for _ in range(50):
                    if Path(server).exists() and list((root / "state").rglob("test_p1.json")):
                        break
                    time.sleep(0.1)
                self.assertIsNone(process.poll())
                registrations = list((root / "state").rglob("test_p1.json"))
                self.assertEqual(len(registrations), 1)
                entry = json.loads(registrations[0].read_text())
                self.assertEqual(entry["pid"], process.pid)
                target = root / "quoted' file|name.ts"
                target.write_text("first\nsecond\nthird\n")
                result = links.rpc(server, 'require("config.herdr_links").open(_A)', {
                    "path": str(target), "line": 2, "column": 3,
                })
                self.assertTrue(result["ok"], result)
                actual = links.rpc(server, '{path=vim.api.nvim_buf_get_name(0), cursor=vim.api.nvim_win_get_cursor(0)}')
                self.assertEqual(actual, {"path": str(target), "cursor": [2, 2]})
                links.rpc(server, '(function() vim.o.hidden=false; vim.api.nvim_buf_set_lines(0,0,1,false,{"unsaved"}); return true end)()')
                other = root / "other.ts"
                other.touch()
                result = links.rpc(server, 'require("config.herdr_links").open(_A)', {"path": str(other)})
                self.assertFalse(result["ok"], result)
                self.assertEqual(links.rpc(server, 'vim.api.nvim_get_current_line()'), "second")
                self.assertEqual(links.rpc(server, 'vim.api.nvim_buf_get_lines(0,0,1,false)'), ["unsaved"])
                subprocess.run(["nvim", "--server", server, "--remote-send", "<C-\\><C-N>:qa!<CR>"], check=True, capture_output=True)
                process.wait(timeout=5)
                self.assertFalse(registrations[0].exists())
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=5)
                process.stderr.close()


if __name__ == "__main__":
    unittest.main()
