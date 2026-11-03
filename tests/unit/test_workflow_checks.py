"""Check stages use durable delegated requests and route on their results."""
import json
import unittest
from unittest import mock

import tests.helpers  # noqa: F401
from agent_studio import workflow
from types import SimpleNamespace


class CheckStages(unittest.TestCase):
    def setUp(self):
        self.wf = {"id": "w", "team_id": "t", "config_json": json.dumps({"delegatedCommands": {
            "commands": {c: {"id": c, "argv": [c], "params": {}} for c in ("one", "two")}}})}
        self.sa = {"id": "s", "stage": "check", "visit": 1, "prompt_path": "/tmp/stage.txt"}
        self.state = {"checks": ["one", "two"], "reuseIfTested": False}
        self.rows = []
        self.tx = mock.Mock()
        self.tx.create.side_effect = self.create
        self.tx.get.side_effect = lambda entity, rid: self.wf if entity == "workflow_run" else next(r for r in self.rows if r["id"] == rid)
        self.tx.transition.side_effect = self.transition
        self.patches = [mock.patch.object(workflow.delegation, "requests_for", side_effect=lambda *a, **k: list(self.rows)),
                        mock.patch.object(workflow, "wf_workspace", return_value="/workspace"),
                        mock.patch.object(workflow.delegation, "spawn", return_value={"dir": "/run"}),
                        mock.patch.object(workflow, "_prev_assignment", return_value=None),
                        mock.patch.object(workflow, "_stage_of", return_value=object()),
                        mock.patch.object(workflow, "_route")]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)

    def create(self, entity, values, **kw):
        row = dict(values, id=str(len(self.rows) + 1),
                   # Tx.create accepts state as a keyword, while some create paths
                   # provide their initial status in the values mapping.
                   status=kw.get("state", values.get("status", "pending")),
                   result_json=None, process_json=None)
        if "argv_json" in row:
            row["argv_json"] = json.dumps(row["argv_json"])
        self.rows.append(row)
        return row["id"]

    def transition(self, entity, rid, status, **kw):
        if entity == "command_request":
            row = next(r for r in self.rows if r["id"] == rid)
            row["status"] = status
            for k, v in kw.get("set_values", {}).items():
                row[k] = json.dumps(v)

    def advance(self):
        return workflow._advance_checks(self.tx, self.wf, self.sa, {}, False, self.state)

    def test_commands_run_in_order_and_failure_routes_with_tail(self):
        self.advance()
        self.assertEqual([r["command_id"] for r in self.rows], ["one"])
        self.assertEqual(self.rows[0]["workflow_run_id"], "w")
        self.assertEqual(self.rows[0]["status"], "running")
        with mock.patch.object(workflow.delegation, "result", return_value={"passed": True, "exitCode": 0}):
            self.advance()
        self.advance()
        self.assertEqual([r["command_id"] for r in self.rows], ["one", "two"])
        self.assertEqual([r["ordinal"] for r in self.rows], [1, 2])
        with mock.patch.object(workflow.delegation, "result", return_value={"passed": False, "exitCode": 1, "outputTail": "bad output"}):
            self.advance()
        self.advance()
        self.assertEqual(workflow._route.call_args.args[3], "fail")
        self.assertEqual([r["command_id"] for r in self.rows], ["one", "two"])
        self.assertEqual([r["status"] for r in self.rows], ["succeeded", "failed"])
        result = self.tx.update.call_args.args[2]["validation_json"]
        self.assertIn("one: passed", result["report"])
        self.assertIn("two: failed\nbad output", workflow._validation_text(result))

    def test_check_command_is_spawned_in_workspace_with_catalog_command(self):
        self.state["checks"] = ["one"]
        with mock.patch.object(workflow.delegation, "spawn", return_value={"dir": "/run"}) as spawn:
            self.advance()
        request = self.rows[0]
        spawn.assert_called_once_with(
            "/tmp/check-01", "/workspace", request,
            workflow.delegation.run_config(self.wf)["commands"]["one"])
        self.assertEqual(request["command_id"], "one")
        self.assertEqual(request["workflow_run_id"], "w")
        self.assertEqual(request["stage_attempt_id"], "s")
        self.assertEqual(json.loads(request["argv_json"]), ["one"])

    def test_reuse_success_on_current_fingerprint(self):
        self.state.update(checks=["one"], reuseIfTested=True)
        self.rows.append({"id": "old", "stage_attempt_id": "old", "command_id": "one", "status": "succeeded", "ordinal": 1,
                          "result_json": json.dumps({"passed": True, "workspaceFingerprint": "fp"})})
        with mock.patch.object(workflow.delegation, "workspace_fingerprint", return_value="fp"):
            self.advance()
        workflow.delegation.spawn.assert_not_called()
        self.advance()
        self.assertEqual(workflow._route.call_args.args[3], "pass")
        self.assertIn("one: reused", self.tx.update.call_args.args[2]["validation_json"]["report"])

    def test_reuse_does_not_skip_command_for_old_fingerprint(self):
        self.state.update(checks=["one"], reuseIfTested=True)
        self.rows.append({"id": "old", "workflow_run_id": "w", "stage_attempt_id": "old",
                          "command_id": "one", "status": "succeeded", "ordinal": 1,
                          "result_json": json.dumps({"passed": True, "workspaceFingerprint": "old-fp"})})
        with mock.patch.object(workflow.delegation, "workspace_fingerprint", return_value="new-fp"):
            self.advance()
        workflow.delegation.spawn.assert_called_once()
        self.assertEqual(self.rows[-1]["command_id"], "one")

    def test_reuse_does_not_skip_after_newer_failure_on_another_fingerprint(self):
        self.state.update(checks=["one"], reuseIfTested=True)
        for ordinal, status, fingerprint in ((1, "succeeded", "a"), (2, "failed", "b")):
            self.rows.append({"id": str(ordinal), "stage_attempt_id": "old", "command_id": "one",
                              "status": status, "ordinal": ordinal,
                              "result_json": json.dumps({"workspaceFingerprint": fingerprint})})
        with mock.patch.object(workflow.delegation, "workspace_fingerprint", return_value="a"):
            self.advance()
        workflow.delegation.spawn.assert_called_once()
        self.assertEqual(self.rows[-1]["status"], "running")

    def test_empty_selection_passes(self):
        self.state["checks"] = []
        self.advance()
        self.assertEqual(workflow._route.call_args.args[3], "pass")
        workflow.delegation.spawn.assert_not_called()

    def test_entry_selects_checks_from_workspace_changes(self):
        stage = SimpleNamespace(id="check", checks="ci", max_visits=1)
        self.wf.update({"config_json": json.dumps({"delegatedCommands": {
            "checkSets": {"ci": {"run": [], "reuseIfTested": False}}}})})
        self.tx.create.return_value = "attempt"
        with mock.patch.object(workflow, "_visit", return_value=(1, 1, 1)), \
             mock.patch.object(workflow, "_write_private"), \
             mock.patch.object(workflow, "workflow_dir", return_value="/tmp/wf"), \
             mock.patch.object(workflow.delegation, "run_config", return_value={"checkSets": {
                 "ci": {"run": [], "reuseIfTested": True}}}), \
             mock.patch.object(workflow.delegation, "changed_paths", return_value=["src/a.py"]) as changed, \
             mock.patch.object(workflow.delegation, "select_checks", return_value=["one"]) as select, \
             mock.patch.object(workflow.validation, "spawn") as legacy_spawn:
            workflow._enter_validation(self.tx, "w", stage, {"stateDir": "/state"}, None)
        changed.assert_called_once_with("/workspace")
        select.assert_called_once_with({"run": [], "reuseIfTested": True}, ["src/a.py"])
        self.assertEqual(self.tx.create.call_args.args[1]["validation_json"], {
            "state": "running", "checks": ["one"], "reuseIfTested": True})
        legacy_spawn.assert_not_called()

    def test_validation_stage_without_checks_keeps_legacy_runner(self):
        stage = SimpleNamespace(id="validation", checks=None, max_visits=1)
        proc = {"pid": 123}
        with mock.patch.object(workflow, "_visit", return_value=(1, 1, 1)), \
             mock.patch.object(workflow, "_write_private"), \
             mock.patch.object(workflow, "workflow_dir", return_value="/tmp/wf"), \
             mock.patch.object(workflow.validation, "spawn", return_value=proc) as spawn:
            workflow._enter_validation(self.tx, "w", stage, {"stateDir": "/state"}, None)
        spawn.assert_called_once_with("/tmp/wf/01-validation", "/workspace",
                                      json.loads(self.wf["config_json"]))
        self.assertEqual(self.tx.create.call_args.args[1]["validation_json"], {
            "state": "running", "process": proc})
