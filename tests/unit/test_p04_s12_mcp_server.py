"""P04-S12: the board MCP server protocol, the agent ticket-add rules, idempotency, and canAddTickets."""
import json
import shutil
import os
import tempfile
import unittest
import uuid

from tests import helpers
from tests.helpers import fresh, make_repo
from agent_studio import boardmodel, mcpserver, teams
from agent_studio.protocol import AsError
from tests.unit.test_p04_s07_board_model import CONFIG_A

ROSTER_OK = uuid.uuid4()
ROSTER_NO = uuid.uuid4()
ASSIGNMENT = ROSTER_OK  # the active assignment of the allowed member


class ServerCase(unittest.TestCase):
    def setUp(self):
        self.ws = make_repo()
        self.addCleanup(helpers.reset_repo, self.ws)
        os.makedirs(os.path.join(self.ws, ".agent-studio"), exist_ok=True)
        with open(os.path.join(self.ws, ".agent-studio", "board.json"), "w") as f:
            json.dump(CONFIG_A, f)
        self.conn, self.store = fresh()
        with self.store.transaction() as tx:
            self.team = tx.create("team", {"name": "t", "workspace": self.ws})
            tx.transition("team", self.team, "running")
            self.allowed = tx.create("agent", {"team_id": self.team, "ordinal": 0, "provider_id": "fake",
                                               "role": "worker", "display_name": "allowed",
                                               "can_add_tickets": 1, "member_id": "allowed"})
            tx.transition("agent", self.allowed, "idle")
            tx.transition("agent", self.allowed, "busy")
            self.forbidden = tx.create("agent", {"team_id": self.team, "ordinal": 1, "provider_id": "fake",
                                                 "role": "worker", "display_name": "plain",
                                                 "can_add_tickets": 0, "member_id": "plain"})
            tx.transition("agent", self.forbidden, "idle")
            tx.transition("agent", self.forbidden, "busy")
        self.asg_ok = self.assignment(self.allowed, "running")
        self.asg_no = self.assignment(self.forbidden, "running")
        self.asg_done = self.assignment(self.allowed, "succeeded")

    def assignment(self, agent_id, status):
        with self.store.transaction() as tx:
            task = tx.create("task", {"team_id": self.team, "origin": "direct", "workspace": self.ws,
                                      "goal": "g"})
            tx.transition("task", task, "assigned")
            asg = tx.create("assignment", {"team_id": self.team, "task_id": task, "agent_id": agent_id,
                                           "attempt": 1, "policy": "read_only", "provider_id": "fake"})
            if status != "queued":
                tx.transition("assignment", asg, "claimed")
                if status != "claimed":
                    tx.transition("assignment", asg, "running")
                    if status != "running":
                        tx.transition("assignment", asg, status)
        return asg

    def add(self, assignment, title="a finding", **extra):
        with self.store.transaction() as tx:
            return boardmodel.mcp_ticket_add(tx, self.ws, dict(
                {"title": title, "priority": 100, "assignment": assignment}, **extra))

    def rpc(self, method, params=None, rid=1, assignment="x", agent="y", workspace="", raw=None):
        obj = raw if raw is not None else {"jsonrpc": "2.0", "id": rid, "method": method,
                                           **({"params": params} if params is not None else {})}
        return mcpserver.handle(obj, assignment, agent, workspace)


