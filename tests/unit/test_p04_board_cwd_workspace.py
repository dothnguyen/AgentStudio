"""The board and ticket commands find the workspace from the current directory, like the team commands."""
import os
import shutil
import tempfile
import unittest

import tests.helpers  # noqa: F401
from agent_studio import boardcli
from agent_studio.protocol import AsError


class Args:
    def __init__(self, workspace=None):
        self.workspace = workspace


class CwdWorkspace(unittest.TestCase):
    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="as-cwd-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        os.makedirs(os.path.join(self.root, ".agent-studio"))
        with open(os.path.join(self.root, ".agent-studio", "workspace.json"), "w") as f:
            f.write('{"id": "00000000-0000-4000-8000-000000000001", "name": "w", "version": 1}')
        self.sub = os.path.join(self.root, "a", "b")
        os.makedirs(self.sub)
        self.old = os.getcwd()
        self.addCleanup(os.chdir, self.old)

    def test_found_from_the_workspace_folder_and_from_below_it(self):
        for where in (self.root, self.sub):
            os.chdir(where)
            self.assertEqual(boardcli._workspace(Args()), self.root)

    def test_explicit_workspace_wins(self):
        os.chdir(self.sub)
        self.assertEqual(boardcli._workspace(Args("/somewhere/else")), "/somewhere/else")

    def test_outside_any_workspace_says_how_to_init(self):
        outside = os.path.realpath(tempfile.mkdtemp(prefix="as-none-"))
        self.addCleanup(shutil.rmtree, outside, True)
        os.chdir(outside)
        with self.assertRaises(AsError) as c:
            boardcli._workspace(Args())
        self.assertEqual(c.exception.code, "WORKSPACE_NOT_FOUND")


if __name__ == "__main__":
    unittest.main()
