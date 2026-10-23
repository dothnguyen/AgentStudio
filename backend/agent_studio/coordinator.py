"""Coordinator daemon: the only writer of materialized state. Detached from every client process."""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import select
import signal
import subprocess
import sys
import time
import traceback
from datetime import datetime, timezone
from typing import Optional

from . import PROTOCOL, VERSION, board, board_config, crashpoints, envresolve, fixtures, gitws, inbox, paths, procid, reconcile, report_rules, reports, \
    resolve, state, tasks, teams, tickets, tmuxctl, workflow, worktrees
from .store import Store
from .protocol import AsError, BACKEND_UNAVAILABLE, DEBUG_DISABLED, INTERNAL, UNKNOWN_COMMAND

LOCK_FILE = "coordinator.lock"
PID_FILE = "coordinator.json"
RUNTIME_FILE = "runtime.json"
LOG_FILE = "coordinator.log"
POLL_S = 0.25
START_WAIT_S = 30.0


def _p(sd: str, name: str) -> str:
    return os.path.join(sd, name)


def launcher_path() -> str:
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "launch.py")


def running_info(sd: str) -> Optional[dict]:
    """Pidfile contents if, and only if, the recorded process identity is alive and holds the lock."""
    info = procid.read_json(_p(sd, PID_FILE))
    if not isinstance(info, dict) or not procid.matches(info):
        return None
    if not procid.lock_is_held(_p(sd, LOCK_FILE)):
        return None
    return info


def describe(sd: str, info: dict, already: bool) -> dict:
    started = info.get("startedAt")
    uptime = None
    if started:
        try:
            t = datetime.fromisoformat(started.replace("Z", "+00:00"))
            uptime = round((datetime.now(timezone.utc) - t).total_seconds(), 3)
        except ValueError:
            pass
    return {"running": True, "alreadyRunning": already, "pid": info["pid"], "startTime": info["startTime"],
            "startedAt": started, "uptimeSeconds": uptime, "version": info.get("version"),
            "debugCommands": bool(info.get("debugCommands")), "logFile": _p(sd, LOG_FILE)}


# ---- lifecycle (called from clients) -----------------------------------------------------------

def start(enable_debug: bool = False) -> dict:
    sd = paths.ensure_state_dir()
    info = running_info(sd)
    if info:
        return describe(sd, info, already=True)
    argv = [sys.executable, "-s", launcher_path(), "coordinator", "run"] + (["--enable-debug"] if enable_debug else [])
    with open(_p(sd, LOG_FILE), "ab") as log:
        proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log, stderr=log, cwd="/",
                                start_new_session=True, close_fds=True)
    deadline = time.monotonic() + START_WAIT_S
    while time.monotonic() < deadline:
        info = running_info(sd)
        if info:
            return describe(sd, info, already=info["pid"] != proc.pid)
        if proc.poll() is not None:
            info = running_info(sd)
            if info:
                return describe(sd, info, already=True)
            raise AsError(BACKEND_UNAVAILABLE, f"The coordinator exited during startup (code {proc.returncode}).",
                          retryable=True, remediation=f"See {_p(sd, LOG_FILE)}")
        time.sleep(0.05)
    raise AsError(BACKEND_UNAVAILABLE, "The coordinator did not become ready in time.", retryable=True,
                  remediation=f"See {_p(sd, LOG_FILE)}")


def stop(timeout_s: float = 10.0) -> dict:
    sd = paths.ensure_state_dir()
    info = running_info(sd)
    if not info:
        return {"stopped": False, "wasRunning": False}
    pid = info["pid"]
    os.kill(pid, signal.SIGTERM)
    forced = False
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if not procid.matches(info):
            break
        time.sleep(0.05)
    else:
        if procid.matches(info):  # re-verify identity immediately before escalating
            os.kill(pid, signal.SIGKILL)
            forced = True
            for _ in range(40):
                if not procid.matches(info):
                    break
                time.sleep(0.05)
    return {"stopped": not procid.matches(info), "wasRunning": True, "pid": pid, "forced": forced}


# ---- daemon -----------------------------------------------------------------------------------

def _log(msg: str) -> None:
    sys.stderr.write(f"{state.utcnow()} coordinator[{os.getpid()}] {msg}\n")
    sys.stderr.flush()


