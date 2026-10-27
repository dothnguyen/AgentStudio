import ast
import contextlib
import io
import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

from tests import helpers  # noqa: F401  (puts backend on sys.path)
from agent_studio import cli, dispatch, state, teamdefs, teams, teamstatus, workspace
from agent_studio.protocol import AsError
from agent_studio.store import Store

ROLES = {"version": 1, "roles": {"developer": {}, "reviewer": {}}}


def member(mid, name, role="developer", **extra):
    return dict({"id": mid, "name": name, "role": role, "provider": "fake"}, **extra)


class Base(unittest.TestCase):
    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="as-s03-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self._old = os.environ.get("XDG_STATE_HOME")
        os.environ["XDG_STATE_HOME"] = os.path.join(self.root, "state")
        self.addCleanup(self._restore)
        self.ws = os.path.join(self.root, "proj")
        os.makedirs(self.ws)
        workspace.init(self.ws)
        self.cfg = os.path.join(self.ws, ".agent-studio")
        with open(os.path.join(self.cfg, "roles.json"), "w") as f:
            json.dump(ROLES, f)

    def _restore(self):
        if self._old is None:
            os.environ.pop("XDG_STATE_HOME", None)
        else:
            os.environ["XDG_STATE_HOME"] = self._old

    def put_team(self, tid, members, name=None):
        teamdefs.save(self.ws, {"id": tid, "name": name or tid.title(), "members": members})

    def build(self, *argv):
        return cli._human_request(["team"] + list(argv))


NOW = "2030-01-01T00:00:00.000Z"
TEAM_ID = "a" * 8 + "-0000-4000-8000-" + "a" * 12
AGENT_ID = "b" * 8 + "-0000-4000-8000-" + "b" * 12


def v8_database(path):
    """Build a persisted version-8 database (migrations 1..8 applied) holding one team and one agent."""
    conn = state.connect(path, role="coordinator", create=True)
    conn.execute("BEGIN IMMEDIATE")
    conn.execute("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)")
    for version in range(1, 9):
        for step in state.MIGRATIONS[version]:
            step(conn) if callable(step) else conn.execute(step)
        conn.execute("INSERT INTO schema_migrations VALUES (?, ?)", (version, NOW))
    conn.execute("INSERT INTO teams (id, name, workspace, status, created_at, updated_at) "
                 "VALUES (?, 't', '/one', 'running', ?, ?)", (TEAM_ID, NOW, NOW))
    conn.execute("INSERT INTO agents (id, team_id, ordinal, provider_id, role, display_name, availability, "
                 "pane_state, created_at, updated_at) VALUES (?, ?, 0, 'fake', 'developer', 'Ryan', 'idle', 'alive', ?, ?)",
                 (AGENT_ID, TEAM_ID, NOW, NOW))
    conn.execute("COMMIT")
    return conn


class Migration(unittest.TestCase):
    def test_fresh_and_v8_databases_reach_the_current_version_with_null_columns(self):
        self.assertEqual(state.SCHEMA_VERSION, 16)
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, True)
        conn = v8_database(os.path.join(d, "old.db"))
        self.assertEqual(state.current_version(conn), 8)
        self.assertNotIn("def_id", {r[1] for r in conn.execute("PRAGMA table_info(teams)")})
        self.assertNotIn("member_id", {r[1] for r in conn.execute("PRAGMA table_info(agents)")})
        self.assertEqual(state.migrate(conn, os.path.join(d, "old.db")), 16)
        self.assertEqual(state.current_version(conn), 16)
        self.assertEqual(conn.execute("SELECT id, def_id FROM teams").fetchall()[0][:], (TEAM_ID, None))
        self.assertEqual(conn.execute("SELECT id, member_id, display_name FROM agents").fetchall()[0][:],
                         (AGENT_ID, None, "Ryan"))
        self.assertEqual(conn.execute("PRAGMA foreign_key_check").fetchall(), [])
        fresh = state.connect(os.path.join(d, "new.db"), role="coordinator", create=True)
        self.assertEqual(state.migrate(fresh, os.path.join(d, "new.db")), 16)
        cols = {r[1] for r in fresh.execute("PRAGMA table_info(agents)")}
        self.assertIn("member_id", cols)
        self.assertIn("def_id", {r[1] for r in fresh.execute("PRAGMA table_info(teams)")})


