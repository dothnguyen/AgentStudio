"""How the coordinator applies worker reports to state (P00-S03 minimal rules; S04 adds evidence validation).

Rules that already hold:
  * a report must match its assignment's agent and attempt, or it is rejected without any state change;
  * `start` is the only way from claimed to running, and it must carry a full process identity;
  * a final report can only finish a running/waiting assignment; terminal assignments never change;
  * an `inconclusive` final goes to `reconciling`, never to `succeeded`.
"""
from __future__ import annotations

from .protocol import AsError
from .store import Tx

REPORT_MISMATCH = "REPORT_MISMATCH"
ACTIVE_ASSIGNMENT = ("claimed", "running", "waiting_input", "reconciling")

FINAL_MAP = {  # report status -> (assignment state, task state or None, agent state)
    "succeeded": ("succeeded", "succeeded", "idle"),
    "failed": ("failed", "failed", "idle"),
    "cancelled": ("cancelled", "cancelled", "idle"),
    "waiting_input": ("waiting_input", "waiting_input", "waiting_input"),
    "inconclusive": ("reconciling", None, "idle"),
}


def _int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def apply(tx: Tx, report: dict):
    asg = tx.get("assignment", report["assignment_id"])
    payload = report["payload"]
    if payload.get("agentId") != asg["agent_id"] or payload.get("attempt") != asg["attempt"]:
        raise AsError(REPORT_MISMATCH, "Report agent/attempt does not match the assignment.")
    kind = report["kind"]
    data = {"reportSeq": report["report_seq"]}

    if kind == "start":
        if not (_int(payload.get("pid")) and _int(payload.get("startTime")) and isinstance(payload.get("bootId"), str)):
            raise AsError(REPORT_MISMATCH, "A start report needs pid, startTime and bootId.")
        seq = tx.transition("assignment", asg["id"], "running", expect=["claimed"], payload=data, set_values={
            "process_pid": payload["pid"], "process_start_time": payload["startTime"],
            "process_boot_id": payload["bootId"]})
        task = tx.get("task", asg["task_id"])
        if task["status"] == "assigned":
            tx.transition("task", task["id"], "running")
        agent = tx.get("agent", asg["agent_id"])
        if agent["availability"] == "idle":
            tx.transition("agent", agent["id"], "busy")
        return "started", seq

    if kind in ("progress", "attention"):
        if asg["status"] not in ACTIVE_ASSIGNMENT:
            raise AsError(REPORT_MISMATCH, f"Assignment is {asg['status']}; late {kind} report ignored.")
        message = str(payload.get("message", ""))[:500]
        return "recorded", tx.note("assignment", asg["id"], f"assignment.{kind}", dict(data, message=message))

    if kind == "final":
        status = payload.get("status")
        if status not in FINAL_MAP:
            raise AsError(REPORT_MISMATCH, f"Unknown final status {status!r}.")
        a_state, t_state, g_state = FINAL_MAP[status]
        result = {"status": status, "summary": str(payload.get("summary", ""))[:2000],
                  "stub": bool(payload.get("stub")), "diagnosticCode": payload.get("diagnosticCode")}
        seq = tx.transition("assignment", asg["id"], a_state, expect=["running", "waiting_input"], payload=data,
                            set_values={"result_json": result, "diagnostic_code": payload.get("diagnosticCode")})
        task = tx.get("task", asg["task_id"])
        if t_state and task["status"] != t_state and t_state in _task_targets(task["status"]):
            tx.transition("task", task["id"], t_state)
        agent = tx.get("agent", asg["agent_id"])
        if agent["availability"] in ("busy", "waiting_input") and agent["availability"] != g_state:
            tx.transition("agent", agent["id"], g_state)
        return "finished", seq

    raise AsError(REPORT_MISMATCH, f"Unknown report kind {kind!r}.")


def _task_targets(current: str):
    from .schema import ENTITIES
    return ENTITIES["task"].transitions.get(current, frozenset())
