import contextlib
import io
import json
import os
import shutil
import tempfile
import unittest

from tests import helpers  # noqa: F401  (puts backend on sys.path)
from agent_studio import cli, dispatch, teamdefs, workspace
from agent_studio.protocol import AsError

ROLES = {"version": 1, "roles": {"developer": {}, "reviewer": {}}}
LEGACY = {"version": 1, "agents": [{"providerId": "codex", "role": "developer", "name": "Dev One", "extra": 1},
                                   {"providerId": "claude", "role": "reviewer", "model": "opus"}]}


class Base(unittest.TestCase):
    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="as-td-"))
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

    def roles(self):
        self.write("roles.json", ROLES)

    def team_file(self, tid="t"):
        return os.path.join(self.cfg, "teams", f"{tid}.json")

    def put_team(self, team, tid="t"):
        os.makedirs(os.path.join(self.cfg, "teams"), exist_ok=True)
        with open(self.team_file(tid), "w", encoding="utf-8") as f:
            f.write(json.dumps(team, indent=2, ensure_ascii=False) + "\n")

    def cli(self, *argv):
        raw = io.BytesIO()
        out, err = io.TextIOWrapper(raw, encoding="utf-8", write_through=True), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = cli.main(list(argv) + ["--workspace", self.ws])
        out.flush()
        return rc, raw.getvalue().decode("utf-8"), err.getvalue()

    def code(self, fn, *a, **k):
        with self.assertRaises(AsError) as c:
            fn(*a, **k)
        return c.exception.code


class PreserveTests(Base):
    def test_hand_edits_and_formatting_survive_commands(self):
        self.roles()
        fixture = {"zeta": {"k": 1}, "name": "Tëam", "id": "t",
                   "members": [{"role": "developer", "id": "a", "name": "Ä", "provider": "codex", "x": [1]}],
                   "note": "ünï"}
        self.put_team(fixture)
        with open(self.team_file(), "rb") as f:
            before = f.read()
        teamdefs.save(self.ws, teamdefs.load(self.ws, "t"))
        with open(self.team_file(), "rb") as f:
            self.assertEqual(f.read(), before)
        teamdefs.add_member(self.ws, "t", "Bob", "reviewer", "claude")
        data = teamdefs.load(self.ws, "t")
        self.assertEqual(list(data), ["zeta", "name", "id", "members", "note"])
        self.assertEqual(data["members"][0]["x"], [1])
        self.assertEqual(data["members"][1]["id"], "bob")
        # hand edit between two commands is kept
        data["extra"] = "hand"
        self.put_team(data)
        teamdefs.remove_member(self.ws, "t", "bob")
        again = teamdefs.load(self.ws, "t")
        self.assertEqual(again["extra"], "hand")
        self.assertEqual(len(again["members"]), 1)

    def test_add_then_add_member_keeps_format(self):
        teamdefs.add_team(self.ws, "My Team")
        teamdefs.add_member(self.ws, None, "A", "developer", "codex", model="m", reasoning="high")
        with open(self.team_file("my-team"), encoding="utf-8") as f:
            text = f.read()
        self.assertTrue(text.endswith("}\n"))
        self.assertEqual(text, json.dumps(json.loads(text), indent=2, ensure_ascii=False) + "\n")


