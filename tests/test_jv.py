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

            # An uncommitted edit on the checked-out PR goes into the stack's net.
            (repo / "bottom.txt").write_text("stackneedle from bottom\nlocalstackneedle\n")
            frame = run(*args)
            self.assertIn("+ local: uncommitted changes", frame)
            self.assertIn("localstackneedle", frame)
            self.assertIn("top.test.txt", frame)

    def test_flat_is_net_of_pr_and_local_work(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo, origin, fake_bin = root / "work", root / "origin.git", root / "bin"
            repo.mkdir()
            fake_bin.mkdir()
            env = {k: v for k, v in os.environ.items() if not k.startswith(("GIT_", "_JV_"))}
            env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
                       TUI_THEME="onedark", JV_THEME="TwoDark", XDG_STATE_HOME=tmp)
            env["PATH"] = str(fake_bin) + os.pathsep + env["PATH"]

            def run(*args):
                return subprocess.run(args, cwd=repo, env=env, stdin=subprocess.DEVNULL,
                                      text=True, capture_output=True, check=True, timeout=300).stdout

            def commit(message, files):
                for name, contents in files.items():
                    (repo / name).write_text(contents + "\n")
                run("git", "add", "--", *files)
                run("git", "commit", "-qm", message)
                return run("git", "rev-parse", "HEAD").strip()

            run("git", "init", "-qb", "main")
            run("git", "config", "user.name", "Net Test")
            run("git", "config", "user.email", "net@example.com")
            run("git", "init", "-q", "--bare", "-b", "main", str(origin))
            run("git", "remote", "add", "origin", str(origin))
            commit("fork point", {"shared.txt": "base"})
            run("git", "push", "-q", "origin", "main")
            run("git", "switch", "-qc", "feat")
            pushed = commit("PR", {"feature.txt": "pushedneedle", "shared.txt": "fixed"})
            run("git", "push", "-q", "origin", "feat")
            run("git", "switch", "-q", "main")
            commit("trunk landed the same fix", {"shared.txt": "fixed", "trunk.txt": "trunkneedle"})
            run("git", "push", "-q", "origin", "main")
            run("git", "switch", "-q", "feat")
            commit("not pushed yet", {"unpushed.txt": "unpushedneedle"})
            (repo / "staged.txt").write_text("stagedneedle\n")
            run("git", "add", "staged.txt")
            (repo / "feature.txt").write_text("pushedneedle\ndirtyneedle\n")
            (repo / "untracked.txt").write_text("untrackedneedle\n")
            status = run("git", "status", "--porcelain")

            pr = {"number": 5, "state": "OPEN", "headRefName": "feat", "headRefOid": pushed,
                  "baseRefName": "main", "isCrossRepository": False,
                  "url": "https://github.com/example/repo/pull/5"}
            gh = fake_bin / "gh"
            gh.write_text("#!/bin/sh\n"
                          "if [ \"$1\" = repo ]; then echo example/repo; exit 0; fi\n"
                          "if [ -n \"$NO_PR\" ]; then echo \"no pull requests found for branch\" >&2; exit 1; fi\n"
                          "case \"$*\" in\n"
                          "  *--jq*) printf '5\\tFix the thing\\tsomeone\\tfeat\\tmain\\tfalse\\tOPEN\\t"
                          "https://github.com/example/repo/pull/5\\n' ;;\n"
                          "  'pr view'*) cat <<'EOF'\n" + json.dumps(pr) + "\nEOF\n ;;\n"
                          "  *) echo \"unexpected gh $*\" >&2; exit 1 ;;\n"
                          "esac\n")
            gh.chmod(0o755)

            frame = run(BIN / "jf", "--snapshot", "160x40")
            self.assertIn("#5", frame)
            self.assertIn("net + local: 1 unpushed commit, uncommitted changes", frame)
            for needle in ("pushedneedle", "dirtyneedle", "unpushedneedle", "stagedneedle"):
                self.assertIn(needle, frame)
            # main already has the PR's fix; untracked files aren't in git diff either.
            for absent in ("shared.txt", "trunk.txt", "untrackedneedle"):
                self.assertNotIn(absent, frame)
            # The snapshot leaves the index and working tree alone.
            self.assertEqual(status, run("git", "status", "--porcelain"))

            env["NO_PR"] = "1"
            run("git", "stash", "-q")
            run("git", "switch", "-qc", "solo", "origin/main")
            commit("solo work", {"solo.txt": "soloneedle"})
            frame = run(BIN / "jf", "--snapshot", "160x40")
            self.assertIn("no PR · net of solo onto main: 1 commit not on main", frame)
            self.assertIn("soloneedle", frame)
            self.assertNotIn("trunk.txt", frame)

    def test_flat_replays_an_older_checkout_onto_the_push(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo, origin, fake_bin = root / "work", root / "origin.git", root / "bin"
            repo.mkdir()
            fake_bin.mkdir()
            env = {k: v for k, v in os.environ.items() if not k.startswith(("GIT_", "_JV_"))}
            env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
                       TUI_THEME="onedark", JV_THEME="TwoDark", XDG_STATE_HOME=tmp)
            env["PATH"] = str(fake_bin) + os.pathsep + env["PATH"]

            def run(*args):
                return subprocess.run(args, cwd=repo, env=env, stdin=subprocess.DEVNULL,
                                      text=True, capture_output=True, check=True, timeout=300).stdout

            def commit(message, files):
                for name, contents in files.items():
                    (repo / name).write_text(contents + "\n")
                run("git", "add", "--", *files)
                run("git", "commit", "-qm", message)
                return run("git", "rev-parse", "HEAD").strip()

            run("git", "init", "-qb", "main")
            run("git", "config", "user.name", "Net Test")
            run("git", "config", "user.email", "net@example.com")
            run("git", "init", "-q", "--bare", "-b", "main", str(origin))
            run("git", "remote", "add", "origin", str(origin))
            commit("fork point", {"shared.txt": "base"})
            run("git", "push", "-q", "origin", "main")
            run("git", "switch", "-qc", "feat")
            old = commit("PR", {"feature.txt": "featureneedle"})
            run("git", "push", "-q", "origin", "feat")
            # Elsewhere, main moves and the PR is rebased onto it and grows.
            run("git", "switch", "-q", "main")
            commit("trunk", {"trunk.txt": "trunkneedle"})
            run("git", "push", "-q", "origin", "main")
            run("git", "switch", "-qc", "elsewhere")
            run("git", "cherry-pick", old)
            pushed = commit("later", {"later.txt": "laterneedle"})
            run("git", "push", "-qf", "origin", "elsewhere:feat")
            # This checkout still has the old copy, plus an edit.
            run("git", "switch", "-q", "feat")
            (repo / "feature.txt").write_text("featureneedle\neditneedle\n")

            pr = {"number": 9, "state": "OPEN", "headRefName": "feat", "headRefOid": pushed,
                  "baseRefName": "main", "isCrossRepository": False,
                  "url": "https://github.com/example/repo/pull/9"}
            gh = fake_bin / "gh"
            gh.write_text("#!/bin/sh\n"
                          "if [ \"$1\" = repo ]; then echo example/repo; exit 0; fi\n"
                          "case \"$*\" in\n"
                          "  *--jq*) exit 1 ;;\n"
                          "  'pr view'*) cat <<'EOF'\n" + json.dumps(pr) + "\nEOF\n ;;\n"
                          "  *) echo \"unexpected gh $*\" >&2; exit 1 ;;\n"
                          "esac\n")
            gh.chmod(0o755)

            frame = run(BIN / "jf", "--snapshot", "160x40")
            self.assertIn("net + local: uncommitted changes, replayed onto the push", frame)
            for needle in ("featureneedle", "editneedle", "laterneedle"):
                self.assertIn(needle, frame)
            self.assertNotIn("trunk.txt", frame)
            self.assertNotIn("⚠", frame)
