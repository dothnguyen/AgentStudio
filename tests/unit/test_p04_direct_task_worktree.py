"""Role-configured one-off task worktrees and coordinator-owned merge-on-success."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest

from tests import helpers
from tests.helpers import fresh, make_repo
from tests.unit.test_s03_rules import final
from agent_studio import report_rules, tasks


class DirectTaskWorktree(unittest.TestCase):
    def setUp(self):
        self.ws = make_repo()
        self.addCleanup(helpers.reset_repo, self.ws)
        self.state_dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.state_dir, True)
        base = subprocess.run(["git", "-C", self.ws, "symbolic-ref", "--short", "HEAD"], check=True,
                              stdout=subprocess.PIPE, text=True).stdout.strip()
        with open(os.path.join(self.ws, "shared.txt"), "w") as f:
            f.write("base\n")
        with open(os.path.join(self.ws, ".agent-studio", "roles.json"), "w") as f:
            json.dump({"version": 1, "roles": {"planner": {
                "directTask": {"workspace": "worktree", "mergeOnSuccess": True, "baseBranch": base,
                               "onMergeConflict": "merge-conflict"}}}}, f)
        with open(os.path.join(self.ws, ".agent-studio", "board.json"), "w") as f:
            json.dump({"version": 2,
                       "statuses": [{"id": "backlog", "kind": "initial"}, {"id": "merge-conflict"},
                                    {"id": "done", "kind": "done"}],
                       "ticketFields": [], "rules": []}, f)
        subprocess.run(["git", "-C", self.ws, "add", "-A"], check=True)
        subprocess.run(["git", "-C", self.ws, "commit", "-qm", "role policy"], check=True)
        self.conn, self.store = fresh()
        self.ctx = {"debug": True, "stateDir": self.state_dir}
        with self.store.transaction() as tx:
            self.team = tx.create("team", {"name": "t", "workspace": self.ws})
            tx.transition("team", self.team, "running")
            self.agent = tx.create("agent", {"team_id": self.team, "ordinal": 0, "provider_id": "fake",
                                              "role": "planner", "display_name": "Planner",
                                              "pane_state": "alive", "can_add_tickets": 1})
            tx.transition("agent", self.agent, "idle")

    def start(self, text="Edit the plan", policy="workspace_write"):
        with self.store.transaction() as tx:
            return tasks.task_direct(tx, {"teamId": self.team, "agentId": self.agent,
                                          "policy": policy, "text": text}, self.ctx)

    def finish(self, receipt, policy="workspace_write"):
        with self.store.transaction() as tx:
            tx.transition("assignment", receipt["assignmentId"], "claimed")
            tx.transition("assignment", receipt["assignmentId"], "running")
            tx.transition("task", receipt["taskId"], "running")
            tx.transition("agent", self.agent, "busy")
            payload = final(receipt["assignmentId"], self.agent, "succeeded", policy=policy)
            report_rules.apply(tx, {"assignment_id": receipt["assignmentId"], "report_seq": 1,
                                    "kind": "final", "payload": payload}, self.ctx)

    def test_success_merges_files_and_removes_the_isolated_worktree(self):
        receipt = self.start()
        worktree = receipt["workspace"]
        self.assertNotEqual(worktree, self.ws)
        self.assertTrue(os.path.isdir(worktree))
        with open(os.path.join(worktree, "plan.md"), "w") as f:
            f.write("isolated plan\n")
        self.assertFalse(os.path.exists(os.path.join(self.ws, "plan.md")))

        self.finish(receipt)

        self.assertEqual(self.conn.execute("SELECT status FROM tasks WHERE id = ?", (receipt["taskId"],))
                         .fetchone()[0], "succeeded")
        self.assertTrue(os.path.isfile(os.path.join(self.ws, "plan.md")))
        self.assertFalse(os.path.isdir(worktree))
        names = [r[0] for r in self.conn.execute(
            "SELECT name FROM events WHERE task_id = ? ORDER BY seq", (receipt["taskId"],)).fetchall()]
        self.assertIn("task.worktree_merged", names)

    def test_board_only_success_needs_no_main_merge_and_tolerates_dirty_main(self):
        receipt = self.start("Create a board ticket", policy="read_only")
        with open(os.path.join(self.ws, "operator-note.txt"), "w") as f:
            f.write("unrelated dirty file\n")
        self.finish(receipt, policy="read_only")
        self.assertEqual(self.conn.execute("SELECT status FROM tasks WHERE id = ?", (receipt["taskId"],))
                         .fetchone()[0], "succeeded")
        self.assertFalse(os.path.isdir(receipt["workspace"]))
        self.assertTrue(os.path.isfile(os.path.join(self.ws, "operator-note.txt")))

    def test_conflict_fails_direct_task_and_creates_recovery_ticket_for_preserved_worktree(self):
        receipt = self.start("Update the shared plan")
        with open(os.path.join(receipt["workspace"], "shared.txt"), "w") as f:
            f.write("from task\n")
        with open(os.path.join(self.ws, "shared.txt"), "w") as f:
            f.write("from main\n")
        subprocess.run(["git", "-C", self.ws, "add", "shared.txt"], check=True)
        subprocess.run(["git", "-C", self.ws, "commit", "-qm", "concurrent main change"], check=True)

        self.finish(receipt)

        self.assertEqual(self.conn.execute("SELECT status FROM tasks WHERE id = ?", (receipt["taskId"],))
                         .fetchone()[0], "failed")
        ticket = dict(self.conn.execute("SELECT * FROM tickets").fetchone())
        self.assertEqual(ticket["status"], "merge-conflict")
        self.assertEqual(ticket["worktree_path"], receipt["workspace"])
        self.assertTrue(os.path.isdir(receipt["workspace"]))
        with open(os.path.join(self.ws, "shared.txt")) as f:
            self.assertEqual(f.read(), "from main\n")
        status = subprocess.run(["git", "-C", self.ws, "status", "--porcelain"], check=True,
                                stdout=subprocess.PIPE, text=True).stdout
        self.assertEqual(status, "")


if __name__ == "__main__":
    unittest.main()
