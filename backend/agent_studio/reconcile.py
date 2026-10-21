"""Reconciliation (P00-S07): turn every interruption into a truthful state. Runs once at coordinator startup and
then on every liveness tick. Decisions are recorded as events; nothing is ever re-dispatched on suspicion.

  running, runner alive                 -> leave it (escalate a cancel the runner ignores)
  running, runner gone, final report    -> leave it for the normal report path
  running, runner gone, result.json     -> apply the saved result (it was completed; its report was lost)
  running, runner gone, no evidence     -> reconciling RUNNER_GONE (or cancelled, if a cancel was requested)
  claimed, request still in the inbox   -> leave it (the worker will pick it up)
  claimed, request nowhere              -> redelivered by teams.redeliver (never seen by a worker)
  claimed, finished without start       -> reconciling RUNNER_NEVER_STARTED
  claimed, picked up, no start in grace -> reconciling RUNNER_NO_START
Uncertain work leaves `reconciling` only through `assignment.resolve` or proven evidence.
"""
from __future__ import annotations

import json
import os
import signal
import time
from datetime import datetime, timezone

from . import procid, report_rules, tmuxctl
from .protocol import AsError
from .providers.base import Adapter
from .runner import CANCEL_MARKER, request_path, run_dir
from .store import Store

CLAIM_START_GRACE_S = float(os.environ.get("AGENT_STUDIO_TEST_CLAIM_GRACE_S", "60"))
CANCEL_ESCALATE_S = 15.0


def _ident(a) -> dict:
    return {"pid": a["process_pid"], "startTime": a["process_start_time"], "bootId": a["process_boot_id"]}


def _unapplied(conn, assignment_id: str) -> bool:
    return conn.execute("SELECT 1 FROM worker_reports r LEFT JOIN report_applications x ON x.report_id = r.id "
                        "WHERE r.assignment_id = ? AND x.report_id IS NULL LIMIT 1", (assignment_id,)).fetchone() \
        is not None


def _age_s(iso: str) -> float:
    try:
        t = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - t).total_seconds()
    except ValueError:
        return 0.0


def _agent_free(tx, agent_id: str) -> None:
    g = tx.get("agent", agent_id)
    if g["availability"] in ("busy", "waiting_input"):
        tx.transition("agent", agent_id, "idle", payload={"reason": "its runner is gone"})


def tick(store: Store, ctx: dict) -> dict:
    sd = ctx["stateDir"]
    summary = {"appliedFromEvidence": 0, "markedReconciling": 0, "cancelled": 0, "escalated": 0}
    rows = store.conn.execute("SELECT * FROM assignments WHERE status IN ('claimed', 'running')").fetchall()
    for a in map(dict, rows):
        if _unapplied(store.conn, a["id"]):
            continue  # its own reports will settle it on the next pass
        rd = run_dir(sd, a["id"])
        marker = os.path.join(rd, CANCEL_MARKER)
        if a["status"] == "running":
            ident = _ident(a)
            if procid.matches(ident):
                if os.path.exists(marker) and time.time() - os.path.getmtime(marker) > CANCEL_ESCALATE_S:
                    try:
                        os.kill(ident["pid"], signal.SIGKILL)  # verified identity; the provider dies with it
                        summary["escalated"] += 1
                        with store.transaction() as tx:
                            tx.note("assignment", a["id"], "assignment.cancel_escalated",
                                    {"reason": f"runner ignored the cancel for {CANCEL_ESCALATE_S:g}s"})
                    except ProcessLookupError:
                        pass
                continue
            evidence = Adapter().reconcile(ident, rd)
            with store.transaction() as tx:
                if evidence["state"] == "terminal":
                    report = evidence["report"]
                    try:
                        report_rules.apply(tx, {"assignment_id": a["id"], "report_seq": None, "kind": "final",
                                                "payload": dict(report, agentId=a["agent_id"], attempt=a["attempt"])})
                        tx.note("assignment", a["id"], "assignment.reconciled",
                                {"decision": "applied the saved result", "source": "result.json",
                                 "status": report.get("status")})
                        summary["appliedFromEvidence"] += 1
                        continue
                    except AsError as e:
                        evidence = {"state": "uncertain", "reason": f"saved result rejected: {e.code}"}
                if os.path.exists(marker):
                    from .tasks import _finish_cancel
                    _finish_cancel(tx, a, "cancel requested and the runner is gone")
                    summary["cancelled"] += 1
                else:
                    tx.transition("assignment", a["id"], "reconciling", set_values={"diagnostic_code": "RUNNER_GONE"},
                                  payload={"reason": evidence.get("reason", "runner gone"), "decision": "reconciling"})
                    _agent_free(tx, a["agent_id"])
                    summary["markedReconciling"] += 1
            continue
        # claimed
        boxes = {b for b in ("inbox", "active", "done") if os.path.exists(request_path(sd, a["agent_id"], a["id"], b))}
        reason = None
        if "done" in boxes:
            reason, code = "the worker finished the request without a start report", "RUNNER_NEVER_STARTED"
        elif "active" in boxes and _age_s(a["updated_at"]) > CLAIM_START_GRACE_S:
            reason, code = f"no start report {CLAIM_START_GRACE_S:g}s after a worker took the request", "RUNNER_NO_START"
        if reason:
            with store.transaction() as tx:
                tx.transition("assignment", a["id"], "reconciling", set_values={"diagnostic_code": code},
                              payload={"reason": reason, "decision": "reconciling"})
            summary["markedReconciling"] += 1
    return summary


def orphan_sessions(store: Store, tmux: tmuxctl.Tmux) -> list:
    """Agent Studio sessions with no running team. Removed only when the team row proves ownership
    (an interrupted stop); otherwise preserved and reported."""
    out = []
    for s in tmux.list_sessions() or []:
        team_id = tmux.session_option(s["session_id"], tmuxctl.OPT_TEAM)
        if not team_id:
            continue
        row = store.conn.execute("SELECT * FROM teams WHERE id = ?", (team_id,)).fetchone()
        if row and row["status"] in ("running", "starting", "error"):
            continue
        owner = tmux.session_option(s["session_id"], tmuxctl.OPT_OWNER)
        if row and row["status"] in ("stopped", "stopping") and owner == row["ownership_marker"]:
            tmux.kill_session(s["session_id"])
            with store.transaction() as tx:
                tx.note("team", team_id, "team.orphan_session_removed", {"sessionId": s["session_id"]})
            out.append(dict(s, action="removed"))
        else:
            out.append(dict(s, action="preserved", reason="no team row proves ownership"))
    return out
