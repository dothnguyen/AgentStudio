#!/usr/bin/env python3
"""P00-S12 live gate - the WSL side. Run inside the target distro, from anywhere:

    python3 /mnt/c/Works/Projects/AgentStudio/scripts/live/live_gate.py run [--providers codex,claude]
            [--developer-model M] [--developer-reasoning R] [--reviewer-model M] [--reviewer-reasoning R]
            [--non-interactive] [--keep-team]

It drives the real backend through the same `agent-studio` entry shim a Windows caller uses, against two different
installed and authenticated providers, in a uniquely named disposable git workspace (never this repository), and
writes an evidence bundle to <state>/live-gate/<time>/ (outside the repository). Pre-existing tmux sessions, ~/.ntm
and other workspaces are inventoried before and after and never touched. Nothing here is a product feature.

    python3 live_gate.py make-workspace
        (used by the Windows script) creates a fresh disposable fixture repository and prints its path.
    python3 live_gate.py check-prompt --assignment ID --sha256 HEX
        (used by the Windows script) confirms the prompt the runner gave the provider contains the task text whose
        UTF-8 SHA-256 is HEX, byte for byte.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SHIM = os.path.join(REPO, "backend", "bin", "agent-studio")
PEERS = ("codex", "claude", "agy", "opencode")
TERMINAL = ("succeeded", "failed", "cancelled")
SETTLED = TERMINAL + ("waiting_input", "reconciling")
SLOW_TASK = ("Read every file in this repository. Then write a detailed explanation of each function and each test, "
             "at least 400 words in total. Do not modify anything.")
SECRET_RE = re.compile(r"(sk-[A-Za-z0-9_\-]{16,}|sk-ant-[A-Za-z0-9_\-]{10,}|eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}"
                       r"|(?i:bearer)\s+[A-Za-z0-9._\-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})")

FIXTURE_FILES = {
    "README.md": "# calc\n\nA tiny calculator used by the Agent Studio live gate.\n",
    "calc.py": "def add(a, b):\n    \"\"\"Return the sum of a and b.\"\"\"\n    return a - b\n\n\n"
               "def mul(a, b):\n    \"\"\"Return the product of a and b.\"\"\"\n    return a * b\n",
    "test_calc.py": "import unittest\n\nfrom calc import add, mul\n\n\nclass CalcTest(unittest.TestCase):\n"
                    "    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n\n"
                    "    def test_mul(self):\n        self.assertEqual(mul(2, 3), 6)\n\n\n"
                    "if __name__ == '__main__':\n    unittest.main()\n",
    ".agent-studio/workflow.json": json.dumps({"version": 1, "validation": {
        "argv": ["python3", "-m", "unittest", "-q", "test_calc"], "timeoutMs": 60000}}, indent=2) + "\n",
    ".agent-studio/roles.json": json.dumps({"version": 1, "roles": {
        "Developer": {"description": "Implements small, focused fixes", "instructions": "roles/developer.md"},
        "Reviewer": {"description": "Reviews diffs strictly but briefly", "instructions": "roles/reviewer.md"}}},
        indent=2) + "\n",
    ".agent-studio/roles/developer.md": "Change only what the task needs. Keep the existing style.\n",
    ".agent-studio/roles/reviewer.md": "Check that the change does what the task asks and nothing else.\n",
}
WORKFLOW_TASK = "Fix the bug in calc.py: add(a, b) must return the sum of a and b. Do not change the tests. FIXTURE-BUG"


class Gate:
    def __init__(self, ns):
        self.ns = ns
        self.stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        self.results = []
        self.evidence = {"recordedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "repo": REPO,
                         "shim": SHIM, "steps": self.results}
        self.assignments = set()
        self.workflows = set()
        self.team = None
        self.ws = None

    # ---- plumbing -------------------------------------------------------------------------------
    def cli(self, *args, stdin=None, timeout=120):
        p = subprocess.run([SHIM] + list(args), input=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=timeout)
        lines = [l for l in p.stdout.decode("utf-8", "replace").splitlines() if l.strip()]
        try:
            resp = json.loads(lines[-1]) if lines else None
        except ValueError:
            resp = None
        return resp or {"ok": False, "error": {"code": "NO_RESPONSE", "message": p.stderr.decode()[-500:]}}

    def req(self, command, args=None, key=None, timeout=120):
        r = {"protocol": "agent-studio/v1", "command": command, "args": args or {}}
        if key is not None:
            r["idempotencyKey"] = key
        return self.cli("request", stdin=json.dumps(r).encode("utf-8"), timeout=timeout)

    def snap(self):
        r = self.cli("snapshot", "--team", self.team["teamId"], "--include-stopped")
        if not r.get("ok"):
            raise RuntimeError(f"snapshot failed: {r}")
        return r["data"]

    def asg(self, asg_id):
        return next((a for a in self.snap()["assignments"] if a["id"] == asg_id), None)

    def wait(self, fn, timeout, what, interval=1.0):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            v = fn()
            if v:
                return v
            time.sleep(interval)
        raise TimeoutError(f"timed out after {timeout}s waiting for {what}")

    def wait_asg(self, asg_id, statuses=SETTLED, timeout=900):
        self.assignments.add(asg_id)
        return self.wait(lambda: (lambda a: a if a and a["status"] in statuses else None)(self.asg(asg_id)),
                         timeout, f"assignment {asg_id[:8]} -> {statuses}", interval=1.5)

    def direct(self, agent, text, policy="read_only", key=None, deadline_ms=None):
        args = {"teamId": self.team["teamId"], "agentId": agent, "policy": policy, "text": text}
        if deadline_ms:
            args["deadlineMs"] = deadline_ms
        r = self.req("task.direct", args, key or f"gate-{uuid.uuid4().hex}")
        if r.get("ok"):
            self.assignments.add(r["data"]["assignmentId"])
        return r

    def task_events(self, task_id):
        r = self.cli("task", "show", "--task", task_id)
        return r["data"]["events"] if r.get("ok") else []

    def provider_starts(self, task_id, asg_id):
        return sum(1 for e in self.task_events(task_id) if e.get("assignmentId") == asg_id
                   and e["name"] == "assignment.progress"
                   and (e.get("data") or {}).get("message") == "provider process started")

    def record(self, sid, title, prd, result, **details):
        self.results.append(dict({"id": sid, "title": title, "prd": prd, "result": result}, **details))
        colour = {"PASS": "32", "FAIL": "31", "BLOCKED": "31", "MANUAL": "33", "SKIP": "33"}.get(result, "0")
        print(f"\033[{colour}m{result:7}\033[0m {sid} {title}" + (f" - {details.get('note')}" if details.get("note") else ""),
              flush=True)
        return result == "PASS"

    def step(self, sid, title, prd, fn):
        print(f"\n== {sid} {title}", flush=True)
        try:
            fn(sid, title, prd)
        except Exception as e:  # a broken step is recorded, the gate continues where it safely can
            self.record(sid, title, prd, "FAIL", note=f"{type(e).__name__}: {e}")

    def ask(self, question):
        if self.ns.non_interactive:
            return None
        try:
            return input(f"\n>>> {question} [y/n] ").strip().lower().startswith("y")
        except EOFError:
            return None

    # ---- inventory --------------------------------------------------------------------------------
    @staticmethod
    def tmux_sessions(socket=None):
        argv = ["tmux"] + (["-L", socket] if socket else []) + ["list-sessions", "-F", "#{session_name} #{session_id}"]
        p = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return sorted(p.stdout.decode().split("\n")[:-1]) if p.returncode == 0 else []

    @staticmethod
    def ntm_inventory():
        root = os.path.expanduser("~/.ntm")
        if not os.path.isdir(root):
            return {"exists": False}
        h, n = hashlib.sha256(), 0
        for d, _, files in sorted(os.walk(root)):
            for f in sorted(files):
                p = os.path.join(d, f)
                try:
                    st = os.stat(p)
                except OSError:
                    continue
                h.update(f"{p}:{st.st_size}:{st.st_mtime_ns}\n".encode())
                n += 1
        return {"exists": True, "files": n, "fingerprint": h.hexdigest()}

    def inventory(self):
        socket = (self.team or {}).get("attach", {}).get("socket") or os.environ.get("AGENT_STUDIO_TMUX_SOCKET") \
            or "agent-studio"
        return {"defaultTmux": self.tmux_sessions(), "agentStudioTmux": self.tmux_sessions(socket),
                "ntm": self.ntm_inventory()}

    # ---- steps ------------------------------------------------------------------------------------
    def s_health(self, sid, title, prd):
        h = self.cli("health")
        self.evidence["health"] = h.get("data")
        c = self.cli("coordinator", "start")
        if not c.get("ok") and "older schema" in json.dumps(c):
            self.cli("coordinator", "stop")
            c = self.cli("coordinator", "start")
        self.evidence["coordinator"] = c.get("data")
        self.record(sid, title, prd, "PASS" if h.get("ok") and c.get("ok") else "FAIL",
                    note=f"coordinator pid {(c.get('data') or {}).get('pid')}")

    def s_providers(self, sid, title, prd):
        wanted = self.ns.providers.split(",") if self.ns.providers else list(PEERS)
        args = ["preflight", "--workspace", self.ws, "--deep"]
        for p in PEERS:
            args += ["--provider", p]
        for pol in ("read_only", "workspace_write"):
            args += ["--policy", pol]
        r = self.cli(*args, timeout=900)
        checks = ((r.get("data") or r.get("error", {}).get("details") or {}).get("checks")) or []
        ready, table = [], {}
        for p in PEERS:
            c = next((x for x in checks if x.get("name") == f"provider:{p}"), {})
            pr = c.get("probe") or {}
            pols = pr.get("policies") or {}
            ok = bool(c.get("ok")) and bool(pr.get("authVerified")) and \
                all(isinstance(pols.get(x), list) for x in ("read_only", "workspace_write"))
            err = c.get("error") or {}
            table[p] = {"ready": ok, "version": pr.get("version"), "authVerified": pr.get("authVerified"),
                        "code": pr.get("code") or err.get("code"), "reason": pr.get("reason") or err.get("message"),
                        "policies": pols}
            if ok and p in wanted:
                ready.append(p)
        self.evidence["providers"] = table
        if len(ready) < 2:
            self.record(sid, title, prd, "BLOCKED", note=f"need two different ready providers, have {ready}",
                        providers=table)
            raise SystemExit(self.finish())
        self.pair = ready[:2]
        self.record(sid, title, prd, "PASS", note=f"Developer={self.pair[0]}, Reviewer={self.pair[1]}",
                    providers=table)

    def make_workspace(self):
        root = os.path.expanduser("~/agent-studio-live")
        os.makedirs(root, exist_ok=True)
        self.ws = tempfile.mkdtemp(prefix=f"{self.stamp}-gate-", dir=root)
        for rel, text in FIXTURE_FILES.items():
            path = os.path.join(self.ws, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                f.write(text)
        self.git("init", "-q")
        self.commit("live gate fixture")
        self.evidence["workspace"] = self.ws
        self.evidence["baseCommit"] = self.git("rev-parse", "HEAD").strip()

    def git(self, *args):
        return subprocess.run(["git", "-C", self.ws, "-c", "user.name=Agent Studio Live Gate",
                               "-c", "user.email=live-gate@agent-studio.invalid"] + list(args),
                              check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.decode()

    def commit(self, msg):
        self.git("add", "-A")
        self.git("commit", "-q", "--allow-empty", "-m", msg)

    def s_launch(self, sid, title, prd):
        before = self.inventory()
        self.evidence["inventoryBefore"] = before
        roster = [{"providerId": self.pair[0], "role": "Developer", "name": f"dev-{self.pair[0]}"},
                  {"providerId": self.pair[1], "role": "Reviewer", "name": f"rev-{self.pair[1]}"}]
        for m, (model, reasoning) in zip(roster, ((self.ns.developer_model, self.ns.developer_reasoning),
                                                  (self.ns.reviewer_model, self.ns.reviewer_reasoning))):
            if model:
                m["model"] = model
            if reasoning:
                m["reasoning"] = reasoning
        r = self.req("team.start", {"workspace": self.ws, "roster": roster, "name": f"live-gate-{self.stamp}"},
                     f"gate-team-{self.stamp}", timeout=300)
        if not r.get("ok"):
            self.record(sid, title, prd, "FAIL", note=json.dumps(r.get("error")))
            raise SystemExit(self.finish())
        self.team = r["data"]
        self.dev, self.rev = (a["agentId"] for a in self.team["agents"])
        att = self.team["attach"]
        panes = subprocess.run(["tmux", "-L", att["socket"], "list-panes", "-s", "-t", "=" + att["sessionName"],
                                "-F", "#{pane_id}"], stdout=subprocess.PIPE).stdout.decode().split()
        after = self.inventory()
        new = sorted(set(after["agentStudioTmux"]) - set(before["agentStudioTmux"]))
        kept = set(before["agentStudioTmux"]) <= set(after["agentStudioTmux"]) and \
            before["defaultTmux"] == after["defaultTmux"]
        ok = len(panes) == 2 and len(new) == 1 and kept
        self.evidence["team"] = {k: self.team[k] for k in ("teamId", "name", "workspace", "agents", "attach")}
        self.record(sid, title, prd, "PASS" if ok else "FAIL", panes=panes, newSessions=new,
                    note=f"{len(panes)} panes in {att['sessionName']}; existing sessions untouched: {kept}")
        print(f"\n   Watch it from WSL:              {att['wsl']}\n"
              f"   or from Windows (PowerShell):   {att['windowsTerminal']}\n", flush=True)

    def s_direct(self, sid, title, prd):
        key = f"gate-direct-{self.stamp}"
        r = self.direct(self.rev, "Summarise README.md in one sentence.", key=key)
        if not r.get("ok"):
            return self.record(sid, title, prd, "FAIL", note=json.dumps(r.get("error")))
        a = self.wait_asg(r["data"]["assignmentId"])
        before = len(self.snap()["assignments"])
        again = self.direct(self.rev, "Summarise README.md in one sentence.", key=key)
        same = again.get("ok") and again["data"]["assignmentId"] == r["data"]["assignmentId"]
        no_new = len(self.snap()["assignments"]) == before
        ok = a["status"] == "succeeded" and same and no_new
        self.record(sid, title, prd, "PASS" if ok else "FAIL", assignment=a["id"], provider=self.pair[1],
                    summary=(a.get("result") or {}).get("summary", "")[:300], idempotentRetrySameAssignment=same,
                    note=f"{a['status']}; identical retry -> same assignment: {same}, no new assignment: {no_new}")

    def s_conflicts(self, sid, title, prd):
        r = self.direct(self.dev, "Create a file docs/NOTES.md that explains every function in calc.py and every test "
                                  "in test_calc.py, at least 400 words in total. Change nothing else.",
                        policy="workspace_write")
        if not r.get("ok"):
            return self.record(sid, title, prd, "FAIL", note=json.dumps(r.get("error")))
        busy = self.direct(self.dev, "Summarise README.md.")
        ws_busy = self.direct(self.rev, "Add a line to README.md.", policy="workspace_write")
        a = self.wait_asg(r["data"]["assignmentId"])
        for extra in (busy, ws_busy):  # if a check was wrongly accepted, let it finish before moving on
            if extra.get("ok"):
                self.wait_asg(extra["data"]["assignmentId"])
        busy_code = (busy.get("error") or {}).get("code")
        ws_code = (ws_busy.get("error") or {}).get("code")
        ok = busy_code == "AGENT_BUSY" and ws_code == "WORKSPACE_BUSY"
        self.commit("notes from the conflict check")  # keep the tree clean for the workflow
        self.record(sid, title, prd, "PASS" if ok else "FAIL", busyAgent=busy_code, busyWorkspace=ws_code,
                    writer=a["status"], note=f"busy agent -> {busy_code}; second writer -> {ws_code}; first: {a['status']}")

    def wait_idle(self, timeout=900):
        self.wait(lambda: all(a["status"] in SETTLED for a in self.snap()["assignments"]), timeout, "team idle", 2)

    def s_workflow(self, sid, title, prd):
        self.wait_idle()
        if self.git("status", "--porcelain").strip():
            self.commit("leftovers before the workflow")
        r = self.req("workflow.start", {"teamId": self.team["teamId"], "developerAgentId": self.dev,
                                        "reviewerAgentId": self.rev, "text": WORKFLOW_TASK}, f"gate-wf-{self.stamp}")
        if not r.get("ok"):
            return self.record(sid, title, prd, "FAIL", note=json.dumps(r.get("error")))
        wf_id = r["data"]["workflowRunId"]
        self.workflows.add(wf_id)
        att = self.team["attach"]
        watched = self.ask(f"The workflow is running. In another terminal attach with\n      {att['wsl']}\n"
                           "    watch both panes, detach (Ctrl-b d), attach again, and check work continues.\n"
                           "    Also try it from Windows Terminal:\n      " + att["windowsTerminal"] +
                           "\n    Did attach / detach / reattach work from WSL and from Windows Terminal, with the "
                           "team still running?")

        def done():
            d = self.cli("workflow", "show", "--workflow", wf_id)
            st = ((d.get("data") or {}).get("workflowRun") or {}).get("status")
            return d["data"] if st in ("succeeded", "failed", "cancelled", "paused") else None
        d = self.wait(done, 1800, "workflow", interval=3)
        wf = d["workflowRun"]
        for a in d.get("assignments", []):
            self.assignments.add(a["id"])
        providers = {a.get("providerId") for a in d.get("assignments", [])}
        stages = [{k: s.get(k) for k in ("stage", "status", "attempt", "outcome", "verdict", "validation", "diff")
                   if k in s} for s in d.get("stageAttempts", [])]
        fixed = "return a + b" in open(os.path.join(self.ws, "calc.py"), encoding="utf-8").read()
        ok = wf["status"] == "succeeded" and len(providers) >= 2 and fixed
        self.evidence["workflow"] = {"id": wf_id, "status": wf["status"], "providers": sorted(p for p in providers if p),
                                     "stages": stages}
        self.record(sid, title, prd, "PASS" if ok else "FAIL", workflow=wf_id, providers=sorted(p for p in providers if p),
                    stages=stages, note=f"{wf['status']}; providers {sorted(p for p in providers if p)}; bug fixed: {fixed}")
        self.record("5", "Attach / detach / reattach (WSL and Windows Terminal)", [5],
                    {True: "PASS", False: "FAIL", None: "MANUAL"}[watched],
                    note="operator confirmed" if watched else "not confirmed by the operator")
        if wf["status"] == "succeeded":
            self.commit("live gate workflow result")

    def s_restart(self, sid, title, prd):
        r = self.direct(self.rev, SLOW_TASK)
        asg = r["data"]["assignmentId"]
        self.wait_asg(asg, ("running",) + SETTLED, timeout=300)
        was = self.asg(asg)["status"]
        stop = self.cli("coordinator", "stop")
        time.sleep(5)
        start = self.cli("coordinator", "start")
        a = self.wait_asg(asg, timeout=900)
        resolved = None
        if a["status"] in ("reconciling", "waiting_input"):
            resolved = self.req("assignment.resolve", {"assignmentId": asg, "action": "fail"}, f"gate-res-{asg}")
            a = self.wait_asg(asg, TERMINAL, timeout=120)
        starts = self.provider_starts(a["taskId"], asg)
        ok = stop.get("ok") and start.get("ok") and starts == 1 and a["status"] in TERMINAL and a.get("attempt") == 1
        self.record(sid, title, prd, "PASS" if ok else "FAIL", assignment=asg, statusWhenStopped=was,
                    finalStatus=a["status"], providerStarts=starts, resolved=bool(resolved),
                    note=f"stopped while {was}; after restart {a['status']}; provider started {starts} time(s)"
                         + ("; resolved explicitly with action fail" if resolved else ""))

    def s_drills(self, sid, title, prd):
        out = {}
        # missing authentication: the real adapters, an empty credentials home
        sys.path.insert(0, os.path.join(REPO, "backend"))
        from agent_studio import providers as prov
        empty = tempfile.mkdtemp()
        for p in self.pair:
            env = dict(os.environ, HOME=empty, CODEX_HOME=empty, CLAUDE_CONFIG_DIR=empty)
            for k in ("OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
                      "CLAUDE_CODE_OAUTH_TOKEN"):
                env.pop(k, None)
            pr = prov.get(p).probe(env)
            out[f"auth:{p}"] = {"code": pr.get("code"), "reason": pr.get("reason"), "ok": pr.get("code") == "AUTH_REQUIRED"}
        # missing provider and unsupported permissions
        missing = [p for p in PEERS if p not in self.pair]
        r = self.req("team.start", {"workspace": self.ws, "roster": [{"providerId": missing[0], "role": "X"}]},
                     f"gate-missing-{self.stamp}")
        out["missingProvider"] = {"code": (r.get("error") or {}).get("code"), "ok": not r.get("ok")}
        r = self.req("task.direct", {"teamId": self.team["teamId"], "agentId": self.rev, "policy": "unrestricted",
                                     "text": "anything"}, f"gate-policy-{self.stamp}")
        out["unsupportedPolicy"] = {"code": (r.get("error") or {}).get("code"),
                                    "message": (r.get("error") or {}).get("message"), "ok": not r.get("ok")}
        # timeout, then the agent is usable again
        r = self.direct(self.dev, SLOW_TASK, deadline_ms=3000)
        a = self.wait_asg(r["data"]["assignmentId"], timeout=300)
        out["timeout"] = {"status": a["status"], "code": (a.get("result") or {}).get("diagnosticCode"),
                          "ok": a["status"] == "failed" and (a.get("result") or {}).get("diagnosticCode") == "TIMEOUT"}
        # provider killed mid-run (dead worker process): never succeeded
        r = self.direct(self.rev, SLOW_TASK)
        asg = r["data"]["assignmentId"]
        self.wait_asg(asg, ("running",) + SETTLED, timeout=300)
        meta = os.path.join(self.state_dir(), "runs", asg, "meta.json")
        pid = None
        self.wait(lambda: os.path.exists(meta), 60, "provider meta.json")
        with open(meta) as f:
            pid = json.load(f)["providerProcess"]["pid"]
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        a = self.wait_asg(asg, timeout=300)
        out["providerKilled"] = {"status": a["status"], "code": (a.get("result") or {}).get("diagnosticCode"),
                                 "ok": a["status"] != "succeeded"}
        # recovery: the same agent takes the next task
        r = self.direct(self.rev, "Reply with exactly RECOVERED and nothing else.")
        a = self.wait_asg(r["data"]["assignmentId"], timeout=600)
        out["recoveredAfterDrills"] = {"status": a["status"], "ok": a["status"] == "succeeded"}
        # malformed / absent final event cannot be forced from a real model: deterministic tests on captured output
        if self.ns.skip_deterministic:
            t = subprocess.CompletedProcess([], 0, b"skipped (--skip-deterministic)")
        else:
            t = subprocess.run([sys.executable, "-m", "unittest", "-q", "tests.unit.test_s08_settings_roles",
                                "tests.unit.test_s09_claude", "tests.unit.test_s04_contract"], cwd=REPO,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=600)
        out["malformedAndMissingFinal"] = {"tests": "test_s04_contract, test_s08_settings_roles, test_s09_claude",
                                           "ok": t.returncode == 0, "tail": t.stdout.decode()[-300:]}
        ok = all(v["ok"] for v in out.values())
        self.record(sid, title, prd, "PASS" if ok else "FAIL", drills=out,
                    note=", ".join(f"{k}:{'ok' if v['ok'] else 'NO'}" for k, v in out.items()))

    def s_repair_loop(self, sid, title, prd):
        t = subprocess.run([sys.executable, "-m", "unittest", "tests.integration.test_s06_workflow"], cwd=REPO,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=900)
        tail = t.stdout.decode()[-400:]
        self.record(sid, title, prd, "PASS" if t.returncode == 0 else "FAIL", tail=tail,
                    note="fake-adapter review -> repair -> pass, and second failure -> failed")

    def s_stop(self, sid, title, prd):
        before = self.evidence["inventoryBefore"]
        r = self.req("team.stop", {"teamId": self.team["teamId"]}, f"gate-stop-{self.stamp}", timeout=120)
        after = self.inventory()
        self.evidence["inventoryAfter"] = after
        ok = (r.get("ok") and after["defaultTmux"] == before["defaultTmux"]
              and after["agentStudioTmux"] == before["agentStudioTmux"] and after["ntm"] == before["ntm"]
              and os.path.isdir(self.ws))
        self.record(sid, title, prd, "PASS" if ok else "FAIL", stop=r.get("data") or r.get("error"),
                    note="other tmux sessions, ~/.ntm and the workspace unchanged" if ok else "inventory changed")

    # ---- evidence -----------------------------------------------------------------------------------
    def state_dir(self):
        return os.path.join(os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state"), "agent-studio")

    def finish(self):
        bundle = os.path.join(self.state_dir(), "live-gate", self.stamp)
        os.makedirs(bundle, exist_ok=True)
        for asg in sorted(self.assignments):
            src = os.path.join(self.state_dir(), "runs", asg)
            if os.path.isdir(src):
                shutil.copytree(src, os.path.join(bundle, "runs", asg), dirs_exist_ok=True)
        for wf in sorted(self.workflows):
            src = os.path.join(self.state_dir(), "workflows", wf)
            if os.path.isdir(src):
                shutil.copytree(src, os.path.join(bundle, "workflows", wf), dirs_exist_ok=True)
        counts = {r: sum(1 for x in self.results if x["result"] == r)
                  for r in ("PASS", "FAIL", "BLOCKED", "MANUAL", "SKIP")}
        gate = "PASS" if counts["FAIL"] == counts["BLOCKED"] == counts["MANUAL"] == counts["SKIP"] == 0 else \
            ("BLOCKED" if counts["BLOCKED"] else "INCOMPLETE")
        self.evidence.update(gate=gate, counts=counts, bundle=bundle)
        with open(os.path.join(bundle, "summary.json"), "w", encoding="utf-8") as f:
            json.dump(self.evidence, f, indent=2, ensure_ascii=True, default=str)
        redacted = 0
        for d, _, files in os.walk(bundle):
            for name in files:
                p = os.path.join(d, name)
                try:
                    text = open(p, encoding="utf-8").read()
                except (UnicodeDecodeError, OSError):
                    continue
                new, n = SECRET_RE.subn("[REDACTED]", text)
                if n:
                    redacted += n
                    with open(p, "w", encoding="utf-8") as f:
                        f.write(new)
        print(f"\nLIVE GATE: {gate}  {counts}  (secret-like strings redacted: {redacted})\nEvidence: {bundle}\n"
              f"Copy it into the repo after review:  cp -r {bundle} {REPO}/phases/phase-00/evidence/s12/", flush=True)
        return 0 if gate == "PASS" else 1

    def run(self):
        self.make_workspace()
        self.step("1a", "Health and coordinator", [1], self.s_health)
        self.step("1b", "Two different ready providers (deep preflight)", [1, 3, 8], self.s_providers)
        self.step("1c", "Launch the team: one pane per agent, no collisions", [1], self.s_launch)
        self.step("2a", "Direct read_only task and idempotent retry", [2], self.s_direct)
        self.step("2b", "Busy agent and second workspace writer rejected", [2], self.s_conflicts)
        self.step("3", "Automatic Developer -> Reviewer workflow across two providers", [3, 5], self.s_workflow)
        self.step("6", "Coordinator restart during an assignment", [6], self.s_restart)
        self.step("8", "Failure drills with recovery", [8], self.s_drills)
        if self.ns.skip_deterministic:  # only for the gate's own dry run, which already runs inside the test suite
            self.record("4", "Deterministic repair loop (fake adapter)", [4], "SKIP", note="--skip-deterministic")
        else:
            self.step("4", "Deterministic repair loop (fake adapter)", [4], self.s_repair_loop)
        if not self.ns.keep_team:
            self.step("7", "Scoped stop", [7], self.s_stop)
        return self.finish()


def check_prompt(ns):
    path = os.path.join(os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state"), "agent-studio",
                        "runs", ns.assignment, "prompt.txt")
    with open(path, "rb") as f:
        data = f.read()
    m = re.search(rb"===== TASK =====\n(.*)\n===== END TASK =====\n\Z", data, re.S)
    got = hashlib.sha256(m.group(1)).hexdigest() if m else None
    out = {"assignment": ns.assignment, "expected": ns.sha256, "taskSha256": got, "match": got == ns.sha256,
           "promptBytes": len(data)}
    print(json.dumps(out))
    return 0 if out["match"] else 1


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--providers")
    r.add_argument("--developer-model")
    r.add_argument("--developer-reasoning")
    r.add_argument("--reviewer-model")
    r.add_argument("--reviewer-reasoning")
    r.add_argument("--non-interactive", action="store_true")
    r.add_argument("--keep-team", action="store_true")
    r.add_argument("--skip-deterministic", action="store_true", help=argparse.SUPPRESS)
    sub.add_parser("make-workspace")
    c = sub.add_parser("check-prompt")
    c.add_argument("--assignment", required=True)
    c.add_argument("--sha256", required=True)
    ns = ap.parse_args()
    if ns.cmd == "check-prompt":
        return check_prompt(ns)
    if ns.cmd == "make-workspace":  # for the Windows script: a fresh disposable fixture repo
        g = Gate(ns)
        g.make_workspace()
        print(json.dumps({"workspace": g.ws, "baseCommit": g.evidence["baseCommit"]}))
        return 0
    return Gate(ns).run()


if __name__ == "__main__":
    sys.exit(main())
