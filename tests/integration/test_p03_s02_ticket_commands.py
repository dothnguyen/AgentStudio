"""P03-S02 ticket commands use the inbox and share read-only CLI/serve output."""
import json
import os
import tempfile
import unittest

from tests.helpers import Sandbox, key, req


class TicketCommandIntegration(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox()
        rc, response, proc = self.sb.run("coordinator", "start")
        self.assertTrue(response["ok"], proc.stderr)
        self.workspace = tempfile.mkdtemp(prefix="as-ticket-ws-")
        os.makedirs(os.path.join(self.workspace, "phases"))
        with open(os.path.join(self.workspace, "phases", "P03-S01-a.md"), "w", encoding="utf-8") as f:
            f.write("# Ticket one\n")

    def tearDown(self):
        self.sb.cleanup()

    def test_create_is_idempotent_and_cli_show_matches_serve(self):
        args = {"workspace": self.workspace, "storyPath": "phases/P03-S01-a.md"}
        idem = key("ticket")
        _, first, _ = self.sb.request(req("ticket.create", args, idempotencyKey=idem))
        _, second, _ = self.sb.request(req("ticket.create", args, idempotencyKey=idem))
        self.assertTrue(first["ok"], first)
        self.assertEqual(first["data"], second["data"])
        self.assertEqual(first["data"]["ticket"]["key"], "T-001")
        _, conflict, _ = self.sb.request(req("ticket.create", dict(args, priority=9), idempotencyKey=idem))
        self.assertEqual(conflict["error"]["code"], "IDEMPOTENCY_CONFLICT")

        _, cli, _ = self.sb.run("ticket", "show", "T-001", "--workspace", self.workspace)
        process = self.sb.popen_serve()
        try:
            process.stdin.write(json.dumps(req("ticket.show", {"workspace": self.workspace, "key": "T-001"}, id="show")).encode() + b"\n")
            process.stdin.flush()
            served = json.loads(process.stdout.readline())
        finally:
            process.stdin.close()
            process.wait(10)
            process.stdout.close()
            process.stderr.close()
        self.assertEqual(json.dumps(cli["data"], separators=(",", ":")),
                         json.dumps(served["data"], separators=(",", ":")))
