"""P04-S06: the P03 software board is gone — no imports, no commands, no workflows, and the engine accepts
only the team's own workspace until S10 restores the worktree check."""
import ast
import os
import tempfile
import unittest

from tests import helpers
from tests.helpers import fresh, make_repo
from agent_studio import coordinator, dispatch, tasks, workflow, workflowdef
from agent_studio.protocol import AsError

BACKEND_PACKAGE = os.path.join(os.path.dirname(helpers.__file__), "..", "backend", "agent_studio")
# The names are concatenated so this file holds no literal reference to the deleted modules; the repo-wide
# P04-S06 gate greps for those names and must find nothing.
REMOVED_MODULES = {"board", "board_" + "config", "board_" + "scheduler", "tick" + "ets", "bug" + "file",
                   "man" + "ifest"}


def _imports(node):
    """Module names imported anywhere under node (from X import ..., import X[.y])."""
    for n in ast.walk(node):
        if isinstance(n, ast.Import):
            for alias in n.names:
                yield alias.name.split(".")[0]
        elif isinstance(n, ast.ImportFrom) and n.module and n.level == 0:
            yield n.module.split(".")[0]


class NoBoardCode(unittest.TestCase):
    def test_no_backend_module_imports_the_removed_board_modules(self):
        checked = 0
        for root, _dirs, files in os.walk(BACKEND_PACKAGE):
            for name in sorted(files):
                if not name.endswith(".py"):
                    continue
                path = os.path.join(root, name)
                with open(path, encoding="utf-8") as f:
                    tree = ast.parse(f.read(), filename=path)
                bad = REMOVED_MODULES & set(_imports(tree))
                self.assertEqual(bad, set(), f"{path} imports {sorted(bad)}")
                checked += 1
        self.assertGreater(checked, 20)

    def test_the_client_entry_modules_import(self):
        import importlib
        for name in ("agent_studio.coordinator", "agent_studio.dispatch", "agent_studio.queries",
                     "agent_studio.serve", "agent_studio.cli"):
            self.assertTrue(importlib.import_module(name), name)

    def test_dispatch_has_only_the_generic_board_commands(self):
        """S06 removed every P03 board command; S07 added back the generic ticket.add/move/show/list/depend
        and board.show. The P03 scheduler and operator commands stay gone."""
        self.assertNotIn("debug.ticket_worktree", dispatch.COMMANDS)
        board_commands = sorted(n for n in dispatch.COMMANDS if n.startswith("board."))
        self.assertEqual(board_commands, ["board.resume", "board.show"])
        self.assertEqual(sorted(n for n in dispatch.COMMANDS if n.startswith("ticket.")),
                         ["ticket.add", "ticket.depend", "ticket.list", "ticket.move", "ticket.show"])
        self.assertEqual(sorted(n for n in coordinator.HANDLERS if n.startswith(("ticket.", "board."))),
                         ["board.resume", "ticket.add", "ticket.depend", "ticket.move"])

    def test_board_resume_is_still_dispatched_and_validated(self):
        ws = tempfile.mkdtemp()
        self.addCleanup(os.rmdir, ws)
        clean = dispatch._validate_board_resume({"workspace": ws, "all": True})
        self.assertEqual(clean, {"workspace": os.path.realpath(ws), "all": True})
        clean = dispatch._validate_board_resume({"workspace": ws, "agentId": "1" * 8 + "-0000-4000-8000-" + "1" * 12})
        self.assertEqual(clean["all"], False)

    def test_no_board_workflow_or_prompt_is_listed(self):
        listed = workflowdef.list_definitions(tempfile.mkdtemp(), workflow.BUILTIN_DIR)
        self.assertEqual([d["name"] for d in listed], ["developer-reviewer"])
        for root, _dirs, files in os.walk(workflow.BUILTIN_DIR):
            for name in files:
                self.assertFalse(name.startswith("board-"), os.path.join(root, name))


class RunWorkspaceRules(unittest.TestCase):
    """task.direct / workflow.start accept only the team's workspace (§F); nothing is written otherwise."""

    def setUp(self):
        self.ws = make_repo()
        self.addCleanup(helpers.reset_repo, self.ws)
        self.conn, self.store = fresh()
        self.ctx = {"stateDir": tempfile.mkdtemp(), "debug": True}
        with self.store.transaction() as tx:
            self.team = tx.create("team", {"name": "t", "workspace": self.ws})
            tx.transition("team", self.team, "running")
            self.dev = tx.create("agent", {"team_id": self.team, "ordinal": 0, "provider_id": "fake",
                                           "role": "Developer", "display_name": "dev", "pane_state": "alive"})
            self.rev = tx.create("agent", {"team_id": self.team, "ordinal": 1, "provider_id": "fake",
                                           "role": "Reviewer", "display_name": "rev", "pane_state": "alive"})
            for agent in (self.dev, self.rev):
                tx.transition("agent", agent, "idle")

    def counts(self):
        return tuple(self.conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
                     for t in ("tasks", "assignments", "workflow_runs", "events"))

    def test_task_direct_refuses_another_workspace_and_writes_nothing(self):
        before = self.counts()
        with self.assertRaises(AsError) as caught:
            with self.store.transaction() as tx:
                tasks.task_direct(tx, {"teamId": self.team, "agentId": self.dev, "policy": "read_only",
                                       "text": "x", "workspace": self.ws + "-worktree"}, self.ctx)
        self.assertEqual(caught.exception.code, "WORKTREE_NOT_REGISTERED")
        self.assertEqual(caught.exception.data, {"workspace": os.path.realpath(self.ws + "-worktree")})
        self.assertEqual(self.counts(), before)

    def test_task_direct_accepts_the_teams_workspace(self):
        with self.store.transaction() as tx:
            receipt = tasks.task_direct(tx, {"teamId": self.team, "agentId": self.dev, "policy": "read_only",
                                             "text": "x", "workspace": self.ws}, self.ctx)
        self.assertEqual(receipt["receipt"], "accepted")
        row = self.conn.execute("SELECT workspace FROM tasks WHERE id = ?", (receipt["taskId"],)).fetchone()
        self.assertEqual(row["workspace"], self.ws)

    def test_workflow_start_refuses_another_workspace_and_writes_nothing(self):
        before = self.counts()
        for args in ({"definition": "developer-reviewer", "text": "x"},
                     {"developerAgentId": self.dev, "reviewerAgentId": self.rev, "text": "x"}):
            with self.subTest(form=sorted(args)):
                with self.assertRaises(AsError) as caught:
                    with self.store.transaction() as tx:
                        workflow.start(tx, dict(args, teamId=self.team, workspace="/somewhere/else"), self.ctx)
                self.assertEqual(caught.exception.code, "WORKTREE_NOT_REGISTERED")
                self.assertEqual(self.counts(), before)

    def test_workflow_start_accepts_the_teams_workspace(self):
        with self.store.transaction() as tx:
            receipt = workflow.start(tx, {"teamId": self.team, "definition": "developer-reviewer", "text": "x",
                                          "workspace": self.ws}, self.ctx)
        self.assertEqual(receipt["receipt"], "accepted")
        row = self.conn.execute("SELECT workspace FROM tasks WHERE id = ?", (receipt["taskId"],)).fetchone()
        self.assertEqual(row["workspace"], self.ws)


if __name__ == "__main__":
    unittest.main()
