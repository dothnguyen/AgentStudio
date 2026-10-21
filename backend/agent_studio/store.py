"""Coordinator-only state writer. Every mutation writes its row change and exactly one event in the same
transaction; invalid transitions raise INVALID_TRANSITION and roll everything back."""
from __future__ import annotations

import json
import re
import uuid
from contextlib import contextmanager
from typing import Any, Dict, Iterable, Optional

from . import schema
from .protocol import AsError, BAD_REQUEST, INTERNAL
from .state import utcnow

INVALID_TRANSITION = "INVALID_TRANSITION"
NOT_FOUND = "NOT_FOUND"
MAX_PAYLOAD_BYTES = 64 * 1024
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
EVENT_NAME_RE = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$")


def new_id() -> str:
    return str(uuid.uuid4())


def validate_uuid(value: Any, name: str = "id") -> str:
    if not isinstance(value, str) or not UUID_RE.match(value):
        raise AsError(BAD_REQUEST, f"{name} must be a lowercase UUID v4.")
    return value


def encode_payload(payload: Optional[dict]) -> str:
    if payload is None:
        payload = {}
    if not isinstance(payload, dict):
        raise AsError(INTERNAL, "Event payload must be a JSON object.")
    try:
        text = json.dumps(payload, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError) as e:
        raise AsError(INTERNAL, f"Event payload is not valid JSON: {e}")
    if len(text) > MAX_PAYLOAD_BYTES:
        raise AsError(INTERNAL, f"Event payload exceeds {MAX_PAYLOAD_BYTES} bytes.")
    return text


def _entity(name: str) -> schema.Entity:
    try:
        return schema.ENTITIES[name]
    except KeyError:
        raise AsError(INTERNAL, f"Unknown entity {name!r}.")


def _check_columns(ent: schema.Entity, values: Dict[str, Any]) -> None:
    unknown = set(values) - set(ent.columns)
    if unknown:
        raise AsError(INTERNAL, f"Columns not writable on {ent.table}: {sorted(unknown)}")
    for col, value in values.items():
        if col.endswith("_json") and value is not None and not isinstance(value, str):
            values[col] = encode_payload(value) if isinstance(value, dict) else json.dumps(value, ensure_ascii=True)


class Store:
    def __init__(self, conn):
        if getattr(conn, "role", None) != "coordinator":
            raise AsError(INTERNAL, "Only the coordinator may open a state writer.")
        self.conn = conn

    @contextmanager
    def transaction(self, actor: str = "coordinator", command_seq: Optional[int] = None,
                    report_id: Optional[int] = None):
        if actor not in schema.ACTORS:
            raise AsError(INTERNAL, f"Unknown actor {actor!r}.")
        self.conn.execute("BEGIN IMMEDIATE")
        tx = Tx(self.conn, actor, command_seq, report_id)
        try:
            yield tx
            self.conn.execute("COMMIT")
        except BaseException:
            self.conn.execute("ROLLBACK")
            raise


