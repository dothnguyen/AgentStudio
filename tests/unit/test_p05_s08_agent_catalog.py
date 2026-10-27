import argparse
import json
import os
import shutil
import tempfile
import unittest

from tests import helpers  # noqa: F401  (puts backend on sys.path)
from agent_studio import PROTOCOL, agentcatalog, cli, dispatch, teamdefs, workspace

ROLES = {"version": 1, "roles": {"developer": {}, "reviewer": {}}}
ADA = {"id": "ada", "name": "Ada", "description": "Implements backend stories.", "provider": "fake",
       "model": "fake-1", "reasoning": "high"}


class Base(unittest.TestCase):
    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="as-ac-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self._old = os.environ.get("XDG_STATE_HOME")
        os.environ["XDG_STATE_HOME"] = os.path.join(self.root, "state")
        self.addCleanup(self._restore)
        self.ws = os.path.join(self.root, "proj")
        os.makedirs(self.ws)
        workspace.init(self.ws)
        self.cfg = os.path.join(self.ws, ".agent-studio")

    def _restore(self):
        if self._old is None:
            os.environ.pop("XDG_STATE_HOME", None)
        else:
            os.environ["XDG_STATE_HOME"] = self._old

    def write(self, name, obj):
        with open(os.path.join(self.cfg, name), "w", encoding="utf-8") as f:
            json.dump(obj, f)

    def team_file(self, tid="t"):
        return os.path.join(self.cfg, "teams", f"{tid}.json")

    def put_team(self, team, tid="t"):
        os.makedirs(os.path.join(self.cfg, "teams"), exist_ok=True)
        with open(self.team_file(tid), "w", encoding="utf-8") as f:
            f.write(json.dumps(team, indent=2, ensure_ascii=False) + "\n")

    def call(self, command, **args):
        return dispatch.handle_request({"protocol": PROTOCOL, "command": command,
                                        "args": dict(args, workspace=self.ws)}, require_id=False)

    def catalog_bytes(self):
        try:
            with open(agentcatalog.path(self.ws), "rb") as f:
                return f.read()
        except FileNotFoundError:
            return None

    def ok(self, r):
        self.assertTrue(r["ok"], r)
        return r["data"]

    def err(self, r, code):
        self.assertFalse(r["ok"], r)
        self.assertEqual(r["error"]["code"], code, r)
        return r

    def tmp_files(self):
        return [n for n in os.listdir(self.cfg) if n.endswith(".tmp")]


