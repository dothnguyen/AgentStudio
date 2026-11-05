"""Delegated commands (P06): vetted commands an agent may ask the coordinator to run for it.

Agents run inside their provider's sandbox (Codex `workspace-write` without network, Claude with its tool allowlist),
so environment work such as reinstalling dependencies is declined. Instead of pausing the run, a stage may request a
command from a committed catalog, `<workspace>/.agent-studio/commands.json`. The agent then ends its turn; the
coordinator runs the command - an argv, never a shell line - in the ticket's workspace, and re-dispatches the same
stage with the original prompt plus a DELEGATED section holding each result.

    load_config(workspace)            the catalog, validated; None when the file is absent (feature off)
    allowed_for(config, stage)        the command ids one stage may request (role, `delegates`, read-only rule)
    check_definition(defn, config)    every `delegates` id of a definition exists in the catalog
    catalog_text(config, ids)         the DELEGATED COMMANDS prompt section for those ids
    file_request(tx, ...)             one validated request row (from the MCP tool or a final-message marker)
    spawn / result / run_delegated    the detached `agent-studio delegate-run` process, like validation's

The agent chooses WHICH vetted command runs, never WHAT runs: commands come from a committed file, frozen into the
run at workflow start, and the only agent input is declared params, each one whole argv element matched against its
pattern.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import select
import shutil
import signal
import subprocess
import sys
import time
from typing import Optional

from . import procid
from .protocol import AsError, BAD_REQUEST
from .providers.base import BASE_ENV

CONFIG_REL = os.path.join(".agent-studio", "commands.json")
DELEGATION_CONFIG_INVALID = "DELEGATION_CONFIG_INVALID"
DELEGATION_NOT_ALLOWED = "DELEGATION_NOT_ALLOWED"
COMMAND_NOT_ALLOWED = "COMMAND_NOT_ALLOWED"
DELEGATION_LIMIT = "DELEGATION_LIMIT"
COMMAND_REQUEST_NOT_ALLOWED = "COMMAND_REQUEST_NOT_ALLOWED"

ID_RE = re.compile(r"[a-z][a-z0-9-]{0,63}\Z")
PARAM_RE = re.compile(r"[a-z][A-Za-z0-9_]{0,31}\Z")
ENV_KEY_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,63}\Z")
TOKEN_RE = re.compile(r"\{([A-Za-z0-9_]+)\}")
MARKER_RE = re.compile(r"^[ \t]*AGENT_STUDIO_DELEGATE[ \t]+(\{.*\})[ \t]*$", re.M)
MAX_COMMANDS = 50
MAX_OUTPUT = 64 * 1024
MAX_FAILURE_BLOCKS = 12 * 1024
OPEN = ("requested", "approved", "running")
TERMINAL = ("succeeded", "failed", "rejected", "cancelled")
PROXY_ENV = ("HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "ALL_PROXY",
             "all_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE")
DEFAULTS = {"timeoutMs": 600000, "network": False, "approval": "auto", "maxPerVisit": 2, "maxPerRun": 6,
            "trackedChanges": "forbid"}
DENIAL_MODES = ("delegate", "pause")
EXAMPLE = ('{"version": 1, "commands": {"app-deps-install": {"description": "Reinstall app dependencies", '
           '"argv": ["npm", "ci"], "cwd": "app", "network": true, "roles": ["Developer"]}}}')


def default_config() -> dict:
    """The canonical empty delegated-command catalog for a new workspace (feature off)."""
    return {"version": 1, "commands": {}, "checkSets": {}}


# ---- configuration ------------------------------------------------------------------------------------

def _bad(path: str, message: str) -> AsError:
    return AsError(DELEGATION_CONFIG_INVALID, f"{CONFIG_REL}: {path}: {message}", data={"path": path},
                   remediation=f"Fix the file; a minimal one looks like: {EXAMPLE}")


def _int(obj: dict, key: str, path: str, lo: int, hi: int, default: int) -> int:
    v = obj.get(key, default)
    if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
        raise _bad(f"{path}.{key}", f"must be an integer from {lo} to {hi}")
    return v


def _choice(obj: dict, key: str, path: str, options: tuple, default):
    v = obj.get(key, default)
    if v not in options:
        raise _bad(f"{path}.{key}", f"must be one of {', '.join(json.dumps(o) for o in options)}")
    return v


def _bool(obj: dict, key: str, path: str, default: bool) -> bool:
    v = obj.get(key, default)
    if not isinstance(v, bool):
        raise _bad(f"{path}.{key}", "must be true or false")
    return v


def _settings(obj: dict, path: str, base: dict) -> dict:
    return {"timeoutMs": _int(obj, "timeoutMs", path, 1000, 3600000, base["timeoutMs"]),
            "network": _bool(obj, "network", path, base["network"]),
            "approval": _choice(obj, "approval", path, ("auto", "human"), base["approval"]),
            "maxPerVisit": _int(obj, "maxPerVisit", path, 1, 20, base["maxPerVisit"]),
            "maxPerRun": _int(obj, "maxPerRun", path, 1, 100, base["maxPerRun"]),
            "trackedChanges": _choice(obj, "trackedChanges", path, ("forbid", "allow"), base["trackedChanges"])}


def _command(cid: str, raw, defaults: dict) -> dict:
    path = f"commands.{cid}"
    if not ID_RE.match(cid):
        raise _bad(path, "a command id must match [a-z][a-z0-9-]{0,63}")
    if not isinstance(raw, dict):
        raise _bad(path, "must be an object")
    known = {"description", "argv", "cwd", "env", "params", "roles"} | set(DEFAULTS)
    for key in raw:
        if key not in known:
            raise _bad(f"{path}.{key}", "unknown key")
    desc = raw.get("description")
    if not isinstance(desc, str) or not desc.strip() or len(desc) > 500:
        raise _bad(f"{path}.description", "is required: 1-500 characters")
    params = {}
    praw = raw.get("params", {})
    if not isinstance(praw, dict) or len(praw) > 8:
        raise _bad(f"{path}.params", "must be an object with at most 8 params")
    for name, spec in praw.items():
        pp = f"{path}.params.{name}"
        if not PARAM_RE.match(name):
            raise _bad(pp, "a param name must match [a-z][A-Za-z0-9_]{0,31}")
        if not isinstance(spec, dict) or set(spec) - {"pattern", "maxLength", "description"}:
            raise _bad(pp, "must be an object with pattern, maxLength and an optional description")
        pattern = spec.get("pattern")
        if not isinstance(pattern, str) or not pattern or len(pattern) > 500:
            raise _bad(f"{pp}.pattern", "is required: a regular expression the whole value must match")
        try:
            re.compile(pattern)
        except re.error as e:
            raise _bad(f"{pp}.pattern", f"is not a valid regular expression: {e}")
        pdesc = spec.get("description", "")
        if not isinstance(pdesc, str) or len(pdesc) > 200:
            raise _bad(f"{pp}.description", "must be text of at most 200 characters")
        params[name] = {"pattern": pattern, "maxLength": _int(spec, "maxLength", pp, 1, 1000, 200),
                        "description": pdesc}
    argv = raw.get("argv")
    if (not isinstance(argv, list) or not 1 <= len(argv) <= 64
            or not all(isinstance(a, str) and a and "\x00" not in a and len(a) <= 4096 for a in argv)):
        raise _bad(f"{path}.argv", "must be a list of 1-64 non-empty strings (an argv, not a shell command line)")
    used = set()
    for i, a in enumerate(argv):
        names = TOKEN_RE.findall(a)
        if not names:
            continue
        if i == 0:
            raise _bad(f"{path}.argv[0]", "the program cannot come from a param")
        if TOKEN_RE.fullmatch(a) is None:
            raise _bad(f"{path}.argv[{i}]", "a {param} must be a whole argv element, not part of one")
        if names[0] not in params:
            raise _bad(f"{path}.argv[{i}]", f"{{{names[0]}}} is not a declared param")
        used.add(names[0])
    unused = sorted(set(params) - used)
    if unused:
        raise _bad(f"{path}.params.{unused[0]}", "is declared but not used in argv")
    cwd = raw.get("cwd", ".")
    if (not isinstance(cwd, str) or not cwd or len(cwd) > 400 or os.path.isabs(cwd) or "\\" in cwd
            or ".." in cwd.split("/")):
        raise _bad(f"{path}.cwd", "must be a relative path inside the workspace (no '..')")
    env = raw.get("env", {})
    if not isinstance(env, dict) or len(env) > 32 or not all(
            isinstance(k, str) and ENV_KEY_RE.match(k) and isinstance(v, str) and "\x00" not in v and len(v) <= 4096
            for k, v in env.items()):
        raise _bad(f"{path}.env", "must map variable names to text values (at most 32)")
    roles = raw.get("roles", [])
    if not isinstance(roles, list) or len(roles) > 32 or not all(isinstance(r, str) and r.strip() for r in roles):
        raise _bad(f"{path}.roles", "must be a list of role names")
    return dict(_settings(raw, path, defaults), id=cid, description=desc.strip(), argv=list(argv), cwd=cwd,
                env=dict(env), params=params, roles=list(dict.fromkeys(roles)))


def _check_sets(raw, commands: dict) -> dict:
    if not isinstance(raw, dict):
        raise _bad("checkSets", "must be an object")
    result = {}
    for sid, spec in raw.items():
        path = f"checkSets.{sid}"
        if not isinstance(sid, str) or not ID_RE.fullmatch(sid):
            raise _bad(path, "a check set id must match [a-z][a-z0-9-]{0,63}")
        if not isinstance(spec, dict):
            raise _bad(path, "must be an object")
        for key in spec:
            if key not in ("run", "otherwise", "reuseIfTested"):
                raise _bad(f"{path}.{key}", "unknown key")
        runs = spec.get("run")
        if not isinstance(runs, list) or not runs:
            raise _bad(f"{path}.run", "must be a non-empty list")
        parsed = []
        for i, rule in enumerate(runs):
            rp = f"{path}.run[{i}]"
            if not isinstance(rule, dict):
                raise _bad(rp, "must be an object")
            for key in rule:
                if key not in ("command", "when"):
                    raise _bad(f"{rp}.{key}", "unknown key")
            command = rule.get("command")
            if not isinstance(command, str) or command not in commands:
                raise _bad(f"{rp}.command", "must name a catalog command")
            patterns = rule.get("when")
            if not isinstance(patterns, list) or not 1 <= len(patterns) <= 20:
                raise _bad(f"{rp}.when", "must be a list of 1-20 globs")
            for j, pattern in enumerate(patterns):
                if (not isinstance(pattern, str) or not pattern or os.path.isabs(pattern)
                        or ".." in pattern or "\\" in pattern or "\x00" in pattern
                        or "[" in pattern or "]" in pattern or re.match(r"^[A-Za-z]:", pattern)):
                    raise _bad(f"{rp}.when[{j}]", "must be a relative glob without '..'")
            parsed.append({"command": command, "when": list(patterns)})
        otherwise = spec.get("otherwise")
        if "otherwise" in spec and (not isinstance(otherwise, str) or otherwise not in commands):
            raise _bad(f"{path}.otherwise", "must name a catalog command")
        result[sid] = {"run": parsed, "reuseIfTested": _bool(spec, "reuseIfTested", path, False)}
        if "otherwise" in spec:
            result[sid]["otherwise"] = otherwise
    return result


def _check_glob(pattern: str) -> re.Pattern:
    """Translate a check-set glob, with **/ also matching zero directories."""
    parts = []
    i = 0
    while i < len(pattern):
        if pattern[i:i + 2] == "**":
            if pattern[i + 2:i + 3] == "/":
                parts.append("(?:.*/)?")
                i += 3
            else:
                parts.append(".*")
                i += 2
        elif pattern[i] == "*":
            parts.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            parts.append("[^/]")
            i += 1
        else:
            parts.append(re.escape(pattern[i]))
            i += 1
    return re.compile("".join(parts), re.DOTALL)


def select_checks(check_set: dict, changed_paths) -> list[str]:
    """Select command IDs in rule order from the paths returned by changed_paths(workspace)."""
    paths = None if changed_paths is None else tuple(changed_paths)
    selected = []
    seen = set()
    for rule in check_set["run"]:
        command = rule["command"]
        if command in seen:
            continue
        if paths is None or any(_check_glob(glob).fullmatch(path)
                                for glob in rule["when"] for path in paths):
            selected.append(command)
            seen.add(command)
    if not selected and paths is not None and "otherwise" in check_set:
        selected.append(check_set["otherwise"])
    return selected


def parse_config(raw) -> dict:
    """The catalog's frozen form from the file's parsed JSON. Raises DELEGATION_CONFIG_INVALID naming the field."""
    if not isinstance(raw, dict) or raw.get("version") != 1:
        raise _bad("$", 'must be an object with "version": 1')
    for key in raw:
        if key not in ("version", "defaults", "commands", "onDenialWithRequest", "resumeSession", "checkSets"):
            raise _bad(key, "unknown key")
    draw = raw.get("defaults", {})
    if not isinstance(draw, dict) or set(draw) - set(DEFAULTS):
        raise _bad("defaults", f"must be an object with only {', '.join(DEFAULTS)}")
    defaults = _settings(draw, "defaults", DEFAULTS)
    craw = raw.get("commands")
    if not isinstance(craw, dict) or len(craw) > MAX_COMMANDS:
        raise _bad("commands", f"is required: an object of at most {MAX_COMMANDS} commands")
    commands = {cid: _command(cid, spec, defaults) for cid, spec in craw.items()}
    resume = raw.get("resumeSession", True)
    if not isinstance(resume, bool):
        raise _bad("resumeSession", "must be true or false")
    return {"version": 1, "commands": commands, "checkSets": _check_sets(raw.get("checkSets", {}), commands), "resumeSession": resume,
            "onDenialWithRequest": _choice(raw, "onDenialWithRequest", "$", DENIAL_MODES, "delegate")}


def load_config(workspace: str) -> Optional[dict]:
    path = os.path.join(workspace, CONFIG_REL)
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as e:
        raise AsError(DELEGATION_CONFIG_INVALID, f"{CONFIG_REL} is not valid JSON: {e}")
    return parse_config(raw)


def check_definition(definition, config: Optional[dict]) -> None:
    """Every `delegates` and `passRequiresCommands` id a stage names must exist in the catalog (checked when a run
    starts)."""
    known = set((config or {}).get("commands", {}))
    for st in definition.stages:
        if getattr(st, "checks", None) is not None:
            check_set = (config or {}).get("checkSets", {}).get(st.checks)
            if check_set is None:
                raise AsError(DELEGATION_CONFIG_INVALID, f"Stage {st.id!r} names unknown check set {st.checks!r}.")
            for cid in {r["command"] for r in check_set["run"]} | ({check_set["otherwise"]} if "otherwise" in check_set else set()):
                if config["commands"][cid]["params"]:
                    raise AsError(DELEGATION_CONFIG_INVALID, f"Check command {cid!r} requires parameters.")
        for cid in (getattr(st, "pass_requires_commands", None) or ()):
            if cid not in known:
                raise AsError(DELEGATION_CONFIG_INVALID, f"Stage {st.id!r} requires {cid!r} to pass, but it is not in "
                                                         f"{CONFIG_REL}.", data={"stage": st.id, "command": cid},
                              remediation=f"Add {cid!r} to {CONFIG_REL} or change the stage's passRequiresCommands.")
        for cid in (getattr(st, "delegates", None) or ()):
            if cid not in known:
                raise AsError(DELEGATION_CONFIG_INVALID, f"Stage {st.id!r} delegates {cid!r}, which is not in "
                                                         f"{CONFIG_REL}.", data={"stage": st.id, "command": cid},
                              remediation=f"Add {cid!r} to {CONFIG_REL} or remove it from the stage's delegates.")


def allowed_for(config: Optional[dict], stage) -> list:
    """Command ids one stage may request: its role is listed, the stage's `delegates` (when given) names it, and a
    read_only stage only gets commands that may not change tracked files."""
    if not config or getattr(stage, "type", "agent") != "agent":
        return []
    only = getattr(stage, "delegates", None)
    out = []
    for cid, c in config["commands"].items():
        if stage.role not in c["roles"]:
            continue
        if only is not None and cid not in only:
            continue
        if stage.permission == "read_only" and c["trackedChanges"] != "forbid":
            continue
        out.append(cid)
    return out


def describe(c: dict) -> dict:
    return {"id": c["id"], "description": c["description"], "argv": c["argv"], "cwd": c["cwd"],
            "params": {k: {"pattern": v["pattern"], "maxLength": v["maxLength"], "description": v["description"]}
                       for k, v in c["params"].items()},
            "approval": c["approval"], "network": c["network"], "trackedChanges": c["trackedChanges"],
            "timeoutMs": c["timeoutMs"], "roles": c["roles"]}


def catalog_text(config: Optional[dict], ids: list) -> str:
    if not config or not ids:
        return ""
    lines = ["You cannot run these yourself; the Agent Studio coordinator runs them for you. To use one, call the",
             "MCP tool `delegated_command_request` (command id, params, reason), or, without MCP, end your final",
             "message with one line per request:",
             'AGENT_STUDIO_DELEGATE {"command": "<id>", "params": {}, "reason": "<why>"}',
             "Then finish your turn with a short summary of where you are. You will be re-dispatched with the",
             "same task plus a DELEGATED section holding each command's result. Never run these commands, or",
             "delete or replace dependencies, yourself.", ""]
    for cid in ids:
        c = config["commands"][cid]
        argv = " ".join(c["argv"])
        lines.append(f"- {cid}: {c['description']} (runs `{argv}` in {c['cwd']}"
                     + (", needs human approval" if c["approval"] == "human" else "") + ")")
        for name, p in c["params"].items():
            lines.append(f"    param {name}: {p['description'] or 'value'} (must match {p['pattern']}, "
                         f"at most {p['maxLength']} characters)")
    return "\n".join(lines)


def render_argv(c: dict, params) -> list:
    """The argv to run: each {param} element replaced by its checked value. Every declared param is required."""
    params = params or {}
    if not isinstance(params, dict):
        raise AsError(BAD_REQUEST, "params must be an object.")
    unknown = sorted(set(params) - set(c["params"]))
    if unknown:
        raise AsError(BAD_REQUEST, f"{c['id']} has no param {unknown[0]!r}.",
                      data={"params": sorted(c["params"])})
    for name, spec in c["params"].items():
        v = params.get(name)
        if not isinstance(v, str) or not v:
            raise AsError(BAD_REQUEST, f"{c['id']} needs param {name!r}.")
        if len(v) > spec["maxLength"] or "\x00" in v or "\n" in v:
            raise AsError(BAD_REQUEST, f"param {name!r} is too long or holds a control character.")
        if v.startswith("-"):
            raise AsError(BAD_REQUEST, f"param {name!r} may not start with '-'.")
        if re.fullmatch(spec["pattern"], v) is None:
            raise AsError(BAD_REQUEST, f"param {name!r} does not match {spec['pattern']}.")
    out = []
    for a in c["argv"]:
        m = TOKEN_RE.fullmatch(a)
        out.append(params[m.group(1)] if m else a)
    return out


def parse_markers(text: Optional[str]) -> list:
    """AGENT_STUDIO_DELEGATE {...} lines of a final message: [(obj or None, raw line)]."""
    out = []
    for m in MARKER_RE.finditer(text or ""):
        try:
            obj = json.loads(m.group(1))
        except ValueError:
            obj = None
        out.append((obj if isinstance(obj, dict) else None, m.group(0).strip()[:300]))
    return out[:20]


# ---- requests (coordinator only) ----------------------------------------------------------------------

def _loads(text, default=None):
    return json.loads(text) if text else default


def run_config(wf: dict) -> Optional[dict]:
    return (_loads(wf.get("config_json"), {}) or {}).get("delegatedCommands")


def requests_for(tx_or_conn, *, assignment_id: Optional[str] = None, workflow_run_id: Optional[str] = None) -> list:
    conn = getattr(tx_or_conn, "conn", tx_or_conn)
    if assignment_id:
        rows = conn.execute("SELECT * FROM command_requests WHERE assignment_id = ? ORDER BY ordinal",
                            (assignment_id,)).fetchall()
    else:
        rows = conn.execute("SELECT * FROM command_requests WHERE workflow_run_id = ? ORDER BY ordinal",
                            (workflow_run_id,)).fetchall()
    return [dict(r) for r in rows]


def _counts(conn, wf_id: str, stage: str, visit: int) -> tuple:
    # every request counts, rejected ones too, so an agent cannot keep asking for what a person turned down
    per_run = conn.execute("SELECT COUNT(*) FROM command_requests WHERE workflow_run_id = ?", (wf_id,)).fetchone()[0]
    per_visit = conn.execute("SELECT COUNT(*) FROM command_requests WHERE workflow_run_id = ? AND stage = ? AND visit = ?",
                             (wf_id, stage, visit)).fetchone()[0]
    return per_run, per_visit


def context_for_assignment(tx_or_conn, assignment_id: str, agent_id: Optional[str] = None) -> dict:
    """The workflow run, stage attempt and allowed commands of one assignment, or DELEGATION_NOT_ALLOWED."""
    from . import workflow
    conn = getattr(tx_or_conn, "conn", tx_or_conn)
    a = conn.execute("SELECT * FROM assignments WHERE id = ?", (assignment_id,)).fetchone()
    if a is None:
        raise AsError(DELEGATION_NOT_ALLOWED, "The assignment does not exist.")
    a = dict(a)
    if agent_id is not None and a["agent_id"] != agent_id:
        raise AsError(DELEGATION_NOT_ALLOWED, "The assignment belongs to another agent.")
    sa = conn.execute("SELECT * FROM stage_attempts WHERE id = ?", (a["stage_attempt_id"],)).fetchone() \
        if a["stage_attempt_id"] else None
    if sa is None:
        raise AsError(DELEGATION_NOT_ALLOWED, "Only workflow stages can delegate commands.")
    sa = dict(sa)
    wf = dict(conn.execute("SELECT * FROM workflow_runs WHERE id = ?", (sa["workflow_run_id"],)).fetchone())
    if not workflow.is_definition_run(wf):
        raise AsError(DELEGATION_NOT_ALLOWED, "This workflow run cannot delegate commands.")
    cfg = run_config(wf)
    stage = workflow._stage_of(wf, sa["stage"])
    ids = allowed_for(cfg, stage)
    per_run, per_visit = _counts(conn, wf["id"], sa["stage"], sa["visit"] or 1)
    return {"assignment": a, "attempt": sa, "run": wf, "config": cfg, "stage": stage, "allowed": ids,
            "perRun": per_run, "perVisit": per_visit}


def list_for_assignment(conn, assignment_id: str, agent_id: str) -> dict:
    ctx = context_for_assignment(conn, assignment_id, agent_id)
    cfg = ctx["config"] or {"commands": {}}
    cmds = []
    for cid in ctx["allowed"]:
        c = cfg["commands"][cid]
        cmds.append(dict(describe(c), remainingThisVisit=max(0, c["maxPerVisit"] - ctx["perVisit"]),
                         remainingThisRun=max(0, c["maxPerRun"] - ctx["perRun"])))
    return {"stage": ctx["stage"].id, "commands": cmds,
            "requests": [public(r) for r in requests_for(conn, assignment_id=assignment_id)]}


def file_request(tx, ctx: dict, command: str, params, reason: Optional[str], source: str) -> dict:
    """Validate and record one request for the assignment in ctx (see context_for_assignment)."""
    if not ctx["allowed"]:
        raise AsError(DELEGATION_NOT_ALLOWED, f"Stage {ctx['stage'].id!r} has no delegated commands for role "
                                              f"{ctx['stage'].role!r}.")
    if command not in ctx["allowed"]:
        raise AsError(COMMAND_NOT_ALLOWED, f"{command!r} is not a command this stage may request.",
                      data={"allowed": ctx["allowed"]})
    c = ctx["config"]["commands"][command]
    argv = render_argv(c, params)
    per_run, per_visit = _counts(tx.conn, ctx["run"]["id"], ctx["attempt"]["stage"], ctx["attempt"]["visit"] or 1)
    if per_visit >= c["maxPerVisit"] or per_run >= c["maxPerRun"]:
        raise AsError(DELEGATION_LIMIT, f"The delegated command limit is reached ({per_visit}/{c['maxPerVisit']} this "
                                        f"visit, {per_run}/{c['maxPerRun']} this run).",
                      remediation="Continue with the checks you can run and report what is missing.")
    ordinal = tx.conn.execute("SELECT COALESCE(MAX(ordinal), 0) FROM command_requests WHERE workflow_run_id = ?",
                              (ctx["run"]["id"],)).fetchone()[0] + 1
    status = "approved" if c["approval"] == "auto" else "requested"
    text = (reason or "").strip()[:500] or None
    rid = tx.create("command_request", {
        "team_id": ctx["run"]["team_id"], "workflow_run_id": ctx["run"]["id"], "stage_attempt_id": ctx["attempt"]["id"],
        "assignment_id": ctx["assignment"]["id"], "stage": ctx["attempt"]["stage"], "visit": ctx["attempt"]["visit"] or 1,
        "ordinal": ordinal, "command_id": command, "params_json": dict(params or {}), "argv_json": argv,
        "reason": text, "source": source}, state=status, event="command_request.created",
        payload={"command": command, "argv": argv, "approval": c["approval"], "source": source, "reason": text,
                 "stage": ctx["attempt"]["stage"]})
    ticket_note(tx, ctx["run"]["id"], "ticket.command_requested",
                {"requestId": rid, "command": command, "approval": c["approval"], "reason": text})
    return {"requestId": rid, "status": status, "command": command, "argv": argv, "approval": c["approval"]}


def request_from_agent(tx, args: dict, ctx: dict) -> dict:
    """command.request (the MCP tool): only while the assignment is live."""
    dc = context_for_assignment(tx, args["assignment"], args["agentId"])
    if dc["assignment"]["status"] not in ("claimed", "running"):
        raise AsError(DELEGATION_NOT_ALLOWED, f"The assignment is {dc['assignment']['status']}; requests are taken "
                                              "only while it runs.")
    if dc["run"]["status"] != "running":
        raise AsError(DELEGATION_NOT_ALLOWED, f"The workflow run is {dc['run']['status']}.")
    out = file_request(tx, dc, args["command"], args.get("params"), args.get("reason"), "mcp")
    return dict(out, next="Finish your turn now with a short summary of your progress; you will be re-dispatched "
                          "with the command's result.")


def file_markers(tx, a: dict, text: Optional[str]) -> list:
    """Requests written as AGENT_STUDIO_DELEGATE lines in a finished assignment's final message."""
    found = parse_markers(text)
    if not found:
        return []
    try:
        dc = context_for_assignment(tx, a["id"])
    except AsError:
        return []
    out = []
    for obj, raw in found:
        try:
            if obj is None or not isinstance(obj.get("command"), str):
                raise AsError(BAD_REQUEST, "a marker needs a JSON object with a command id")
            reason = obj.get("reason") if isinstance(obj.get("reason"), str) else None
            out.append(file_request(tx, dc, obj["command"], obj.get("params"), reason, "marker"))
        except AsError as e:
            tx.note("workflow_run", dc["run"]["id"], "workflow_run.delegation_refused",
                    {"assignmentId": a["id"], "marker": raw, "code": e.code, "message": e.message})
    return out


