import ast
import json
import os
import shutil
import tempfile
import unittest
from unittest.mock import patch

from tests import helpers  # noqa: F401  (puts backend on sys.path)
from agent_studio import PROTOCOL, dispatch, schema, state, teamdefs, teamstatus
from agent_studio.store import Store


ROLES = {"version": 1, "roles": {"developer": {}}}


def definition(team_id, name=None, members=None):
    return {"id": team_id, "name": name or team_id.title(), "members": members or []}


def member(member_id):
    return {"id": member_id, "name": member_id.title(), "role": "developer", "provider": "fake"}


class TeamListTests(unittest.TestCase):
    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="as-team-list-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.workspace = os.path.join(self.root, "workspace")
        os.makedirs(os.path.join(self.workspace, ".agent-studio"))
        with open(os.path.join(self.workspace, ".agent-studio", "roles.json"), "w", encoding="utf-8") as f:
            json.dump(ROLES, f)
        self.state_home = os.path.join(self.root, "state-home")
        self.old_state_home = os.environ.get("XDG_STATE_HOME")
        os.environ["XDG_STATE_HOME"] = self.state_home
        self.addCleanup(self._restore_state_home)
        state_dir = os.path.join(self.state_home, "agent-studio")
        os.makedirs(state_dir)
        self.db_path = state.db_path(state_dir)
        self.conn = state.connect(self.db_path, role="coordinator", create=True)
        state.migrate(self.conn, self.db_path)
        self.addCleanup(self.conn.close)
        self.store = Store(self.conn)

    def _restore_state_home(self):
        if self.old_state_home is None:
            os.environ.pop("XDG_STATE_HOME", None)
        else:
            os.environ["XDG_STATE_HOME"] = self.old_state_home

    def put_definition(self, team_id, body):
        teams_dir = os.path.join(self.workspace, ".agent-studio", "teams")
        os.makedirs(teams_dir, exist_ok=True)
        with open(os.path.join(teams_dir, f"{team_id}.json"), "w", encoding="utf-8") as f:
            json.dump(body, f)

    def seed_runtime(self, definition_id, name, status, availabilities, assignment_agent=None):
        with self.store.transaction() as tx:
            team_id = tx.create("team", {"name": name, "workspace": self.workspace,
                                         "def_id": definition_id})
            agent_ids = []
            for ordinal, availability in enumerate(availabilities):
                agent_id = tx.create("agent", {"team_id": team_id, "ordinal": ordinal,
                                                "provider_id": "fake", "role": "developer",
                                                "display_name": f"Agent {ordinal}",
                                                "member_id": f"member-{ordinal}"})
                if availability == "busy":
                    tx.transition("agent", agent_id, "idle")
                    tx.transition("agent", agent_id, "busy")
                elif availability != "starting":
                    tx.transition("agent", agent_id, availability)
                agent_ids.append(agent_id)
            if status == "running":
                tx.transition("team", team_id, "running")
            elif status == "stopped":
                tx.transition("team", team_id, "stopping")
                tx.transition("team", team_id, "stopped")
            if assignment_agent is not None:
                task_id = tx.create("task", {"team_id": team_id, "origin": "direct",
                                             "workspace": self.workspace, "goal": "goal"})
                tx.create("assignment", {"team_id": team_id, "task_id": task_id,
                                         "agent_id": agent_ids[assignment_agent], "attempt": 1,
                                         "policy": "read_only", "provider_id": "fake"})
        return team_id

    def result(self):
        return teamstatus.workspace_teams(self.conn, self.workspace)

    def test_empty_workspace_returns_empty_not_truncated(self):
        self.assertEqual(self.result(), {"workspace": self.workspace, "teams": [], "truncated": False})

    def test_stopped_and_running_definitions_report_runtime_counts(self):
        self.put_definition("alpha", definition("alpha", "Alpha", [member("one"), member("two"), member("three")]))
        self.put_definition("beta", definition("beta", "Beta", [member("only")]))
        older_alpha = self.seed_runtime("alpha", "Old Alpha", "stopped", ["offline"])
        alpha = self.seed_runtime("alpha", "Alpha", "running", ["idle", "busy"], assignment_agent=1)
        beta = self.seed_runtime("beta", "Beta", "stopped", ["offline"])

        teams = self.result()["teams"]
        self.assertEqual([entry["id"] for entry in teams], ["alpha", "beta"])
        self.assertEqual([entry["members"] for entry in teams], [3, 1])
        self.assertEqual(teams[0]["runtime"], {
            "teamId": alpha, "status": "running", "memberCount": 2,
            "availability": {"starting": 0, "idle": 1, "busy": 1, "waiting_input": 0,
                             "limit_reached": 0, "offline": 0, "error": 0},
            "activeAssignments": 1,
        })
        self.assertEqual(tuple(teams[0]["runtime"]["availability"]), schema.AGENT_STATES)
        self.assertNotEqual(teams[0]["runtime"]["teamId"], older_alpha)
        self.assertEqual(teams[1]["runtime"], {
            "teamId": beta, "status": "stopped", "memberCount": 1,
            "availability": {"starting": 0, "idle": 0, "busy": 0, "waiting_input": 0,
                             "limit_reached": 0, "offline": 1, "error": 0},
            "activeAssignments": 0,
        })
        self.assertEqual(tuple(teams[1]["runtime"]["availability"]), schema.AGENT_STATES)

    def test_unstarted_definition_has_null_runtime(self):
        self.put_definition("alpha", definition("alpha"))
        self.assertIsNone(self.result()["teams"][0]["runtime"])

    def test_malformed_definition_is_isolated(self):
        teams_dir = os.path.join(self.workspace, ".agent-studio", "teams")
        os.makedirs(teams_dir)
        with open(os.path.join(teams_dir, "alpha.json"), "w", encoding="utf-8") as f:
            f.write("{")
        self.put_definition("beta", definition("beta"))

        result = self.result()
        self.assertEqual(result["teams"][0], {
            "id": "alpha", "name": None, "members": 0,
            "problems": [{"path": "$", "message": "could not load team definition: TEAM_CONFIG_INVALID"}],
            "runtime": None,
        })
        self.assertEqual(result["teams"][1]["id"], "beta")
        serialized = json.dumps(result)
        self.assertEqual(serialized.count(self.workspace), 1)
        self.assertNotIn("Expecting property name", serialized)

    def test_semantic_problems_are_reported_without_hiding_runtime(self):
        body = definition("wrong-id", "Alpha")
        self.put_definition("alpha", body)
        runtime_id = self.seed_runtime("alpha", "Alpha", "running", ["idle"])

        entry = self.result()["teams"][0]
        self.assertEqual(entry["problems"], [{"path": "id", "message": "must equal the file name ('alpha')"}])
        self.assertEqual(entry["runtime"]["teamId"], runtime_id)

    def test_limit_is_lexical_and_sets_truncated(self):
        for number in reversed(range(51)):
            team_id = f"team-{number:02d}"
            self.put_definition(team_id, definition(team_id))

        result = self.result()
        expected = [f"team-{number:02d}" for number in range(50)]
        self.assertEqual([entry["id"] for entry in result["teams"]], expected)
        self.assertTrue(result["truncated"])

    def test_limit_does_not_load_or_query_definition_51(self):
        for number in range(51):
            team_id = f"team-{number:02d}"
            self.put_definition(team_id, definition(team_id))

        real_load = teamdefs.load
        with patch.object(teamdefs, "load", wraps=real_load) as load, \
                patch.object(teamstatus, "team_status", wraps=teamstatus.team_status) as status:
            result = self.result()

        self.assertEqual(load.call_count, 50)
        self.assertEqual(status.call_count, 50)
        self.assertNotIn("team-50", [entry["id"] for entry in result["teams"]])

    def test_dispatch_validation_and_read_only_behavior(self):
        counts_before = tuple(self.conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                              for table in ("commands", "events"))

        def request(args):
            return dispatch.handle_request({"protocol": PROTOCOL, "id": "request-1",
                                            "command": "team.list", "args": args}, require_id=True)

        success = request({"workspace": self.workspace})
        self.assertTrue(success["ok"])
        self.assertEqual(success["data"]["workspace"], self.workspace)
        cases = [
            ({}, "BAD_REQUEST", "Missing required argument 'workspace'."),
            ({"workspace": ""}, "BAD_REQUEST", "Argument 'workspace' must not be empty."),
            ({"workspace": None}, "BAD_REQUEST", "Missing required argument 'workspace'."),
            ({"workspace": "relative"}, "WORKSPACE_NOT_FOUND", "The workspace path must be absolute."),
            ({"workspace": self.workspace, "z": 1, "a": 2}, "BAD_REQUEST",
             "team.list got unknown argument(s): a, z."),
        ]
        for args, code, message in cases:
            with patch.object(dispatch, "_reader", side_effect=AssertionError("reader opened before validation")):
                response = request(args)
            self.assertFalse(response["ok"])
            self.assertEqual(response["error"]["code"], code)
            self.assertEqual(response["error"]["message"], message)
        counts_after = tuple(self.conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                             for table in ("commands", "events"))
        self.assertEqual(counts_after, counts_before)

    def test_teamstatus_remains_board_independent(self):
        with open(teamstatus.__file__, encoding="utf-8") as f:
            tree = ast.parse(f.read())
        names = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                names.add((node.module or "").split(".")[0])
                names.update(alias.name for alias in node.names)
            elif isinstance(node, ast.Import):
                names.update(alias.name.split(".")[0] for alias in node.names)
        self.assertFalse(names & {"board", "board_scheduler", "board_config", "tickets", "queries"}, names)


if __name__ == "__main__":
    unittest.main()
