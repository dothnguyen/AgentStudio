import hashlib
import json
import os
from unittest import mock

from tests.unit import test_p05_s10_team_overview as fixture
from agent_studio import PROTOCOL, dispatch, rolecatalog, roles

DOC = {"version": 1, "extra": 1, "roles": {
    "victim": {"name": "Victim", "description": "d", "instructions": "roles/victim.md", "skills": ["s"]},
    "other": {"name": "Other", "description": "o"},
    "developer": {"description": "Implements stories"}, "reviewer": {}}}
WORKFLOW = {"version": 1, "stages": [{"id": "work", "role": "victim", "permission": "read_only",
                                      "prompt": "{{task}}", "next": {"done": "$succeed"}}]}
YAML = ("version: 1\nstages:\n- id: work\n  role: victim\n  permission: read_only\n  prompt: '{{task}}'\n"
        "  next: {done: '$succeed'}\n")
BOARD = {"version": 2, "statuses": [{"id": "todo", "kind": "initial"}, {"id": "done", "kind": "done"}],
         "rules": [{"when": {"status": "todo"}, "role": "victim", "workflow": "builtin", "onPass": "done", "onFail": "todo"}]}


def sha(data):
    return hashlib.sha256(data).hexdigest() if data is not None else None


class RoleDeleteTests(fixture.TeamOverviewTests):
    def setUp(self):
        super().setUp()
        self.base = os.path.join(self.ws, ".agent-studio")
        self.write("roles.json", DOC)
        self.write("board.json", {"version": 2, "statuses": BOARD["statuses"], "rules": []})
        os.makedirs(os.path.join(self.base, "roles"))
        os.makedirs(os.path.join(self.base, "skills", "s"))
        self.put("roles/victim.md", b"victim text")
        self.put("skills/s/SKILL.md", b"skill")

    def put(self, rel, data):
        path = os.path.join(self.base, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)

    def get(self, rel):
        try:
            with open(os.path.join(self.base, rel), "rb") as f:
                return f.read()
        except FileNotFoundError:
            return None

    def snapshot(self):
        out = {}
        for root, _, files in os.walk(self.base):
            for name in files:
                p = os.path.join(root, name)
                out[os.path.relpath(p, self.base)] = open(p, "rb").read()
        db = os.path.join(self.home, "agent-studio")
        for name in sorted(os.listdir(db)):
            if name.endswith(".db"):
                out["db:" + name] = self.conn.execute("SELECT count(*) FROM agents").fetchone()[0]
        return out

    def tokens(self, rel="roles/victim.md"):
        return sha(self.get("roles.json")), sha(self.get(rel))

    def delete(self, role="victim", rel="roles/victim.md", **over):
        r, i = self.tokens(rel)
        args = {"workspace": self.ws, "roleId": role, "expectedRolesSha256": r, "expectedInstructionsSha256": i}
        args.update(over)
        args = {k: v for k, v in args.items() if v is not ...}
        return dispatch.handle_request({"protocol": PROTOCOL, "command": "role.delete", "args": args}, False)

    def rejected(self, code, resp=None, **over):
        before = self.snapshot()
        resp = resp or self.delete(**over)
        self.assertFalse(resp["ok"], resp)
        self.assertEqual(resp["error"]["code"], code, resp)
        self.assertEqual(self.snapshot(), before)
        return resp

    def ok(self, **over):
        resp = self.delete(**over)
        self.assertTrue(resp["ok"], resp)
        return resp["data"]

    def usage(self, resp):
        return resp["data"]["usage"]

    def workflows(self):
        folder = os.path.join(self.base, "workflows")
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, "first.json"), "w") as f:
            json.dump(WORKFLOW, f)
        with open(os.path.join(folder, "second.yaml"), "w") as f:
            f.write(YAML)

    # ---- references ----
    def test_saved_team_member_blocks_delete(self):
        self.put_team("core", [dict(id="dev", name="Dev", role="victim")])
        u = self.usage(self.rejected("ROLE_IN_USE"))
        self.assertEqual((u["members"][0]["teamDefId"], u["members"][0]["memberId"]), ("core", "dev"))

    def test_legacy_roster_blocks_delete(self):
        self.write("team.json", {"version": 1, "agents": [{"providerId": "fake", "role": "victim", "name": "Old"}]})
        u = self.usage(self.rejected("ROLE_IN_USE"))
        self.assertEqual((u["legacyRoster"][0]["memberIndex"], u["legacyRoster"][0]["memberName"]), (0, "Old"))

    def test_board_rule_blocks_delete(self):
        self.write("board.json", BOARD)
        u = self.usage(self.rejected("ROLE_IN_USE"))
        self.assertEqual((u["boardRules"][0]["index"], u["boardRules"][0]["status"]), (0, "todo"))

    def test_json_workflow_stage_blocks_delete(self):
        self.workflows()
        os.unlink(os.path.join(self.base, "workflows", "second.yaml"))
        u = self.usage(self.rejected("ROLE_IN_USE"))
        self.assertEqual([(w["name"], w["stageId"]) for w in u["workflows"]], [("first", "work")])

    def test_yaml_workflow_stage_blocks_delete(self):
        self.workflows()
        os.unlink(os.path.join(self.base, "workflows", "first.json"))
        u = self.usage(self.rejected("ROLE_IN_USE"))
        self.assertEqual([(w["name"], w["stageId"]) for w in u["workflows"]], [("second", "work")])

    def test_starting_and_running_runtime_block_delete(self):
        for status in ("starting", "running"):
            team, agents = self.seed_runtime("rt-" + status, status=status, agents=(("dev", "idle"),))
            self.conn.execute("UPDATE agents SET role='victim' WHERE team_id=?", (team,))
            self.conn.commit()
        u = self.usage(self.rejected("ROLE_IN_USE"))
        self.assertEqual(sorted((m["teamDefId"], m["memberId"]) for m in u["members"]),
                         [("rt-running", "dev"), ("rt-starting", "dev")])
        self.assertTrue(all(m["live"]["agentId"] for m in u["members"]))

    def test_combined_references_return_one_complete_usage(self):
        self.put_team("core", [dict(id="dev", name="Dev", role="victim")])
        self.write("team.json", {"version": 1, "agents": [{"providerId": "fake", "role": "victim", "name": "Old"}]})
        self.write("board.json", BOARD)
        self.workflows()
        self.seed_runtime("live")
        self.conn.execute("UPDATE agents SET role='victim'")
        self.conn.commit()
        u = self.usage(self.rejected("ROLE_IN_USE"))
        self.assertEqual((len(u["members"]), len(u["legacyRoster"]), len(u["boardRules"]), len(u["workflows"])),
                         (2, 1, 1, 2))
        self.assertEqual(u["count"], 6)

    def test_stopped_runtime_and_frozen_assignment_do_not_block(self):
        team, agents = self.seed_runtime("old", status="stopped")
        self.conn.execute("UPDATE agents SET role='victim'")
        self.conn.commit()
        before = self.conn.execute("SELECT count(*) FROM agents").fetchone()[0]
        self.assertTrue(self.ok()["deleted"])
        self.assertEqual(self.conn.execute("SELECT count(*) FROM agents").fetchone()[0], before)

    def test_partial_saved_source_returns_usage_unavailable(self):
        self.put_team("core", [dict(id="dev", name="Dev", role="victim")])
        self.put("board.json", b"{broken")
        resp = self.rejected("ROLE_USAGE_UNAVAILABLE")
        u = self.usage(resp)
        self.assertEqual(len(u["members"]), 1)
        self.assertTrue(u["partial"])
        self.assertIn("board", [p["source"] for p in u["problems"]])

    def test_runtime_reader_failure_returns_usage_unavailable(self):
        with mock.patch("agent_studio.state.connect", side_effect=OSError("db gone")):
            resp = self.rejected("ROLE_USAGE_UNAVAILABLE")
        u = self.usage(resp)
        self.assertTrue(u["partial"])
        self.assertIn("runtime", [p["source"] for p in u["problems"]])
        self.assertEqual(resp["data"]["roleId"], "victim")

    # ---- tokens ----
    def test_stale_roles_token_is_atomic(self):
        resp = self.rejected("CONFIG_CHANGED", expectedRolesSha256="1" * 64)
        self.assertEqual(resp["error"]["message"], ".agent-studio/roles.json changed since it was read; reload and retry.")
        self.assertEqual(resp["data"], {"rolesSha256": sha(self.get("roles.json")),
                                        "instructionsSha256": sha(b"victim text")})

    def test_stale_instruction_token_is_atomic(self):
        resp = self.rejected("CONFIG_CHANGED", expectedInstructionsSha256="2" * 64)
        self.assertEqual(resp["error"]["message"],
                         ".agent-studio/roles/victim.md changed since it was read; reload and retry.")
        self.assertEqual(resp["data"]["instructionsSha256"], sha(b"victim text"))

    def test_file_created_after_null_token_is_config_changed(self):
        os.unlink(os.path.join(self.base, "roles", "victim.md"))
        r, _ = self.tokens()
        self.put("roles/victim.md", b"late")
        self.rejected("CONFIG_CHANGED", expectedRolesSha256=r, expectedInstructionsSha256=None)

    def test_file_removed_after_nonnull_token_is_config_changed(self):
        r, i = self.tokens()
        os.unlink(os.path.join(self.base, "roles", "victim.md"))
        resp = self.rejected("CONFIG_CHANGED", expectedRolesSha256=r, expectedInstructionsSha256=i)
        self.assertIsNone(resp["data"]["instructionsSha256"])

    # ---- success shapes ----
    def test_delete_unused_role_and_owned_conventional_instruction(self):
        data = self.ok()
        self.assertEqual(data["instructions"], {"path": ".agent-studio/roles/victim.md", "action": "deleted", "reason": None})
        self.assertEqual((data["deleted"], data["roleId"], data["workspace"]), (True, "victim", self.ws))
        self.assertEqual(json.loads(self.get("roles.json")),
                         {"version": 1, "extra": 1, "roles": {k: v for k, v in DOC["roles"].items() if k != "victim"}})
        self.assertEqual(data["rolesSha256"], sha(self.get("roles.json")))
        self.assertIsNone(self.get("roles/victim.md"))
        self.assertEqual(self.get("skills/s/SKILL.md"), b"skill")
        self.assertEqual([n for n in os.listdir(self.base) if n.startswith(".")], [])

    def test_missing_conventional_instruction_is_reported(self):
        os.unlink(os.path.join(self.base, "roles", "victim.md"))
        self.assertEqual(self.ok()["instructions"],
                         {"path": ".agent-studio/roles/victim.md", "action": "missing", "reason": None})

    def test_pathless_incidental_file_is_preserved(self):
        doc = json.loads(json.dumps(DOC))
        del doc["roles"]["victim"]["instructions"]
        self.write("roles.json", doc)
        data = self.ok(expectedInstructionsSha256=None)
        self.assertEqual(data["instructions"], {"path": None, "action": "none", "reason": None})
        self.assertEqual(self.get("roles/victim.md"), b"victim text")

    def test_custom_instruction_is_preserved(self):
        doc = json.loads(json.dumps(DOC))
        doc["roles"]["victim"]["instructions"] = "custom/v.md"
        self.write("roles.json", doc)
        self.put("custom/v.md", b"custom")
        data = self.ok(rel="custom/v.md")
        self.assertEqual(data["instructions"], {"path": ".agent-studio/custom/v.md", "action": "preserved", "reason": "custom_path"})
        self.assertEqual(self.get("custom/v.md"), b"custom")

    def test_shared_conventional_instruction_is_preserved(self):
        doc = json.loads(json.dumps(DOC))
        doc["roles"]["other"]["instructions"] = "roles/victim.md"
        self.write("roles.json", doc)
        data = self.ok()
        self.assertEqual((data["instructions"]["action"], data["instructions"]["reason"]), ("preserved", "shared_path"))
        self.assertEqual(self.get("roles/victim.md"), b"victim text")

    def test_symlink_escape_is_preserved_without_following(self):
        outside = os.path.join(self.root, "outside.md")
        with open(outside, "wb") as f:
            f.write(b"secret")
        os.unlink(os.path.join(self.base, "roles", "victim.md"))
        os.symlink(outside, os.path.join(self.base, "roles", "victim.md"))
        data = self.ok(expectedInstructionsSha256=None)
        self.assertEqual((data["instructions"]["action"], data["instructions"]["reason"]), ("preserved", "unsafe_path"))
        self.assertTrue(os.path.islink(os.path.join(self.base, "roles", "victim.md")))
        self.assertEqual(open(outside, "rb").read(), b"secret")

    def test_skill_files_and_unrelated_configuration_are_byte_identical(self):
        self.put_team("core", [dict(id="dev", name="Dev", role="other")])
        self.write("team.json", {"version": 1, "agents": [{"providerId": "fake", "role": "other"}]})
        self.put("permissions.json", b'{"p": 1}')
        self.put("workflows/x.json", json.dumps(dict(WORKFLOW, stages=[dict(WORKFLOW["stages"][0], role="other")])).encode())
        keep = {k: v for k, v in self.snapshot().items() if k not in ("roles.json", "roles/victim.md")}
        self.ok()
        after = self.snapshot()
        self.assertEqual({k: v for k, v in after.items() if k in keep}, keep)

    def test_final_role_leaves_empty_valid_catalog(self):
        self.write("roles.json", {"version": 1, "roles": {"victim": DOC["roles"]["victim"]}})
        self.ok()
        self.assertEqual(json.loads(self.get("roles.json")), {"version": 1, "roles": {}})

    def test_roles_write_failure_restores_catalog_and_instruction(self):
        before = self.snapshot()
        with mock.patch.object(roles, "_replace", side_effect=OSError("boom")):
            resp = self.delete()
        self.assertFalse(resp["ok"])
        self.assertEqual(self.snapshot(), before)

    def test_request_validation_and_unknown_role(self):
        for over in ({"roleId": ""}, {"roleId": 5}, {"expectedRolesSha256": ...}, {"expectedRolesSha256": None},
                     {"expectedRolesSha256": "A" * 64}, {"expectedInstructionsSha256": ...},
                     {"expectedInstructionsSha256": "short"}, {"extra": 1}):
            self.rejected("BAD_REQUEST", **over)
        resp = self.rejected("ROLE_NOT_FOUND", role="ghost")
        self.assertEqual(resp["error"]["message"], "Role 'ghost' is not defined in .agent-studio/roles.json.")
