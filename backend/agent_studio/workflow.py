"""The workflow engine (P00-S06, generalised by P01-S04..S06).

Every run executes a frozen definition (workflowdef.py): an ordered list of agent and validation stages whose outcomes
route to the next stage. P00's Developer -> Reviewer workflow is the built-in definition `developer-reviewer`.

The coordinator advances runs from durable state only (assignment rows, validation result files); it never reads
panes, and it has no role names, stage ids, or provider-specific branches. Outcomes (design contract section D):

  agent stage succeeded: work stage -> done; verdict stage -> pass / fail (a pass whose passRequires did not pass
                         becomes fail); missing or malformed verdict -> paused
  agent stage failed / inconclusive / waiting / reconciling -> paused with its diagnostic code
  validation exit 0 / nonzero or timeout -> pass / fail; could not run -> paused; process lost -> paused
  any cancelled stage, or an operator cancel -> cancelled
  a run with no frozen definition (started by P00 before the upgrade) -> paused LEGACY_WORKFLOW_RUN, cancel only
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

from . import crashpoints, gitws, procid, prompts, tasks, validation, workflowdef
from .protocol import AsError, BAD_REQUEST
from .providers.base import valid_verdict
from .state import utcnow
from .store import NOT_FOUND, Store, Tx
from .textsafe import terminal_safe

ACTIVE = ("queued", "running", "paused")
SAME_AGENT = "SAME_AGENT"
ROLE_UNBOUND = "ROLE_UNBOUND"
ROLE_AMBIGUOUS = "ROLE_AMBIGUOUS"
LEGACY_WORKFLOW_RUN = "LEGACY_WORKFLOW_RUN"
BUILTIN_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "workflows")
# The P00 command form (developerAgentId / reviewerAgentId) maps onto this built-in definition and its two roles.
# This constant is the only place in the engine that names them; the guard test exempts it.
P00_FORM = ("developer-reviewer", "Developer", "Reviewer")


# ---- helpers ----------------------------------------------------------------------------------------

def workflow_dir(state_dir: str, wf_id: str) -> str:
    return os.path.join(state_dir, "workflows", wf_id)


def _read(path: Optional[str], limit: int = 512 * 1024) -> str:
    if not path:
        return ""
    try:
        with open(path, "rb") as f:
            return f.read(limit).decode("utf-8", "replace")
    except OSError:
        return ""


def _write_private(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(text.encode("utf-8"))


def _validation_text(val: dict) -> str:
    if val.get("error"):
        return f"Validation could not run: {val['error']}"
    head = validation.output_head(val.get("outputPath", ""), 32 * 1024)
    status = "PASSED" if val.get("passed") else ("TIMED OUT" if val.get("timedOut") else f"FAILED (exit {val.get('exitCode')})")
    return f"Validation {status}.\n{head}"


def _loads(text, default=None):
    return json.loads(text) if text else default


def _cancel_requested(tx: Tx, wf_id: str) -> bool:
    return tx.conn.execute("SELECT 1 FROM events WHERE entity = 'workflow_run' AND entity_id = ? "
                           "AND name = 'workflow_run.cancel_requested' LIMIT 1", (wf_id,)).fetchone() is not None


def _current_attempt(tx: Tx, wf_id: str) -> Optional[dict]:
    row = tx.conn.execute("SELECT * FROM stage_attempts WHERE workflow_run_id = ? AND status = 'active' "
                          "ORDER BY created_at DESC, rowid DESC LIMIT 1", (wf_id,)).fetchone()
    return dict(row) if row else None


# ---- start ------------------------------------------------------------------------------------------

def is_definition_run(wf: dict) -> bool:
    """P00 runs have no frozen definition and keep the DEV_STAGES / POLICY lookups."""
    return wf.get("definition_json") is not None


def frozen_definition(wf: dict) -> "workflowdef.Definition":
    """The definition a run was started with. Read only through from_json, never parse_obj."""
    return workflowdef.from_json(json.loads(wf["definition_json"]))


class ReadTx:
    """The two read methods bind_roles needs, over a reader connection (workflow.validate binds without writing)."""

    def __init__(self, conn):
        self.conn = conn

    def get(self, entity: str, entity_id: str) -> dict:
        from . import schema
        row = self.conn.execute(f"SELECT * FROM {schema.ENTITIES[entity].table} WHERE id = ?", (entity_id,)).fetchone()
        if row is None:
            raise AsError(NOT_FOUND, f"{entity} {entity_id} does not exist.")
        return dict(row)


def bind_roles(tx: Tx, team: dict, definition: "workflowdef.Definition", overrides: dict, ctx: dict,
               check_providers: bool = True) -> dict:
    """One agent per distinct role of the definition: the roster `role` (exactly one match), or an override.
    Returns {role: agent row}, roles in stage order. Rejects before anything is written. workflow.validate passes
    check_providers=False: the provider mapping is verified by the coordinator when the run starts."""
    roles, perms = [], {}
    for st in definition.stages:
        if st.type != "agent":
            continue
        if st.role not in perms:
            roles.append(st.role)
            perms[st.role] = []
        if st.permission not in perms[st.role]:
            perms[st.role].append(st.permission)
    unknown = sorted(set(overrides) - set(roles))
    if unknown:
        raise AsError(BAD_REQUEST, f"bindings name role(s) the definition does not use: {unknown}.")
    team_agents = [dict(r) for r in tx.conn.execute(
        "SELECT * FROM agents WHERE team_id = ? ORDER BY ordinal", (team["id"],)).fetchall()]
    bound = {}
    for role in roles:
        if role in overrides:
            try:
                a = tx.get("agent", overrides[role])
            except AsError:
                raise AsError(NOT_FOUND, f"Agent {overrides[role]} (bound to {role}) does not exist.")
            if a["team_id"] != team["id"]:
                raise AsError(tasks.AGENT_NOT_IN_TEAM, f"Agent {a['id']} (bound to {role}) is not in team {team['id']}.")
        else:
            matches = [x for x in team_agents if x["role"] == role]
            if not matches:
                raise AsError(ROLE_UNBOUND, f"No agent in team {team['id']} has the role {role!r}.",
                              data={"role": role}, remediation=f"Add an agent with role {role!r} or pass --bind "
                                                               f"{role}=<agent id>.")
            if len(matches) > 1:
                raise AsError(ROLE_AMBIGUOUS, f"{len(matches)} agents have the role {role!r}.",
                              data={"role": role, "agentIds": [m["id"] for m in matches]},
                              remediation=f"Pass --bind {role}=<agent id>.")
            a = matches[0]
        bound[role] = a
    seen = {}
    for role, a in bound.items():
        if a["id"] in seen:
            raise AsError(SAME_AGENT, f"Roles {seen[a['id']]!r} and {role!r} are bound to the same agent; a role's "
                                      "work is never reviewed by the agent that did it.",
                          data={"roles": [seen[a["id"]], role], "agentId": a["id"]})
        seen[a["id"]] = role
    for role, a in bound.items():
        if a["availability"] in ("offline", "error", "limit_reached") or a["pane_state"] != "alive":
            raise AsError(tasks.AGENT_UNAVAILABLE, f"{role} agent {a['display_name']} is {a['availability']}.")
        if not check_providers:
            continue
        adapter, _ = tasks.adapter_for(a, ctx)
        for policy in perms[role]:
            if adapter.describe(dict(os.environ))["policies"].get(policy) in (None, "unsupported"):
                raise AsError(tasks.POLICY_UNSUPPORTED, f"{role} agent's provider {a['provider_id']} has no "
                                                        f"verified mapping for {policy}.")
    return bound


def _start_definition(tx: Tx, args: dict, ctx: dict) -> dict:
    team = tx.get("team", args["teamId"])
    if team["status"] != "running":
        raise AsError(tasks.TEAM_NOT_RUNNING, f"Team {team['id']} is {team['status']}.")
    ws = tasks.run_workspace(tx, team, args.get("workspace"))
    definition = workflowdef.load(ws, args["definition"], BUILTIN_DIR)
    first = definition.stages[0]
    bound = bind_roles(tx, team, definition, args.get("bindings") or {}, ctx)
    base = gitws.require_repo(ws)
    dirty = gitws.dirty_entries(ws)
    if dirty and not (ctx["debug"] and args.get("allowDirtyTree")):
        raise AsError(gitws.WORKSPACE_DIRTY, f"The workspace has {len(dirty)} uncommitted change(s); the workflow "
                                             "needs a clean starting commit.", data={"entries": dirty[:20]},
                      remediation="Commit or stash your changes first (definition files and prompts included).")
    config = validation.load_config(ws)
    holder = tasks._mutating_in_workspace(tx, ws)
    if holder:
        raise AsError(tasks.WORKSPACE_BUSY, f"The workspace already has active mutating work ({holder}).")
    if args.get("debugStageOptions"):
        if not ctx["debug"]:
            raise AsError(BAD_REQUEST, "debugStageOptions is only accepted by debug coordinators.")
        config["debugStageOptions"] = args["debugStageOptions"]
    deadline = (datetime.now(timezone.utc) + timedelta(milliseconds=config["workflowDeadlineMs"])
                ).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    bindings = {role: a["id"] for role, a in bound.items()}
    task = tx.create("task", {"team_id": team["id"], "origin": "workflow", "workspace": ws, "goal": args["text"]})
    tx.transition("task", task, "assigned")
    tx.transition("task", task, "running")
    wf = tx.create("workflow_run", {"team_id": team["id"], "task_id": task, "workflow": "definition",
                                    "retry_budget": 0, "retry_count": 0, "base_commit": base, "config_json": config,
                                    "deadline_at": deadline, "definition_name": definition.name,
                                    "definition_json": workflowdef.to_json(definition),
                                    "definition_sha256": definition.source_sha256, "bindings_json": bindings,
                                    "step_count": 1},
                   payload={"baseCommit": base, "validationArgv": config["validation"]["argv"],
                            "definition": definition.name, "definitionSha256": definition.source_sha256,
                            "bindings": bindings})
    tx.transition("workflow_run", wf, "running", set_values={"transition_reason": "started"})
    if first.kind == "verdict":
        tx.transition("task", task, "review")
    seed = args.get("seed", {})
    asg = _enter(tx, wf, first.id, ctx, None, seed)
    return {"receipt": "accepted", "workflowRunId": wf, "taskId": task, "baseCommit": base,
            "definition": definition.name, "definitionSha256": definition.source_sha256, "bindings": bindings,
            "assignmentId": asg, "validationArgv": config["validation"]["argv"]}




def start(tx: Tx, args: dict, ctx: dict) -> dict:
    """workflow.start. The P00 form (developerAgentId / reviewerAgentId) runs the built-in definition with those two
    agents bound directly, so P00 teams keep working whatever their role names are."""
    if args.get("definition"):
        return _start_definition(tx, args, ctx)
    dev, rev = args["developerAgentId"], args["reviewerAgentId"]
    if dev == rev:
        raise AsError(SAME_AGENT, "developerAgentId and reviewerAgentId must be two different agents.")
    name, dev_role, rev_role = P00_FORM
    out = _start_definition(tx, dict(args, definition=name, bindings={dev_role: dev, rev_role: rev}), ctx)
    return dict(out, developerAgentId=dev, reviewerAgentId=rev)


def _visit(tx: Tx, wf_id: str, stage: str, new_visit: bool) -> tuple:
    """(attempt, visit, n): the attempt number within the stage, its visit, and its position in the run. A routed entry
    is a new visit; a resolve-retry of the same stage repeats the visit it was on."""
    n = tx.conn.execute("SELECT COUNT(*) FROM stage_attempts WHERE workflow_run_id = ?", (wf_id,)).fetchone()[0] + 1
    attempt = tx.conn.execute("SELECT COUNT(*) FROM stage_attempts WHERE workflow_run_id = ? AND stage = ?",
                              (wf_id, stage)).fetchone()[0] + 1
    prior = tx.conn.execute("SELECT COALESCE(MAX(visit), 0) FROM stage_attempts WHERE workflow_run_id = ? AND stage = ?",
                            (wf_id, stage)).fetchone()[0]
    return attempt, (prior + 1 if new_visit or prior == 0 else prior), n


def _enter(tx: Tx, wf_id: str, stage: str, ctx: dict, from_assignment: Optional[str], data: dict) -> Optional[str]:
    """Enter a stage by routing: an agent stage gets an assignment (its ID is returned), a validation stage starts
    the validator."""
    st = _stage_of(tx.get("workflow_run", wf_id), stage)
    if st.type == "validation":
        _enter_validation(tx, wf_id, st, ctx, from_assignment)
        return None
    return _dispatch(tx, wf_id, stage, None, ctx, from_assignment, data=data, new_visit=True)


def _enter_validation(tx: Tx, wf_id: str, st: "workflowdef.Stage", ctx: dict, from_assignment: Optional[str]) -> None:
    wf = tx.get("workflow_run", wf_id)
    attempt, visit, n = _visit(tx, wf_id, st.id, True)
    sdir = os.path.join(workflow_dir(ctx["stateDir"], wf_id), f"{n:02d}-{st.id}")
    marker = os.path.join(sdir, "stage.txt")
    _write_private(marker, f"validation stage {st.id}, visit {visit}\n")
    proc = validation.spawn(sdir, wf_workspace(tx, wf), _loads(wf["config_json"], {}))
    crashpoints.hit("after_validator_spawn")
    sa = tx.create("stage_attempt", {"team_id": wf["team_id"], "workflow_run_id": wf_id, "stage": st.id,
                                     "attempt": attempt, "phase": "validating", "prompt_path": marker,
                                     "stage_type": "validation", "visit": visit,
                                     "validation_json": {"state": "running", "process": proc}},
                   event="stage_attempt.validating",
                   payload={"stage": st.id, "visit": visit, "sourceAssignmentId": from_assignment})
    tx.update("workflow_run", wf_id, {"current_stage": st.id, "current_agent_id": None}, "workflow_run.stage_entered",
              {"toStage": st.id, "type": "validation", "stageAttemptId": sa, "fromAssignmentId": from_assignment})


def _dispatch(tx: Tx, wf_id: str, stage: str, prompt: Optional[str], ctx: dict, from_assignment: Optional[str],
              provider_options: Optional[dict] = None, data: Optional[dict] = None,
              new_visit: bool = False) -> str:
    """Create the stage attempt and its assignment. Routing passes prompt=None and `data` (diff, validation, findings,
    summary) and the frozen template is rendered here; a resolve-retry passes the earlier prompt text."""
    wf = tx.get("workflow_run", wf_id)
    config = _loads(wf["config_json"], {})
    st = _stage_of(wf, stage)
    agent_id = _loads(wf["bindings_json"], {})[st.role]
    policy = st.permission
    agent = tx.get("agent", agent_id)
    attempt, visit, n = _visit(tx, wf_id, stage, new_visit)
    if prompt is None:
        prompt = prompts.render(st.prompt, kind=st.kind, task=tx.get("task", wf["task_id"])["goal"],
                                stage=stage, visit=visit, **(data or {}))
    sdir = os.path.join(workflow_dir(ctx["stateDir"], wf_id), f"{n:02d}-{stage}")
    prompt_path = os.path.join(sdir, "prompt.txt")
    _write_private(prompt_path, prompt)
    sa = tx.create("stage_attempt", {"team_id": wf["team_id"], "workflow_run_id": wf_id, "stage": stage,
                                     "attempt": attempt, "agent_id": agent_id, "phase": "assignment",
                                     "prompt_path": prompt_path, "stage_type": "agent", "visit": visit})
    adapter, alias = tasks.adapter_for(agent, ctx)
    request = tasks.build_request(agent, tx.get("task", wf["task_id"])["workspace"],
                                  {"promptFile": prompt_path, "deadlineMs": config.get("stageDeadlineMs"),
                                   "workflowRunId": wf_id, "stage": stage,
                                   "expectsVerdict": st.kind == "verdict",
                                   "mcpWorkspace": tx.get("team", wf["team_id"])["workspace"]})
    stage_opts = provider_options or (config.get("debugStageOptions") or {}).get(stage)
    if isinstance(stage_opts, list):   # debug only: one option set per visit, the last one repeats
        stage_opts = stage_opts[min(visit, len(stage_opts)) - 1] if stage_opts else None
    if stage_opts and ctx["debug"] and getattr(adapter, "test_only", False):
        request["providerOptions"] = stage_opts
    if alias:
        request["fixtureAdapter"] = alias
    asg = tx.create("assignment", {"team_id": wf["team_id"], "task_id": wf["task_id"], "agent_id": agent_id,
                                   "stage_attempt_id": sa, "attempt": attempt, "policy": policy,
                                   "provider_id": agent["provider_id"], "request_json": request},
                    payload=tasks._request_summary(request))
    tx.update("stage_attempt", sa, {"assignment_id": asg}, "stage_attempt.dispatched",
              {"assignmentId": asg, "policy": policy})
    tx.update("workflow_run", wf_id, {"current_stage": stage, "current_agent_id": agent_id}, "workflow_run.handoff",
              {"toStage": stage, "toAssignmentId": asg, "agentId": agent_id, "providerId": agent["provider_id"],
               "fromAssignmentId": from_assignment})
    return asg


# ---- advancing --------------------------------------------------------------------------------------

def _advance_one(tx: Tx, wf_id: str, ctx: dict) -> bool:
    wf = tx.get("workflow_run", wf_id)
    sa = _current_attempt(tx, wf_id)
    if wf["deadline_at"] and wf["deadline_at"] < utcnow():
        _stop_active(tx, wf, sa, ctx)
        _end(tx, wf, "failed", "workflow deadline reached")
        return True
    cancel = _cancel_requested(tx, wf_id)
    if not is_definition_run(wf):
        return _legacy_run(tx, wf, sa, cancel)
    if sa is None:
        return False
    if sa["phase"] == "validating":
        return _advance_validation(tx, wf, sa, ctx, cancel)
    return _advance_definition(tx, wf, sa, ctx, cancel)


def _legacy_run(tx: Tx, wf: dict, sa: Optional[dict], cancel: bool) -> bool:
    """Q8: a run P00 started before the upgrade is never killed or silently failed. Once its current assignment or
    validator is over it pauses, and then only workflow.cancel is accepted."""
    if sa is not None and sa["phase"] == "assignment" and sa["assignment_id"]:
        if tx.get("assignment", sa["assignment_id"])["status"] in ("queued", "claimed", "running"):
            return False
    elif sa is not None and sa["phase"] == "validating":
        val = (_loads(sa["validation_json"], {}) or {}).get("process") or {}
        if validation.result(os.path.dirname(sa["prompt_path"])) is None and procid.matches(val):
            return False
    if cancel:
        _end(tx, wf, "cancelled", "cancelled by the operator")
    else:
        _pause(tx, wf, sa, "this run was started before the upgrade and cannot continue; cancel it",
               LEGACY_WORKFLOW_RUN)
    return True


def _prev_assignment(tx: Tx, wf_id: str) -> Optional[str]:
    row = tx.conn.execute("SELECT assignment_id FROM stage_attempts WHERE workflow_run_id = ? AND assignment_id "
                          "IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1", (wf_id,)).fetchone()
    return row[0] if row else None


def _latest_result(tx: Tx, wf_id: str, stage: Optional[str] = None) -> Optional[dict]:
    """The newest completed validation result of the run (or of one validation stage)."""
    sql = ("SELECT validation_json FROM stage_attempts WHERE workflow_run_id = ? AND stage_type = 'validation' "
           "AND status = 'completed'" + (" AND stage = ?" if stage else "") + " ORDER BY created_at DESC, rowid DESC")
    row = tx.conn.execute(sql, (wf_id, stage) if stage else (wf_id,)).fetchone()
    return _loads(row[0], None) if row else None


def _last_summary(tx: Tx, wf_id: str) -> str:
    for row in tx.conn.execute("SELECT artifacts_json FROM stage_attempts WHERE workflow_run_id = ? AND artifacts_json "
                               "IS NOT NULL ORDER BY created_at DESC, rowid DESC", (wf_id,)).fetchall():
        text = (_loads(row[0], {}) or {}).get("summary")
        if text:
            return text
    return ""


def _advance_validation(tx: Tx, wf: dict, sa: dict, ctx: dict, cancel: bool) -> bool:
    sdir = os.path.dirname(sa["prompt_path"])
    val_state = _loads(sa["validation_json"], {}) or {}
    res = validation.result(sdir)
    if res is None:
        if procid.matches(val_state.get("process") or {}) and not cancel:
            crashpoints.hit("while_validating")
            return False
        res = validation.result(sdir)
        if res is None:
            if cancel:
                _kill(val_state.get("process"))
                _end(tx, wf, "cancelled", "cancelled by the operator")
            else:
                _pause(tx, wf, sa, "the validation process ended without a result", "VALIDATION_LOST")
            return True
    res["outputHead"] = validation.output_head(res.get("outputPath", ""), 2000)
    source = _prev_assignment(tx, wf["id"])
    tx.update("stage_attempt", sa["id"], {"phase": "done", "validation_json": dict(res, state="done"),
                                          "outcome": "validation_" + ("passed" if res["passed"] else "failed")},
              "stage_attempt.validated", {"stage": sa["stage"], "sourceAssignmentId": source, "passed": res["passed"],
                                          "exitCode": res.get("exitCode"), "timedOut": res.get("timedOut"),
                                          "error": res.get("error")})
    tx.transition("stage_attempt", sa["id"], "completed")
    if cancel:
        _end(tx, wf, "cancelled", "cancelled by the operator")
    elif res.get("error"):
        _pause(tx, wf, None, f"validation could not run: {res['error']}", "VALIDATION_ERROR")
    else:
        _route(tx, tx.get("workflow_run", wf["id"]), _stage_of(wf, sa["stage"]), "pass" if res["passed"] else "fail",
               None, source, ctx)
    return True


# ---- routing ----------------------------------------------------------------------------------------

def _advance_definition(tx: Tx, wf: dict, sa: dict, ctx: dict, cancel: bool) -> bool:
    """One finished agent stage of a definition run: outcome, diff, then routing (design contract section D)."""
    a = tx.get("assignment", sa["assignment_id"])
    if a["status"] in ("queued", "claimed", "running"):
        return False
    result = _loads(a["result_json"], {}) or {}
    if a["status"] == "cancelled" or cancel:
        _end(tx, wf, "cancelled", "cancelled by the operator" if cancel else f"{sa['stage']} assignment cancelled")
        return True
    st = _stage_of(wf, sa["stage"])
    verdict = None
    if st.kind == "verdict" and a["status"] in ("succeeded", "reconciling"):
        verdict = result.get("verdict") if a["status"] == "succeeded" else None
        if not valid_verdict(verdict):
            _pause(tx, wf, sa, f"{sa['stage']} verdict missing or malformed",
                   result.get("diagnosticCode") or "MALFORMED_VERDICT")
            return True
    if a["status"] != "succeeded":
        _pause(tx, wf, sa, f"{sa['stage']} {a['status']}", result.get("diagnosticCode"))
        return True
    findings = None
    if st.kind == "verdict":
        outcome = verdict["verdict"]
        findings = [str(f)[:2000] for f in verdict.get("findings", [])][:50]
        if outcome == "pass":   # a pass counts only if every validation stage it depends on passed
            for ref in st.pass_requires:
                got = _latest_result(tx, wf["id"], ref)
                if not got or not got.get("passed"):
                    outcome = "fail"
                    findings = [f"{ref} did not pass"] + findings
    else:
        outcome = "done"
    values = {"outcome": outcome if verdict else "done", "phase": "done",
              "artifacts_json": {"summary": str(result.get("finalText") or result.get("summary") or "")[:16 * 1024]}}
    if st.permission == "workspace_write":
        diff = gitws.capture_diff(wf_workspace(tx, wf), wf["base_commit"], os.path.dirname(sa["prompt_path"]))
        values["diff_json"] = diff
    if verdict:
        values["verdict_json"] = {"verdict": outcome, "findings": findings, "agentVerdict": verdict["verdict"]}
        values["outcome"] = f"verdict_{outcome}"
    tx.update("stage_attempt", sa["id"], values, "stage_attempt.verdict" if verdict else "stage_attempt.completed",
              {"sourceAssignmentId": a["id"], "stage": sa["stage"], "outcome": outcome,
               **({"verdict": outcome, "findings": findings[:10]} if verdict else {}),
               **({"diffPath": values["diff_json"]["path"], "diffBytes": values["diff_json"]["bytes"],
                   "changedFiles": values["diff_json"]["changedFiles"][:20],
                   "untrackedFiles": values["diff_json"]["untrackedFiles"][:20]} if "diff_json" in values else {})})
    tx.transition("stage_attempt", sa["id"], "completed")
    crashpoints.hit("after_verdict_before_route")
    _route(tx, tx.get("workflow_run", wf["id"]), st, outcome, findings, a["id"], ctx)
    return True


def _route(tx: Tx, wf: dict, st: "workflowdef.Stage", outcome: str, findings: Optional[list],
           source_asg: Optional[str], ctx: dict) -> None:
    d = frozen_definition(wf)
    target = st.next[outcome]
    finding = (findings[0] if findings else None)
    base = {"fromStage": st.id, "outcome": outcome, "sourceAssignmentId": source_asg}
    values = {"step_count": wf["step_count"]}
    if finding:
        values["last_finding"] = finding
    if target in (workflowdef.SUCCEED, workflowdef.FAIL):
        tx.update("workflow_run", wf["id"], values, "workflow_run.routed",
                  dict(base, toStage=target, reason=f"{st.id} {outcome}"))
        _end(tx, tx.get("workflow_run", wf["id"]), "succeeded" if target == workflowdef.SUCCEED else "failed",
             f"{st.id} {outcome}")
        return
    nxt = next(x for x in d.stages if x.id == target)
    visits = tx.conn.execute("SELECT COALESCE(MAX(visit), 0) FROM stage_attempts WHERE workflow_run_id = ? AND stage = ?",
                             (wf["id"], target)).fetchone()[0]
    limit = None
    if wf["step_count"] + 1 > d.max_steps:
        limit = f"step limit {d.max_steps} reached"
    elif visits >= nxt.max_visits:
        limit = f"{target} visit limit {nxt.max_visits} reached"
    if limit:
        tx.update("workflow_run", wf["id"], values, "workflow_run.routed",
                  dict(base, toStage=workflowdef.FAIL, reason=limit, wouldEnter=target))
        _end(tx, tx.get("workflow_run", wf["id"]), "failed", limit)
        return
    values["step_count"] = wf["step_count"] + 1
    tx.update("workflow_run", wf["id"], values, "workflow_run.routed",
              dict(base, toStage=target, reason=f"{st.id} {outcome} -> {target}", step=values["step_count"]))
    if st.kind == "verdict" and outcome == "fail":   # a failed verdict sends work back: that is a repair round
        tx.update("workflow_run", wf["id"], {"retry_count": wf["retry_count"] + 1,
                                             "transition_reason": f"{target} entered after {st.id} {outcome}"},
                  "workflow_run.repair_requested",
                  {"reason": f"{st.id} {outcome}", "findings": (findings or [])[:10], "toStage": target,
                   "sourceAssignmentId": source_asg})
    task = tx.get("task", wf["task_id"])
    want = "review" if nxt.kind == "verdict" else "running"
    if task["status"] != want:
        tx.transition("task", task["id"], want)
    crashpoints.hit("before_route_commit")
    latest = _latest_result(tx, wf["id"])
    data = {"diff": _latest_diff_text(tx, wf["id"]), "findings": findings, "summary": _last_summary(tx, wf["id"]),
            "validation": _validation_text(latest) if latest else None}
    _enter(tx, wf["id"], target, ctx, source_asg, data)


# ---- run lifecycle ----------------------------------------------------------------------------------

def advance(store: Store, ctx: dict) -> int:
    rows = store.conn.execute("SELECT id FROM workflow_runs WHERE status = 'running'").fetchall()
    n = 0
    for r in rows:
        try:
            with store.transaction() as tx:
                changed = _advance_one(tx, r["id"], ctx)
            if changed:
                n += 1
                crashpoints.hit("after_advance_commit")
        except AsError as e:  # e.g. git failed: pause with the reason instead of retrying forever
            with store.transaction() as tx:
                wf = tx.get("workflow_run", r["id"])
                if wf["status"] == "running":
                    _pause(tx, wf, None, f"{e.code}: {e.message}", e.code)
    return n


def _stage_of(wf: dict, stage_id: str) -> "workflowdef.Stage":
    return next(x for x in frozen_definition(wf).stages if x.id == stage_id)


def _latest_diff_text(tx: Tx, wf_id: str) -> Optional[str]:
    """The newest captured diff of the run (the workspace_write stage that ran last), or None before any."""
    for row in tx.conn.execute("SELECT diff_json FROM stage_attempts WHERE workflow_run_id = ? AND diff_json IS NOT NULL "
                               "ORDER BY created_at DESC, rowid DESC", (wf_id,)).fetchall():
        diff = _loads(row["diff_json"], {}) or {}
        if diff.get("path"):
            return _read(diff["path"])
    return None


def wf_workspace(tx: Tx, wf: dict) -> str:
    return tx.get("task", wf["task_id"])["workspace"]


def _pause(tx: Tx, wf: dict, sa: Optional[dict], reason: str, code: Optional[str]) -> None:
    tx.transition("workflow_run", wf["id"], "paused", set_values={"transition_reason": reason},
                  payload={"reason": reason, "diagnosticCode": code, "stage": sa["stage"] if sa else None,
                           "assignmentId": sa["assignment_id"] if sa else None})


def _end(tx: Tx, wf: dict, status: str, reason: str) -> None:
    for row in tx.conn.execute("SELECT id FROM stage_attempts WHERE workflow_run_id = ? AND status = 'active'",
                               (wf["id"],)).fetchall():
        tx.transition("stage_attempt", row["id"], "abandoned", payload={"reason": reason})
    tx.transition("workflow_run", wf["id"], status, set_values={"transition_reason": reason, "current_agent_id": None},
                  payload={"reason": reason})
    task = tx.get("task", wf["task_id"])
    if task["status"] != status:
        tx.transition("task", task["id"], status, payload={"reason": reason})


def _kill(proc: Optional[dict]) -> None:
    import signal
    if proc and procid.matches(proc):
        try:
            os.killpg(proc["pid"], signal.SIGTERM)
        except ProcessLookupError:
            pass


def _stop_active(tx: Tx, wf: dict, sa: Optional[dict], ctx: dict) -> None:
    if not sa:
        return
    if sa["phase"] == "validating":
        _kill((_loads(sa["validation_json"], {}) or {}).get("process"))
    elif sa["assignment_id"]:
        a = tx.get("assignment", sa["assignment_id"])
        if a["status"] in tasks.ACTIVE:
            tasks.assignment_cancel(tx, {"assignmentId": a["id"]}, ctx)


def _retry_run(tx: Tx, args: dict) -> dict:
    wf = tx.get("workflow_run", args["workflowRunId"])
    if not is_definition_run(wf):
        raise AsError(LEGACY_WORKFLOW_RUN, "This run was started before the upgrade and can only be cancelled.",
                      remediation=f"agent-studio workflow cancel --workflow {wf['id']}")
    return wf


def retry(tx: Tx, args: dict, ctx: dict) -> dict:
    """Run the current stage again with its original prompt: the way out for a stage that is waiting_input,
    reconciling, or ended in a state the engine paused on (same rules as assignment.resolve --action retry)."""
    from . import resolve
    wf = _retry_run(tx, args)
    sa = _current_attempt(tx, wf["id"])
    if wf["status"] in ("succeeded", "failed", "cancelled") or sa is None or not sa["assignment_id"]:
        raise AsError(resolve.RESOLVE_NOT_ALLOWED, f"The run is {wf['status']} and has no stage to retry.")
    a = tx.get("assignment", sa["assignment_id"])
    r = resolve.resolve(tx, dict({"assignmentId": a["id"], "action": "retry"},
                                 **({"debugProviderOptions": args["debugProviderOptions"]}
                                    if args.get("debugProviderOptions") is not None else {})), ctx)
    return dict(r, workflowRunId=wf["id"])


def cancel(tx: Tx, args: dict, ctx: dict) -> dict:
    wf = tx.get("workflow_run", args["workflowRunId"])
    out = {"workflowRunId": wf["id"], "previousStatus": wf["status"]}
    if wf["status"] in ("succeeded", "failed", "cancelled"):
        return dict(out, outcome="already_finished", status=wf["status"])
    sa = _current_attempt(tx, wf["id"])
    if wf["status"] == "running" and sa and sa["phase"] == "assignment":
        a = tx.get("assignment", sa["assignment_id"])
        r = tasks.assignment_cancel(tx, {"assignmentId": a["id"]}, ctx)
        if r["outcome"] in ("cancel_requested", "finishing"):
            tx.note("workflow_run", wf["id"], "workflow_run.cancel_requested", {"assignmentId": a["id"]})
            return dict(out, outcome="cancel_requested", status="running")
    elif wf["status"] == "running" and sa and sa["phase"] == "validating":
        _kill((_loads(sa["validation_json"], {}) or {}).get("process"))
    elif sa and sa["assignment_id"]:  # paused: free an agent left waiting for input
        a = tx.get("assignment", sa["assignment_id"])
        if a["status"] in tasks.ACTIVE:
            tasks.assignment_cancel(tx, {"assignmentId": a["id"]}, ctx)
    _end(tx, tx.get("workflow_run", wf["id"]), "cancelled", "cancelled by the operator")
    return dict(out, outcome="cancelled", status="cancelled")


