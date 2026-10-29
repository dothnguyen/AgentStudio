"""P05-S32: saving shared role instructions changes only assignments created afterwards (Codex stand-in)."""
import hashlib
import json
import os
import sqlite3
import unittest

from tests.helpers import key, req, wait_until
from tests.integration.test_s08_providers import CodexCase, write


class RoleInstructionDispatch(CodexCase):
    ctl = {"slowSeconds": 6}

    def setUp(self):
        super().setUp()
        cfg = os.path.join(self.ws, ".agent-studio")
        write(os.path.join(cfg, "roles", "developer.md"), "OLD-MARKER: write tests first.\n")

    def request_json(self, assignment):
        conn = sqlite3.connect(os.path.join(self.sb.state_dir, "state.db"), timeout=10)
        try:
            row = conn.execute("SELECT request_json FROM assignments WHERE id = ?", (assignment,)).fetchone()
        finally:
            conn.close()
        return json.loads(row[0])

    def test_save_changes_only_future_assignment_role_context(self):
        r = self.start([{"providerId": "codex", "role": "Developer"}, {"providerId": "codex", "role": "Developer"}])
        self.assertTrue(r["ok"], r)
        team = r["data"]["teamId"]
        first, second = [a["agentId"] for a in r["data"]["agents"]]

        rc, listed, _ = self.sb.request(req("role.list", {"workspace": self.ws}))
        self.assertTrue(listed["ok"], listed)
        item = next(x for x in listed["data"]["items"] if x["id"] == "Developer")
        roles_sha, instr_sha = listed["data"]["sha256"], item["instructions"]["sha256"]

        a = self.direct(team, first, text="OLD-TASK write at least 400 words")["assignmentId"]
        wait_until(lambda: any("OLD-TASK" in c["prompt"] for c in self.calls()), timeout=20, message="A captured")

        rc, saved, _ = self.sb.request(req("role.instructions.update", {
            "workspace": self.ws, "role": "Developer", "text": "NEW-MARKER: review before merge.\n",
            "expectedRolesSha256": roles_sha, "expectedInstructionsSha256": instr_sha}))
        self.assertTrue(saved["ok"], saved)
        self.assertEqual(saved["data"]["appliesTo"], "new_assignments")
        self.assertEqual(saved["data"]["message"], "Saved role instructions. Changes apply to new assignments; "
                         "existing assignments keep their frozen role context.")

        b = self.direct(team, second, text="NEW-TASK quick")["assignmentId"]
        old_req, new_req = self.request_json(a), self.request_json(b)
        old_ctx, new_ctx = old_req["roleContext"], new_req["roleContext"]
        self.assertIn("OLD-MARKER", old_ctx["text"])
        self.assertNotIn("NEW-MARKER", old_ctx["text"])
        self.assertIn("NEW-MARKER", new_ctx["text"])
        self.assertNotIn("OLD-MARKER", new_ctx["text"])
        self.assertNotEqual(old_ctx["sha256"], new_ctx["sha256"])
        old_src = next(s for s in old_ctx["sources"] if s["kind"] == "role")
        new_src = next(s for s in new_ctx["sources"] if s["kind"] == "role")
        self.assertEqual((old_src["path"], old_src["bytes"], old_src["sha256"]),
                         (".agent-studio/roles/developer.md", len(b"OLD-MARKER: write tests first.\n"),
                          hashlib.sha256(b"OLD-MARKER: write tests first.\n").hexdigest()))
        new_bytes = b"NEW-MARKER: review before merge.\n"
        self.assertEqual((new_src["path"], new_src["bytes"], new_src["sha256"]),
                         (".agent-studio/roles/developer.md", len(new_bytes), hashlib.sha256(new_bytes).hexdigest()))

        self.assertEqual(self.wait_done(team, a)["status"], "succeeded")
        self.assertEqual(self.wait_done(team, b)["status"], "succeeded")
        prompts = {("OLD-TASK" in c["prompt"]): c["prompt"] for c in self.calls() if "TASK" in c["prompt"]}
        self.assertIn("OLD-MARKER", prompts[True])
        self.assertNotIn("NEW-MARKER", prompts[True])
        self.assertIn("NEW-MARKER", prompts[False])
        self.assertNotIn("OLD-MARKER", prompts[False])
        self.assertEqual([t["id"] for t in self.sb.snapshot(team)["teams"]], [team])


if __name__ == "__main__":
    unittest.main()