class ModeSelection(Base):
    def test_definition_start_sends_mapped_roster(self):
        self.put_team("alpha", [member("ryan", "Ryan", model="m1", reasoning="high"), member("sam", "Sam", "reviewer")])
        with mock.patch.object(os, "getcwd", return_value=self.ws):
            req = self.build("start")
        a = req["args"]
        self.assertEqual((req["command"], a["teamDefId"], a["name"], a["workspace"]), ("team.start", "alpha", "Alpha", self.ws))
        self.assertEqual(a["roster"], [
            {"memberId": "ryan", "displayName": "Ryan", "providerId": "fake", "role": "developer", "model": "m1",
             "reasoning": "high"},
            {"memberId": "sam", "displayName": "Sam", "providerId": "fake", "role": "reviewer"}])
        self.assertEqual(dispatch._validate_team_start(a)["teamDefId"], "alpha")

    def test_name_flag_and_team_selection(self):
        self.put_team("alpha", [member("a", "A")])
        self.put_team("beta", [member("b", "B")])
        with mock.patch.object(os, "getcwd", return_value=self.ws):
            with self.assertRaises(AsError) as c:
                self.build("start")
            self.assertEqual(c.exception.code, "TEAM_AMBIGUOUS")
            with self.assertRaises(AsError) as c:
                self.build("start", "--team", "nope")
            self.assertEqual(c.exception.code, "TEAM_NOT_FOUND")
            req = self.build("start", "--team", "beta", "--name", "Mine")
        self.assertEqual((req["args"]["teamDefId"], req["args"]["name"]), ("beta", "Mine"))

    def test_invalid_and_empty_definitions_write_no_request(self):
        self.put_team("bad", [member("a", "A", role="nobody")])
        with mock.patch.object(dispatch, "handle_request") as sent, mock.patch.object(os, "getcwd", return_value=self.ws):
            raw = io.BytesIO()
            out = io.TextIOWrapper(raw, encoding="utf-8", write_through=True)
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
                rc = cli.main(["team", "start"])
        self.assertNotEqual(rc, 0)
        sent.assert_not_called()
        body = json.loads(raw.getvalue().decode("utf-8").splitlines()[-1])
        self.assertEqual(body["error"]["code"], "TEAM_CONFIG_INVALID")
        self.assertTrue(body["data"]["problems"])
        self.put_team("bad", [])
        with mock.patch.object(os, "getcwd", return_value=self.ws), self.assertRaises(AsError) as c:
            self.build("start")
        self.assertEqual(c.exception.code, "TEAM_CONFIG_INVALID")
        self.assertEqual(c.exception.data["problems"][0]["path"], "members")

    def test_legacy_start_is_refused_and_names_import_legacy(self):
        # P04-S06 deleted the CLI-side team.json fallback: only team import-legacy reads it now.
        legacy = os.path.join(self.root, "legacy")
        os.makedirs(os.path.join(legacy, ".agent-studio"))
        with open(os.path.join(legacy, ".agent-studio", "team.json"), "w") as f:
            json.dump({"version": 1, "agents": [{"providerId": "fake", "role": "developer"}]}, f)
        for argv in (("start", "--workspace", legacy), ("start", "--workspace", legacy, "--team", "x")):
            with self.assertRaises(AsError) as c:
                self.build(*argv)
            self.assertEqual(c.exception.code, "TEAM_NOT_FOUND")
            self.assertIn("team import-legacy", c.exception.remediation)

    def test_agent_roster_path_and_conflict_with_team(self):
        self.put_team("alpha", [member("a", "A")])
        req = self.build("start", "--workspace", self.ws, "--agent", "fake:developer:Dev")
        self.assertEqual(req["args"]["roster"], [{"providerId": "fake", "role": "developer", "displayName": "Dev"}])
        self.assertNotIn("teamDefId", req["args"])
        with self.assertRaises(AsError) as c:
            self.build("start", "--workspace", self.ws, "--agent", "fake:developer", "--team", "alpha")
        self.assertEqual(c.exception.code, "BAD_REQUEST")

    def test_stop_by_definition_or_uuid(self):
        self.put_team("alpha", [member("a", "A")])
        req = self.build("stop", "--team", "alpha", "--workspace", self.ws)
        self.assertEqual((req["command"], req["args"]), ("team.stop", {"workspace": self.ws, "teamDefId": "alpha"}))
        uid = "11111111-1111-4111-8111-111111111111"
        req = self.build("stop", "--team", uid)
        self.assertEqual(req["args"], {"teamId": uid})
        with mock.patch.object(os, "getcwd", return_value=self.ws):
            self.assertEqual(self.build("stop")["args"]["teamDefId"], "alpha")


