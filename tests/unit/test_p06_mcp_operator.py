"""P06: the MCP server's operator mode - the person's own clients, read-only unless allowed to write."""
import io
import json
import unittest
from unittest import mock

from agent_studio import mcpserver

OP = {"workspace": "", "allowWrites": False, "session": "s1"}


def rpc(method, params=None, operator=None, rid=1):
    obj = {"jsonrpc": "2.0", "id": rid, "method": method}
    if params is not None:
        obj["params"] = params
    return mcpserver.handle(obj, "", "", operator=operator if operator is not None else OP)


def call(name, args=None, operator=None, rid=1):
    return rpc("tools/call", {"name": name, "arguments": args or {}}, operator, rid)["result"]


class OperatorTools(unittest.TestCase):
    def names(self, writes):
        return [t["name"] for t in rpc("tools/list", operator=dict(OP, allowWrites=writes))["result"]["tools"]]

    def test_read_only_by_default(self):
        names = self.names(False)
        self.assertIn("team_overview", names)
        self.assertNotIn("ticket_move", names)

    def test_writes_are_listed_when_allowed(self):
        names = self.names(True)
        for n in ("ticket_move", "ticket_unblock", "ticket_retry", "command_approve"):
            self.assertIn(n, names)

    def test_write_refused_without_the_flag(self):
        with mock.patch.object(mcpserver.dispatch, "handle_request") as h:
            r = call("ticket_unblock", {"key": "T-1"})
        self.assertTrue(r["isError"])
        self.assertEqual(r["code"], "FORBIDDEN")
        h.assert_not_called()

    def test_unknown_tool(self):
        self.assertEqual(rpc("tools/call", {"name": "shell", "arguments": {}})["error"]["code"], mcpserver.METHOD_NOT_FOUND)

    def test_read_goes_through_the_command_path_with_the_workspace(self):
        seen = {}

        def fake(req, require_id=False):
            seen.update(req)
            return {"ok": True, "data": {"tickets": [{"key": "T-1", "status": "backlog", "phase": "p", "title": "x"}]}}
        with mock.patch.object(mcpserver.dispatch, "handle_request", fake), \
                mock.patch.object(mcpserver.wsmod, "resolve", return_value={"path": "/w"}):
            r = call("ticket_list", {"status": "backlog"})
        self.assertFalse(r["isError"])
        self.assertEqual(seen["command"], "ticket.list")
        self.assertEqual(seen["args"], {"status": "backlog", "workspace": "/w"})
        self.assertNotIn("idempotencyKey", seen)

    def test_write_has_a_stable_key_per_request_and_session(self):
        keys = []

        def fake(req, require_id=False):
            keys.append(req["idempotencyKey"])
            return {"ok": True, "data": {"ticket": {"key": "T-1", "status": "dev-ready"}}}
        op = dict(OP, allowWrites=True)
        with mock.patch.object(mcpserver.dispatch, "handle_request", fake), \
                mock.patch.object(mcpserver.wsmod, "resolve", return_value={"path": "/w"}):
            call("ticket_unblock", {"key": "T-1"}, op, rid=7)
            call("ticket_unblock", {"key": "T-1"}, op, rid=7)
            call("ticket_unblock", {"key": "T-1"}, dict(op, session="s2"), rid=7)
        self.assertEqual(keys[0], keys[1])
        self.assertNotEqual(keys[0], keys[2])

    def test_command_errors_are_tool_results(self):
        from agent_studio.protocol import AsError
        with mock.patch.object(mcpserver.dispatch, "handle_request",
                               return_value={"ok": False, "error": {"code": "NOT_FOUND", "message": "no"}}), \
                mock.patch.object(mcpserver.wsmod, "resolve", return_value={"path": "/w"}):
            r = call("ticket_show", {"key": "T-9"})
        self.assertTrue(r["isError"])
        self.assertEqual(r["code"], "NOT_FOUND")


class OperatorMain(unittest.TestCase):
    def test_serve_needs_no_assignment_env(self):
        out = io.BytesIO()
        line = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping"}).encode() + b"\n"
        self.assertEqual(mcpserver.serve(io.BytesIO(line), out, operator=dict(OP)), 0)
        self.assertEqual(json.loads(out.getvalue())["result"], {})

    def test_config_text_names_each_client_and_the_windows_form(self):
        text = mcpserver.config_text("/home/u/.local/bin/agent-studio", "/w", True, "Ubuntu")
        for needle in ("claude mcp add", "codex mcp add", "[mcp_servers.agent-studio]", '"mcp"', "wsl.exe -d Ubuntu -e",
                       "--allow-writes", "--workspace"):
            self.assertIn(needle, text)

    def test_flags_that_need_operator(self):
        with mock.patch("sys.stderr", io.StringIO()):
            self.assertEqual(mcpserver.main(["--allow-writes"]), 2)
            self.assertEqual(mcpserver.main(["--bogus"]), 2)


if __name__ == "__main__":
    unittest.main()
