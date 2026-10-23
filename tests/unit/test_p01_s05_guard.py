"""P01-S05/S06 guard: the definition engine never branches on a role name, a stage id, or a provider ID.
Docstrings and comments are ignored; names and string constants are checked."""
import ast
import os
import re
import unittest

import tests.helpers  # noqa: F401

BACKEND = os.path.join(os.path.dirname(__file__), "..", "..", "backend", "agent_studio")
FORBIDDEN = re.compile(r"\b(developer|reviewer|teamlead|qa|codex|claude|agy|opencode|fake|develop|final|tests)\b",
                       re.I)


def tree(name):
    with open(os.path.join(BACKEND, name), encoding="utf-8") as f:
        return ast.parse(f.read())


def words(node):
    """Names, attributes, and string constants under node, minus docstrings."""
    skip = set()
    for n in ast.walk(node):
        if isinstance(n, (ast.FunctionDef, ast.ClassDef, ast.Module)) and n.body \
                and isinstance(n.body[0], ast.Expr) and isinstance(getattr(n.body[0], "value", None), ast.Constant):
            skip.add(id(n.body[0].value))
    for n in ast.walk(node):
        if isinstance(n, ast.Name):
            yield n.id
        elif isinstance(n, ast.Attribute):
            yield n.attr
        elif isinstance(n, ast.arg):
            yield n.arg
        elif isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in skip:
            yield n.value


def hits(node):
    return sorted({m.group(0) for w in words(node) for m in [FORBIDDEN.search(w)] if m})


class NoNamesInTheEngine(unittest.TestCase):
    def test_workflowdef_and_prompts_are_clean(self):
        for name in ("workflowdef.py", "prompts.py"):
            self.assertEqual(hits(tree(name)), [], name)

    def test_the_whole_of_workflow_py_is_clean(self):
        mod = tree("workflow.py")
        # P00_FORM is the one documented place that maps the P00 command form onto the built-in definition.
        mod.body = [n for n in mod.body
                    if not (isinstance(n, ast.Assign) and any(getattr(t, "id", "") == "P00_FORM" for t in n.targets))]
        self.assertEqual(hits(mod), [])
        self.assertTrue(any(isinstance(n, ast.FunctionDef) and n.name == "_advance_definition" for n in mod.body))

    def test_tickets_is_clean(self):
        self.assertEqual(hits(tree("tickets.py")), [])

    def test_worktrees_is_clean(self):
        self.assertEqual(hits(tree("worktrees.py")), [])

    def test_board_modules_are_clean(self):
        for name in ("board.py", "board_config.py"):
            self.assertEqual(hits(tree(name)), [], name)

    def test_the_guard_catches_a_violation(self):
        bad = ast.parse("def f(x):\n    return x.role == 'QA' or x.stage == 'develop'\n")
        self.assertEqual(hits(bad), ["QA", "develop"])
        self.assertEqual(hits(ast.parse('def f():\n    """Developer docs."""\n    return 1\n')), [])


if __name__ == "__main__":
    unittest.main()
