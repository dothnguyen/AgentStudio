import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from backend.agent_studio import PROTOCOL, dispatch, roles
from backend.agent_studio.protocol import AsError

LIMIT = roles.LIMITS["instructions"]


def sha(data):
    return hashlib.sha256(data).hexdigest()


class InstructionSaveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = self.tmp.name
        self.base = Path(self.ws, ".agent-studio")
        (self.base / "roles").mkdir(parents=True)
        self.roles_path = self.base / "roles.json"
        self.doc = {"version": 1, "extra": {"keep": 1}, "roles": {
            "worker": {"name": "Worker", "description": "d", "instructions": "custom/worker.md", "skills": ["a"],
                       "directTask": {"workspace": "main"}, "unknown": 7},
            "plain": {"name": "Plain", "description": "p", "skills": ["b"], "directTask": {"workspace": "main"}, "x": 1},
            "last": {}}}
        self.write_roles(self.doc)
        (self.base / "custom").mkdir()
        (self.base / "custom" / "worker.md").write_bytes(b"old text")

    def write_roles(self, doc):
        self.roles_path.write_text(json.dumps(doc), encoding="utf-8")

    def tokens(self, rel):
        target = self.base / rel
        return sha(self.roles_path.read_bytes()), (sha(target.read_bytes()) if target.exists() else None)

    def snapshot(self):
        return {str(p.relative_to(self.base)): p.read_bytes() for p in self.base.rglob("*") if p.is_file()}

    def save(self, role, text, rel, **kw):
        r, i = self.tokens(rel)
        return roles.update_instructions(self.ws, role, text, kw.get("roles", r), kw.get("instr", i))

    def assertCode(self, code, fn, message=None):
        with self.assertRaises(AsError) as cm:
            fn()
        self.assertEqual(cm.exception.code, code)
        if message:
            self.assertEqual(cm.exception.message, message)
        return cm.exception

    def no_temps(self):
        self.assertEqual([p for p in self.base.rglob("*") if p.name.startswith(".as-stage.")], [])

    def request(self, **args):
        base = {"workspace": self.ws, "role": "worker", "text": "x",
                "expectedRolesSha256": "0" * 64, "expectedInstructionsSha256": None}
        base.update(args)
        base = {k: v for k, v in base.items() if v is not ...}
        return dispatch.handle_request({"protocol": PROTOCOL, "command": "role.instructions.update", "args": base}, False)

    def test_custom_path_is_replaced_in_place_without_rewriting_roles_json(self):
        before = self.roles_path.read_bytes()
        out = self.save("worker", "new text", "custom/worker.md")
        self.assertEqual((self.base / "custom/worker.md").read_bytes(), b"new text")
        self.assertEqual(self.roles_path.read_bytes(), before)
        self.assertEqual(out["rolesSha256"], sha(before))
        self.assertEqual(out["instructions"], {"path": "custom/worker.md", "state": "ok", "text": "new text",
                                               "sha256": sha(b"new text"), "bytes": 8})
        self.assertEqual(out["appliesTo"], "new_assignments")
        self.assertIn("Changes apply to new assignments", out["message"])
        self.assertFalse((self.base / "roles/worker.md").exists())
        self.no_temps()

    def test_pathless_role_creates_conventional_file_and_reference(self):
        out = self.save("plain", "hello", "roles/plain.md")
        self.assertEqual((self.base / "roles/plain.md").read_bytes(), b"hello")
        doc = json.loads(self.roles_path.read_text())
        expected = json.loads(json.dumps(self.doc))
        expected["roles"]["plain"]["instructions"] = "roles/plain.md"
        self.assertEqual(doc, expected)
        self.assertEqual(list(doc["roles"]), ["worker", "plain", "last"])
        self.assertEqual(out["rolesSha256"], sha(self.roles_path.read_bytes()))
        self.assertEqual(out["instructions"]["path"], "roles/plain.md")
        self.no_temps()

    def test_empty_unicode_and_exact_byte_limit_are_saved(self):
        out = self.save("worker", "", "custom/worker.md")
        self.assertEqual((out["instructions"]["bytes"], out["instructions"]["sha256"]), (0, sha(b"")))
        self.assertEqual((self.base / "custom/worker.md").read_bytes(), b"")
        text = "héllo 日本語 🙂"
        out = self.save("worker", text, "custom/worker.md")
        self.assertEqual(out["instructions"]["bytes"], len(text.encode()))
        self.assertGreater(len(text.encode()), len(text))
        text = "日" * (LIMIT // 3) + "a"
        self.assertEqual(len(text.encode()), LIMIT)
        r, i = self.tokens("custom/worker.md")
        resp = self.request(text=text, expectedRolesSha256=r, expectedInstructionsSha256=i)
        self.assertTrue(resp["ok"], resp)
        self.assertEqual(resp["data"]["instructions"]["bytes"], LIMIT)
        self.assertEqual((self.base / "custom/worker.md").read_bytes(), text.encode())

    def test_dispatch_rejects_oversize_nul_bad_tokens_missing_and_unknown_arguments(self):
        r, i = self.tokens("custom/worker.md")
        before = self.snapshot()
        good = {"expectedRolesSha256": r, "expectedInstructionsSha256": i}
        cases = [dict(good, text="a" * (LIMIT + 1)), dict(good, text="a\x00b"),
                 dict(good, text=None), dict(good, text=5), dict(good, role=""), dict(good, role="é" * 101),
                 dict(good, expectedRolesSha256="A" * 64), dict(good, expectedRolesSha256=...),
                 dict(good, expectedRolesSha256=r[:-1]), dict(good, expectedInstructionsSha256=...),
                 dict(good, expectedInstructionsSha256="g" * 64), dict(good, expectedInstructionsSha256=i + "\n"),
                 dict(good, extra=1)]
        for args in cases:
            with self.subTest(args={k: str(v)[:20] for k, v in args.items()}):
                resp = self.request(**args)
                self.assertFalse(resp["ok"])
                self.assertEqual(resp["error"]["code"], "BAD_REQUEST")
        self.assertEqual(self.snapshot(), before)
        with self.assertRaises(AsError) as cm:
            dispatch._role_instructions_update({"workspace": self.ws, "role": "worker", "text": "a\ud800",
                                                "expectedRolesSha256": r, "expectedInstructionsSha256": i}, {})
        self.assertEqual(cm.exception.code, "BAD_REQUEST")
        self.assertIn("unpaired surrogate", cm.exception.message)

    def test_missing_configured_file_is_created_for_matching_null_token(self):
        (self.base / "custom/worker.md").unlink()
        before = self.roles_path.read_bytes()
        self.doc["roles"]["worker"]["instructions"] = "deep/er/w.md"
        self.write_roles(self.doc)
        out = self.save("worker", "made", "deep/er/w.md")
        self.assertEqual((self.base / "deep/er/w.md").read_bytes(), b"made")
        self.assertEqual(json.loads(self.roles_path.read_text())["roles"]["worker"]["instructions"], "deep/er/w.md")
        self.assertEqual(out["instructions"]["path"], "deep/er/w.md")
        self.assertNotEqual(before, b"")

    def test_unsafe_absolute_parent_directory_and_escaping_symlink_paths_write_nothing(self):
        outside = tempfile.TemporaryDirectory()
        self.addCleanup(outside.cleanup)
        os.symlink(outside.name, self.base / "link")
        os.symlink(os.path.join(outside.name, "t.md"), self.base / "filelink.md")
        (self.base / "adir").mkdir()
        (self.base / "afile").write_bytes(b"f")
        message = "Role 'worker' instructions path must be a regular file inside .agent-studio."
        for rel in ("/etc/x.md", "../x.md", "a/../x.md", "", "adir", "link/x.md", "filelink.md", "afile/x.md"):
            with self.subTest(rel=rel):
                self.doc["roles"]["worker"]["instructions"] = rel
                self.write_roles(self.doc)
                before = self.snapshot()
                self.assertCode("ROLES_CONFIG_INVALID", lambda: roles.update_instructions(
                    self.ws, "worker", "t", sha(self.roles_path.read_bytes()), None), message)
                self.assertEqual(self.snapshot(), before)
                self.assertEqual(os.listdir(outside.name), [])
        self.doc["roles"]["bad/id"] = {}
        self.write_roles(self.doc)
        self.assertCode("ROLES_CONFIG_INVALID", lambda: roles.update_instructions(
            self.ws, "bad/id", "t", sha(self.roles_path.read_bytes()), None),
            "Role 'bad/id' instructions path must be a regular file inside .agent-studio.")

    def test_stale_roles_token_returns_fresh_tokens_and_writes_nothing(self):
        r, i = self.tokens("custom/worker.md")
        (self.base / "custom/worker.md").write_bytes(b"also changed")
        self.write_roles(dict(self.doc, extra={"keep": 2}))
        before = self.snapshot()
        err = self.assertCode("CONFIG_CHANGED", lambda: roles.update_instructions(self.ws, "worker", "t", r, i),
                              ".agent-studio/roles.json changed since it was read; reload and retry.")
        fresh = self.tokens("custom/worker.md")
        self.assertEqual(err.data, {"rolesSha256": fresh[0], "instructionsSha256": fresh[1]})
        self.assertEqual(self.snapshot(), before)

    def test_stale_instruction_token_returns_fresh_tokens_and_writes_nothing(self):
        r, i = self.tokens("custom/worker.md")
        (self.base / "custom/worker.md").write_bytes(b"\xff changed")
        before = self.snapshot()
        err = self.assertCode("CONFIG_CHANGED", lambda: roles.update_instructions(self.ws, "worker", "t", r, i),
                              "Role 'worker' instructions changed since they were read; reload and retry.")
        self.assertEqual(err.data, {"rolesSha256": r, "instructionsSha256": sha(b"\xff changed")})
        self.assertEqual(self.snapshot(), before)
        # The invalid-UTF-8 file can be repaired with its raw-byte token.
        roles.update_instructions(self.ws, "worker", "fixed", r, sha(b"\xff changed"))
        self.assertEqual((self.base / "custom/worker.md").read_bytes(), b"fixed")

    def test_pathless_existing_conventional_file_conflicts_with_null_token(self):
        (self.base / "roles/plain.md").write_bytes(b"orphan")
        r, _ = self.tokens("roles/plain.md")
        before = self.snapshot()
        err = self.assertCode("CONFIG_CHANGED", lambda: roles.update_instructions(self.ws, "plain", "t", r, None))
        self.assertEqual(err.data["instructionsSha256"], sha(b"orphan"))
        self.assertEqual(self.snapshot(), before)

    def test_configured_replace_failure_keeps_original_and_cleans_temps(self):
        before = self.snapshot()
        with mock.patch.object(roles, "_replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.save("worker", "new", "custom/worker.md")
        self.assertEqual(self.snapshot(), before)
        self.no_temps()

    def test_pathless_second_replace_failure_rolls_back_instruction_and_cleans_temps(self):
        real = roles._replace

        def fail_roles(src, dst):
            if dst.endswith("roles.json"):
                raise OSError("boom")
            real(src, dst)

        for existing in (False, True):
            with self.subTest(existing=existing):
                target = self.base / "roles/plain.md"
                if existing:
                    target.write_bytes(b"prior")
                else:
                    target.unlink(missing_ok=True)
                before = self.snapshot()
                with mock.patch.object(roles, "_replace", side_effect=fail_roles):
                    with self.assertRaises(OSError):
                        self.save("plain", "new", "roles/plain.md")
                self.assertEqual(self.snapshot(), before)
                self.no_temps()

    def test_invalid_catalog_and_unknown_role_do_not_write(self):
        self.roles_path.write_text("{not json")
        before = self.snapshot()
        err = self.assertCode("ROLES_CONFIG_INVALID", lambda: roles.update_instructions(
            self.ws, "worker", "t", sha(self.roles_path.read_bytes()), None))
        self.assertIn("not valid JSON", err.message)
        self.assertEqual(self.snapshot(), before)
        self.write_roles({"version": 2, "roles": {}})
        before = self.snapshot()
        self.assertCode("ROLES_CONFIG_INVALID", lambda: roles.update_instructions(
            self.ws, "worker", "t", sha(self.roles_path.read_bytes()), None))
        self.assertEqual(self.snapshot(), before)
        self.write_roles(self.doc)
        before = self.snapshot()
        self.assertCode("ROLE_NOT_FOUND", lambda: roles.update_instructions(
            self.ws, "Worker", "t", sha(self.roles_path.read_bytes()), None),
            "Role 'Worker' is not defined in .agent-studio/roles.json.")
        self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
