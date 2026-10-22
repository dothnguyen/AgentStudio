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
TICKET_KINDS = ("feature", "story", "bug")
TICKET_SEVERITIES = ("blocker", "major", "minor")
TICKET_STATES = ("backlog", "ready_unpack", "unpacking", "unpacked", "done", "refine", "refining",
                 "ready_dev", "in_dev", "ready_test", "in_test", "fail_test", "ready_review", "in_review",
                 "ready_merge", "merged", "changes_requested", "triage", "triaging", "blocked", "cancelled")
TICKET_TERMINAL = ("merged", "done", "cancelled")
TICKET_WORKING = {"unpacking": ("ready_unpack",), "refining": ("refine",), "triaging": ("triage",),
                  "in_dev": ("ready_dev", "fail_test", "changes_requested"), "in_test": ("ready_test",),
                  "in_review": ("ready_review",)}
TICKET_OPERATOR_TARGETS = ("backlog", "ready_unpack", "ready_dev", "ready_test", "ready_review", "refine",
                           "triage", "fail_test", "changes_requested", "blocked")
KIND_STATUSES = {
    "feature": frozenset(("backlog", "ready_unpack", "unpacking", "unpacked", "done", "blocked", "cancelled")),
    "story": frozenset(("backlog", "refine", "refining", "ready_dev", "in_dev", "ready_test", "in_test",
                          "ready_review", "in_review", "ready_merge", "merged", "fail_test", "changes_requested",
                          "blocked", "cancelled")),
    "bug": frozenset(("triage", "triaging", "ready_dev", "in_dev", "ready_test", "in_test", "ready_review",
                        "in_review", "ready_merge", "merged", "fail_test", "changes_requested", "blocked", "cancelled")),
}
_ticket_transitions = set()
for _work, _queues in TICKET_WORKING.items():
    for _queue in _queues:
        _ticket_transitions.update(((_queue, _work, "coordinator"), (_work, _queue, "coordinator")))
_ticket_transitions.update((("unpacking", "unpacked", "coordinator"), ("unpacked", "done", "coordinator"),
    ("refining", "ready_dev", "coordinator"), ("triaging", "ready_dev", "coordinator"),
    ("in_dev", "ready_test", "coordinator"), ("in_test", "ready_review", "coordinator"),
    ("in_test", "fail_test", "coordinator"), ("in_review", "ready_merge", "coordinator"),
    ("in_review", "changes_requested", "coordinator"), ("ready_merge", "merged", "coordinator"),
    ("ready_merge", "changes_requested", "coordinator"), ("backlog", "refine", "coordinator")))
for _to in ("unpacked", "ready_dev", "ready_test", "fail_test", "ready_review", "changes_requested", "ready_merge"):
    _ticket_transitions.add(("blocked", _to, "coordinator"))
for _from in set(TICKET_STATES) - set(TICKET_TERMINAL) - {"blocked"}:
    for _to in TICKET_OPERATOR_TARGETS:
        if _to != _from:
            _ticket_transitions.add((_from, _to, "operator"))
    for _actor in ("coordinator", "operator"):
        _ticket_transitions.update(((_from, "blocked", _actor), (_from, "cancelled", _actor)))
for _actor in ("coordinator", "operator"):
    _ticket_transitions.add(("blocked", "cancelled", _actor))
TICKET_TRANSITIONS = frozenset(_ticket_transitions)

