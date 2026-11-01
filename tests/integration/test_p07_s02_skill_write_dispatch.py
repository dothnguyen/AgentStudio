"""P07-S02: skill.create and skill.update through the real request shim."""
import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path

from tests.helpers import Sandbox, key, req, wait_until
from tests.integration.test_s08_providers import CodexCase, write


OLD_SKILL = b"SKILL-MARKER: four-space indents.\n"
NEW_SKILL = b"NEW-SKILL-CONTENT: two-space indents.\n"


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

    def snapshot(self):
        return {str(path.relative_to(self.ws)): path.read_bytes()
                for path in Path(self.ws).rglob("*") if path.is_file()}

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

    def test_second_write_with_the_same_token_is_a_conflict(self):
        created = self.request("skill.create", {
            "workspace": self.ws, "skill": {"id": "new-skill", "text": "one"}})[1]["data"]
        token = created["skill"]["sha256"]
        first = self.request("skill.update", {
            "workspace": self.ws, "skill": "new-skill", "text": "two", "expectedSha256": token})[1]
        self.assertTrue(first["ok"], first)
        before = self.snapshot()
        rc, stale, _ = self.request("skill.update", {
            "workspace": self.ws, "skill": "new-skill", "text": "three", "expectedSha256": token})
        self.assertFalse(stale["ok"], stale)
        self.assertEqual(stale["error"]["code"], "CONFIG_CHANGED")
        self.assertEqual(stale["data"], {"skillSha256": hashlib.sha256(b"two").hexdigest()})
        self.assertEqual(self.snapshot(), before)

    def test_unknown_arguments_and_bad_input_are_rejected_without_writes(self):
        before = self.snapshot()
        cases = [
            ("skill.create", {"workspace": self.ws, "skill": {"id": "a", "text": "x"}, "extra": 1}),
            ("skill.create", {"workspace": self.ws, "skill": {"id": "a", "text": "x", "extra": 1}}),
            ("skill.create", {"workspace": self.ws, "skill": {"id": "A", "text": "x"}}),
            ("skill.update", {"workspace": self.ws, "skill": "house-style", "text": "x",
                              "expectedSha256": "0" * 64, "extra": 1}),
            ("skill.update", {"workspace": self.ws, "skill": "house-style", "text": "x"}),
            ("skill.update", {"workspace": self.ws, "skill": "house-style", "expectedSha256": "0" * 64}),
            ("skill.update", {"workspace": self.ws, "skill": "house-style", "text": "x",
                              "expectedSha256": "0" * 63}),
        ]
        for command, args in cases:
            with self.subTest(command=command, args=args):
                rc, response, _ = self.request(command, args)
                self.assertFalse(response["ok"], response)
                self.assertEqual(response["error"]["code"], "BAD_REQUEST")
        self.assertEqual(self.snapshot(), before)

    def test_missing_and_truncated_skills_are_reported(self):
        rc, missing, _ = self.request("skill.update", {
            "workspace": self.ws, "skill": "absent", "text": "x", "expectedSha256": "0" * 64})
        self.assertEqual(missing["error"]["code"], "SKILL_NOT_FOUND")
        (Path(self.base, "skills", "big")).mkdir()
        Path(self.base, "skills", "big", "SKILL.md").write_bytes(b"a" * (32 * 1024 + 1))
        rc, truncated, _ = self.request("skill.update", {
            "workspace": self.ws, "skill": "big", "text": "x", "expectedSha256": "0" * 64})
        self.assertEqual(truncated["error"]["code"], "BAD_REQUEST")
        self.assertIn("shorten it outside the app first", truncated["error"]["message"])


class SkillWriteAssignment(CodexCase):
    """A skill update affects the skills frozen into new assignments, not running ones (P05-S32 pattern)."""

    ctl = {"slowSeconds": 6}

    def request_json(self, assignment):
        conn = sqlite3.connect(os.path.join(self.sb.state_dir, "state.db"), timeout=10)
        try:
            row = conn.execute("SELECT request_json FROM assignments WHERE id = ?", (assignment,)).fetchone()
        finally:
            conn.close()
        return json.loads(row[0])

    def test_update_changes_only_future_assignment_skill_context(self):
        r = self.start([{"providerId": "codex", "role": "Developer"},
                        {"providerId": "codex", "role": "Developer"}])
        self.assertTrue(r["ok"], r)
        team = r["data"]["teamId"]
        first, second = [a["agentId"] for a in r["data"]["agents"]]

        rc, shown, _ = self.sb.request(req("skill.show", {"workspace": self.ws, "skill": "house-style"}))
        self.assertTrue(shown["ok"], shown)
        token = shown["data"]["skill"]["sha256"]

        a = self.direct(team, first, text="OLD-TASK write at least 400 words")["assignmentId"]
        wait_until(lambda: any("OLD-TASK" in c["prompt"] for c in self.calls()), timeout=20, message="A captured")

        rc, saved, _ = self.sb.request(req("skill.update", {
            "workspace": self.ws, "skill": "house-style", "text": NEW_SKILL.decode(),
            "expectedSha256": token}))
        self.assertTrue(saved["ok"], saved)
        self.assertEqual(saved["data"]["skill"]["sha256"], hashlib.sha256(NEW_SKILL).hexdigest())

        b = self.direct(team, second, text="NEW-TASK quick")["assignmentId"]
        old_ctx = self.request_json(a)["roleContext"]
        new_ctx = self.request_json(b)["roleContext"]
        self.assertIn("SKILL-MARKER", old_ctx["text"])
        self.assertNotIn("NEW-SKILL-CONTENT", old_ctx["text"])
        self.assertIn("NEW-SKILL-CONTENT", new_ctx["text"])
        self.assertNotIn("SKILL-MARKER", new_ctx["text"])
        old_src = next(s for s in old_ctx["sources"] if s["kind"] == "skill")
        new_src = next(s for s in new_ctx["sources"] if s["kind"] == "skill")
        self.assertEqual((old_src["path"], old_src["sha256"]),
                         (".agent-studio/skills/house-style/SKILL.md", hashlib.sha256(OLD_SKILL).hexdigest()))
        self.assertEqual((new_src["path"], new_src["sha256"]),
                         (".agent-studio/skills/house-style/SKILL.md", hashlib.sha256(NEW_SKILL).hexdigest()))

        self.assertEqual(self.wait_done(team, a)["status"], "succeeded")
        self.assertEqual(self.wait_done(team, b)["status"], "succeeded")
        prompts = {("OLD-TASK" in c["prompt"]): c["prompt"] for c in self.calls() if "TASK" in c["prompt"]}
        self.assertIn("SKILL-MARKER", prompts[True])
        self.assertNotIn("NEW-SKILL-CONTENT", prompts[True])
        self.assertIn("NEW-SKILL-CONTENT", prompts[False])
        self.assertNotIn("SKILL-MARKER", prompts[False])


if __name__ == "__main__":
    unittest.main()