class DispatchValidation(unittest.TestCase):
    def test_slugs_accepted_and_non_slugs_rejected(self):
        ws = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, ws, True)
        ok = {"workspace": "/w", "teamDefId": "alpha",
              "roster": [{"providerId": "fake", "role": "r", "memberId": "ryan"}]}
        self.assertEqual(dispatch._validate_team_start(ok)["teamDefId"], "alpha")
        for bad in ("Alpha", "a b", "", 3, "-x"):
            with self.assertRaises(AsError) as c:
                dispatch._validate_team_start(dict(ok, teamDefId=bad))
            self.assertEqual(c.exception.code, "BAD_REQUEST")
            roster = [{"providerId": "fake", "role": "r", "memberId": bad}]
            with self.assertRaises(AsError) as c:
                dispatch._validate_team_start(dict(ok, roster=roster))
            self.assertEqual(c.exception.code, "BAD_REQUEST")
        with self.assertRaises(AsError):
            dispatch._validate_team_stop({"workspace": ws, "teamDefId": "Bad"})
        with self.assertRaises(AsError):
            dispatch._validate_team_stop({"teamId": "x"})
        self.assertEqual(dispatch._validate_team_stop({"workspace": ws, "teamDefId": "alpha"})["teamDefId"], "alpha")


def seeded():
    path = os.path.join(tempfile.mkdtemp(), "state.db")
    conn = state.connect(path, role="coordinator", create=True)
    state.migrate(conn, path)
    return conn, Store(conn)


class StatusAndLookup(unittest.TestCase):
    def setUp(self):
        self.conn, self.store = seeded()
        with self.store.transaction() as tx:
            self.team = tx.create("team", {"name": "Alpha", "workspace": "/w", "def_id": "alpha"})
            self.ryan = tx.create("agent", {"team_id": self.team, "ordinal": 0, "provider_id": "codex",
                                            "role": "developer", "display_name": "Ryan", "member_id": "ryan-m"})
            self.sam = tx.create("agent", {"team_id": self.team, "ordinal": 1, "provider_id": "claude",
                                           "role": "reviewer", "display_name": "Sam"})
            tx.transition("team", self.team, "running")
            task = tx.create("task", {"team_id": self.team, "origin": "direct", "workspace": "/w", "goal": "g"})
            self.task = task
            self.asg = tx.create("assignment", {"team_id": self.team, "task_id": task, "agent_id": self.ryan,
                                                "attempt": 1, "policy": "read_only", "provider_id": "codex"})

    def test_status_rows(self):
        d = teamstatus.team_status(self.conn, None, "/w", "alpha")
        self.assertEqual(d["team"], {"id": self.team, "teamDefId": "alpha", "name": "Alpha", "status": "running",
                                     "workspace": "/w"})
        ryan, sam = d["members"]
        self.assertEqual((ryan["memberId"], ryan["name"], ryan["provider"], ryan["role"]),
                         ("ryan-m", "Ryan", "codex", "developer"))
        self.assertEqual(ryan["assignment"], {"id": self.asg, "status": "queued", "taskId": self.task})
        self.assertIsNone(sam["assignment"])
        self.assertEqual(teamstatus.team_status(self.conn, self.team, None, None)["team"]["id"], self.team)

    def test_never_started_definition(self):
        self.assertEqual(teamstatus.team_status(self.conn, None, "/w", "beta"), {"team": None, "members": []})
        self.assertEqual(teamstatus.team_status(self.conn, None, "/other", "alpha"), {"team": None, "members": []})

    def test_status_module_imports_no_board_module(self):
        with open(teamstatus.__file__, encoding="utf-8") as f:
            tree = ast.parse(f.read())
        names = set()
        for n in ast.walk(tree):
            if isinstance(n, ast.ImportFrom):
                names.add((n.module or "").split(".")[0])
                names.update(a.name for a in n.names)
            elif isinstance(n, ast.Import):
                names.update(a.name.split(".")[0] for a in n.names)
        self.assertFalse(names & {"board", "board_" + "scheduler", "board_" + "config", "tick" + "ets", "queries"},
                         names)

    def test_render_human(self):
        d = teamstatus.team_status(self.conn, None, "/w", "alpha")
        text = cli._render_team_status(d)
        self.assertTrue(text.startswith("alpha (Alpha): running\n"))
        self.assertIn(f"Ryan [codex/developer] starting  {self.asg} queued", text)
        self.assertEqual(cli._render_team_status({"team": None, "members": [], "_ref": "beta"}), "team beta: not running")

    def test_find_agent_by_uuid_member_id_and_name(self):
        for ref in (self.ryan, "ryan-m", "RYAN"):
            self.assertEqual(teams.find_agent(self.conn, self.team, ref)["id"], self.ryan)
        self.assertEqual(teams.find_agent(self.conn, self.team, "sam")["id"], self.sam)
        with self.assertRaises(AsError) as c:
            teams.find_agent(self.conn, self.team, "nobody")
        self.assertEqual(c.exception.code, "MEMBER_NOT_FOUND")


if __name__ == "__main__":
    unittest.main()
