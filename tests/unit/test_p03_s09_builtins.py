import os
import unittest

from agent_studio import board, roles, workflow, workflowdef


ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")


class BuiltinTests(unittest.TestCase):
    def test_board_unpack_definition_prompt_and_feature_task(self):
        definition = workflowdef.load("/missing", "board-unpack", workflow.BUILTIN_DIR)
        self.assertEqual([stage.role for stage in definition.stages if stage.type == "agent"], ["ProductOwner"])
        self.assertEqual(definition.stages[0].permission, "workspace_write")
        self.assertFalse(any(stage.type == "validation" for stage in definition.stages))
        with open(os.path.join(workflow.BUILTIN_DIR, "prompts", "board-unpack.md")) as f:
            prompt = f.read()
        for text in ("tickets.json", "dependsOn", "questions", "history-changing git"):
            self.assertIn(text, prompt)
        task = board._task({"key": "T-001", "kind": "feature", "title": "Feature", "story_path": None,
                            "brief_path": "briefs/x.md", "out_dir": "plans/x"})
        self.assertIn("Brief: briefs/x.md", task)
        self.assertIn("Out: plans/x", task)

    def test_product_owner_configures_cleanly(self):
        self.assertEqual({agent["role"] for agent in roles.load_team(ROOT)},
                         {"TeamLead", "Developer", "QA", "ProductOwner"})
        self.assertIn("ProductOwner", roles.load_config(ROOT)["roles"])
        context = roles.context_for(ROOT, "ProductOwner")
        self.assertTrue(context["configured"])
        self.assertEqual(context["warnings"], [])
