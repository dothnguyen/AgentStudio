import ast
import copy
import hashlib
import json
import os
import shutil
import tempfile
import unittest
from unittest.mock import patch

from tests import helpers  # noqa: F401  (puts backend on sys.path)
from agent_studio import PROTOCOL, boardmodel, boardsettings, dispatch, state
from agent_studio.protocol import AsError
from agent_studio.store import Store

ROLES = {"version": 1, "roles": {"worker": {"description": "Builds", "skills": [], "custom": 1},
                                 "TeamLead": {"description": "Leads"}}, "note": "keep"}


def wf(role):
    return {"version": 1, "description": role, "stages": [
        {"id": "work", "role": role, "permission": "read_only", "prompt": "Do.\n{{task}}",
         "next": {"done": "$succeed"}}]}


def rule(status, role, workflow, on_pass, on_fail, **extra):
    r = {"when": {"status": status}, "role": role, "workflow": workflow, "onPass": on_pass, "onFail": on_fail}
    r.update(extra)
    return r


BOARD = {"version": 2, "baseBranch": "main",
         "statuses": [{"id": "build", "kind": "initial"}, {"id": "ready"}, {"id": "plan-ready"},
                      {"id": "merge-conflict"}, {"id": "plan-merge-conflict"}, {"id": "done", "kind": "done"}],
         "ticketFields": [],
         "rules": [
             rule("build", "worker", "work", "ready", "build", workspace="worktree"),
             {"when": {"status": "ready"}, "action": "merge", "onPass": "done", "onFail": "merge-conflict"},
             {"when": {"status": "plan-ready"}, "action": "merge", "onPass": "done", "onFail": "plan-merge-conflict"},
             rule("merge-conflict", "TeamLead", "resolve", "ready", "merge-conflict", workspace="worktree",
                  syncBase=True),
             rule("plan-merge-conflict", "TeamLead", "resolve", "plan-ready", "plan-merge-conflict",
                  workspace="worktree", syncBase=True)]}


def sha(data):
    return hashlib.sha256(data).hexdigest()