ENTITIES: Dict[str, Entity] = {
    "ticket": Entity("ticket", "tickets", "status", TICKET_STATES,
        frozenset({"backlog", "ready_unpack", "refine", "triage"}),
        _t({s: tuple(t for f, t, _a in TICKET_TRANSITIONS if f == s) +
               (tuple(x for x in TICKET_STATES if x not in TICKET_TERMINAL and x not in TICKET_WORKING)
                if s == "blocked" else ()) for s in TICKET_STATES}),
        ("workspace", "key", "kind", "title", "story_path", "brief_path", "out_dir", "raw_text",
         "attachments_json", "severity", "duplicate_of", "parent_ticket_id", "return_status", "blocked_reason",
         "priority", "branch", "worktree_path", "base_commit", "head_commit", "merged_commit", "assignee_agent_id",
         "lease_until", "run_id", "applied_run_id", "dev_rounds", "test_rounds", "review_rounds", "findings_json",
         "questions_json"), None),
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
         "pane_start_time", "pane_boot_id", "capabilities_json", "model", "reasoning"),
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
         "transition_reason", "developer_agent_id", "reviewer_agent_id", "current_agent_id", "config_json",
         "last_finding", "deadline_at", "definition_name", "definition_json", "definition_sha256", "bindings_json",
         "step_count"),
        "workflow_run_id", ("team_id", "task_id")),
    "stage_attempt": Entity(
        "stage_attempt", "stage_attempts", "status", STAGE_ATTEMPT_STATES, frozenset({"active"}),
        _t({"active": ("completed", "abandoned"), "completed": (), "abandoned": ()}),
        ("team_id", "workflow_run_id", "stage", "attempt", "outcome", "artifacts_json", "agent_id", "assignment_id",
         "phase", "validation_json", "verdict_json", "diff_json", "prompt_path", "stage_type", "visit"),
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

# v4: workflow bookkeeping (P00-S06).
MIGRATION_4 = [
    "ALTER TABLE workflow_runs ADD COLUMN developer_agent_id TEXT REFERENCES agents(id)",
    "ALTER TABLE workflow_runs ADD COLUMN reviewer_agent_id TEXT REFERENCES agents(id)",
    "ALTER TABLE workflow_runs ADD COLUMN current_agent_id TEXT",
    "ALTER TABLE workflow_runs ADD COLUMN config_json TEXT",
    "ALTER TABLE workflow_runs ADD COLUMN last_finding TEXT",
    "ALTER TABLE workflow_runs ADD COLUMN deadline_at TEXT",
    "ALTER TABLE stage_attempts ADD COLUMN agent_id TEXT REFERENCES agents(id)",
    "ALTER TABLE stage_attempts ADD COLUMN assignment_id TEXT REFERENCES assignments(id)",
    "ALTER TABLE stage_attempts ADD COLUMN phase TEXT",
    "ALTER TABLE stage_attempts ADD COLUMN validation_json TEXT",
    "ALTER TABLE stage_attempts ADD COLUMN verdict_json TEXT",
    "ALTER TABLE stage_attempts ADD COLUMN diff_json TEXT",
    "ALTER TABLE stage_attempts ADD COLUMN prompt_path TEXT",
    "CREATE INDEX workflow_runs_by_status ON workflow_runs (status)",
]

# v5: per-agent model and reasoning level (validated by the agent's adapter).
MIGRATION_5 = ["ALTER TABLE agents ADD COLUMN model TEXT", "ALTER TABLE agents ADD COLUMN reasoning TEXT"]


# v6 (P01-S04): workflow_runs and stage_attempts are rebuilt, because SQLite cannot drop the P00 CHECKs on stage names
# and on retry_count <= retry_budget. Stage ids are then checked by the engine against the frozen definition. Every
# row is copied unchanged. state.migrate switches foreign keys off around the transaction (the documented
# SQLite procedure) and this step checks them explicitly before the commit.
_WF_OLD_COLS = ("id, team_id, task_id, workflow, status, current_stage, retry_count, retry_budget, base_commit, "
                "transition_reason, created_at, updated_at, developer_agent_id, reviewer_agent_id, current_agent_id, "
                "config_json, last_finding, deadline_at")
_SA_OLD_COLS = ("id, team_id, workflow_run_id, stage, attempt, status, outcome, artifacts_json, created_at, "
                "updated_at, agent_id, assignment_id, phase, validation_json, verdict_json, diff_json, prompt_path")


def _rebuild_workflow_tables(conn) -> None:
    conn.execute(f"""CREATE TABLE workflow_runs_new (
        id {ID},
        team_id TEXT NOT NULL REFERENCES teams(id),
        task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
        workflow TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN {_in(WORKFLOW_STATES)}),
        current_stage TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
        retry_budget INTEGER NOT NULL DEFAULT 1 CHECK (retry_budget >= 0),
        base_commit TEXT,
        transition_reason TEXT,
        {TS},
        developer_agent_id TEXT REFERENCES agents(id),
        reviewer_agent_id TEXT REFERENCES agents(id),
        current_agent_id TEXT,
        config_json TEXT,
        last_finding TEXT,
        deadline_at TEXT,
        definition_name TEXT,
        definition_json TEXT,
        definition_sha256 TEXT,
        bindings_json TEXT,
        step_count INTEGER NOT NULL DEFAULT 0 CHECK (step_count >= 0))""")
    conn.execute(f"INSERT INTO workflow_runs_new ({_WF_OLD_COLS}) SELECT {_WF_OLD_COLS} FROM workflow_runs")
    conn.execute(f"""CREATE TABLE stage_attempts_new (
        id {ID},
        team_id TEXT NOT NULL REFERENCES teams(id),
        workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id),
        stage TEXT NOT NULL,
        attempt INTEGER NOT NULL CHECK (attempt >= 1),
        status TEXT NOT NULL CHECK (status IN {_in(STAGE_ATTEMPT_STATES)}),
        outcome TEXT,
        artifacts_json TEXT,
        {TS},
        agent_id TEXT REFERENCES agents(id),
        assignment_id TEXT REFERENCES assignments(id),
        phase TEXT,
        validation_json TEXT,
        verdict_json TEXT,
        diff_json TEXT,
        prompt_path TEXT,
        stage_type TEXT,
        visit INTEGER,
        UNIQUE (workflow_run_id, stage, attempt))""")
    conn.execute(f"INSERT INTO stage_attempts_new ({_SA_OLD_COLS}) SELECT {_SA_OLD_COLS} FROM stage_attempts")
    conn.execute("DROP TABLE stage_attempts")
    conn.execute("DROP TABLE workflow_runs")
    conn.execute("ALTER TABLE workflow_runs_new RENAME TO workflow_runs")
    conn.execute("ALTER TABLE stage_attempts_new RENAME TO stage_attempts")
    conn.execute("CREATE INDEX workflow_runs_by_status ON workflow_runs (status)")
    bad = conn.execute("PRAGMA foreign_key_check").fetchall()
    if bad:
        raise RuntimeError(f"migration 6 broke {len(bad)} foreign key(s): {[tuple(r) for r in bad[:5]]}")


MIGRATION_6 = [_rebuild_workflow_tables]


def _check_ticket_foreign_keys(conn) -> None:
    bad = conn.execute("PRAGMA foreign_key_check").fetchall()
    if bad:
        raise RuntimeError(f"migration 7 broke {len(bad)} foreign key(s): {[tuple(r) for r in bad[:5]]}")


MIGRATION_7 = [
    f"""CREATE TABLE tickets (
        id {ID}, workspace TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN {_in(TICKET_KINDS)}),
        title TEXT NOT NULL, story_path TEXT, brief_path TEXT, out_dir TEXT, raw_text TEXT, attachments_json TEXT,
        severity TEXT CHECK (severity IS NULL OR severity IN {_in(TICKET_SEVERITIES)}), duplicate_of TEXT,
        parent_ticket_id TEXT REFERENCES tickets(id), status TEXT NOT NULL CHECK (status IN {_in(TICKET_STATES)}),
        return_status TEXT, blocked_reason TEXT, priority INTEGER NOT NULL DEFAULT 100, branch TEXT, worktree_path TEXT,
        base_commit TEXT, head_commit TEXT, merged_commit TEXT, assignee_agent_id TEXT REFERENCES agents(id), lease_until TEXT,
        run_id TEXT REFERENCES workflow_runs(id), applied_run_id TEXT REFERENCES workflow_runs(id),
        dev_rounds INTEGER NOT NULL DEFAULT 0, test_rounds INTEGER NOT NULL DEFAULT 0, review_rounds INTEGER NOT NULL DEFAULT 0,
        findings_json TEXT, questions_json TEXT, {TS},
        CHECK ((status = 'blocked') = (return_status IS NOT NULL)))""",
    "CREATE UNIQUE INDEX tickets_key ON tickets (workspace, key)",
    "CREATE INDEX tickets_by_workspace_status ON tickets (workspace, status)",
    """CREATE TABLE ticket_deps (
        ticket_id TEXT NOT NULL REFERENCES tickets(id), blocked_by_ticket_id TEXT NOT NULL REFERENCES tickets(id),
        PRIMARY KEY (ticket_id, blocked_by_ticket_id), CHECK (ticket_id <> blocked_by_ticket_id))""",
    """CREATE TABLE ticket_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL REFERENCES tickets(id),
        event_seq INTEGER NOT NULL REFERENCES events(seq), at TEXT NOT NULL, actor TEXT NOT NULL,
        name TEXT NOT NULL, from_status TEXT, to_status TEXT, payload_json TEXT NOT NULL)""",
    """CREATE TABLE board_state (workspace TEXT PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('running','paused')),
        reason TEXT, config_json TEXT, review_streak INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)""",
    """CREATE TABLE board_locks (workspace TEXT NOT NULL, name TEXT NOT NULL, ticket_id TEXT REFERENCES tickets(id),
        created_at TEXT NOT NULL, PRIMARY KEY (workspace, name))""",
] + _immutable("ticket_events") + [_check_ticket_foreign_keys]
