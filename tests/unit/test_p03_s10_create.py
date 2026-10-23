import os
import tempfile
import unittest

from agent_studio import cli, coordinator, dispatch, tickets
from agent_studio.protocol import AsError, BAD_REQUEST, STORY_PATH_INVALID, TICKET_TRANSITION_INVALID
from tests.unit.test_p03_s01_tickets import fresh


class FeatureCreateTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.root, "phases"))
        with open(os.path.join(self.root, "brief.md"), "w") as f:
            f.write("# Excellent feature\n")
        self.conn, self.store = fresh()

    def create(self, **extra):
        values = {"workspace": self.root, "kind": "feature", "briefPath": "brief.md", "outDir": "phases/phase-04/"}
        values.update(extra)
        args = dispatch._validate_ticket_create(values)
        with self.store.transaction() as tx:
            return coordinator._handle_ticket_create(args, tx, {})

    def test_feature_create_uses_brief_and_normalizes_output_directory(self):
        got = self.create()
        self.assertEqual((got["ticket"]["status"], got["ticket"]["brief_path"], got["ticket"]["out_dir"], got["ticket"]["title"]),
                         ("ready_unpack", "brief.md", "phases/phase-04", "Excellent feature"))
        self.assertEqual((got["dependsOn"], got["parsed"]), ([], {"ids": [], "resolved": [], "unresolved": []}))

    def test_feature_invalid_arguments_are_refused(self):
        cases = [({"outDir": "/tmp/x"}, STORY_PATH_INVALID), ({"outDir": "phases/../x"}, STORY_PATH_INVALID),
                 ({"outDir": "phases"}, STORY_PATH_INVALID), ({"outDir": "other/x"}, STORY_PATH_INVALID),
                 ({"briefPath": "missing.md"}, STORY_PATH_INVALID), ({"outDir": None}, BAD_REQUEST),
                 ({"storyPath": "brief.md"}, BAD_REQUEST), ({"text": "x"}, BAD_REQUEST),
                 ({"dependsOn": []}, BAD_REQUEST), ({"noDeps": False}, BAD_REQUEST)]
        for values, code in cases:
            with self.subTest(values=values):
                with self.assertRaises(AsError) as cm:
                    self.create(**values)
                self.assertEqual(cm.exception.code, code)

    def test_approve_rejects_story_and_releases_all_waiting_children(self):
        feature = self.create()["ticket"]
        with self.store.transaction() as tx:
            feature = tickets.move(tx, feature, "unpacking", "coordinator")
            feature = tickets.move(tx, feature, "unpacked", "coordinator")
            first = tickets.create(tx, self.root, "story", {"title": "First", "parent_ticket_id": feature["id"]}, hold=True)
            second = tickets.create(tx, self.root, "story", {"title": "Second", "parent_ticket_id": feature["id"]}, hold=True)
            approved = coordinator._handle_ticket_approve({"workspace": self.root, "key": feature["key"]}, tx, {})
            self.assertEqual(approved["approved"], [first["key"], second["key"]])
            self.assertEqual([tickets.get(tx, self.root, child["key"])["status"] for child in (first, second)],
                             ["refine", "refine"])
            story = tickets.create(tx, self.root, "story", {"title": "Story"})
            with self.assertRaises(AsError) as cm:
                coordinator._handle_ticket_approve({"workspace": self.root, "key": story["key"]}, tx, {})
        self.assertEqual(cm.exception.code, TICKET_TRANSITION_INVALID)

    def test_approve_rejects_feature_that_is_not_unpacked(self):
        feature = self.create()["ticket"]
        statuses = ("ready_unpack", "unpacking", "done")
        with self.store.transaction() as tx:
            for status in statuses:
                with self.subTest(status=status):
                    if status != "ready_unpack":
                        feature = tickets.move(tx, feature, "unpacking", "coordinator") if status == "unpacking" else feature
                    if status == "done":
                        feature = tickets.move(tx, feature, "unpacked", "coordinator")
                        feature = tickets.move(tx, feature, "done", "coordinator")
                    self.assertEqual(feature["status"], status)
                    with self.assertRaises(AsError) as cm:
                        coordinator._handle_ticket_approve({"workspace": self.root, "key": feature["key"]}, tx, {})
                    self.assertEqual(cm.exception.code, TICKET_TRANSITION_INVALID)

    def test_cli_builds_feature_create_and_approve_commands(self):
        created = cli._human_request(["ticket", "create", "--workspace", self.root, "--kind", "feature",
                                      "--brief", "brief.md", "--out", "phases/phase-04"])
        self.assertEqual(created["command"], "ticket.create")
        self.assertEqual(created["args"], {"workspace": self.root, "kind": "feature", "briefPath": "brief.md", "outDir": "phases/phase-04"})
        approved = cli._human_request(["ticket", "approve", "--workspace", self.root, "T-001"])
        self.assertEqual((approved["command"], approved["args"]), ("ticket.approve", {"workspace": self.root, "key": "T-001"}))

    def test_cli_approve_keeps_ticket_and_explicit_idempotency_keys_distinct(self):
        approved = cli._human_request(["ticket", "approve", "--workspace", self.root, "T-001",
                                       "--key", "approve-idempotency-key"])
        self.assertEqual(approved["args"], {"workspace": self.root, "key": "T-001"})
        self.assertEqual(approved["idempotencyKey"], "approve-idempotency-key")
