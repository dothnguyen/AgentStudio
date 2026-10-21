"""Command inbox: clients insert rows; only the coordinator completes them."""
from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from typing import Optional

from .protocol import AsError, IDEMPOTENCY_CONFLICT
from .state import utcnow


def canonical(obj) -> str:
    return json.dumps(obj, ensure_ascii=True, sort_keys=True, separators=(",", ":"))


def payload_hash(command: str, args: dict) -> str:
    return hashlib.sha256(canonical({"command": command, "args": args}).encode("ascii")).hexdigest()


# ---- client side -----------------------------------------------------------------------------

def insert_or_get(conn: sqlite3.Connection, key: str, command: str, args: dict) -> int:
    digest = payload_hash(command, args)
    try:
        cur = conn.execute(
            "INSERT INTO commands (idempotency_key, command, payload_hash, args_json, status, created_at) "
            "VALUES (?, ?, ?, ?, 'pending', ?)",
            (key, command, digest, canonical(args), utcnow()))
        return int(cur.lastrowid)
    except sqlite3.IntegrityError:
        row = conn.execute("SELECT seq, payload_hash FROM commands WHERE idempotency_key = ?", (key,)).fetchone()
        if row is None:
            raise
        if row["payload_hash"] != digest:
            raise AsError(IDEMPOTENCY_CONFLICT, "This idempotency key was already used with a different command or payload.",
                          data={"idempotencyKey": key})
        return int(row["seq"])


def wait_response(conn: sqlite3.Connection, seq: int, timeout_s: float) -> Optional[dict]:
    deadline = time.monotonic() + timeout_s
    delay = 0.005
    while True:
        row = conn.execute("SELECT status, response_json FROM commands WHERE seq = ?", (seq,)).fetchone()
        if row is not None and row["status"] == "done":
            return json.loads(row["response_json"])
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None
        time.sleep(min(delay, remaining))
        delay = min(delay * 2, 0.05)


# ---- coordinator side ------------------------------------------------------------------------

def pending(conn: sqlite3.Connection, limit: int = 100):
    return conn.execute("SELECT seq, idempotency_key, command, args_json FROM commands "
                        "WHERE status = 'pending' ORDER BY seq LIMIT ?", (limit,)).fetchall()


def complete(conn: sqlite3.Connection, seq: int, response: dict) -> None:
    conn.execute("UPDATE commands SET status = 'done', response_json = ?, completed_at = ? "
                 "WHERE seq = ? AND status = 'pending'", (canonical(response), utcnow(), seq))
