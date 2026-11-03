import json
import os
import tempfile
import unittest
from unittest.mock import patch

import tests.helpers  # noqa: F401
from agent_studio import workflowdef, workflow, cli, dispatch, mcpserver
from agent_studio.protocol import AsError


class StepTests(unittest.TestCase):
    def parse(self, steps, **extra):
        return workflowdef.parse_obj(dict(version=2, role="worker", steps=steps, **extra), "flow.yaml",
                                     {"workflows/prompts/work.md": "Do {{task}}"})

    def test_kinds_routing_and_frozen_round_trip(self):
        d = self.parse([{"id": "work", "agent": {"prompt": "work.md", "access": "write", "delegates": ["test-unit"]}},
                        {"id": "check", "check": {"checks": "code"}},
                        {"id": "act", "action": "merge"},
                        {"id": "ask", "approval": {"ask": "Publish?"}}])
        a, b, c, e = d.stages
        self.assertEqual((a.kind, a.role, a.permission, a.prompt_source, a.delegates),
                         ("verdict", "worker", "workspace_write", "workflows/prompts/work.md", ("test-unit",)))
        self.assertEqual((b.kind, b.checks, c.kind, c.step_value, e.kind, e.step_value),
                         ("validation", "code", "action", "merge", "approval", "Publish?"))
        self.assertEqual([dict(x.next) for x in d.stages], [
            {"pass": "check", "fail": "$fail"}, {"pass": "act", "fail": "$fail"},
            {"pass": "ask", "fail": "$fail"}, {"pass": "$succeed", "fail": "$fail"}])
        self.assertEqual(workflowdef.from_json(json.loads(workflowdef.to_json(d))), d)

    def test_retry_sets_earlier_visit_limit(self):
        d = self.parse([{"id": "a", "agent": {"prompt": "work.md", "access": "read"}},
                        {"id": "b", "check": {"checks": "code"},
                         "onFail": {"retry": "a", "max": 3, "then": "end-fail"}}])
        self.assertEqual((d.stages[0].max_visits, d.stages[0].permission, d.stages[1].next["fail"]),
                         (4, "read_only", "a"))

    def test_large_retry_limit_round_trips_but_frozen_stages_remain_bounded(self):
        d = self.parse([{"id": "a", "check": {"checks": "code"}},
                        {"id": "b", "check": {"checks": "code"},
                         "onFail": {"retry": "a", "max": 10, "then": "end-fail"}}])
        frozen = json.loads(workflowdef.to_json(d))
        self.assertEqual(workflowdef.from_json(frozen), d)
        self.assertEqual(d.stages[0].max_visits, 11)
        del frozen["compiledSteps"]
        with self.assertRaises(AsError):
            workflowdef.from_json(frozen)
        legacy = workflowdef.parse_obj({"version": 2, "stages": [{"id": "a", "type": "validation"}]}, "flow.yaml")
        frozen = json.loads(workflowdef.to_json(legacy))
        frozen["stages"][0]["maxVisits"] = 11
        with self.assertRaises(AsError):
            workflowdef.from_json(frozen)

    def test_step_routes_can_end_explicitly_and_prompt_paths_with_slash_are_preserved(self):
        d = workflowdef.parse_obj(
            {"version": 2, "role": "worker", "steps": [
                {"id": "work", "agent": {"prompt": "custom/work.md", "access": "read"},
                 "onPass": "end-pass", "onFail": "end-fail"},
            ]}, "flow.yaml", {"custom/work.md": "Do {{task}}"})
        stage = d.stages[0]
        self.assertEqual((stage.prompt_source, stage.next["pass"], stage.next["fail"]),
                         ("custom/work.md", "$succeed", "$fail"))

    def test_retry_then_must_be_end_fail_and_max_must_be_positive_integer(self):
        invalid = [
            {"retry": "a", "max": 1, "then": "end-pass"},
            {"retry": "a", "max": 0, "then": "end-fail"},
            {"retry": "a", "max": True, "then": "end-fail"},
        ]
        for retry in invalid:
            with self.subTest(retry=retry), self.assertRaises(AsError):
                self.parse([{"id": "a", "action": "merge"},
                            {"id": "b", "check": {"checks": "code"}, "onFail": retry}])

    def test_retry_max_is_additional_visits_and_last_step_defaults_to_success(self):
        d = self.parse([
            {"id": "a", "agent": {"prompt": "work.md", "access": "write"}},
            {"id": "b", "check": {"checks": "code"},
             "onFail": {"retry": "a", "max": 1, "then": "end-fail"}},
        ])
        self.assertEqual(d.stages[0].max_visits, 2)
        self.assertEqual(d.stages[1].next["pass"], "$succeed")
        self.assertEqual(d.stages[1].next["fail"], "a")

    def test_invalid_steps_are_rejected(self):
        cases = [[], [{"id": "a", "action": "x", "onFail": {"retry": "b", "max": 1, "then": "end-fail"}}, {"id": "b", "action": "x"}],
                 [{"id": "a", "action": "x"}, {"id": "b", "action": "x", "onFail": {"retry": "a", "max": 0, "then": "end-fail"}}],
                 [{"id": "a", "action": "x", "approval": {"ask": "x"}}]]
        for steps in cases:
            with self.subTest(steps=steps), self.assertRaises(AsError):
                self.parse(steps)
        with self.assertRaises(AsError):
            self.parse([{"id": "a", "action": "x"}], stages=[{"id": "legacy", "type": "validation"}])
        with self.assertRaises(AsError):
            workflowdef.parse_obj({"version": 2}, "flow.yaml")

    def test_steps_are_only_valid_for_version_two(self):
        with self.assertRaises(AsError) as e:
            workflowdef.parse_obj({"version": 1, "role": "worker", "steps": [
                {"id": "a", "action": "merge"},
            ]}, "flow.yaml")
        self.assertEqual(e.exception.code, workflowdef.WORKFLOW_DEFINITION_INVALID)

    def test_unknown_placeholder_is_rejected(self):
        with self.assertRaises(AsError):
            workflowdef.parse_obj({"version": 2, "role": "worker", "steps": [{"id": "a", "agent": {"prompt": "work.md", "access": "read"}}]},
                                  "flow.yaml", {"workflows/prompts/work.md": "{{unknown}}"})

    def test_loader_reads_step_prompt_from_workflows_prompts(self):
        with tempfile.TemporaryDirectory() as workspace:
            folder = os.path.join(workspace, ".agent-studio", "workflows")
            os.makedirs(os.path.join(folder, "prompts"))
            with open(os.path.join(folder, "prompts", "work.md"), "w") as f:
                f.write("Hello {{task}}")
            with open(os.path.join(folder, "flow.json"), "w") as f:
                json.dump({"version": 2, "role": "worker", "steps": [
                    {"id": "a", "agent": {"prompt": "work.md", "access": "read"}}]}, f)
            self.assertEqual(workflowdef.load(workspace, "flow").stages[0].prompt, "Hello {{task}}")

    def test_start_refuses_unsupported_kinds(self):
        for kind, value in (("action", "merge"),):
            d = self.parse([{"id": "a", kind: value}])
            class Tx:
                def get(self, *args):
                    return {"status": "running", "id": "team"}
            with patch.object(workflow.tasks, "run_workspace", return_value="/tmp"), patch.object(workflow.workflowdef, "load", return_value=d):
                with self.assertRaises(AsError) as e:
                    workflow._start_definition(Tx(), {"teamId": "team", "definition": "x"}, {})
            self.assertEqual((e.exception.code, str(e.exception)), ("WORKFLOW_DEFINITION_INVALID", "step kind not supported yet"))


