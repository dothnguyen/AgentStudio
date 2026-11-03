"""P04-S09: the rules schema, `board rules check`, the outcome applier and `ticket unblock`."""
import json
import os
import unittest

from tests import helpers  # noqa: F401  (puts backend on sys.path)
from tests.helpers import fresh
from agent_studio import boardmodel
from agent_studio.protocol import AsError
from tests.unit.test_p04_s07_board_model import BoardCase
from tests.unit.test_board_config_v3 import config as workflow_config

ROLES = {"version": 1, "roles": {"worker": {}, "checker": {}}}
SOLO = {"version": 1, "description": "solo", "stages": [
    {"id": "work", "role": "worker", "permission": "read_only", "prompt": "{{task}}",
     "next": {"done": "$succeed"}}]}
CHECK = {"version": 1, "description": "check", "stages": [
    {"id": "look", "role": "checker", "permission": "read_only", "prompt": "{{task}}",
     "next": {"done": "$succeed"}}]}
RULES_CONFIG = {"version": 2,
                "statuses": [{"id": "todo", "kind": "initial"}, {"id": "review"}, {"id": "hold"},
                             {"id": "done", "kind": "done"}, {"id": "dropped", "kind": "closed"}],
                "ticketFields": [],
                "rules": [
                    {"when": {"status": "todo"}, "role": "worker", "workflow": "solo",
                     "onPass": "review", "onFail": "todo", "maxRounds": 2},
                    {"when": {"status": "review"}, "role": "checker", "workflow": "check",
                     "onPass": "done", "onFail": "todo", "onBlocked": "hold"},
                    {"when": {"status": "dropped"}, "action": "merge", "onPass": "dropped",
                     "onFail": "dropped"}]}
BLOCKABLE_CONFIG = {"version": 2,
                    "statuses": [{"id": "todo", "kind": "initial"}, {"id": "done", "kind": "done"}],
                    "ticketFields": [],
                    "rules": [{"when": {"status": "todo"}, "role": "worker", "workflow": "solo",
                               "onPass": "done", "onFail": "todo", "maxRounds": 2}]}


class RulesCase(BoardCase):
    def setUp(self):
        super().setUp()
        with open(os.path.join(self.ws, ".agent-studio", "roles.json"), "w") as f:
            json.dump(ROLES, f)
        os.makedirs(os.path.join(self.ws, ".agent-studio", "workflows"), exist_ok=True)
        for name, definition in (("solo.json", SOLO), ("check.json", CHECK)):
            with open(os.path.join(self.ws, ".agent-studio", "workflows", name), "w") as f:
                json.dump(definition, f)
        self.write_config(RULES_CONFIG)

    def check(self, config=None):
        return boardmodel.check_rules(self.ws, config or boardmodel.load_config(self.ws))

    def problems_with(self, config):
        self.write_config(config)
        with self.assertRaises(AsError) as caught:
            boardmodel.load_config(self.ws)
        return caught.exception.data["problems"]


