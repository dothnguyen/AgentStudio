"""Board configuration loading and validation."""
from __future__ import annotations

import copy
import json
import os
import re

from . import schema
from .protocol import AsError, BOARD_CONFIG_INVALID

_NAME = re.compile(r"[a-z0-9][a-z0-9-]{0,63}\Z")
_BRANCH = re.compile(r"[A-Za-z0-9._/-]+\Z")
_HERE = os.path.dirname(os.path.abspath(__file__))


def _defaults():
    with open(os.path.join(_HERE, "board_defaults.json"), encoding="utf-8") as f:
        return json.load(f)


def _invalid(errors):
    raise AsError(BOARD_CONFIG_INVALID, "Board configuration is invalid.", data={"errors": errors})


def load(workspace, roles=None):
    defaults = _defaults()
    path = os.path.join(workspace, ".agent-studio", "board.json")
    written = {}
    try:
        if os.path.exists(path):
            if os.path.getsize(path) > 64 * 1024:
                _invalid([{"path": "$", "message": "file is larger than 64 KiB"}])
            with open(path, encoding="utf-8") as f:
                written = json.load(f)
    except json.JSONDecodeError:
        _invalid([{"path": "$", "message": "invalid JSON"}])
    except OSError as e:
        _invalid([{"path": "$", "message": str(e)}])
    if not isinstance(written, dict):
        _invalid([{"path": "$", "message": "root must be an object"}])
    errors = []
    allowed = set(defaults)
    for key in written:
        if key not in allowed:
            errors.append({"path": key, "message": "unknown key"})
    def bad(path, message): errors.append({"path": path, "message": message})
    if "version" in written and (type(written["version"]) is not int or written["version"] != 1):
        bad("version", "must be 1")
    if "baseBranch" in written:
        v = written["baseBranch"]
        if not isinstance(v, str) or not 1 <= len(v) <= 200 or not _BRANCH.fullmatch(v) or ".." in v: bad("baseBranch", "must be a valid branch name")
    for name, lo, hi in (("maxParallelDev", 1, 16), ("leaseSeconds", 30, 3600)):
        if name in written and (isinstance(written[name], bool) or not isinstance(written[name], int) or not lo <= written[name] <= hi): bad(name, f"must be an integer from {lo} to {hi}")
    if "requirePlanApproval" in written and not isinstance(written["requirePlanApproval"], bool): bad("requirePlanApproval", "must be a boolean")
    limits = written.get("roundLimits", {})
    if not isinstance(limits, dict): bad("roundLimits", "must be an object")
    else:
        for key, value in limits.items():
            p = "roundLimits." + key
            if key not in defaults["roundLimits"]: bad(p, "unknown key")
            elif isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 20: bad(p, "must be an integer from 1 to 20")
    columns = written.get("columns", {})
    if not isinstance(columns, dict): bad("columns", "must be an object")
    else:
        for column, value in columns.items():
            base = "columns." + column
            if column not in schema.BOARD_COLUMNS:
                bad(base, "unknown column")
                continue
            if not isinstance(value, dict):
                bad(base, "must be an object")
                continue
            for key, item in value.items():
                p = base + "." + key
                if key not in ("role", "definition", "bugDefinition"): bad(p, "unknown key")
                elif not isinstance(item, str) or not (1 <= len(item) <= (64 if key == "role" else 64)) or (key != "role" and not _NAME.fullmatch(item)): bad(p, "must be a valid string")
            if roles is not None and "role" in value and value["role"] not in roles: bad(base + ".role", "role is not in the team roster")
    if errors: _invalid(errors)
    result = copy.deepcopy(defaults)
    for key, value in written.items():
        if key == "columns":
            for column, column_value in value.items(): result["columns"][column].update(column_value)
        elif key == "roundLimits": result[key].update(value)
        else: result[key] = value
    if roles is not None:
        result["unstaffed"] = [name for name, value in result["columns"].items() if value["role"] not in roles]
    return result


def current(tx, workspace, roles):
    row = tx.conn.execute("SELECT config_json FROM board_state WHERE workspace = ?", (workspace,)).fetchone()
    if row and row[0]: return json.loads(row[0])
    return load(workspace, roles)
