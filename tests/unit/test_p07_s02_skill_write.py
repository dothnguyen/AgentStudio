"""P07-S02: create and update a skill file through the skill commands."""
import hashlib
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from backend.agent_studio import PROTOCOL, dispatch, roles, skills
from backend.agent_studio.protocol import AsError

LIMIT = roles.LIMITS["skill"]
TEXT = "# Alpha skill\nbody\n"


def sha(data):
    return hashlib.sha256(data).hexdigest()


class SkillWriteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = self.tmp.name
        self.base = Path(self.ws, ".agent-studio")
        self.base.mkdir()
        self.roles_path = self.base / "roles.json"
        self.roles_path.write_bytes(b'{"version": 1, "roles": {}}')
        self.roles_before = self.roles_path.read_bytes()

    # ---- helpers ---------------------------------------------------------------------------
    def files(self):
        found = {}
        for root, _, names in os.walk(self.ws):
            for name in names:
                path = Path(root, name)
                found[str(path.relative_to(self.ws))] = path.read_bytes()
        return found

    def target(self, skill):
        return self.base / "skills" / skill / "SKILL.md"

    def no_temps(self):
        self.assertEqual([p for p in self.base.rglob("*") if p.name.startswith(".as-stage.")], [])

    def assertNoRolesChange(self):
        self.assertEqual(self.roles_path.read_bytes(), self.roles_before)

    def assertCode(self, code, fn, message=None):
        with self.assertRaises(AsError) as cm:
            fn()
        self.assertEqual(cm.exception.code, code)
        if message is not None:
            self.assertEqual(cm.exception.message, message)
        return cm.exception

    def create(self, skill, text=TEXT):
        return skills.create_skill(self.ws, {"id": skill, "text": text})

    def update(self, skill, text, token):
        return skills.update_skill(self.ws, skill, text, token)

    def call(self, command, **args):
        return dispatch.handle_request({"protocol": PROTOCOL, "id": "r", "command": command,
                                        "args": args}, True)

    # ---- create ----------------------------------------------------------------------------
    def test_create_makes_folders_and_returns_the_item(self):
        out = self.create("alpha")
        target = self.target("alpha")
        self.assertEqual(target.read_bytes(), TEXT.encode())
        self.assertTrue((self.base / "skills").is_dir())
        self.assertEqual(out["workspace"], self.ws)
        self.assertEqual(out["text"], TEXT)
        self.assertEqual(out["skill"], {
            "id": "alpha", "path": "skills/alpha/SKILL.md", "state": "ok", "title": "Alpha skill",
            "bytes": len(TEXT.encode()), "sha256": sha(TEXT.encode()), "roles": []})
        self.assertEqual([p.name for p in target.parent.iterdir()], ["SKILL.md"])
        self.no_temps()
        self.assertNoRolesChange()

    def test_create_empty_text_is_allowed(self):
        out = self.create("empty", "")
        self.assertEqual(self.target("empty").read_bytes(), b"")
        self.assertEqual((out["skill"]["state"], out["skill"]["title"], out["skill"]["bytes"],
                          out["skill"]["sha256"]), ("ok", None, 0, sha(b"")))
        self.assertEqual(out["text"], "")
        self.no_temps()
        self.assertNoRolesChange()

    def test_create_new_file_gets_the_default_mode(self):
        out = self.create("alpha")
        umask = os.umask(0)
        os.umask(umask)
        mode = stat.S_IMODE(os.stat(self.target("alpha")).st_mode)
        self.assertEqual(mode, 0o666 & ~umask)
        self.assertEqual(out["skill"]["state"], "ok")
        self.assertNoRolesChange()

    def test_create_with_existing_skills_directory_or_empty_skill_folder(self):
        (self.base / "skills").mkdir()
        out = self.create("beta", "# Beta\n")
        self.assertEqual(self.target("beta").read_bytes(), b"# Beta\n")
        self.assertEqual(out["skill"]["id"], "beta")
        (self.base / "skills" / "gamma").mkdir()
        self.create("gamma", "plain")
        self.assertEqual(self.target("gamma").read_bytes(), b"plain")
        self.no_temps()
        self.assertNoRolesChange()

    def test_create_existing_file_is_rejected_without_changing_it(self):
        self.create("alpha")
        before = self.files()
        self.assertCode("SKILL_EXISTS", lambda: self.create("alpha", "other"))
        self.assertEqual(self.files(), before)
        self.assertNoRolesChange()

    def test_create_invalid_ids_are_bad_requests_and_write_nothing(self):
        before = self.files()
        for skill in ("", "Upper", ".dot", "-dash", "a" * 65, "../x", "a/b", "a b", "é"):
            with self.subTest(skill=skill):
                err = self.assertCode("BAD_REQUEST", lambda skill=skill: self.create(skill))
                self.assertIn("skill.id", err.message)
                self.assertEqual(self.files(), before)
        self.assertFalse((self.base / "skills").exists())

    def test_create_exact_limit_is_saved_and_one_byte_more_is_rejected(self):
        exact = "a" * LIMIT
        out = self.create("exact", exact)
        self.assertEqual((out["skill"]["bytes"], out["skill"]["sha256"]), (LIMIT, sha(exact.encode())))
        self.assertEqual(self.target("exact").read_bytes(), exact.encode())
        before = self.files()
        err = self.assertCode("BAD_REQUEST", lambda: self.create("over", "a" * (LIMIT + 1)))
        self.assertIn("skill.text", err.message)
        self.assertEqual(self.files(), before)
        self.no_temps()
        self.assertNoRolesChange()

    def test_create_rejects_non_string_text(self):
        for value in (None, 5, b"bytes", ["text"]):
            with self.subTest(value=repr(value)):
                before = self.files()
                err = self.assertCode("BAD_REQUEST", lambda value=value: self.create("alpha", value))
                self.assertIn("skill.text", err.message)
                self.assertEqual(self.files(), before)
        self.assertFalse((self.base / "skills").exists())

    def test_create_counts_unicode_as_utf8_bytes(self):
        text = "é" * (LIMIT // 2)  # two UTF-8 bytes each: exactly the limit
        out = self.create("unicode", text)
        self.assertEqual(len(text.encode()), LIMIT)
        self.assertEqual(out["skill"]["bytes"], LIMIT)
        self.assertEqual(self.target("unicode").read_bytes(), text.encode())
        before = self.files()
        self.assertCode("BAD_REQUEST", lambda: self.create("over", text + "a"))
        self.assertEqual(self.files(), before)
        self.no_temps()
        self.assertNoRolesChange()

    def test_create_never_writes_through_a_symlinked_skills_or_skill_folder(self):
        outside = Path(self.ws, "outside")
        outside.mkdir()
        os.symlink(outside, self.base / "skills")
        self.assertCode("BAD_REQUEST", lambda: self.create("alpha"))
        self.assertEqual(list(outside.iterdir()), [])
        os.unlink(self.base / "skills")
        (self.base / "skills").mkdir()
        os.symlink(outside, self.base / "skills" / "alpha")
        self.assertCode("BAD_REQUEST", lambda: self.create("alpha"))
        self.assertEqual(list(outside.iterdir()), [])
        self.no_temps()
        self.assertNoRolesChange()

    def test_create_rechecks_for_the_file_immediately_before_replace(self):
        stage = roles._stage

        def appear(directory, data, mode):
            tmp = stage(directory, data, mode)
            Path(directory, "SKILL.md").write_bytes(b"other writer")
            return tmp

        with mock.patch.object(roles, "_stage", side_effect=appear):
            self.assertCode("SKILL_EXISTS", lambda: self.create("alpha"))
        self.assertEqual(self.target("alpha").read_bytes(), b"other writer")
        self.assertEqual([p.name for p in self.target("alpha").parent.iterdir()], ["SKILL.md"])
        self.no_temps()
        self.assertNoRolesChange()

    def test_create_replace_failure_removes_temp_and_new_folders(self):
        with mock.patch.object(roles, "_replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.create("alpha")
        self.assertFalse((self.base / "skills").exists())
        self.no_temps()
        self.assertNoRolesChange()

    # ---- update ----------------------------------------------------------------------------
    def test_update_replaces_content_and_keeps_the_file_mode(self):
        created = self.create("alpha")
        os.chmod(self.target("alpha"), 0o640)
        out = self.update("alpha", "# Beta\nnew\n", created["skill"]["sha256"])
        self.assertEqual(self.target("alpha").read_bytes(), b"# Beta\nnew\n")
        self.assertEqual(stat.S_IMODE(os.stat(self.target("alpha")).st_mode), 0o640)
        self.assertEqual(out["skill"], {
            "id": "alpha", "path": "skills/alpha/SKILL.md", "state": "ok", "title": "Beta",
            "bytes": len(b"# Beta\nnew\n"), "sha256": sha(b"# Beta\nnew\n"), "roles": []})
        self.assertEqual(out["text"], "# Beta\nnew\n")
        self.assertEqual([p.name for p in self.target("alpha").parent.iterdir()], ["SKILL.md"])
        self.no_temps()
        self.assertNoRolesChange()

    def test_update_stale_token_reports_current_sha_and_writes_nothing(self):
        created = self.create("alpha")
        self.target("alpha").write_bytes(b"interloper")
        before = self.files()
        err = self.assertCode("CONFIG_CHANGED", lambda: self.update(
            "alpha", "new", created["skill"]["sha256"]))
        self.assertEqual(err.data, {"skillSha256": sha(b"interloper")})
        self.assertEqual(self.files(), before)
        self.no_temps()
        self.assertNoRolesChange()

    def test_update_change_between_read_and_replace_is_a_conflict(self):
        created = self.create("alpha")
        real_read = roles._read_raw
        calls = {"count": 0}

        def read_then_change(path):
            calls["count"] += 1
            if calls["count"] == 2:  # the recheck immediately before replace
                Path(path).write_bytes(b"newer")
            return real_read(path)

        with mock.patch.object(roles, "_read_raw", side_effect=read_then_change):
            err = self.assertCode("CONFIG_CHANGED", lambda: self.update(
                "alpha", "mine", created["skill"]["sha256"]))
        self.assertEqual(err.data, {"skillSha256": sha(b"newer")})
        self.assertEqual(self.target("alpha").read_bytes(), b"newer")
        self.assertEqual([p.name for p in self.target("alpha").parent.iterdir()], ["SKILL.md"])
        self.no_temps()
        self.assertNoRolesChange()

    def test_update_file_removed_between_read_and_replace_reports_null_sha(self):
        created = self.create("alpha")
        real_read = roles._read_raw
        calls = {"count": 0}

        def read_then_remove(path):
            calls["count"] += 1
            if calls["count"] == 2:  # the recheck immediately before replace
                os.unlink(path)
            return real_read(path)

        with mock.patch.object(roles, "_read_raw", side_effect=read_then_remove):
            err = self.assertCode("CONFIG_CHANGED", lambda: self.update(
                "alpha", "mine", created["skill"]["sha256"]))
        self.assertEqual(err.data, {"skillSha256": None})
        self.assertFalse(self.target("alpha").exists())
        self.assertEqual(list(self.target("alpha").parent.iterdir()), [])
        self.no_temps()
        self.assertNoRolesChange()

    def test_update_to_empty_text_is_allowed(self):
        created = self.create("alpha")
        out = self.update("alpha", "", created["skill"]["sha256"])
        self.assertEqual(self.target("alpha").read_bytes(), b"")
        self.assertEqual((out["skill"]["state"], out["skill"]["title"], out["skill"]["bytes"],
                          out["skill"]["sha256"]), ("ok", None, 0, sha(b"")))
        self.assertEqual(out["text"], "")
        self.no_temps()
        self.assertNoRolesChange()

    def test_update_never_writes_through_a_symlinked_skills_or_skill_folder(self):
        outside = Path(self.ws, "outside")
        outside.mkdir()
        os.symlink(outside, self.base / "skills")
        self.assertCode("BAD_REQUEST", lambda: self.update("alpha", "text", "0" * 64))
        self.assertEqual(list(outside.iterdir()), [])
        os.unlink(self.base / "skills")
        (self.base / "skills").mkdir()
        os.symlink(outside, self.base / "skills" / "alpha")
        self.assertCode("BAD_REQUEST", lambda: self.update("alpha", "text", "0" * 64))
        self.assertEqual(list(outside.iterdir()), [])
        self.no_temps()
        self.assertNoRolesChange()

    def test_update_identical_bytes_is_a_no_op_that_keeps_inode_and_mtime(self):
        created = self.create("alpha")
        os.utime(self.target("alpha"), ns=(1_600_000_000_000_000_000,) * 2)
        before = os.stat(self.target("alpha"))
        out = self.update("alpha", TEXT, created["skill"]["sha256"])
        after = os.stat(self.target("alpha"))
        self.assertEqual((after.st_ino, after.st_mtime_ns), (before.st_ino, before.st_mtime_ns))
        self.assertEqual(out["skill"]["sha256"], created["skill"]["sha256"])
        self.assertEqual(out["text"], TEXT)
        self.no_temps()
        self.assertNoRolesChange()

    def test_update_exact_limit_and_unicode_bytes_are_saved(self):
        created = self.create("alpha")
        exact = "é" * (LIMIT // 2)  # two UTF-8 bytes each: exactly the limit
        out = self.update("alpha", exact, created["skill"]["sha256"])
        self.assertEqual(len(exact.encode()), LIMIT)
        self.assertEqual(out["skill"]["bytes"], LIMIT)
        self.assertEqual(self.target("alpha").read_bytes(), exact.encode())
        before = self.files()
        err = self.assertCode("BAD_REQUEST", lambda: self.update("alpha", exact + "a", out["skill"]["sha256"]))
        self.assertIn("text", err.message)
        self.assertEqual(self.files(), before)
        self.no_temps()
        self.assertNoRolesChange()

    def test_update_missing_file_is_skill_not_found(self):
        self.assertCode("SKILL_NOT_FOUND", lambda: self.update("ghost", "text", "0" * 64))
        self.assertFalse((self.base / "skills").exists())
        (self.base / "skills" / "ghost").mkdir(parents=True)
        self.assertCode("SKILL_NOT_FOUND", lambda: self.update("ghost", "text", "0" * 64))
        self.assertEqual(list((self.base / "skills" / "ghost").iterdir()), [])
        self.no_temps()
        self.assertNoRolesChange()

    def test_update_truncated_file_is_refused_with_a_shorten_message(self):
        (self.base / "skills" / "big").mkdir(parents=True)
        self.target("big").write_bytes(b"a" * (LIMIT + 1))
        before = self.files()
        err = self.assertCode("BAD_REQUEST", lambda: self.update("big", "short", "0" * 64))
        self.assertIn("shorten it outside the app first", err.message)
        self.assertEqual(self.files(), before)
        self.no_temps()
        self.assertNoRolesChange()

    def test_update_directory_or_symlinked_target_is_a_bad_request(self):
        (self.base / "skills" / "dir" / "SKILL.md").mkdir(parents=True)
        self.assertCode("BAD_REQUEST", lambda: self.update("dir", "text", "0" * 64))
        outside = Path(self.ws, "outside.md")
        outside.write_bytes(b"secret")
        (self.base / "skills" / "linked").mkdir(parents=True)
        os.symlink(outside, self.target("linked"))
        self.assertCode("BAD_REQUEST", lambda: self.update("linked", "text", "0" * 64))
        self.assertEqual(outside.read_bytes(), b"secret")
        self.no_temps()
        self.assertNoRolesChange()

    def test_update_replace_failure_keeps_the_old_file_and_cleans_temps(self):
        created = self.create("alpha")
        before = self.files()
        with mock.patch.object(roles, "_replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.update("alpha", "new", created["skill"]["sha256"])
        self.assertEqual(self.files(), before)
        self.assertEqual([p.name for p in self.target("alpha").parent.iterdir()], ["SKILL.md"])
        self.no_temps()
        self.assertNoRolesChange()

    # ---- dispatch and isolation ------------------------------------------------------------
    def test_dispatch_validates_arguments_and_writes_nothing(self):
        created = self.create("alpha")
        token = created["skill"]["sha256"]
        before = self.files()
        create_cases = [
            {},
            {"skill": "alpha"},
            {"skill": {"text": "x"}},
            {"skill": {"id": "beta"}},
            {"skill": {"id": "beta", "text": None}},
            {"skill": {"id": "beta", "text": "x", "extra": 1}},
            {"skill": {"id": "Bad", "text": "x"}},
            {"workspace": self.ws, "skill": {"id": "beta", "text": "x"}, "extra": 1},
        ]
        update_cases = [
            {"skill": "alpha", "expectedSha256": token},
            {"skill": "alpha", "text": "x"},
            {"skill": "alpha", "text": "x", "expectedSha256": None},
            {"skill": "alpha", "text": "x", "expectedSha256": "A" * 64},
            {"skill": "alpha", "text": "x", "expectedSha256": token[:-1]},
            {"skill": "Bad", "text": "x", "expectedSha256": token},
            {"skill": "alpha", "text": None, "expectedSha256": token},
            {"skill": "alpha", "text": "x", "expectedSha256": token, "extra": 1},
        ]
        for args in create_cases:
            with self.subTest(command="skill.create", args=args):
                resp = self.call("skill.create", **{"workspace": self.ws, **args}) \
                    if "workspace" not in args else self.call("skill.create", **args)
                self.assertFalse(resp["ok"], resp)
                self.assertEqual(resp["error"]["code"], "BAD_REQUEST")
        for args in update_cases:
            with self.subTest(command="skill.update", args=args):
                resp = self.call("skill.update", **{"workspace": self.ws, **args}) \
                    if "workspace" not in args else self.call("skill.update", **args)
                self.assertFalse(resp["ok"], resp)
                self.assertEqual(resp["error"]["code"], "BAD_REQUEST")
        self.assertEqual(self.files(), before)
        self.assertNoRolesChange()

    def test_dispatch_create_show_update_show_round_trip(self):
        created = self.call("skill.create", workspace=self.ws, skill={"id": "alpha", "text": TEXT})
        self.assertTrue(created["ok"], created)
        token = created["data"]["skill"]["sha256"]
        self.assertEqual(self.call("skill.show", workspace=self.ws, skill="alpha")["data"]["text"], TEXT)
        updated = self.call("skill.update", workspace=self.ws, skill="alpha", text="# Beta\n", expectedSha256=token)
        self.assertTrue(updated["ok"], updated)
        self.assertEqual(updated["data"]["text"], "# Beta\n")
        self.assertEqual(self.call("skill.show", workspace=self.ws, skill="alpha")["data"]["text"], "# Beta\n")
        self.assertEqual(self.target("alpha").read_bytes(), b"# Beta\n")
        self.assertNoRolesChange()

    def test_writes_do_not_require_or_parse_roles_json(self):
        self.roles_path.write_bytes(b"{not json")
        created = self.create("alpha")
        self.update("alpha", "# Beta\n", created["skill"]["sha256"])
        self.assertEqual(self.target("alpha").read_bytes(), b"# Beta\n")
        self.assertEqual(self.roles_path.read_bytes(), b"{not json")

    def test_writes_work_when_roles_json_is_missing(self):
        self.roles_path.unlink()
        created = self.create("alpha")
        self.update("alpha", "# Beta\n", created["skill"]["sha256"])
        self.assertEqual(self.target("alpha").read_bytes(), b"# Beta\n")
        self.assertFalse(self.roles_path.exists())
        self.no_temps()


if __name__ == "__main__":
    unittest.main()
