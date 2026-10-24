#!/usr/bin/env python3
"""P03-S16 board failure drills on the fake provider.

    python3 scripts/live/board_drills.py --provider fake [--only NAME ...]

Each drill gets its own throwaway state directory, tmux directory, git repository and debug coordinator, injects
one failure into a board run, checks the path the board takes, applies the recovery from backend/RECOVERY.md and
waits until every ticket is merged.  Nothing here touches the operator's coordinator, state or repositories.
Importable: `run_drill(name, evidence_root=None)` runs one drill and returns {name, ok, finalStatus, seconds}.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SHIM = os.path.join(ROOT, "backend", "bin", "agent-studio")
EVIDENCE_BASE = os.path.join(ROOT, "phases", "phase-03", "evidence", "s16")
STORY_DIR = "phases/phase-03/stories"
FIXTURE_PROVIDERS = "codex=fake,claude=fake,agy=fake"
ROSTER = [("codex", "TeamLead"), ("claude", "Developer"), ("agy", "QA")]
STILL_SECONDS = 5.0


def wait_seconds():
    return int(os.environ.get("TEST_WAIT_SECONDS", "120"))


def wait_until(fn, timeout=None, interval=0.1, message="condition"):
    deadline = time.monotonic() + (wait_seconds() if timeout is None else timeout)
    last = None
    while time.monotonic() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    raise AssertionError(f"timed out waiting for {message}; last={last!r}")


def fake(scenario="success", write=None, duration=200):
    option = {"scenario": scenario, "durationMs": duration, "progressLines": 1}
    if write:
        option["writeFile"] = write
    return option


# The S13 happy path: refine writes the story file, develop writes fixed.txt, every verdict passes.
DEFAULTS = {
    "refine": lambda: fake("verdict_pass", STORY_DIR + "/story-1.md", 100),
    "develop": lambda: fake("success", "fixed.txt", 300),
    "test": lambda: fake("verdict_pass", None, 100),
    "review": lambda: fake("verdict_pass", None, 100),
}

_KEY = "substr(t.goal, 9, instr(substr(t.goal, 9), ' ') - 1)"
# A workflow run is named "definition", so the board column comes from the ticket: its working status, or the
# status it returns to when a paused run is retried.
_COLUMN = """CASE CASE WHEN k.status = 'blocked' THEN k.return_status ELSE k.status END
    WHEN 'refine' THEN 'refine' WHEN 'refining' THEN 'refine'
    WHEN 'ready_dev' THEN 'develop' WHEN 'in_dev' THEN 'develop' WHEN 'fail_test' THEN 'develop'
    WHEN 'changes_requested' THEN 'develop'
    WHEN 'ready_test' THEN 'test' WHEN 'in_test' THEN 'test'
    WHEN 'ready_review' THEN 'review' WHEN 'in_review' THEN 'review' ELSE 'other' END"""
TRIGGER_SQL = (
    "CREATE TABLE drill_script (tkey TEXT NOT NULL, col TEXT NOT NULL, nth INTEGER NOT NULL, options TEXT NOT NULL)",
    "CREATE TABLE drill_seen (aid TEXT NOT NULL, tkey TEXT NOT NULL, col TEXT NOT NULL)",
    """CREATE TRIGGER drill_fixture_options AFTER INSERT ON assignments WHEN NEW.stage_attempt_id IS NOT NULL
        BEGIN
          INSERT INTO drill_seen (aid, tkey, col)
            SELECT NEW.id, %(key)s, %(col)s FROM tasks t, tickets k WHERE t.id = NEW.task_id AND k.key = %(key)s;
          UPDATE assignments SET request_json = json_set(request_json, '$.providerOptions', json(COALESCE(
            (SELECT o.options FROM drill_script o, drill_seen b
              WHERE b.aid = NEW.id AND o.col = b.col AND o.tkey IN (b.tkey, '*')
                AND o.nth IN (0, (SELECT COUNT(*) FROM drill_seen c WHERE c.tkey = b.tkey AND c.col = b.col AND c.rowid <= b.rowid))
              ORDER BY (o.tkey = '*'), (o.nth = 0) LIMIT 1),
            '{"scenario":"success","durationMs":50,"progressLines":1}')))
          WHERE id = NEW.id;
        END""" % {"key": _KEY, "col": _COLUMN},
)


def temp_root():
    base = tempfile.gettempdir()
    if base.startswith("/mnt/"):
        base = "/tmp"
    return tempfile.mkdtemp(prefix="as-drill-", dir=base)


class Env:
    """One drill's isolated world.  Creating it starts nothing; `setup()` does."""

    def __init__(self, name="drill"):
        self.name = name
        self.root = temp_root()
        tmux_dir = os.path.join(self.root, "tmux")
        os.makedirs(tmux_dir, mode=0o700)
        self.env = dict(os.environ)
        for k in ("TMUX", "TMUX_PANE", "AGENT_STUDIO_TEST_CRASH_AT"):
            self.env.pop(k, None)
        self.env.update({"XDG_STATE_HOME": os.path.join(self.root, "state"), "AGENT_STUDIO_ENV_MODE": "inherit",
                         "TMUX_TMPDIR": tmux_dir, "AGENT_STUDIO_TEST_FIXTURE_PROVIDERS": FIXTURE_PROVIDERS})
        self.workspace = os.path.join(self.root, "repo")
        self.commands = []
        self.before = None
        self.keys = []
        self.agents = {}
        self.teams = []

    @property
    def state_dir(self):
        return os.path.join(self.env["XDG_STATE_HOME"], "agent-studio")

    @property
    def db(self):
        return os.path.join(self.state_dir, "state.db")

    # ---- process plumbing -------------------------------------------------------------------------------------
    def run(self, *args, stdin=None, extra_env=None, timeout=60):
        env = dict(self.env, **(extra_env or {}))
        proc = subprocess.run([SHIM] + list(args), input=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              env=env, timeout=timeout)
        lines = [l for l in proc.stdout.splitlines() if l.strip()]
        return json.loads(lines[-1]) if lines else None

    def start_coordinator(self, extra_env=None):
        resp = self.run("coordinator", "start", "--enable-debug", extra_env=extra_env)
        assert resp and resp["ok"], resp
        return resp

    def coordinator_pid(self):
        with open(os.path.join(self.state_dir, "coordinator.json"), encoding="utf-8") as f:
            return json.load(f)["pid"]

    def call(self, command, recovery=False, **args):
        request = {"protocol": "agent-studio/v1", "command": command, "args": dict(args)}
        if not command.endswith((".show", ".list")) and command != "events.after":
            request["idempotencyKey"] = "drill-" + uuid.uuid4().hex
        resp = self.run("request", stdin=json.dumps(request).encode("utf-8"))
        if recovery:
            self.commands.append({"request": request, "response": resp})
        assert resp is not None, f"{command}: no response"
        return resp

    def ok(self, command, recovery=False, **args):
        resp = self.call(command, recovery=recovery, **args)
        assert resp["ok"], (command, resp)
        return resp["data"]

    def sql(self, query, params=()):
        conn = sqlite3.connect(self.db, timeout=10)
        try:
            return conn.execute(query, params).fetchall()
        finally:
            conn.close()

    # ---- fixture ----------------------------------------------------------------------------------------------
    def git(self, *args):
        return subprocess.run(["git", "-C", self.workspace] + list(args), check=True, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.strip()

    def make_repo(self, tickets=1, config=None):
        os.makedirs(os.path.join(self.workspace, ".agent-studio"))
        os.makedirs(os.path.join(self.workspace, STORY_DIR))
        subprocess.run(["git", "init", "-q", self.workspace], check=True)
        self.git("config", "user.email", "drill@example.invalid")
        self.git("config", "user.name", "drill")
        with open(os.path.join(self.workspace, "check.py"), "w") as f:
            f.write("print('validation passes')\n")
        with open(os.path.join(self.workspace, ".agent-studio", "workflow.json"), "w") as f:
            json.dump({"version": 1, "validation": {"argv": ["python3", "check.py"], "timeoutMs": 20000}}, f)
        for n in range(1, tickets + 1):
            with open(os.path.join(self.workspace, STORY_DIR, f"story-{n}.md"), "w", encoding="utf-8") as f:
                f.write(f"# Story {n}\n")
        self.git("add", "-A")
        self.git("commit", "-qm", "base")
        base = self.git("symbolic-ref", "--short", "HEAD")
        with open(os.path.join(self.workspace, ".agent-studio", "board.json"), "w", encoding="utf-8") as f:
            json.dump(dict({"baseBranch": base, "maxParallelDev": 2}, **(config or {})), f)
        self.git("add", "-A")
        self.git("commit", "-qm", "board config")
        self.workspace = os.path.realpath(self.workspace)

    def script(self, tkey, col, nth, option):
        self.sql_write("INSERT INTO drill_script (tkey, col, nth, options) VALUES (?, ?, ?, ?)",
                       (tkey, col, nth, json.dumps(option)))

    def sql_write(self, query, params=()):
        conn = sqlite3.connect(self.db, timeout=10)
        try:
            conn.execute(query, params)
            conn.commit()
        finally:
            conn.close()

    def install_script(self):
        conn = sqlite3.connect(self.db, timeout=10)
        try:
            for statement in TRIGGER_SQL:
                conn.execute(statement)
            for col, make in DEFAULTS.items():
                conn.execute("INSERT INTO drill_script (tkey, col, nth, options) VALUES ('*', ?, 0, ?)",
                             (col, json.dumps(make())))
            conn.commit()
        finally:
            conn.close()

    def setup(self, tickets=1, developers=1, config=None, coordinator_env=None, status=None):
        """Repo, debug coordinator, default fakes, team and tickets.  The drill adds its script, then `start_board()`."""
        self.make_repo(tickets, config)
        self.start_coordinator(coordinator_env)
        self.install_script()
        roster = [{"providerId": p, "role": r, "name": r.lower()} for p, r in ROSTER if r != "Developer"]
        roster += [{"providerId": "claude", "role": "Developer", "name": f"dev-{n}"} for n in range(1, developers + 1)]
        team = self.ok("team.start", workspace=self.workspace, roster=roster)
        self.agents = {a["name"] if "name" in a else a["role"]: a["agentId"] for a in team["agents"]}
        self.developers = [a["agentId"] for a in team["agents"] if a["role"] == "Developer"]
        self.qa = next(a["agentId"] for a in team["agents"] if a["role"] == "QA")
        for n in range(1, tickets + 1):
            ticket = self.ok("ticket.create", workspace=self.workspace, storyPath=f"{STORY_DIR}/story-{n}.md")["ticket"]
            self.keys.append(ticket["key"])
            if status:
                self.ok("ticket.move", workspace=self.workspace, key=ticket["key"], to=status)

    def start_board(self):
        self.ok("board.run", workspace=self.workspace)

    # ---- observation ------------------------------------------------------------------------------------------
    def ticket(self, key=None):
        return self.ok("ticket.show", workspace=self.workspace, key=key or self.keys[0])

    def status(self, key=None):
        return self.ticket(key)["ticket"]["status"]

    def events(self, key=None):
        return self.ticket(key)["events"]

    def board(self):
        return self.ok("board.show", workspace=self.workspace)

    def all_events(self):
        out, cursor = [], 0
        while True:
            page = self.ok("events.after", cursor=cursor, limit=200)
            out.extend(e for e in page["events"] if e["name"].startswith(("ticket.", "board.")))
            if not page["hasMore"]:
                return out
            cursor = page["nextCursor"]

    def mark_before(self, **extra):
        """Snapshot board.show; `extra` (e.g. the assignment row) is recorded beside it under "drill"."""
        self.before = self.board()
        if extra:
            self.before["drill"] = extra

    def wait_status(self, key, status, message=None, timeout=None):
        return wait_until(lambda: self.status(key) == status, timeout=timeout, message=message or f"{key} {status}")

    def wait_merged(self):
        wait_until(lambda: all(self.status(k) == "merged" for k in self.keys), message="all tickets merged")

    def final_status(self):
        statuses = [self.status(k) for k in self.keys]
        return statuses[0] if len(set(statuses)) == 1 else ",".join(statuses)

    def holds(self):
        return self.board()["held"]

    def assignment_row(self, agent_id):
        rows = self.sql("SELECT id, status, process_pid, diagnostic_code FROM assignments WHERE agent_id = ? "
                        "ORDER BY rowid DESC LIMIT 1", (agent_id,))
        return rows[0] if rows else None

    def stay(self, check, seconds=STILL_SECONDS, message="state changed"):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            assert check(), message
            time.sleep(0.25)

    # ---- teardown ---------------------------------------------------------------------------------------------
    def write_evidence(self, folder):
        os.makedirs(folder, exist_ok=True)

        def dump(name, value):
            with open(os.path.join(folder, name), "w", encoding="utf-8") as f:
                json.dump(value, f, indent=2, sort_keys=True)
                f.write("\n")
        try:
            after = self.board()
        except Exception as error:  # evidence is best effort once a drill has already failed
            after = {"error": str(error)}
        try:
            events = self.all_events()
        except Exception as error:
            events = [{"error": str(error)}]
        dump("board_show_before.json", self.before)
        dump("board_show_after.json", after)
        dump("events.json", events)
        dump("commands.json", self.commands)

    def cleanup(self):
        try:
            self.run("coordinator", "stop", timeout=30)
        except Exception:
            pass
        try:
            subprocess.run(["tmux", "-L", "agent-studio", "kill-server"], env=self.env, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=20)
            subprocess.run(["tmux", "kill-server"], env=self.env, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=20)
        except Exception:
            pass
        shutil.rmtree(self.root, ignore_errors=True)


# ---- the drills ---------------------------------------------------------------------------------------------------
def names(env, key, *wanted):
    return [e for e in env.events(key) if e["name"] in wanted]


def drill_coordinator_killed(env, evidence):
    env.setup()
    key = env.keys[0]
    env.script(key, "develop", 1, fake("success", "fixed.txt", 12000))
    env.start_board()
    env.wait_status(key, "in_dev")
    pid = env.coordinator_pid()
    env.mark_before(coordinatorPid=pid, note="coordinator killed while the ticket is in_dev")
    os.kill(pid, signal.SIGKILL)
    wait_until(lambda: not os.path.exists(f"/proc/{pid}") or open(f"/proc/{pid}/stat").read().split()[2] == "Z",
               timeout=10, message="coordinator gone")
    env.start_coordinator()
    env.commands.append({"argv": ["coordinator", "start", "--enable-debug"], "response": "ok"})
    env.wait_merged()
    runs = [e["payload"]["runId"] for e in env.events(key) if e["name"] == "ticket.run_started"
            and e["payload"].get("definition") == "board-develop"]
    applied = [e for e in names(env, key, "ticket.outcome_applied") if e["payload"].get("runId") == runs[0]]
    assert len(applied) == 1, f"develop run applied {len(applied)} times"


def drill_runner_killed(env, evidence):
    env.setup()
    key = env.keys[0]
    env.script(key, "test", 1, fake("verdict_pass", None, 30000))
    env.start_board()
    env.wait_status(key, "in_test")
    row = wait_until(lambda: (r := env.assignment_row(env.qa)) and r[1] == "running" and r[2] and r, message="QA running")
    os.kill(row[2], signal.SIGKILL)
    wait_until(lambda: (r := env.assignment_row(env.qa)) and r[1] == "reconciling" and r, message="QA reconciling")
    assert env.assignment_row(env.qa)[3] == "RUNNER_GONE", env.assignment_row(env.qa)
    ticket = wait_until(lambda: (t := env.ticket(key)["ticket"])["status"] == "blocked" and t, message="ticket blocked")
    assert ticket["blockedReason"].startswith("RUN_PAUSED:"), ticket["blockedReason"]
    assert ticket["returnStatus"] == "ready_test", ticket["returnStatus"]
    gone = env.assignment_row(env.qa)
    env.mark_before(assignment={"id": gone[0], "status": gone[1], "diagnosticCode": gone[3]})
    env.ok("assignment.resolve", recovery=True, assignmentId=row[0], action="retry")
    env.wait_merged()


def drill_merge_conflict(env, evidence):
    env.setup(tickets=2, developers=2)
    for key in env.keys:
        env.script(key, "develop", 1, fake("success", "shared.txt", 3000))
        env.script(key, "develop", 2, fake("success", "shared.txt", 200))
    env.start_board()
    conflict = wait_until(lambda: next((k for k in env.keys if names(env, k, "ticket.merge_conflict")), None),
                          message="a ticket.merge_conflict event")
    event = names(env, conflict, "ticket.merge_conflict")[0]
    assert "shared.txt" in json.dumps(event["payload"]), event
    env.mark_before()
    findings = env.sql("SELECT findings_json FROM tickets WHERE key = ?", (conflict,))[0][0]
    assert "MERGE_CONFLICT: shared.txt" in (findings or ""), findings
    env.wait_merged()
    assert len(names(env, conflict, "ticket.merge_conflict")) == 1


def drill_round_limit(env, evidence):
    env.setup(config={"roundLimits": {"dev": 3, "test": 1, "review": 3}})
    key = env.keys[0]
    env.script(key, "test", 1, fake("verdict_fail", None, 100))
    env.script(key, "test", 2, fake("verdict_fail", None, 100))
    env.start_board()
    ticket = wait_until(lambda: (t := env.ticket(key)["ticket"])["status"] == "blocked" and t, message="ticket blocked")
    assert ticket["blockedReason"] == "ROUND_LIMIT:test", ticket["blockedReason"]
    assert ticket["returnStatus"] == "fail_test", ticket["returnStatus"]
    assert any(e["toStatus"] == "fail_test" for e in env.events(key)), "no fail_test after the first failed QA"
    env.mark_before()
    env.ok("ticket.unblock", recovery=True, workspace=env.workspace, key=key)
    env.wait_merged()


def drill_planning_outside(env, evidence):
    env.setup()
    key = env.keys[0]
    env.script(key, "refine", 1, fake("verdict_pass", "outside.txt", 100))
    env.start_board()
    head = env.git("rev-parse", "HEAD")
    ticket = wait_until(lambda: (t := env.ticket(key)["ticket"])["status"] == "blocked" and t, message="ticket blocked")
    assert ticket["blockedReason"].startswith("PLANNING_DIFF_INVALID"), ticket["blockedReason"]
    assert env.git("rev-parse", "HEAD") == head, "a planning commit was made"
    outside = os.path.join(env.workspace, "outside.txt")
    assert os.path.exists(outside), "outside.txt was reverted"
    env.mark_before()
    env.ok("ticket.unblock", recovery=True, workspace=env.workspace, key=key)
    wait_until(lambda: {"column": "refine", "reason": "MAIN_CHECKOUT_DIRTY"} in env.holds(), message="refine held dirty")
    assert env.status(key) == "refine"
    os.unlink(outside)
    env.commands.append({"argv": ["rm", "outside.txt"], "response": "ok"})
    env.wait_merged()


def drill_dirty_main(env, evidence):
    env.setup()
    key = env.keys[0]
    env.script(key, "review", 1, fake("verdict_pass", None, 4000))
    env.start_board()
    wait_until(lambda: env.status(key) in ("ready_review", "in_review"), interval=0.05, message="ready_review")
    scratch = os.path.join(env.workspace, "scratch.txt")
    with open(scratch, "w") as f:
        f.write("operator scratch\n")
    wait_until(lambda: env.status(key) == "ready_merge", message="ready_merge")
    wait_until(lambda: {"column": "merge", "reason": "MAIN_CHECKOUT_DIRTY"} in env.holds(), message="merge held dirty")
    env.stay(lambda: env.status(key) == "ready_merge", 2, "ticket merged with a dirty main checkout")
    env.mark_before()
    os.unlink(scratch)
    env.commands.append({"argv": ["rm", "scratch.txt"], "response": "ok"})
    env.wait_merged()


def drill_usage_limit(env, evidence):
    env.setup()
    key = env.keys[0]
    developer = env.developers[0]
    env.script(key, "develop", 1, fake("usage_limit", None, 200))
    env.start_board()
    released = wait_until(lambda: next((e for e in env.events(key) if e["name"] == "ticket.released"), None), message="ticket.released")
    assert released["payload"]["reason"] == "usage_limit", released
    ticket = env.ticket(key)["ticket"]
    assert ticket["status"] == "ready_dev", ticket["status"]
    assert env.sql("SELECT dev_rounds FROM tickets WHERE key = ?", (key,))[0][0] == 0, "the limited round was counted"
    agent = next(a for a in env.board()["agents"] if a["agentId"] == developer)
    assert agent["availability"] == "limit_reached", agent
    claims = len(names(env, key, "ticket.claimed"))
    env.mark_before()
    env.stay(lambda: env.status(key) == "ready_dev" and len(names(env, key, "ticket.claimed")) == claims,
             message="ticket reclaimed while the developer is limited")
    env.ok("board.resume", recovery=True, workspace=env.workspace, agentId=developer)
    env.wait_merged()


def drill_stuck_claim(env, evidence):
    env.setup(config={"leaseSeconds": 3600}, coordinator_env={"AGENT_STUDIO_TEST_CRASH_AT": "after_ticket_claim_commit"},
              status="ready_dev")
    key = env.keys[0]
    env.start_board()
    pid = env.coordinator_pid()
    wait_until(lambda: not os.path.exists(f"/proc/{pid}") or open(f"/proc/{pid}/stat").read().split()[2] == "Z",
               timeout=30, message="coordinator crashed at the claim")
    env.start_coordinator()
    env.commands.append({"argv": ["coordinator", "start", "--enable-debug"], "response": "ok"})

    def pending():
        order = [e["name"] for e in env.events(key)]
        claimed = max((i for i, n in enumerate(order) if n == "ticket.claimed"), default=-1)
        started = max((i for i, n in enumerate(order) if n == "ticket.run_started"), default=-1)
        return env.status(key) == "in_dev" and claimed > started
    env.stay(pending, message="the claim did not stay pending")
    env.mark_before()
    env.ok("ticket.retry", recovery=True, workspace=env.workspace, key=key)
    released = wait_until(lambda: next((e for e in env.events(key) if e["name"] == "ticket.released"), None), message="ticket.released")
    assert released["payload"]["reason"] == "operator_retry", released
    env.wait_merged()


DRILLS = {
    "coordinator_killed": drill_coordinator_killed,
    "runner_killed": drill_runner_killed,
    "merge_conflict": drill_merge_conflict,
    "round_limit": drill_round_limit,
    "planning_outside": drill_planning_outside,
    "dirty_main": drill_dirty_main,
    "usage_limit": drill_usage_limit,
    "stuck_claim": drill_stuck_claim,
}


def run_drill(name, evidence_dir=None):
    """Run one drill in a fresh Env.  `evidence_dir` is the run folder; the drill writes <evidence_dir>/<name>/."""
    env = Env(name)
    started = time.monotonic()
    result = {"name": name, "ok": False, "finalStatus": None}
    error = None
    try:
        DRILLS[name](env, evidence_dir)
        env.wait_merged()
        result["ok"] = True
    except BaseException as exc:  # a failed drill is a result; Ctrl-C still stops the run after cleanup
        error = f"{type(exc).__name__}: {exc}"
        if isinstance(exc, KeyboardInterrupt):
            raise
    finally:
        try:
            result["finalStatus"] = env.final_status()
        except Exception:
            result["finalStatus"] = None
        if evidence_dir:
            env.write_evidence(os.path.join(evidence_dir, name))
        env.cleanup()
    result["seconds"] = round(time.monotonic() - started, 1)
    if error:
        result["error"] = error
    return result


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Run the P03 board failure drills on the fake provider.")
    parser.add_argument("--provider", required=True, choices=["fake"])
    parser.add_argument("--only", nargs="+", metavar="NAME", choices=sorted(DRILLS))
    return parser.parse_args(argv)


def main(argv=None):
    ns = parse_args(argv)  # argparse exits 2 on a bad --provider or --only
    chosen = ns.only or list(DRILLS)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir = os.path.join(EVIDENCE_BASE, stamp)
    os.makedirs(run_dir, exist_ok=True)
    results = []
    for name in chosen:
        result = run_drill(name, run_dir)
        results.append(result)
        print(("PASS " if result["ok"] else "FAIL ") + name + ("" if result["ok"] else f"  {result.get('error')}"), flush=True)
    passed = sum(1 for r in results if r["ok"])
    summary = {"provider": "fake", "drills": results, "passed": passed, "failed": len(results) - passed}
    with open(os.path.join(run_dir, "summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)
        f.write("\n")
    print(f"{passed}/{len(results)} drills passed")
    print(f"evidence: {run_dir}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