def public(r: dict) -> dict:
    return {"id": r["id"], "workflowRunId": r["workflow_run_id"], "assignmentId": r["assignment_id"],
            "stage": r["stage"], "visit": r["visit"], "ordinal": r["ordinal"], "command": r["command_id"],
            "params": _loads(r["params_json"], {}), "argv": _loads(r["argv_json"], []), "reason": r["reason"],
            "source": r["source"], "status": r["status"], "result": _public_result(_loads(r["result_json"])),
            "createdAt": r["created_at"], "updatedAt": r["updated_at"]}


def _public_result(res: Optional[dict]) -> Optional[dict]:
    if not res:
        return None
    return {k: res.get(k) for k in ("exitCode", "timedOut", "error", "durationMs", "passed", "outputHead",
                                    "outputTruncated", "trackedChanges", "rejectedReason") if k in res}


def ticket_note(tx, wf_id: str, name: str, payload: dict) -> None:
    """Record a delegation step on the board ticket that holds this run, when there is one."""
    from . import boardmodel
    row = tx.conn.execute("SELECT id, status, workflow_status FROM tickets WHERE active_run_id = ?", (wf_id,)).fetchone()
    if row is not None:
        status = row["workflow_status"] or row["status"]
        boardmodel._ticket_event(tx.conn, row["id"], name, "coordinator", status, status, payload)


