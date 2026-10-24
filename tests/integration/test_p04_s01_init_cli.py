import json
import os
import shutil
import tempfile
import unittest

from tests.helpers import Sandbox


class InitCliTests(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox()
        self.addCleanup(self.sb.cleanup)
        self.cwd = os.path.realpath(tempfile.mkdtemp(prefix="as-init-"))
        self.addCleanup(shutil.rmtree, self.cwd, True)

    def test_init_then_list_json_and_request_still_json(self):
        import subprocess
        from tests.helpers import SHIM
        proc = subprocess.run([SHIM, "init", "--json"], cwd=self.cwd, env=self.sb.env,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertTrue(json.loads(proc.stdout)["ok"])
        self.assertTrue(os.path.isfile(os.path.join(self.cwd, ".agent-studio", "workspace.json")))
        rc, resp, _ = self.sb.run("workspace", "list", "--json")
        self.assertEqual(rc, 0)
        self.assertEqual([w["path"] for w in resp["data"]["workspaces"]], [self.cwd])
        rc, resp, _ = self.sb.request({"protocol": "agent-studio/v1", "id": "1", "command": "health"})
        self.assertEqual(rc, 0)
        self.assertTrue(resp["ok"])


if __name__ == "__main__":
    unittest.main()