class RulesSchema(RulesCase):
    def test_good_rules_load_and_index_by_status(self):
        model = boardmodel.load_config(self.ws)
        self.assertEqual(set(model["rulesByStatus"]), {"none", "review", "dropped"})
        self.assertEqual(self.check(), [])

    def test_created_ticket_policies_are_status_validated_and_rule_scoped(self):
        good = json.loads(json.dumps(RULES_CONFIG))
        good["rules"][0]["createdTicketStatus"] = "todo"
        good["rules"][2]["onPassCreatedTickets"] = {"from": "todo", "to": "review"}
        self.write_config(good)
        self.assertEqual(self.check(), [])

        bad = json.loads(json.dumps(good))
        bad["rules"][2]["onPassCreatedTickets"]["to"] = "nowhere"
        paths = " ".join(p["path"] for p in self.problems_with(bad))
        self.assertIn("rules[2].onPassCreatedTickets.to", paths)

        bad = json.loads(json.dumps(good))
        bad["rules"][0]["onPassCreatedTickets"] = {"from": "todo", "to": "review"}
        paths = " ".join(p["path"] for p in self.problems_with(bad))
        self.assertIn("rules[0].onPassCreatedTickets", paths)

    def test_schema_problems_are_reported_at_load_time(self):
        cases = [
            ({**RULES_CONFIG, "rules": [{"when": {"status": "nowhere"}, "role": "worker",
                                         "workflow": "solo", "onPass": "review", "onFail": "todo"}]},
             "rules[0].when.status"),
            ({**RULES_CONFIG, "rules": [{"when": {"status": "todo"}, "role": "worker", "workflow": "solo",
                                         "onPass": "nowhere", "onFail": "todo"}]}, "rules[0].onPass"),
            ({**RULES_CONFIG, "rules": [{"when": {"status": "todo"}, "role": "worker", "workflow": "solo",
                                         "onPass": "review"}]}, "rules[0].onFail"),
            ({**RULES_CONFIG, "rules": [{"when": {"status": "todo"}, "role": "worker", "workflow": "solo",
                                         "onPass": "review", "onFail": "todo",
                                         "onBlocked": "nowhere"}]}, "rules[0].onBlocked"),
            ({**RULES_CONFIG, "rules": [
                {"when": {"status": "todo"}, "role": "worker", "workflow": "solo", "onPass": "review",
                 "onFail": "todo"},
                {"when": {"status": "todo"}, "role": "checker", "workflow": "solo", "onPass": "done",
                 "onFail": "todo"}]}, "rules"),
            ({**RULES_CONFIG, "rules": [{"when": {"status": "todo"}, "role": "worker", "workflow": "solo",
                                         "action": "drop", "onPass": "review", "onFail": "todo"}]},
             "rules[0]"),
            ({**RULES_CONFIG, "rules": [{"when": {"status": "todo"}, "role": "worker",
                                         "onPass": "review", "onFail": "todo"}]}, "rules[0]"),
            ({**RULES_CONFIG, "rules": [{"when": {"status": "todo"}, "role": "worker", "workflow": "solo",
                                         "onPass": "review", "onFail": "todo", "maxRounds": 0}]},
             "rules[0].maxRounds"),
            ({**RULES_CONFIG, "rules": [{"when": {"status": "todo"}, "role": "worker", "workflow": "solo",
                                         "onPass": "review", "onFail": "todo", "workspace": "server"}]},
             "rules[0].workspace"),
            ({**RULES_CONFIG, "rules": [{"when": {"status": "todo"}, "role": "worker", "workflow": "solo",
                                         "onPass": "review", "onFail": "todo", "cap": "many"}]},
             "rules[0].cap"),
            ({**RULES_CONFIG, "rules": [{"when": {"status": "todo"}, "role": "worker", "workflow": "solo",
                                         "onPass": "review", "onFail": "todo", "requiresDeps": "yes"}]},
             "rules[0].requiresDeps"),
            ({**RULES_CONFIG, "statuses": [{"id": "todo", "kind": "initial"}, {"id": "blocked"},
                                           {"id": "done", "kind": "done"}],
              "rules": [{"when": {"status": "todo"}, "role": "worker", "workflow": "solo",
                         "onPass": "done", "onFail": "todo"}]}, "statuses[1].id"),
        ]
        for config, fragment in cases:
            with self.subTest(fragment=fragment):
                paths = " ".join(p["path"] for p in self.problems_with(config))
                self.assertIn(fragment, paths)

    def test_check_rules_reports_roles_workflows_and_the_path(self):
        bad_role = json.loads(json.dumps(RULES_CONFIG))
        bad_role["rules"][0]["role"] = "nobody"
        self.write_config(bad_role)
        problems = self.check()
        self.assertIn("rules[0].role", [p["path"] for p in problems])

        bad_flow = json.loads(json.dumps(RULES_CONFIG))
        bad_flow["rules"][0]["workflow"] = "missing-one"
        self.write_config(bad_flow)
        self.assertEqual([p["path"] for p in self.check()], ["rules[0].workflow"])

        with open(os.path.join(self.ws, ".agent-studio", "workflows", "solo.json"), "w") as f:
            f.write("{ broken")
        self.write_config(RULES_CONFIG)
        self.assertTrue(any("cannot be bound" in p["message"] for p in self.check()))
        with open(os.path.join(self.ws, ".agent-studio", "workflows", "solo.json"), "w") as f:
            json.dump(SOLO, f)

        no_path = {"version": 2, "statuses": [{"id": "todo", "kind": "initial"}, {"id": "again"},
                                              {"id": "done", "kind": "done"}],
                   "ticketFields": [],
                   "rules": [{"when": {"status": "todo"}, "role": "worker", "workflow": "solo",
                              "onPass": "again", "onFail": "todo"}]}
        self.write_config(no_path)
        problems = self.check(boardmodel.load_config(self.ws))
        self.assertEqual([p["path"] for p in problems], ["rules"])
        self.assertIn("no path", problems[0]["message"])

        os.remove(os.path.join(self.ws, ".agent-studio", "roles.json"))
        self.write_config(RULES_CONFIG)
        self.assertEqual([p["path"] for p in self.check()][0], "roles.json")


