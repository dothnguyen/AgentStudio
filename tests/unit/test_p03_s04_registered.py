import os
import subprocess
import tempfile
import unittest

from tests import helpers  # noqa: F401
from agent_studio import cli, dispatch, inbox, tickets, worktrees
from agent_studio.protocol import AsError, BAD_REQUEST, IDEMPOTENCY_CONFLICT, WORKTREE_NOT_REGISTERED
from tests.unit.test_p03_s01_tickets import fresh


class RegisteredWorktreeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.workspace = os.path.join(self.temp.name, "repo")
        self.state = os.path.join(self.temp.name, "state")
        os.mkdir(self.workspace)
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Unit Tester")
        self.git("config", "user.email", "unit@example.invalid")
        with open(os.path.join(self.workspace, "tracked.txt"), "w", encoding="utf-8") as f:
            f.write("initial\n")
        self.git("add", "tracked.txt")
        self.git("commit", "-m", "initial")
        self.conn, self.store = fresh()
        with self.store.transaction() as tx:
            self.ticket = tickets.create(tx, self.workspace, "story", {"title": "A ticket"})
        self.created = worktrees.create(self.workspace, self.ticket["key"], worktrees.slug(self.ticket["title"]),
                                        "main", state_dir=self.state)
        with self.store.transaction() as tx:
            tickets.record_worktree(tx, self.ticket, self.created)
        row = self.conn.execute("SELECT branch, worktree_path, base_commit FROM tickets WHERE id = ?", (self.ticket["id"],)).fetchone()
        self.assertEqual(tuple(row), (self.created["branch"], self.created["path"], self.created["baseCommit"]))
        self.assertEqual(self.conn.execute("SELECT name FROM ticket_events ORDER BY id DESC LIMIT 1").fetchone()[0],
                         "ticket.worktree_created")

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.run(["git", "-C", self.workspace, *args], check=True, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE).stdout.decode().strip()

    def registered(self, path):
        with self.store.transaction() as tx:
            return tickets.registered_worktree(tx, self.workspace, path, state_dir=self.state)

    def rejected(self, path):
        with self.assertRaises(AsError) as caught:
            self.registered(path)
        self.assertEqual(caught.exception.code, WORKTREE_NOT_REGISTERED)
        self.assertEqual(caught.exception.data, {"workspace": os.path.realpath(path)})

    def test_registered_worktree_accepts_canonical_path_and_symlink(self):
        self.assertEqual(self.registered(self.created["path"]), self.created["path"])
        link = os.path.join(self.temp.name, "link")
        os.symlink(self.created["path"], link)
        self.assertEqual(self.registered(link), self.created["path"])

    def test_registered_worktree_rejects_missing_parent_plain_and_removed_worktrees(self):
        self.rejected("/tmp/x")
        self.rejected(os.path.dirname(self.workspace))
        plain = os.path.join(self.temp.name, "plain")
        self.git("worktree", "add", "-b", "plain", plain, "main")
        self.rejected(plain)
        subprocess.run(["git", "-C", self.workspace, "worktree", "remove", "--force", plain], check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        worktrees.remove(self.workspace, self.created["path"], state_dir=self.state)
        self.rejected(self.created["path"])

    def test_registered_worktree_rejects_removed_worktree_while_ticket_is_live(self):
        worktrees.remove(self.workspace, self.created["path"], state_dir=self.state)
        self.rejected(self.created["path"])

    def test_registered_worktree_rejects_cancelled_ticket(self):
        with self.store.transaction() as tx:
            tickets.cancel(tx, self.ticket, "operator")
        self.rejected(self.created["path"])


class WorkspaceArgumentTests(unittest.TestCase):
    def test_relative_workspace_is_refused_for_every_start_form(self):
        base = {"teamId": "00000000-0000-4000-8000-000000000001", "text": "task", "workspace": "relative"}
        requests = (
            (dispatch._validate_definition_start, dict(base, definition="example")),
            (dispatch._validate_workflow_start, dict(base, developerAgentId="00000000-0000-4000-8000-000000000002",
                                                     reviewerAgentId="00000000-0000-4000-8000-000000000003")),
            (dispatch._validate_task_direct, dict(base, agentId="00000000-0000-4000-8000-000000000002",
                                                   policy="read_only")),
        )
        for validator, args in requests:
            with self.subTest(validator=validator.__name__):
                with self.assertRaises(AsError) as caught:
                    validator(args)
                self.assertEqual(caught.exception.code, BAD_REQUEST)

    def test_cli_includes_workspace_only_when_given(self):
        direct = cli._human_request(["task", "direct", "--team", "team", "--agent", "agent", "--policy", "read_only",
                                     "--text", "task", "--workspace", "/worktree"])
        workflow = cli._human_request(["workflow", "start", "--team", "team", "--definition", "example",
                                       "--text", "task", "--workspace", "/worktree"])
        self.assertEqual(direct["args"]["workspace"], "/worktree")
        self.assertEqual(workflow["args"]["workspace"], "/worktree")

    def test_workspace_changes_idempotency_payload(self):
        conn, _ = fresh()
        try:
            inbox.insert_or_get(conn, "workspace-key", "task.direct", {"workspace": "/one"})
            with self.assertRaises(AsError) as caught:
                inbox.insert_or_get(conn, "workspace-key", "task.direct", {"workspace": "/two"})
            self.assertEqual(caught.exception.code, IDEMPOTENCY_CONFLICT)
        finally:
            conn.close()

