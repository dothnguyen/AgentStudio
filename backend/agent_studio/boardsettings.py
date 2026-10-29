"""Board settings (P05-S11): a read projection of board.json, roles.json, workflows and runner state, and validated atomic writes of board.json and role descriptions."""
from __future__ import annotations

import copy
import hashlib
import json
import os

from . import boardmodel, roles, workflowdef
from .protocol import AsError, BAD_REQUEST, BOARD_CONFIG_INVALID, CONFIG_CHANGED, ROLE_NOT_FOUND

PROTECTED_ROUTES = {"merge-conflict": "TeamLead", "plan-merge-conflict": "TeamLead"}
EDITABLE_BOARD_KEYS = ("statuses", "ticketFields", "rules", "leaseSeconds", "baseBranch", "agentTicketStatus")


def _path(workspace, name):
    return os.path.join(workspace, boardmodel.CONFIG_DIR, name)


def _read_bytes(path):
    try:
        with open(path, "rb") as f:
            return f.read()
    except FileNotFoundError:
        return None


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _write_json(path, doc) -> str:
    data = (json.dumps(doc, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    tmp = f"{path}.{os.getpid()}.tmp"
    try:
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except FileNotFoundError:
            pass
        raise
    return _sha(data)


def _check_expected(expected, current_bytes, name):
    if expected is not None and expected != _sha(current_bytes or b""):
        raise AsError(CONFIG_CHANGED, f"{boardmodel.CONFIG_DIR}/{name} changed since it was read; reload and retry.",
                      data={"sha256": None if current_bytes is None else _sha(current_bytes)})


def _status_ids(raw):
    if not isinstance(raw, dict) or not isinstance(raw.get("statuses"), list):
        return set()
    return {s["id"] for s in raw["statuses"] if isinstance(s, dict) and isinstance(s.get("id"), str)}


def protected_problems(current_raw, candidate_raw):
    problems = []
    applicable = _status_ids(current_raw) | _status_ids(candidate_raw)
    candidate_ids = _status_ids(candidate_raw)
    rules = candidate_raw.get("rules") if isinstance(candidate_raw, dict) else None
    rules = rules if isinstance(rules, list) else []
    for status, role in PROTECTED_ROUTES.items():
        if status not in applicable:
            continue
        if status not in candidate_ids:
            problems.append({"path": "statuses", "message": f"status {status!r} is protected and must stay on this board"})
            continue
        found = None
        for i, rule in enumerate(rules):
            if isinstance(rule, dict) and rule.get("when") == {"status": status}:
                found = (i, rule)
                break
        if found is None:
            problems.append({"path": "rules", "message": f"status {status!r} must have a rule routing it to role {role!r}"})
        elif found[1].get("role") != role:
            problems.append({"path": f"rules[{found[0]}].role",
                             "message": f"status {status!r} must route to role {role!r} (got {found[1].get('role')!r})"})
    return problems


def _board_block(ws):
    data = _read_bytes(_path(ws, "board.json"))
    if data is None:
        return ({"state": "missing", "sha256": None, "message": ".agent-studio/board.json does not exist",
                 "problems": [], "config": None}, None, None)
    sha = _sha(data)
    try:
        raw = json.loads(data)
    except ValueError as e:
        return ({"state": "invalid", "sha256": sha, "message": f"board.json is not valid JSON: {e}",
                 "problems": [], "config": None}, None, None)
    try:
        cfg = boardmodel.parse_config(raw)
    except AsError as e:
        return ({"state": "invalid", "sha256": sha, "message": e.message,
                 "problems": (e.data or {}).get("problems", []), "config": raw}, raw, None)
    return ({"state": "ok", "sha256": sha, "message": None, "problems": boardmodel.check_rules(ws, cfg),
             "config": raw}, raw, cfg)


def _roles_block(ws):
    data = _read_bytes(_path(ws, "roles.json"))
    if data is None:
        return {"state": "missing", "sha256": None, "message": ".agent-studio/roles.json does not exist", "items": []}
    sha = _sha(data)
    try:
        raw = roles.load_config(ws)
    except AsError as e:
        return {"state": "invalid", "sha256": sha, "message": e.message, "items": []}
    if raw is None:
        return {"state": "missing", "sha256": None, "message": ".agent-studio/roles.json does not exist", "items": []}
    items = [{"id": name, "description": spec.get("description") if isinstance(spec.get("description"), str) else None}
             for name, spec in raw["roles"].items()]
    return {"state": "ok", "sha256": sha, "message": None, "items": items}


def runner(conn, workspace, coordinator_running, runtime_error):
    out = {"status": None, "runStatus": None, "teamId": None, "teamStatus": None, "teamDefId": None,
           "coordinatorRunning": bool(coordinator_running), "error": runtime_error}
    if runtime_error is not None or conn is None:
        out["status"] = "unavailable"
        return out
    row = conn.execute("SELECT team_id, run_status FROM board_state WHERE workspace = ?", (workspace,)).fetchone()
    if row is None or row["team_id"] is None:
        out["status"] = "not_bound"
        out["runStatus"] = row["run_status"] if row else None
        return out
    out["runStatus"], out["teamId"] = row["run_status"], row["team_id"]
    team = conn.execute("SELECT status, def_id FROM teams WHERE id = ?", (row["team_id"],)).fetchone()
    if team is not None:
        out["teamStatus"], out["teamDefId"] = team["status"], team["def_id"]
    if row["run_status"] == "stopped":
        out["status"] = "stopped"
    elif team is None or team["status"] != "running":
        out["status"] = "team_not_running"
    elif not coordinator_running:
        out["status"] = "disconnected"
    else:
        out["status"] = "running"
    return out


def settings(conn, workspace, coordinator_running, runtime_error):
    ws = workspace
    board, raw, cfg = _board_block(ws)
    statuses, rules, action_rules = [], [], []
    worktree = {"baseBranch": None, "worktreeStatuses": []}
    if cfg is not None:
        statuses = [{"id": s["id"], "name": s.get("name"), "kind": s.get("kind")} for s in cfg["statuses"]]
        for i, r in enumerate(cfg["rules"]):
            status = r["when"]["status"]
            rules.append({"index": i, "status": status, "type": "action" if "action" in r else "agent",
                          "role": r.get("role"), "workflow": r.get("workflow"), "action": r.get("action"),
                          "onPass": r["onPass"], "onFail": r["onFail"], "onBlocked": r.get("onBlocked"),
                          "workspace": r.get("workspace"), "syncBase": r.get("syncBase", False),
                          "maxRounds": r.get("maxRounds"), "priority": r.get("priority"),
                          "protected": status in PROTECTED_ROUTES})
            if "action" in r:
                action_rules.append({"status": status, "action": r["action"], "onPass": r["onPass"],
                                     "onFail": r["onFail"], "onPassCreatedTickets": r.get("onPassCreatedTickets")})
        worktree = {"baseBranch": cfg["baseBranch"],
                    "worktreeStatuses": [r["when"]["status"] for r in cfg["rules"] if r.get("workspace") == "worktree"]}
    ids = _status_ids(raw)
    problems = protected_problems(raw, raw)
    protected = [{"status": status, "role": role,
                  "satisfied": not any(repr(status) in p["message"] for p in problems)}
                 for status, role in PROTECTED_ROUTES.items() if status in ids]
    workflows = [{"name": d["name"], "builtin": d["builtin"], "roles": d["roles"], "errors": d["errors"]}
                 for d in workflowdef.list_definitions(ws, boardmodel.BUILTIN_DEFINITIONS_DIR)]
    return {"workspace": ws, "board": board, "statuses": statuses, "rules": rules, "actionRules": action_rules,
            "worktree": worktree, "protectedRoutes": protected, "roles": _roles_block(ws), "workflows": workflows,
            "runner": runner(conn, ws, coordinator_running, runtime_error)}


def update_board(workspace, changes, expected_sha256=None):
    ws = workspace
    if not isinstance(changes, dict) or not changes:
        raise AsError(BAD_REQUEST, "changes must be a non-empty object.")
    unknown = set(changes) - set(EDITABLE_BOARD_KEYS)
    if unknown:
        raise AsError(BAD_REQUEST, f"changes got unknown key(s): {', '.join(sorted(unknown))}.")
    path = _path(ws, "board.json")
    data = _read_bytes(path)
    if data is None:
        boardmodel.load_config(ws)  # raises the standard "no board.json" error
        raise AsError(BOARD_CONFIG_INVALID, "board.json cannot be read as a JSON object; fix it by hand first.")
    try:
        current = json.loads(data)
    except ValueError:
        current = None
    if not isinstance(current, dict):
        raise AsError(BOARD_CONFIG_INVALID, "board.json cannot be read as a JSON object; fix it by hand first.")
    _check_expected(expected_sha256, data, "board.json")
    candidate = copy.deepcopy(current)
    for key, value in changes.items():
        if value is None:
            candidate.pop(key, None)
        else:
            candidate[key] = copy.deepcopy(value)
    cfg = boardmodel.parse_config(candidate)
    problems = boardmodel.check_rules(ws, cfg) + protected_problems(current, candidate)
    if problems:
        raise AsError(BOARD_CONFIG_INVALID, f"board.json is invalid: {len(problems)} problem(s); nothing was written",
                      data={"problems": problems})
    if candidate == current:
        return {"workspace": ws, "file": "board.json", "sha256": _sha(data), "changed": []}
    sha = _write_json(path, candidate)
    return {"workspace": ws, "file": "board.json", "sha256": sha, "changed": sorted(changes)}


def update_role(workspace, role_id, description, expected_sha256=None):
    result = roles.update_role(workspace, role_id, {"description": description}, expected_sha256)
    result["role"] = {"id": result["role"]["id"], "description": result["role"]["description"]}
    result.pop("warnings")
    return result