class ApplierCase(RulesCase):
    def add(self, *args, **kwargs):
        ticket = super().add(*args, **kwargs)
        # These legacy applier tests exercise pre-migration status rows.
        self.conn.execute("UPDATE tickets SET status = workflow_status, workflow_status = NULL WHERE id = ?",
                          (ticket["id"],))
        self.conn.commit()
        return ticket

    def setUp(self):
        super().setUp()
        self.write_config(BLOCKABLE_CONFIG)
        with self.store.transaction() as tx:
            self.team = tx.create("team", {"name": "t", "workspace": self.ws})
            tx.transition("team", self.team, "running")

    def make_run(self, status):
        with self.store.transaction() as tx:
            task = tx.create("task", {"team_id": self.team, "origin": "workflow", "workspace": self.ws,
                                      "goal": "g"})
            tx.transition("task", task, "assigned")
            tx.transition("task", task, "running")
            run = tx.create("workflow_run", {"team_id": self.team, "task_id": task, "workflow": "definition"})
            tx.transition("workflow_run", run, "running")
            if status != "running":
                tx.transition("workflow_run", run, status)
        return run

    def apply(self, key, run):
        with self.store.transaction() as tx:
            return boardmodel.apply_run_outcome(tx, self.ws, {"key": key, "run": run})


