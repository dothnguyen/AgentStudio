import json
import unittest

from tests.unit import test_p05_s10_team_overview as fixture


class ManagementReadModelTests(unittest.TestCase):
    setUp = fixture.TeamOverviewTests.setUp
    _restore = fixture.TeamOverviewTests._restore
    write = fixture.TeamOverviewTests.write
    put_team = fixture.TeamOverviewTests.put_team
    seed_runtime = fixture.TeamOverviewTests.seed_runtime
    seed_assignment = fixture.TeamOverviewTests.seed_assignment
    ov = fixture.TeamOverviewTests.ov
    team = fixture.TeamOverviewTests.team
    member = fixture.TeamOverviewTests.member

    def catalog(self):
        entries = [
            {"id": "primary", "name": "Primary", "provider": "codex", "model": "model-one", "reasoning": "high", "description": "First"},
            {"id": "backup", "name": "Backup", "provider": "claude", "model": "model-two", "reasoning": "low", "description": "Second"},
            {"id": "new-backup", "name": "New", "provider": "fake", "model": "new", "reasoning": "medium", "description": "New backup"},
        ]
        self.write("agents.json", {"version": 1, "agents": entries})
        return entries

    def configured(self, **fields):
        self.put_team("core", [dict(id="dev", name="Dev", role="developer", **fields)])

    def test_ordered_options_resolve_in_saved_order(self):
        entries = self.catalog()
        self.configured(agents=["backup", "primary"])
        m = self.member(self.ov(), "core", "dev")
        self.assertEqual((m["agentMode"], m["defaultAgent"]), ("ordered_catalog", "backup"))
        self.assertEqual(m["agentOptions"], [dict(entries[1], state="ok"), dict(entries[0], state="ok")])
        self.assertEqual((m["provider"], m["model"], m["reasoning"]), ("claude", "model-two", "low"))
        self.assertIsNone(m["runtime"])

    def test_missing_option_is_explicit(self):
        self.catalog()
        self.configured(agents=["removed", "primary"])
        out = self.ov()
        m = self.member(out, "core", "dev")
        self.assertEqual([o["id"] for o in m["agentOptions"]], ["removed", "primary"])
        self.assertEqual(m["agentOptions"][0], dict(id="removed", name=None, provider=None, model=None, reasoning=None, description=None, state="missing"))
        self.assertEqual(m["defaultAgent"], "removed")
        self.assertEqual(self.team(out, "core")["definition"]["state"], "problems")
        self.write("agents.json", "{", raw=True)
        out = self.ov()
        m = self.member(out, "core", "dev")
        self.assertEqual([o["state"] for o in m["agentOptions"]], ["missing", "missing"])
        self.assertEqual((out["catalog"]["state"], m["agentDefState"]), ("invalid", "unavailable"))

    def test_saved_edit_differs_from_frozen_runtime(self):
        self.catalog()
        self.configured(agents=["primary", "new-backup"])
        _, ids = self.seed_runtime("core")
        self.conn.execute("UPDATE agents SET configured_agents_json=?, active_catalog_agent=?, provider_id=?, model=?, reasoning=? WHERE id=?",
                          (json.dumps(["primary", "old-backup"]), "old-backup", "claude", "old-model", "low", ids["dev"]))
        m = self.member(self.ov(), "core", "dev")
        self.assertEqual([o["id"] for o in m["agentOptions"]], ["primary", "new-backup"])
        self.assertEqual(m["defaultAgent"], "primary")
        r = m["runtime"]
        self.assertEqual((r["configuredAgents"], r["activeAgent"], r["provider"], r["model"], r["reasoning"]),
                         (["primary", "old-backup"], "old-backup", "claude", "old-model", "low"))
        self.assertNotIn("new-backup", r["configuredAgents"])

    def test_runtime_quota_and_pending_switch_fields(self):
        self.catalog()
        self.configured(agents=["primary", "backup"])
        team, ids = self.seed_runtime("core")
        agent = ids["dev"]
        assignment, _ = self.seed_assignment(team, agent, "work", run=False)
        task = self.conn.execute("SELECT task_id FROM assignments WHERE id=?", (assignment,)).fetchone()[0]
        self.conn.execute("UPDATE agents SET configured_agents_json=?, active_catalog_agent=?, quota_holds_json=?, model=?, reasoning=? WHERE id=?",
                          (json.dumps(["primary", "backup"]), "primary", json.dumps({"primary": None, "backup": "2026-10-28T12:00:00Z"}), "actual", "high", agent))
        with self.store.transaction() as tx:
            tx.update("agent", agent, {"pending_agent": "backup", "pending_assignment": assignment},
                      "agent.switch_requested", {"toAgent": "backup", "assignmentId": assignment})
        at = self.conn.execute("SELECT at FROM events WHERE name='agent.switch_requested' ORDER BY seq DESC LIMIT 1").fetchone()[0]
        r = self.member(self.ov(), "core", "dev")["runtime"]
        self.assertEqual(r["quotaHolds"], {"primary": None, "backup": "2026-10-28T12:00:00Z"})
        self.assertEqual(r["pendingAgent"], "backup")
        self.assertEqual(r["lastSwitch"], dict(state="pending", requestedAgent="backup", assignmentId=assignment, code=None, message=None, at=at))
        self.assertEqual(r["assignment"], dict(id=assignment, status="queued", taskId=task))
        self.assertEqual((r["provider"], r["model"], r["reasoning"], r["stale"]), ("fake", "actual", "high", False))
        stale = self.member(self.ov(running=False), "core", "dev")["runtime"]
        self.assertEqual(stale, dict(r, stale=True))

    def test_inline_and_single_catalog_compatibility(self):
        entries = self.catalog()
        self.put_team("core", [dict(id="dev", name="Dev", role="developer", provider="fake", model="inline", reasoning="low"),
                               dict(id="single", name="Single", role="developer", agent="primary")])
        self.seed_runtime("core", agents=(("dev", "idle"), ("orphan", "idle")))
        out = self.ov()
        inline = self.member(out, "core", "dev")
        self.assertEqual((inline["agentMode"], inline["agentOptions"], inline["defaultAgent"]), ("inline", [], None))
        self.assertEqual((inline["provider"], inline["model"], inline["reasoning"]), ("fake", "inline", "low"))
        self.assertEqual((inline["runtime"]["configuredAgents"], inline["runtime"]["quotaHolds"]), (None, {}))
        single = self.member(out, "core", "single")
        self.assertEqual((single["agentMode"], single["defaultAgent"], single["source"], single["agentDefId"], single["agentDefState"]),
                         ("single_catalog", "primary", "catalog", "primary", "ok"))
        self.assertEqual(single["agentOptions"], [dict(entries[0], state="ok")])
        orphan = self.member(out, "core", "orphan")
        self.assertEqual((orphan["source"], orphan["agentMode"], orphan["agentOptions"], orphan["defaultAgent"]), ("runtime", "inline", [], None))

    def test_catalog_entry_with_invalid_fields_is_still_present(self):
        self.write("agents.json", {"version": 1, "agents": [
            {"id": "primary", "name": 42, "provider": "fake", "model": False,
             "reasoning": None, "description": "d" * 250}]})
        self.configured(agents=["primary"])
        out = self.ov()
        self.assertEqual(self.member(out, "core", "dev")["agentOptions"], [
            {"id": "primary", "name": None, "provider": "fake", "model": None,
             "reasoning": None, "description": "d" * 200, "state": "ok"}])

    def test_assignment_uses_newest_active_row_and_breaks_timestamp_ties(self):
        self.configured(provider="fake")
        team, ids = self.seed_runtime("core")
        first, _ = self.seed_assignment(team, ids["dev"], "first", run=False)
        second, _ = self.seed_assignment(team, ids["dev"], "second", run=False)
        finished, _ = self.seed_assignment(team, ids["dev"], "finished", run=False, statuses=("cancelled",))
        self.conn.execute("UPDATE assignments SET created_at=? WHERE id IN (?, ?)",
                          ("2026-01-01T00:00:00Z", first, second))
        self.conn.execute("UPDATE assignments SET created_at=? WHERE id=?", ("2027-01-01T00:00:00Z", finished))
        task = self.conn.execute("SELECT task_id FROM assignments WHERE id=?", (second,)).fetchone()[0]
        self.assertEqual(self.member(self.ov(), "core", "dev")["runtime"]["assignment"],
                         {"id": second, "status": "queued", "taskId": task})
        self.conn.execute("UPDATE assignments SET created_at=? WHERE id=?", ("2028-01-01T00:00:00Z", first))
        self.assertEqual(self.member(self.ov(), "core", "dev")["runtime"]["assignment"]["id"], first)

    def test_runtime_assignment_selects_each_active_status_for_its_agent(self):
        self.configured(provider="fake")
        team, ids = self.seed_runtime("core", agents=(("dev", "idle"), ("other", "idle")))
        other, _ = self.seed_assignment(team, ids["other"], "other", run=False)
        self.conn.execute("UPDATE assignments SET created_at=? WHERE id=?", ("2099-01-01T00:00:00Z", other))
        assignment, _ = self.seed_assignment(team, ids["dev"], "own", run=False)
        task = self.conn.execute("SELECT task_id FROM assignments WHERE id=?", (assignment,)).fetchone()[0]
        for status in ("queued", "claimed", "running", "waiting_input", "reconciling"):
            with self.subTest(status=status):
                self.conn.execute("UPDATE assignments SET status=? WHERE id=?", (status, assignment))
                runtime = self.member(self.ov(), "core", "dev")["runtime"]
                self.assertEqual(runtime["assignment"], {"id": assignment, "status": status, "taskId": task})
        self.conn.execute("UPDATE assignments SET status='cancelled' WHERE id=?", (assignment,))
        self.assertIsNone(self.member(self.ov(), "core", "dev")["runtime"]["assignment"])

    def test_pending_column_and_switch_event_are_independent(self):
        self.configured(provider="fake")
        _, ids = self.seed_runtime("core")
        agent = ids["dev"]
        self.conn.execute("UPDATE agents SET pending_agent=? WHERE id=?", ("backup", agent))
        runtime = self.member(self.ov(), "core", "dev")["runtime"]
        self.assertEqual((runtime["pendingAgent"], runtime["lastSwitch"]), ("backup", None))
        self.conn.execute("UPDATE agents SET pending_agent=NULL WHERE id=?", (agent,))
        with self.store.transaction() as tx:
            tx.note("agent", agent, "agent.switch_requested", {"toAgent": "primary", "assignmentId": None})
        runtime = self.member(self.ov(), "core", "dev")["runtime"]
        self.assertIsNone(runtime["pendingAgent"])
        self.assertEqual(runtime["lastSwitch"]["requestedAgent"], "primary")
        self.assertEqual(runtime["lastSwitch"]["state"], "pending")

    def test_runtime_shape_and_unavailable_state_preserve_evidence(self):
        self.configured(provider="fake")
        _, ids = self.seed_runtime("core")
        runtime = self.member(self.ov(), "core", "dev")["runtime"]
        self.assertEqual(runtime, {"agentId": ids["dev"], "availability": "idle", "paneState": "unknown",
                                   "configuredAgents": None, "activeAgent": None, "quotaHolds": {},
                                   "pendingAgent": None, "lastSwitch": None, "provider": "fake",
                                   "model": None, "reasoning": None, "assignment": None, "stale": False})
        member = self.member(self.ov(error={"code": "unavailable"}), "core", "dev")
        self.assertEqual(member["runtime"], dict(runtime, stale=True))
        self.assertEqual((member["presence"], member["work"]),
                         ("unavailable", {"state": "unavailable", "reason": "unavailable"}))

    def test_saved_files_change_without_rewriting_runtime_or_database(self):
        self.catalog()
        self.configured(agents=["primary", "backup"])
        _, ids = self.seed_runtime("core")
        self.conn.execute("UPDATE agents SET configured_agents_json=?, active_catalog_agent=?, quota_holds_json=? WHERE id=?",
                          (json.dumps(["primary", "backup"]), "backup", json.dumps({"backup": None}), ids["dev"]))
        before = self.member(self.ov(), "core", "dev")
        self.configured(agents=["primary", "new-backup"])
        entries = self.catalog()
        entries[0]["model"] = "edited-model"
        self.write("agents.json", {"version": 1, "agents": entries})
        changes = self.conn.total_changes
        after = self.member(self.ov(), "core", "dev")
        self.assertEqual([o["id"] for o in after["agentOptions"]], ["primary", "new-backup"])
        self.assertEqual(after["model"], "edited-model")
        self.assertEqual(after["runtime"], before["runtime"])
        self.assertEqual(self.conn.total_changes, changes)

    def test_runtime_evidence_and_staleness_follow_effective_team_state(self):
        self.configured(provider="fake")
        team, ids = self.seed_runtime("core", status="starting")
        assignment, _ = self.seed_assignment(team, ids["dev"], "work", run=False)
        starting = self.member(self.ov(), "core", "dev")
        self.assertFalse(starting["runtime"]["stale"])
        self.assertEqual(starting["runtime"]["assignment"]["id"], assignment)
        for status in ("stopped", "error"):
            with self.subTest(status=status):
                self.conn.execute("UPDATE teams SET status=? WHERE id=?", (status, team))
                member = self.member(self.ov(), "core", "dev")
                self.assertEqual(member["runtime"], dict(starting["runtime"], stale=True))
                self.assertEqual(member["presence"], status)
                self.assertEqual(member["work"], {"state": "unavailable", "reason": status})

    def test_missing_single_catalog_reference_remains_default(self):
        self.catalog()
        self.configured(agent="removed")
        out = self.ov()
        member = self.member(out, "core", "dev")
        self.assertEqual((member["agentMode"], member["defaultAgent"], member["agentDefId"],
                          member["agentDefState"]), ("single_catalog", "removed", "removed", "missing"))
        self.assertEqual(member["agentOptions"], [{"id": "removed", "name": None, "provider": None,
                          "model": None, "reasoning": None, "description": None, "state": "missing"}])
        self.assertEqual(self.team(out, "core")["definition"]["state"], "problems")
        self.assertIsNone(member["runtime"])

    def test_unavailable_catalog_retains_each_saved_id_with_empty_fields(self):
        self.configured(agents=["primary", "backup"])
        self.write("agents.json", "{", raw=True)
        out = self.ov()
        member = self.member(out, "core", "dev")
        self.assertEqual((member["agentMode"], member["defaultAgent"], member["agentDefState"]),
                         ("ordered_catalog", "primary", "unavailable"))
        self.assertEqual(member["agentOptions"], [
            {"id": agent_id, "name": None, "provider": None, "model": None,
             "reasoning": None, "description": None, "state": "missing"}
            for agent_id in ("primary", "backup")])
        self.assertEqual(out["catalog"]["state"], "invalid")

    def test_orphan_runtime_catalog_evidence_does_not_create_saved_options(self):
        self.catalog()
        self.configured(provider="fake")
        _, ids = self.seed_runtime("core", agents=(("orphan", "idle"),))
        self.conn.execute("UPDATE agents SET configured_agents_json=?, active_catalog_agent=?, quota_holds_json=? WHERE id=?",
                          (json.dumps(["primary", "backup"]), "backup", json.dumps({"primary": None}), ids["orphan"]))
        member = self.member(self.ov(running=False), "core", "orphan")
        self.assertEqual((member["source"], member["agentMode"], member["agentOptions"], member["defaultAgent"]),
                         ("runtime", "inline", [], None))
        self.assertEqual((member["runtime"]["configuredAgents"], member["runtime"]["activeAgent"],
                          member["runtime"]["quotaHolds"], member["runtime"]["stale"]),
                         (["primary", "backup"], "backup", {"primary": None}, True))
        self.assertEqual((member["presence"], member["work"]),
                         ("disconnected", {"state": "unavailable", "reason": "disconnected"}))

    def test_completed_and_failed_switch_events_are_projected(self):
        self.configured(provider="fake")
        _, ids = self.seed_runtime("core")
        agent = ids["dev"]
        for name, state, code, message in (
            ("agent.option_switched", "completed", None, None),
            ("agent.switch_failed", "failed", "BAD_REQUEST", "Switch failed"),
        ):
            with self.subTest(state=state):
                with self.store.transaction() as tx:
                    tx.note("agent", agent, name, {"toAgent": "backup", "assignmentId": "assignment",
                                                  "code": code, "message": message})
                at = self.conn.execute("SELECT at FROM events WHERE entity_id=? AND name=? ORDER BY seq DESC LIMIT 1",
                                       (agent, name)).fetchone()[0]
                runtime = self.member(self.ov(), "core", "dev")["runtime"]
                self.assertEqual(runtime["lastSwitch"], {"state": state, "requestedAgent": "backup",
                                 "assignmentId": "assignment", "code": code, "message": message, "at": at})

    def test_option_string_fields_are_bounded(self):
        self.write("agents.json", {"version": 1, "agents": [{
            "id": "primary", "name": "n" * 250, "provider": "p" * 250,
            "model": "m" * 250, "reasoning": "r" * 250, "description": "d" * 250,
        }]})
        self.configured(agents=["primary"])
        option = self.member(self.ov(), "core", "dev")["agentOptions"][0]
        self.assertEqual(option, {"id": "primary", "name": "n" * 200,
                                  "provider": "p" * 200, "model": "m" * 200,
                                  "reasoning": "r" * 200, "description": "d" * 200,
                                  "state": "ok"})

    def test_switch_evidence_is_scoped_to_each_runtime_agent(self):
        self.configured(provider="fake")
        _, ids = self.seed_runtime("core", agents=(("dev", "idle"), ("other", "idle")))
        with self.store.transaction() as tx:
            tx.note("agent", ids["dev"], "agent.switch_requested",
                    {"toAgent": "primary", "assignmentId": None})
            tx.note("agent", ids["other"], "agent.switch_requested",
                    {"toAgent": "backup", "assignmentId": None})
        out = self.ov()
        self.assertEqual(self.member(out, "core", "dev")["runtime"]["lastSwitch"]["requestedAgent"], "primary")
        self.assertEqual(self.member(out, "core", "other")["runtime"]["lastSwitch"]["requestedAgent"], "backup")
