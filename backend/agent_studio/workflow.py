"""Built-in Developer -> Reviewer workflow (P00-S06).

    developer -> [diff + validation] -> reviewer -> (one repair) developer_repair -> [diff + validation]
              -> reviewer_recheck -> final

The coordinator advances runs from durable state only (assignment rows, validation result files); it never reads
panes and has no provider-specific branches. Decisions follow the PRD section 6 truth table:

  Developer failed / inconclusive / waiting          -> paused (operator resolves)
  validation pass + reviewer pass                    -> succeeded
  validation pass + reviewer fail                    -> repair if budget remains, else failed
  validation fail + any valid verdict                -> repair if budget remains, else failed
  reviewer verdict malformed / missing / not success -> paused
  any stage cancelled                                -> cancelled
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

from . import gitws, procid, prompts, tasks, validation, workflowdef
from .protocol import AsError, BAD_REQUEST
from .providers.base import valid_verdict
from .state import utcnow
from .store import NOT_FOUND, Store, Tx
from .textsafe import terminal_safe

DEV_STAGES = ("developer", "developer_repair")
REVIEW_STAGES = ("reviewer", "reviewer_recheck")
POLICY = {"developer": "workspace_write", "developer_repair": "workspace_write",
          "reviewer": "read_only", "reviewer_recheck": "read_only"}
ACTIVE = ("queued", "running", "paused")
SAME_AGENT = "SAME_AGENT"
ROLE_UNBOUND = "ROLE_UNBOUND"
ROLE_AMBIGUOUS = "ROLE_AMBIGUOUS"
BUILTIN_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "workflows")

TEMPLATES = {
    "developer": (
        "You are the Developer in an Agent Studio workflow.\n"
        "Make the change described in TASK inside the current workspace. Keep the change focused, and do not\n"
        "touch files the task does not need. A deterministic validation command will run after you finish, and\n"
        "a separate Reviewer will read your diff. Finish with a short summary of what you changed.\n"),
    "developer_repair": (
        "You are the Developer in an Agent Studio workflow, repairing your earlier change after review.\n"
        "Address every item in FINDINGS and make VALIDATION pass, without unrelated changes. DIFF shows the\n"
        "current changes against the starting commit. Finish with a short summary of what you changed.\n"),
    "reviewer": (
        "You are the Reviewer in an Agent Studio workflow. You have read-only access: do not modify files.\n"
        "Review DIFF against TASK, taking VALIDATION into account.\n"),
}
TEMPLATES["reviewer_recheck"] = TEMPLATES["reviewer"]


# ---- helpers ----------------------------------------------------------------------------------------

def workflow_dir(state_dir: str, wf_id: str) -> str:
    return os.path.join(state_dir, "workflows", wf_id)


def compose_prompt(stage: str, task: str, diff: Optional[str] = None, validation_text: Optional[str] = None,
                   findings: Optional[list] = None) -> str:
    """P00 stage prompt: the fixed template, then the data sections, rendered by prompts.render. Review stages end
    with the verdict footer (P01-S03 moved the JSON sentence from the template to the end of the prompt)."""
    template = TEMPLATES[stage]
    template += "{{task}}"
    if diff is not None:
        template += "{{diff}}"
    if validation_text is not None:
        template += "{{validation}}"
    if findings is not None:
        template += "{{findings}}"
    return prompts.render(template, kind="verdict" if stage in REVIEW_STAGES else "work", task=task, diff=diff,
                          validation=validation_text, findings=findings, stage=stage, visit=1)


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


def _last_dev_attempt(tx: Tx, wf_id: str) -> dict:
    return dict(tx.conn.execute("SELECT * FROM stage_attempts WHERE workflow_run_id = ? AND stage IN "
                                "('developer', 'developer_repair') AND status = 'completed' "
                                "ORDER BY created_at DESC, rowid DESC LIMIT 1", (wf_id,)).fetchone())


# ---- start ------------------------------------------------------------------------------------------

def is_definition_run(wf: dict) -> bool:
    """P00 runs have no frozen definition and keep the DEV_STAGES / POLICY lookups."""
    return wf.get("definition_json") is not None


def frozen_definition(wf: dict) -> "workflowdef.Definition":
    """The definition a run was started with. Read only through from_json, never parse_obj."""
    return workflowdef.from_json(json.loads(wf["definition_json"]))


def bind_roles(tx: Tx, team: dict, definition: "workflowdef.Definition", overrides: dict, ctx: dict) -> dict:
    """One agent per distinct role of the definition: the roster `role` (exactly one match), or an override.
    Returns {role: agent row}, roles in stage order. Rejects before anything is written."""
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
        if a["availability"] in ("offline", "error") or a["pane_state"] != "alive":
            raise AsError(tasks.AGENT_UNAVAILABLE, f"{role} agent {a['display_name']} is {a['availability']}.")
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
    ws = team["workspace"]
    definition = workflowdef.load(ws, args["definition"], BUILTIN_DIR)
    first = definition.stages[0]
    if first.type != "agent":
        raise AsError(BAD_REQUEST, f"Definition {definition.name} starts with a validation stage; that is not "
                                   "supported until P01-S06.")
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
    asg = _dispatch(tx, wf, first.id, None, ctx, from_assignment=None, data={})
    return {"receipt": "accepted", "workflowRunId": wf, "taskId": task, "baseCommit": base,
            "definition": definition.name, "definitionSha256": definition.source_sha256, "bindings": bindings,
            "assignmentId": asg, "validationArgv": config["validation"]["argv"]}


def start(tx: Tx, args: dict, ctx: dict) -> dict:
    if args.get("definition"):
        return _start_definition(tx, args, ctx)
    team = tx.get("team", args["teamId"])
    if team["status"] != "running":
        raise AsError(tasks.TEAM_NOT_RUNNING, f"Team {team['id']} is {team['status']}.")
    if args["developerAgentId"] == args["reviewerAgentId"]:
        raise AsError(SAME_AGENT, "The Developer and the Reviewer must be two different agents.")
    agents = {}
    for role, key in (("developer", "developerAgentId"), ("reviewer", "reviewerAgentId")):
        try:
            a = tx.get("agent", args[key])
        except AsError:
            raise AsError(NOT_FOUND, f"{role} agent {args[key]} does not exist.")
        if a["team_id"] != team["id"]:
            raise AsError(tasks.AGENT_NOT_IN_TEAM, f"{role} agent {a['id']} is not in team {team['id']}.")
        if a["availability"] in ("offline", "error") or a["pane_state"] != "alive":
            raise AsError(tasks.AGENT_UNAVAILABLE, f"{role} agent {a['display_name']} is {a['availability']}.")
        adapter, _ = tasks.adapter_for(a, ctx)
        policy = POLICY[role]
        if adapter.describe(dict(os.environ))["policies"].get(policy) in (None, "unsupported"):
            raise AsError(tasks.POLICY_UNSUPPORTED, f"{role} agent's provider {a['provider_id']} has no verified "
                                                    f"mapping for {policy}.")
        agents[role] = a
    ws = team["workspace"]
    base = gitws.require_repo(ws)
    dirty = gitws.dirty_entries(ws)
    if dirty and not (ctx["debug"] and args.get("allowDirtyTree")):
        raise AsError(gitws.WORKSPACE_DIRTY, f"The workspace has {len(dirty)} uncommitted change(s); the workflow "
                                             "needs a clean starting commit.", data={"entries": dirty[:20]},
                      remediation="Commit or stash your changes first.")
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
    task = tx.create("task", {"team_id": team["id"], "origin": "workflow", "workspace": ws, "goal": args["text"]})
    tx.transition("task", task, "assigned")
    tx.transition("task", task, "running")
    wf = tx.create("workflow_run", {"team_id": team["id"], "task_id": task, "workflow": "developer_reviewer",
                                    "retry_budget": 1, "retry_count": 0, "base_commit": base,
                                    "developer_agent_id": agents["developer"]["id"],
                                    "reviewer_agent_id": agents["reviewer"]["id"], "config_json": config,
                                    "deadline_at": deadline},
                   payload={"baseCommit": base, "validationArgv": config["validation"]["argv"]})
    tx.transition("workflow_run", wf, "running", set_values={"transition_reason": "started"})
    first = _dispatch(tx, wf, "developer", compose_prompt("developer", args["text"]), ctx, from_assignment=None)
    return {"receipt": "accepted", "workflowRunId": wf, "taskId": task, "baseCommit": base,
            "developerAgentId": agents["developer"]["id"], "reviewerAgentId": agents["reviewer"]["id"],
            "assignmentId": first, "validationArgv": config["validation"]["argv"]}


def _dispatch(tx: Tx, wf_id: str, stage: str, prompt: Optional[str], ctx: dict, from_assignment: Optional[str],
              provider_options: Optional[dict] = None, data: Optional[dict] = None) -> str:
    """Create the stage attempt and its assignment. P00 runs pass the composed prompt. Definition runs may pass None
    and `data` (diff, validation, findings, summary), and the frozen template is rendered here."""
    wf = tx.get("workflow_run", wf_id)
    config = _loads(wf["config_json"], {})
    if is_definition_run(wf):
        st = next(x for x in frozen_definition(wf).stages if x.id == stage)
        agent_id = _loads(wf["bindings_json"], {})[st.role]
        policy, stage_type = st.permission, st.type
    else:
        st, stage_type, policy = None, "agent", POLICY[stage]
        agent_id = wf["developer_agent_id"] if stage in DEV_STAGES else wf["reviewer_agent_id"]
    agent = tx.get("agent", agent_id)
    n = tx.conn.execute("SELECT COUNT(*) FROM stage_attempts WHERE workflow_run_id = ?", (wf_id,)).fetchone()[0] + 1
    attempt = tx.conn.execute("SELECT COUNT(*) FROM stage_attempts WHERE workflow_run_id = ? AND stage = ?",
                              (wf_id, stage)).fetchone()[0] + 1
    if prompt is None:
        prompt = prompts.render(st.prompt, kind=st.kind, task=tx.get("task", wf["task_id"])["goal"],
                                stage=stage, visit=attempt, **(data or {}))
    sdir = os.path.join(workflow_dir(ctx["stateDir"], wf_id), f"{n:02d}-{stage}")
    prompt_path = os.path.join(sdir, "prompt.txt")
    _write_private(prompt_path, prompt)
    sa = tx.create("stage_attempt", {"team_id": wf["team_id"], "workflow_run_id": wf_id, "stage": stage,
                                     "attempt": attempt, "agent_id": agent_id, "phase": "assignment",
                                     "prompt_path": prompt_path, "stage_type": stage_type, "visit": attempt})
    adapter, alias = tasks.adapter_for(agent, ctx)
    request = tasks.build_request(agent, tx.get("task", wf["task_id"])["workspace"],
                                  {"promptFile": prompt_path, "deadlineMs": config.get("stageDeadlineMs"),
                                   "workflowRunId": wf_id, "stage": stage})
    stage_opts = provider_options or (config.get("debugStageOptions") or {}).get(stage)
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

def advance(store: Store, ctx: dict) -> int:
    rows = store.conn.execute("SELECT id FROM workflow_runs WHERE status = 'running'").fetchall()
    n = 0
    for r in rows:
        try:
            with store.transaction() as tx:
                if _advance_one(tx, r["id"], ctx):
                    n += 1
        except AsError as e:  # e.g. git failed: pause with the reason instead of retrying forever
            with store.transaction() as tx:
                wf = tx.get("workflow_run", r["id"])
                if wf["status"] == "running":
                    _pause(tx, wf, None, f"{e.code}: {e.message}", e.code)
    return n


def _advance_one(tx: Tx, wf_id: str, ctx: dict) -> bool:
    wf = tx.get("workflow_run", wf_id)
    sa = _current_attempt(tx, wf_id)
    if wf["deadline_at"] and wf["deadline_at"] < utcnow():
        _stop_active(tx, wf, sa, ctx)
        _end(tx, wf, "failed", "workflow deadline reached")
        return True
    if sa is None:
        return False
    cancel = _cancel_requested(tx, wf_id)
    sdir = os.path.dirname(sa["prompt_path"])
    if sa["phase"] == "assignment" and is_definition_run(wf):
        a = tx.get("assignment", sa["assignment_id"])
        if a["status"] in ("queued", "claimed", "running"):
            return False
        if a["status"] == "cancelled" or cancel:
            _end(tx, wf, "cancelled", "cancelled by the operator" if cancel else f"{sa['stage']} assignment cancelled")
        else:   # P01-S05 adds outcomes and routing; until then a finished first stage waits for the operator
            _pause(tx, wf, sa, f"{sa['stage']} {a['status']}; routing for definition runs is not available yet",
                   (_loads(a["result_json"], {}) or {}).get("diagnosticCode") or "ROUTING_NOT_AVAILABLE")
        return True
    if sa["phase"] == "assignment":
        a = tx.get("assignment", sa["assignment_id"])
        if a["status"] in ("queued", "claimed", "running"):
            return False
        result = _loads(a["result_json"], {}) or {}
        if a["status"] == "cancelled" or cancel:
            _end(tx, wf, "cancelled", "cancelled by the operator" if cancel else f"{sa['stage']} assignment cancelled")
            return True
        if sa["stage"] in DEV_STAGES:
            if a["status"] != "succeeded":
                _pause(tx, wf, sa, f"{sa['stage']} {a['status']}", result.get("diagnosticCode"))
                return True
            diff = gitws.capture_diff(wf_workspace(tx, wf), wf["base_commit"], sdir)
            proc = validation.spawn(sdir, wf_workspace(tx, wf), _loads(wf["config_json"], {}))
            tx.update("stage_attempt", sa["id"], {"phase": "validating", "diff_json": diff,
                                                  "validation_json": {"state": "running", "process": proc}},
                      "stage_attempt.validating", {"sourceAssignmentId": a["id"], "diffPath": diff["path"],
                                                   "diffBytes": diff["bytes"], "changedFiles": diff["changedFiles"][:20],
                                                   "untrackedFiles": diff["untrackedFiles"][:20]})
            return True
        verdict = result.get("verdict") if a["status"] == "succeeded" else None
        if not valid_verdict(verdict):
            why = "reviewer verdict missing or malformed" if a["status"] in ("succeeded", "reconciling") \
                else f"{sa['stage']} {a['status']}"
            _pause(tx, wf, sa, why, result.get("diagnosticCode") or "MALFORMED_VERDICT")
            return True
        findings = [str(f)[:2000] for f in verdict.get("findings", [])][:50]
        tx.update("stage_attempt", sa["id"], {"verdict_json": {"verdict": verdict["verdict"], "findings": findings},
                                              "outcome": f"verdict_{verdict['verdict']}", "phase": "done"},
                  "stage_attempt.verdict",
                  {"sourceAssignmentId": a["id"], "verdict": verdict["verdict"], "findings": findings[:10]})
        tx.transition("stage_attempt", sa["id"], "completed")
        _decide(tx, wf, a["id"], verdict["verdict"], findings, ctx)
        return True
    if sa["phase"] == "validating":
        val_state = _loads(sa["validation_json"], {}) or {}
        res = validation.result(sdir)
        if res is None:
            if procid.matches(val_state.get("process") or {}) and not cancel:
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
        tx.update("stage_attempt", sa["id"], {"phase": "done", "validation_json": dict(res, state="done"),
                                              "outcome": "validation_" + ("passed" if res["passed"] else "failed")},
                  "stage_attempt.validated", {"sourceAssignmentId": sa["assignment_id"], "passed": res["passed"],
                                              "exitCode": res.get("exitCode"), "timedOut": res.get("timedOut"),
                                              "error": res.get("error")})
        tx.transition("stage_attempt", sa["id"], "completed")
        if cancel:
            _end(tx, wf, "cancelled", "cancelled by the operator")
            return True
        if res.get("error"):
            _pause(tx, wf, None, f"validation could not run: {res['error']}", "VALIDATION_ERROR")
            return True
        task = tx.get("task", wf["task_id"])
        diff = _loads(sa["diff_json"], {}) or {}
        stage = "reviewer" if sa["stage"] == "developer" else "reviewer_recheck"
        prompt = compose_prompt(stage, task["goal"], diff=_read(diff.get("path")), validation_text=_validation_text(res))
        if task["status"] == "running":
            tx.transition("task", task["id"], "review")
        _dispatch(tx, wf["id"], stage, prompt, ctx, from_assignment=sa["assignment_id"])
        return True
    return False


def wf_workspace(tx: Tx, wf: dict) -> str:
    return tx.get("task", wf["task_id"])["workspace"]


def _decide(tx: Tx, wf: dict, review_assignment: str, verdict: str, findings: list, ctx: dict) -> None:
    dev = _last_dev_attempt(tx, wf["id"])
    val = _loads(dev["validation_json"], {}) or {}
    passed = bool(val.get("passed"))
    if passed and verdict == "pass":
        _end(tx, wf, "succeeded", "validation passed and the reviewer approved")
        return
    reasons = ([] if passed else ["validation failed"]) + (["reviewer requested changes"] if verdict == "fail" else [])
    reason = " and ".join(reasons)
    last_finding = (findings[0] if findings else val.get("outputHead", "")[:500]) or None
    wf = tx.get("workflow_run", wf["id"])
    if wf["retry_count"] >= wf["retry_budget"]:
        tx.update("workflow_run", wf["id"], {"last_finding": last_finding}, "workflow_run.finding",
                  {"finding": last_finding})
        _end(tx, wf, "failed", f"{reason}; repair budget ({wf['retry_budget']}) used")
        return
    tx.update("workflow_run", wf["id"], {"retry_count": wf["retry_count"] + 1, "last_finding": last_finding,
                                         "transition_reason": f"repair: {reason}"}, "workflow_run.repair_requested",
              {"reason": reason, "findings": findings[:10], "validationPassed": passed,
               "sourceAssignmentId": review_assignment})
    task = tx.get("task", wf["task_id"])
    if task["status"] == "review":
        tx.transition("task", task["id"], "running")
    diff = _loads(dev["diff_json"], {}) or {}
    prompt = compose_prompt("developer_repair", task["goal"], diff=_read(diff.get("path")),
                            validation_text=_validation_text(val), findings=findings)
    _dispatch(tx, wf["id"], "developer_repair", prompt, ctx, from_assignment=review_assignment)


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


# ---- cancel ---------------------------------------------------------------------------------------

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
