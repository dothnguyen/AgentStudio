import json
import os
import tempfile
import unittest
from unittest import mock

from tests import helpers  # noqa: F401
from agent_studio import board, board_scheduler, teams, tickets, workflow, workflowdef
from agent_studio.protocol import AsError
from tests.unit.test_p03_s01_tickets import fresh

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
EXAMPLE = os.path.join(ROOT, "phases", "phase-03", "examples", "team-two-devs.json")


class RosterNameTests(unittest.TestCase):
    def test_two_developers_with_display_names_are_accepted(self):
        roster = teams.validate_roster({"roster": [
            {"providerId": "claude", "role": "Developer", "displayName": "dev-1"},
            {"providerId": "claude", "role": "Developer", "displayName": "dev-2"}]}, allow_fake=False)
        self.assertEqual([m["displayName"] for m in roster], ["dev-1", "dev-2"])

    def test_team_json_name_key_is_the_display_name(self):
        roster = teams.validate_roster({"roster": [
            {"providerId": "claude", "role": "Developer", "name": "alpha"},
            {"providerId": "claude", "role": "Developer", "displayName": "beta", "name": "ignored"},
            {"providerId": "claude", "role": "Developer"}]}, allow_fake=False)
        self.assertEqual([m["displayName"] for m in roster], ["alpha", "beta", "Developer-3"])

    def test_duplicate_names_are_refused_with_indexes(self):
        with self.assertRaises(AsError) as raised:
            teams.validate_roster({"roster": [
                {"providerId": "claude", "role": "TeamLead", "name": "x"},
                {"providerId": "claude", "role": "Developer", "name": "dev"},
                {"providerId": "claude", "role": "QA", "displayName": " DEV "}]}, allow_fake=False)
        self.assertEqual(raised.exception.code, teams.TEAM_CONFIG_INVALID)
        self.assertEqual(raised.exception.data["indexes"], [1, 2])
        self.assertEqual(raised.exception.data["name"], "DEV")

    def test_team_start_fails_before_probe_tmux_or_rows(self):
        conn, store = fresh()
        try:
            tmux = mock.Mock()
            roster = [{"providerId": "claude", "role": "Developer", "name": "dev"},
                      {"providerId": "claude", "role": "Developer", "name": " DEV "}]
            with mock.patch.object(teams.providers, "probe_many") as probe, \
                    mock.patch.object(teams.os, "access", return_value=True):
                with self.assertRaises(AsError) as raised:
                    with store.transaction() as tx:
                        teams.team_start(tx, {"workspace": "/tmp", "roster": roster},
                                         {"debug": False, "stateDir": "/tmp", "tmux": tmux})
            self.assertEqual(raised.exception.code, teams.TEAM_CONFIG_INVALID)
            probe.assert_not_called()
            self.assertEqual(tmux.mock_calls, [])
            for table in ("teams", "agents"):
                self.assertEqual(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0], 0)
        finally:
            conn.close()

    def test_example_roster_is_valid_with_two_distinct_developers(self):
        with open(EXAMPLE, encoding="utf-8") as f:
            data = json.load(f)
        self.assertEqual(data["version"], 1)
        roster = teams.validate_roster({"roster": data["agents"]}, allow_fake=False)
        devs = [m for m in roster if m["role"] == "Developer"]
        self.assertEqual(len(devs), 2)
        self.assertEqual(len({m["displayName"] for m in devs}), 2)


def add_agent(tx, team, ordinal, role, name):
    agent = tx.create("agent", {"team_id": team, "ordinal": ordinal, "provider_id": "fake", "role": role,
                                "display_name": name})
    tx.conn.execute("UPDATE agents SET availability = 'idle', pane_state = 'alive' WHERE id = ?", (agent,))
    return agent