class Tx:
    def __init__(self, conn, actor, command_seq, report_id):
        self.conn = conn
        self.actor = actor
        self.command_seq = command_seq
        self.report_id = report_id
        self.events = []  # seqs written in this transaction

    # ---- reads -------------------------------------------------------------------------------
    def get(self, entity: str, entity_id: str) -> dict:
        ent = _entity(entity)
        row = self.conn.execute(f"SELECT * FROM {ent.table} WHERE id = ?", (entity_id,)).fetchone()
        if row is None:
            raise AsError(NOT_FOUND, f"{entity} {entity_id} does not exist.")
        return dict(row)

    # ---- writes (each writes exactly one event) -------------------------------------------------
    def create(self, entity: str, values: Dict[str, Any], state: Optional[str] = None,
               event: Optional[str] = None, payload: Optional[dict] = None, entity_id: Optional[str] = None) -> str:
        ent = _entity(entity)
        values = dict(values)
        _check_columns(ent, values)
        if state is None:
            state = sorted(ent.initial)[0]
        if state not in ent.initial:
            raise AsError(INVALID_TRANSITION, f"{entity} cannot be created in state {state!r}.")
        entity_id = validate_uuid(entity_id) if entity_id else new_id()
        now = utcnow()
        row = dict(values, id=entity_id, created_at=now, updated_at=now)
        row[ent.state_col] = state
        cols = list(row)
        self.conn.execute(f"INSERT INTO {ent.table} ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                          [row[c] for c in cols])
        self._event(ent, row, event or f"{entity}.created", None, state, payload)
        return entity_id

    def transition(self, entity: str, entity_id: str, to_state: str, event: Optional[str] = None,
                   payload: Optional[dict] = None, set_values: Optional[Dict[str, Any]] = None,
                   expect: Optional[Iterable[str]] = None) -> int:
        ent = _entity(entity)
        current = self.get(entity, entity_id)
        from_state = current[ent.state_col]
        if expect is not None and from_state not in set(expect):
            raise AsError(INVALID_TRANSITION, f"{entity} {entity_id} is {from_state!r}, expected one of {sorted(expect)}.",
                          data={"entity": entity, "id": entity_id, "state": from_state})
        if to_state not in ent.transitions.get(from_state, frozenset()):
            raise AsError(INVALID_TRANSITION, f"{entity} cannot go from {from_state!r} to {to_state!r}.",
                          data={"entity": entity, "id": entity_id, "state": from_state, "requested": to_state})
        values = dict(set_values or {})
        _check_columns(ent, values)
        values[ent.state_col] = to_state
        values["updated_at"] = utcnow()
        assignments = ", ".join(f"{c} = ?" for c in values)
        cur = self.conn.execute(f"UPDATE {ent.table} SET {assignments} WHERE id = ? AND {ent.state_col} = ?",
                                list(values.values()) + [entity_id, from_state])
        if cur.rowcount != 1:
            raise AsError(INVALID_TRANSITION, f"{entity} {entity_id} changed concurrently.")
        current.update(values)
        return self._event(ent, current, event or f"{entity}.{to_state}", from_state, to_state, payload)

    def update(self, entity: str, entity_id: str, set_values: Dict[str, Any], event: str,
               payload: Optional[dict] = None) -> int:
        """Change non-state columns (e.g. pane identity). Still records one event."""
        ent = _entity(entity)
        values = dict(set_values)
        if not values:
            raise AsError(INTERNAL, "update() needs at least one column.")
        _check_columns(ent, values)
        current = self.get(entity, entity_id)
        values["updated_at"] = utcnow()
        assignments = ", ".join(f"{c} = ?" for c in values)
        self.conn.execute(f"UPDATE {ent.table} SET {assignments} WHERE id = ?", list(values.values()) + [entity_id])
        current.update(values)
        state = current[ent.state_col]
        return self._event(ent, current, event, state, state, payload)

    def note(self, entity: str, entity_id: str, event: str, payload: Optional[dict] = None) -> int:
        """Record evidence about an entity without changing it."""
        ent = _entity(entity)
        current = self.get(entity, entity_id)
        state = current[ent.state_col]
        return self._event(ent, current, event, state, state, payload)

    # ---- internals ---------------------------------------------------------------------------
    def _event(self, ent: schema.Entity, row: dict, name: str, from_state, to_state, payload) -> int:
        if not EVENT_NAME_RE.match(name):
            raise AsError(INTERNAL, f"Invalid event name {name!r}.")
        refs = {c: None for c in schema.EVENT_REF_COLS}
        for col in ent.ref_cols_in_row:
            refs[col] = row.get(col)
        if ent.ref_col:
            refs[ent.ref_col] = row["id"]
        cur = self.conn.execute(
            "INSERT INTO events (at, actor, name, entity, entity_id, team_id, agent_id, task_id, assignment_id, "
            "workflow_run_id, command_seq, report_id, from_state, to_state, payload_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (utcnow(), self.actor, name, ent.name, row["id"], refs["team_id"], refs["agent_id"], refs["task_id"],
             refs["assignment_id"], refs["workflow_run_id"], self.command_seq, self.report_id, from_state, to_state,
             encode_payload(payload)))
        self.events.append(cur.lastrowid)
        return int(cur.lastrowid)