def _require_debug(ctx: dict) -> None:
    if not ctx["debug"]:
        raise AsError(DEBUG_DISABLED, "Debug commands are disabled in this coordinator.",
                      remediation="agent-studio coordinator stop && agent-studio coordinator start --enable-debug")


def _handle_debug_echo(args: dict, tx, ctx: dict) -> dict:
    _require_debug(ctx)
    text = args["text"]
    raw = text.encode("utf-8")
    return {"text": text, "sha256": hashlib.sha256(raw).hexdigest(), "utf8Bytes": len(raw),
            "codePoints": len(text), "coordinatorPid": os.getpid()}


def _handle_debug_fixture(args: dict, tx, ctx: dict) -> dict:
    _require_debug(ctx)
    return fixtures.create_fixture_team(tx, agents=args["agents"], workspace=args["workspace"])


def _handle_debug_assign(args: dict, tx, ctx: dict) -> dict:
    _require_debug(ctx)
    return teams.debug_assign(tx, args, ctx)


def _handle_debug_ticket_worktree(args: dict, tx, ctx: dict) -> dict:
    _require_debug(ctx)
    ticket = tickets.get(tx, args["workspace"], args["key"])
    branch = gitws.run(args["workspace"], "symbolic-ref", "--short", "HEAD").stdout.decode().strip()
    created = worktrees.create(args["workspace"], ticket["key"], worktrees.slug(ticket["title"]), branch,
                               state_dir=ctx["stateDir"])
    tickets.record_worktree(tx, ticket, created)
    return {"ticket": ticket["key"], "worktree": created}


def _ticket_deps(tx, ticket):
    return [row[0] for row in tx.conn.execute(
        "SELECT t.key FROM ticket_deps d JOIN tickets t ON t.id = d.blocked_by_ticket_id "
        "WHERE d.ticket_id = ? ORDER BY t.key", (ticket["id"],))]


def _handle_ticket_create(args, tx, ctx):
    story_path = tickets.check_workspace_path(args["workspace"], args["storyPath"])
    with open(os.path.join(args["workspace"], story_path), "r", encoding="utf-8") as f:
        text = f.read()
    stem = os.path.splitext(os.path.basename(story_path))[0]
    parsed_ids = tickets.parse_depends(text)
    parsed = tickets.resolve_depends(tx, args["workspace"], parsed_ids)
    ticket = tickets.create(tx, args["workspace"], "story", {
        "title": args.get("title", tickets.story_title(text, stem)), "story_path": story_path,
        "priority": args["priority"]})
    if args["noDeps"]:
        deps = []
    elif "dependsOn" in args:
        deps = args["dependsOn"]
    else:
        deps = parsed["resolved"]
    if deps:
        tickets.add_deps(tx, ticket, deps)
    ticket = tickets.get(tx, args["workspace"], ticket["key"])
    return {"ticket": ticket, "dependsOn": _ticket_deps(tx, ticket),
            "parsed": {"ids": parsed_ids, **parsed},
            "warnings": [{"code": "DEPENDS_UNRESOLVED", "id": ident} for ident in parsed["unresolved"]]}


def _handle_ticket_move(args, tx, ctx):
    ticket = tickets.move(tx, tickets.get(tx, args["workspace"], args["key"]), args["to"], "operator",
                          args.get("reason"))
    return {"ticket": ticket}


def _handle_ticket_block(args, tx, ctx):
    return {"ticket": tickets.block(tx, tickets.get(tx, args["workspace"], args["key"]), "operator", args["reason"])}


def _handle_ticket_unblock(args, tx, ctx):
    return {"ticket": tickets.unblock(tx, tickets.get(tx, args["workspace"], args["key"]), "operator")}


def _handle_ticket_cancel(args, tx, ctx):
    ticket = tickets.get(tx, args["workspace"], args["key"])
    run = None
    if ticket["run_id"]:
        row = tx.conn.execute("SELECT status FROM workflow_runs WHERE id = ?", (ticket["run_id"],)).fetchone()
        if row is not None and row["status"] in ("queued", "running", "paused"):
            run = workflow.cancel(tx, {"workflowRunId": ticket["run_id"]}, ctx)
    ticket = tickets.cancel(tx, ticket, "operator", args.get("reason"))
    return {"ticket": ticket, "run": run}