class OutcomeApplier(ApplierCase):
    def test_failure_limit_routes_third_failure_and_resets_after_pass(self):
        config = json.loads(json.dumps(RULES_CONFIG))
        config["rules"][1]["onFailureLimit"] = {"count": 3, "status": "hold"}
        self.write_config(config)
        self.add("escalation")
        self.legacy_status("T-001", "review")
        for failure in range(1, 4):
            result = self.apply("T-001", self.make_run("failed"))
            self.assertEqual(result["ticket"]["status"], "hold" if failure == 3 else "none")
            if failure < 3:
                self.legacy_status("T-001", "review")
        self.assertEqual(result["reason"], "FAILURE_LIMIT:review")
        self.legacy_status("T-001", "review")
        result = self.apply("T-001", self.make_run("failed"))
        self.assertEqual(result["ticket"]["status"], "none")
        self.legacy_status("T-001", "review")
        self.apply("T-001", self.make_run("succeeded"))
        self.legacy_status("T-001", "review")
        result = self.apply("T-001", self.make_run("failed"))
        self.assertEqual(result["ticket"]["status"], "none")

    def test_failure_limit_schema_rejects_invalid_threshold_and_status(self):
        config = json.loads(json.dumps(RULES_CONFIG))
        config["rules"][1]["onFailureLimit"] = {"count": 0, "status": "missing"}
        paths = [problem["path"] for problem in self.problems_with(config)]
        self.assertIn("rules[1].onFailureLimit.count", paths)
        self.assertIn("rules[1].onFailureLimit.status", paths)

    def test_failure_limit_does_not_count_paused_runs_or_replays(self):
        config = json.loads(json.dumps(RULES_CONFIG))
        config["rules"][1]["onFailureLimit"] = {"count": 2, "status": "hold"}
        self.write_config(config)
        self.add("pause and retry")
        self.legacy_status("T-001", "review")
        self.assertEqual(self.apply("T-001", self.make_run("paused"))["ticket"]["status"], "hold")
        self.legacy_status("T-001", "review")
        first = self.make_run("failed")
        self.assertEqual(self.apply("T-001", first)["ticket"]["status"], "none")
        self.assertFalse(self.apply("T-001", first)["applied"])
        self.legacy_status("T-001", "review")
        self.assertEqual(self.apply("T-001", self.make_run("failed"))["ticket"]["status"], "hold")

    def test_pass_fail_and_round_limit(self):
        ticket = self.add("work")
        run = self.make_run("succeeded")
        got = self.apply("T-001", run)
        self.assertEqual((got["applied"], got["outcome"], got["ticket"]["status"], got["rounds"]),
                         (True, "pass", "merged", 1))
        self.assertEqual(got["ticket"]["runId"], run)

        self.add("retry me")
        for round_no, expected in ((1, "none"), (2, "blocked")):
            run = self.make_run("failed")
            got = self.apply("T-002", run)
            self.assertEqual(got["ticket"]["status"], expected, round_no)
            self.assertEqual(got["rounds"], round_no)
        row = self.conn.execute("SELECT return_status, blocked_reason, rounds_json FROM tickets WHERE key = 'T-002'"
                                ).fetchone()
        self.assertEqual((row["return_status"], row["blocked_reason"]), ("none", "ROUND_LIMIT:none"))
        self.assertEqual(json.loads(row["rounds_json"]), {"none": 2})

    def test_blocked_outcomes(self):
        self.add("paused one")
        run = self.make_run("paused")
        got = self.apply("T-001", run)
        self.assertEqual((got["outcome"], got["ticket"]["status"], got["reason"]),
                         ("blocked", "blocked", f"RUN_BLOCKED:{run}"))
        self.add("cancelled one")
        run = self.make_run("cancelled")
        got = self.apply("T-002", run)
        self.assertEqual((got["outcome"], got["ticket"]["status"], got["rounds"]),
                         ("cancelled", "none", 0))

    def test_on_blocked_rule_target_is_used_when_configured(self):
        self.write_config(RULES_CONFIG)
        self.add("to review")
        self.legacy_status("T-001", "review")
        run = self.make_run("paused")
        got = self.apply("T-001", run)
        self.assertEqual((got["outcome"], got["ticket"]["status"]), ("blocked", "hold"))

    def test_idempotent_and_late_outcomes(self):
        self.add("once")
        run = self.make_run("succeeded")
        first = self.apply("T-001", run)
        events_before = self.count("ticket_events")
        again = self.apply("T-001", run)  # replayed or late after a restart: no change
        self.assertEqual(again["applied"], False)
        self.assertEqual(again["ticket"]["status"], first["ticket"]["status"])
        self.assertEqual(self.count("ticket_events"), events_before)
        other = self.make_run("failed")
        self.add("second")  # a different run applies normally to a ticket still in a ruled status
        self.assertEqual(self.apply("T-002", other)["applied"], True)

    def test_bad_applies_change_nothing(self):
        self.add("a")
        with self.assertRaises(AsError) as caught:
            self.apply("T-001", "9" * 8 + "-0000-4000-8000-" + "9" * 12)
        self.assertEqual(caught.exception.code, "NOT_FOUND")
        run = self.make_run("running")
        with self.assertRaises(AsError) as caught:
            self.apply("T-001", run)
        self.assertEqual(caught.exception.code, "TICKET_BUSY")
        done = self.make_run("succeeded")
        self.legacy_status("T-001", "merged")  # no rule works the done status
        with self.assertRaises(AsError) as caught:
            self.apply("T-001", done)
        self.assertEqual(caught.exception.code, "BOARD_RULE_MISSING")
        self.assertEqual(self.count("ticket_events"), 1)  # created only

    def test_events_written_per_apply(self):
        self.add("tracked")
        run = self.make_run("failed")
        self.apply("T-001", run)
        events = self.events("T-001")
        self.assertEqual([(e["name"], e["from_status"], e["to_status"], e["actor"]) for e in events],
                         [("ticket.created", None, "backlog", "operator"),
                          ("ticket.outcome_applied", "none", "none", "coordinator")])
        self.assertEqual(json.loads(events[-1]["payload_json"])["rounds"], 1)