class BoardSettingsTests(unittest.TestCase):
    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="as-board-settings-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.ws = os.path.join(self.root, "workspace")
        self.cfg = os.path.join(self.ws, ".agent-studio")
        os.makedirs(os.path.join(self.cfg, "workflows"))
        self.write("roles.json", ROLES)
        self.write("workflows/work.json", wf("worker"))
        self.write("workflows/resolve.json", wf("TeamLead"))
        self.write("board.json", BOARD)
        self.old = os.environ.get("XDG_STATE_HOME")
        self.addCleanup(self._restore)
        self.home = os.path.join(self.root, "state-home")
        os.environ["XDG_STATE_HOME"] = self.home
        sd = os.path.join(self.home, "agent-studio")
        os.makedirs(sd)
        db = state.db_path(sd)
        self.conn = state.connect(db, role="coordinator", create=True)
        state.migrate(self.conn, db)
        self.addCleanup(self.conn.close)
        self.store = Store(self.conn)

    def _restore(self):
        if self.old is None:
            os.environ.pop("XDG_STATE_HOME", None)
        else:
            os.environ["XDG_STATE_HOME"] = self.old

    def write(self, name, body, raw=False):
        with open(os.path.join(self.cfg, name), "w", encoding="utf-8") as f:
            f.write(body if raw else json.dumps(body))

    def read_bytes(self, name):
        with open(os.path.join(self.cfg, name), "rb") as f:
            return f.read()

    def read_json(self, name):
        return json.loads(self.read_bytes(name))

    def snapshot(self):
        snap = {}
        for name in ("board.json", "roles.json"):
            p = os.path.join(self.cfg, name)
            snap[name] = open(p, "rb").read() if os.path.exists(p) else None
        snap["listing"] = sorted(os.listdir(self.cfg))
        return snap

    def settings(self, running=True):
        return boardsettings.settings(self.conn, self.ws, running, None)

    def test_settings_projection_valid_path(self):
        s = self.settings()
        self.assertEqual(s["board"]["state"], "ok")
        self.assertEqual(s["board"]["problems"], [])
        self.assertEqual(s["board"]["sha256"], sha(self.read_bytes("board.json")))
        self.assertEqual([x["id"] for x in s["statuses"]], [x["id"] for x in BOARD["statuses"]])
        build = s["rules"][0]
        self.assertEqual((build["type"], build["role"], build["workflow"], build["onPass"], build["onFail"],
                          build["workspace"]), ("agent", "worker", "work", "ready", "build", "worktree"))
        self.assertEqual([a["status"] for a in s["actionRules"]], ["ready", "plan-ready"])
        self.assertEqual([a["onFail"] for a in s["actionRules"]], ["merge-conflict", "plan-merge-conflict"])
        self.assertEqual(s["worktree"], {"baseBranch": "main",
                                         "worktreeStatuses": ["build", "merge-conflict", "plan-merge-conflict"]})
        self.assertEqual(s["protectedRoutes"],
                         [{"status": "merge-conflict", "role": "TeamLead", "satisfied": True},
                          {"status": "plan-merge-conflict", "role": "TeamLead", "satisfied": True}])
        self.assertEqual(s["roles"]["items"], [{"id": "worker", "description": "Builds"},
                                               {"id": "TeamLead", "description": "Leads"}])
        names = {w["name"] for w in s["workflows"]}
        self.assertTrue({"work", "resolve"} <= names)
        self.assertEqual([r["onFailureLimit"] for r in s["rules"]], [None] * 5)

    def test_settings_projects_failure_limit_policy(self):
        board = copy.deepcopy(BOARD)
        board["statuses"] += [{"id": "qa"}, {"id": "review"}, {"id": "need-escalate"}]
        policy = {"count": 3, "status": "need-escalate"}
        board["rules"] += [
            rule("qa", "worker", "work", "review", "build", onFailureLimit=dict(policy)),
            rule("review", "worker", "work", "ready", "build", onFailureLimit=dict(policy)),
            rule("need-escalate", "worker", "work", "qa", "need-escalate", maxRounds=3)]
        self.write("board.json", board)
        s = self.settings()
        self.assertEqual(s["board"]["state"], "ok")
        self.assertEqual(s["board"]["problems"], [])
        self.assertEqual(s["rules"][5]["onFailureLimit"], policy)
        self.assertEqual(s["rules"][6]["onFailureLimit"], policy)
        for i in (0, 1, 2, 7):
            self.assertIsNone(s["rules"][i]["onFailureLimit"])
        self.assertEqual(s["board"]["config"]["rules"][5]["onFailureLimit"], policy)
        self.assertIsNot(s["rules"][5]["onFailureLimit"], s["board"]["config"]["rules"][5]["onFailureLimit"])

    def test_board_update_round_trips_failure_limit(self):
        rules = copy.deepcopy(BOARD["rules"])
        rules[0]["onFailureLimit"] = {"count": 2, "status": "build"}
        out = boardsettings.update_board(self.ws, {"rules": rules}, sha(self.read_bytes("board.json")))
        self.assertEqual(out["changed"], ["rules"])
        self.assertEqual(self.read_json("board.json")["rules"][0]["onFailureLimit"], {"count": 2, "status": "build"})
        self.assertEqual(self.settings()["rules"][0]["onFailureLimit"], {"count": 2, "status": "build"})
        del rules[0]["onFailureLimit"]
        boardsettings.update_board(self.ws, {"rules": rules}, sha(self.read_bytes("board.json")))
        self.assertNotIn("onFailureLimit", self.read_json("board.json")["rules"][0])
        self.assertIsNone(self.settings()["rules"][0]["onFailureLimit"])
        self.assertEqual(self.read_json("board.json"), BOARD)

    def test_invalid_failure_limit_edits_leave_files_untouched(self):
        cases = [(0, {"count": 0, "status": "build"}, "rules[0].onFailureLimit.count"),
                 (0, {"count": 2, "status": "nowhere"}, "rules[0].onFailureLimit.status"),
                 (0, {"count": 2}, "rules[0].onFailureLimit"),
                 (1, {"count": 2, "status": "build"}, "rules[1].onFailureLimit")]
        for index, policy, path in cases:
            with self.subTest(path=path, policy=policy):
                rules = copy.deepcopy(BOARD["rules"])
                rules[index]["onFailureLimit"] = policy
                before = self.snapshot()
                with self.assertRaises(AsError) as cm:
                    boardsettings.update_board(self.ws, {"rules": rules})
                self.assertEqual(cm.exception.code, "BOARD_CONFIG_INVALID")
                self.assertIn(path, [p["path"] for p in cm.exception.data["problems"]])
                self.assertEqual(self.snapshot(), before)

    def test_board_update_round_trip_preserves_untouched_keys(self):
        rules = copy.deepcopy(BOARD["rules"])
        rules[0]["maxRounds"] = 4
        cur = sha(self.read_bytes("board.json"))
        out = boardsettings.update_board(self.ws, {"rules": rules, "leaseSeconds": 200}, cur)
        self.assertEqual(out["changed"], ["leaseSeconds", "rules"])
        want = dict(copy.deepcopy(BOARD), rules=rules, leaseSeconds=200)
        self.assertEqual(self.read_json("board.json"), want)
        self.assertEqual(out["sha256"], sha(self.read_bytes("board.json")))
        self.assertEqual(self.settings()["rules"][0]["maxRounds"], 4)

    def test_board_update_noop_does_not_write(self):
        p = os.path.join(self.cfg, "board.json")
        before = os.stat(p).st_mtime_ns
        out = boardsettings.update_board(self.ws, {"baseBranch": "main"})
        self.assertEqual(out["changed"], [])
        self.assertEqual(os.stat(p).st_mtime_ns, before)

    def with_rules(self, fn):
        rules = copy.deepcopy(BOARD["rules"])
        fn(rules)
        return {"rules": rules}

    def test_invalid_board_edits_leave_files_untouched(self):
        def on_pass(r):
            r[0]["onPass"] = "nowhere"

        def role(r):
            r[0]["role"] = "ghost"

        def wfn(r):
            r[0]["workflow"] = "missing-wf"
        cur = sha(self.read_bytes("board.json"))
        statuses = [s for s in BOARD["statuses"] if s["id"] != "done"]
        cases = [("unknown key", {"version": 3}, None, "BAD_REQUEST", None),
                 ("empty", {}, None, "BAD_REQUEST", None),
                 ("onPass", self.with_rules(on_pass), None, "BOARD_CONFIG_INVALID", "rules[0].onPass"),
                 ("role", self.with_rules(role), None, "BOARD_CONFIG_INVALID", "rules[0].role"),
                 ("workflow", self.with_rules(wfn), None, "BOARD_CONFIG_INVALID", "rules[0].workflow"),
                 ("no done", {"statuses": statuses}, None, "BOARD_CONFIG_INVALID", None),
                 ("sha", {"leaseSeconds": 5}, "0" * 64, "CONFIG_CHANGED", None)]
        for label, changes, expected, code, path in cases:
            with self.subTest(label):
                before = self.snapshot()
                with self.assertRaises(AsError) as cm:
                    boardsettings.update_board(self.ws, changes, expected)
                self.assertEqual(cm.exception.code, code)
                if path:
                    self.assertIn(path, [p["path"] for p in cm.exception.data["problems"]])
                if code == "CONFIG_CHANGED":
                    self.assertEqual(cm.exception.data["sha256"], cur)
                if label == "unknown key":
                    self.assertEqual(cm.exception.message, "changes got unknown key(s): version.")
                if label == "empty":
                    self.assertEqual(cm.exception.message, "changes must be a non-empty object.")
                self.assertEqual(self.snapshot(), before)

    def test_protected_routes_enforced(self):
        def to_worker(r):
            r[3]["role"] = "worker"
            r[3]["workflow"] = "work"

        def drop_plan(r):
            del r[4]

        rules = copy.deepcopy(BOARD["rules"])
        rules[1]["onFail"] = "build"
        del rules[3]
        statuses = [s for s in BOARD["statuses"] if s["id"] != "merge-conflict"]
        cases = [(self.with_rules(to_worker),
                  "status 'merge-conflict' must route to role 'TeamLead' (got 'worker')"),
                 (self.with_rules(drop_plan),
                  "status 'plan-merge-conflict' must have a rule routing it to role 'TeamLead'"),
                 ({"statuses": statuses, "rules": rules},
                  "status 'merge-conflict' is protected and must stay on this board")]
        for changes, message in cases:
            with self.subTest(message):
                before = self.snapshot()
                with self.assertRaises(AsError) as cm:
                    boardsettings.update_board(self.ws, changes)
                self.assertEqual(cm.exception.code, "BOARD_CONFIG_INVALID")
                self.assertIn(message, [p["message"] for p in cm.exception.data["problems"]])
                self.assertEqual(self.snapshot(), before)

    def test_protection_only_applies_to_present_statuses(self):
        self.write("board.json", {"version": 2, "statuses": [{"id": "build", "kind": "initial"},
                                                              {"id": "done", "kind": "done"}],
                                  "ticketFields": [], "rules": [rule("build", "worker", "work", "done", "build")]})
        self.assertEqual(self.settings()["protectedRoutes"], [])
        self.assertEqual(boardsettings.update_board(self.ws, {"leaseSeconds": 30})["changed"], ["leaseSeconds"])

    def test_settings_reports_unhealthy_board_as_problem(self):
        board = copy.deepcopy(BOARD)
        board["rules"][3]["role"] = "worker"
        board["rules"][3]["workflow"] = "work"
        self.write("board.json", board)
        s = self.settings()
        self.assertFalse(s["protectedRoutes"][0]["satisfied"])
        self.assertTrue(s["protectedRoutes"][1]["satisfied"])
        self.write("board.json", "{", raw=True)
        s = self.settings()
        self.assertEqual((s["board"]["state"], s["statuses"]), ("invalid", []))
        os.remove(os.path.join(self.cfg, "board.json"))
        self.assertEqual(self.settings()["board"]["state"], "missing")

    def test_invalid_or_missing_board_has_no_projected_rules(self):
        board = copy.deepcopy(BOARD)
        board["rules"][0]["onFailureLimit"] = {"count": 0, "status": "build"}
        self.write("board.json", board)
        s = self.settings()
        self.assertEqual(s["board"]["state"], "invalid")
        self.assertEqual(s["rules"], [])
        os.remove(os.path.join(self.cfg, "board.json"))
        s = self.settings()
        self.assertEqual(s["board"]["state"], "missing")
        self.assertEqual(s["rules"], [])

    def test_role_update_round_trip_and_preserves_fields(self):
        cur = sha(self.read_bytes("roles.json"))
        out = boardsettings.update_role(self.ws, "worker", "Builds things", cur)
        self.assertTrue(out["changed"])
        doc = self.read_json("roles.json")
        self.assertEqual(doc["roles"]["worker"], {"description": "Builds things", "skills": [], "custom": 1})
        self.assertEqual(doc["roles"]["TeamLead"], {"description": "Leads"})
        self.assertEqual(doc["note"], "keep")
        boardsettings.update_role(self.ws, "worker", None)
        self.assertNotIn("description", self.read_json("roles.json")["roles"]["worker"])
        boardsettings.update_role(self.ws, "worker", "x")
        self.assertFalse(boardsettings.update_role(self.ws, "worker", "x")["changed"])

    def test_invalid_role_edits_leave_files_untouched(self):
        def missing():
            os.remove(os.path.join(self.cfg, "roles.json"))

        def bad():
            self.write("roles.json", {"version": 2})
        cases = [("ghost", None, "ROLE_NOT_FOUND", "Role 'ghost' is not defined in .agent-studio/roles.json.", "ghost", None),
                 ("sha", None, "CONFIG_CHANGED", None, "worker", "0" * 64),
                 ("missing", missing, "ROLE_NOT_FOUND", "Role 'worker' is not defined in .agent-studio/roles.json.", "worker", None),
                 ("bad", bad, "ROLES_CONFIG_INVALID", None, "worker", None)]
        for label, prep, code, message, role, expected in cases:
            with self.subTest(label):
                if prep:
                    prep()
                before = self.snapshot()
                with self.assertRaises(AsError) as cm:
                    boardsettings.update_role(self.ws, role, "new", expected)
                self.assertEqual(cm.exception.code, code)
                if message:
                    self.assertEqual(cm.exception.message, message)
                self.assertEqual(self.snapshot(), before)

    def test_runner_states(self):
        run = boardsettings.runner
        self.assertEqual(run(None, self.ws, True, None)["status"], "unavailable")
        err = {"code": "BACKEND_UNAVAILABLE", "message": "x"}
        self.assertEqual(run(self.conn, self.ws, True, err)["status"], "unavailable")
        self.assertEqual(run(self.conn, self.ws, True, None)["status"], "not_bound")

        def seed(run_status, team_status="running"):
            with self.store.transaction() as tx:
                team = tx.create("team", {"name": "t", "workspace": self.ws, "def_id": "alpha"})
                if team_status == "running":
                    tx.transition("team", team, "running")
                else:
                    tx.transition("team", team, "stopping")
                    tx.transition("team", team, "stopped")
            self.conn.execute("DELETE FROM board_state WHERE workspace = ?", (self.ws,))
            self.conn.execute("INSERT INTO board_state (workspace, current_phase_id, created_at, updated_at, "
                              "team_id, run_status) VALUES (?, NULL, ?, ?, ?, ?)",
                              (self.ws, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", team, run_status))
            self.conn.commit()
            return team
        team = seed("running")
        r = run(self.conn, self.ws, True, None)
        self.assertEqual((r["status"], r["teamId"], r["teamDefId"], r["teamStatus"]),
                         ("running", team, "alpha", "running"))
        self.assertEqual(run(self.conn, self.ws, False, None)["status"], "disconnected")
        seed("stopped")
        self.assertEqual(run(self.conn, self.ws, True, None)["status"], "stopped")
        seed("running", "stopped")
        self.assertEqual(run(self.conn, self.ws, True, None)["status"], "team_not_running")

    def call(self, command, **args):
        return dispatch.handle_request({"protocol": PROTOCOL, "id": "r1", "command": command, "args": args},
                                       require_id=True)

    def test_dispatch_contract(self):
        def bad(r, code, msg):
            self.assertFalse(r["ok"], r)
            self.assertEqual((r["error"]["code"], r["error"]["message"]), (code, msg))
        bad(self.call("board.settings"), "BAD_REQUEST", "Missing required argument 'workspace'.")
        bad(self.call("board.settings", workspace=self.ws, z=1, a=2), "BAD_REQUEST",
            "board.settings got unknown argument(s): a, z.")
        bad(self.call("board.settings", workspace=self.root), "WORKSPACE_NOT_FOUND",
            f"{self.root} is not an Agent Studio workspace (no .agent-studio directory).")
        count = lambda: [self.conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("commands", "events")]
        before = count()
        with patch.object(dispatch.coordinator, "running_info", return_value={"pid": 1}):
            r = self.call("board.settings", workspace=self.ws)
        self.assertTrue(r["ok"], r)
        self.assertEqual(set(r["data"]), {"workspace", "board", "statuses", "rules", "actionRules", "worktree",
                                          "protectedRoutes", "roles", "workflows", "runner"})
        self.assertEqual(count(), before)
        bad(self.call("board.settings.update", workspace=self.ws), "BAD_REQUEST",
            "Missing required argument 'changes'.")
        bad(self.call("board.settings.update", workspace=self.ws, changes={"leaseSeconds": 9},
                      expectedSha256="xyz"), "BAD_REQUEST", "expectedSha256 must be a lowercase hex sha256.")
        bad(self.call("role.update", workspace=self.ws, role="worker"), "BAD_REQUEST",
            "Missing required argument 'description'.")
        r = self.call("role.update", workspace=self.ws, role="worker", description="Hi")
        self.assertTrue(r["ok"], r)
        r = self.call("board.settings.update", workspace=self.ws, changes={"leaseSeconds": 9})
        self.assertTrue(r["ok"], r)

    def test_parse_config_matches_load_config(self):
        self.assertEqual(boardmodel.parse_config(self.read_json("board.json")), boardmodel.load_config(self.ws))

    def test_boardsettings_imports_no_scheduler_or_tmux(self):
        with open(boardsettings.__file__, encoding="utf-8") as f:
            tree = ast.parse(f.read())
        names = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                names.add((node.module or "").split(".")[0])
                names.update(a.name for a in node.names)
            elif isinstance(node, ast.Import):
                names.update(a.name.split(".")[0] for a in node.names)
        self.assertFalse(names & {"boardsched", "coordinator", "tmuxctl", "queries"}, names)


if __name__ == "__main__":
    unittest.main()
