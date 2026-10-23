import json
import os
import tempfile
import unittest

from agent_studio import coordinator, dispatch
from agent_studio.protocol import AsError, BAD_REQUEST, STORY_PATH_INVALID
from tests.unit.test_p03_s01_tickets import fresh


class BugCreateTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.conn, self.store = fresh()
        with open(os.path.join(self.root, "trace.txt"), "w") as f:
            f.write("trace")

    def test_bug_is_created_in_triage_with_attachment_and_default_title(self):
        args = dispatch._validate_ticket_create({"workspace": self.root, "kind": "bug", "text": "Login crash\ndetails", "attachments": ["trace.txt"]})
        with self.store.transaction(actor="operator") as tx:
            receipt = coordinator.HANDLERS["ticket.create"](args, tx, {})
        self.assertEqual((receipt["ticket"]["status"], receipt["ticket"]["raw_text"], receipt["ticket"]["title"]), ("triage", "Login crash\ndetails", "Login crash"))
        self.assertEqual(json.loads(receipt["ticket"]["attachments_json"]), ["trace.txt"])
        self.assertEqual(receipt["parsed"], {"ids": [], "resolved": [], "unresolved": []})

    def test_bad_bug_inputs_are_refused(self):
        cases = [({"kind": "bug", "text": " "}, BAD_REQUEST), ({"kind": "bug", "text": "x", "storyPath": "a.md"}, BAD_REQUEST), ({"kind": "feature", "storyPath": "a.md"}, BAD_REQUEST), ({"kind": "bug", "text": "x", "attachments": ["missing"]}, STORY_PATH_INVALID), ({"kind": "bug", "text": "x", "attachments": ["../escape"]}, STORY_PATH_INVALID)]
        for args, code in cases:
            with self.subTest(args=args):
                with self.assertRaises(AsError) as cm:
                    dispatch._validate_ticket_create({"workspace": self.root, **args})
                self.assertEqual(cm.exception.code, code)
