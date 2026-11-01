"""P07-S01: skill.list and skill.show work through the real request shim without a coordinator."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest

from tests.helpers import Sandbox, req
from agent_studio import skills


class SkillDispatchTests(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox()
        self.addCleanup(self.sb.cleanup)
        self.ws = os.path.realpath(tempfile.mkdtemp(prefix="as-skills-"))
        self.addCleanup(shutil.rmtree, self.ws, True)
        self.base = os.path.join(self.ws, ".agent-studio")
        os.makedirs(os.path.join(self.base, "skills"))
        self.put("skills/python-testing/SKILL.md", b"# Python testing\nUse unittest.\n")
        self.put("roles/developer.md", b"Implement.\n")
        self.put("roles.json", json.dumps({"version": 1, "roles": {
            "Developer": {"name": "Developer", "instructions": "roles/developer.md",
                          "skills": ["python-testing", "missing"]}}}).encode())

    def put(self, rel, data):
        path = os.path.join(self.base, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)

    def snapshot(self):
        return {str(path.relative_to(self.ws)): path.read_bytes()
                for path in Path(self.ws).rglob("*") if path.is_file()}

    def test_skill_list_matches_the_direct_projection_and_is_read_only(self):
        before = self.snapshot()
        rc, response, proc = self.sb.request(req("skill.list", {"workspace": self.ws}))
        self.assertEqual(rc, 0, proc.stderr)
        self.assertTrue(response["ok"], response)
        expected = skills.list_skills(self.ws)
        self.assertEqual(response["data"], expected)
        self.assertEqual([item["id"] for item in response["data"]["skills"]],
                         ["missing", "python-testing"])
        self.assertEqual(response["data"]["rolesSha256"],
                         hashlib.sha256(Path(self.base, "roles.json").read_bytes()).hexdigest())
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(os.path.exists(os.path.join(self.sb.state_dir, "state.db")),
                         "skill.list must not open the state database")

    def test_skill_show_returns_the_same_item_and_text(self):
        before = self.snapshot()
        rc, response, proc = self.sb.request(
            req("skill.show", {"workspace": self.ws, "skill": "python-testing"}))
        self.assertEqual(rc, 0, proc.stderr)
        self.assertTrue(response["ok"], response)
        item = response["data"]["skill"]
        self.assertEqual((item["id"], item["title"], item["state"]), ("python-testing", "Python testing", "ok"))
        self.assertEqual(response["data"]["text"], "# Python testing\nUse unittest.\n")
        missing = self.sb.request(req("skill.show", {"workspace": self.ws, "skill": "missing"}))[1]["data"]
        self.assertEqual((missing["skill"]["state"], missing["text"]), ("missing", None))
        rc, unknown, _ = self.sb.request(req("skill.show", {"workspace": self.ws, "skill": "absent"}))
        self.assertEqual(unknown["error"]["code"], "SKILL_NOT_FOUND")
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(os.path.exists(os.path.join(self.sb.state_dir, "state.db")),
                         "skill.show must not open the state database")


if __name__ == "__main__":
    unittest.main()