class CommandRuleTests(Base):
    def test_add_rules(self):
        self.assertEqual(teamdefs.add_team(self.ws, "Core Team")["team"]["id"], "core-team")
        self.assertEqual(self.code(teamdefs.add_team, self.ws, "x", "core-team"), "TEAM_EXISTS")
        self.assertEqual(self.code(teamdefs.add_team, self.ws, "x", "Bad_Id"), "BAD_REQUEST")
        self.assertEqual(self.code(teamdefs.add_team, self.ws, "!!!"), "BAD_REQUEST")

    def test_member_rules(self):
        teamdefs.add_team(self.ws, "t")
        teamdefs.add_member(self.ws, None, "Dev One", "developer", "codex")
        self.assertEqual(self.code(teamdefs.add_member, self.ws, None, "dev one", "developer", "codex"),
                         "MEMBER_EXISTS")
        self.assertEqual(self.code(teamdefs.remove_member, self.ws, None, "nobody"), "MEMBER_NOT_FOUND")
        self.assertEqual(teamdefs.remove_member(self.ws, None, "DEV ONE")["removed"]["id"], "dev-one")
        teamdefs.add_member(self.ws, None, "Dev One", "developer", "codex")
        teamdefs.remove_member(self.ws, None, "dev-one")

    def test_team_selection(self):
        self.assertEqual(self.code(teamdefs.show, self.ws, None), "TEAM_NOT_FOUND")
        teamdefs.add_team(self.ws, "one")
        self.assertEqual(teamdefs.show(self.ws, None)["team"]["id"], "one")
        teamdefs.add_team(self.ws, "two")
        self.assertEqual(self.code(teamdefs.show, self.ws, None), "TEAM_AMBIGUOUS")
        self.assertEqual(self.code(teamdefs.show, self.ws, "three"), "TEAM_NOT_FOUND")
        self.assertEqual(teamdefs.show(self.ws, "two")["team"]["id"], "two")

    def test_add_member_warns_but_writes(self):
        self.roles()
        teamdefs.add_team(self.ws, "t")
        res = teamdefs.add_member(self.ws, None, "A", "nope", "bogus")
        paths = {w["path"] for w in res["warnings"]}
        self.assertEqual(paths, {"members[0].role", "members[0].provider"})
        self.assertEqual(len(teamdefs.load(self.ws, "t")["members"]), 1)
        rc, out, _ = self.cli("team", "add-member", "--name", "B", "--role", "nope", "--provider", "codex")
        self.assertEqual(rc, 0)
        self.assertIn("warning: members[1].role:", out)

    def test_invalid_file_not_rewritten(self):
        os.makedirs(os.path.join(self.cfg, "teams"))
        with open(self.team_file(), "w") as f:
            f.write("{nope")
        self.assertEqual(self.code(teamdefs.add_member, self.ws, "t", "A", "r", "codex"), "TEAM_CONFIG_INVALID")
        with open(self.team_file()) as f:
            self.assertEqual(f.read(), "{nope")


class ValidateTests(Base):
    def problems(self, team, fid="t"):
        return {(p["path"]) for p in teamdefs.validate(self.ws, team, fid)}

    def test_valid_and_fake(self):
        self.roles()
        team = {"id": "t", "name": "T", "members": [
            {"id": "a", "name": "A", "role": "developer", "provider": "codex", "model": "gpt-5", "reasoning": "high"},
            {"id": "f", "name": "F", "role": "reviewer", "provider": "fake"}]}
        self.assertEqual(teamdefs.validate(self.ws, team, "t"), [])

    def test_all_problems_with_paths(self):
        self.roles()
        members = [{"id": "a", "name": "A", "role": "developer", "provider": "agy", "model": "x"},
                   {"id": "a", "name": "A", "role": "ghost", "provider": "nope"},
                   {"id": "c", "name": "C", "role": "developer", "provider": "codex", "reasoning": "extreme"},
                   {"id": "d", "name": "D", "role": "", "provider": "codex", "model": "bad model!"},
                   "str"] + [{"id": f"m{i}", "name": "n", "role": "developer", "provider": "codex"} for i in range(5)]
        got = self.problems({"id": "other", "name": "", "members": members})
        self.assertEqual(got, {"id", "name", "members", "members[0].model", "members[1].id", "members[1].role",
                               "members[1].provider", "members[2].reasoning", "members[3].role",
                               "members[3].model", "members[4]"})

    def test_shape_and_no_roles_file(self):
        self.assertEqual(self.problems({"id": "t", "name": "T", "members": "x"}), {"members"})
        got = self.problems({"id": "t", "name": "T", "members": [{"id": "a", "name": "A", "provider": "codex"}]})
        self.assertEqual(got, {"members[0].role"})
        got = self.problems({"id": "t", "name": "T", "members": [{"id": "a", "name": "A", "role": "r",
                                                                  "provider": "codex", "model": 3}]})
        self.assertIn("members[0].model", got)

    def test_model_rejected_for_known_provider_without_model_selection(self):
        from backend.agent_studio import providers
        self.assertFalse(providers.get("agy").model_selectable())  # opencode is implemented (P00-S11)
        self.roles()
        got = self.problems({"id": "t", "name": "T", "members": [
            {"id": "a", "name": "A", "role": "developer", "provider": "agy", "model": "gpt-5"}]})
        self.assertEqual(got, {"members[0].model"})

    def test_validate_team_error_lists_problems(self):
        self.put_team({"id": "t", "name": "T", "members": [{"id": "a", "name": "A", "role": "r", "provider": "x"}]})
        with self.assertRaises(AsError) as c:
            teamdefs.validate_team(self.ws, None)
        self.assertEqual(c.exception.code, "TEAM_CONFIG_INVALID")
        self.assertEqual(len(c.exception.data["problems"]), 2)
        self.assertIn("members[0].role:", c.exception.message)