def _operator_request(tx, request_id: str) -> dict:
    r = tx.get("command_request", request_id)
    wf = tx.get("workflow_run", r["workflow_run_id"])
    if wf["status"] in ("succeeded", "failed", "cancelled"):
        raise AsError(COMMAND_REQUEST_NOT_ALLOWED, f"Its workflow run is already {wf['status']}.")
    return r


def approve(tx, args: dict, ctx: dict) -> dict:
    r = _operator_request(tx, args["requestId"])
    if r["status"] != "requested":
        raise AsError(COMMAND_REQUEST_NOT_ALLOWED, f"Request {r['id']} is {r['status']}; only a requested command can "
                                                   "be approved.")
    tx.transition("command_request", r["id"], "approved", payload={"by": "operator"})
    ticket_note(tx, r["workflow_run_id"], "ticket.command_approved", {"requestId": r["id"], "command": r["command_id"]})
    return {"requestId": r["id"], "status": "approved"}


def reject(tx, args: dict, ctx: dict) -> dict:
    r = _operator_request(tx, args["requestId"])
    if r["status"] != "requested":
        raise AsError(COMMAND_REQUEST_NOT_ALLOWED, f"Request {r['id']} is {r['status']}; only a requested command can "
                                                   "be rejected.")
    why = (args.get("reason") or "").strip()[:500] or "rejected by the operator"
    tx.transition("command_request", r["id"], "rejected", payload={"reason": why},
                  set_values={"result_json": {"passed": False, "rejectedReason": why}})
    ticket_note(tx, r["workflow_run_id"], "ticket.command_rejected",
                {"requestId": r["id"], "command": r["command_id"], "reason": why})
    return {"requestId": r["id"], "status": "rejected"}


