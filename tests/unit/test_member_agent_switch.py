import unittest
from types import SimpleNamespace
from unittest.mock import patch

from tests import helpers  # noqa: F401
from tests.helpers import fresh
from tests.unit.test_p04_s02_team_definitions import Base
from agent_studio import agentcatalog, dispatch, teamcli, teamdefs, teams
from agent_studio.protocol import AsError


class MemberAgentSwitchTests(Base):
    def setUp(self):
        super().setUp()
        self.roles()
        self.write("agents.json", {"version": 1, "agents": [
            {"id": "first", "name": "First", "provider": "fake"},
            {"id": "second", "name": "Second", "provider": "fake"}]})
        self.put_team({"id": "t", "name": "Team", "members": [
            {"id": "dev", "name": "Dev", "role": "developer", "agents": ["first", "second"]}]})
        self.conn, self.store = fresh()
        self.addCleanup(self.conn.close)
        with self.store.transaction() as tx:
            self.team = tx.create("team", {"name": "Team", "workspace": self.ws, "def_id": "t"})
            tx.transition("team", self.team, "running")
            self.agent = tx.create("agent", {"team_id": self.team, "ordinal": 0, "provider_id": "fake",
                                            "role": "developer", "display_name": "Dev", "member_id": "dev",
                                            "pane_state": "alive", "active_catalog_agent": "first"})
            tx.transition("agent", self.agent, "idle")
        self.args = {"workspace": self.ws, "teamDefId": "t", "memberId": "dev", "agent": "second"}

    def test_catalog_choices_validate_and_prevent_deletion(self):
        self.assertEqual(teamdefs.validate_team(self.ws, "t")["problems"], [])
        self.assertEqual(teamdefs.check_team(self.ws, "t")["roster"][0]["agents"], ["first", "second"])
        with self.assertRaises(AsError) as caught:
            agentcatalog.delete_agent(self.ws, "second")
        self.assertEqual(caught.exception.code, "AGENT_IN_USE")

    def test_edit_choices_through_team_definition_api(self):
        response = dispatch._teamdef_member_update({"workspace": self.ws, "teamDefId": "t", "memberId": "dev",
                                                    "agents": ["second", "first"]}, {})
        self.assertEqual(response["member"]["agents"], ["second", "first"])
        self.assertEqual(teamdefs.check_team(self.ws, "t")["roster"][0]["provider"], "fake")
        with self.assertRaises(AsError):
            dispatch._teamdef_member_update({"workspace": self.ws, "teamDefId": "t", "memberId": "dev",
                                             "agents": ["second", "second"]}, {})

    @patch("agent_studio.providers.probe_many", return_value={"fake": {"available": True}})
    def test_switch_quota_limited_member_and_record_event(self, probe):
        with self.store.transaction() as tx:
            tx.transition("agent", self.agent, "busy")
            tx.transition("agent", self.agent, "limit_reached", set_values={"limit_reset_at": "2030-01-01"})
            result = teams.switch_member_agent(tx, self.args, {"debug": True})
        self.assertEqual(result["activeAgent"], "second")
        row = self.conn.execute("SELECT availability, active_catalog_agent, limit_reset_at FROM agents WHERE id = ?",
                                (self.agent,)).fetchone()
        self.assertEqual(tuple(row), ("idle", "second", None))
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM events WHERE name = 'agent.option_switched'").fetchone()[0], 1)

    def test_busy_member_is_not_switched(self):
        with self.store.transaction() as tx:
            tx.transition("agent", self.agent, "busy")
            with self.assertRaises(AsError):
                teams.switch_member_agent(tx, self.args, {"debug": True})
        row = self.conn.execute("SELECT availability, active_catalog_agent FROM agents WHERE id = ?", (self.agent,)).fetchone()
        self.assertEqual(tuple(row), ("busy", "first"))

    @patch("agent_studio.providers.probe_many", return_value={"fake": {"available": True}})
    def test_quota_failover_and_all_options_exhausted(self, probe):
        with self.store.transaction() as tx:
            tx.transition("agent", self.agent, "busy")
            tx.transition("agent", self.agent, "limit_reached")
            teams.handle_quota_limit(tx, self.agent, None, {"debug": True})
        row = dict(self.conn.execute("SELECT * FROM agents WHERE id = ?", (self.agent,)).fetchone())
        self.assertEqual((row["active_catalog_agent"], row["availability"]), ("second", "idle"))
        self.assertEqual(teams.quota_holds(row), {"first": None})
        with self.store.transaction() as tx:
            tx.transition("agent", self.agent, "busy")
            tx.transition("agent", self.agent, "limit_reached")
            teams.handle_quota_limit(tx, self.agent, None, {"debug": True})
        row = dict(self.conn.execute("SELECT * FROM agents WHERE id = ?", (self.agent,)).fetchone())
        self.assertEqual((row["active_catalog_agent"], row["availability"]), ("second", "limit_reached"))
        self.assertEqual(teams.quota_holds(row), {"first": None, "second": None})
        with self.store.transaction() as tx:
            with self.assertRaises(AsError):
                teams.switch_member_agent(tx, dict(self.args, agent="first"), {"debug": True})

    @patch("agent_studio.providers.probe_many", return_value={"fake": {"available": True}})
    def test_expired_backup_quota_reactivates_exhausted_member(self, probe):
        with self.store.transaction() as tx:
            tx.transition("agent", self.agent, "limit_reached", set_values={"quota_holds_json": {
                "first": None, "second": "2000-01-01T00:00:00Z"}})
        teams.recover_expired_quotas(self.store, {"debug": True})
        agent = dict(self.conn.execute("SELECT * FROM agents WHERE id = ?", (self.agent,)).fetchone())
        self.assertEqual((agent["active_catalog_agent"], agent["availability"]), ("second", "idle"))
        self.assertEqual(teams.quota_holds(agent), {"first": None})

    @patch("agent_studio.teamcli._write_call")
    @patch("builtins.input", return_value="no")
    @patch("agent_studio.teamcli.sys.stdin.isatty", return_value=True)
    @patch("agent_studio.teamcli._running_team")
    @patch("agent_studio.cli._team_workspace", return_value="/workspace")
    def test_declining_cancellation_does_not_send_a_switch(self, workspace, running, tty, answer, write):
        running.return_value = ({"teamDefId": "t"}, [{"memberId": "dev", "agentId": self.agent,
                                                       "name": "Dev", "assignment": {"id": "assignment"}}])
        result, _ = teamcli._switch_agent(SimpleNamespace(team="t", member="dev", agent="second",
                                                          cancel_active=False))
        self.assertFalse(result["switched"])
        write.assert_not_called()
