import os
import tempfile
import unittest

from tests.unit.test_p03_s01_tickets import fresh
from agent_studio import tickets
from agent_studio.protocol import AsError, STORY_PATH_INVALID


class TicketStoryParsing(unittest.TestCase):
    def test_workspace_path_accepts_story_and_refuses_unsafe_paths(self):
        root = tempfile.mkdtemp()
        os.makedirs(os.path.join(root, "phases"))
        with open(os.path.join(root, "phases", "x.md"), "w", encoding="utf-8") as f:
            f.write("# x\n")
        with open(os.path.join(root, "x.txt"), "w", encoding="utf-8") as f:
            f.write("x")
        os.mkdir(os.path.join(root, "directory.md"))
        outside = os.path.join(tempfile.mkdtemp(), "outside.md")
        open(outside, "w", encoding="utf-8").close()
        os.symlink(outside, os.path.join(root, "escape.md"))
        self.assertEqual(tickets.check_workspace_path(root, "phases/x.md"), "phases/x.md")
        for path in ("../x.md", outside, "escape.md", "missing.md", "directory.md", "x.txt"):
            with self.subTest(path=path), self.assertRaises(AsError) as cm:
                tickets.check_workspace_path(root, path)
            self.assertEqual(cm.exception.code, STORY_PATH_INVALID)

    def test_parse_resolve_and_title(self):
        self.assertEqual(tickets.parse_depends("Depends on: P03-S01, P03-S04 (x)"), ["P03-S01", "P03-S04"])
        self.assertEqual(tickets.parse_depends("Depends on: — (P01 S01–S09 engine as built)"), [])
        self.assertEqual(tickets.parse_depends("# no dependencies"), [])
        conn, store = fresh()
        with store.transaction() as tx:
            story = tickets.create(tx, "/one", "story", {"title": "one", "story_path": "P03-S01-ticket-store-and-states.md"})
            self.assertEqual(tickets.resolve_depends(tx, "/one", ["P03-S01", "P03-S99"]),
                             {"resolved": [story["key"]], "unresolved": ["P03-S99"]})
            tickets.cancel(tx, story, "operator")
            self.assertEqual(tickets.resolve_depends(tx, "/one", ["P03-S01"]),
                             {"resolved": [], "unresolved": ["P03-S01"]})
        self.assertEqual(tickets.story_title("# A title\ntext", "fallback"), "A title")
        self.assertEqual(tickets.story_title("text", "fallback"), "fallback")
