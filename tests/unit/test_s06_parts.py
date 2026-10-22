"""P00-S06 parts: workflow config, the detached validator, safe git diff capture, prompt composition."""
import json
import os
import subprocess
import tempfile
import unittest

from tests.helpers import make_repo
from agent_studio import gitws, validation, workflow
from agent_studio.protocol import AsError


class Config(unittest.TestCase):
    def ws_with(self, cfg):
        ws = tempfile.mkdtemp()
        os.makedirs(os.path.join(ws, ".agent-studio"))
        with open(os.path.join(ws, ".agent-studio", "workflow.json"), "w") as f:
            f.write(cfg if isinstance(cfg, str) else json.dumps(cfg))
        return ws

    def test_valid_and_invalid(self):
        ok = validation.load_config(self.ws_with({"version": 1, "validation": {"argv": ["make", "test"]}}))
        self.assertEqual(ok["validation"]["argv"], ["make", "test"])
        bad = ["{", {"version": 2, "validation": {"argv": ["x"]}}, {"version": 1},
               {"version": 1, "validation": {"argv": "make test && rm -rf ~"}},
               {"version": 1, "validation": {"argv": []}},
               {"version": 1, "validation": {"argv": ["x"], "timeoutMs": 10}}]
        for cfg in bad:
            with self.assertRaises(AsError, msg=cfg) as cm:
                validation.load_config(self.ws_with(cfg))
            self.assertEqual(cm.exception.code, "WORKFLOW_CONFIG_INVALID")


class Validator(unittest.TestCase):
    def run_it(self, argv, timeout_ms=10000):
        d = tempfile.mkdtemp()
        ws = tempfile.mkdtemp()
        with open(os.path.join(d, "validation.request.json"), "w") as f:
            json.dump({"argv": argv, "cwd": ws, "timeoutMs": timeout_ms}, f)
        validation.run_validator(d)
        return validation.result(d)

    def test_outcomes(self):
        self.assertTrue(self.run_it(["python3", "-c", "print('ok')"])["passed"])
        r = self.run_it(["python3", "-c", "import sys; print('bad'); sys.exit(3)"])
        self.assertEqual((r["passed"], r["exitCode"]), (False, 3))
        r = self.run_it(["python3", "-c", "import time; time.sleep(30)"], timeout_ms=1000)
        self.assertEqual((r["passed"], r["timedOut"]), (False, True))
        r = self.run_it(["definitely-not-a-command-xyz"])
        self.assertFalse(r["passed"])
        self.assertIn("not found", r["error"])
        r = self.run_it(["python3", "-c", "print('x' * 200000)"])
        self.assertTrue(r["passed"])
        self.assertLessEqual(os.path.getsize(r["outputPath"]), validation.MAX_OUTPUT)
        r = self.run_it(["echo", "$(touch CANARY_ARGV)", ";", "rm", "-rf", "~"])
        self.assertTrue(r["passed"])
        self.assertIn("$(touch CANARY_ARGV) ; rm -rf ~", open(r["outputPath"]).read())


class GitCapture(unittest.TestCase):
    def test_diff_includes_untracked_and_ignores_repo_config_commands(self):
        ws = make_repo()
        base = gitws.require_repo(ws)
        canary = os.path.join(tempfile.mkdtemp(), "FSMONITOR_RAN")
        for k, v in (("core.fsmonitor", f"touch {canary}; echo"), ("diff.external", f"touch {canary}"),
                     ("core.pager", f"touch {canary}")):
            subprocess.run(["git", "-C", ws, "config", k, v], check=True)
        with open(os.path.join(ws, "check.py"), "a") as f:
            f.write("# changed\n")
        with open(os.path.join(ws, "new_file.txt"), "w") as f:
            f.write("brand new\n")
        self.assertEqual(len(gitws.dirty_entries(ws)), 2)  # check.py and new_file.txt; .git/config is never listed
        out = tempfile.mkdtemp()
        d = gitws.capture_diff(ws, base, out)
        text = open(d["path"]).read()
        self.assertIn("# changed", text)
        self.assertIn("brand new", text)
        self.assertEqual(d["untrackedFiles"], ["new_file.txt"])
        self.assertFalse(os.path.exists(canary), "repository config must never run a program")

    def test_not_a_repo(self):
        with self.assertRaises(AsError) as cm:
            gitws.require_repo(tempfile.mkdtemp())
        self.assertEqual(cm.exception.code, "WORKSPACE_NOT_GIT")


class Prompts(unittest.TestCase):
    def test_sections_and_bounds(self):
        from agent_studio import prompts, workflowdef
        d = workflowdef.load(tempfile.mkdtemp(), "developer-reviewer", workflow.BUILTIN_DIR)
        st = next(x for x in d.stages if x.id == "developer_repair")
        p = prompts.render(st.prompt, kind=st.kind, task="task $(x)", diff="d" * (300 * 1024), validation="v",
                           findings=["f1", "`f2`"], stage=st.id, visit=1)
        for s in ("===== TASK =====", "task $(x)", "===== DIFF =====", "DIFF truncated", "===== FINDINGS =====",
                  "- `f2`", "===== VALIDATION ====="):
            self.assertIn(s, p)
        rv = next(x for x in d.stages if x.id == "reviewer")
        self.assertIn("JSON", prompts.render(rv.prompt, kind=rv.kind, task="t", stage=rv.id, visit=1))


if __name__ == "__main__":
    unittest.main()
