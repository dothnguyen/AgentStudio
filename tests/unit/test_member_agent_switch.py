import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from tests import helpers  # noqa: F401
from tests.helpers import fresh
from tests.unit.test_p04_s02_team_definitions import Base
from agent_studio import agentcatalog, dispatch, teamcli, teamdefs, teams, teamstatus
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
                                            "pane_state": "alive", "active_catalog_agent": "first",
                                            "configured_agents_json": ["first", "second"]})
            tx.transition("agent", self.agent, "idle")
        self.args = {"workspace": self.ws, "teamDefId": "t", "memberId": "dev", "agent": "second"}

    def status_member(self):
        return teamstatus.team_status(self.conn, self.team, self.ws, "t")["members"][0]

    def event_at(self, name):
        return self.conn.execute("SELECT at FROM events WHERE entity_id = ? AND name = ? ORDER BY seq DESC LIMIT 1",
                                 (self.agent, name)).fetchone()[0]

    def cancelled_pending_switch(self):
        with self.store.transaction() as tx:
            task = tx.create("task", {"team_id": self.team, "origin": "direct", "workspace": self.ws, "goal": "g"})
            assignment = tx.create("assignment", {"team_id": self.team, "task_id": task, "agent_id": self.agent,
                                                   "attempt": 1, "policy": "read_only", "provider_id": "fake"})
            tx.transition("assignment", assignment, "cancelled")
            tx.update("agent", self.agent, {"pending_agent": "second", "pending_assignment": assignment},
                      "agent.switch_requested", {"toAgent": "second", "assignmentId": assignment})
        return assignment

    @patch("agent_studio.providers.probe_many", return_value={"fake": {"available": True}})
    def test_completed_pending_switch_records_assignment(self, probe):
        assignment = self.cancelled_pending_switch()
        teams.complete_pending_switches(self.store, {"debug": True})
        self.assertEqual(self.status_member()["lastSwitch"], {
            "state": "completed", "requestedAgent": "second", "assignmentId": assignment,
            "code": None, "message": None, "at": self.event_at("agent.option_switched")})

    def test_failed_pending_switch_records_assignment_and_error(self):
        assignment = self.cancelled_pending_switch()
        self.write("agents.json", {"version": 1, "agents": [
            {"id": "first", "name": "First", "provider": "fake"}]})
        teams.complete_pending_switches(self.store, {"debug": True})
        payload = self.conn.execute("SELECT payload_json FROM events WHERE entity_id = ? AND name = ? ORDER BY seq DESC LIMIT 1",
                                    (self.agent, "agent.switch_failed")).fetchone()[0]
        self.assertEqual(json.loads(payload), {"toAgent": "second", "assignmentId": assignment,
                                               "code": "TEAM_CONFIG_INVALID",
                                               "message": "Agent 'second' is missing from the catalog."})
        self.assertEqual(self.status_member()["lastSwitch"], {
            "state": "failed", "requestedAgent": "second", "assignmentId": assignment,
            "code": "TEAM_CONFIG_INVALID", "message": "Agent 'second' is missing from the catalog.",
            "at": self.event_at("agent.switch_failed")})
        row = self.conn.execute("SELECT pending_agent, pending_assignment FROM agents WHERE id = ?", (self.agent,)).fetchone()
        self.assertEqual(tuple(row), (None, None))

    def test_switch_event_queries_use_entity_index_in_sequence_order(self):
        with self.store.transaction() as tx:
            for _ in range(200):
                tx.note("team", self.team, "team.test_event", {})
        queries = [
            ("SELECT * FROM events WHERE team_id = ? AND entity = 'agent' AND entity_id = ? AND name IN "
             "('agent.switch_requested', 'agent.option_switched', 'agent.switch_failed') ORDER BY seq DESC LIMIT 1",
             (self.team, self.agent)),
            ("SELECT payload_json FROM events WHERE team_id = ? AND entity = 'agent' AND entity_id = ? "
             "AND name = 'agent.switch_requested' AND seq < ? ORDER BY seq DESC LIMIT 1",
             (self.team, self.agent, 1000)),
        ]
        for query, params in queries:
            plan = " ".join(row[3] for row in self.conn.execute("EXPLAIN QUERY PLAN " + query, params))
            self.assertIn("events_by_entity", plan)
            self.assertNotIn("TEMP B-TREE", plan)

    @patch("agent_studio.providers.probe_many", return_value={"fake": {"available": True}})
    def test_running_options_are_frozen_until_restart(self, probe):
        self.write("agents.json", {"version": 1, "agents": [
            {"id": x, "name": x.title(), "provider": "fake"} for x in ("first", "second", "third")]})
        self.put_team({"id": "t", "name": "Team", "members": [
            {"id": "dev", "name": "Dev", "role": "developer", "agents": ["first", "third"]}]})
        self.assertEqual(self.status_member()["configuredAgents"], ["first", "second"])
        with self.store.transaction() as tx:
            self.assertEqual(teams.switch_member_agent(tx, self.args, {"debug": True})["activeAgent"], "second")
            with self.assertRaises(AsError) as caught:
                teams.switch_member_agent(tx, dict(self.args, agent="third"), {"debug": True})
        self.assertEqual((caught.exception.code, caught.exception.message),
                         ("BAD_REQUEST", "Agent 'third' is not configured for member 'dev'."))

    @patch("agent_studio.providers.probe_many", return_value={"fake": {"available": True}})
    def test_status_projects_completed_switch(self, probe):
        with self.store.transaction() as tx:
            teams.switch_member_agent(tx, self.args, {"debug": True})
        self.assertEqual(self.status_member()["lastSwitch"], {"state": "completed", "requestedAgent": "second",
            "assignmentId": None, "code": None, "message": None, "at": self.event_at("agent.option_switched")})

    def test_status_projects_pending_switch(self):
        with self.store.transaction() as tx:
            tx.update("agent", self.agent, {"pending_agent": "second", "pending_assignment": "assignment"},
                      "agent.switch_requested", {"toAgent": "first", "assignmentId": "old"})
        self.assertEqual(self.status_member()["lastSwitch"], {"state": "pending", "requestedAgent": "second",
            "assignmentId": "assignment", "code": None, "message": None, "at": self.event_at("agent.switch_requested")})

    def test_status_projects_failed_switch(self):
        with self.store.transaction() as tx:
            tx.update("agent", self.agent, {"pending_agent": "second", "pending_assignment": "assignment"},
                      "agent.switch_requested", {"toAgent": "second", "assignmentId": "assignment"})
            tx.update("agent", self.agent, {"pending_agent": None, "pending_assignment": None},
                      "agent.switch_failed", {"toAgent": "second", "assignmentId": "assignment", "code": "BAD_REQUEST", "message": "failed"})
        self.assertEqual(self.status_member()["lastSwitch"], {"state": "failed", "requestedAgent": "second",
            "assignmentId": "assignment", "code": "BAD_REQUEST", "message": "failed", "at": self.event_at("agent.switch_failed")})

    def test_legacy_runtime_uses_current_definition(self):
        with self.store.transaction() as tx:
            tx.update("agent", self.agent, {"configured_agents_json": None}, "agent.test_setup")
        self.put_team({"id": "t", "name": "Team", "members": [
            {"id": "dev", "name": "Dev", "role": "developer", "agents": ["first"]}]})
        self.assertIsNone(self.status_member()["configuredAgents"])
        with self.store.transaction() as tx:
            with self.assertRaises(AsError) as caught:
                teams.resume_member_agent(tx, self.args)
        self.assertEqual(caught.exception.code, "BAD_REQUEST")

    @patch("agent_studio.providers.probe_many", return_value={"fake": {"available": True}})
    def test_legacy_switch_uses_edited_definition(self, probe):
        with self.store.transaction() as tx:
            tx.update("agent", self.agent, {"configured_agents_json": None}, "agent.test_setup")
        self.write("agents.json", {"version": 1, "agents": [
            {"id": x, "name": x.title(), "provider": "fake"} for x in ("first", "second", "third")]})
        self.put_team({"id": "t", "name": "Team", "members": [
            {"id": "dev", "name": "Dev", "role": "developer", "agents": ["first", "third"]}]})
        with self.store.transaction() as tx:
            with self.assertRaises(AsError) as caught:
                teams.switch_member_agent(tx, self.args, {"debug": True})
            self.assertEqual((caught.exception.code, caught.exception.message),
                             ("BAD_REQUEST", "Agent 'second' is not configured for member 'dev'."))
            result = teams.switch_member_agent(tx, dict(self.args, agent="third"), {"debug": True})
        self.assertEqual(result["activeAgent"], "third")
        self.assertIsNone(self.status_member()["configuredAgents"])

    @patch("agent_studio.providers.probe_many", return_value={"fake": {"available": True}})
    def test_frozen_switch_reads_current_catalog_after_member_removed(self, probe):
        self.put_team({"id": "t", "name": "Team", "members": []})
        self.write("agents.json", {"version": 1, "agents": [
            {"id": "first", "name": "First", "provider": "fake"},
            {"id": "second", "name": "Second", "provider": "fake", "model": "updated-model"}]})
        with self.store.transaction() as tx:
            teams.switch_member_agent(tx, self.args, {"debug": True})
        row = self.conn.execute("SELECT active_catalog_agent, model FROM agents WHERE id = ?", (self.agent,)).fetchone()
        self.assertEqual(tuple(row), ("second", "updated-model"))

    def test_status_without_switch_event_has_null_last_switch(self):
        self.assertIsNone(self.status_member()["lastSwitch"])

    def test_historical_failure_uses_nearest_request_for_same_agent(self):
        with self.store.transaction() as tx:
            tx.note("agent", self.agent, "agent.switch_requested", {"toAgent": "first", "assignmentId": "old"})
            tx.note("agent", self.agent, "agent.switch_requested", {"toAgent": "second", "assignmentId": "new"})
            other = tx.create("agent", {"team_id": self.team, "ordinal": 1, "provider_id": "fake",
                                       "role": "developer", "display_name": "Other", "member_id": "other"})
            tx.note("agent", other, "agent.switch_requested", {"toAgent": "other", "assignmentId": "other"})
            tx.note("agent", self.agent, "agent.switch_failed", {"code": "BAD_REQUEST", "message": "failed"})
        self.assertEqual(self.status_member()["lastSwitch"], {
            "state": "failed", "requestedAgent": "second", "assignmentId": "new",
            "code": "BAD_REQUEST", "message": "failed", "at": self.event_at("agent.switch_failed")})

    def test_historical_failure_uses_previous_request(self):
        with self.store.transaction() as tx:
            tx.note("agent", self.agent, "agent.switch_requested", {"toAgent": "second", "assignmentId": "a"})
            tx.note("agent", self.agent, "agent.switch_failed", {"code": "BAD_REQUEST", "message": "failed"})
        self.assertEqual(self.status_member()["lastSwitch"], {"state": "failed", "requestedAgent": "second",
            "assignmentId": "a", "code": "BAD_REQUEST", "message": "failed", "at": self.event_at("agent.switch_failed")})

    @patch("agent_studio.providers.probe_many", return_value={"fake": {"available": True}})
    def test_failover_uses_frozen_options_after_definition_edit(self, probe):
        self.put_team({"id": "t", "name": "Team", "members": [
            {"id": "dev", "name": "Dev", "role": "developer", "agents": ["first"]}]})
        with self.store.transaction() as tx:
            tx.transition("agent", self.agent, "limit_reached")
            teams.handle_quota_limit(tx, self.agent, None, {"debug": True})
        self.assertEqual(self.status_member()["activeAgent"], "second")

    def test_provider_reset_uses_frozen_options_after_edit(self):
        self.write("agents.json", {"version": 1, "agents": [
            {"id": x, "name": x.title(), "provider": "fake"} for x in ("first", "second", "third")]})
        self.put_team({"id": "t", "name": "Team", "members": [
            {"id": "dev", "name": "Dev", "role": "developer", "agents": ["first", "third"]}]})
        with self.store.transaction() as tx:
            tx.update("agent", self.agent, {"quota_holds_json": {"second": None, "third": None}}, "agent.test_setup")
            result = teams.reset_provider_usage(tx, {"workspace": self.ws, "teamDefId": "t", "provider": "fake"}, {"debug": True})
        self.assertEqual(result["members"][0]["cleared"], ["second"])
        self.assertEqual(self.status_member()["quotaHolds"], {"third": None})

    def test_provider_reset_includes_removed_frozen_member(self):
        self.put_team({"id": "t", "name": "Team", "members": []})
        with self.store.transaction() as tx:
            tx.update("agent", self.agent, {"quota_holds_json": {"second": None}}, "agent.test_setup")
            result = teams.reset_provider_usage(tx, {"workspace": self.ws, "teamDefId": "t", "provider": "fake"}, {"debug": True})
        self.assertEqual(result["members"][0]["cleared"], ["second"])

    def test_pending_projection_uses_event_after_columns_are_cleared(self):
        with self.store.transaction() as tx:
            tx.note("agent", self.agent, "agent.switch_requested", {"toAgent": "second", "assignmentId": "a"})
        self.assertEqual(self.status_member()["lastSwitch"], {
            "state": "pending", "requestedAgent": "second", "assignmentId": "a",
            "code": None, "message": None, "at": self.event_at("agent.switch_requested")})

    def test_projection_uses_event_sequence_and_ignores_other_agents(self):
        with self.store.transaction() as tx:
            with patch("agent_studio.store.utcnow", return_value="2099-01-01"):
                tx.note("agent", self.agent, "agent.switch_requested", {"toAgent": "first", "assignmentId": "old"})
            with patch("agent_studio.store.utcnow", return_value="2000-01-01"):
                tx.note("agent", self.agent, "agent.option_switched", {"toAgent": "second"})
            other = tx.create("agent", {"team_id": self.team, "ordinal": 1, "provider_id": "fake",
                                       "role": "developer", "display_name": "Other", "member_id": "other"})
            tx.note("agent", other, "agent.switch_failed", {"toAgent": "first", "code": "BAD_REQUEST", "message": "other"})
        self.assertEqual(self.status_member()["lastSwitch"], {
            "state": "completed", "requestedAgent": "second", "assignmentId": None,
            "code": None, "message": None, "at": "2000-01-01"})

    def test_resume_uses_frozen_eligibility_after_definition_edit(self):
        self.put_team({"id": "t", "name": "Team", "members": [
            {"id": "dev", "name": "Dev", "role": "developer", "agents": ["first", "third"]}]})
        with self.store.transaction() as tx:
            tx.update("agent", self.agent, {"quota_holds_json": {"second": None}}, "agent.test_setup")
            self.assertTrue(teams.resume_member_agent(tx, self.args)["cleared"])
            with self.assertRaises(AsError) as caught:
                teams.resume_member_agent(tx, dict(self.args, agent="third"))
        self.assertEqual((caught.exception.code, caught.exception.message),
                         ("BAD_REQUEST", "Agent 'third' is not configured for member 'dev'."))

    def test_frozen_option_missing_from_catalog_reports_catalog_error(self):
        self.write("agents.json", {"version": 1, "agents": [
            {"id": "first", "name": "First", "provider": "fake"}]})
        with self.store.transaction() as tx:
            with self.assertRaises(AsError) as caught:
                teams.switch_member_agent(tx, self.args, {"debug": True})
        self.assertEqual((caught.exception.code, caught.exception.message),
                         ("TEAM_CONFIG_INVALID", "Agent 'second' is missing from the catalog."))

    @patch("agent_studio.providers.probe_many", return_value={"fake": {"available": True}})
    def test_expired_quota_recovery_uses_frozen_options_after_edit(self, probe):
        self.put_team({"id": "t", "name": "Team", "members": [
            {"id": "dev", "name": "Dev", "role": "developer", "agents": ["first"]}]})
        with self.store.transaction() as tx:
            tx.transition("agent", self.agent, "limit_reached", set_values={"quota_holds_json": {
                "first": None, "second": "2000-01-01T00:00:00Z"}})
        teams.recover_expired_quotas(self.store, {"debug": True})
        self.assertEqual((self.status_member()["activeAgent"], self.status_member()["availability"]), ("second", "idle"))

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

    def test_resume_inactive_option_preserves_active_work_and_other_holds(self):
        with self.store.transaction() as tx:
            tx.update("agent", self.agent, {"quota_holds_json": {"first": None, "second": "2030-01-01T00:00:00Z"},
                                            "active_catalog_agent": "second"}, "agent.test_setup")
            tx.transition("agent", self.agent, "busy")
            result = teams.resume_member_agent(tx, dict(self.args, agent="first"))
        agent = dict(self.conn.execute("SELECT * FROM agents WHERE id = ?", (self.agent,)).fetchone())
        self.assertTrue(result["cleared"])
        self.assertEqual((agent["availability"], agent["active_catalog_agent"]), ("busy", "second"))
        self.assertEqual(teams.quota_holds(agent), {"second": "2030-01-01T00:00:00Z"})
        with self.store.transaction() as tx:
            self.assertFalse(teams.resume_member_agent(tx, dict(self.args, agent="first"))["cleared"])
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM events WHERE name = 'agent.quota_resumed'").fetchone()[0], 1)

    def test_resume_active_option_makes_quota_held_member_idle(self):
        with self.store.transaction() as tx:
            tx.transition("agent", self.agent, "limit_reached", set_values={
                "quota_holds_json": {"first": None, "second": None}, "limit_reset_at": "2030-01-01"})
            teams.resume_member_agent(tx, dict(self.args, agent="first"))
        agent = dict(self.conn.execute("SELECT * FROM agents WHERE id = ?", (self.agent,)).fetchone())
        self.assertEqual((agent["availability"], agent["limit_reset_at"]), ("idle", None))
        self.assertEqual(teams.quota_holds(agent), {"second": None})

    def test_resume_rejects_unconfigured_option(self):
        with self.store.transaction() as tx:
            with self.assertRaises(AsError):
                teams.resume_member_agent(tx, dict(self.args, agent="unknown"))

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
