"""P07-S03: skill.delete through the real request shim without a coordinator."""
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from tests.helpers import Sandbox, req


class SkillDeleteDispatch(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox()
        self.addCleanup(self.sb.cleanup)
        self.ws = os.path.realpath(tempfile.mkdtemp(prefix="as-skill-delete-"))
        self.addCleanup(shutil.rmtree, self.ws, True)
        self.base = os.path.join(self.ws, ".agent-studio")
        self.put("skills/house-style/SKILL.md", b"# House style\nUse it.\n")
        self.put("skills/spare/SKILL.md", b"# Spare\nUnused.\n")
        self.put("roles/developer.md", b"Implement.\n")
        self.put("roles.json", json.dumps({"version": 1, "roles": {
            "Developer": {"instructions": "roles/developer.md",
                          "skills": ["house-style", "legacy-notes"]}}}).encode())
        self.roles_before = Path(self.base, "roles.json").read_bytes()

    def put(self, rel, data):
        path = os.path.join(self.base, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)

    def request(self, command, args):
        return self.sb.request(req(command, args))

    def listed(self):
        rc, response, proc = self.request("skill.list", {"workspace": self.ws})
        self.assertEqual(rc, 0, proc.stderr)
        self.assertTrue(response["ok"], response)
        return response["data"]

    def delete(self, skill, roles_sha="current", file_sha="current", **over):
        data = self.listed()
        item = next(entry for entry in data["skills"] if entry["id"] == skill)
        args = {"workspace": self.ws, "skill": skill,
                "expectedRolesSha256": data["rolesSha256"] if roles_sha == "current" else roles_sha,
                "expectedSha256": item["sha256"] if file_sha == "current" else file_sha}
        args.update(over)
        return self.request("skill.delete", args)

    def test_list_delete_list_shows_the_skill_gone(self):
        before = self.listed()
        self.assertEqual([item["id"] for item in before["skills"]], ["house-style", "legacy-notes", "spare"])
        rc, deleted, proc = self.delete("spare")
        self.assertEqual(rc, 0, proc.stderr)
        self.assertTrue(deleted["ok"], deleted)
        self.assertEqual(deleted["data"]["workspace"], self.ws)
        self.assertEqual(deleted["data"]["deleted"], {"id": "spare", "folder": "removed"})
        self.assertEqual(deleted["data"]["rolesSha256"], before["rolesSha256"])
        self.assertFalse(Path(self.base, "skills", "spare", "SKILL.md").exists())
        self.assertFalse(Path(self.base, "skills", "spare").exists())

        after = self.listed()
        self.assertEqual([item["id"] for item in after["skills"]], ["house-style", "legacy-notes"])
        self.assertEqual(after["rolesSha256"], before["rolesSha256"])
        self.assertEqual(Path(self.base, "roles.json").read_bytes(), self.roles_before)
        self.assertEqual(Path(self.base, "skills", "house-style", "SKILL.md").read_bytes(),
                         b"# House style\nUse it.\n")
        self.assertFalse(os.path.exists(os.path.join(self.sb.state_dir, "state.db")),
                         "skill.delete must not open the state database")
