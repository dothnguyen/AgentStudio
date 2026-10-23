import json
import os
import tempfile
import unittest

from backend.agent_studio import board_config
from backend.agent_studio.protocol import AsError, BOARD_CONFIG_INVALID


class BoardConfigTests(unittest.TestCase):
    def setUp(self):
        self.workspace = tempfile.TemporaryDirectory()
        os.mkdir(os.path.join(self.workspace.name, ".agent-studio"))

    def tearDown(self):
        self.workspace.cleanup()

    def write(self, value):
        with open(os.path.join(self.workspace.name, ".agent-studio", "board.json"), "w") as f:
            json.dump(value, f)

    def test_missing_returns_defaults(self):
        self.assertEqual(board_config.load(self.workspace.name), board_config._defaults())

    def test_partial_values_merge(self):
        self.write({"maxParallelDev": 4, "columns": {"test": {"role": "Tester"}}})
        result = board_config.load(self.workspace.name)
        self.assertEqual(result["maxParallelDev"], 4)
        self.assertEqual(result["columns"]["test"]["role"], "Tester")
        self.assertEqual(result["columns"]["test"]["definition"], "board-test")

    def test_invalid_values_report_all_paths(self):
        self.write({"version": True, "maxParallelDev": True, "unexpected": 1,
                    "columns": {"unknown": {}, "test": {"nope": 1}}})
        with self.assertRaises(AsError) as raised:
            board_config.load(self.workspace.name)
        self.assertEqual(raised.exception.code, BOARD_CONFIG_INVALID)
        self.assertEqual({x["path"] for x in raised.exception.data["errors"]},
                         {"version", "maxParallelDev", "unexpected", "columns.unknown", "columns.test.nope"})

    def test_max_parallel_dev_rejects_string_and_out_of_range_values(self):
        for value in ("2", 17):
            with self.subTest(value=value):
                self.write({"maxParallelDev": value})
                with self.assertRaises(AsError) as raised:
                    board_config.load(self.workspace.name)
                self.assertEqual(raised.exception.code, BOARD_CONFIG_INVALID)
                self.assertEqual([x["path"] for x in raised.exception.data["errors"]], ["maxParallelDev"])

    def test_invalid_json_is_root_error(self):
        with open(os.path.join(self.workspace.name, ".agent-studio", "board.json"), "w") as f:
            f.write("{")
        with self.assertRaises(AsError) as raised:
            board_config.load(self.workspace.name)
        self.assertEqual(raised.exception.data["errors"][0]["path"], "$")

    def test_roster_rejects_written_role_and_lists_default_unstaffed(self):
        self.write({"columns": {"test": {"role": "Nobody"}}})
        with self.assertRaises(AsError) as raised:
            board_config.load(self.workspace.name, {"QA"})
        self.assertEqual(raised.exception.data["errors"][0]["path"], "columns.test.role")
        os.unlink(os.path.join(self.workspace.name, ".agent-studio", "board.json"))
        self.assertIn("test", board_config.load(self.workspace.name, {"TeamLead"})["unstaffed"])

    def test_current_uses_frozen_board_config(self):
        frozen = {"version": 1, "columns": {}}
        class Conn:
            def execute(self, *_args):
                return self
            def fetchone(self):
                return (json.dumps(frozen),)
        class Tx:
            conn = Conn()
        self.assertEqual(board_config.current(Tx(), self.workspace.name, set()), frozen)
