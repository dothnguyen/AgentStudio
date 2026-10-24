import contextlib
import io
import json
import os
import shutil
import tempfile
import unittest

from tests import helpers  # noqa: F401  (puts backend on sys.path)
from agent_studio import cli, dispatch, workspace
from agent_studio.protocol import AsError, BAD_REQUEST, WORKSPACE_NOT_FOUND


class Base(unittest.TestCase):
    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="as-ws-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self._old = os.environ.get("XDG_STATE_HOME")
        os.environ["XDG_STATE_HOME"] = os.path.join(self.root, "state")
        self.addCleanup(self._restore)
        self.ws = os.path.join(self.root, "proj")
        os.makedirs(self.ws)
        self.registry = os.path.join(self.root, "state", "agent-studio", "workspaces.json")

    def _restore(self):
        if self._old is None:
            os.environ.pop("XDG_STATE_HOME", None)
        else:
            os.environ["XDG_STATE_HOME"] = self._old

    def reg(self):
        with open(self.registry) as f:
            return json.load(f)

    def cli(self, *argv):
        raw = io.BytesIO()
        out, err = io.TextIOWrapper(raw, encoding="utf-8", write_through=True), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = cli.main(list(argv))
        out.flush()
        return rc, raw.getvalue().decode("utf-8"), err.getvalue()


class InitTests(Base):
    def test_init_writes_marker_and_registers(self):
        ws = workspace.init(self.ws)
        with open(os.path.join(self.ws, ".agent-studio", "workspace.json")) as f:
            data = json.load(f)
        self.assertEqual(data["name"], "proj")
        self.assertEqual(data["id"], ws["id"])
        self.assertEqual(len(self.reg()["workspaces"]), 1)

    def test_second_init_changes_nothing(self):
        workspace.init(self.ws)
        marker = os.path.join(self.ws, ".agent-studio", "workspace.json")
        before, reg = open(marker, "rb").read(), open(self.registry, "rb").read()
        again = workspace.init(self.ws, name="other")
        self.assertTrue(again["existed"])
        self.assertEqual(open(marker, "rb").read(), before)
        self.assertEqual(open(self.registry, "rb").read(), reg)

    def test_init_keeps_other_files_in_marker_dir(self):
        os.makedirs(os.path.join(self.ws, ".agent-studio"))
        keep = os.path.join(self.ws, ".agent-studio", "team.json")
        open(keep, "w").write("{}")
        workspace.init(self.ws)
        self.assertEqual(open(keep).read(), "{}")

    def test_init_missing_path_is_bad_request(self):
        with self.assertRaises(AsError) as cm:
            workspace.init(os.path.join(self.root, "nope"))
        self.assertEqual(cm.exception.code, BAD_REQUEST)

    def test_init_path_option_and_name(self):
        rc, out, _ = self.cli("init", "--path", self.ws, "--name", "Named")
        self.assertEqual(rc, 0)
        self.assertIn("Named", out)
        self.assertEqual(workspace.resolve(self.ws)["name"], "Named")


class ResolveTests(Base):
    def test_resolve_from_nested_folder(self):
        ws = workspace.init(self.ws)
        sub = os.path.join(self.ws, "a", "b")
        os.makedirs(sub)
        self.assertEqual(workspace.resolve(sub)["id"], ws["id"])

    def test_resolve_skips_marker_dir_without_workspace_json(self):
        ws = workspace.init(self.ws)
        sub = os.path.join(self.ws, "sub")
        os.makedirs(os.path.join(sub, ".agent-studio"))
        self.assertEqual(workspace.resolve(sub)["id"], ws["id"])

    def test_resolve_innermost(self):
        workspace.init(self.ws)
        inner = os.path.join(self.ws, "inner")
        os.makedirs(inner)
        i = workspace.init(inner)
        self.assertEqual(workspace.resolve(inner)["id"], i["id"])

    def test_override_wins_and_does_not_walk_up(self):
        a = workspace.init(self.ws)
        other = os.path.join(self.root, "other")
        os.makedirs(other)
        b = workspace.init(other)
        self.assertEqual(workspace.resolve(self.ws, override=other)["id"], b["id"])
        sub = os.path.join(self.ws, "sub")
        os.makedirs(sub)
        with self.assertRaises(AsError) as cm:
            workspace.resolve(self.ws, override=sub)
        self.assertEqual(cm.exception.code, WORKSPACE_NOT_FOUND)
        self.assertEqual(cm.exception.remediation, "run agent-studio init")
        self.assertNotEqual(a["id"], b["id"])

    def test_not_found(self):
        with self.assertRaises(AsError) as cm:
            workspace.resolve(self.ws)
        self.assertEqual(cm.exception.code, WORKSPACE_NOT_FOUND)
        self.assertEqual(cm.exception.remediation, "run agent-studio init")

    def test_bad_marker_is_bad_request(self):
        os.makedirs(os.path.join(self.ws, ".agent-studio"))
        open(os.path.join(self.ws, ".agent-studio", "workspace.json"), "w").write('{"id": 1}')
        with self.assertRaises(AsError) as cm:
            workspace.resolve(self.ws)
        self.assertEqual(cm.exception.code, BAD_REQUEST)
        self.assertIn("workspace.json", cm.exception.message)


class ListAndCliTests(Base):
    def test_list_flags_missing_without_rewriting(self):
        workspace.init(self.ws)
        shutil.rmtree(self.ws)
        before = open(self.registry, "rb").read()
        items = workspace.list_workspaces()["workspaces"]
        self.assertEqual(len(items), 1)
        self.assertTrue(items[0]["missing"])
        self.assertEqual(open(self.registry, "rb").read(), before)

    def test_list_empty_human(self):
        rc, out, _ = self.cli("workspace", "list")
        self.assertEqual((rc, out.strip()), (0, "no workspaces registered"))

    def test_json_envelopes(self):
        rc, out, _ = self.cli("init", "--path", self.ws, "--json")
        self.assertEqual(rc, 0)
        self.assertTrue(json.loads(out)["ok"])
        rc, out, _ = self.cli("workspace", "list", "--json")
        self.assertEqual(json.loads(out)["data"]["workspaces"][0]["path"], self.ws)
        rc, out, _ = self.cli("init", "--path", os.path.join(self.root, "nope"), "--json")
        resp = json.loads(out)
        self.assertEqual((rc, resp["ok"], resp["error"]["code"]), (1, False, BAD_REQUEST))

    def test_human_output_and_error(self):
        self.cli("init", "--path", self.ws)
        rc, out, _ = self.cli("workspace", "list")
        self.assertEqual(rc, 0)
        self.assertIn("proj", out)
        self.assertIn(self.ws, out)
        shutil.rmtree(self.ws)
        self.assertIn("(missing)", self.cli("workspace", "list")[1])
        rc, out, err = self.cli("init", "--path", self.ws)
        self.assertEqual((rc, out), (1, ""))
        self.assertTrue(err.startswith("BAD_REQUEST: "))

    def test_error_prints_remediation(self):
        rc, out, err = io.StringIO(), io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cli.emit({"ok": False, "error": {"code": "X", "message": "m", "remediation": "do it"}},
                            str, False)
        self.assertEqual((code, err.getvalue()), (1, "X: m\ndo it\n"))

    def test_not_dispatch_commands(self):
        for key in dispatch.COMMANDS:
            self.assertFalse(key == "init" or key.startswith("workspace"), key)


if __name__ == "__main__":
    unittest.main()