class CatalogTests(Base):
    def test_missing_file_lists_empty(self):
        d = self.ok(self.call("agentdef.list"))
        self.assertEqual((d["agents"], d["problems"], d["version"]), ([], [], 1))
        self.assertIsNone(self.catalog_bytes())

    def test_create_update_delete_round_trip_survives_reload(self):
        self.ok(self.call("agentdef.create", agent=dict(ADA)))
        with open(agentcatalog.path(self.ws), encoding="utf-8") as f:
            self.assertEqual(json.load(f), {"version": 1, "agents": [ADA]})
        raw = self.catalog_bytes().decode("utf-8")
        self.assertTrue(raw.endswith("\n"))
        self.assertIn('\n  "version"', raw)
        self.assertEqual(self.ok(self.call("agentdef.list"))["agents"], [ADA])
        self.ok(self.call("agentdef.update", agentDefId="ada", changes={"model": "fake-2", "reasoning": None}))
        with open(agentcatalog.path(self.ws), encoding="utf-8") as f:
            entry = json.load(f)["agents"][0]
        self.assertEqual(entry["model"], "fake-2")
        self.assertNotIn("reasoning", entry)
        d = self.ok(self.call("agentdef.delete", agentDefId="ada"))
        self.assertEqual(d["deleted"]["id"], "ada")
        with open(agentcatalog.path(self.ws), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["agents"], [])

    def test_create_derives_id_from_name(self):
        d = self.ok(self.call("agentdef.create", agent={"name": "Dev One", "provider": "fake"}))
        self.assertEqual(d["agent"]["id"], "dev-one")

    def test_duplicate_id_rejected_file_unchanged(self):
        self.ok(self.call("agentdef.create", agent=dict(ADA)))
        before = self.catalog_bytes()
        r = self.err(self.call("agentdef.create", agent=dict(ADA)), "AGENT_EXISTS")
        self.assertEqual(r["error"]["message"], "Agent 'ada' already exists.")
        self.assertEqual(self.catalog_bytes(), before)

    def test_invalid_fields_rejected_file_unchanged(self):
        cases = [
            ({"id": "Ada!", "name": "A", "provider": "fake"}, "agent.id", None),
            ({"id": "a", "provider": "fake"}, "agent.name", None),
            ({"id": "a", "name": "x" * 81, "provider": "fake"}, "agent.name", None),
            ({"id": "a", "name": "A", "provider": "fake", "description": "x" * 4001}, "agent.description", None),
            ({"id": "a", "name": "A", "provider": "gemini"}, "agent.provider", "unknown provider 'gemini'"),
            ({"id": "a", "name": "A", "provider": "agy", "model": "x"}, "agent.model",
             "agy: choosing a model is not supported."),
            ({"id": "a", "name": "A", "provider": "fake", "reasoning": "extreme"}, "agent.reasoning", None),
            ({"id": "a", "name": "A", "provider": "fake", "model": 5}, "agent.model", "must be a string"),
        ]
        self.ok(self.call("agentdef.create", agent=dict(ADA)))
        before = self.catalog_bytes()
        for agent, path, msg in cases:
            with self.subTest(path=path, agent=agent):
                r = self.err(self.call("agentdef.create", agent=agent), "AGENT_CATALOG_INVALID")
                found = [p for p in r["data"]["problems"] if p["path"] == path]
                self.assertTrue(found, r["data"])
                if msg:
                    self.assertTrue(found[0]["message"].startswith(msg), found)
                self.assertEqual(self.catalog_bytes(), before)

    def test_request_shape_errors(self):
        self.ok(self.call("agentdef.create", agent=dict(ADA)))
        before = self.catalog_bytes()
        slug = "agentDefId must be a slug (lowercase letters, digits, '-'; at most 64 characters)."
        cases = [
            ("agentdef.create", {"agent": ADA, "x": 1}, "agentdef.create got unknown argument(s): x."),
            ("agentdef.create", {"agent": "ada"}, "agent must be an object."),
            ("agentdef.create", {"agent": {"name": "A", "provider": "fake", "role": "dev"}},
             "agent has unknown field(s): role."),
            ("agentdef.create", {}, "Missing required argument 'agent'."),
            ("agentdef.update", {"agentDefId": "ada", "changes": {"id": "b"}}, "An agent id cannot be changed."),
            ("agentdef.update", {"agentDefId": "ada", "changes": {}}, "changes needs at least one field."),
            ("agentdef.update", {"agentDefId": "Bad Id", "changes": {"name": "x"}}, slug),
            ("agentdef.update", {"agentDefId": "ada"}, "Missing required argument 'changes'."),
        ]
        for command, args, msg in cases:
            with self.subTest(command=command, args=args):
                r = self.err(self.call(command, **args), "BAD_REQUEST")
                self.assertEqual(r["error"]["message"], msg)
                self.assertEqual(self.catalog_bytes(), before)

    def test_update_provider_change_revalidates_settings(self):
        self.ok(self.call("agentdef.create", agent=dict(ADA)))
        before = self.catalog_bytes()
        r = self.err(self.call("agentdef.update", agentDefId="ada", changes={"provider": "agy"}),
                      "AGENT_CATALOG_INVALID")
        paths = {p["path"] for p in r["data"]["problems"]}
        self.assertTrue(paths & {"agents[0].model", "agents[0].reasoning"}, paths)
        self.assertEqual(self.catalog_bytes(), before)

    def test_unknown_id_not_found(self):
        for command, args in (("agentdef.update", {"changes": {"name": "Z"}}), ("agentdef.delete", {})):
            with self.subTest(command=command):
                r = self.err(self.call(command, agentDefId="zed", **args), "AGENT_NOT_FOUND")
                self.assertEqual(r["error"]["message"], "No agent 'zed' in agents.json.")

    def test_referenced_delete_rejected(self):
        self.ok(self.call("agentdef.create", agent=dict(ADA)))
        team = {"id": "alpha", "name": "Alpha", "members": [
            {"id": "a1", "name": "A1", "role": "developer", "agent": "ada"}]}
        self.put_team(team, "alpha")
        self.put_team(dict(team, id="beta", name="Beta"), "beta")
        files = [self.catalog_bytes()] + [open(self.team_file(t), "rb").read() for t in ("alpha", "beta")]
        r = self.err(self.call("agentdef.delete", agentDefId="ada"), "AGENT_IN_USE")
        self.assertEqual(r["error"]["message"], "Agent 'ada' is used by team(s): alpha, beta.")
        self.assertEqual(r["data"], {"teams": ["alpha", "beta"]})
        after = [self.catalog_bytes()] + [open(self.team_file(t), "rb").read() for t in ("alpha", "beta")]
        self.assertEqual(files, after)
        for t in ("alpha", "beta"):
            self.put_team(dict(team, id=t, members=[]), t)
        self.ok(self.call("agentdef.delete", agentDefId="ada"))

    def test_unreadable_team_file_blocks_delete(self):
        self.ok(self.call("agentdef.create", agent=dict(ADA)))
        os.makedirs(os.path.join(self.cfg, "teams"), exist_ok=True)
        with open(self.team_file("broken"), "w") as f:
            f.write("{not json")
        before = self.catalog_bytes()
        self.err(self.call("agentdef.delete", agentDefId="ada"), "TEAM_CONFIG_INVALID")
        self.assertEqual(self.catalog_bytes(), before)

    def test_hand_edited_fields_preserved(self):
        self.write("agents.json", {"version": 1, "x-note": "keep", "agents": [dict(ADA, color="teal")]})
        self.ok(self.call("agentdef.update", agentDefId="ada", changes={"name": "Ada L"}))
        with open(agentcatalog.path(self.ws), encoding="utf-8") as f:
            data = json.load(f)
        self.assertEqual(data["x-note"], "keep")
        self.assertEqual(data["agents"][0]["color"], "teal")
        self.assertEqual(data["agents"][0]["name"], "Ada L")
        self.assertEqual(list(data["agents"][0]), list(dict(ADA, color="teal")))

    def test_invalid_catalog_never_rewritten(self):
        self.write("roles.json", ROLES)
        with open(agentcatalog.path(self.ws), "w") as f:
            f.write("{not json")
        broken = self.catalog_bytes()
        self.err(self.call("agentdef.list"), "AGENT_CATALOG_INVALID")
        self.err(self.call("agentdef.create", agent=dict(ADA)), "AGENT_CATALOG_INVALID")
        self.assertEqual(self.catalog_bytes(), broken)
        bad = [{"version": 2, "agents": []}, {"version": 1, "agents": [ADA, dict(ADA)]}]
        for obj in bad:
            with self.subTest(obj=obj):
                self.write("agents.json", obj)
                before = self.catalog_bytes()
                self.assertTrue(self.ok(self.call("agentdef.list"))["problems"])
                self.err(self.call("agentdef.create", agent={"id": "z", "name": "Z", "provider": "fake"}),
                          "AGENT_CATALOG_INVALID")
                self.err(self.call("agentdef.update", agentDefId="ada", changes={"name": "Q"}),
                          "AGENT_CATALOG_INVALID")
                self.err(self.call("agentdef.delete", agentDefId="ada"), "AGENT_CATALOG_INVALID")
                self.assertEqual(self.catalog_bytes(), before)
        self.assertEqual(self.tmp_files(), [])

    def test_workspace_without_config_dir(self):
        bare = os.path.join(self.root, "bare")
        os.makedirs(bare)
        for command, args in (("agentdef.list", {}), ("agentdef.create", {"agent": dict(ADA)})):
            r = dispatch.handle_request({"protocol": PROTOCOL, "command": command,
                                         "args": dict(args, workspace=bare)}, require_id=False)
            self.err(r, "WORKSPACE_NOT_FOUND")
        self.assertEqual(os.listdir(bare), [])

    def test_inline_members_still_valid_with_catalog_present(self):
        self.write("roles.json", ROLES)
        self.ok(self.call("agentdef.create", agent=dict(ADA)))
        team = {"id": "t", "name": "T", "members": [
            {"id": "ryan", "name": "Ryan", "role": "developer", "provider": "fake"}]}
        self.put_team(team, "t")
        before = open(self.team_file(), "rb").read()
        self.assertEqual(teamdefs.validate(self.ws, team, "t"), [])
        self.ok(self.call("agentdef.update", agentDefId="ada", changes={"name": "Ada 2"}))
        roster = cli._definition_start_args(self.ws, argparse.Namespace(team="t", name=None))["roster"]
        self.assertEqual(roster, [{"memberId": "ryan", "displayName": "Ryan", "providerId": "fake",
                                   "role": "developer"}])
        self.assertEqual(open(self.team_file(), "rb").read(), before)

    def test_commands_registered(self):
        for name in ("agentdef.list", "agentdef.create", "agentdef.update", "agentdef.delete"):
            self.assertIn(name, dispatch.COMMANDS)
        self.assertEqual({n for n in dispatch.COMMANDS if n.startswith("team.")},
                         {"team.attach", "team.start", "team.stop", "team.status", "team.list",
                          "team.overview"})


if __name__ == "__main__":
    unittest.main()