class BindingTests(unittest.TestCase):
    def setUp(self):
        self.conn, self.store = fresh()
        with self.store.transaction() as tx:
            self.team = tx.create("team", {"name": "t", "workspace": "/w"})
            tx.transition("team", self.team, "running")
            self.lead = add_agent(tx, self.team, 0, "TeamLead", "lead")
            self.dev1 = add_agent(tx, self.team, 1, "Developer", "dev-1")
            self.dev2 = add_agent(tx, self.team, 2, "Developer", "dev-2")
            self.qa = add_agent(tx, self.team, 3, "QA", "qa")
        self.definition = workflowdef.load(os.path.realpath(ROOT), "story-delivery", workflow.BUILTIN_DIR)

    def tearDown(self): self.conn.close()

    def bind(self, overrides):
        with self.store.transaction() as tx:
            return workflow.bind_roles(tx, tx.get("team", self.team), self.definition, overrides, {}, check_providers=False)

    def test_bind_roles_without_override_is_ambiguous_for_two_developers(self):
        with self.assertRaises(AsError) as raised:
            self.bind({})
        self.assertEqual(raised.exception.code, workflow.ROLE_AMBIGUOUS)
        self.assertEqual(raised.exception.data["agentIds"], [self.dev1, self.dev2])

    def test_bind_roles_with_override_binds_second_developer(self):
        bound = self.bind({"Developer": self.dev2})
        self.assertEqual({r: a["id"] for r, a in bound.items()},
                         {"TeamLead": self.lead, "Developer": self.dev2, "QA": self.qa})

    def test_board_start_binds_the_claiming_developer(self):
        ws = os.path.realpath(helpers.make_repo())
        state_dir = tempfile.mkdtemp()
        config = {"baseBranch": "main", "leaseSeconds": 60,
                  "columns": {"develop": {"role": "Developer", "definition": "board-develop"}}}
        with self.store.transaction() as tx:
            tx.conn.execute("UPDATE teams SET workspace = ? WHERE id = ?", (ws, self.team))
            ticket = tickets.create(tx, ws, "story", {"title": "x"})
            tx.conn.execute("UPDATE tickets SET status = 'in_dev', worktree_path = ?, branch = 'ticket/T-001', "
                            "assignee_agent_id = ? WHERE id = ?", (ws, self.dev2, ticket["id"]))
            ticket = tx.get("ticket", ticket["id"])
            result = board.start_claimed(tx, ticket, tx.get("agent", self.dev2), config,
                                         {"stateDir": state_dir, "debug": True})
        run = self.conn.execute("SELECT * FROM workflow_runs WHERE id = ?", (result["workflowRunId"],)).fetchone()
        self.assertEqual(json.loads(run["bindings_json"])["Developer"], self.dev2)
        self.assertEqual(run["current_agent_id"], self.dev2)
        stage = self.conn.execute("SELECT agent_id, stage FROM stage_attempts WHERE workflow_run_id = ?",
                                  (run["id"],)).fetchall()
        self.assertEqual([r["agent_id"] for r in stage], [self.dev2])
        self.assertEqual(self.conn.execute("SELECT run_id FROM tickets WHERE id = ?", (ticket["id"],)).fetchone()[0],
                         run["id"])


class SchedulerTwoDevelopersTests(unittest.TestCase):
    def setUp(self):
        self.conn, self.store = fresh()
        self.workspace = "/tick"
        config = {"baseBranch": "main", "maxParallelDev": 2, "columns": {
            "unpack": {"role": "Owner"}, "triage": {"role": "Lead"}, "refine": {"role": "Lead"},
            "develop": {"role": "Developer"}, "test": {"role": "QA"}, "review": {"role": "Lead"}}}
        with self.store.transaction() as tx:
            self.team = tx.create("team", {"name": "t", "workspace": self.workspace})
            tx.transition("team", self.team, "running")
            self.dev1 = add_agent(tx, self.team, 0, "Developer", "dev-1")
            self.dev2 = add_agent(tx, self.team, 1, "Developer", "dev-2")
            tx.conn.execute("UPDATE agents SET pane_state = 'unknown' WHERE team_id = ?", (self.team,))
        self.conn.execute("INSERT INTO board_state (workspace,status,reason,config_json,updated_at) VALUES (?,?,NULL,?,'n')",
                          (self.workspace, "running", json.dumps(config)))

    def tearDown(self): self.conn.close()

    def ready(self, n):
        rows = []
        for i in range(n):
            with self.store.transaction() as tx:
                row = tickets.create(tx, self.workspace, "story", {"title": f"t{i}"})
                tx.conn.execute("UPDATE tickets SET status = 'ready_dev' WHERE id = ?", (row["id"],))
                rows.append(row)
        return rows

    def claim_stub(self, store, workspace, key, agent_id, ctx, config=None):
        with store.transaction() as tx:
            row = tx.conn.execute("SELECT * FROM tickets WHERE workspace = ? AND key = ?", (workspace, key)).fetchone()
            tx.conn.execute("UPDATE tickets SET status = 'in_dev', assignee_agent_id = ? WHERE id = ?",
                            (agent_id, row["id"]))
        return {}

    def test_one_tick_claims_one_ticket_per_developer_exactly_once(self):
        self.ready(2)
        with mock.patch("agent_studio.board_scheduler.board.claim_and_start", side_effect=self.claim_stub) as start:
            board_scheduler.tick(self.store, {"stateDir": "/tmp"})
        calls = [(c.args[2], c.args[3]) for c in start.call_args_list]
        self.assertEqual(sorted(a for _, a in calls), sorted([self.dev1, self.dev2]))
        self.assertEqual(len({k for k, _ in calls}), 2)
        self.assertEqual(calls[0][1], self.dev1)  # ordinal order

    def test_developer_with_active_assignment_is_skipped(self):
        self.ready(2)
        busy = self.dev1
        with mock.patch("agent_studio.board_scheduler.tasks._active_for_agent",
                        side_effect=lambda tx, agent_id: {"id": "a", "status": "running"} if agent_id == busy else None), \
                mock.patch("agent_studio.board_scheduler.board.claim_and_start", side_effect=self.claim_stub) as start:
            board_scheduler.tick(self.store, {"stateDir": "/tmp"})
        self.assertEqual([c.args[3] for c in start.call_args_list], [self.dev2])
