"""P03-S07's merge boundary, exercised with a real local git repository."""
import json
import os
import shutil
import sqlite3
import subprocess
import tempfile
import unittest

from tests import helpers  # noqa: F401
from agent_studio import board, state, tickets, worktrees
from agent_studio.store import Store
from tests.helpers import Sandbox, key, make_repo, req, wait_until


def git(path, *args):
    return subprocess.run(["git", "-C", path, *args], check=True, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.strip()


class MergeIntegration(unittest.TestCase):
    def setUp(self):
        self.paths = []

    def tearDown(self):
        for path in self.paths:
            shutil.rmtree(path, ignore_errors=True)

    def fixture(self, story="stories/example.md"):
        workspace = make_repo()
        state_dir = tempfile.mkdtemp()
        self.paths.extend((workspace, state_dir))
        os.makedirs(os.path.join(workspace, os.path.dirname(story)), exist_ok=True)
        with open(os.path.join(workspace, story), "w", encoding="utf-8") as f:
            f.write("# Example\nStatus: To Do\n")
        base = git(workspace, "symbolic-ref", "--short", "HEAD")
        with open(os.path.join(workspace, ".agent-studio", "board.json"), "w", encoding="utf-8") as f:
            json.dump({"baseBranch": base}, f)
        git(workspace, "add", "-A")
        git(workspace, "commit", "-m", "fixture")
        conn = state.connect(os.path.join(state_dir, "state.db"), role="coordinator", create=True)
        state.migrate(conn, os.path.join(state_dir, "state.db"))
        return workspace, state_dir, conn, Store(conn), base, story

    def ready(self, store, workspace, state_dir, base, story, *, title="Example", path="change.txt", text="change\n",
              parent=None, depends_on=()):
        with store.transaction() as tx:
            ticket = tickets.create(tx, workspace, "story", {"title": title, "story_path": story,
                                                                "parent_ticket_id": parent})
            if depends_on:
                tickets.add_deps(tx, ticket, list(depends_on))
            for status in ("refining", "ready_dev", "in_dev", "ready_test", "in_test", "ready_review", "in_review", "ready_merge"):
                ticket = tickets.move(tx, ticket, status, "coordinator")
            created = worktrees.create(workspace, ticket["key"], worktrees.slug(ticket["title"]), base, state_dir=state_dir)
            ticket = tickets.record_worktree(tx, ticket, created)
            with open(os.path.join(created["path"], path), "w", encoding="utf-8") as f:
                f.write(text)
            git(created["path"], "add", path)
            git(created["path"], "commit", "-m", "branch change")
        return ticket

    @staticmethod
    def event_count(conn, ticket, name, payload=None):
        rows = conn.execute("SELECT payload_json FROM ticket_events WHERE ticket_id = ? AND name = ?", (ticket["id"], name)).fetchall()
        if payload is None:
            return len(rows)
        return sum(json.loads(row[0]) == payload for row in rows)

    def test_ready_ticket_squash_merges_story_and_removes_worktree(self):
        workspace, state_dir, conn, store, base, story = self.fixture()
        ticket = self.ready(store, workspace, state_dir, base, story)
        with store.transaction() as tx:
            board._note(tx, ticket, "ticket.outcome_applied", {"to": "ready_merge", "commitMessage": "Lead message\n\nTicket: T-001"})
        board.merge_ready(store, {"stateDir": state_dir})
        row = conn.execute("SELECT status, merged_commit, head_commit, worktree_path FROM tickets").fetchone()
        self.assertEqual(row["status"], "merged")
        self.assertTrue(row["merged_commit"])
        self.assertTrue(row["head_commit"])
        self.assertFalse(os.path.exists(row["worktree_path"]))
        self.assertEqual(git(workspace, "log", "-1", "--format=%B"), "Lead message\n\nTicket: T-001")
        self.assertIn("Status: Done (", open(os.path.join(workspace, story), encoding="utf-8").read())
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM board_locks").fetchone()[0], 0)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM ticket_events WHERE name = 'ticket.merged'").fetchone()[0], 1)

    def test_merge_holds_once_until_dirty_busy_or_wrong_branch_clears(self):
        for cause in ("dirty", "busy", "branch"):
            with self.subTest(cause=cause):
                workspace, state_dir, conn, store, base, story = self.fixture()
                ticket = self.ready(store, workspace, state_dir, base, story)
                if cause == "dirty":
                    with open(os.path.join(workspace, "untracked"), "w", encoding="utf-8") as f:
                        f.write("x")
                    clear = lambda: os.unlink(os.path.join(workspace, "untracked"))
                    reason = "MAIN_CHECKOUT_DIRTY"
                elif cause == "busy":
                    with store.transaction() as tx:
                        team_id = tx.create("team", {"name": "merge-holder", "workspace": workspace})
                        tx.transition("team", team_id, "running")
                        agent_id = tx.create("agent", {"team_id": team_id, "ordinal": 0, "provider_id": "codex",
                                                          "role": "Developer", "display_name": "holder", "pane_state": "alive"})
                        tx.transition("agent", agent_id, "idle")
                        task_id = tx.create("task", {"team_id": team_id, "origin": "direct", "workspace": workspace,
                                                        "goal": "hold main checkout"})
                        tx.create("assignment", {"team_id": team_id, "task_id": task_id, "agent_id": agent_id,
                                                   "attempt": 1, "policy": "workspace_write", "provider_id": "codex"})
                    clear = lambda: conn.execute("UPDATE assignments SET status = 'cancelled'").connection.commit()
                    reason = "MAIN_CHECKOUT_BUSY"
                else:
                    git(workspace, "checkout", "-qb", "other")
                    clear = lambda: git(workspace, "checkout", "-q", base)
                    reason = "MAIN_CHECKOUT_WRONG_BRANCH"
                board.merge_ready(store, {"stateDir": state_dir})
                board.merge_ready(store, {"stateDir": state_dir})
                self.assertEqual(self.event_count(conn, ticket, "board.held", {"column": "merge", "reason": reason}), 1)
                self.assertEqual(conn.execute("SELECT status FROM tickets WHERE id = ?", (ticket["id"],)).fetchone()[0], "ready_merge")
                clear()
                board.merge_ready(store, {"stateDir": state_dir})
                self.assertEqual(conn.execute("SELECT status FROM tickets WHERE id = ?", (ticket["id"],)).fetchone()[0], "merged")

    def test_conflict_returns_ticket_with_findings_and_clean_main(self):
        workspace, state_dir, conn, store, base, story = self.fixture()
        first = self.ready(store, workspace, state_dir, base, story, path="shared.txt", text="first\n")
        second = self.ready(store, workspace, state_dir, base, story, path="shared.txt", text="second\n")
        board.merge_ready(store, {"stateDir": state_dir})
        merged_head = git(workspace, "rev-parse", "HEAD")
        board.merge_ready(store, {"stateDir": state_dir})
        row = conn.execute("SELECT status, review_rounds, findings_json FROM tickets WHERE id = ?", (second["id"],)).fetchone()
        self.assertEqual((row["status"], row["review_rounds"]), ("changes_requested", 1))
        self.assertEqual(json.loads(row["findings_json"]), ["MERGE_CONFLICT: shared.txt"])
        self.assertEqual(self.event_count(conn, second, "ticket.merge_conflict"), 1)
        self.assertEqual(git(workspace, "rev-parse", "HEAD"), merged_head)
        self.assertEqual(git(workspace, "status", "--porcelain"), "")

    def test_recover_merge_handles_both_persistent_crash_states(self):
        for committed in (False, True):
            with self.subTest(after_merge_git_commit=committed):
                workspace, state_dir, conn, store, base, story = self.fixture()
                ticket = self.ready(store, workspace, state_dir, base, story)
                old_head = git(workspace, "rev-parse", "HEAD")
                with store.transaction() as tx:
                    tx.conn.execute("INSERT INTO board_locks (workspace, name, ticket_id, created_at) VALUES (?, 'merge', ?, 'now')",
                                    (workspace, ticket["id"]))
                subprocess.run(["git", "-C", workspace, "merge", "--squash", ticket["branch"]], check=True)
                if committed:
                    git(workspace, "commit", "--allow-empty", "-m", ticket["key"] + ": Example\n\nTicket: " + ticket["key"])
                board.recover_merge(store, {"stateDir": state_dir})
                row = conn.execute("SELECT status FROM tickets WHERE id = ?", (ticket["id"],)).fetchone()[0]
                self.assertEqual(row, "merged" if committed else "ready_merge")
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM board_locks").fetchone()[0], 0)
                if not committed:
                    self.assertEqual(git(workspace, "rev-parse", "HEAD"), old_head)
                    self.assertEqual(git(workspace, "status", "--porcelain"), "")
                    board.merge_ready(store, {"stateDir": state_dir})
                    self.assertEqual(conn.execute("SELECT status FROM tickets WHERE id = ?", (ticket["id"],)).fetchone()[0], "merged")

    def test_dependency_default_message_and_parent_completion(self):
        workspace, state_dir, conn, store, base, story = self.fixture()
        with store.transaction() as tx:
            parent = tickets.create(tx, workspace, "feature", {"title": "Feature"})
            parent = tickets.move(tx, parent, "unpacking", "coordinator")
            parent = tickets.move(tx, parent, "unpacked", "coordinator")
        first = self.ready(store, workspace, state_dir, base, story, title="One", parent=parent["id"])
        second = self.ready(store, workspace, state_dir, base, story, title="Two", parent=parent["id"], depends_on=(first["key"],))
        with store.transaction() as tx:
            self.assertFalse(tickets.deps_merged(tx, second))
        board.merge_ready(store, {"stateDir": state_dir})
        with store.transaction() as tx:
            self.assertTrue(tickets.deps_merged(tx, second))
        self.assertEqual(git(workspace, "log", "-1", "--format=%B"), first["key"] + ": One\n\nTicket: " + first["key"])
        self.assertEqual(conn.execute("SELECT status FROM tickets WHERE id = ?", (parent["id"],)).fetchone()[0], "unpacked")
        board.merge_ready(store, {"stateDir": state_dir})
        self.assertEqual(conn.execute("SELECT status FROM tickets WHERE id = ?", (parent["id"],)).fetchone()[0], "done")