def cancel_request(tx, r: dict, reason: str) -> None:
    if r["status"] in TERMINAL:
        return
    if r["status"] == "running":
        stop((_loads(r["process_json"], {}) or {}))
    tx.transition("command_request", r["id"], "cancelled", payload={"reason": reason})


def cancel(tx, args: dict, ctx: dict) -> dict:
    r = _operator_request(tx, args["requestId"])
    if r["status"] in TERMINAL:
        raise AsError(COMMAND_REQUEST_NOT_ALLOWED, f"Request {r['id']} is already {r['status']}.")
    cancel_request(tx, r, (args.get("reason") or "").strip()[:500] or "cancelled by the operator")
    return {"requestId": r["id"], "status": "cancelled"}


def result_text(reqs: list) -> str:
    """The DELEGATED section body handed to the resumed stage."""
    parts = []
    for r in reqs:
        res = _loads(r["result_json"], {}) or {}
        argv = " ".join(_loads(r["argv_json"], []))
        head = f"[{r['ordinal']}] {r['command_id']} (`{argv}`): "
        if r["status"] == "rejected":
            parts.append(head + f"NOT RUN - rejected: {res.get('rejectedReason') or 'by the operator'}")
            continue
        if r["status"] == "cancelled":
            parts.append(head + "NOT RUN - cancelled")
            continue
        if res.get("error"):
            status = f"COULD NOT RUN - {res['error']}"
        elif res.get("trackedChanges"):
            status = (f"FAILED - it changed tracked files, which this command may not do: "
                      f"{', '.join(res['trackedChanges'][:10])}")
        elif res.get("timedOut"):
            status = "TIMED OUT"
        else:
            status = "SUCCEEDED" if res.get("exitCode") == 0 else f"FAILED (exit {res.get('exitCode')})"
        failure_blocks = res.get("failureBlocks") or ""
        tail = res.get("outputTail") or ""
        output = []
        if failure_blocks:
            output.append(f"Failure/error blocks:\n{failure_blocks}")
        if tail and tail.strip() not in failure_blocks:
            output.append(f"Output (last part):\n{tail}")
        parts.append(head + f"{status}, {res.get('durationMs', 0)} ms.\n" + ("\n\n".join(output) if output else
                                                                               "(no output)"))
    return "\n\n".join(parts) or "(no delegated commands)"