class WorkflowOutcomeApplier(ApplierCase):
    def setUp(self):
        super().setUp()
        self.config = workflow_config()
        self.config["rules"][0].update(maxRounds=2, onFailureLimit={"count": 2, "status": "merge-ready"})
        self.write_config(self.config)
        self.ticket = self.add("workflow outcome")
        self.claim("working")

    def claim(self, status):
        self.conn.execute("UPDATE tickets SET status = 'in-progress', workflow_status = ?, "
                          "assignee = 'worker', active_run_id = NULL, lease_until = 'later' WHERE id = ?",
                          (status, self.ticket["id"]))

    def test_pass_moves_to_ready_and_replay_writes_nothing(self):
        run = self.make_run("succeeded")
        result = self.apply(self.ticket["key"], run)
        row = boardmodel.get_ticket(self.conn, self.ws, self.ticket["key"])
        self.assertEqual((row["workflow_status"], row["status"], row["assignee"], row["lease_until"]),
                         ("merge-ready", "in-progress", None, None))
        self.assertEqual(result["rule"], "ready")
        events = self.events(self.ticket["key"])
        self.assertEqual([(e["name"], e["from_status"], e["to_status"]) for e in events[-2:]],
                         [("ticket.workflow_changed", "working", "merge-ready"),
                          ("ticket.outcome_applied", "working", "merge-ready")])
        self.assertFalse(self.apply(self.ticket["key"], run)["applied"])
        self.assertEqual(len(self.events(self.ticket["key"])), len(events))

    def test_pass_to_done_and_when_rule_lookup(self):
        self.claim("merge-ready")
        self.apply(self.ticket["key"], self.make_run("succeeded"))
        row = boardmodel.get_ticket(self.conn, self.ws, self.ticket["key"])
        self.assertEqual((row["workflow_status"], row["status"]), ("done", "done"))

    def test_failure_and_failure_limit(self):
        self.apply(self.ticket["key"], self.make_run("failed"))
        row = boardmodel.get_ticket(self.conn, self.ws, self.ticket["key"])
        self.assertEqual((row["workflow_status"], row["status"]), ("ready", "in-progress"))
        self.claim("working")
        result = self.apply(self.ticket["key"], self.make_run("failed"))
        self.assertEqual((result["ticket"]["workflowStatus"], result["ticket"]["status"], result["reason"]),
                         ("merge-ready", "in-progress", "FAILURE_LIMIT:ready"))

    def test_failed_run_findings_are_appended_and_event_keeps_workflow_statuses(self):
        self.conn.execute("UPDATE tickets SET body = ? WHERE id = ?", ("original brief", self.ticket["id"]))
        run = self.make_run("failed")
        with self.store.transaction() as tx:
            tx.create("stage_attempt", {"team_id": self.team, "workflow_run_id": run, "stage": "work",
                                         "attempt": 1, "verdict_json": {"verdict": "fail",
                                                                        "findings": ["missing validation"]}})

        self.apply(self.ticket["key"], run)

        row = boardmodel.get_ticket(self.conn, self.ws, self.ticket["key"])
        self.assertIn("original brief", row["body"])
        self.assertIn("Findings from ready, round 1", row["body"])
        self.assertIn("- missing validation", row["body"])
        event = [e for e in self.events(self.ticket["key"]) if e["name"] == "ticket.outcome_applied"][-1]
        self.assertEqual((event["from_status"], event["to_status"]), ("working", "ready"))
        self.assertEqual(json.loads(event["payload_json"]), {
            "ticketId": self.ticket["id"], "key": self.ticket["key"], "run": run,
            "outcome": "fail", "rule": "ready", "rounds": 1, "to": "ready", "reason": None,
        })

    def test_round_limit_and_blocked_outcome_preserve_column_and_return_status(self):
        del self.config["rules"][0]["onFailureLimit"]
        self.write_config(self.config)
        self.apply(self.ticket["key"], self.make_run("failed"))
        self.claim("working")
        result = self.apply(self.ticket["key"], self.make_run("failed"))
        row = boardmodel.get_ticket(self.conn, self.ws, self.ticket["key"])
        self.assertEqual((row["workflow_status"], row["status"], row["return_status"], row["blocked_reason"]),
                         ("blocked", "in-progress", "ready", "ROUND_LIMIT:ready"))
        self.assertEqual(result["reason"], "ROUND_LIMIT:ready")
        self.claim("working")
        run = self.make_run("paused")
        self.apply(self.ticket["key"], run)
        row = boardmodel.get_ticket(self.conn, self.ws, self.ticket["key"])
        self.assertEqual((row["workflow_status"], row["status"], row["return_status"], row["blocked_reason"]),
                         ("blocked", "in-progress", "ready", f"RUN_BLOCKED:{run}"))

    def test_on_blocked_target_is_a_workflow_status(self):
        self.config["rules"][0]["onBlocked"] = "merge-ready"
        self.write_config(self.config)
        result = self.apply(self.ticket["key"], self.make_run("paused"))
        self.assertEqual((result["ticket"]["workflowStatus"], result["ticket"]["status"]),
                         ("merge-ready", "in-progress"))