def _handle_ticket_depend(args, tx, ctx):
    ticket = tickets.get(tx, args["workspace"], args["key"])
    if args["on"]:
        tickets.add_deps(tx, ticket, args["on"])
    if args["remove"]:
        tickets.remove_deps(tx, ticket, args["remove"])
    ticket = tickets.get(tx, args["workspace"], args["key"])
    return {"ticket": ticket, "dependsOn": _ticket_deps(tx, ticket)}


def _handle_ticket_start(args, tx, ctx):
    ticket = tickets.get(tx, args["workspace"], args["key"])
    agent = tx.get("agent", args["agentId"])
    team = tx.get("team", agent["team_id"])
    if team["status"] != "running" or team["workspace"] != args["workspace"]:
        raise AsError(tasks.TEAM_NOT_RUNNING, "Agent team is not running on this workspace.")
    roles = {row[0] for row in tx.conn.execute("SELECT role FROM agents WHERE team_id = ?", (team["id"],))}
    return board.start_column(tx, ticket, agent, board_config.current(tx, args["workspace"], roles), ctx)


HANDLERS = {
    "debug.echo": _handle_debug_echo,
    "debug.fixture": _handle_debug_fixture,
    "debug.assign": _handle_debug_assign,
    "debug.ticket_worktree": _handle_debug_ticket_worktree,
    "team.start": lambda args, tx, ctx: teams.team_start(tx, args, ctx),
    "team.stop": lambda args, tx, ctx: teams.team_stop(tx, args, ctx),
    "task.direct": lambda args, tx, ctx: tasks.task_direct(tx, args, ctx),
    "assignment.cancel": lambda args, tx, ctx: tasks.assignment_cancel(tx, args, ctx),
    "workflow.start": lambda args, tx, ctx: workflow.start(tx, args, ctx),
    "workflow.cancel": lambda args, tx, ctx: workflow.cancel(tx, args, ctx),
    "workflow.retry": lambda args, tx, ctx: workflow.retry(tx, args, ctx),
    "assignment.resolve": lambda args, tx, ctx: resolve.resolve(tx, args, ctx),
    "ticket.create": _handle_ticket_create,
    "ticket.move": _handle_ticket_move,
    "ticket.block": _handle_ticket_block,
    "ticket.unblock": _handle_ticket_unblock,
    "ticket.cancel": _handle_ticket_cancel,
    "ticket.depend": _handle_ticket_depend,
    "ticket.start": _handle_ticket_start,
}
MONITOR_INTERVAL_S = 2.0


def process_pending(store: Store, ctx: dict) -> int:
    """Each command's state changes, events, and stored response commit in ONE transaction, so a crash can
    never leave a change applied without its receipt (which would replay it) or a receipt without the change."""
    conn = store.conn
    n = 0
    for row in inbox.pending(conn):
        handler = HANDLERS.get(row["command"])
        try:
            with store.transaction(actor="operator", command_seq=row["seq"]) as tx:
                if handler is None:
                    raise AsError(UNKNOWN_COMMAND, f"The coordinator does not handle {row['command']!r}.")
                data = handler(json.loads(row["args_json"]), tx, ctx)
                crashpoints.hit("before_command_commit")
                if isinstance(data, teams.Failure):  # keep the recorded state change, answer with the error
                    resp = {"ok": False, "error": data.error.to_error()}
                    if data.error.data is not None:
                        resp["data"] = data.error.data
                    inbox.complete(conn, row["seq"], resp)
                else:
                    inbox.complete(conn, row["seq"], {"ok": True, "data": data})
            crashpoints.hit("after_command_commit")
        except AsError as e:  # the transaction rolled back; record the rejection on its own
            resp = {"ok": False, "error": e.to_error()}
            if e.data is not None:
                resp["data"] = e.data
            inbox.complete(conn, row["seq"], resp)
        except Exception:  # never let one command kill the loop; never log its payload
            _log(f"handler error for command seq={row['seq']} name={row['command']}:\n{traceback.format_exc()}")
            inbox.complete(conn, row["seq"], {"ok": False, "error": {"code": INTERNAL,
                                              "message": "Internal coordinator error.", "retryable": False}})
        n += 1
    return n


def _reap_children() -> None:
    """Collect finished children we started with Popen and never waited for (detached validators). Safe here:
    the loop is single-threaded, so no subprocess.run() is waiting at the same time."""
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return