class Protocol(ServerCase):
    def test_initialize_tools_and_ping(self):
        got = self.rpc("initialize", {"protocolVersion": "2024-11-05"})
        self.assertEqual(got["result"]["serverInfo"]["name"], "agent-studio")
        self.assertEqual(got["result"]["protocolVersion"], "2024-11-05")
        listed = self.rpc("tools/list")
        names = [t["name"] for t in listed["result"]["tools"]]
        self.assertEqual(names, ["ticket_add", "ticket_update", "ticket_list", "ticket_show", "phase_list",
                                 "board_show"])
        self.assertEqual(self.rpc("ping")["result"], {})
        self.assertIsNone(self.rpc("notifications/initialized"))

    def test_errors_carry_jsonrpc_codes(self):
        unknown_tool = self.rpc("tools/call", {"name": "nope", "arguments": {}})
        self.assertEqual(unknown_tool["error"]["code"], -32601)
        unknown = self.rpc("resources/list")
        self.assertEqual(unknown["error"]["code"], -32601)
        broken = mcpserver.handle({"jsonrpc": "1.0", "id": 2, "method": "tools/list"}, "x", "y")
        self.assertEqual(broken["error"]["code"], -32600)
        not_json = mcpserver.handle("nonsense", "x", "y")
        self.assertEqual(not_json["error"]["code"], -32600)

    def test_command_errors_are_tool_results_with_the_code(self):
        from unittest import mock
        from agent_studio import dispatch
        err = {"ok": False, "error": {"code": "TICKET_NOT_FOUND", "message": "no", "retryable": False}}
        with mock.patch.object(dispatch, "handle_request", return_value=err):
            got = self.rpc("tools/call", {"name": "ticket_show", "arguments": {"key": "T-999"}},
                           assignment=self.asg_ok, agent=self.allowed, workspace=self.ws)
        self.assertTrue(got["result"]["isError"])
        self.assertEqual(got["result"]["code"], "TICKET_NOT_FOUND")
        self.assertIn("TICKET_NOT_FOUND", got["result"]["content"][0]["text"])
        # the same error as a protocol-level envelope (e.g. inside tools/call params validation)
        with mock.patch.object(dispatch, "handle_request", return_value=err):
            env = mcpserver.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                                    "params": {"name": "ticket_show", "arguments": {"key": "T-999"}}},
                                   "x", "y", self.ws)
        self.assertEqual(env["result"]["code"], "TICKET_NOT_FOUND")


class TicketAddRules(ServerCase):
    def test_creates_ticket_with_created_by_initial_status_and_phase(self):
        got = self.add(self.asg_ok, "review findings: errors are swallowed")
        ticket = got["ticket"]
        self.assertEqual((ticket["status"], ticket["phase"], ticket["createdByMember"],
                          ticket["createdByAssignment"]), ("open", "default", "allowed", self.asg_ok))
        self.assertEqual(got["dependsOn"], [])

    def test_phase_and_dependencies(self):
        with self.store.transaction() as tx:
            boardmodel.phase_add(tx, self.ws, {"id": "later", "name": "Later"})
        got = self.add(self.asg_ok, "for later", phase="later")
        self.assertEqual(got["ticket"]["phase"], "later")
        first = self.add(self.asg_ok, "the blocker")
        second = self.add(self.asg_ok, "the dependent", dependsOn=[first["ticket"]["key"]])
        self.assertEqual(second["dependsOn"], [first["ticket"]["key"]])
        with self.assertRaises(AsError) as caught:
            self.add(self.asg_ok, "bad dep", dependsOn=["T-999"])
        self.assertEqual(caught.exception.code, "TICKET_NOT_FOUND")
        with self.assertRaises(AsError) as caught:
            self.add(self.asg_ok, "closed phase", phase="nowhere")
        self.assertEqual(caught.exception.code, "PHASE_NOT_FOUND")

    def test_forbidden_inactive_and_cap(self):
        with self.assertRaises(AsError) as caught:
            self.add(self.asg_no, "not allowed")
        self.assertEqual(caught.exception.code, "FORBIDDEN")
        with self.assertRaises(AsError) as caught:
            self.add(self.asg_done, "assignment over")
        self.assertEqual(caught.exception.code, "FORBIDDEN")
        with self.assertRaises(AsError) as caught:
            self.add("8" * 8 + "-0000-4000-8000-" + "8" * 12, "no such assignment")
        self.assertEqual(caught.exception.code, "FORBIDDEN")
        for n in range(boardmodel.MCP_TICKET_CAP):
            self.add(self.asg_ok, f"capped ticket {n}")
        with self.assertRaises(AsError) as caught:
            self.add(self.asg_ok, "one too many")
        self.assertEqual(caught.exception.code, "TICKET_CAP_REACHED")

    def test_duplicate_open_title(self):
        got = self.add(self.asg_ok, "same title")
        with self.assertRaises(AsError) as caught:
            self.add(self.asg_ok, "same title")
        self.assertEqual(caught.exception.code, "TICKET_DUPLICATE")
        # a terminal twin does not block a new ticket
        with self.store.transaction() as tx:
            boardmodel.ticket_move(tx, self.ws, {"key": got["ticket"]["key"], "to": "finished",
                                                 "force": True})
        again = self.add(self.asg_ok, "same title")
        self.assertNotEqual(again["ticket"]["key"], got["ticket"]["key"])