# ---- the detached runner --------------------------------------------------------------------------------

def spawn(run_dir: str, workspace: str, r: dict, c: dict) -> dict:
    """Start `agent-studio delegate-run --dir RUN_DIR` for one approved request; returns its process identity."""
    os.makedirs(run_dir, mode=0o700, exist_ok=True)
    _stop_orphan(run_dir)
    root = os.path.realpath(workspace)
    cwd = os.path.realpath(os.path.join(root, c["cwd"]))
    if cwd != root and not cwd.startswith(root + os.sep):
        raise AsError(DELEGATION_CONFIG_INVALID, f"{c['id']}: cwd {c['cwd']!r} resolves outside the workspace.")
    request = {"argv": _loads(r["argv_json"], []), "cwd": cwd, "workspace": root, "timeoutMs": c["timeoutMs"],
               "env": c["env"], "network": c["network"], "trackedChanges": c["trackedChanges"],
               "command": c["id"], "requestId": r["id"]}
    tmp = os.path.join(run_dir, "request.json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(request, f)
    os.replace(tmp, os.path.join(run_dir, "request.json"))
    launcher = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "launch.py")
    p = subprocess.Popen([sys.executable, "-s", launcher, "delegate-run", "--dir", run_dir], stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd="/", start_new_session=True,
                         close_fds=True)
    ident = dict(procid.identity(p.pid), dir=run_dir)
    with open(os.path.join(run_dir, "process.json"), "w", encoding="utf-8") as f:
        json.dump(ident, f)
    return ident


