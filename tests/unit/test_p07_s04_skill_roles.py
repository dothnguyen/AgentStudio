"""P07-S04: choose which roles use a skill in one write (skill.roles.update)."""
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from backend.agent_studio import PROTOCOL, dispatch, roles, skills


def sha(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


class SkillRolesUpdateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = self.tmp.name
        self.base = Path(self.ws, ".agent-studio")
        self.base.mkdir()
        self.roles_path = self.base / "roles.json"
        for skill in ("house-style", "alpha", "beta", "gamma"):
            self.put(f"skills/{skill}/SKILL.md", f"# {skill}\n".encode())
        self.put("roles/developer.md", b"Implement.\n")
        self.put("roles/reviewer.md", b"Review.\n")
        self.write_roles({"version": 1, "roles": {}})

    # ---- helpers ---------------------------------------------------------------------------
    def put(self, rel, data):
        path = self.base / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def write_roles(self, doc):
        self.roles_path.write_text(json.dumps(doc), encoding="utf-8")

    def roles_doc(self):
        return json.loads(self.roles_path.read_text(encoding="utf-8"))

    def token(self):
        return sha(self.roles_path.read_bytes() if self.roles_path.exists() else None)

    def files(self):
        found = {}
        for root, dirs, names in os.walk(self.ws):
            for name in dirs:
                found[str(Path(root, name).relative_to(self.ws)) + "/"] = b""
            for name in names:
                path = Path(root, name)
                found[str(path.relative_to(self.ws))] = path.read_bytes()
        return found

    def call(self, command, **args):
        return dispatch.handle_request({"protocol": PROTOCOL, "id": "r", "command": command,
                                        "args": args}, False)

    def update(self, role_ids, skill="house-style", expected="current", **over):
        args = {"workspace": self.ws, "skill": skill, "roles": role_ids,
                "expectedRolesSha256": self.token() if expected == "current" else expected}
        args.update(over)
        args = {key: value for key, value in args.items() if value is not ...}
        return self.call("skill.roles.update", **args)

    def ok(self, role_ids, **over):
        response = self.update(role_ids, **over)
        self.assertTrue(response["ok"], response)
        return response["data"]

    def rejected(self, code, role_ids, **over):
        before = self.files()
        response = self.update(role_ids, **over)
        self.assertFalse(response["ok"], response)
        self.assertEqual(response["error"]["code"], code, response)
        self.assertEqual(self.files(), before)
        return response

    # ---- success ---------------------------------------------------------------------------
    def test_adds_the_skill_to_one_role_and_leaves_peers_unchanged(self):
        self.write_roles({"version": 1, "roles": {
            "developer": {"name": "Developer", "skills": ["alpha", "house-style"]},
            "reviewer": {"name": "Reviewer", "skills": ["alpha"]}}})
        before = self.roles_doc()["roles"]
        data = self.ok(["developer", "reviewer"])
        doc = self.roles_doc()
        self.assertEqual(data["workspace"], self.ws)
        self.assertEqual(data["skill"], "house-style")
        self.assertEqual(data["roles"], ["developer", "reviewer"])
        self.assertEqual(data["added"], ["reviewer"])
        self.assertEqual(data["removed"], [])
        self.assertEqual(data["rolesSha256"], sha(self.roles_path.read_bytes()))
        self.assertEqual(doc["roles"]["developer"], before["developer"])
        self.assertEqual(doc["roles"]["reviewer"], {"name": "Reviewer", "skills": ["alpha", "house-style"]})

    def test_adds_to_several_roles_creating_missing_skills_lists(self):
        self.write_roles({"version": 1, "roles": {
            "developer": {"name": "Developer", "skills": ["house-style"]},
            "reviewer": {"name": "Reviewer", "skills": ["alpha"]},
            "planner": {"name": "Planner"},
            "ops": {"name": "Ops", "skills": []}}})
        data = self.ok(["developer", "reviewer", "planner", "ops"])
        doc = self.roles_doc()
        self.assertEqual(data["added"], ["reviewer", "planner", "ops"])
        self.assertEqual(data["removed"], [])
        self.assertEqual(data["roles"], ["developer", "reviewer", "planner", "ops"])
        self.assertEqual(doc["roles"]["reviewer"]["skills"], ["alpha", "house-style"])
        self.assertEqual(doc["roles"]["planner"], {"name": "Planner", "skills": ["house-style"]})
        self.assertEqual(doc["roles"]["ops"], {"name": "Ops", "skills": ["house-style"]})

    def test_removes_from_several_roles_and_keeps_empty_arrays(self):
        self.write_roles({"version": 1, "roles": {
            "developer": {"skills": ["house-style", "alpha"]},
            "reviewer": {"skills": ["house-style"]},
            "planner": {"skills": ["house-style", "gamma"]}}})
        data = self.ok([])
        doc = self.roles_doc()
        self.assertEqual(data["roles"], [])
        self.assertEqual(data["added"], [])
        self.assertEqual(data["removed"], ["developer", "reviewer", "planner"])
        self.assertEqual(doc["roles"]["developer"]["skills"], ["alpha"])
        self.assertEqual(doc["roles"]["reviewer"]["skills"], [])
        self.assertEqual(doc["roles"]["planner"]["skills"], ["gamma"])

    def test_adds_and_removes_in_one_call(self):
        self.write_roles({"version": 1, "roles": {
            "developer": {"skills": ["house-style"]},
            "reviewer": {"skills": ["house-style"]},
            "planner": {"skills": []}}})
        data = self.ok(["planner"])
        self.assertEqual(data["added"], ["planner"])
        self.assertEqual(data["removed"], ["developer", "reviewer"])
        self.assertEqual(data["roles"], ["planner"])
        doc = self.roles_doc()
        self.assertEqual(doc["roles"]["developer"]["skills"], [])
        self.assertEqual(doc["roles"]["reviewer"]["skills"], [])
        self.assertEqual(doc["roles"]["planner"]["skills"], ["house-style"])

    def test_keeps_the_order_of_existing_entries_and_appends_last(self):
        self.write_roles({"version": 1, "roles": {
            "developer": {"skills": ["beta", "alpha"]},
            "reviewer": {"skills": ["gamma", "house-style", "alpha"]}}})
        data = self.ok(["developer"])
        doc = self.roles_doc()
        self.assertEqual(data["added"], ["developer"])
        self.assertEqual(data["removed"], ["reviewer"])
        self.assertEqual(doc["roles"]["developer"]["skills"], ["beta", "alpha", "house-style"])
        self.assertEqual(doc["roles"]["reviewer"]["skills"], ["gamma", "alpha"])

    def test_empty_result_keeps_an_empty_skills_array(self):
        self.write_roles({"version": 1, "roles": {"developer": {"skills": ["house-style"]}}})
        data = self.ok([])
        self.assertEqual(data["removed"], ["developer"])
        self.assertEqual(self.roles_doc()["roles"]["developer"], {"skills": []})

    def test_noop_keeps_bytes_inode_and_mtime_and_never_replaces(self):
        self.write_roles({"version": 1, "roles": {
            "developer": {"skills": ["house-style"]},
            "reviewer": {"skills": ["alpha"]}}})
        before, stat = self.roles_path.read_bytes(), self.roles_path.stat()
        with mock.patch.object(roles.os, "replace") as replace:
            data = self.ok(["developer"])
        replace.assert_not_called()
        self.assertEqual(data["roles"], ["developer"])
        self.assertEqual((data["added"], data["removed"]), ([], []))
        self.assertEqual(data["rolesSha256"], sha(before))
        after = self.roles_path.stat()
        self.assertEqual((self.roles_path.read_bytes(), after.st_ino, after.st_mtime_ns),
                         (before, stat.st_ino, stat.st_mtime_ns))

    def test_skill_and_instruction_files_are_untouched(self):
        self.write_roles({"version": 1, "roles": {
            "developer": {"instructions": "roles/developer.md", "skills": ["alpha"]},
            "reviewer": {"skills": []}}})
        before = self.files()
        self.ok(["developer", "reviewer"])
        after = self.files()
        self.assertEqual(set(after), set(before))
        for path in before:
            if path != ".agent-studio/roles.json":
                self.assertEqual(after[path], before[path], path)

    def test_roles_json_mode_is_kept(self):
        self.write_roles({"version": 1, "roles": {
            "developer": {"skills": ["alpha"]},
            "reviewer": {"skills": []}}})
        os.chmod(self.roles_path, 0o640)
        self.ok(["reviewer"])
        self.assertEqual(self.roles_path.stat().st_mode & 0o777, 0o640)

    def test_formatting_is_identical_to_role_update_for_the_same_change(self):
        self.write_roles({"version": 1, "roles": {
            "developer": {"skills": ["house-style"]},
            "reviewer": {"skills": ["alpha"]}}})
        original = self.roles_path.read_bytes()
        self.ok(["developer", "reviewer"])
        written = self.roles_path.read_bytes()
        self.roles_path.write_bytes(original)
        roles.update_role(self.ws, "reviewer", {"skills": ["alpha", "house-style"]})
        self.assertEqual(self.roles_path.read_bytes(), written)

    def test_top_level_and_unknown_role_fields_are_preserved(self):
        self.write_roles({"version": 1, "extra": {"keep": 1}, "roles": {
            "developer": {"name": "Developer", "custom": 5, "skills": []},
            "reviewer": {"name": "Reviewer", "skills": ["alpha"]}}})
        self.ok(["developer"])
        doc = self.roles_doc()
        self.assertEqual(doc["extra"], {"keep": 1})
        self.assertEqual(doc["roles"]["developer"],
                         {"name": "Developer", "custom": 5, "skills": ["house-style"]})
        self.assertEqual(doc["roles"]["reviewer"], {"name": "Reviewer", "skills": ["alpha"]})

    def test_the_request_order_does_not_matter_for_a_noop(self):
        self.write_roles({"version": 1, "roles": {
            "developer": {"skills": ["house-style"]},
            "reviewer": {"skills": ["house-style"]}}})
        before = self.roles_path.read_bytes()
        data = self.ok(["reviewer", "developer"])
        self.assertEqual((data["added"], data["removed"]), ([], []))
        self.assertEqual(set(data["roles"]), {"developer", "reviewer"})
        self.assertEqual(self.roles_path.read_bytes(), before)

    # ---- failures --------------------------------------------------------------------------
    def test_unknown_role_names_the_first_unknown_and_writes_nothing(self):
        self.write_roles({"version": 1, "roles": {
            "developer": {"skills": []},
            "reviewer": {"skills": []}}})
        response = self.rejected("ROLE_NOT_FOUND", ["developer", "ghost", "also-ghost"])
        self.assertIn("ghost", response["error"]["message"])
        self.assertNotIn("also-ghost", response["error"]["message"])

    def test_duplicate_role_ids_are_bad_requests_without_writing(self):
        self.write_roles({"version": 1, "roles": {"developer": {"skills": []}}})
        response = self.rejected("BAD_REQUEST", ["developer", "developer"])
        self.assertIn("more than once", response["error"]["message"])

    def test_adding_a_missing_skill_is_refused_but_removing_one_succeeds(self):
        self.write_roles({"version": 1, "roles": {
            "developer": {"skills": ["ghost-skill", "alpha"]},
            "reviewer": {"skills": []}}})
        response = self.rejected("SKILL_NOT_FOUND", ["developer", "reviewer"], skill="ghost-skill")
        self.assertIn("ghost-skill", response["error"]["message"])

        data = self.ok([], skill="ghost-skill")
        self.assertEqual(data["added"], [])
        self.assertEqual(data["removed"], ["developer"])
        self.assertEqual(self.roles_doc()["roles"]["developer"]["skills"], ["alpha"])

    def test_missing_skill_blocks_removals_in_the_same_call(self):
        self.write_roles({"version": 1, "roles": {
            "developer": {"skills": ["ghost-skill"]},
            "reviewer": {"skills": []}}})
        response = self.rejected("SKILL_NOT_FOUND", ["reviewer"], skill="ghost-skill")
        self.assertIn("ghost-skill", response["error"]["message"])
        doc = self.roles_doc()
        self.assertEqual(doc["roles"]["developer"]["skills"], ["ghost-skill"])
        self.assertEqual(doc["roles"]["reviewer"]["skills"], [])

    def test_unknown_role_rejects_the_whole_change_including_other_edits(self):
        self.write_roles({"version": 1, "roles": {
            "developer": {"skills": ["house-style"]},
            "reviewer": {"skills": []}}})
        response = self.rejected("ROLE_NOT_FOUND", ["reviewer", "ghost"])
        self.assertIn("ghost", response["error"]["message"])
        doc = self.roles_doc()
        self.assertEqual(doc["roles"]["developer"]["skills"], ["house-style"])
        self.assertEqual(doc["roles"]["reviewer"]["skills"], [])

    def test_an_existing_dangling_reference_is_left_alone_when_the_set_matches(self):
        self.write_roles({"version": 1, "roles": {
            "developer": {"skills": ["ghost-skill", "alpha"]},
            "reviewer": {"skills": []}}})
        before, stat = self.roles_path.read_bytes(), self.roles_path.stat()
        data = self.ok(["developer"], skill="ghost-skill")
        self.assertEqual((data["added"], data["removed"]), ([], []))
        self.assertEqual(data["roles"], ["developer"])
        after = self.roles_path.stat()
        self.assertEqual((self.roles_path.read_bytes(), after.st_ino, after.st_mtime_ns),
                         (before, stat.st_ino, stat.st_mtime_ns))

    def test_removing_a_dangling_skill_from_several_roles_keeps_the_rest(self):
        self.write_roles({"version": 1, "roles": {
            "developer": {"skills": ["ghost-skill", "alpha"]},
            "reviewer": {"skills": ["beta", "ghost-skill"]}}})
        data = self.ok([], skill="ghost-skill")
        self.assertEqual(data["removed"], ["developer", "reviewer"])
        doc = self.roles_doc()
        self.assertEqual(doc["roles"]["developer"]["skills"], ["alpha"])
        self.assertEqual(doc["roles"]["reviewer"]["skills"], ["beta"])

    def test_stale_token_reports_the_current_sha_and_writes_nothing(self):
        self.write_roles({"version": 1, "roles": {
            "developer": {"skills": []},
            "reviewer": {"skills": []}}})
        response = self.rejected("CONFIG_CHANGED", ["developer"], expected="0" * 64)
        self.assertEqual(response["data"], {"rolesSha256": sha(self.roles_path.read_bytes())})
        self.assertEqual(response["error"]["message"],
                         ".agent-studio/roles.json changed since it was read; reload and retry.")

    def test_stale_token_is_checked_before_role_and_skill_existence(self):
        self.write_roles({"version": 1, "roles": {"developer": {"skills": []}}})
        response = self.rejected("CONFIG_CHANGED", ["ghost"], skill="ghost-skill", expected="0" * 64)
        self.assertEqual(response["data"], {"rolesSha256": sha(self.roles_path.read_bytes())})

    def test_a_null_token_is_stale_while_roles_json_exists(self):
        self.write_roles({"version": 1, "roles": {"developer": {"skills": []}}})
        response = self.rejected("CONFIG_CHANGED", ["developer"], expected=None)
        self.assertEqual(response["data"], {"rolesSha256": sha(self.roles_path.read_bytes())})

    def test_roles_changed_between_the_check_and_the_replace_is_a_conflict(self):
        self.write_roles({"version": 1, "roles": {
            "developer": {"skills": []},
            "reviewer": {"skills": []}}})
        changed = {"version": 1, "roles": {"developer": {"skills": []}, "reviewer": {"skills": ["alpha"]}}}
        real_read = roles._read_raw
        reads = {"count": 0}

        def read_then_change(path):
            if os.path.basename(path) == "roles.json":
                reads["count"] += 1
                if reads["count"] == 2:  # the recheck immediately before the replace
                    self.write_roles(changed)
            return real_read(path)

        before = self.files()
        with mock.patch.object(roles, "_read_raw", side_effect=read_then_change):
            response = self.update(["developer"])
        self.assertFalse(response["ok"], response)
        self.assertEqual(response["error"]["code"], "CONFIG_CHANGED", response)
        self.assertEqual(response["data"], {"rolesSha256": sha(self.roles_path.read_bytes())})
        after = self.files()
        self.assertEqual(set(after), set(before))
        self.assertFalse(any(".roles.json." in name for name in after), after.keys())
        for path in before:
            if path != ".agent-studio/roles.json":
                self.assertEqual(after[path], before[path], path)

    def test_invalid_existing_roles_json_is_refused_without_writing(self):
        docs = [
            b"{not json",
            json.dumps({"version": 2, "roles": {}}).encode(),
            json.dumps({"version": 1, "roles": {"developer": {"skills": ["alpha", "alpha"]}}}).encode(),
        ]
        for raw in docs:
            with self.subTest(raw=raw):
                self.roles_path.write_bytes(raw)
                response = self.rejected("ROLES_CONFIG_INVALID", ["developer"], expected=sha(raw))
                if b"alpha" in raw:  # the catalog-level validation carries structured problems
                    self.assertTrue(response["data"]["problems"])

    def test_invalid_skills_entry_types_are_refused_without_writing(self):
        docs = [
            json.dumps({"version": 1, "roles": {"developer": {"skills": "alpha"}}}).encode(),
            json.dumps({"version": 1, "roles": {"developer": {"skills": [1]}}}).encode(),
            json.dumps({"version": 1, "roles": {"developer": {"skills": ["Bad Skill"]}}}).encode(),
        ]
        for raw in docs:
            with self.subTest(raw=raw):
                self.roles_path.write_bytes(raw)
                self.rejected("ROLES_CONFIG_INVALID", ["developer"], expected=sha(raw))

    def test_atomic_replace_failure_cleans_the_temp_file_and_keeps_the_original(self):
        self.write_roles({"version": 1, "roles": {
            "developer": {"skills": []},
            "reviewer": {"skills": []}}})
        before = self.files()
        with mock.patch.object(roles, "_replace", side_effect=OSError("failure")):
            with self.assertRaises(OSError):
                skills.update_skill_roles(self.ws, "house-style", ["developer"], self.token())
        self.assertEqual(self.files(), before)

    def test_missing_roles_json_allows_an_empty_noop_but_not_unknown_roles(self):
        self.roles_path.unlink()
        data = self.ok([], expected=None)
        self.assertEqual(data, {"workspace": self.ws, "skill": "house-style", "roles": [],
                                "added": [], "removed": [], "rolesSha256": None})
        self.assertFalse(self.roles_path.exists())
        response = self.rejected("ROLE_NOT_FOUND", ["developer"], expected=None)
        self.assertIn("developer", response["error"]["message"])

    def test_dispatch_rejects_bad_arguments_without_writing(self):
        self.write_roles({"version": 1, "roles": {
            "developer": {"skills": []},
            "reviewer": {"skills": []}}})
        token = self.token()
        before = self.files()
        cases = [
            {"workspace": self.ws, "skill": "house-style", "expectedRolesSha256": token},
            {"workspace": self.ws, "skill": "house-style", "roles": ["developer"]},
            {"workspace": self.ws, "skill": "Bad", "roles": ["developer"], "expectedRolesSha256": token},
            {"workspace": self.ws, "skill": "house-style", "roles": "developer", "expectedRolesSha256": token},
            {"workspace": self.ws, "skill": "house-style", "roles": [1], "expectedRolesSha256": token},
            {"workspace": self.ws, "skill": "house-style", "roles": ["developer"],
             "expectedRolesSha256": "short"},
            {"workspace": self.ws, "skill": "house-style", "roles": ["developer"],
             "expectedRolesSha256": "A" * 64},
            {"workspace": self.ws, "skill": "house-style", "roles": ["developer"],
             "expectedRolesSha256": token, "extra": 1},
        ]
        for args in cases:
            with self.subTest(args=args):
                response = self.call("skill.roles.update", **args)
                self.assertFalse(response["ok"], response)
                self.assertEqual(response["error"]["code"], "BAD_REQUEST", response)
        self.assertEqual(self.files(), before)


if __name__ == "__main__":
    unittest.main()
