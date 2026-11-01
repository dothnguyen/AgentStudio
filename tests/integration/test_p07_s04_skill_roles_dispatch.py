"""P07-S04: skill.roles.update through the real request shim without a coordinator."""
import hashlib
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from tests.helpers import Sandbox, req


class SkillRolesUpdateDispatch(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox()
        self.addCleanup(self.sb.cleanup)
        self.ws = os.path.realpath(tempfile.mkdtemp(prefix="as-skill-roles-"))
        self.addCleanup(shutil.rmtree, self.ws, True)
        self.base = os.path.join(self.ws, ".agent-studio")
        self.put("skills/house-style/SKILL.md", b"# House style\nUse it.\n")
        self.put("roles/developer.md", b"Implement.\n")
        self.put("roles/reviewer.md", b"Review.\n")
        self.put("roles.json", json.dumps({"version": 1, "roles": {
            "developer": {"name": "Developer", "instructions": "roles/developer.md",
                          "skills": ["house-style"]},
            "reviewer": {"name": "Reviewer", "instructions": "roles/reviewer.md", "skills": []}}}).encode())
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

    def skill_roles(self, listed):
        return next(item for item in listed["skills"] if item["id"] == "house-style")["roles"]

    def role_skills(self):
        rc, response, proc = self.request("role.list", {"workspace": self.ws})
        self.assertEqual(rc, 0, proc.stderr)
        self.assertTrue(response["ok"], response)
        return {item["id"]: [skill["id"] for skill in item["skills"]]
                for item in response["data"]["items"]}

    def test_list_update_list_changes_every_selected_role_in_one_write(self):
        before = self.listed()
        self.assertEqual([role["id"] for role in self.skill_roles(before)], ["developer"])
        self.assertEqual(self.role_skills(), {"developer": ["house-style"], "reviewer": []})

        rc, response, proc = self.request("skill.roles.update", {
            "workspace": self.ws, "skill": "house-style", "roles": ["developer", "reviewer"],
            "expectedRolesSha256": before["rolesSha256"]})
        self.assertEqual(rc, 0, proc.stderr)
        self.assertTrue(response["ok"], response)
        data = response["data"]
        self.assertEqual(data["workspace"], self.ws)
        self.assertEqual(data["skill"], "house-style")
        self.assertEqual(data["roles"], ["developer", "reviewer"])
        self.assertEqual(data["added"], ["reviewer"])
        self.assertEqual(data["removed"], [])
        self.assertEqual(data["rolesSha256"], hashlib.sha256(Path(self.base, "roles.json").read_bytes()).hexdigest())

        after = self.listed()
        self.assertEqual([role["id"] for role in self.skill_roles(after)], ["developer", "reviewer"])
        self.assertEqual(after["rolesSha256"], data["rolesSha256"])
        self.assertEqual(self.role_skills(), {"developer": ["house-style"], "reviewer": ["house-style"]})
        self.assertEqual(Path(self.base, "roles/developer.md").read_bytes(), b"Implement.\n")
        self.assertEqual(Path(self.base, "roles/reviewer.md").read_bytes(), b"Review.\n")
        self.assertEqual(Path(self.base, "skills/house-style/SKILL.md").read_bytes(),
                         b"# House style\nUse it.\n")
        self.assertFalse(os.path.exists(os.path.join(self.sb.state_dir, "state.db")),
                         "skill.roles.update must not open the state database")

    def test_the_old_token_is_stale_after_the_write_and_changes_nothing(self):
        before = self.listed()
        args = {"workspace": self.ws, "skill": "house-style", "roles": ["reviewer"],
                "expectedRolesSha256": before["rolesSha256"]}
        first = self.request("skill.roles.update", args)[1]
        self.assertTrue(first["ok"], first)
        snapshot = {str(path.relative_to(self.ws)): path.read_bytes()
                    for path in Path(self.ws).rglob("*") if path.is_file()}

        rc, stale, _ = self.request("skill.roles.update", args)
        self.assertFalse(stale["ok"], stale)
        self.assertEqual(stale["error"]["code"], "CONFIG_CHANGED")
        self.assertEqual(stale["data"], {"rolesSha256": self.listed()["rolesSha256"]})
        self.assertEqual({str(path.relative_to(self.ws)): path.read_bytes()
                          for path in Path(self.ws).rglob("*") if path.is_file()}, snapshot)


if __name__ == "__main__":
    unittest.main()