class LiveMergeIntegration(unittest.TestCase):
    """The paths below deliberately use the debug coordinator, not board internals."""

    def setUp(self):
        self.sb = Sandbox(extra_env={"AGENT_STUDIO_TEST_FIXTURE_PROVIDERS": "codex=fake,claude=fake,agy=fake"})
        _, started, proc = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(started["ok"], proc.stderr)
        self.workspace = make_repo(check_for="shared.txt")
        self.story = "stories/example.md"
        os.makedirs(os.path.join(self.workspace, "stories"))
        with open(os.path.join(self.workspace, self.story), "w", encoding="utf-8") as f:
            f.write("# Example\nStatus: To Do\n")
        self.base = git(self.workspace, "symbolic-ref", "--short", "HEAD")
        with open(os.path.join(self.workspace, ".agent-studio", "board.json"), "w", encoding="utf-8") as f:
            json.dump({"baseBranch": self.base}, f)
        git(self.workspace, "add", "-A")
        git(self.workspace, "commit", "-m", "merge fixture")
        roster = [{"providerId": "codex", "role": "TeamLead"}, {"providerId": "claude", "role": "Developer"},
                  {"providerId": "agy", "role": "QA"}]
        _, response, _ = self.sb.request(req("team.start", {"workspace": self.workspace, "roster": roster}, idempotencyKey=key()))
        self.assertTrue(response["ok"], response)
        self.agents = {a["role"]: a["agentId"] for a in response["data"]["agents"]}

    def tearDown(self):
        self.sb.cleanup()

    def create(self, title="Example", depends=()):
        args = {"workspace": self.workspace, "storyPath": self.story, "title": title}
        if depends:
            args["dependsOn"] = list(depends)
        _, response, _ = self.sb.request(req("ticket.create", args, idempotencyKey=key()))
        self.assertTrue(response["ok"], response)
        return response["data"]["ticket"]

    def move(self, ticket, status):
        _, response, _ = self.sb.request(req("ticket.move", {"workspace": self.workspace, "key": ticket["key"], "to": status},
                                             idempotencyKey=key()))
        self.assertTrue(response["ok"], response)
        return response["data"]["ticket"]

    def detail(self, ticket):
        _, response, _ = self.sb.request(req("ticket.show", {"workspace": self.workspace, "key": ticket["key"]}))
        self.assertTrue(response["ok"], response)
        return response["data"]

    def prepare_worktree(self, ticket):
        _, response, _ = self.sb.request(req("debug.ticket_worktree", {"workspace": self.workspace, "key": ticket["key"]},
                                             idempotencyKey=key()))
        self.assertTrue(response["ok"], response)
        return response["data"]["worktree"]["path"]

    def configure_fake(self, workflow_id, stage, option):
        conn = sqlite3.connect(os.path.join(self.sb.state_dir, "state.db"), timeout=10)
        try:
            config = json.loads(conn.execute("SELECT config_json FROM workflow_runs WHERE id = ?", (workflow_id,)).fetchone()[0])
            config["debugStageOptions"] = {stage: option}
            conn.execute("UPDATE workflow_runs SET config_json = ? WHERE id = ?", (json.dumps(config), workflow_id))
            for assignment_id, request in conn.execute("SELECT a.id, a.request_json FROM assignments a JOIN stage_attempts s ON s.assignment_id = a.id WHERE s.workflow_run_id = ?", (workflow_id,)):
                request = json.loads(request)
                request["providerOptions"] = option
                conn.execute("UPDATE assignments SET request_json = ? WHERE id = ?", (json.dumps(request), assignment_id))
            conn.commit()
        finally:
            conn.close()

    def start(self, ticket, role, stage, option):
        conn = sqlite3.connect(os.path.join(self.sb.state_dir, "state.db"), timeout=10)
        try:
            conn.execute("UPDATE agents SET availability = 'busy' WHERE id = ?", (self.agents[role],))
            conn.commit()
        finally:
            conn.close()
        _, response, _ = self.sb.request(req("ticket.start", {"workspace": self.workspace, "key": ticket["key"],
                                                           "agentId": self.agents[role]}, idempotencyKey=key()))
        try:
            self.assertTrue(response["ok"], response)
            self.configure_fake(response["data"]["workflowRunId"], stage, option)
        finally:
            conn = sqlite3.connect(os.path.join(self.sb.state_dir, "state.db"), timeout=10)
            try:
                conn.execute("UPDATE agents SET availability = 'idle' WHERE id = ?", (self.agents[role],))
                conn.commit()
            finally:
                conn.close()
        return response["data"]

    def wait_ticket(self, ticket, status):
        return wait_until(lambda: (d := self.detail(ticket))["ticket"]["status"] == status and
                          d["ticket"]["appliedRunId"] == d["ticket"]["runId"] and d,
                          timeout=120, message="ticket " + status)

    def ready(self, title, path, text):
        ticket = self.create(title)
        worktree = self.prepare_worktree(ticket)
        for status in ("ready_dev", "ready_test", "ready_review"):
            ticket = self.move(ticket, status)
        with open(os.path.join(worktree, path), "w", encoding="utf-8") as f:
            f.write(text)
        git(worktree, "add", path)
        git(worktree, "commit", "-m", "branch change")
        # Operators cannot enter ready_merge; the applier does after a review.  Set it as a fixture.
        conn = sqlite3.connect(os.path.join(self.sb.state_dir, "state.db"), timeout=10)
        try:
            conn.execute("UPDATE tickets SET status = 'ready_merge' WHERE id = ?", (ticket["id"],))
            conn.commit()
        finally:
            conn.close()
        return self.detail(ticket)["ticket"]

    def offline_ready(self, title="Crash test"):
        """Build a ready ticket while its coordinator is deliberately stopped."""
        conn = state.connect(os.path.join(self.sb.state_dir, "state.db"), role="coordinator", create=True)
        store = Store(conn)
        try:
            with store.transaction() as tx:
                ticket = tickets.create(tx, self.workspace, "story", {"title": title, "story_path": self.story})
                for status in ("refining", "ready_dev", "in_dev", "ready_test", "in_test", "ready_review", "in_review", "ready_merge"):
                    ticket = tickets.move(tx, ticket, status, "coordinator")
                created = worktrees.create(self.workspace, ticket["key"], worktrees.slug(ticket["title"]), self.base,
                                           state_dir=self.sb.state_dir)
                ticket = tickets.record_worktree(tx, ticket, created)
                crash_file = "crash-" + worktrees.slug(title) + ".txt"
                with open(os.path.join(created["path"], crash_file), "w", encoding="utf-8") as f:
                    f.write("crash fixture\n")
                git(created["path"], "add", crash_file)
                git(created["path"], "commit", "-m", "branch change")
            return ticket
        finally:
            conn.close()

    def coordinator_running(self):
        _, health, _ = self.sb.run("health")
        return health and health["ok"] and health["data"]["coordinator"]["running"]

    def offline_busy_main(self):
        conn = state.connect(os.path.join(self.sb.state_dir, "state.db"), role="coordinator", create=True)
        store = Store(conn)
        try:
            with store.transaction() as tx:
                team = tx.create("team", {"name": "recovery-holder", "workspace": self.workspace})
                tx.transition("team", team, "running")
                agent = tx.create("agent", {"team_id": team, "ordinal": 0, "provider_id": "codex", "role": "Developer",
                                              "display_name": "holder", "pane_state": "alive"})
                tx.transition("agent", agent, "idle")
                task = tx.create("task", {"team_id": team, "origin": "direct", "workspace": self.workspace,
                                           "goal": "hold main checkout"})
                return tx.create("assignment", {"team_id": team, "task_id": task, "agent_id": agent, "attempt": 1,
                                                 "policy": "workspace_write", "provider_id": "codex"})
        finally:
            conn.close()

    def test_review_pass_extracts_commit_block_and_defaults_before_merge(self):
        for final, expected, defaulted in (("lead notes\n```commit\nCustom merge\n```", "Custom merge", False),
                                           ("lead notes", None, True)):
            with self.subTest(defaulted=defaulted):
                ticket = self.create("Review title")
                self.prepare_worktree(ticket)
                ticket = self.move(ticket, "ready_review")
                # Hold merging long enough to inspect the real review outcome event.
                with open(os.path.join(self.workspace, "untracked"), "w", encoding="utf-8") as f:
                    f.write("hold\n")
                self.start(ticket, "TeamLead", "verdict", {"scenario": "verdict_pass", "durationMs": 50,
                                                             "progressLines": 1, "finalText": final})
                detail = self.wait_ticket(ticket, "ready_merge")
                outcome = [e for e in detail["events"] if e["name"] == "ticket.outcome_applied"][-1]
                message = outcome["payload"]["commitMessage"]
                self.assertEqual(message, (expected or ticket["key"] + ": Review title") + "\n\nTicket: " + ticket["key"])
                self.assertEqual(any(e["name"] == "ticket.merge_message_defaulted" for e in detail["events"]), defaulted)
                os.unlink(os.path.join(self.workspace, "untracked"))
                merged = wait_until(lambda: self.detail(ticket)["ticket"]["status"] == "merged" and self.detail(ticket), timeout=120)
                self.assertEqual(git(self.workspace, "log", "-1", "--format=%B"), message)

    def test_conflict_next_develop_records_base_merge_markers_then_resolution(self):
        with open(os.path.join(self.workspace, "hold-conflict"), "w", encoding="utf-8") as f:
            f.write("hold\n")
        first = self.ready("First", "shared.txt", "first\n")
        second = self.ready("Second", "shared.txt", "second\n")
        os.unlink(os.path.join(self.workspace, "hold-conflict"))
        self.assertEqual(wait_until(lambda: self.detail(first)["ticket"]["status"] == "merged" and self.detail(first), timeout=120)["ticket"]["status"], "merged")
        conflicted = wait_until(lambda: self.detail(second)["ticket"]["status"] == "changes_requested" and self.detail(second), timeout=120)
        self.assertEqual((conflicted["ticket"]["reviewRounds"], conflicted["ticket"]["findings"]), (1, ["MERGE_CONFLICT: shared.txt"]))
        started = self.start(second, "Developer", "work", {"scenario": "success", "durationMs": 50, "progressLines": 1})
        self.assertEqual(git(started["workspace"], "log", "-1", "--format=%s"), second["key"] + ": merge " + self.base + " (conflicts)")
        prompt = open(self.sb.run("workflow", "show", "--workflow", started["workflowRunId"])[1]["data"]["stageAttempts"][0]["promptPath"], encoding="utf-8").read()
        self.assertIn("MERGE_CONFLICT: shared.txt", prompt)
        marker = self.wait_ticket(second, "ready_dev")
        self.assertEqual((marker["ticket"]["devRounds"], marker["ticket"]["findings"]), (1, ["MERGE_MARKERS_LEFT: shared.txt"]))
        self.start(second, "Developer", "work", {"scenario": "success", "durationMs": 50, "progressLines": 1, "writeFile": "shared.txt"})
        resolved = self.wait_ticket(second, "ready_test")
        self.assertEqual(git(resolved["ticket"]["worktreePath"], "log", "-1", "--format=%s"), second["key"] + ": develop round 1")

    def test_dependency_rejects_start_then_uses_merged_commit_as_worktree_base(self):
        with open(os.path.join(self.workspace, "hold-dependency"), "w", encoding="utf-8") as f:
            f.write("hold\n")
        first = self.ready("One", "one.txt", "one\n")
        second = self.create("Two", depends=(first["key"],))
        second = self.move(second, "ready_dev")
        _, rejected, _ = self.sb.request(req("ticket.start", {"workspace": self.workspace, "key": second["key"],
                                                           "agentId": self.agents["Developer"]}, idempotencyKey=key()))
        self.assertFalse(rejected["ok"])
        self.assertEqual(rejected["error"]["code"], "TICKET_DEPS_NOT_MERGED")
        os.unlink(os.path.join(self.workspace, "hold-dependency"))
        first_detail = wait_until(lambda: self.detail(first)["ticket"]["status"] == "merged" and self.detail(first), timeout=120)
        self.start(second, "Developer", "work", {"scenario": "success", "durationMs": 50, "progressLines": 1, "writeFile": "two.txt"})
        started = self.detail(second)["ticket"]
        self.assertEqual(git(started["worktreePath"], "rev-parse", "HEAD"), first_detail["ticket"]["mergedCommit"])

    def test_debug_restart_recovers_both_merge_crash_points(self):
        for point in ("after_merge_squash", "after_merge_git_commit"):
            with self.subTest(point=point):
                self.sb.run("coordinator", "stop")
                ticket = self.offline_ready(point)
                old_head = git(self.workspace, "rev-parse", "HEAD")
                self.sb.env["AGENT_STUDIO_TEST_CRASH_AT"] = point
                # The armed coordinator can crash before `start` reports it healthy, so `ok` is not asserted;
                # the crash marker below is the evidence.
                self.sb.run("coordinator", "start", "--enable-debug")
                wait_until(lambda: os.path.exists(os.path.join(self.sb.state_dir, "crashed-at-" + point)),
                           timeout=40, message="debug merge crash")
                wait_until(lambda: not self.coordinator_running(), timeout=40, message="coordinator exit")
                self.assertTrue(os.path.exists(os.path.join(self.sb.state_dir, "crashed-at-" + point)))
                self.sb.env.pop("AGENT_STUDIO_TEST_CRASH_AT", None)
                if point == "after_merge_squash":
                    holder = self.offline_busy_main()
                _, restarted, proc = self.sb.run("coordinator", "start", "--enable-debug")
                self.assertTrue(restarted["ok"], proc.stderr)
                if point == "after_merge_git_commit":
                    detail = wait_until(lambda: self.detail(ticket)["ticket"]["status"] == "merged" and self.detail(ticket), timeout=120)
                    self.assertEqual(git(self.workspace, "rev-list", "--count", old_head + "..HEAD"), "1")
                    self.assertEqual(sum(e["name"] == "ticket.merged" for e in detail["events"]), 1)
                    self.assertFalse(os.path.exists(detail["ticket"]["worktreePath"]))
                else:
                    detail = self.detail(ticket)
                    self.assertEqual(detail["ticket"]["status"], "ready_merge")
                    self.assertEqual(git(self.workspace, "rev-parse", "HEAD"), old_head)
                    self.assertEqual(git(self.workspace, "status", "--porcelain"), "")
                    self.assertTrue(os.path.isdir(detail["ticket"]["worktreePath"]))
                    conn = sqlite3.connect(os.path.join(self.sb.state_dir, "state.db"))
                    try:
                        conn.execute("UPDATE assignments SET status = 'cancelled' WHERE id = ?", (holder,))
                        conn.commit()
                    finally:
                        conn.close()
                    detail = wait_until(lambda: self.detail(ticket)["ticket"]["status"] == "merged" and self.detail(ticket), timeout=120)
                self.assertEqual(sum(e["name"] == "ticket.merged" for e in detail["events"]), 1)
                conn = sqlite3.connect(os.path.join(self.sb.state_dir, "state.db"))
                try:
                    self.assertEqual(conn.execute("SELECT COUNT(*) FROM board_locks").fetchone()[0], 0)
                finally:
                    conn.close()
