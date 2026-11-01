"""P07-S03: skill.delete through the real request shim without a coordinator."""
import hashlib
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

    def snapshot(self):
        return {str(path.relative_to(self.ws)): path.read_bytes()
                for path in Path(self.ws).rglob("*") if path.is_file()}

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

    def test_in_use_skill_is_refused_with_the_roles_and_nothing_is_removed(self):
        before = self.snapshot()
        rc, response, _ = self.delete("house-style")
        self.assertFalse(response["ok"], response)
        self.assertEqual(response["error"]["code"], "SKILL_IN_USE")
        self.assertEqual(response["data"], {"roles": ["Developer"]})
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(Path(self.base, "roles.json").read_bytes(), self.roles_before)

    def test_missing_skill_with_null_tokens_has_nothing_to_delete(self):
        before = self.snapshot()
        rc, response, _ = self.delete("legacy-notes")
        self.assertFalse(response["ok"], response)
        self.assertEqual(response["error"]["code"], "SKILL_NOT_FOUND")
        self.assertIn("nothing to delete", response["error"]["message"])
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(Path(self.base, "roles.json").read_bytes(), self.roles_before)

    def test_stale_tokens_never_delete_anything(self):
        before = self.snapshot()
        rc, response, _ = self.delete("spare", roles_sha="1" * 64)
        self.assertFalse(response["ok"], response)
        self.assertEqual(response["error"]["code"], "CONFIG_CHANGED")
        current = self.listed()
        spare = next(item for item in current["skills"] if item["id"] == "spare")
        self.assertEqual(response["data"], {"rolesSha256": current["rolesSha256"],
                                            "skillSha256": spare["sha256"]})
        self.assertEqual(self.snapshot(), before)

        rc, response, _ = self.delete("spare", file_sha="2" * 64)
        self.assertEqual(response["error"]["code"], "CONFIG_CHANGED")
        self.assertEqual(response["data"], {"rolesSha256": current["rolesSha256"],
                                            "skillSha256": spare["sha256"]})
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(Path(self.base, "roles.json").read_bytes(), self.roles_before)

    def test_unreadable_and_truncated_files_delete_with_a_null_file_token(self):
        self.put("skills/broken/SKILL.md", b"\xff\xfe not utf-8")
        self.put("skills/huge/SKILL.md", b"x" * 32769)
        for skill in ("broken", "huge"):
            with self.subTest(skill=skill):
                rc, response, proc = self.delete(skill, file_sha=None)
                self.assertEqual(rc, 0, proc.stderr)
                self.assertTrue(response["ok"], response)
                self.assertEqual(response["data"]["deleted"], {"id": skill, "folder": "removed"})
                self.assertFalse(Path(self.base, "skills", skill).exists())
        after = self.listed()
        self.assertEqual([item["id"] for item in after["skills"]], ["house-style", "legacy-notes", "spare"])

    def test_delete_writes_are_serialized_by_the_tokens(self):
        data = self.listed()
        spare = next(item for item in data["skills"] if item["id"] == "spare")
        args = {"workspace": self.ws, "skill": "spare",
                "expectedRolesSha256": data["rolesSha256"], "expectedSha256": spare["sha256"]}
        first = self.request("skill.delete", args)[1]
        self.assertTrue(first["ok"], first)
        before = self.snapshot()
        second = self.request("skill.delete", args)[1]
        self.assertFalse(second["ok"], second)
        self.assertEqual(second["error"]["code"], "SKILL_NOT_FOUND")
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(Path(self.base, "roles.json").read_bytes(), self.roles_before)

    def test_unknown_arguments_and_bad_tokens_are_rejected_without_writes(self):
        before = self.snapshot()
        token = hashlib.sha256(b"# Spare\nUnused.\n").hexdigest()
        roles_token = hashlib.sha256(self.roles_before).hexdigest()
        cases = [
            {"skill": "spare", "expectedRolesSha256": roles_token},
            {"skill": "spare", "expectedSha256": token},
            {"skill": "spare", "expectedRolesSha256": "short", "expectedSha256": token},
            {"skill": "spare", "expectedRolesSha256": roles_token, "expectedSha256": "A" * 64},
            {"skill": "spare", "expectedRolesSha256": roles_token, "expectedSha256": token, "extra": 1},
            {"skill": "Bad", "expectedRolesSha256": roles_token, "expectedSha256": token},
        ]
        for args in cases:
            with self.subTest(args=args):
                rc, response, _ = self.request("skill.delete", {"workspace": self.ws, **args})
                self.assertFalse(response["ok"], response)
                self.assertEqual(response["error"]["code"], "BAD_REQUEST")
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(Path(self.base, "roles.json").read_bytes(), self.roles_before)


if __name__ == "__main__":
    unittest.main()
