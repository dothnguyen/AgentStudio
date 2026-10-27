import ast
import json
import os
import shutil
import tempfile
import unittest
from unittest.mock import patch

from tests import helpers  # noqa: F401  (puts backend on sys.path)
from agent_studio import PROTOCOL, dispatch, state, store as store_mod, teamview
from agent_studio.store import Store

ROLES = {"version": 1, "roles": {"developer": {"description": "Implements stories"}, "reviewer": {}}}
AGENTS = [{"id": "dev-codex", "name": "Dev Codex", "provider": "codex", "model": "gpt-5", "reasoning": "high"}]
DEV = {"id": "dev", "name": "Dev", "role": "developer", "agent": "dev-codex"}
REV = {"id": "rev", "name": "Rev", "role": "reviewer", "provider": "fake"}


class TeamOverviewTests(unittest.TestCase):
    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="as-team-overview-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.ws = os.path.join(self.root, "workspace")
        os.makedirs(os.path.join(self.ws, ".agent-studio"))
        self.write("roles.json", ROLES)
        self.write("agents.json", {"version": 1, "agents": AGENTS})
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
        with open(os.path.join(self.ws, ".agent-studio", name), "w", encoding="utf-8") as f:
            f.write(body if raw else json.dumps(body))

    def put_team(self, tid, members, name=None):
        d = os.path.join(self.ws, ".agent-studio", "teams")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f"{tid}.json"), "w", encoding="utf-8") as f:
            json.dump({"id": tid, "name": name or tid.title(), "members": members}, f)

    def seed_runtime(self, def_id, status="running", agents=(("dev", "idle"),), name="t"):
        ids = {}
        with self.store.transaction() as tx:
            team = tx.create("team", {"name": name, "workspace": self.ws, "def_id": def_id})
            for i, (member_id, availability) in enumerate(agents):
                a = tx.create("agent", {"team_id": team, "ordinal": i, "provider_id": "fake", "role": "developer",
                                        "display_name": f"Agent {i}", "member_id": member_id})
                if availability in ("busy", "waiting_input"):
                    tx.transition("agent", a, "idle")
                    tx.transition("agent", a, "busy")
                    if availability == "waiting_input":
                        tx.transition("agent", a, "waiting_input")
                elif availability != "starting":
                    tx.transition("agent", a, availability)
                ids[member_id or f"#{i}"] = a
            if status == "running":
                tx.transition("team", team, "running")
            elif status == "stopped":
                tx.transition("team", team, "stopping")
                tx.transition("team", team, "stopped")
        return team, ids

    def seed_assignment(self, team, agent, goal, run=True, statuses=()):
        with self.store.transaction() as tx:
            task = tx.create("task", {"team_id": team, "origin": "direct", "workspace": self.ws, "goal": goal})
            asg = tx.create("assignment", {"team_id": team, "task_id": task, "agent_id": agent, "attempt": 1,
                                           "policy": "read_only", "provider_id": "fake"})
            for s in statuses:
                tx.transition("assignment", asg, s)
            run_id = tx.create("workflow_run", {"team_id": team, "task_id": task, "workflow": "test"}) if run else None
        return asg, run_id

    def seed_ticket(self, key, title, agent_id, run_id):
        now = "2026-01-01T00:00:00.000Z"
        phase, tid = store_mod.new_id(), store_mod.new_id()
        self.conn.execute("INSERT INTO phases (id, workspace, slug, name, position, status, created_at, updated_at) "
                          "VALUES (?, ?, ?, 'Phase', 0, 'open', ?, ?)", (phase, self.ws, f"p-{key}", now, now))
        self.conn.execute("INSERT INTO tickets (id, workspace, key, title, body, phase_id, status, priority, "
                          "assignee, active_run_id, created_at, updated_at) "
                          "VALUES (?, ?, ?, ?, 'b', ?, 'in_progress', 100, ?, ?, ?, ?)",
                          (tid, self.ws, key, title, phase, agent_id, run_id, now, now))
        self.conn.commit()

    def ov(self, running=True, conn=True, error=None):
        return teamview.overview(self.conn if conn else None, self.ws, running, error)

    def team(self, out, tid):
        return next(t for t in out["teams"] if t["id"] == tid)

    def member(self, out, tid, mid):
        return next(m for m in self.team(out, tid)["members"] if m["memberId"] == mid)

    def core(self):
        self.put_team("core", [DEV, REV])

    def test_live_members_report_availability_and_work(self):
        self.core()
        team, ids = self.seed_runtime("core", agents=(("dev", "busy"), ("rev", "idle")))
        _, run = self.seed_assignment(team, ids["dev"], "Build it")
        self.seed_ticket("T-001", "Title", ids["dev"], run)
        out = self.ov()
        dev, rev = self.member(out, "core", "dev"), self.member(out, "core", "rev")
        self.assertEqual((dev["presence"], dev["work"]["state"]), ("busy", "working"))
        self.assertEqual(dev["work"]["assignment"]["goal"], "Build it")
        self.assertEqual(dev["work"]["assignment"]["workflowRunId"], run)
        self.assertEqual(dev["work"]["ticket"]["key"], "T-001")
        self.assertEqual(dev["work"]["ticket"]["workflowRunId"], run)
        self.assertEqual((rev["presence"], rev["work"]), ("idle", {"state": "none"}))

    def test_role_and_provider_come_from_workspace_files(self):
        self.core()
        self.seed_runtime("core", agents=(("dev", "idle"), ("rev", "idle")))
        out = self.ov()
        dev, rev = self.member(out, "core", "dev"), self.member(out, "core", "rev")
        self.assertEqual((dev["roleDescription"], dev["roleState"]), ("Implements stories", "defined"))
        self.assertEqual((dev["provider"], dev["model"], dev["reasoning"]), ("codex", "gpt-5", "high"))
        self.assertEqual((dev["source"], dev["agentDefState"], dev["runtime"]["provider"]),
                         ("catalog", "ok", "fake"))
        self.assertEqual((rev["roleDescription"], rev["roleState"], rev["source"], rev["agentDefState"]),
                         (None, "defined", "inline", None))

    def test_multi_team_membership(self):
        self.put_team("alpha", [DEV])
        self.put_team("beta", [DEV])
        self.seed_runtime("alpha")
        out = self.ov()
        a, b = self.member(out, "alpha", "dev"), self.member(out, "beta", "dev")
        self.assertEqual((a["provider"], a["model"]), (b["provider"], b["model"]))
        self.assertEqual(a["presence"], "idle")
        self.assertEqual(self.team(out, "beta")["runtime"]["state"], "not_started")
        self.assertEqual((b["presence"], b["work"], b["runtime"]),
                         ("not_started", {"state": "unavailable", "reason": "not_started"}, None))

    def test_waiting_and_offline_members(self):
        self.core()
        team, ids = self.seed_runtime("core", agents=(("dev", "waiting_input"), ("rev", "offline")))
        self.seed_assignment(team, ids["dev"], "g", statuses=("claimed", "running", "waiting_input"))
        out = self.ov()
        dev, rev = self.member(out, "core", "dev"), self.member(out, "core", "rev")
        self.assertEqual((dev["presence"], rev["presence"]), ("waiting_input", "offline"))
        self.assertEqual(dev["work"]["assignment"]["status"], "waiting_input")

    def test_stopped_team_is_stale_not_live(self):
        self.core()
        team, ids = self.seed_runtime("core", "stopped", agents=(("dev", "idle"),))
        self.seed_assignment(team, ids["dev"], "g")
        out = self.ov()
        dev = self.member(out, "core", "dev")
        self.assertEqual(self.team(out, "core")["runtime"]["state"], "stopped")
        self.assertEqual((dev["presence"], dev["runtime"]["stale"], dev["runtime"]["availability"]),
                         ("stopped", True, "idle"))
        self.assertEqual(dev["work"], {"state": "unavailable", "reason": "stopped"})

    def test_disconnected_when_coordinator_not_running(self):
        self.core()
        self.seed_runtime("core")
        out = self.ov(running=False)
        dev = self.member(out, "core", "dev")
        self.assertEqual(self.team(out, "core")["runtime"]["state"], "disconnected")
        self.assertEqual((dev["presence"], dev["work"]["reason"]), ("disconnected", "disconnected"))

    def test_runtime_unavailable_without_db(self):
        self.core()
        err = {"code": "BACKEND_UNAVAILABLE", "message": "m"}
        out = self.ov(running=False, conn=False, error=err)
        self.assertEqual(out["runtimeState"], {"available": False, "error": err})
        self.assertEqual(self.team(out, "core")["runtime"]["state"], "unavailable")
        self.assertEqual(self.member(out, "core", "dev")["provider"], "codex")
        self.assertTrue(out["partial"])

    def test_member_added_after_start_is_not_in_runtime(self):
        self.put_team("core", [DEV, {"id": "new", "name": "New", "role": "developer", "provider": "fake"}])
        self.seed_runtime("core")
        new = self.member(self.ov(), "core", "new")
        self.assertEqual((new["presence"], new["work"]["reason"]), ("not_in_runtime", "not_in_runtime"))

    def test_runtime_only_member_and_orphan_runtime(self):
        self.put_team("core", [DEV])
        self.seed_runtime("core", agents=(("dev", "idle"), (None, "idle")))
        self.seed_runtime("ghost", agents=(("x", "idle"),), name="Ghost")
        out = self.ov()
        extra = self.team(out, "core")["members"][1]
        self.assertEqual((extra["source"], extra["memberId"], extra["name"]), ("runtime", None, "Agent 1"))
        ghost = self.team(out, "ghost")
        self.assertEqual((ghost["definition"]["state"], ghost["name"]), ("missing", "Ghost"))
        self.assertTrue(out["partial"])

    def test_missing_configuration_states(self):
        self.core()
        self.write("roles.json", "{", raw=True)
        out = self.ov()
        self.assertEqual(out["roles"]["state"], "invalid")
        os.remove(os.path.join(self.ws, ".agent-studio", "roles.json"))
        out = self.ov()
        self.assertEqual(out["roles"]["state"], "missing")
        self.assertEqual(self.member(out, "core", "dev")["roleState"], "unavailable")
        self.assertTrue(out["partial"])
        self.write("roles.json", ROLES)
        self.put_team("core", [dict(DEV, role="ghost")])
        self.assertEqual(self.member(self.ov(), "core", "dev")["roleState"], "undefined")
        self.put_team("core", [dict(DEV, agent="ghost")])
        out = self.ov()
        m = self.member(out, "core", "dev")
        self.assertEqual((m["agentDefState"], m["provider"], m["model"]), ("missing", None, None))
        self.assertEqual(self.team(out, "core")["definition"]["state"], "problems")
        self.put_team("core", [DEV])
        self.write("agents.json", "{", raw=True)
        out = self.ov()
        self.assertEqual(out["catalog"]["state"], "invalid")
        self.assertEqual(self.member(out, "core", "dev")["agentDefState"], "unavailable")
        self.write("agents.json", {"version": 1, "agents": AGENTS})
        self.write("teams/bad.json", "{", raw=True)
        out = self.ov()
        self.assertEqual(self.team(out, "bad")["definition"],
                         {"state": "unreadable", "problems": [
                             {"path": "$", "message": "could not load team definition: TEAM_CONFIG_INVALID"}]})
        self.assertEqual(self.team(out, "core")["definition"]["state"], "valid")

    def test_bounds(self):
        for i in range(51):
            self.put_team(f"t{i:02d}", [REV])
        out = self.ov()
        self.assertEqual(len(out["teams"]), 50)
        self.assertTrue(out["truncated"])
        for i in range(51):
            os.remove(os.path.join(self.ws, ".agent-studio", "teams", f"t{i:02d}.json"))
        long_role = {"version": 1, "roles": {"developer": {"description": "d" * 3000}, "reviewer": {}}}
        self.write("roles.json", long_role)
        members = [dict(REV, id=f"m{i}", name="n" * 300, role="developer") for i in range(20)]
        self.put_team("big", members)
        out = self.ov()
        big = self.team(out, "big")
        self.assertEqual((len(big["members"]), big["membersTruncated"]), (16, True))
        self.assertEqual(len(big["members"][0]["roleDescription"]), 2000)
        self.assertEqual(len(big["members"][0]["name"]), 200)
        self.put_team("core", [DEV])
        team, ids = self.seed_runtime("core", agents=(("dev", "busy"),))
        self.seed_assignment(team, ids["dev"], "x" * 500)
        goal = self.member(self.ov(), "core", "dev")["work"]["assignment"]["goal"]
        self.assertEqual(len(goal), 204)
        self.assertTrue(goal.endswith(" ..."))

    def req(self, **args):
        return dispatch.handle_request({"protocol": PROTOCOL, "id": "r1", "command": "team.overview",
                                        "args": args}, require_id=True)

    def test_dispatch_contract_and_read_only(self):
        self.core()
        with patch.object(dispatch, "_reader", side_effect=AssertionError):
            cases = [({}, "BAD_REQUEST", "Missing required argument 'workspace'."),
                     ({"workspace": "rel"}, "WORKSPACE_NOT_FOUND", "The workspace path must be absolute."),
                     ({"workspace": self.ws, "z": 1, "a": 2}, "BAD_REQUEST",
                      "team.overview got unknown argument(s): a, z."),
                     ({"workspace": self.root}, "WORKSPACE_NOT_FOUND",
                      f"{self.root} is not an Agent Studio workspace (no .agent-studio directory).")]
            for args, code, msg in cases:
                r = self.req(**args)
                self.assertFalse(r["ok"])
                self.assertEqual((r["error"]["code"], r["error"]["message"]), (code, msg))
        self.seed_runtime("core")
        before = [self.conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("commands", "events")]
        with patch.object(dispatch.coordinator, "running_info", return_value={"pid": 1}):
            r = self.req(workspace=self.ws)
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["data"]["workspace"], self.ws)
        self.assertEqual(self.team(r["data"], "core")["runtime"]["state"], "running")
        after = [self.conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("commands", "events")]
        self.assertEqual(before, after)
        os.environ["XDG_STATE_HOME"] = os.path.join(self.root, "empty-home")
        r = self.req(workspace=self.ws)
        self.assertTrue(r["ok"], r)
        self.assertFalse(r["data"]["runtimeState"]["available"])
        self.assertEqual(r["data"]["runtimeState"]["error"]["code"], "BACKEND_UNAVAILABLE")

    def test_teamview_imports_no_board_or_tmux(self):
        with open(teamview.__file__, encoding="utf-8") as f:
            tree = ast.parse(f.read())
        names = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                names.add((node.module or "").split(".")[0])
                names.update(a.name for a in node.names)
            elif isinstance(node, ast.Import):
                names.update(a.name.split(".")[0] for a in node.names)
        self.assertFalse(names & {"boardmodel", "boardsched", "queries", "tmuxctl", "coordinator"}, names)


if __name__ == "__main__":
    unittest.main()
