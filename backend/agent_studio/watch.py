"""`task direct --wait`: follow one assignment from the journal (never from the pane) until it stops running.
Progress goes to stderr; the caller prints the final task detail as the single JSON response."""
from __future__ import annotations

import sys
import time

from . import paths, queries, state
from .textsafe import one_line

STOPPED = ("succeeded", "failed", "cancelled", "waiting_input", "reconciling")


def follow(assignment_id: str, task_id: str, poll_s: float = 0.5, timeout_s: float = None) -> dict:
    sd = paths.ensure_state_dir()
    conn = state.connect(state.db_path(sd), role="reader")
    try:
        cursor = 0
        deadline = None if timeout_s is None else time.monotonic() + timeout_s
        while True:
            page = queries.events_after(conn, cursor, limit=500)
            for e in page["events"]:
                if e.get("assignmentId") == assignment_id or e.get("taskId") == task_id:
                    msg = e["data"].get("message") if isinstance(e.get("data"), dict) else None
                    line = f"{e['at'][11:19]} {e['name']}" + (f" - {one_line(msg, 200)}" if msg else "") + \
                           (f" -> {e['to']}" if e.get("to") and e.get("from") != e.get("to") else "")
                    sys.stderr.write(line + "\n")
            sys.stderr.flush()
            cursor = page["nextCursor"]
            status = conn.execute("SELECT status FROM assignments WHERE id = ?", (assignment_id,)).fetchone()[0]
            if status in STOPPED and not page["hasMore"]:
                return queries.task_detail(conn, task_id)
            if deadline and time.monotonic() > deadline:
                return queries.task_detail(conn, task_id)
            time.sleep(poll_s)
    finally:
        conn.close()


WF_STOPPED = ("succeeded", "failed", "cancelled", "paused")


def follow_workflow(wf_id: str, poll_s: float = 0.5) -> dict:
    sd = paths.ensure_state_dir()
    conn = state.connect(state.db_path(sd), role="reader")
    try:
        task_id = conn.execute("SELECT task_id FROM workflow_runs WHERE id = ?", (wf_id,)).fetchone()[0]
        cursor = 0
        while True:
            page = queries.events_after(conn, cursor, limit=500)
            for e in page["events"]:
                if e.get("workflowRunId") == wf_id or e.get("taskId") == task_id:
                    if e["name"] == "assignment.progress":
                        continue
                    d = e.get("data") or {}
                    extra = d.get("reason") or d.get("message") or (f"verdict {d['verdict']}" if "verdict" in d else "") \
                        or (f"validation {'passed' if d.get('passed') else 'failed'}" if "passed" in d else "") \
                        or (f"-> {d['toStage']}" if "toStage" in d else "")
                    sys.stderr.write(f"{e['at'][11:19]} {e['name']}" + (f" - {one_line(str(extra), 200)}" if extra else "")
                                     + "\n")
            sys.stderr.flush()
            cursor = page["nextCursor"]
            status = conn.execute("SELECT status FROM workflow_runs WHERE id = ?", (wf_id,)).fetchone()[0]
            if status in WF_STOPPED and not page["hasMore"]:
                return queries.workflow_detail(conn, wf_id)
            time.sleep(poll_s)
    finally:
        conn.close()
