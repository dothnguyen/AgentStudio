"""P04-S11: dry run of the board live-gate script on the fake provider, in an isolated state dir, HOME and
tmux server. Proves the script's own logic; the real gate needs real providers (see the S11 story)."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

from tests.helpers import REPO

GATE = os.path.join(REPO, "scripts", "live", "board_live_gate.py")


class DryRun(unittest.TestCase):
    def test_board_gate_dry_run(self):
        root = tempfile.mkdtemp(prefix="as-boardgate-test-")
        env = None
        try:
            os.makedirs(os.path.join(root, "tmux"), mode=0o700)
            home = os.path.join(root, "home")
            os.makedirs(home)
            env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "TMUX_PANE")}
            env.update(HOME=home, XDG_STATE_HOME=os.path.join(root, "state"),
                       TMUX_TMPDIR=os.path.join(root, "tmux"), AGENT_STUDIO_ENV_MODE="inherit")
            p = subprocess.run([sys.executable, GATE, "run", "--dry-run"], env=env,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=540)
            out = p.stdout.decode()
            self.assertEqual(p.returncode, 0, out[-3000:])
            bundle = [l.split("Evidence: ", 1)[1] for l in out.splitlines() if l.startswith("Evidence: ")]
            self.assertTrue(bundle, out)
            with open(os.path.join(bundle[0], "summary.json")) as f:
                summary = json.load(f)
            self.assertEqual(summary["gate"], "DRY-RUN (fake provider; plumbing proof, not live-gate evidence)")
            results = {s["id"]: s["result"] for s in summary["steps"]}
            for step in ("0-rules", "1-teams", "2-phase-current", "3-tickets", "4-run-board",
                         "5-other-team-ask", "6-three-done", "8-other-phase-untouched"):
                self.assertEqual(results[step], "PASS", (step, summary["steps"]))
            self.assertEqual(results["7-dependency-and-forced-fail"], "SKIP")  # fake gives no verdicts
        finally:
            if env:
                subprocess.run([os.path.join(REPO, "backend", "bin", "agent-studio"), "coordinator", "stop"],
                               env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
                for args in (["-L", "agent-studio", "kill-server"], ["kill-server"]):
                    subprocess.run(["tmux"] + args, env=env, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL)
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
