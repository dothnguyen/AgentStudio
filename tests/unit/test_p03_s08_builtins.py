import os
import unittest

from agent_studio import bugfile, workflow, workflowdef


class BuiltinTests(unittest.TestCase):
    def test_bug_builtins_and_prompts(self):
        root = workflow.BUILTIN_DIR
        expectations = {"board-triage": ("workspace_write", False), "board-develop-bug": ("workspace_write", True),
                        "board-test-bug": ("read_only", False), "board-review-bug": ("read_only", False)}
        for name, (permission, validation) in expectations.items():
            with self.subTest(name=name):
                definition = workflowdef.load("/missing", name, root)
                self.assertEqual(len({stage.role for stage in definition.stages if stage.type == "agent"}), 1)
                self.assertEqual(definition.stages[0].permission, permission)
                self.assertEqual(any(stage.type == "validation" for stage in definition.stages), validation)
        def prompt(name):
            with open(os.path.join(root, "prompts", name), encoding="utf-8") as f:
                return f.read()
        triage = prompt("board-triage.md")
        self.assertIn("Severity:", triage)
        for section in bugfile.REQUIRED_SECTIONS:
            self.assertIn("## " + section, triage)
        develop = prompt("board-develop-bug.md")
        for word in ("regression test", "Evidence", "history-changing git", "FINDINGS"):
            self.assertIn(word, develop)
        review = prompt("board-review-bug.md")
        self.assertIn("commit", review)
        self.assertIn("BUG-", review)
