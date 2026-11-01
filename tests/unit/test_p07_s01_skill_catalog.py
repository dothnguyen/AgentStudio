"""P07-S01: the read-only skill catalog and skill detail projection."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest

from backend.agent_studio import PROTOCOL, dispatch, roles, skills

LIMIT = 32 * 1024


class SkillCatalogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = self.tmp.name
        self.base = os.path.join(self.ws, ".agent-studio")
        os.mkdir(self.base)

    def write(self, path, data):
        path = os.path.join(self.base, path)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)

    def catalog(self, specs):
        data = json.dumps({"version": 1, "roles": specs}).encode()
        self.write("roles.json", data)
        return data

    def items(self):
        return {item["id"]: item for item in skills.list_skills(self.ws)["skills"]}

    def call(self, command, **args):
        return dispatch.handle_request({"protocol": PROTOCOL, "id": "r", "command": command, "args": args}, True)

    def test_empty_and_absent_skills_directory(self):
        data = self.catalog({})
        result = skills.list_skills(self.ws)
        self.assertEqual(result["skills"], [])
        self.assertEqual(result["problems"], [])
        self.assertEqual(result["rolesSha256"], hashlib.sha256(data).hexdigest())
        self.assertEqual(result["limits"], {"skillBytes": LIMIT, "roleContextBytes": roles.LIMITS["total"]})
        os.mkdir(os.path.join(self.base, "skills"))
        self.assertEqual(skills.list_skills(self.ws)["skills"], [])

    def test_ok_skill_has_title_bytes_and_hash(self):
        data = b"# Alpha skill\nbody\n"
        self.write("skills/alpha/SKILL.md", data)
        self.catalog({})
        result = skills.list_skills(self.ws)
        self.assertEqual(set(result), {"workspace", "rolesSha256", "limits", "skills", "problems"})
        self.assertEqual(set(result["skills"][0]),
                         {"id", "path", "state", "title", "bytes", "sha256", "roles"})
        self.assertEqual(result["skills"], [{
            "id": "alpha", "path": "skills/alpha/SKILL.md", "state": "ok", "title": "Alpha skill",
            "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "roles": []}])

    def test_title_comes_from_first_non_empty_line_and_empty_file_is_null(self):
        self.write("skills/plain/SKILL.md", b"\n   \nPlain title\n# later\n")
        self.write("skills/empty/SKILL.md", b"")
        self.write("skills/long/SKILL.md", b"#" + b"x" * 130)
        self.catalog({})
        items = self.items()
        self.assertEqual(items["plain"]["title"], "Plain title")
        self.assertIsNone(items["empty"]["title"])
        self.assertEqual((items["empty"]["bytes"], items["empty"]["sha256"]),
                         (0, hashlib.sha256(b"").hexdigest()))
        self.assertEqual(items["long"]["title"], "x" * 120)

    def test_exact_limit_is_ok_and_one_byte_more_is_truncated(self):
        exact = b"a" * LIMIT
        larger = b"a" * LIMIT + b"b"
        self.write("skills/exact/SKILL.md", exact)
        self.write("skills/larger/SKILL.md", larger)
        self.catalog({})
        items = self.items()
        self.assertEqual((items["exact"]["state"], items["exact"]["bytes"], items["exact"]["sha256"]),
                         ("ok", LIMIT, hashlib.sha256(exact).hexdigest()))
        self.assertEqual((items["larger"]["state"], items["larger"]["bytes"], items["larger"]["sha256"]),
                         ("truncated", LIMIT + 1, hashlib.sha256(larger[:LIMIT]).hexdigest()))

    def test_symlinked_folder_is_ignored_and_symlinked_file_is_unreadable(self):
        outside = os.path.join(self.ws, "outside")
        os.mkdir(outside)
        with open(os.path.join(outside, "SKILL.md"), "wb") as f:
            f.write(b"# Outside secret\n")
        os.makedirs(os.path.join(self.base, "skills"))
        os.symlink(outside, os.path.join(self.base, "skills", "linked"))
        os.mkdir(os.path.join(self.base, "skills", "escaped"))
        os.symlink(os.path.join(outside, "SKILL.md"), os.path.join(self.base, "skills", "escaped", "SKILL.md"))
        os.makedirs(os.path.join(self.base, "skills", "dirfile", "SKILL.md"))
        self.catalog({})
        result = skills.list_skills(self.ws)
        self.assertEqual([item["id"] for item in result["skills"]], ["dirfile", "escaped"])
        self.assertTrue(all(item["state"] == "unreadable" for item in result["skills"]))
        self.assertNotIn(outside, json.dumps(result))
        self.assertNotIn("Outside secret", json.dumps(result))
        self.assertEqual([problem["path"] for problem in result["problems"]],
                         ["skills/dirfile/SKILL.md", "skills/escaped/SKILL.md"])

    def test_symlinked_skills_directory_is_never_followed(self):
        outside = os.path.join(self.ws, "outside-skills")
        os.makedirs(os.path.join(outside, "leak"))
        with open(os.path.join(outside, "leak", "SKILL.md"), "wb") as f:
            f.write(b"# Leaked title\nsecret body")
        self.catalog({"worker": {"skills": ["leak"]}})
        os.symlink(outside, os.path.join(self.base, "skills"))
        result = skills.list_skills(self.ws)
        self.assertEqual([(item["id"], item["state"]) for item in result["skills"]],
                         [("leak", "missing")])
        self.assertNotIn("Leaked", json.dumps(result))
        self.assertNotIn("secret body", json.dumps(result))

    def test_invalid_utf8_is_unreadable(self):
        self.write("skills/bad/SKILL.md", b"# Bad\n\xff")
        self.catalog({})
        item = self.items()["bad"]
        self.assertEqual(item, {"id": "bad", "path": "skills/bad/SKILL.md", "state": "unreadable",
                                "title": None, "bytes": None, "sha256": None, "roles": []})
        self.assertIn({"path": "skills/bad/SKILL.md",
                       "message": "Skill 'bad' could not be read as regular UTF-8 text."},
                      skills.list_skills(self.ws)["problems"])

    def test_show_unreadable_skill_returns_null_text(self):
        self.write("skills/bad/SKILL.md", b"# Bad\n\xff")
        self.catalog({})
        result = self.call("skill.show", workspace=self.ws, skill="bad")["data"]
        self.assertEqual((result["skill"]["state"], result["text"]), ("unreadable", None))

    def test_context_bytes_ignore_unreadable_and_escaping_instruction_files(self):
        skill = b"# One\n"
        self.write("skills/one/SKILL.md", skill)
        os.makedirs(os.path.join(self.base, "roles", "notes"))
        outside = os.path.join(self.ws, "outside.md")
        with open(outside, "wb") as f:
            f.write(b"secret instructions")
        os.symlink(outside, os.path.join(self.base, "roles", "link.md"))
        self.catalog({
            "dir": {"skills": ["one"], "instructions": "roles/notes"},
            "escape": {"skills": ["one"], "instructions": "roles/link.md"}})
        self.assertEqual(self.items()["one"]["roles"], [
            {"id": "dir", "name": None, "contextBytes": len(skill)},
            {"id": "escape", "name": None, "contextBytes": len(skill)}])

    def test_role_listed_missing_skill_is_reported_and_unlisted_empty_folder_is_hidden(self):
        os.makedirs(os.path.join(self.base, "skills", "hidden"))
        self.catalog({"worker": {"skills": ["ghost"]}})
        result = skills.list_skills(self.ws)
        self.assertEqual(result["skills"], [{
            "id": "ghost", "path": "skills/ghost/SKILL.md", "state": "missing", "title": None,
            "bytes": None, "sha256": None,
            "roles": [{"id": "worker", "name": None, "contextBytes": 0}]}])
        self.assertIn({"path": "skills/ghost/SKILL.md",
                       "message": "Skill 'ghost' has no readable SKILL.md."}, result["problems"])

    def test_invalid_role_skill_id_is_a_problem_without_an_item(self):
        self.write("skills/good/SKILL.md", b"ok")
        self.catalog({"worker": {"skills": ["Bad Skill", "good"]}})
        result = skills.list_skills(self.ws)
        self.assertEqual([item["id"] for item in result["skills"]], ["good"])
        self.assertEqual(result["skills"][0]["roles"],
                         [{"id": "worker", "name": None, "contextBytes": 2}])
        self.assertIn({"path": "roles.worker.skills", "message": "Skill id is invalid."}, result["problems"])

    def test_several_roles_share_a_skill_with_and_without_instruction_bytes(self):
        common = b"# Common\n"
        other = b"other"
        self.write("skills/common/SKILL.md", common)
        self.write("skills/other/SKILL.md", other)
        self.write("roles/first.md", b"instr")
        self.catalog({
            "first": {"name": " First ", "skills": ["common"], "instructions": "roles/first.md"},
            "second": {"skills": ["common"], "instructions": "roles/missing.md"},
            "third": {"skills": ["other"]}})
        items = self.items()
        self.assertEqual(set(items["common"]["roles"][0]), {"id", "name", "contextBytes"})
        self.assertEqual(items["common"]["roles"], [
            {"id": "first", "name": "First", "contextBytes": 5 + len(common)},
            {"id": "second", "name": None, "contextBytes": len(common)}])
        self.assertEqual(items["other"]["roles"], [{"id": "third", "name": None, "contextBytes": len(other)}])

    def test_truncated_skill_does_not_count_towards_context_bytes(self):
        self.write("skills/big/SKILL.md", b"a" * (LIMIT + 1))
        self.write("roles/worker.md", b"12345")
        self.catalog({"worker": {"skills": ["big", "missing"], "instructions": "roles/worker.md"}})
        item = self.items()["big"]
        self.assertEqual(item["roles"], [{"id": "worker", "name": None, "contextBytes": 5}])

    def test_missing_and_invalid_roles_json_still_list_folders(self):
        self.write("skills/a/SKILL.md", b"skill")
        result = skills.list_skills(self.ws)
        self.assertIsNone(result["rolesSha256"])
        self.assertEqual([item["id"] for item in result["skills"]], ["a"])
        self.assertEqual(result["skills"][0]["roles"], [])
        self.assertEqual(result["problems"], [{"path": "roles.json", "message": "Role catalog is missing."}])

        self.write("roles.json", b"{not json")
        result = skills.list_skills(self.ws)
        self.assertIsNone(result["rolesSha256"])
        self.assertEqual([item["id"] for item in result["skills"]], ["a"])
        self.assertEqual(result["problems"],
                         [{"path": "roles.json", "message": "Role catalog has invalid content or root shape."}])

    def test_show_returns_text_for_ok_truncated_missing_and_errors(self):
        data = b"# Title\nbody"
        large = b"a" * (LIMIT + 1)
        self.write("skills/ok/SKILL.md", data)
        self.write("skills/large/SKILL.md", large)
        self.catalog({"worker": {"skills": ["ghost"]}})
        ok = self.call("skill.show", workspace=self.ws, skill="ok")["data"]
        self.assertEqual(set(ok), {"workspace", "skill", "text"})
        self.assertEqual(set(ok["skill"]), {"id", "path", "state", "title", "bytes", "sha256", "roles"})
        self.assertEqual(ok["text"], data.decode())
        self.assertEqual(ok["skill"]["state"], "ok")
        large_result = self.call("skill.show", workspace=self.ws, skill="large")["data"]
        self.assertEqual((large_result["skill"]["state"], len(large_result["text"].encode())),
                         ("truncated", LIMIT))
        self.assertEqual(large_result["text"], large[:LIMIT].decode())
        missing = self.call("skill.show", workspace=self.ws, skill="ghost")["data"]
        self.assertEqual((missing["skill"]["state"], missing["text"]), ("missing", None))
        unknown = self.call("skill.show", workspace=self.ws, skill="absent")
        self.assertEqual(unknown["error"]["code"], "SKILL_NOT_FOUND")
        bad = self.call("skill.show", workspace=self.ws, skill="Bad")
        self.assertEqual(bad["error"]["code"], "BAD_REQUEST")

    def test_dispatch_rejects_unknown_arguments_and_bad_workspaces(self):
        self.catalog({})
        self.assertEqual(self.call("skill.list", workspace=self.ws, z=1, a=1)["error"]["message"],
                         "skill.list got unknown argument(s): a, z.")
        self.assertEqual(self.call("skill.show", workspace=self.ws, skill="a", extra=True)["error"]["message"],
                         "skill.show got unknown argument(s): extra.")
        self.assertEqual(self.call("skill.list")["error"]["message"], "Missing required argument 'workspace'.")
        self.assertEqual(self.call("skill.list", workspace=os.path.dirname(self.ws))["error"]["code"],
                         "WORKSPACE_NOT_FOUND")

    def test_listing_and_showing_are_read_only(self):
        self.write("skills/a/SKILL.md", b"# A\n")
        self.write("roles/worker.md", b"instructions")
        self.catalog({"worker": {"skills": ["a"], "instructions": "roles/worker.md"}})

        def snapshot():
            return {str(path.relative_to(self.ws)): path.read_bytes()
                    for path in Path(self.ws).rglob("*") if path.is_file()}

        before = snapshot()
        self.assertEqual(skills.list_skills(self.ws), skills.list_skills(self.ws))
        self.call("skill.list", workspace=self.ws)
        self.call("skill.show", workspace=self.ws, skill="a")
        self.assertEqual(snapshot(), before)


if __name__ == "__main__":
    unittest.main()