def _stop_orphan(run_dir: str) -> None:
    try:
        with open(os.path.join(run_dir, "process.json"), encoding="utf-8") as f:
            old = json.load(f)
    except (OSError, ValueError):
        return
    stop(old)
    for name in ("result.json", "output.log"):
        try:
            os.unlink(os.path.join(run_dir, name))
        except OSError:
            pass


def stop(proc: dict) -> None:
    if proc and proc.get("pid") and procid.matches(proc):
        try:
            os.killpg(proc["pid"], signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass


def alive(proc: dict) -> bool:
    return bool(proc and proc.get("pid") and procid.matches(proc))


def result(run_dir: str) -> Optional[dict]:
    try:
        with open(os.path.join(run_dir, "result.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _tracked_state(root: str) -> Optional[str]:
    git = shutil.which("git")
    if not git:
        return None
    try:
        out = subprocess.run([git, "-C", root, "status", "--porcelain=v1", "--untracked-files=no"],
                             stdin=subprocess.DEVNULL, capture_output=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.stdout.decode("utf-8", "replace") if out.returncode == 0 else None


def _changed(before: str, after: str) -> list:
    b, a = set(before.splitlines()), set(after.splitlines())
    return sorted({line[3:] for line in (a ^ b) if len(line) > 3})


def _git(root: str, *args) -> Optional[bytes]:
    git = shutil.which("git")
    if not git:
        return None
    try:
        out = subprocess.run([git, "-C", root, "-c", "core.quotepath=off"] + list(args), stdin=subprocess.DEVNULL,
                             capture_output=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.stdout if out.returncode == 0 else None


def workspace_fingerprint(root: str) -> Optional[str]:
    """One hash of the code a command saw: HEAD, the tracked changes against it, and every untracked (not ignored)
    file with its content. Equal fingerprints mean the same code; None when git cannot tell."""
    head = _git(root, "rev-parse", "HEAD")
    diff = _git(root, "diff", "HEAD", "--binary", "--no-ext-diff", "--no-textconv")
    others = _git(root, "ls-files", "--others", "--exclude-standard", "-z")
    if head is None or diff is None or others is None:
        return None
    h = hashlib.sha256()
    h.update(head.strip() + b"\0")
    h.update(hashlib.sha256(diff).digest())
    for rel in sorted(p for p in others.split(b"\0") if p):
        h.update(rel + b"\0")
        path = os.path.join(os.fsencode(root), rel)
        try:
            with open(path, "rb") as f:
                fh = hashlib.sha256()
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    fh.update(chunk)
            h.update(fh.digest())
        except OSError:
            h.update(b"?")
    return h.hexdigest()


UI_PREFIXES = ("app/",)
BACKEND_PREFIXES = ("backend/", "tests/")
BOTH_PREFIXES = ("scripts/",)   # the test runner itself: a change there can break either side
SUITE_ALL, SUITE_UI, SUITE_BACKEND = "test-all", "test-ui", "test-backend"


def changed_paths(root: str) -> Optional[set]:
    """Every path this branch changed: committed since it left the base branch, uncommitted, and untracked.
    None when git cannot tell. The base branch is board.json's baseBranch, else main or master."""
    names = []
    try:
        with open(os.path.join(root, ".agent-studio", "board.json"), encoding="utf-8") as f:
            names.append(json.load(f).get("baseBranch"))
    except (OSError, ValueError, AttributeError):
        pass
    paths = set()
    for base in [n for n in names if isinstance(n, str)] + ["main", "master"]:
        merge_base = _git(root, "merge-base", "HEAD", base)
        if merge_base is not None and merge_base.strip():
            diff = _git(root, "diff", "--name-only", "-z", merge_base.strip().decode("ascii", "replace"), "HEAD")
            if diff is None:
                return None
            paths |= {p.decode("utf-8", "replace") for p in diff.split(b"\0") if p}
            break
    for args in (("diff", "--name-only", "-z", "HEAD"), ("ls-files", "--others", "--exclude-standard", "-z")):
        out = _git(root, *args)
        if out is None:
            return None
        paths |= {p.decode("utf-8", "replace") for p in out.split(b"\0") if p}
    return paths


def required_suite(paths) -> tuple:
    """(suite command id, why) for a set of changed paths: only app/ changed -> test-ui; only backend changed ->
    test-backend; both, or neither (docs, config), or git could not tell -> test-all."""
    if paths is None:
        return SUITE_ALL, "the changed files could not be determined"
    ui = any(p.startswith(UI_PREFIXES + BOTH_PREFIXES) for p in paths)
    backend = any(p.startswith(BACKEND_PREFIXES + BOTH_PREFIXES) for p in paths)
    if ui and not backend:
        return SUITE_UI, "the changes touch only the app (app/)"
    if backend and not ui:
        return SUITE_BACKEND, "the changes touch only the backend (backend/, tests/)"
    if ui and backend:
        return SUITE_ALL, "the changes touch both the app and the backend"
    return SUITE_ALL, "the changes touch neither the app nor the backend"


def verify_pass(tx, wf: dict, ids, workspace: str) -> Optional[str]:
    """None when the suite this change needs succeeded in this run on exactly the code in `workspace` now (its newest
    run on this code passed); otherwise the BLOCKER finding that turns a pass verdict into a fail.

    A stage lists the commands it accepts (`passRequiresCommands`). When those include the standard suites
    (test-all, test-backend, test-ui) the changed files decide which one is required: test-ui or test-backend for a
    change confined to one side, test-all otherwise; test-all always counts for any of them, being the superset.
    For any other list, one successful run of any listed command is enough."""
    ids = tuple(ids)
    why = None
    if SUITE_ALL in ids and (SUITE_UI in ids or SUITE_BACKEND in ids):
        suite, why = required_suite(changed_paths(workspace))
        ids = tuple(dict.fromkeys([suite, SUITE_ALL])) if suite in ids else ids
    names = " or ".join(ids)
    needed = f" ({why})" if why else ""
    marks = ",".join("?" * len(ids))
    rows = [dict(r) for r in tx.conn.execute(
        f"SELECT * FROM command_requests WHERE workflow_run_id = ? AND command_id IN ({marks}) "
        f"AND status IN ('succeeded', 'failed') ORDER BY ordinal DESC", (wf["id"],) + tuple(ids)).fetchall()]
    if not rows:
        return (f"BLOCKER: {names} was not run in this stage's workflow run{needed} - a pass needs a successful "
                f"{names} run on the final code (request it as a delegated command, then judge its result)")
    current = workspace_fingerprint(workspace)
    if current is None:
        return "BLOCKER: Agent Studio could not fingerprint the workspace to check which code the tests ran on"
    failed, seen = None, set()
    for r in rows:   # newest first; each accepted command's newest run on this exact code decides for that command
        res = _loads(r["result_json"], {}) or {}
        if res.get("workspaceFingerprint") != current or r["command_id"] in seen:
            continue
        seen.add(r["command_id"])
        if r["status"] == "succeeded":
            return None
        if failed is None:
            fail = res.get("error") or ("timed out" if res.get("timedOut") else f"exit {res.get('exitCode')}")
            failed = (f"BLOCKER: the latest {r['command_id']} run on the final code failed ({fail}); fix it and run "
                      f"{names} again")
    if failed:
        return failed
    return (f"BLOCKER: the code changed after the last {names} run, so the final code was never tested{needed} - run "
            f"{names} again after your last change")


def _tail(path: str, limit: int = 2000) -> str:
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - limit))
            return f.read(limit).decode("utf-8", "replace")
    except OSError:
        return ""


_FAILURE_LINE = re.compile(r"^(?:FAIL(?:ED)?(?:\s|:|\()|ERROR(?:\s|:|\()|Traceback \(most recent call last\):)",
                           re.IGNORECASE)
_BLOCK_BOUNDARY = re.compile(r"^[=_-]{5,}$")


def _failure_blocks(path: str, tail: str = "", limit: int = MAX_FAILURE_BLOCKS) -> str:
    """Return bounded failure/error regions even when later output pushes them out of the tail."""
    try:
        with open(path, "rb") as f:
            text = f.read(MAX_OUTPUT).decode("utf-8", "replace")
    except OSError:
        text = ""
    if tail and tail not in text:
        text += "\n" + tail
    lines = text.splitlines()
    spans = []
    for i, line in enumerate(lines):
        if not _FAILURE_LINE.match(line.strip()):
            continue
        start = i - 1 if i and _BLOCK_BOUNDARY.match(lines[i - 1].strip()) else i
        end = min(len(lines), i + 40)
        for j in range(i + 1, end):
            if j > i + 1 and _BLOCK_BOUNDARY.match(lines[j].strip()):
                end = j + 1
                break
        if spans and start <= spans[-1][1]:
            spans[-1] = (spans[-1][0], max(spans[-1][1], end))
        else:
            spans.append((start, end))
    chunks = []
    used = 0
    for start, end in spans:
        chunk = "\n".join(lines[start:end]).strip()
        if not chunk:
            continue
        remaining = limit - used
        if remaining <= 0:
            break
        if len(chunk) > remaining:
            chunk = chunk[:remaining].rstrip() + "\n[failure output truncated]"
        chunks.append(chunk)
        used += len(chunk) + 2
    return "\n\n".join(chunks)


def run_delegated(run_dir: str) -> int:
    """Entry point of `agent-studio delegate-run --dir DIR` (detached). Writes result.json last."""
    with open(os.path.join(run_dir, "request.json"), encoding="utf-8") as f:
        req = json.load(f)
    out_path = os.path.join(run_dir, "output.log")
    started = time.monotonic()
    res = {"exitCode": None, "timedOut": False, "error": None, "outputPath": out_path, "outputTruncated": False}
    exe = req["argv"][0]
    exe = exe if os.path.isabs(exe) else shutil.which(exe)
    before = _tracked_state(req["workspace"]) if req.get("trackedChanges") == "forbid" else None
    if not exe:
        res["error"] = f"command not found: {req['argv'][0]}"
    elif not os.path.isdir(req["cwd"]):
        res["error"] = f"working directory does not exist: {req['cwd']}"
    else:
        names = BASE_ENV + (PROXY_ENV if req.get("network") else ())
        env = {k: os.environ[k] for k in names if k in os.environ}
        env.update(req.get("env") or {})
        env["AGENT_STUDIO_DELEGATED_COMMAND"] = req.get("command", "")
        fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            p = subprocess.Popen([exe] + req["argv"][1:], cwd=req["cwd"], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, start_new_session=True)
            deadline = started + req["timeoutMs"] / 1000.0
            os.set_blocking(p.stdout.fileno(), False)
            written = 0
            keep = b""  # the last part of the output, kept even when the file is capped
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    res["timedOut"] = True
                    for sig in (signal.SIGTERM, signal.SIGKILL):
                        try:
                            os.killpg(p.pid, sig)
                        except ProcessLookupError:
                            break
                        try:
                            p.wait(timeout=3)
                            break
                        except subprocess.TimeoutExpired:
                            continue
                    break
                if select.select([p.stdout], [], [], min(0.2, remaining))[0]:
                    chunk = os.read(p.stdout.fileno(), 65536)
                    if not chunk:
                        break
                    keep = (keep + chunk)[-4096:]
                    if written < MAX_OUTPUT:
                        piece = chunk[:MAX_OUTPUT - written]
                        os.write(fd, piece)
                        written += len(piece)
                    if written >= MAX_OUTPUT:
                        res["outputTruncated"] = True
            p.wait()
            p.stdout.close()
            res["exitCode"] = p.returncode
            res["outputTail"] = keep.decode("utf-8", "replace")[-2000:]
        except OSError as e:
            res["error"] = f"command could not start: {e.strerror}"
        finally:
            os.close(fd)
    res["workspaceFingerprint"] = workspace_fingerprint(req["workspace"])
    if before is not None:
        after = _tracked_state(req["workspace"])
        if after is not None and after != before:
            res["trackedChanges"] = _changed(before, after)[:50] or ["(tracked files changed)"]
    res["durationMs"] = int((time.monotonic() - started) * 1000)
    res.setdefault("outputTail", _tail(out_path))
    res["failureBlocks"] = _failure_blocks(out_path, res["outputTail"])
    res["passed"] = (res["error"] is None and not res["timedOut"] and res["exitCode"] == 0
                     and not res.get("trackedChanges"))
    tmp = os.path.join(run_dir, "result.json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(res, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, os.path.join(run_dir, "result.json"))
    return 0
