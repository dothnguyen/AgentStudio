"""SQLite connections, roles, and migrations.

Write authority is enforced by SQLite itself: every connection is opened with a role, and non-coordinator
roles get an authorizer that rejects writes outside their inbox table.

  coordinator  all reads and writes, migrations (only the coordinator daemon and tests use it)
  client       read + INSERT INTO commands
  runner       read + INSERT INTO worker_reports
  reader       read-only (mode=ro + query_only)
"""
from __future__ import annotations

import os
import sqlite3
import urllib.parse
from datetime import datetime, timezone

from . import schema
from .protocol import AsError, BACKEND_UNAVAILABLE, UNSUPPORTED_SCHEMA

SCHEMA_VERSION = 12
ROLES = ("coordinator", "client", "runner", "reader")
ROLE_INSERTS = {"client": {"commands"}, "runner": {"worker_reports"}, "reader": set()}

MIGRATIONS = {
    1: [
        """CREATE TABLE commands (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            idempotency_key TEXT NOT NULL UNIQUE,
            command TEXT NOT NULL,
            payload_hash TEXT NOT NULL,
            args_json TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('pending', 'done')),
            response_json TEXT,
            created_at TEXT NOT NULL,
            completed_at TEXT,
            CHECK ((status = 'pending') = (response_json IS NULL))
        )""",
        "CREATE INDEX commands_pending ON commands (status, seq)",
    ],
    2: schema.MIGRATION_2,
    3: schema.MIGRATION_3,
    4: schema.MIGRATION_4,
    5: schema.MIGRATION_5,
    6: schema.MIGRATION_6,
    7: schema.MIGRATION_7,
    8: schema.MIGRATION_8,
    9: schema.MIGRATION_9,
    10: schema.MIGRATION_10,
    11: schema.MIGRATION_11,
    12: schema.MIGRATION_12,
}

_DDL_ACTIONS = {getattr(sqlite3, n) for n in dir(sqlite3)
                if n.startswith(("SQLITE_CREATE_", "SQLITE_DROP_")) or n in ("SQLITE_ALTER_TABLE", "SQLITE_REINDEX",
                                                                           "SQLITE_ATTACH", "SQLITE_DETACH",
                                                                           "SQLITE_ANALYZE")}


class RoleConnection(sqlite3.Connection):
    role = "reader"


def _authorizer(role: str):
    allowed_inserts = ROLE_INSERTS[role]

    def check(action, arg1, arg2, dbname, source):
        if action == sqlite3.SQLITE_INSERT:
            return sqlite3.SQLITE_OK if (arg1 in allowed_inserts or (allowed_inserts and arg1 == "sqlite_sequence")) \
                else sqlite3.SQLITE_DENY
        if action in (sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE):
            # AUTOINCREMENT bookkeeping happens on sqlite_sequence when an allowed insert runs.
            return sqlite3.SQLITE_OK if (allowed_inserts and arg1 == "sqlite_sequence") else sqlite3.SQLITE_DENY
        if action in _DDL_ACTIONS:
            return sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_PRAGMA and arg2 is not None:
            return sqlite3.SQLITE_DENY  # setting pragmas is coordinator-only after connect()
        return sqlite3.SQLITE_OK

    return check


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def db_path(state_dir: str) -> str:
    return os.path.join(state_dir, "state.db")


def connect(path: str, role: str, create: bool = False) -> RoleConnection:
    if role not in ROLES:
        raise ValueError(f"unknown role {role!r}")
    if create and role != "coordinator":
        raise ValueError("only the coordinator creates the database")
    if not create and not os.path.exists(path):
        raise AsError(BACKEND_UNAVAILABLE, "The state database has not been initialized by the coordinator.",
                      retryable=True, remediation="Run: agent-studio coordinator start")
    if role == "reader":
        uri = "file:" + urllib.parse.quote(os.path.abspath(path)) + "?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=5.0, isolation_level=None, factory=RoleConnection)
    else:
        conn = sqlite3.connect(path, timeout=5.0, isolation_level=None, factory=RoleConnection)
    conn.role = role
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    if role == "reader":
        conn.execute("PRAGMA query_only = 1")
    if role != "coordinator":
        conn.set_authorizer(_authorizer(role))
    return conn


def current_version(conn) -> int:
    row = conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()
    return int(row[0] or 0)


def migrate(conn: RoleConnection, path: str) -> int:
    if conn.role != "coordinator":
        raise ValueError("only the coordinator migrates")
    conn.execute("PRAGMA journal_mode = WAL")
    # Table rebuilds (v6) need foreign keys off; the pragma is a no-op inside a transaction, so it is switched here.
    # Migration steps that rebuild tables run PRAGMA foreign_key_check themselves before the commit.
    conn.execute("PRAGMA foreign_keys = OFF")
    try:
        _migrate_locked(conn)
    finally:
        conn.execute("PRAGMA foreign_keys = ON")
    for suffix in ("", "-wal", "-shm"):
        p = path + suffix
        if os.path.exists(p):
            os.chmod(p, 0o600)
    return SCHEMA_VERSION


def _migrate_locked(conn) -> None:
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)")
        version = current_version(conn)
        if version > SCHEMA_VERSION:
            raise AsError(UNSUPPORTED_SCHEMA, f"Database schema version {version} is newer than this backend supports "
                                              f"({SCHEMA_VERSION}).", remediation="Upgrade Agent Studio.")
        for v in range(version + 1, SCHEMA_VERSION + 1):
            for step in MIGRATIONS[v]:
                if callable(step):
                    step(conn)
                else:
                    conn.execute(step)
            conn.execute("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", (v, utcnow()))
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise


def check_schema(conn) -> None:
    try:
        version = current_version(conn)
    except sqlite3.OperationalError:
        version = 0
    if version == 0:
        raise AsError(BACKEND_UNAVAILABLE, "The state database has not been initialized by the coordinator.",
                      retryable=True, remediation="Run: agent-studio coordinator start")
    if version > SCHEMA_VERSION:
        raise AsError(UNSUPPORTED_SCHEMA, f"Database schema version {version} is newer than this client supports.",
                      remediation="Upgrade Agent Studio.")
    if version < SCHEMA_VERSION:
        raise AsError(BACKEND_UNAVAILABLE, "The running coordinator uses an older schema.", retryable=True,
                      remediation="Restart it: agent-studio coordinator stop && agent-studio coordinator start")


def db_id(conn) -> str:
    row = conn.execute("SELECT value FROM meta WHERE key = 'db_id'").fetchone()
    return row[0]
