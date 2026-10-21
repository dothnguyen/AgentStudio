import os
import sqlite3
import tempfile
import unittest

from tests import helpers  # noqa: F401
from agent_studio import inbox, paths, procid, state
from agent_studio.protocol import AsError


class StateTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "state.db")

    def test_migrate_empty_and_repeat(self):
        conn = state.connect(self.path, role="coordinator", create=True)
        self.assertEqual(state.migrate(conn, self.path), state.SCHEMA_VERSION)
        self.assertEqual(state.migrate(conn, self.path), state.SCHEMA_VERSION)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()[0], state.SCHEMA_VERSION)
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o600)
        state.check_schema(conn)

    def test_future_schema_rejected(self):
        conn = state.connect(self.path, role="coordinator", create=True)
        state.migrate(conn, self.path)
        conn.execute("INSERT INTO schema_migrations VALUES (99, 'x')")
        with self.assertRaises(AsError) as cm:
            state.migrate(conn, self.path)
        self.assertEqual(cm.exception.code, "UNSUPPORTED_SCHEMA")
        with self.assertRaises(AsError) as cm:
            state.check_schema(conn)
        self.assertEqual(cm.exception.code, "UNSUPPORTED_SCHEMA")

    def test_client_cannot_use_uninitialized_db(self):
        with self.assertRaises(AsError) as cm:
            state.connect(self.path, role="client")
        self.assertEqual(cm.exception.code, "BACKEND_UNAVAILABLE")

    def test_idempotent_insert_and_conflict(self):
        conn = state.connect(self.path, role="coordinator", create=True)
        state.migrate(conn, self.path)
        a = inbox.insert_or_get(conn, "key-00000001", "debug.echo", {"text": "x"})
        b = inbox.insert_or_get(conn, "key-00000001", "debug.echo", {"text": "x"})
        self.assertEqual(a, b)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM commands").fetchone()[0], 1)
        with self.assertRaises(AsError) as cm:
            inbox.insert_or_get(conn, "key-00000001", "debug.echo", {"text": "y"})
        self.assertEqual(cm.exception.code, "IDEMPOTENCY_CONFLICT")

    def test_pending_rows_cannot_have_responses(self):
        conn = state.connect(self.path, role="coordinator", create=True)
        state.migrate(conn, self.path)
        with self.assertRaises(sqlite3.IntegrityError):
            conn.execute("INSERT INTO commands (idempotency_key, command, payload_hash, args_json, status, "
                         "response_json, created_at) VALUES ('k1234567', 'c', 'h', '{}', 'pending', '{}', 'now')")

    def test_complete_is_single_shot(self):
        conn = state.connect(self.path, role="coordinator", create=True)
        state.migrate(conn, self.path)
        seq = inbox.insert_or_get(conn, "key-00000002", "debug.echo", {"text": "x"})
        inbox.complete(conn, seq, {"ok": True, "data": 1})
        inbox.complete(conn, seq, {"ok": True, "data": 2})
        self.assertEqual(inbox.wait_response(conn, seq, 0), {"ok": True, "data": 1})


class IdentityTests(unittest.TestCase):
    def test_own_identity_matches(self):
        ident = procid.identity(os.getpid())
        self.assertTrue(procid.matches(ident))

    def test_pid_reuse_is_not_identity(self):
        ident = procid.identity(os.getpid())
        ident["startTime"] += 1
        self.assertFalse(procid.matches(ident))
        self.assertFalse(procid.matches({"pid": os.getpid(), "startTime": None, "bootId": procid.boot_id()}))
        self.assertFalse(procid.matches(dict(procid.identity(os.getpid()), bootId="other-boot")))


class PathTests(unittest.TestCase):
    def test_mnt_state_dir_rejected(self):
        old = os.environ.get("XDG_STATE_HOME")
        os.environ["XDG_STATE_HOME"] = "/mnt/c/Users/someone/state"
        try:
            with self.assertRaises(AsError) as cm:
                paths.ensure_state_dir()
            self.assertEqual(cm.exception.code, "STATE_DIR_UNUSABLE")
        finally:
            if old is None:
                os.environ.pop("XDG_STATE_HOME")
            else:
                os.environ["XDG_STATE_HOME"] = old

    def test_relative_xdg_ignored(self):
        old = os.environ.get("XDG_STATE_HOME")
        os.environ["XDG_STATE_HOME"] = "relative/path"
        try:
            self.assertTrue(paths.raw_state_dir().startswith(os.path.expanduser("~")))
        finally:
            if old is None:
                os.environ.pop("XDG_STATE_HOME")
            else:
                os.environ["XDG_STATE_HOME"] = old


if __name__ == "__main__":
    unittest.main()