class LegacyTests(Base):
    """P04-S06 removed the CLI-side team.json fallback: only `team import-legacy` reads team.json now."""

    def setUp(self):
        super().setUp()
        self.roles()
        self.write("team.json", LEGACY)
        with open(os.path.join(self.cfg, "team.json"), "rb") as f:
            self.legacy_bytes = f.read()

    def same(self):
        with open(os.path.join(self.cfg, "team.json"), "rb") as f:
            self.assertEqual(f.read(), self.legacy_bytes)

    def test_no_default_team_anywhere_and_team_json_untouched(self):
        self.assertEqual(teamdefs.list_teams(self.ws)["teams"], [])
        self.assertEqual(self.code(teamdefs.show, self.ws, None), "TEAM_NOT_FOUND")
        self.assertEqual(self.code(teamdefs.validate_team, self.ws, None), "TEAM_NOT_FOUND")
        self.assertEqual(self.code(teamdefs.add_member, self.ws, None, "A", "developer", "codex"), "TEAM_NOT_FOUND")
        self.assertEqual(self.code(teamdefs.remove_member, self.ws, None, "dev-one"), "TEAM_NOT_FOUND")
        self.same()

    def test_team_start_without_teams_is_team_not_found_naming_import_legacy(self):
        rc, out, err = self.cli("team", "start")
        self.assertEqual(rc, 1)
        resp = json.loads(out)
        self.assertEqual(resp["error"]["code"], "TEAM_NOT_FOUND")
        self.assertIn("team import-legacy", resp["error"]["remediation"])
        self.same()

    def test_team_start_named_default_is_also_refused(self):
        rc, out, _ = self.cli("team", "start", "--team", "default")
        self.assertEqual(rc, 1)
        self.assertEqual(json.loads(out)["error"]["code"], "TEAM_NOT_FOUND")
        self.same()

    def test_team_list_shows_no_default_team(self):
        rc, out, _ = self.cli("team", "list", "--json")
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(out)["data"]["teams"], [])
        rc, out, _ = self.cli("team", "list")
        self.assertEqual(out.strip(), "no teams defined")

    def test_import_legacy_still_converts(self):
        res = teamdefs.import_legacy(self.ws)
        self.assertEqual(res["warnings"], [])
        self.assertEqual(teamdefs.validate_team(self.ws, "default")["problems"], [])
        self.assertEqual(self.code(teamdefs.import_legacy, self.ws), "TEAM_EXISTS")
        self.assertFalse(teamdefs.show(self.ws, None)["legacy"])
        self.same()

    def test_import_without_team_json(self):
        os.remove(os.path.join(self.cfg, "team.json"))
        self.assertEqual(self.code(teamdefs.import_legacy, self.ws), "TEAM_NOT_FOUND")

    def test_import_legacy_cli_human_and_json(self):
        rc, out, _ = self.cli("team", "import-legacy", "--id", "core", "--name", "Core")
        self.assertEqual(rc, 0)
        self.assertEqual(out.splitlines()[0], "imported team.json as team core (2 member(s))")
        os.remove(self.team_file("core"))
        rc, out, _ = self.cli("team", "import-legacy", "--json")
        resp = json.loads(out)
        self.assertEqual(rc, 0)
        self.assertTrue(resp["ok"])
        self.assertEqual(resp["data"]["team"]["id"], "default")
        self.assertEqual(len(resp["data"]["team"]["members"]), 2)
        self.assertEqual(resp["data"]["warnings"], [])

    def test_import_legacy_cli_error(self):
        os.remove(os.path.join(self.cfg, "team.json"))
        rc, out, err = self.cli("team", "import-legacy", "--json")
        self.assertEqual(rc, 1)
        self.assertEqual(json.loads(out)["error"]["code"], "TEAM_NOT_FOUND")

    def test_team_add_ignores_team_json(self):
        teamdefs.add_team(self.ws, "new")
        self.assertEqual([t["id"] for t in teamdefs.list_teams(self.ws)["teams"]], ["new"])
        self.same()


