"""P07-S02: skill.create and skill.update through the real request shim."""
import hashlib
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from tests.helpers import Sandbox, req


OLD_SKILL = b"SKILL-MARKER: four-space indents.\n"


class SkillWriteDispatch(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox()
        self.addCleanup(self.sb.cleanup)
        self.ws = os.path.realpath(tempfile.mkdtemp(prefix="as-skill-write-"))
        self.addCleanup(shutil.rmtree, self.ws, True)
        self.base = os.path.join(self.ws, ".agent-studio")
        self.put("skills/house-style/SKILL.md", OLD_SKILL)
        self.put("roles.json", json.dumps({"version": 1, "roles": {
            "Developer": {"instructions": "roles/developer.md", "skills": ["house-style"]}}}).encode())
        self.put("roles/developer.md", b"Implement.\n")

    def put(self, rel, data):
        path = os.path.join(self.base, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)

    def request(self, command, args):
        return self.sb.request(req(command, args))

    def test_create_show_update_show_round_trip(self):
        roles_before = Path(self.base, "roles.json").read_bytes()
        rc, created, proc = self.request("skill.create", {
            "workspace": self.ws, "skill": {"id": "new-skill", "text": "# New skill\ncontent\n"}})
        self.assertEqual(rc, 0, proc.stderr)
        self.assertTrue(created["ok"], created)
        item = created["data"]["skill"]
        data = b"# New skill\ncontent\n"
        self.assertEqual((item["id"], item["path"], item["state"], item["title"], item["bytes"], item["sha256"]),
                         ("new-skill", "skills/new-skill/SKILL.md", "ok", "New skill", len(data),
                          hashlib.sha256(data).hexdigest()))
        self.assertEqual(created["data"]["text"], data.decode())
        self.assertEqual(Path(self.base, "skills/new-skill/SKILL.md").read_bytes(), data)

        shown = self.request("skill.show", {"workspace": self.ws, "skill": "new-skill"})[1]
        self.assertEqual(shown["data"]["skill"], item)

        rc, updated, _ = self.request("skill.update", {
            "workspace": self.ws, "skill": "new-skill", "text": "# New skill\nedited\n",
            "expectedSha256": item["sha256"]})
        self.assertTrue(updated["ok"], updated)
        self.assertEqual(updated["data"]["text"], "# New skill\nedited\n")
        self.assertNotEqual(updated["data"]["skill"]["sha256"], item["sha256"])
        shown = self.request("skill.show", {"workspace": self.ws, "skill": "new-skill"})[1]
        self.assertEqual(shown["data"]["text"], "# New skill\nedited\n")
        self.assertEqual(Path(self.base, "roles.json").read_bytes(), roles_before)
        self.assertFalse(os.path.exists(os.path.join(self.sb.state_dir, "state.db")),
                         "skill writes must not open the state database")