class RpcIdempotency(ServerCase):
    def test_same_request_id_creates_one_ticket(self):
        from unittest import mock
        from agent_studio import dispatch
        keys = []
        first_by_key = {}

        def capture(req, require_id=False):
            key = req.get("idempotencyKey")
            keys.append(key)
            if key in first_by_key:  # the coordinator returns the first result for a repeated key
                return first_by_key[key]
            first_by_key[key] = {"ok": True, "data": {"ticket": {"key": f"T-{len(keys):03d}",
                                                                 "status": "open", "phase": "default",
                                                                 "title": "x", "createdByMember": "m",
                                                                 "createdByAssignment": "a"},
                                                      "dependsOn": []}}
            return first_by_key[key]

        with mock.patch.object(dispatch, "handle_request", side_effect=capture):
            def call(rid):
                return self.rpc("tools/call", {"name": "ticket_add",
                                               "arguments": {"title": "idempotent finding",
                                                             "priority": 10}},
                                rid=rid, assignment=self.asg_ok, agent=self.allowed)
            first = call(7)
            self.assertFalse(first["result"].get("isError"), first)
            again = call(7)
            self.assertEqual(keys[0], keys[1])  # the same JSON-RPC id derives the same idempotency key
            self.assertEqual(again["result"]["ticket"]["key"], first["result"]["ticket"]["key"])
            other = call(8)
            self.assertNotEqual(keys[1], keys[2])
        with mock.patch.object(dispatch, "handle_request", side_effect=capture):
            pass  # (replaced above)

    def test_tools_over_the_full_dispatch_path(self):
        """The server rides dispatch: the same request path the CLI uses (workspace included)."""
        from unittest import mock
        from agent_studio import dispatch
        sent = []
        with mock.patch.object(dispatch, "handle_request",
                               side_effect=lambda req, require_id=False: sent.append(req) or
                               {"ok": True, "data": {"tickets": []}}):
            got = self.rpc("tools/call", {"name": "ticket_list", "arguments": {"status": "open"}},
                           assignment=self.asg_ok, agent=self.allowed, workspace=self.ws)
        self.assertEqual(got["result"]["isError"], False)
        req = sent[0]
        self.assertEqual((req["command"], req["args"]["workspace"]), ("ticket.list", self.ws))


class TeamDefs(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="as-mcp-td-")
        self.addCleanup(__import__("shutil").rmtree, self.root, True)
        self.ws = os.path.join(self.root, "proj")
        os.makedirs(os.path.join(self.ws, ".agent-studio", "teams"))
        from agent_studio import workspace
        with open(os.path.join(self.ws, ".agent-studio", "workspace.json"), "w") as f:
            json.dump({"id": str(uuid.uuid4()), "name": "w"}, f)
        import sys
        old = os.environ.get("XDG_STATE_HOME")
        os.environ["XDG_STATE_HOME"] = os.path.join(self.root, "state")
        self.addCleanup(os.environ.__setitem__, "XDG_STATE_HOME", old) if old else \
            self.addCleanup(os.environ.pop, "XDG_STATE_HOME", None)

    def team(self, members):
        with open(os.path.join(self.ws, ".agent-studio", "teams", "core.json"), "w") as f:
            json.dump({"id": "core", "name": "Core", "members": members}, f)
        return "core"

    def test_validated_add_member_and_hand_edit(self):
        fid = self.team([{"id": "a", "name": "A", "role": "r", "provider": "fake"},
                         {"id": "b", "name": "B", "role": "r2", "provider": "fake",
                          "canAddTickets": True}])
        problems = teams.validate_roster({"workspace": self.ws, "roster": [
            {"agentId": str(uuid.uuid4()), "providerId": "fake", "role": "r", "displayName": "A",
             "memberId": "a"},
            {"agentId": str(uuid.uuid4()), "providerId": "fake", "role": "r2", "displayName": "B",
             "memberId": "b", "canAddTickets": True}]}, allow_fake=True)
        self.assertEqual([m.get("canAddTickets") for m in problems], [None, True])
        with self.assertRaises(AsError) as caught:
            teams.validate_roster({"workspace": self.ws, "roster": [
                {"agentId": str(uuid.uuid4()), "providerId": "fake", "role": "r", "displayName": "C",
                 "memberId": "c", "canAddTickets": "yes"}]}, allow_fake=True)
        self.assertIn("canAddTickets", caught.exception.message)
        # old definitions without the key still load
        with open(os.path.join(self.ws, ".agent-studio", "teams", fid + ".json")) as f:
            data = json.load(f)
        self.assertNotIn("canAddTickets", data["members"][0])

    def test_add_member_flag_and_show(self):
        fid = self.team([])
        from agent_studio import teamdefs
        teamdefs.add_member(self.ws, fid, "Dee", "dev", "fake", can_add_tickets=True)
        with open(os.path.join(self.ws, ".agent-studio", "teams", fid + ".json")) as f:
            data = json.load(f)
        self.assertIs(data["members"][0]["canAddTickets"], True)
        teamdefs.add_member(self.ws, fid, "Ray", "review", "fake")
        with open(os.path.join(self.ws, ".agent-studio", "teams", fid + ".json")) as f:
            data = json.load(f)
        self.assertNotIn("canAddTickets", data["members"][1])


