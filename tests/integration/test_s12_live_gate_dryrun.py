"""P00-S12: dry run of the live gate script against the stand-in codex and claude CLIs, in an isolated state dir,
HOME and tmux server. Proves the script's own logic; the real gate needs real providers (see the S12 story)."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

from tests.helpers import REPO

FIX = os.path.join(REPO, "tests", "fixtures")
GATE = os.path.join(REPO, "scripts", "live", "live_gate.py")


class DryRun(unittest.TestCase):
    def test_gate_with_stand_ins(self):
        root = tempfile.mkdtemp(prefix="as-gate-")
        try:
            bin_dir = os.path.join(root, "bin")
            os.makedirs(bin_dir)
            for p in ("codex", "claude"):
                shutil.copy(os.path.join(FIX, p, "bin", p), os.path.join(bin_dir, p))
            for ctl in ("fake-codex.json", "fake-claude.json"):
                with open(os.path.join(bin_dir, ctl), "w") as f:
                    json.dump({"slowSeconds": 8}, f)
            home = os.path.join(root, "home")
            os.makedirs(os.path.join(home, ".ntm"))
            with open(os.path.join(home, ".ntm", "keep.txt"), "w") as f:
                f.write("pre-existing")
            tmuxdir = os.path.join(root, "tmux")
            os.makedirs(tmuxdir, mode=0o700)
            env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "TMUX_PANE")}
            env.update(HOME=home, XDG_STATE_HOME=os.path.join(root, "state"), TMUX_TMPDIR=tmuxdir,
                       AGENT_STUDIO_ENV_MODE="inherit", PATH=bin_dir + os.pathsep + env.get("PATH", "/usr/bin:/bin"))
            env.pop("CODEX_HOME", None)
            env.pop("CLAUDE_CONFIG_DIR", None)
            subprocess.run(["tmux", "new-session", "-d", "-s", "users-own-session"], env=env, check=True)
            p = subprocess.run([sys.executable, GATE, "run", "--providers", "codex,claude", "--non-interactive",
                                "--skip-deterministic", "--reviewer-model", "sonnet", "--reviewer-reasoning", "low"],
                               env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=600)
            out = p.stdout.decode()
            bundle = [l.split("Evidence: ", 1)[1] for l in out.splitlines() if l.startswith("Evidence: ")]
            self.assertTrue(bundle, out)
            with open(os.path.join(bundle[0], "summary.json")) as f:
                summary = json.load(f)
            results = {s["id"]: s for s in summary["steps"]}
            for sid in ("1a", "1b", "1c", "2a", "2b", "3", "6", "8", "7"):
                self.assertEqual(results[sid]["result"], "PASS", (sid, results[sid], out[-3000:]))
            self.assertEqual(results["5"]["result"], "MANUAL")
            self.assertEqual(summary["gate"], "INCOMPLETE")
            self.assertEqual(summary["workflow"]["providers"], ["claude", "codex"])
            drills = results["8"]["drills"]
            self.assertEqual(drills["timeout"]["code"], "TIMEOUT")
            self.assertNotEqual(drills["providerKilled"]["status"], "succeeded")
            self.assertEqual(results["6"]["providerStarts"], 1)
            sessions = subprocess.run(["tmux", "list-sessions", "-F", "#{session_name}"], env=env,
                                      stdout=subprocess.PIPE).stdout.decode().split()
            self.assertEqual(sessions, ["users-own-session"])
        finally:
            subprocess.run([os.path.join(REPO, "backend", "bin", "agent-studio"), "coordinator", "stop"],
                           env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
            for args in (["-L", "agent-studio", "kill-server"], ["kill-server"]):
                subprocess.run(["tmux"] + args, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