def run(enable_debug: bool = False) -> int:
    sd = paths.ensure_state_dir()
    lock_fd = os.open(_p(sd, LOCK_FILE), os.O_RDWR | os.O_CREAT, 0o600)
    for _ in range(20):
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if running_info(sd):
                _log("another coordinator already holds the lock; exiting")
                return 3
            time.sleep(0.05)  # a client may be probing the lock momentarily
    else:
        _log("could not acquire the coordinator lock; exiting")
        return 3

    stop_flag = {"stop": False}
    wake_r, wake_w = os.pipe()
    os.set_blocking(wake_r, False)
    os.set_blocking(wake_w, False)
    signal.set_wakeup_fd(wake_w)

    def on_term(signum, frame):
        stop_flag["stop"] = True

    signal.signal(signal.SIGTERM, on_term)
    signal.signal(signal.SIGINT, on_term)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    signal.signal(signal.SIGUSR1, lambda s, f: None)  # wake-up only; set_wakeup_fd does the work

    dbp = state.db_path(sd)
    conn = state.connect(dbp, role="coordinator", create=True)
    state.migrate(conn, dbp)
    store = Store(conn)

    env, envinfo = envresolve.resolve()
    os.environ.clear()
    os.environ.update(env)  # later stories spawn tmux/providers with this environment
    procid.write_json_atomic(_p(sd, RUNTIME_FILE), {
        "envMode": envinfo["mode"], "envSource": envinfo["source"], "shell": envinfo.get("shell"),
        "warnings": envinfo["warnings"], "pathDirs": envresolve.summarize_path(env.get("PATH", "")),
        "distro": env.get("WSL_DISTRO_NAME") or os.environ.get("WSL_DISTRO_NAME")})
    ident = procid.identity(os.getpid())
    pidfile = dict(ident, startedAt=state.utcnow(), version=VERSION, protocol=PROTOCOL, debugCommands=enable_debug,
                   schemaVersion=state.SCHEMA_VERSION)
    procid.write_json_atomic(_p(sd, PID_FILE), pidfile)
    _log(f"started (debug={enable_debug}, env={envinfo['source']})")

    tmux = tmuxctl.Tmux(env=env)
    ctx = {"debug": enable_debug, "stateDir": sd, "tmux": tmux}
    crashpoints.configure(enable_debug, sd)
    startup = {"at": state.utcnow()}
    for name, step in (("reports", lambda: reports.apply_pending(store, report_rules.apply)),
                       ("panes", lambda: teams.monitor(store, tmux)),
                       ("assignments", lambda: reconcile.tick(store, ctx)),
                       ("orphanSessions", lambda: reconcile.orphan_sessions(store, tmux))):
        try:
            startup[name] = step()
        except Exception as e:  # recorded, never fatal: the loop retries every tick
            startup[name] = {"error": str(e)}
            _log(f"startup reconciliation step {name} failed:\n{traceback.format_exc()}")
    runtime = procid.read_json(_p(sd, RUNTIME_FILE)) or {}
    procid.write_json_atomic(_p(sd, RUNTIME_FILE), dict(runtime, startupReconciliation=startup))
    _log(f"startup reconciliation: {json.dumps(startup, default=str)[:2000]}")
    next_monitor = 0.0
    while not stop_flag["stop"]:
        try:
            reports.apply_pending(store, report_rules.apply)  # first, so commands see the latest outcomes
            process_pending(store, ctx)
            workflow.advance(store, ctx)
            teams.redeliver(store, sd)
            teams.dispatch_claims(store, sd)
            if time.monotonic() >= next_monitor:
                _reap_children()
                teams.monitor(store, tmux)
                reconcile.tick(store, ctx)
                next_monitor = time.monotonic() + MONITOR_INTERVAL_S
        except Exception:
            _log(f"loop error:\n{traceback.format_exc()}")
            time.sleep(0.5)
        if stop_flag["stop"]:
            break
        try:
            select.select([wake_r], [], [], POLL_S)
        except InterruptedError:
            pass
        try:
            while os.read(wake_r, 512):
                pass
        except BlockingIOError:
            pass

    _log("stopping")
    current = procid.read_json(_p(sd, PID_FILE))
    if isinstance(current, dict) and current.get("pid") == os.getpid():
        try:
            os.unlink(_p(sd, PID_FILE))
        except OSError:
            pass
    conn.close()
    return 0