class CliTests(Base):
    def test_human_and_json_output(self):
        self.roles()
        rc, out, _ = self.cli("team", "list")
        self.assertEqual((rc, out.strip()), (0, "no teams defined"))
        rc, out, _ = self.cli("team", "add", "--name", "Core")
        self.assertEqual(rc, 0)
        self.assertIn("core", out)
        rc, out, _ = self.cli("team", "add-member", "--name", "A", "--role", "developer", "--provider", "codex",
                              "--model", "m")
        self.assertEqual(rc, 0)
        rc, out, _ = self.cli("team", "show")
        self.assertIn("a  A  developer  codex  model=m", out)
        rc, out, _ = self.cli("team", "validate")
        self.assertEqual(out.strip(), "team core: valid")
        rc, out, _ = self.cli("team", "list", "--json")
        resp = json.loads(out)
        self.assertTrue(resp["ok"])
        self.assertEqual(resp["data"]["teams"], [{"id": "core", "name": "Core", "members": 1, "legacy": False}])
        rc, out, _ = self.cli("team", "remove-member", "--member", "a")
        self.assertEqual(rc, 0)

    def test_errors(self):
        rc, out, err = self.cli("team", "show")
        self.assertEqual((rc, out), (1, ""))
        self.assertTrue(err.startswith("TEAM_NOT_FOUND:"))
        self.assertIn("agent-studio team add", err)
        self.cli("team", "add", "--name", "x")
        self.put_team({"id": "x", "name": "x", "members": [{"id": "a", "name": "a", "role": "r", "provider": "q"}]},
                      "x")
        rc, out, err = self.cli("team", "validate", "--json")
        self.assertEqual(rc, 1)
        resp = json.loads(out)
        self.assertEqual(resp["error"]["code"], "TEAM_CONFIG_INVALID")
        self.assertTrue(resp["error"]["data"]["problems"])
        rc, _, err = self.cli("team", "validate")
        self.assertEqual(rc, 1)
        self.assertIn("members[0].provider", err)

    def test_not_dispatch_commands(self):
        for a in teamdefs_actions():
            self.assertNotIn(f"team.{a}", dispatch.COMMANDS)
        usage = cli.USAGE.replace("team list|show|validate", "team list team show team validate")
        for a in teamdefs_actions():
            self.assertIn(f"team {a}", usage)


def teamdefs_actions():
    return ["add", "add-member", "remove-member", "list", "show", "validate", "import-legacy"]


if __name__ == "__main__":
    unittest.main()
