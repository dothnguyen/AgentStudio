"""Schema v2: entities, enums, allowed transitions, and DDL. Single source for SQL CHECKs and Python validation."""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Dict, FrozenSet, Optional, Tuple

PROVIDERS = ("codex", "claude", "agy", "opencode", "fake")
POLICIES = ("read_only", "workspace_write")
STAGES = ("developer", "reviewer", "developer_repair", "reviewer_recheck")
ACTORS = ("coordinator", "operator", "runner")
REPORT_KINDS = ("start", "progress", "attention", "final")


def _t(spec: Dict[str, Tuple[str, ...]]) -> Dict[str, FrozenSet[str]]:
    return {k: frozenset(v) for k, v in spec.items()}


@dataclass(frozen=True)
class Entity:
    name: str                       # event entity name, e.g. "assignment"
    table: str
    state_col: str
    states: Tuple[str, ...]
    initial: FrozenSet[str]
    transitions: Dict[str, FrozenSet[str]]
    columns: Tuple[str, ...]        # insertable/updatable columns besides id, state, timestamps
    ref_col: Optional[str]          # events.<ref_col> holds this entity's id
    ref_cols_in_row: Tuple[str, ...] = field(default=())  # row columns copied into event refs

    @property
    def terminal(self) -> FrozenSet[str]:
        return frozenset(s for s in self.states if not self.transitions.get(s))


AGENT_STATES = ("starting", "idle", "busy", "waiting_input", "offline", "error")
ASSIGNMENT_STATES = ("queued", "claimed", "running", "waiting_input", "reconciling", "succeeded", "failed", "cancelled")
TASK_STATES = ("queued", "assigned", "running", "waiting_input", "review", "succeeded", "failed", "cancelled")
WORKFLOW_STATES = ("queued", "running", "paused", "succeeded", "failed", "cancelled")
TEAM_STATES = ("starting", "running", "stopping", "stopped", "error")
STAGE_ATTEMPT_STATES = ("active", "completed", "abandoned")

ENTITIES: Dict[str, Entity] = {
    "team": Entity(
        "team", "teams", "status", TEAM_STATES, frozenset({"starting"}),
        _t({"starting": ("running", "stopping", "error"),
            "running": ("stopping", "error"),
            "stopping": ("stopped", "error"),
            "error": ("stopping", "stopped"),
            "stopped": ()}),
        ("name", "workspace", "tmux_session_id", "tmux_window_id", "ownership_marker"),
        "team_id"),
    "agent": Entity(
        "agent", "agents", "availability", AGENT_STATES, frozenset({"starting"}),
        # Agents have no terminal state: an offline/error agent can be restarted.
        _t({"starting": ("idle", "offline", "error"),
            "idle": ("busy", "offline", "error"),
            "busy": ("idle", "waiting_input", "offline", "error"),
            "waiting_input": ("busy", "idle", "offline", "error"),
            "offline": ("starting", "idle", "error"),
            "error": ("starting", "offline")}),
        ("team_id", "ordinal", "provider_id", "role", "display_name", "pane_state", "pane_id", "pane_pid",
         "pane_start_time", "pane_boot_id", "capabilities_json"),
        "agent_id", ("team_id",)),
    "task": Entity(
        "task", "tasks", "status", TASK_STATES, frozenset({"queued"}),
        _t({"queued": ("assigned", "failed", "cancelled"),
            "assigned": ("running", "queued", "failed", "cancelled"),
            "running": ("review", "waiting_input", "succeeded", "failed", "cancelled"),
            "waiting_input": ("running", "failed", "cancelled"),
            "review": ("running", "succeeded", "failed", "cancelled"),
            "succeeded": (), "failed": (), "cancelled": ()}),
        ("team_id", "origin", "workspace", "goal", "outcome_json"),
        "task_id", ("team_id",)),
    "workflow_run": Entity(
        "workflow_run", "workflow_runs", "status", WORKFLOW_STATES, frozenset({"queued"}),
        _t({"queued": ("running", "failed", "cancelled"),
            "running": ("paused", "succeeded", "failed", "cancelled"),
            "paused": ("running", "failed", "cancelled"),
            "succeeded": (), "failed": (), "cancelled": ()}),
        ("team_id", "task_id", "workflow", "current_stage", "retry_count", "retry_budget", "base_commit",
         "transition_reason"),
        "workflow_run_id", ("team_id", "task_id")),
    "stage_attempt": Entity(
        "stage_attempt", "stage_attempts", "status", STAGE_ATTEMPT_STATES, frozenset({"active"}),
        _t({"active": ("completed", "abandoned"), "completed": (), "abandoned": ()}),
        ("team_id", "workflow_run_id", "stage", "attempt", "outcome", "artifacts_json"),
        None, ("team_id", "workflow_run_id")),
    "assignment": Entity(
        "assignment", "assignments", "status", ASSIGNMENT_STATES, frozenset({"queued"}),
        # Uncertain outcomes go to `reconciling`; nothing jumps from queued/claimed straight to succeeded.
        _t({"queued": ("claimed", "failed", "cancelled"),
            "claimed": ("running", "reconciling", "failed", "cancelled"),
            "running": ("waiting_input", "reconciling", "succeeded", "failed", "cancelled"),
            "waiting_input": ("running", "reconciling", "failed", "cancelled"),
            "reconciling": ("running", "waiting_input", "succeeded", "failed", "cancelled"),
            "succeeded": (), "failed": (), "cancelled": ()}),
        ("team_id", "task_id", "agent_id", "stage_attempt_id", "attempt", "policy", "provider_id", "process_pid",
         "process_start_time", "process_boot_id", "deadline_at", "result_json", "diagnostic_code", "request_json"),
        "assignment_id", ("team_id", "task_id", "agent_id")),
}

