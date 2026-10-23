import json
import os
import tempfile
import unittest
from unittest import mock

from backend.agent_studio import dispatch, state, workflow, workflowdef
from backend.agent_studio.protocol import AsError, BAD_REQUEST
from backend.agent_studio.store import Store


class BoardBuiltinTests(unittest.TestCase):
    def test_definitions_load_with_required_shapes(self):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        for name, permission in (("board-refine", "workspace_write"), ("board-develop", "workspace_write"),
                                 ("board-test", "read_only"), ("board-review", "read_only")):
            definition = workflowdef.load(root.name, name, workflow.BUILTIN_DIR)
            agents = [s for s in definition.stages if s.type == "agent"]
            self.assertEqual(len({s.role for s in agents}), 1)
            self.assertEqual(agents[0].permission, permission)
        develop = workflowdef.load(root.name, "board-develop", workflow.BUILTIN_DIR)
        self.assertEqual(develop.stages[0].max_visits, 3)
        self.assertEqual(develop.stages[1].next["fail"], "work")

    def test_prompts_contain_operator_requirements(self):
        expected = {"board-develop": ("Evidence", "history-changing git", "FINDINGS"),
                    "board-review": ("commit",)}
        for name, words in expected.items():
            with open(workflow.BUILTIN_DIR + "/prompts/" + name + ".md") as f:
                text = f.read()
            for word in words:
                self.assertIn(word, text)

    def test_dispatch_rejects_seed_in_both_start_forms(self):
        base = {"teamId": "00000000-0000-4000-8000-000000000001", "text": "task", "seed": {}}
        forms = (dict(base, definition="example"),
                 dict(base, developerAgentId="00000000-0000-4000-8000-000000000002",
                      reviewerAgentId="00000000-0000-4000-8000-000000000003"))
        for args in forms:
            with self.assertRaises(AsError) as raised:
                dispatch._validate_workflow_start(args)
            self.assertEqual(raised.exception.code, BAD_REQUEST)

    def test_workspace_cannot_override_reserved_board_definition(self):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        workflows = os.path.join(root.name, ".agent-studio", "workflows")
        os.makedirs(workflows)
        with open(os.path.join(workflows, "board-test.json"), "w", encoding="utf-8") as f:
            f.write("{}")
        with self.assertRaises(AsError) as raised:
            workflowdef.load(root.name, "board-test", workflow.BUILTIN_DIR)
        self.assertEqual(raised.exception.code, workflowdef.WORKFLOW_DEFINITION_INVALID)

    def test_direct_start_renders_findings_and_diff_seed_in_first_prompt(self):
        root = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        workflows = os.path.join(root.name, ".agent-studio", "workflows")
        os.makedirs(workflows)
        with open(os.path.join(workflows, "seed-test.json"), "w", encoding="utf-8") as f:
            json.dump({"version": 1, "description": "seed rendering test", "stages": [
                {"id": "work", "role": "QA", "permission": "read_only",
                 "prompt": "{{findings}}\n{{diff}}", "next": {"done": "$succeed"}}
            ]}, f)
        db_dir = tempfile.TemporaryDirectory()
        self.addCleanup(db_dir.cleanup)
        conn = state.connect(os.path.join(db_dir.name, "state.db"), role="coordinator", create=True)
        self.addCleanup(conn.close)
        state.migrate(conn, os.path.join(db_dir.name, "state.db"))
        store = Store(conn)
        with store.transaction() as tx:
            team = tx.create("team", {"name": "seed-test", "workspace": root.name})
            tx.transition("team", team, "running")
            agent = tx.create("agent", {"team_id": team, "ordinal": 0, "provider_id": "fake", "role": "QA",
                                        "display_name": "qa", "pane_state": "alive"})
            tx.transition("agent", agent, "idle")
            with mock.patch.object(workflow.gitws, "require_repo", return_value="base"), \
                 mock.patch.object(workflow.gitws, "dirty_entries", return_value=[]), \
                 mock.patch.object(workflow.validation, "load_config", return_value={
                     "validation": {"argv": ["true"], "timeoutMs": 1000},
                     "stageDeadlineMs": 1000, "workflowDeadlineMs": 1000}):
                run = workflow.start(tx, {"teamId": team, "definition": "seed-test", "text": "task",
                                          "seed": {"findings": ["x1"], "diff": "d1"}},
                                     {"stateDir": db_dir.name, "debug": True})
        prompt_path = conn.execute("SELECT prompt_path FROM stage_attempts WHERE workflow_run_id = ?",
                                   (run["workflowRunId"],)).fetchone()[0]
        with open(prompt_path, encoding="utf-8") as f:
            prompt = f.read()
        self.assertIn("x1", prompt)
        self.assertIn("d1", prompt)