class ApprovalInterfaceTests(unittest.TestCase):
    def test_cli_approval_decisions_and_validation(self):
        run = "00000000-0000-4000-8000-000000000001"
        for option, value in (("--yes", True), ("--no", False)):
            request = cli._human_request(["workflow", "approve", run, "gate", option, "--note", "change it"])
            self.assertEqual(request["command"], "workflow.approve")
            self.assertEqual(dispatch._validate_workflow_approve(request["args"]),
                             {"workflowRunId": run, "stage": "gate", "approve": value, "note": "change it"})
            self.assertTrue(request["idempotencyKey"])
        with self.assertRaises(AsError):
            dispatch._validate_workflow_approve({"workflowRunId": run, "stage": "gate", "approve": "yes"})
        with self.assertRaises(AsError):
            cli._human_request(["workflow", "approve", run, "gate"])

    def test_mcp_approval_is_write_gated_and_forwards_arguments(self):
        self.assertNotIn("workflow_approve", {t["name"] for t in mcpserver.operator_tools(False)})
        self.assertIn("workflow_approve", {t["name"] for t in mcpserver.operator_tools(True)})
        args = {"workflowRunId": "run", "stage": "gate", "approve": False, "note": "fix"}
        with patch.object(mcpserver, "_call", return_value={"outcome": "fail"}) as call:
            mcpserver._operator_tool_call("workflow_approve", args, {"allowWrites": True, "session": "s"}, 1)
        self.assertEqual(call.call_args.args[:3], ("workflow.approve", args, True))
