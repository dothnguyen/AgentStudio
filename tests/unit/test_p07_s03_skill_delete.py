"""P07-S03: delete a skill that no role uses (skill.delete)."""
import hashlib
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from backend.agent_studio import PROTOCOL, dispatch, roles, skills


def sha(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


class SkillDeleteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = self.tmp.name
        self.base = Path(self.ws, ".agent-studio")
        self.base.mkdir()
        self.roles_path = self.base / "roles.json"
        self.write_roles({"version": 1, "roles": {}})
        self.put("skills/unused/SKILL.md", b"# Unused\n")

    # ---- helpers ---------------------------------------------------------------------------
    def write_roles(self, doc):
        self.roles_path.write_text(json.dumps(doc), encoding="utf-8")

    def put(self, rel, data):
        path = self.base / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def target(self, skill):
        return self.base / "skills" / skill / "SKILL.md"

    def files(self):
        found = {}
        for root, dirs, names in os.walk(self.ws):
            for name in dirs:
                found[str(Path(root, name).relative_to(self.ws)) + "/"] = b""
            for name in names:
                path = Path(root, name)
                found[str(path.relative_to(self.ws))] = path.read_bytes()
        return found

    def tokens(self, skill="unused"):
        roles_data = self.roles_path.read_bytes() if self.roles_path.exists() else None
        target = self.target(skill)
        skill_data = target.read_bytes() if target.is_file() and not target.is_symlink() else None
        return sha(roles_data), sha(skill_data)

    def call(self, command, **args):
        return dispatch.handle_request({"protocol": PROTOCOL, "id": "r", "command": command,
                                        "args": args}, False)

    def delete(self, skill="unused", roles_sha="current", file_sha="current", **over):
        expected_roles, expected_file = self.tokens(skill)
        args = {"workspace": self.ws, "skill": skill,
                "expectedRolesSha256": expected_roles if roles_sha == "current" else roles_sha,
                "expectedSha256": expected_file if file_sha == "current" else file_sha}
        args.update(over)
        args = {key: value for key, value in args.items() if value is not ...}
        return self.call("skill.delete", **args)

    def rejected(self, code, response=None, **over):
        before = self.files()
        roles_before = self.roles_path.read_bytes() if self.roles_path.exists() else None
        response = response or self.delete(**over)
        self.assertFalse(response["ok"], response)
        self.assertEqual(response["error"]["code"], code, response)
        self.assertEqual(self.files(), before)
        self.assertEqual(self.roles_path.read_bytes() if self.roles_path.exists() else None, roles_before)
        return response

    def ok(self, **over):
        response = self.delete(**over)
        self.assertTrue(response["ok"], response)
        return response["data"]

    # ---- success ---------------------------------------------------------------------------
    def test_unused_skill_deletes_the_file_and_the_empty_folder(self):
        roles_before = self.roles_path.read_bytes()
        data = self.ok()
        self.assertEqual(data["workspace"], self.ws)
        self.assertEqual(data["deleted"], {"id": "unused", "folder": "removed"})
        self.assertEqual(data["rolesSha256"], sha(roles_before))
        self.assertFalse(self.target("unused").exists())
        self.assertFalse((self.base / "skills" / "unused").exists())
        self.assertTrue((self.base / "skills").is_dir())
        self.assertEqual(self.roles_path.read_bytes(), roles_before)

    def test_other_files_in_the_folder_are_kept_and_never_touched(self):
        self.put("skills/unused/notes.txt", b"keep me")
        data = self.ok()
        self.assertEqual(data["deleted"], {"id": "unused", "folder": "kept"})
        self.assertFalse(self.target("unused").exists())
        self.assertEqual((self.base / "skills" / "unused" / "notes.txt").read_bytes(), b"keep me")
        self.assertEqual(sorted(p.name for p in (self.base / "skills" / "unused").iterdir()), ["notes.txt"])

    def test_missing_roles_json_accepts_a_null_roles_token(self):
        self.roles_path.unlink()
        data = self.ok()
        self.assertIsNone(data["rolesSha256"])
        self.assertEqual(data["deleted"]["folder"], "removed")
        self.assertFalse(self.roles_path.exists())
        self.assertFalse(self.target("unused").exists())

    def test_maximum_length_skill_id_can_be_deleted(self):
        skill = "a" * 64
        self.put(f"skills/{skill}/SKILL.md", b"# Long id\n")
        data = self.ok(skill=skill)
        self.assertEqual(data["deleted"], {"id": skill, "folder": "removed"})
        self.assertFalse((self.base / "skills" / skill).exists())

    def test_folder_removal_failure_keeps_the_file_removed_and_reports_kept(self):
        with mock.patch.object(skills.os, "rmdir", side_effect=OSError("busy")):
            data = self.ok()
        self.assertEqual(data["deleted"]["folder"], "kept")
        self.assertFalse(self.target("unused").exists())
        self.assertTrue((self.base / "skills" / "unused").is_dir())

    # ---- in use ----------------------------------------------------------------------------
    def test_in_use_skill_is_refused_with_the_role_ids_and_nothing_removed(self):
        self.write_roles({"version": 1, "roles": {
            "developer": {"skills": ["unused"]},
            "reviewer": {"skills": ["unused", "another"]},
            "unrelated": {"skills": ["third"]}}})
        before = self.files()
        response = self.rejected("SKILL_IN_USE")
        self.assertEqual(response["data"], {"roles": ["developer", "reviewer"]})
        self.assertIn("developer", response["error"]["message"])
        self.assertIn("reviewer", response["error"]["message"])
        self.assertEqual(self.files(), before)
        self.assertEqual(self.target("unused").read_bytes(), b"# Unused\n")

    def test_role_listing_the_skill_among_several_blocks_delete(self):
        self.write_roles({"version": 1, "roles": {
            "developer": {"skills": ["alpha", "unused", "beta"]}}})
        response = self.rejected("SKILL_IN_USE")
        self.assertEqual(response["data"], {"roles": ["developer"]})
        self.assertTrue(self.target("unused").exists())

    # ---- tokens ----------------------------------------------------------------------------
    def test_stale_roles_token_reports_both_current_shas_and_deletes_nothing(self):
        response = self.rejected("CONFIG_CHANGED", roles_sha="1" * 64)
        self.assertEqual(response["data"], {"rolesSha256": sha(self.roles_path.read_bytes()),
                                            "skillSha256": sha(b"# Unused\n")})
        self.assertTrue(self.target("unused").exists())

    def test_stale_file_token_reports_both_current_shas_and_deletes_nothing(self):
        response = self.rejected("CONFIG_CHANGED", file_sha="2" * 64)
        self.assertEqual(response["data"], {"rolesSha256": sha(self.roles_path.read_bytes()),
                                            "skillSha256": sha(b"# Unused\n")})
        self.assertTrue(self.target("unused").exists())

    def test_null_roles_token_is_rejected_when_roles_json_exists(self):
        response = self.rejected("CONFIG_CHANGED", roles_sha=None)
        self.assertEqual(response["data"]["rolesSha256"], sha(self.roles_path.read_bytes()))
        self.assertTrue(self.target("unused").exists())

    def test_null_file_token_is_rejected_when_the_file_exists(self):
        response = self.rejected("CONFIG_CHANGED", file_sha=None)
        self.assertEqual(response["data"]["skillSha256"], sha(b"# Unused\n"))
        self.assertTrue(self.target("unused").exists())

    def test_non_null_roles_token_is_rejected_when_roles_json_is_missing(self):
        self.roles_path.unlink()
        response = self.rejected("CONFIG_CHANGED", roles_sha="1" * 64)
        self.assertEqual(response["data"], {"rolesSha256": None, "skillSha256": sha(b"# Unused\n")})
        self.assertFalse(self.roles_path.exists())
        self.assertTrue(self.target("unused").exists())

    def test_stale_token_is_reported_before_the_in_use_check(self):
        self.write_roles({"version": 1, "roles": {"developer": {"skills": ["unused"]}}})
        response = self.rejected("CONFIG_CHANGED", roles_sha="1" * 64)
        self.assertEqual(response["data"], {"rolesSha256": sha(self.roles_path.read_bytes()),
                                            "skillSha256": sha(b"# Unused\n")})
        self.assertTrue(self.target("unused").exists())

    def test_roles_change_between_the_check_and_the_removal_is_a_conflict(self):
        real_read = roles._read_raw
        reads = {"count": 0}

        def read_then_change(path):
            if os.path.basename(path) == "roles.json":
                reads["count"] += 1
                if reads["count"] == 2:  # the recheck immediately before removal
                    self.write_roles({"version": 1, "roles": {"developer": {"skills": ["unused"]}}})
            return real_read(path)

        before = self.files()
        with mock.patch.object(roles, "_read_raw", side_effect=read_then_change):
            response = self.delete()
        self.assertFalse(response["ok"], response)
        self.assertEqual(response["error"]["code"], "CONFIG_CHANGED", response)
        self.assertEqual(response["data"], {"rolesSha256": sha(self.roles_path.read_bytes()),
                                            "skillSha256": sha(b"# Unused\n")})
        after = self.files()
        self.assertEqual({k: v for k, v in after.items() if k != ".agent-studio/roles.json"},
                         {k: v for k, v in before.items() if k != ".agent-studio/roles.json"})

    def test_file_change_between_the_check_and_the_removal_is_a_conflict(self):
        real_read = skills._read_skill_bytes
        calls = {"count": 0}

        def read_then_change(real_base, skill, target):
            calls["count"] += 1
            if calls["count"] == 2:  # the recheck immediately before removal
                Path(target).write_bytes(b"# Changed\n")
            return real_read(real_base, skill, target)

        with mock.patch.object(skills, "_read_skill_bytes", side_effect=read_then_change):
            response = self.delete()
        self.assertFalse(response["ok"], response)
        self.assertEqual(response["error"]["code"], "CONFIG_CHANGED", response)
        self.assertEqual(response["data"], {"rolesSha256": sha(self.roles_path.read_bytes()),
                                            "skillSha256": sha(b"# Changed\n")})
        self.assertEqual(self.target("unused").read_bytes(), b"# Changed\n")

    def test_roles_json_removed_between_the_check_and_the_removal_is_a_conflict(self):
        real_read = roles._read_raw
        reads = {"count": 0}

        def read_then_remove(path):
            if os.path.basename(path) == "roles.json":
                reads["count"] += 1
                if reads["count"] == 2:  # the recheck immediately before removal
                    os.unlink(path)
            return real_read(path)

        with mock.patch.object(roles, "_read_raw", side_effect=read_then_remove):
            response = self.delete()
        self.assertFalse(response["ok"], response)
        self.assertEqual(response["error"]["code"], "CONFIG_CHANGED", response)
        self.assertEqual(response["data"], {"rolesSha256": None, "skillSha256": sha(b"# Unused\n")})
        self.assertFalse(self.roles_path.exists())
        self.assertTrue(self.target("unused").exists())
        self.assertTrue((self.base / "skills" / "unused").is_dir())

    def test_file_removed_between_the_check_and_the_removal_is_a_conflict(self):
        real_read = skills._read_skill_bytes
        calls = {"count": 0}

        def read_then_remove(real_base, skill, target):
            calls["count"] += 1
            if calls["count"] == 2:  # the recheck immediately before removal
                os.unlink(target)
            return real_read(real_base, skill, target)

        with mock.patch.object(skills, "_read_skill_bytes", side_effect=read_then_remove):
            response = self.delete()
        self.assertFalse(response["ok"], response)
        self.assertEqual(response["error"]["code"], "CONFIG_CHANGED", response)
        self.assertEqual(response["data"], {"rolesSha256": sha(self.roles_path.read_bytes()),
                                            "skillSha256": None})
        self.assertFalse(self.target("unused").exists())
        # The conflict must stop the delete before it tries to remove the folder.
        self.assertTrue((self.base / "skills" / "unused").is_dir())

    # ---- missing, unsafe and invalid -------------------------------------------------------
    def test_missing_skill_is_not_found_and_says_there_is_nothing_to_delete(self):
        response = self.rejected("SKILL_NOT_FOUND", skill="ghost")
        self.assertIn("nothing to delete", response["error"]["message"])
        self.assertIn("ghost", response["error"]["message"])
        (self.base / "skills" / "empty").mkdir()
        response = self.rejected("SKILL_NOT_FOUND", skill="empty")
        self.assertIn("nothing to delete", response["error"]["message"])

    def test_symlinked_skill_folder_is_refused_without_following_it(self):
        outside = Path(self.ws, "outside")
        outside.mkdir()
        (outside / "SKILL.md").write_bytes(b"outside")
        (self.base / "skills").mkdir(exist_ok=True)
        os.symlink(outside, self.base / "skills" / "linked")
        response = self.rejected("BAD_REQUEST", skill="linked")
        self.assertIn("symbolic link", response["error"]["message"])
        self.assertEqual((outside / "SKILL.md").read_bytes(), b"outside")
        self.assertTrue(os.path.islink(self.base / "skills" / "linked"))

    def test_symlinked_skill_file_is_refused_without_following_it(self):
        outside = Path(self.ws, "outside.md")
        outside.write_bytes(b"outside")
        (self.base / "skills" / "linked").mkdir(parents=True)
        os.symlink(outside, self.target("linked"))
        response = self.rejected("BAD_REQUEST", skill="linked")
        self.assertIn("symbolic link", response["error"]["message"])
        self.assertEqual(outside.read_bytes(), b"outside")
        self.assertTrue(os.path.islink(self.target("linked")))

    def test_symlinked_skills_directory_is_refused(self):
        outside = Path(self.ws, "outside-skills")
        outside.mkdir()
        (outside / "unused").mkdir()
        (outside / "unused" / "SKILL.md").write_bytes(b"outside")
        os.unlink(self.base / "skills" / "unused" / "SKILL.md")
        os.rmdir(self.base / "skills" / "unused")
        os.rmdir(self.base / "skills")
        os.symlink(outside, self.base / "skills")
        response = self.rejected("BAD_REQUEST", skill="unused")
        self.assertIn("symbolic link", response["error"]["message"])
        self.assertEqual((outside / "unused" / "SKILL.md").read_bytes(), b"outside")

    def test_invalid_ids_are_bad_requests_and_remove_nothing(self):
        before = self.files()
        for skill in ("", "Upper", ".dot", "-dash", "a" * 65, "../unused", "a/b", "a b", "é"):
            with self.subTest(skill=skill):
                response = self.call("skill.delete", workspace=self.ws, skill=skill,
                                     expectedRolesSha256=sha(self.roles_path.read_bytes()),
                                     expectedSha256=sha(b"# Unused\n"))
                self.assertFalse(response["ok"], response)
                self.assertEqual(response["error"]["code"], "BAD_REQUEST", response)
                self.assertEqual(self.files(), before)

    def test_invalid_catalog_is_refused_without_deleting(self):
        self.roles_path.write_bytes(b"{not json")
        response = self.rejected("ROLES_CONFIG_INVALID", roles_sha=sha(b"{not json"))
        self.assertTrue(self.target("unused").exists())

    def test_invalid_roles_skills_entry_is_refused_without_deleting(self):
        self.write_roles({"version": 1, "roles": {"developer": {"skills": "unused"}}})
        response = self.rejected("ROLES_CONFIG_INVALID", roles_sha=sha(self.roles_path.read_bytes()))
        self.assertIn("skills must be a list", response["error"]["message"])
        self.assertTrue(self.target("unused").exists())

    def test_missing_skills_folder_has_nothing_to_delete(self):
        shutil.rmtree(self.base / "skills")
        response = self.rejected("SKILL_NOT_FOUND", skill="unused")
        self.assertIn("nothing to delete", response["error"]["message"])
        self.assertFalse((self.base / "skills").exists())

    def test_skill_file_that_is_a_directory_is_refused(self):
        target = self.target("unused")
        target.unlink()
        target.mkdir()
        response = self.rejected("BAD_REQUEST")
        self.assertIn("regular file", response["error"]["message"])
        self.assertTrue(target.is_dir())

    def test_skill_folder_that_is_a_regular_file_is_refused(self):
        folder = self.base / "skills" / "unused"
        (folder / "SKILL.md").unlink()
        folder.rmdir()
        folder.write_bytes(b"not a folder")
        response = self.rejected("BAD_REQUEST")
        self.assertIn("must be a folder", response["error"]["message"])
        self.assertEqual(folder.read_bytes(), b"not a folder")

    # ---- dispatch validation ---------------------------------------------------------------
    def test_dispatch_validates_tokens_and_arguments_without_deleting(self):
        token = sha(b"# Unused\n")
        roles_token = sha(self.roles_path.read_bytes())
        roles_before = self.roles_path.read_bytes()
        before = self.files()
        cases = [
            {"skill": "unused", "expectedRolesSha256": roles_token},
            {"skill": "unused", "expectedSha256": token},
            {"skill": "unused", "expectedRolesSha256": "A" * 64, "expectedSha256": token},
            {"skill": "unused", "expectedRolesSha256": "short", "expectedSha256": token},
            {"skill": "unused", "expectedRolesSha256": roles_token, "expectedSha256": "A" * 64},
            {"skill": "unused", "expectedRolesSha256": roles_token, "expectedSha256": token[:-1]},
            {"skill": "unused", "expectedRolesSha256": roles_token, "expectedSha256": token, "extra": 1},
        ]
        for args in cases:
            with self.subTest(args=args):
                response = self.call("skill.delete", workspace=self.ws, **args)
                self.assertFalse(response["ok"], response)
                self.assertEqual(response["error"]["code"], "BAD_REQUEST", response)
        self.assertEqual(self.files(), before)
        self.assertEqual(self.roles_path.read_bytes(), roles_before)


if __name__ == "__main__":
    unittest.main()