class AdapterMcpArgs(unittest.TestCase):
    """The provider CLIs must be allowed to call the board tools, and Codex must get a real args array."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="as-mcp-ad-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.prompt = os.path.join(self.tmp, "prompt.txt")
        open(self.prompt, "w").close()

    def inp(self, provider, mcp, policy="workspace_write"):
        from agent_studio.providers.base import AssignmentInput
        return AssignmentInput(assignment_id="a" * 8, agent_id="b" * 8, provider_id=provider, attempt=1,
                               workspace=self.tmp, prompt_path=self.prompt, role_instructions="x", policy=policy,
                               deadline_s=60, output_budget_bytes=1 << 20, mcp_tickets=mcp)

    def prepare(self, provider, mcp, policy="workspace_write"):
        from agent_studio import providers
        from unittest import mock
        adapter = providers.get(provider)
        with mock.patch.object(type(adapter), "executable", return_value="/bin/true"), \
                mock.patch.object(type(adapter), "validate_settings", return_value=None, create=True):
            return adapter._prepare(self.inp(provider, mcp, policy), {})

    def test_claude_allowlists_exactly_the_board_tools_when_enabled(self):
        for policy in ("read_only", "workspace_write"):
            argv = self.prepare("claude", True, policy).argv
            allowed = argv[argv.index("--allowedTools") + 1].split(",")
            for tool in ("ticket_add", "ticket_update", "ticket_list", "ticket_show", "phase_list", "board_show"):
                self.assertIn("mcp__agent-studio__" + tool, allowed)
            self.assertEqual(argv.count("--allowedTools"), 1)
            self.assertIn("--strict-mcp-config", argv)
            self.assertIn("--mcp-config", argv)

    def test_claude_unchanged_when_disabled(self):
        argv = self.prepare("claude", False).argv
        self.assertNotIn("--mcp-config", argv)
        self.assertFalse([a for a in argv if "mcp__" in a])

    def test_codex_args_is_one_toml_array_and_values_are_escaped(self):
        argv = self.prepare("codex", True).argv
        overrides = [argv[i + 1] for i, a in enumerate(argv) if a == "-c"]
        args = [o for o in overrides if o.startswith("mcp_servers.agent-studio.args")]
        self.assertEqual(len(args), 1)
        self.assertTrue(args[0].startswith("mcp_servers.agent-studio.args=["), args[0])
        self.assertEqual(json.loads(args[0].split("=", 1)[1])[-1], "mcp")
        self.assertFalse([o for o in overrides if ".args.0" in o])

    def test_codex_unchanged_when_disabled(self):
        argv = self.prepare("codex", False).argv
        self.assertFalse([a for a in argv if "agent-studio" in a])


if __name__ == "__main__":
    unittest.main()
