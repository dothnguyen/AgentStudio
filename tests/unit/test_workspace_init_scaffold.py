import json
import os
import shutil
import sqlite3
import tempfile
import concurrent.futures
import unittest
from unittest import mock

from tests import helpers  # noqa: F401  (puts backend on sys.path)
from agent_studio import (agentcatalog, boardmodel, boardsettings, delegation, roles, state, validation,
                          workspace, workspaceinit)
from agent_studio.protocol import AsError, BAD_REQUEST

REQUIRED_FILES = (
    "workspace.json", "board.json", "roles.json", "agents.json", "workflow.json", "commands.json",
    "permissions.json",
)
REQUIRED_DIRS = ("roles", "skills", "teams", "workflows", os.path.join("workflows", "prompts"))


class WorkspaceScaffoldTests(unittest.TestCase):
    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="as-scaffold-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self._old = os.environ.get("XDG_STATE_HOME")
        os.environ["XDG_STATE_HOME"] = os.path.join(self.root, "state")
        self.addCleanup(self._restore)
        self.ws = os.path.join(self.root, "proj")
        os.makedirs(self.ws)
        self.cfg = os.path.join(self.ws, ".agent-studio")

    def _restore(self):
        if self._old is None:
            os.environ.pop("XDG_STATE_HOME", None)
        else:
            os.environ["XDG_STATE_HOME"] = self._old

    def read(self, name):
        with open(os.path.join(self.cfg, name), "rb") as f:
            return f.read()

    def assert_complete(self):
        for name in REQUIRED_FILES:
            path = os.path.join(self.cfg, name)
            self.assertTrue(os.path.isfile(path), path)
            with open(path, encoding="utf-8") as f:
                self.assertIsInstance(json.load(f), dict, path)
        for name in REQUIRED_DIRS:
            self.assertTrue(os.path.isdir(os.path.join(self.cfg, name)), name)

    def test_init_writes_the_complete_structure_and_board_loads(self):
        result = workspace.init(self.ws)
        self.assertFalse(result["existed"])
        self.assert_complete()

        board = boardmodel.load_config(self.ws)
        self.assertEqual(board["version"], boardmodel.CONFIG_VERSION)
        self.assertEqual(board["version"], 4)
        self.assertIn("none", {s["id"] for s in board["statuses"]})
        self.assertEqual({s["kind"] for s in board["statuses"]}, {None, "initial", "done", "closed"})

        # Every feature loader accepts the scaffold and no configuration problem is reported.
        self.assertEqual(roles.load_config(self.ws), roles.default_config())
        self.assertEqual(agentcatalog.load(self.ws), agentcatalog.default_catalog())
        self.assertEqual(validation.load_config(self.ws)["validation"]["argv"], ["python3", "-m", "unittest"])
        self.assertEqual(delegation.load_config(self.ws)["commands"], {})
        settings = boardsettings.settings(None, self.ws, False, None)
        self.assertEqual(settings["board"]["state"], "ok")
        self.assertEqual(settings["board"]["problems"], [])

    def test_second_init_keeps_every_existing_file_byte_for_byte(self):
        workspace.init(self.ws)
        for name in ("board.json", "roles.json", "agents.json"):
            with open(os.path.join(self.cfg, name), "wb") as f:
                f.write(("user-owned " + name).encode("utf-8"))
        before = {name: self.read(name) for name in REQUIRED_FILES}

        again = workspace.init(self.ws, name="other")

        self.assertTrue(again["existed"])
        self.assertEqual({name: self.read(name) for name in REQUIRED_FILES}, before)
        self.assertEqual(again["id"], json.loads(self.read("workspace.json"))["id"])

    def test_init_resumes_after_partial_initialization(self):
        first = workspace.init(self.ws)
        marker_before = self.read("workspace.json")
        keep = os.path.join(self.cfg, "roles", "developer.md")
        with open(keep, "w", encoding="utf-8") as f:
            f.write("my instructions\n")
        os.unlink(os.path.join(self.cfg, "board.json"))
        os.unlink(os.path.join(self.cfg, "agents.json"))
        shutil.rmtree(os.path.join(self.cfg, "workflows"))

        second = workspace.init(self.ws)

        self.assertTrue(second["existed"])
        self.assertEqual(second["id"], first["id"])
        self.assertEqual(self.read("workspace.json"), marker_before)
        self.assert_complete()
        with open(keep, encoding="utf-8") as f:
            self.assertEqual(f.read(), "my instructions\n")
        boardmodel.load_config(self.ws)

    def test_failed_initialization_is_clear_and_retry_finishes_the_scaffold(self):
        os.makedirs(self.cfg)
        blocked = os.path.join(self.cfg, "roles")
        with open(blocked, "w", encoding="utf-8") as f:
            f.write("not a directory\n")

        with self.assertRaises(AsError) as cm:
            workspace.init(self.ws)
        self.assertEqual(cm.exception.code, BAD_REQUEST)
        self.assertIn(blocked, cm.exception.message)
        self.assertIn("not a directory", cm.exception.message)
        registry = os.path.join(self.root, "state", "agent-studio", "workspaces.json")
        self.assertFalse(os.path.exists(registry))

        os.unlink(blocked)
        result = workspace.init(self.ws)

        self.assertTrue(result["existed"])  # the marker from the failed attempt is reused
        self.assert_complete()
        boardmodel.load_config(self.ws)

    def test_a_failure_partway_through_file_creation_is_completed_by_retry(self):
        real_create = workspaceinit._create_file
        calls = {"count": 0}

        def flaky(path, data):
            calls["count"] += 1
            if calls["count"] == 3:
                raise OSError("simulated disk full")
            return real_create(path, data)

        with mock.patch.object(workspaceinit, "_create_file", flaky):
            with self.assertRaises(AsError) as cm:
                workspace.init(self.ws)
        self.assertEqual(cm.exception.code, BAD_REQUEST)
        self.assertIn("simulated disk full", cm.exception.message)
        self.assertTrue(os.path.isfile(os.path.join(self.cfg, "workspace.json")))

        workspace.init(self.ws)

        self.assert_complete()
        boardmodel.load_config(self.ws)

    def test_runtime_initialization_failure_does_not_register_workspace_and_can_retry(self):
        failure = AsError(BAD_REQUEST, "simulated runtime database failure")
        with mock.patch.object(workspaceinit, "ensure_runtime", side_effect=failure):
            with self.assertRaises(AsError) as cm:
                workspace.init(self.ws)
        self.assertIn("simulated runtime database failure", cm.exception.message)
        registry = os.path.join(self.root, "state", "agent-studio", "workspaces.json")
        self.assertFalse(os.path.exists(registry))

        result = workspace.init(self.ws)

        self.assertTrue(result["existed"])
        self.assertTrue(os.path.isfile(registry))
        conn = state.connect(os.path.join(self.root, "state", "agent-studio", "state.db"), role="reader")
        try:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM phases WHERE workspace = ? AND slug = 'default'",
                                          (self.ws,)).fetchone()[0], 1)
        finally:
            conn.close()

    def test_runtime_initialization_retries_sqlite_lock_contention(self):
        real_connect = state.connect
        calls = {"count": 0}

        def locked_once(*args, **kwargs):
            calls["count"] += 1
            if calls["count"] == 1:
                raise sqlite3.OperationalError("database is locked")
            return real_connect(*args, **kwargs)

        with mock.patch.object(state, "connect", side_effect=locked_once), \
             mock.patch.object(workspaceinit.time, "sleep") as sleep:
            workspaceinit.ensure_runtime(self.ws)

        self.assertEqual(calls["count"], 2)
        sleep.assert_called_once_with(0.1)
        conn = real_connect(os.path.join(self.root, "state", "agent-studio", "state.db"), role="reader")
        try:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM phases WHERE workspace = ? AND slug = 'default'",
                                          (self.ws,)).fetchone()[0], 1)
        finally:
            conn.close()

    def test_concurrent_initialization_creates_one_default_phase(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: workspace.init(self.ws), range(8)))
        self.assertEqual(len(results), 8)
        conn = state.connect(os.path.join(self.root, "state", "agent-studio", "state.db"), role="reader")
        try:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM phases WHERE workspace = ? AND slug = 'default'",
                                          (self.ws,)).fetchone()[0], 1)
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
