"""Immutable worker-report inbox. Runners insert; only the coordinator applies, exactly once per report."""
from __future__ import annotations

import hashlib
import json
import sqlite3
from typing import Callable, Optional, Tuple

from . import schema
from .protocol import AsError, BAD_REQUEST
from .state import utcnow
from .store import NOT_FOUND, Store, Tx, encode_payload, validate_uuid

REPORT_CONFLICT = "REPORT_CONFLICT"


def submit(conn, assignment_id: str, report_seq: int, kind: str, payload: dict) -> int:
    """Runner side. Re-submitting an identical report is a no-op that returns the original id."""
    validate_uuid(assignment_id, "assignmentId")
    if isinstance(report_seq, bool) or not isinstance(report_seq, int) or report_seq < 0:
        raise AsError(BAD_REQUEST, "report_seq must be a non-negative integer.")
    if kind not in schema.REPORT_KINDS:
        raise AsError(BAD_REQUEST, f"Unknown report kind {kind!r}.")
    text = encode_payload(payload)
    digest = hashlib.sha256(text.encode("ascii")).hexdigest()
    try:
        cur = conn.execute("INSERT INTO worker_reports (assignment_id, report_seq, kind, payload_json, payload_hash, "
                           "received_at) VALUES (?, ?, ?, ?, ?, ?)",
                           (assignment_id, report_seq, kind, text, digest, utcnow()))
        return int(cur.lastrowid)
    except sqlite3.IntegrityError as e:
        if "FOREIGN KEY" in str(e):
            raise AsError(NOT_FOUND, f"Assignment {assignment_id} does not exist.")
        row = conn.execute("SELECT id, kind, payload_hash FROM worker_reports WHERE assignment_id = ? AND report_seq = ?",
                           (assignment_id, report_seq)).fetchone()
        if row is None:
            raise
        if row["kind"] != kind or row["payload_hash"] != digest:
            raise AsError(REPORT_CONFLICT, f"Report {report_seq} for assignment {assignment_id} was already submitted "
                                           "with different content.")
        return int(row["id"])


Handler = Callable[[Tx, dict], Tuple[str, Optional[int]]]


def record_only(tx: Tx, report: dict) -> Tuple[str, Optional[int]]:
    """S02 default: attach the report to its assignment as evidence without changing state.
    S04/S05 replace this with real report semantics."""
    seq = tx.note("assignment", report["assignment_id"], "assignment.report_received",
                  {"reportSeq": report["report_seq"], "kind": report["kind"]})
    return "recorded", seq


def apply_pending(store: Store, handler: Handler = record_only, limit: int = 100) -> int:
    rows = store.conn.execute(
        "SELECT r.* FROM worker_reports r LEFT JOIN report_applications a ON a.report_id = r.id "
        "WHERE a.report_id IS NULL ORDER BY r.id LIMIT ?", (limit,)).fetchall()
    applied = 0
    for row in rows:
        report = dict(row)
        report["payload"] = json.loads(report.pop("payload_json"))
        try:
            with store.transaction(actor="runner", report_id=report["id"]) as tx:
                if tx.conn.execute("SELECT 1 FROM report_applications WHERE report_id = ?", (report["id"],)).fetchone():
                    continue  # applied by an earlier pass; applying is idempotent
                outcome, seq = handler(tx, report)
                tx.conn.execute("INSERT INTO report_applications (report_id, applied_at, outcome, event_seq) "
                                "VALUES (?, ?, ?, ?)", (report["id"], utcnow(), outcome, seq))
            applied += 1
        except AsError as e:
            # The handler rejected the report (e.g. invalid transition). Record that once, without state change.
            with store.transaction(actor="runner", report_id=report["id"]) as tx:
                tx.conn.execute("INSERT INTO report_applications (report_id, applied_at, outcome, event_seq) "
                                "VALUES (?, ?, ?, NULL)", (report["id"], utcnow(), f"rejected:{e.code}"))
            applied += 1
    return applied
