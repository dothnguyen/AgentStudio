import json
import os
import shutil
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from tests import helpers  # noqa: F401  (puts backend on sys.path)
from agent_studio import PROTOCOL, agentcatalog, cli, dispatch, state, teamdefs
from agent_studio.store import Store

ROLES = {"version": 1, "roles": {"developer": {}, "reviewer": {}}}
AGENTS = [{"id": "dev-codex", "name": "Dev Codex", "provider": "codex", "model": "gpt-5", "reasoning": "high"},
          {"id": "rev-fake", "name": "Rev Fake", "provider": "fake"}]
CATALOG_MSG = "agent 'ghost' is not defined in .agent-studio/agents.json"


class TeamEditTests(unittest.TestCase):
    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="as-team-edit-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.ws = os.path.join(self.root, "workspace")
        os.makedirs(os.path.join(self.ws, ".agent-studio"))
        with open(os.path.join(self.ws, ".agent-studio", "roles.json"), "w", encoding="utf-8") as f:
            json.dump(ROLES, f)
        self.old = os.environ.get("XDG_STATE_HOME")
        self.addCleanup(self._restore)
        self.set_state_home(os.path.join(self.root, "state-home"), create_db=True)
        self.put_catalog(AGENTS)

    def _restore(self):
        if self.old is None:
            os.environ.pop("XDG_STATE_HOME", None)
        else:
            os.environ["XDG_STATE_HOME"] = self.old

    def set_state_home(self, home, create_db):
        os.environ["XDG_STATE_HOME"] = home
        sd = os.path.join(home, "agent-studio")
        os.makedirs(sd)
        if create_db:
            db = state.db_path(sd)
            self.conn = state.connect(db, role="coordinator", create=True)
            state.migrate(self.conn, db)
            self.addCleanup(self.conn.close)
            self.store = Store(self.conn)

    def put_catalog(self, agents):
        with open(os.path.join(self.ws, ".agent-studio", "agents.json"), "w", encoding="utf-8") as f:
            json.dump({"version": 1, "agents": agents}, f)

    def put_team(self, tid, body):
        d = os.path.join(self.ws, ".agent-studio", "teams")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f"{tid}.json"), "w", encoding="utf-8") as f:
            json.dump(body, f, ensure_ascii=False)

    def raw(self, tid):
        with open(os.path.join(self.ws, ".agent-studio", "teams", f"{tid}.json"), "rb") as f:
            return f.read()

    def seed_runtime(self, def_id, status):
        with self.store.transaction() as tx:
            tid = tx.create("team", {"name": "t", "workspace": self.ws, "def_id": def_id})
            if status == "running":
                tx.transition("team", tid, "running")
            elif status == "stopped":
                tx.transition("team", tid, "stopping")
                tx.transition("team", tid, "stopped")
        return tid

    def req(self, command, args):
        return dispatch.handle_request({"protocol": PROTOCOL, "id": "r1", "command": command, "args": args},
                                       require_id=True)

    def tdreq(self, command, **args):
        args.setdefault("workspace", self.ws)
        if command != "teamdef.create":
            args.setdefault("teamDefId", "core")
        return self.req(command, args)

    def build_core(self):
        self.assertTrue(self.tdreq("teamdef.create", name="Core")["ok"])
        r = self.tdreq("teamdef.member.add", agent="dev-codex", role="developer")
        self.assertTrue(r["ok"], r)
        r = self.tdreq("teamdef.member.add", agent="rev-fake", role="reviewer", name="Rex")
        self.assertTrue(r["ok"], r)

    def test_assemble_from_catalog_and_validate_ready(self):
        self.build_core()
        r = self.tdreq("teamdef.validate")
        self.assertTrue(r["ok"], r)
        d = r["data"]
        self.assertTrue(d["ready"])
        self.assertEqual(d["roster"][0], {"id": "dev-codex", "name": "Dev Codex", "role": "developer",
                                          "source": "catalog", "agent": "dev-codex", "provider": "codex",
                                          "model": "gpt-5", "reasoning": "high", "canAddTickets": None})
        self.assertEqual((d["roster"][1]["id"], d["roster"][1]["provider"]), ("rex", "fake"))
        members = json.loads(self.raw("core"))["members"]
        self.assertEqual([list(m) for m in members], [["id", "name", "role", "agent"]] * 2)

    def test_cli_start_args_resolve_catalog_members(self):
        self.build_core()
        out = cli._definition_start_args(self.ws, SimpleNamespace(team="core", name=None))
        self.assertEqual(out["roster"][0], {"memberId": "dev-codex", "displayName": "Dev Codex",
                                            "providerId": "codex", "role": "developer", "model": "gpt-5",
                                            "reasoning": "high"})

    def test_validate_not_ready_lists_problems(self):
        self.tdreq("teamdef.create", name="Core")
        d = self.tdreq("teamdef.validate")["data"]
        self.assertFalse(d["ready"])
        self.assertEqual(d["problems"], [{"path": "members", "message": "the team has no members"}])
        self.put_team("core", {"id": "core", "name": "Core", "members": [
            {"id": "a", "name": "A", "role": "developer", "agent": "ghost"}]})
        d = self.tdreq("teamdef.validate")["data"]
        self.assertEqual(d["problems"], [{"path": "members[0].agent", "message": CATALOG_MSG}])
        self.assertEqual(d["roster"], [])

    def put_inline(self):
        self.put_team("core", {"id": "core", "name": "Core", "note": "ü", "members": [
            {"id": "a", "name": "A", "role": "developer", "provider": "codex", "x": [1]}]})

    def test_legacy_inline_members_still_valid_and_editable(self):
        self.put_inline()
        d = self.tdreq("teamdef.validate")["data"]
        self.assertTrue(d["ready"])
        self.assertEqual(d["roster"][0]["source"], "inline")
        r = self.tdreq("teamdef.member.update", memberId="a", model="gpt-5")
        self.assertTrue(r["ok"], r)
        t = json.loads(self.raw("core"))
        self.assertEqual(t["note"], "ü")
        self.assertEqual(list(t["members"][0]), ["id", "name", "role", "provider", "x", "model"])

    def test_migrate_inline_to_catalog_and_back(self):
        self.put_inline()
        self.tdreq("teamdef.member.update", memberId="a", model="gpt-5")
        r = self.tdreq("teamdef.member.update", memberId="a", agent="dev-codex")
        self.assertTrue(r["ok"], r)
        m = json.loads(self.raw("core"))["members"][0]
        self.assertEqual(m, {"id": "a", "name": "A", "role": "developer", "x": [1], "agent": "dev-codex"})
        r = self.tdreq("teamdef.member.update", memberId="a", provider="codex")
        self.assertTrue(r["ok"], r)
        self.assertNotIn("agent", json.loads(self.raw("core"))["members"][0])

    def test_invalid_edits_write_nothing(self):
        self.build_core()
        cases = [
            ("add ghost", "teamdef.member.add", dict(agent="ghost", role="developer", name="G"),
             "TEAM_CONFIG_INVALID", None, "members[2].agent"),
            ("bad role", "teamdef.member.add", dict(agent="dev-codex", role="nope", name="N"),
             "TEAM_CONFIG_INVALID", None, "members[2].role"),
            ("both", "teamdef.member.add", dict(agent="dev-codex", provider="codex", role="developer"),
             "BAD_REQUEST", "Give agent or provider, not both.", None),
            ("neither", "teamdef.member.add", dict(role="developer", name="N"), "BAD_REQUEST",
             "teamdef.member.add needs agent (a catalog agent id) or provider.", None),
            ("agent+model", "teamdef.member.add", dict(agent="dev-codex", role="developer", model="x"),
             "BAD_REQUEST", "model and reasoning come from agent 'dev-codex' in .agent-studio/agents.json; "
                            "edit the agent instead.", None),
            ("dup", "teamdef.member.add", dict(agent="dev-codex", role="developer"), "MEMBER_EXISTS",
             "Team 'core' already has a member 'dev-codex'.", None),
            ("unknown member", "teamdef.member.update", dict(memberId="zz", name="Z"), "MEMBER_NOT_FOUND",
             "No member 'zz' in team 'core'.", None),
            ("empty update", "teamdef.member.update", dict(memberId="rex"), "BAD_REQUEST",
             "teamdef.member.update needs at least one change.", None),
            ("clear role", "teamdef.member.update", dict(memberId="rex", role=None), "BAD_REQUEST",
             "name, role, agent and provider cannot be cleared.", None),
            ("unknown arg", "teamdef.member.add", dict(agent="dev-codex", role="developer", x=1), "BAD_REQUEST",
             "teamdef.member.add got unknown argument(s): x.", None),
            ("rename empty", "teamdef.rename", dict(name=""), "BAD_REQUEST",
             "Argument 'name' must not be empty.", None),
            ("create existing", "teamdef.create", dict(name="Core"), "TEAM_EXISTS", None, None),
        ]
        for label, command, args, code, message, path in cases:
            with self.subTest(label):
                before = self.raw("core")
                r = self.tdreq(command, **args)
                self.assertFalse(r["ok"], r)
                self.assertEqual(r["error"]["code"], code)
                if message:
                    self.assertEqual(r["error"]["message"], message)
                if path:
                    self.assertEqual(r["data"]["problems"][0]["path"], path)
                self.assertEqual(self.raw("core"), before)

    def test_unknown_agent_and_ninth_member(self):
        self.put_team("core", {"id": "core", "name": "Core", "members": []})
        before = self.raw("core")
        r = self.tdreq("teamdef.member.add", agent="ghost", role="developer", name="G")
        self.assertEqual(r["data"]["problems"], [{"path": "members[0].agent", "message": CATALOG_MSG}])
        self.assertEqual(self.raw("core"), before)
        self.put_team("core", {"id": "core", "name": "Core", "members": [
            {"id": f"m{i}", "name": f"M{i}", "role": "developer", "agent": "rev-fake"} for i in range(8)]})
        before = self.raw("core")
        r = self.tdreq("teamdef.member.add", agent="rev-fake", role="developer", name="Nine")
        self.assertEqual(r["error"]["code"], "TEAM_CONFIG_INVALID")
        self.assertEqual(r["data"]["problems"][0]["path"], "members")
        self.assertEqual(self.raw("core"), before)

    def test_preexisting_problem_does_not_block_unrelated_edit(self):
        self.put_team("core", {"id": "core", "name": "Core", "members": [
            {"id": "bad", "name": "Bad", "role": "ghost", "provider": "fake"}]})
        r = self.tdreq("teamdef.member.add", agent="dev-codex", role="developer")
        self.assertTrue(r["ok"], r)
        self.assertEqual([p["path"] for p in r["data"]["problems"]], ["members[0].role"])
        self.assertEqual(len(json.loads(self.raw("core"))["members"]), 2)

    def test_active_team_rejects_delete_and_remove(self):
        self.build_core()
        self.seed_runtime("core", "running")
        before = self.raw("core")
        r = self.tdreq("teamdef.delete")
        self.assertEqual(r["error"]["code"], "TEAM_ALREADY_RUNNING")
        self.assertEqual(r["error"]["message"], "Team 'core' is running in this workspace; stop it before deleting it.")
        self.assertEqual(r["data"]["teamDefId"], "core")
        self.assertEqual(r["error"]["remediation"], "run agent-studio team stop --team core")
        r = self.tdreq("teamdef.member.remove", memberId="dev-codex")
        self.assertEqual(r["error"]["code"], "TEAM_ALREADY_RUNNING")
        self.assertTrue(r["error"]["message"].endswith("before removing member 'dev-codex'."))
        self.assertEqual(self.raw("core"), before)
        r = self.tdreq("teamdef.rename", name="Core 2")
        self.assertTrue(r["ok"] and r["data"]["appliesOnNextStart"], r)
        r = self.tdreq("teamdef.member.add", agent="rev-fake", role="reviewer", name="Third")
        self.assertTrue(r["ok"] and r["data"]["appliesOnNextStart"], r)
        self.assertEqual(self.tdreq("teamdef.show")["data"]["active"]["status"], "running")

    def test_stopped_team_allows_delete_and_remove(self):
        self.build_core()
        self.seed_runtime("core", "stopped")
        r = self.tdreq("teamdef.member.remove", memberId="dev-codex")
        self.assertTrue(r["ok"], r)
        self.assertNotIn("appliesOnNextStart", r["data"])
        self.assertEqual([m["id"] for m in json.loads(self.raw("core"))["members"]], ["rex"])
        r = self.tdreq("teamdef.member.add", agent="dev-codex", role="developer")
        self.assertIs(r["data"]["appliesOnNextStart"], False)
        self.assertTrue(self.tdreq("teamdef.delete")["ok"])
        self.assertFalse(os.path.exists(os.path.join(self.ws, ".agent-studio", "teams", "core.json")))
        self.assertEqual(self.tdreq("teamdef.show")["error"]["code"], "TEAM_NOT_FOUND")

    def test_no_state_db_means_inactive(self):
        self.build_core()
        self.set_state_home(os.path.join(self.root, "fresh"), create_db=False)
        r = self.tdreq("teamdef.delete")
        self.assertTrue(r["ok"], r)

    def test_catalog_member_with_provider_key_is_a_problem(self):
        team = {"id": "core", "name": "Core", "members": [
            {"id": "a", "name": "A", "role": "developer", "agent": "dev-codex", "provider": "codex"}]}
        self.assertIn({"path": "members[0].provider",
                       "message": "must not be set on a member that uses agent 'dev-codex'; "
                                  "edit the agent in .agent-studio/agents.json"},
                      teamdefs.validate(self.ws, team, "core"))

    def test_invalid_catalog_reported_once(self):
        with open(os.path.join(self.ws, ".agent-studio", "agents.json"), "w") as f:
            f.write("{nope")
        team = {"id": "core", "name": "Core", "members": [
            {"id": "a", "name": "A", "role": "developer", "agent": "dev-codex"},
            {"id": "b", "name": "B", "role": "developer", "agent": "rev-fake"}]}
        problems = teamdefs.validate(self.ws, team, "core")
        self.assertEqual([p["path"] for p in problems], ["agents.json"])
        inline = {"id": "core", "name": "Core", "members": [
            {"id": "a", "name": "A", "role": "developer", "provider": "fake"}]}
        self.assertEqual(teamdefs.validate(self.ws, inline, "core"), [])

    def test_agent_references_find_catalog_members(self):
        self.build_core()
        self.put_team("other", {"id": "other", "name": "O", "members": []})
        self.assertEqual(agentcatalog.references(self.ws, "dev-codex"), ["core"])

    def test_agent_references_skip_unreadable_team_file(self):
        self.build_core()
        d = os.path.join(self.ws, ".agent-studio", "teams")
        with open(os.path.join(d, "broken.json"), "w") as f:
            f.write("{nope")
        self.assertEqual(agentcatalog.references(self.ws, "dev-codex"), ["core"])

    def test_rename_inactive_team_succeeds_without_next_start_flag(self):
        self.build_core()
        r = self.tdreq("teamdef.rename", name="Renamed")
        self.assertTrue(r["ok"], r)
        self.assertIs(r["data"]["appliesOnNextStart"], False)
        self.assertEqual(json.loads(self.raw("core"))["name"], "Renamed")

    def test_validate_with_invalid_catalog_is_not_ready_and_does_not_raise(self):
        self.build_core()
        with open(os.path.join(self.ws, ".agent-studio", "agents.json"), "w") as f:
            f.write("{nope")
        r = self.tdreq("teamdef.validate")
        self.assertTrue(r["ok"], r)
        self.assertFalse(r["data"]["ready"])
        self.assertEqual(r["data"]["roster"], [])
        self.assertEqual([p["path"] for p in r["data"]["problems"]], ["agents.json"])

    def test_update_catalog_member_with_model_is_rejected(self):
        self.build_core()
        before = self.raw("core")
        r = self.tdreq("teamdef.member.update", memberId="rex", model="x")
        self.assertEqual(r["error"]["code"], "BAD_REQUEST")
        self.assertEqual(self.raw("core"), before)

    def test_update_unknown_agent_writes_nothing(self):
        self.build_core()
        before = self.raw("core")
        r = self.tdreq("teamdef.member.update", memberId="rex", agent="ghost")
        self.assertEqual(r["error"]["code"], "TEAM_CONFIG_INVALID")
        self.assertEqual(r["data"]["problems"][0]["path"], "members[1].agent")
        self.assertEqual(self.raw("core"), before)

    def test_remove_unknown_member_writes_nothing(self):
        self.build_core()
        before = self.raw("core")
        r = self.tdreq("teamdef.member.remove", memberId="zz")
        self.assertEqual(r["error"]["code"], "MEMBER_NOT_FOUND")
        self.assertEqual(self.raw("core"), before)

    def test_validation_runs_before_reader(self):
        with patch.object(dispatch, "_reader", side_effect=AssertionError):
            r = self.req("teamdef.show", {"workspace": self.ws, "teamDefId": "Bad_Id"})
        self.assertEqual(r["error"]["code"], "BAD_REQUEST")
        self.assertEqual(r["error"]["message"],
                         "teamDefId must be a slug (lowercase letters, digits, '-'; at most 64 characters).")

    def test_commands_registered_and_team_actions_absent(self):
        for c in ("show", "validate", "create", "rename", "delete", "member.add", "member.update",
                  "member.remove"):
            self.assertIn(f"teamdef.{c}", dispatch.COMMANDS)
        for c in ("add", "show", "validate", "add-member", "remove-member"):
            self.assertNotIn(f"team.{c}", dispatch.COMMANDS)


if __name__ == "__main__":
    unittest.main()
