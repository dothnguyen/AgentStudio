"""Protocol envelope, error codes, and field validation (protocol agent-studio/v1)."""
from __future__ import annotations

import json
import re
from typing import Any, Optional

from . import PROTOCOL

BAD_REQUEST = "BAD_REQUEST"
UNSUPPORTED_PROTOCOL = "UNSUPPORTED_PROTOCOL"
UNKNOWN_COMMAND = "UNKNOWN_COMMAND"
WORKSPACE_NOT_FOUND = "WORKSPACE_NOT_FOUND"
TMUX_NOT_FOUND = "TMUX_NOT_FOUND"
STATE_DIR_UNUSABLE = "STATE_DIR_UNUSABLE"
BACKEND_UNAVAILABLE = "BACKEND_UNAVAILABLE"
PENDING = "PENDING"
IDEMPOTENCY_CONFLICT = "IDEMPOTENCY_CONFLICT"
UNSUPPORTED_SCHEMA = "UNSUPPORTED_SCHEMA"
DEBUG_DISABLED = "DEBUG_DISABLED"
INTERNAL = "INTERNAL"
TICKET_NOT_FOUND = "TICKET_NOT_FOUND"
TICKET_TRANSITION_INVALID = "TICKET_TRANSITION_INVALID"
TICKET_BUSY = "TICKET_BUSY"
TICKET_DEPENDENCY_CYCLE = "TICKET_DEPENDENCY_CYCLE"
STORY_PATH_INVALID = "STORY_PATH_INVALID"
WORKTREE_EXISTS = "WORKTREE_EXISTS"
WORKTREE_NOT_REGISTERED = "WORKTREE_NOT_REGISTERED"
MAIN_CHECKOUT_WRONG_BRANCH = "MAIN_CHECKOUT_WRONG_BRANCH"
BOARD_CONFIG_INVALID = "BOARD_CONFIG_INVALID"
BOARD_STATUS_UNKNOWN = "BOARD_STATUS_UNKNOWN"
PHASE_NOT_FOUND = "PHASE_NOT_FOUND"
PHASE_EXISTS = "PHASE_EXISTS"
PHASE_PROTECTED = "PHASE_PROTECTED"
PHASE_CLOSED = "PHASE_CLOSED"
PHASE_NOT_EMPTY = "PHASE_NOT_EMPTY"
BOARD_RULE_MISSING = "BOARD_RULE_MISSING"
BOARD_ALREADY_RUNNING = "BOARD_ALREADY_RUNNING"
TICKET_CAP_REACHED = "TICKET_CAP_REACHED"
TICKET_DUPLICATE = "TICKET_DUPLICATE"
FORBIDDEN = "FORBIDDEN"
TICKET_ROLE_MISMATCH = "TICKET_ROLE_MISMATCH"
MANIFEST_INVALID = "MANIFEST_INVALID"

# Guard against unbounded memory use on a single serve line; individual fields have their own limits.
MAX_LINE_BYTES = 2 * 1024 * 1024
MAX_ID_CHARS = 128
IDEMPOTENCY_KEY_RE = re.compile(r"^[A-Za-z0-9._:-]{8,128}$")


class AsError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False,
                 remediation: Optional[str] = None, data: Any = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.remediation = remediation
        self.data = data

    def to_error(self) -> dict:
        err = {"code": self.code, "message": self.message, "retryable": self.retryable}
        if self.remediation:
            err["remediation"] = self.remediation
        return err


def dumps(obj: Any) -> bytes:
    """Wire encoding. ensure_ascii keeps the bytes 7-bit clean so no console code page can corrupt them;
    JSON escapes still carry every Unicode character exactly."""
    return json.dumps(obj, ensure_ascii=True, separators=(",", ":")).encode("ascii")


def envelope(request_id: Any, ok: bool, data: Any = None, error: Optional[dict] = None) -> dict:
    resp = {"protocol": PROTOCOL, "id": request_id, "ok": ok}
    if data is not None:
        resp["data"] = data
    if error is not None:
        resp["error"] = error
    return resp


def validate_id(value: Any) -> Any:
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise AsError(BAD_REQUEST, "Request id must be a string or integer.")
    if isinstance(value, str) and not (1 <= len(value) <= MAX_ID_CHARS):
        raise AsError(BAD_REQUEST, f"Request id must be 1-{MAX_ID_CHARS} characters.")
    return value


def validate_idempotency_key(value: Any) -> str:
    if not isinstance(value, str) or not IDEMPOTENCY_KEY_RE.match(value):
        raise AsError(BAD_REQUEST, "Mutating commands need an idempotencyKey of 8-128 characters [A-Za-z0-9._:-].")
    return value


def req_text(args: dict, name: str, max_bytes: int, required: bool = True, allow_empty: bool = True) -> Optional[str]:
    if name not in args or args[name] is None:
        if required:
            raise AsError(BAD_REQUEST, f"Missing required argument '{name}'.")
        return None
    value = args[name]
    if not isinstance(value, str):
        raise AsError(BAD_REQUEST, f"Argument '{name}' must be a string.")
    try:
        encoded = value.encode("utf-8")
    except UnicodeEncodeError:
        raise AsError(BAD_REQUEST, f"Argument '{name}' contains an unpaired surrogate and is not valid Unicode text.")
    if len(encoded) > max_bytes:
        raise AsError(BAD_REQUEST, f"Argument '{name}' is {len(encoded)} bytes; the limit is {max_bytes}.")
    if "\x00" in value:
        raise AsError(BAD_REQUEST, f"Argument '{name}' must not contain NUL characters.")
    if not allow_empty and not value:
        raise AsError(BAD_REQUEST, f"Argument '{name}' must not be empty.")
    return value


def req_int(args: dict, name: str, lo: int, hi: int, default: int) -> int:
    value = args.get(name, default)
    if isinstance(value, bool) or not isinstance(value, int) or not (lo <= value <= hi):
        raise AsError(BAD_REQUEST, f"Argument '{name}' must be an integer between {lo} and {hi}.")
    return value


def req_bool(args: dict, name: str, default: bool = False) -> bool:
    value = args.get(name, default)
    if not isinstance(value, bool):
        raise AsError(BAD_REQUEST, f"Argument '{name}' must be true or false.")
    return value
TEAM_EXISTS = "TEAM_EXISTS"
TEAM_NOT_FOUND = "TEAM_NOT_FOUND"
TEAM_AMBIGUOUS = "TEAM_AMBIGUOUS"
MEMBER_EXISTS = "MEMBER_EXISTS"
MEMBER_NOT_FOUND = "MEMBER_NOT_FOUND"
TEAM_ALREADY_RUNNING = "TEAM_ALREADY_RUNNING"
TEAM_NOT_RUNNING = "TEAM_NOT_RUNNING"
AGENT_CATALOG_INVALID = "AGENT_CATALOG_INVALID"
AGENT_EXISTS = "AGENT_EXISTS"
AGENT_NOT_FOUND = "AGENT_NOT_FOUND"
AGENT_IN_USE = "AGENT_IN_USE"
CONFIG_CHANGED = "CONFIG_CHANGED"
ROLE_NOT_FOUND = "ROLE_NOT_FOUND"
