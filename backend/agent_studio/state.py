"""SQLite connection and migrations. Only the coordinator runs migrate(); clients call check_schema()."""
from __future__ import annotations

import os
import sqlite3
from datetime import datetime, timezone

from .protocol import AsError, BACKEND_UNAVAILABLE, UNSUPPORTED_SCHEMA

SCHEMA_VERSION = 1

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
}


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def db_path(state_dir: str) -> str:
    return os.path.join(state_dir, "state.db")


def connect(path: str, create: bool = False) -> sqlite3.Connection:
    if not create and not os.path.exists(path):
        raise AsError(BACKEND_UNAVAILABLE, "The state database has not been initialized by the coordinator.",
                      retryable=True, remediation="Run: agent-studio coordinator start")
    conn = sqlite3.connect(path, timeout=5.0, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def current_version(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()
    return int(row[0] or 0)


def migrate(conn: sqlite3.Connection, path: str) -> int:
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)")
        version = current_version(conn)
        if version > SCHEMA_VERSION:
            raise AsError(UNSUPPORTED_SCHEMA, f"Database schema version {version} is newer than this backend supports "
                                              f"({SCHEMA_VERSION}).", remediation="Upgrade Agent Studio.")
        for v in range(version + 1, SCHEMA_VERSION + 1):
            for stmt in MIGRATIONS[v]:
                conn.execute(stmt)
            conn.execute("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", (v, utcnow()))
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    for suffix in ("", "-wal", "-shm"):
        p = path + suffix
        if os.path.exists(p):
            os.chmod(p, 0o600)
    return SCHEMA_VERSION


def check_schema(conn: sqlite3.Connection) -> None:
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
