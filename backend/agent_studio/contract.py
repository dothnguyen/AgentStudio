"""Validation of normalized assignment reports (architecture section F). Used by the runner before sending
and by the coordinator before applying, so a bad or forged report can never finish an assignment."""
from __future__ import annotations

from .protocol import AsError
from .providers.base import POLICIES, REPORT_PROTOCOL, STATUSES

BAD_REPORT = "BAD_REPORT"
REPORT_MISMATCH = "REPORT_MISMATCH"
CONTRADICTORY = "CONTRADICTORY_EVIDENCE"

REQUIRED = {"protocol": str, "assignmentId": str, "agentId": str, "providerId": str, "attempt": int,
            "policy": str, "status": str, "summary": str, "artifacts": list, "evidence": dict}
EVIDENCE_REQUIRED = {"providerTerminalEvent": bool, "timedOut": bool, "cancelRequested": bool, "truncated": bool,
                     "validation": list}


SESSION_MODES = ("none", "unsupported", "fresh", "resume")


def _nonneg(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def validate_report(r: dict, expect: dict) -> dict:
    if not isinstance(r, dict):
        raise AsError(BAD_REPORT, "Report must be an object.")
    for k, t in REQUIRED.items():
        if k not in r:
            raise AsError(BAD_REPORT, f"Report is missing {k!r}.")
        if not isinstance(r[k], t) or (t is int and isinstance(r[k], bool)):
            raise AsError(BAD_REPORT, f"Report field {k!r} has the wrong type.")
    if r["protocol"] != REPORT_PROTOCOL:
        raise AsError(BAD_REPORT, f"Unknown report protocol {r['protocol']!r}.")
    if r["status"] not in STATUSES:
        raise AsError(BAD_REPORT, f"Unknown status {r['status']!r}.")
    if r["policy"] not in POLICIES:
        raise AsError(BAD_REPORT, f"Unknown policy {r['policy']!r}.")
    for k in ("assignmentId", "agentId", "providerId", "attempt", "policy"):
        if k in expect and r[k] != expect[k]:
            raise AsError(REPORT_MISMATCH, f"Report {k} {r[k]!r} does not match the assignment ({expect[k]!r}).")
    ev = r["evidence"]
    for k, t in EVIDENCE_REQUIRED.items():
        if not isinstance(ev.get(k), t):
            raise AsError(BAD_REPORT, f"Report evidence field {k!r} is missing or has the wrong type.")
    exit_code = r.get("exitCode")
    if exit_code is not None and (not isinstance(exit_code, int) or isinstance(exit_code, bool)):
        raise AsError(BAD_REPORT, "exitCode must be an integer or null.")
    un = r.get("usageNormalized")
    if un is not None and not (isinstance(un, dict) and set(un) == {"inputTokens", "cachedInputTokens", "outputTokens"}
                               and all(_nonneg(v) for v in un.values())):
        raise AsError(BAD_REPORT, "usageNormalized must be null or three non-negative integers.")
    tu = r.get("toolUses")
    if tu is not None and not (isinstance(tu, dict) and len(tu) <= 100 and all(
            isinstance(k, str) and len(k) <= 100 and _nonneg(v) for k, v in tu.items())):
        raise AsError(BAD_REPORT, "toolUses must be null or at most 100 tool names mapped to non-negative integers.")
    if "session" in r and not (isinstance(r["session"], dict) and r["session"].get("mode") in SESSION_MODES):
        raise AsError(BAD_REPORT, f"session.mode must be one of {', '.join(SESSION_MODES)}.")
    if r["status"] == "succeeded":
        problems = []
        if not ev["providerTerminalEvent"] or not ev.get("terminalOk"):
            problems.append("no successful terminal provider event")
        if exit_code != 0:
            problems.append(f"exit code {exit_code}")
        if r.get("attention"):
            problems.append("unresolved attention")
        if ev["timedOut"] or ev["cancelRequested"] or ev.get("signal") is not None:
            problems.append("timeout/cancel/signal recorded")
        if r.get("diagnosticCode"):
            problems.append(f"diagnostic {r['diagnosticCode']}")
        if problems:
            raise AsError(CONTRADICTORY, "Report claims success but " + ", ".join(problems) + ".")
    return r