class Unblock(ApplierCase):
    def test_unblock_returns_to_the_recorded_status(self):
        self.add("stuck")
        for _ in range(2):
            self.apply("T-001", self.make_run("failed"))
        row = self.conn.execute("SELECT status FROM tickets WHERE key = 'T-001'").fetchone()
        self.assertEqual(row["status"], "blocked")
        with self.store.transaction() as tx:
            got = boardmodel.ticket_unblock(tx, self.ws, {"key": "T-001"})
        self.assertEqual((got["ticket"]["workflowStatus"], got["ticket"]["status"]), ("none", "backlog"))
        row = self.conn.execute("SELECT status, return_status, blocked_reason FROM tickets WHERE key = 'T-001'"
                                ).fetchone()
        self.assertEqual((row["status"], row["return_status"], row["blocked_reason"]), ("backlog", None, None))
        self.assertEqual([e["name"] for e in self.events("T-001")][-1], "ticket.unblocked")
        with self.assertRaises(AsError) as caught:  # only a blocked ticket can be unblocked
            with self.store.transaction() as tx:
                boardmodel.ticket_unblock(tx, self.ws, {"key": "T-001"})
        self.assertEqual(caught.exception.code, "TICKET_TRANSITION_INVALID")

    def test_blocked_tickets_show_in_a_reserved_column(self):
        self.add("stuck")
        for _ in range(2):
            self.apply("T-001", self.make_run("failed"))
        shown = boardmodel.board_show(self.conn, self.ws)
        columns = shown["phases"][0]["columns"]
        self.assertEqual(sum(columns.values()), 1)
        self.assertEqual(shown["phases"][0]["workflow"]["blocked"], 1)


if __name__ == "__main__":
    unittest.main()
