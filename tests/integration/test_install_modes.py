"""A checkout whose executable bits were lost (git on a Windows drive, core.fileMode=false): team.start must say
so clearly, and install.sh must restore them."""
import os
import shutil
import subprocess
import tempfile
import unittest

from tests.helpers import BACKEND, Sandbox, key, req


class LostExecBits(unittest.TestCase):
    def setUp(self):
        self.copy = os.path.join(tempfile.mkdtemp(prefix="as-copy-"), "backend")
        shutil.copytree(BACKEND, self.copy, ignore=shutil.ignore_patterns("__pycache__"))
        for f in ("agent-studio", "agent-studio-worker"):
            os.chmod(os.path.join(self.copy, "bin", f), 0o644)
        os.chmod(os.path.join(self.copy, "install.sh"), 0o644)
        self.sb = Sandbox(extra_env={"AGENT_STUDIO_TEST_FIXTURE_PROVIDERS": "codex=fake"})
        self.shim = os.path.join(self.copy, "bin", "agent-studio")

    def tearDown(self):
        subprocess.run(["bash", self.shim, "coordinator", "stop"], env=self.sb.env, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL)
        self.sb.cleanup()
        shutil.rmtree(os.path.dirname(self.copy), ignore_errors=True)

    def test_clear_error_then_install_fixes_it(self):
        def run(*args, stdin=None):
            p = subprocess.run(["bash", self.shim] + list(args), input=stdin, env=self.sb.env,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
            import json
            return json.loads(p.stdout.decode().splitlines()[-1])
        self.assertTrue(run("coordinator", "start", "--enable-debug")["ok"])
        ws = tempfile.mkdtemp()
        import json
        body = json.dumps(req("team.start", {"workspace": ws, "roster": [{"providerId": "codex", "role": "d"}]},
                              idempotencyKey=key())).encode()
        r = run("request", stdin=body)
        self.assertEqual(r["error"]["code"], "BACKEND_UNAVAILABLE")
        self.assertIn("not executable", r["error"]["message"])
        self.assertIn("install.sh", r["error"]["remediation"])
        env = dict(self.sb.env, HOME=tempfile.mkdtemp())
        subprocess.run(["bash", os.path.join(self.copy, "install.sh")], env=env, check=True, stdout=subprocess.DEVNULL)
        self.assertTrue(os.access(os.path.join(self.copy, "bin", "agent-studio-worker"), os.X_OK))
        body = json.dumps(req("team.start", {"workspace": ws, "roster": [{"providerId": "codex", "role": "d"}]},
                              idempotencyKey=key())).encode()
        r = run("request", stdin=body)
        self.assertTrue(r["ok"], r)


if __name__ == "__main__":
    unittest.main()