EVENT_REF_COLS = ("team_id", "agent_id", "task_id", "assignment_id", "workflow_run_id")


def _in(values) -> str:
    return "(" + ", ".join(f"'{v}'" for v in values) + ")"


ID = "TEXT PRIMARY KEY CHECK (length(id) = 36)"
TS = "created_at TEXT NOT NULL, updated_at TEXT NOT NULL"


def _immutable(table: str) -> list:
    return [f"CREATE TRIGGER {table}_no_update BEFORE UPDATE ON {table} "
            f"BEGIN SELECT RAISE(ABORT, '{table} is append-only'); END",
            f"CREATE TRIGGER {table}_no_delete BEFORE DELETE ON {table} "
            f"BEGIN SELECT RAISE(ABORT, '{table} is append-only'); END"]


def _insert_db_id(conn) -> None:
    conn.execute("INSERT INTO meta (key, value) VALUES ('db_id', ?)", (str(uuid.uuid4()),))


MIGRATION_2 = [
    "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    _insert_db_id,
    f"""CREATE TABLE teams (
        id {ID},
        name TEXT NOT NULL,
        workspace TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN {_in(TEAM_STATES)}),
        tmux_session_id TEXT, tmux_window_id TEXT, ownership_marker TEXT,
        {TS})""",
    f"""CREATE TABLE agents (
        id {ID},
        team_id TEXT NOT NULL REFERENCES teams(id),
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        provider_id TEXT NOT NULL CHECK (provider_id IN {_in(PROVIDERS)}),
        role TEXT NOT NULL,
        display_name TEXT NOT NULL,
        availability TEXT NOT NULL CHECK (availability IN {_in(AGENT_STATES)}),
        pane_state TEXT NOT NULL DEFAULT 'unknown' CHECK (pane_state IN ('unknown', 'alive', 'dead')),
        pane_id TEXT, pane_pid INTEGER, pane_start_time INTEGER, pane_boot_id TEXT,
        capabilities_json TEXT,
        {TS},
        UNIQUE (team_id, ordinal),
        CHECK ((pane_pid IS NULL) = (pane_start_time IS NULL) AND (pane_pid IS NULL) = (pane_boot_id IS NULL)))""",
    f"""CREATE TABLE tasks (
        id {ID},
        team_id TEXT NOT NULL REFERENCES teams(id),
        origin TEXT NOT NULL CHECK (origin IN ('direct', 'workflow')),
        workspace TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN {_in(TASK_STATES)}),
        outcome_json TEXT,
        {TS})""",
    f"""CREATE TABLE workflow_runs (
        id {ID},
        team_id TEXT NOT NULL REFERENCES teams(id),
        task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
        workflow TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN {_in(WORKFLOW_STATES)}),
        current_stage TEXT CHECK (current_stage IS NULL OR current_stage IN {_in(STAGES)}),
        retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
        retry_budget INTEGER NOT NULL DEFAULT 1 CHECK (retry_budget >= 0),
        base_commit TEXT,
        transition_reason TEXT,
        {TS},
        CHECK (retry_count <= retry_budget))""",
    f"""CREATE TABLE stage_attempts (
        id {ID},
        team_id TEXT NOT NULL REFERENCES teams(id),
        workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id),
        stage TEXT NOT NULL CHECK (stage IN {_in(STAGES)}),
        attempt INTEGER NOT NULL CHECK (attempt >= 1),
        status TEXT NOT NULL CHECK (status IN {_in(STAGE_ATTEMPT_STATES)}),
        outcome TEXT,
        artifacts_json TEXT,
        {TS},
        UNIQUE (workflow_run_id, stage, attempt))""",
    f"""CREATE TABLE assignments (
        id {ID},
        team_id TEXT NOT NULL REFERENCES teams(id),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        agent_id TEXT NOT NULL REFERENCES agents(id),
        stage_attempt_id TEXT REFERENCES stage_attempts(id),
        attempt INTEGER NOT NULL CHECK (attempt >= 1),
        policy TEXT NOT NULL CHECK (policy IN {_in(POLICIES)}),
        provider_id TEXT NOT NULL CHECK (provider_id IN {_in(PROVIDERS)}),
        status TEXT NOT NULL CHECK (status IN {_in(ASSIGNMENT_STATES)}),
        process_pid INTEGER, process_start_time INTEGER, process_boot_id TEXT,
        deadline_at TEXT,
        result_json TEXT,
        diagnostic_code TEXT,
        {TS},
        CHECK ((process_pid IS NULL) = (process_start_time IS NULL)
               AND (process_pid IS NULL) = (process_boot_id IS NULL)))""",
    "CREATE INDEX assignments_by_agent ON assignments (agent_id, status)",
    "CREATE INDEX assignments_by_task ON assignments (task_id)",
    "CREATE INDEX tasks_by_team ON tasks (team_id, created_at)",
    "CREATE INDEX agents_by_team ON agents (team_id, ordinal)",
    f"""CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        actor TEXT NOT NULL CHECK (actor IN {_in(ACTORS)}),
        name TEXT NOT NULL,
        entity TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        team_id TEXT, agent_id TEXT, task_id TEXT, assignment_id TEXT, workflow_run_id TEXT,
        command_seq INTEGER REFERENCES commands(seq),
        report_id INTEGER REFERENCES worker_reports(id),
        from_state TEXT,
        to_state TEXT,
        payload_json TEXT NOT NULL)""",
    "CREATE INDEX events_by_team ON events (team_id, seq)",
    f"""CREATE TABLE worker_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        assignment_id TEXT NOT NULL REFERENCES assignments(id),
        report_seq INTEGER NOT NULL CHECK (report_seq >= 0),
        kind TEXT NOT NULL CHECK (kind IN {_in(REPORT_KINDS)}),
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        received_at TEXT NOT NULL,
        UNIQUE (assignment_id, report_seq))""",
    """CREATE TABLE report_applications (
        report_id INTEGER PRIMARY KEY REFERENCES worker_reports(id),
        applied_at TEXT NOT NULL,
        outcome TEXT NOT NULL,
        event_seq INTEGER REFERENCES events(seq))""",
] + _immutable("events") + _immutable("worker_reports") + _immutable("report_applications")

# v3: the immutable request handed to the runner (prompt references, stub settings in debug builds).
MIGRATION_3 = ["ALTER TABLE assignments ADD COLUMN request_json TEXT"]
