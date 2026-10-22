"""P00-S07 failure drills through the real coordinator, tmux workers, runner and fake provider.
Each drill checks: a truthful visible state, a documented command that resolves it, and exactly one provider
execution (one run folder with one provider start) per assignment."""
import json
import os
import signal
import subprocess
import tempfile
import time
import unittest

from tests.helpers import SHIM, Sandbox, key, make_repo, req, reset_repo, wait_until
from agent_studio import procid, reports, state
from agent_studio.providers.base import REPORT_PROTOCOL

ALIASES = {"AGENT_STUDIO_TEST_FIXTURE_PROVIDERS": "codex=fake,claude=fake,agy=fake,opencode=fake"}
TERMINAL = ("succeeded", "failed", "cancelled")


def fake(scenario, duration=200, write=None):
    o = {"scenario": scenario, "durationMs": duration, "progressLines": 1}
    if write:
        o["writeFile"] = write
    return o


class Drill(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox(extra_env=ALIASES)
        self.start_coordinator()
        self.ws = make_repo()
        rc, r, _ = self.sb.request(req("team.start", {"workspace": self.ws, "roster": [
            {"providerId": "codex", "role": "developer"}, {"providerId": "claude", "role": "reviewer"}]},
            idempotencyKey=key()))
        self.assertTrue(r["ok"], r)
        self.team = r["data"]
        self.a0, self.a1 = (a["agentId"] for a in self.team["agents"])

    def tearDown(self):
        self.sb.cleanup()

    # ---- helpers ------------------------------------------------------------------------------
    def start_coordinator(self, crash_at=None):
        if crash_at:
            self.sb.env["AGENT_STUDIO_TEST_CRASH_AT"] = crash_at
        else:
            self.sb.env.pop("AGENT_STUDIO_TEST_CRASH_AT", None)
        rc, r, p = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(r["ok"], (r, p.stderr))
        return r["data"]["pid"]

    def coordinator_pid(self):
        c = self.sb.run("health")[1]["data"]["coordinator"]
        return c["pid"] if c["running"] else None

    def restart_after_crash(self):
        wait_until(lambda: self.coordinator_pid() is None, timeout=20, message="coordinator to crash")
        self.start_coordinator()

    def direct(self, agent, scenario="success", duration=200, k=None, timeout_ms=None, policy="read_only", **extra):
        msg = req("task.direct", dict({"teamId": self.team["teamId"], "agentId": agent, "policy": policy,
                                       "text": "drill", "debugProviderOptions": fake(scenario, duration)}, **extra),
                  idempotencyKey=k or key("drill"))
        if timeout_ms:
            msg["timeoutMs"] = timeout_ms
        return self.sb.request(msg)[1]

    def resolve(self, asg, action, **extra):
        rc, r, _ = self.sb.request(req("assignment.resolve", dict({"assignmentId": asg, "action": action}, **extra),
                                       idempotencyKey=key("resolve")))
        return r

    def snap(self):
        return self.sb.snapshot(self.team["teamId"])

    def asg(self, aid):
        return next(a for a in self.snap()["assignments"] if a["id"] == aid)

    def wait_asg(self, aid, statuses, timeout=30):
        statuses = (statuses,) if isinstance(statuses, str) else statuses
        return wait_until(lambda: self.asg(aid)["status"] in statuses and self.asg(aid), timeout=timeout,
                          message=f"{aid[:8]} -> {statuses}")

    def task_assignments(self, task_id):
        return [a for a in self.snap()["assignments"] if a["taskId"] == task_id]

    def provider_starts(self, aid):
        rc, r, _ = self.sb.run("events", "--team", self.team["teamId"], "--limit", "1000")
        return len([e for e in r["data"]["events"] if e.get("assignmentId") == aid
                    and e["name"] == "assignment.progress" and e["data"].get("providerProcess")])

    def assert_ran_once(self, task_id):
        asgs = self.task_assignments(task_id)
        self.assertEqual(len(asgs), 1, "one assignment per task")
        runs = os.listdir(os.path.join(self.sb.state_dir, "runs"))
        self.assertEqual(runs.count(asgs[0]["id"]), 1)
        self.assertEqual(self.provider_starts(asgs[0]["id"]), 1, "exactly one provider execution")
        return asgs[0]


class CoordinatorCrashes(Drill):
    def test_crash_before_intent_commit(self):
        self.sb.run("coordinator", "stop")
        self.start_coordinator("before_command_commit")
        k = key("crash1")
        first = self.direct(self.a0, k=k, timeout_ms=3000)
        self.assertEqual(first["error"]["code"], "PENDING")  # a missed response, never a guess
        self.restart_after_crash()
        again = wait_until(lambda: (lambda r: r["ok"] and r)(self.direct(self.a0, k=k)), message="receipt")
        self.wait_asg(again["data"]["assignmentId"], "succeeded")
        self.assert_ran_once(again["data"]["taskId"])

    def test_crash_after_intent_before_claim(self):
        self.sb.run("coordinator", "stop")
        self.start_coordinator("after_command_commit")
        k = key("crash2")
        self.direct(self.a0, k=k, timeout_ms=3000)
        self.restart_after_crash()
        r = self.direct(self.a0, k=k)
        self.assertTrue(r["ok"], r)
        self.wait_asg(r["data"]["assignmentId"], "succeeded")
        self.assert_ran_once(r["data"]["taskId"])

    def test_crash_after_claim_before_request_file(self):
        self.sb.run("coordinator", "stop")
        self.start_coordinator("after_claim_commit")
        r = self.direct(self.a0, timeout_ms=5000)
        self.restart_after_crash()
        task = r["data"]["taskId"] if r.get("ok") else self.snap()["tasks"][0]["id"]
        a = self.task_assignments(task)[0]
        self.wait_asg(a["id"], "succeeded")
        self.assert_ran_once(task)

    def test_crash_while_running_and_while_applying_the_final_report(self):
        r = self.direct(self.a0, scenario="slow", duration=4000)
        aid = r["data"]["assignmentId"]
        self.wait_asg(aid, "running")
        os.kill(self.coordinator_pid(), signal.SIGKILL)
        time.sleep(1)
        self.start_coordinator("before_report_apply_commit")  # dies while applying the next report
        self.restart_after_crash()
        self.wait_asg(aid, "succeeded")
        self.assert_ran_once(r["data"]["taskId"])
        conn = state.connect(state.db_path(self.sb.state_dir), role="reader")
        dup = conn.execute("SELECT report_id, COUNT(*) FROM report_applications GROUP BY report_id HAVING COUNT(*) > 1"
                           ).fetchall()
        self.assertEqual(dup, [])

    def test_runner_finishes_while_coordinator_is_down(self):
        r = self.direct(self.a0, scenario="slow", duration=2500)
        aid = r["data"]["assignmentId"]
        self.wait_asg(aid, "running")
        self.sb.run("coordinator", "stop")
        time.sleep(4)
        self.assertEqual(self.asg(aid)["status"], "running")  # nothing applies reports while it is down
        self.start_coordinator()
        self.wait_asg(aid, "succeeded")
        self.assert_ran_once(r["data"]["taskId"])


class RunnerAndPaneLoss(Drill):
    def test_runner_killed_then_resolve_retry_runs_a_new_attempt(self):
        r = self.direct(self.a0, scenario="slow", duration=30000)
        aid = r["data"]["assignmentId"]
        a = self.wait_asg(aid, "running")
        os.kill(a["processPid"], signal.SIGKILL)
        a = self.wait_asg(aid, "reconciling")
        self.assertEqual(a["diagnosticCode"], "RUNNER_GONE")
        self.assertEqual(self.resolve(aid, "fail", policy="read_only")["error"]["code"], "BAD_REQUEST")
        out = self.resolve(aid, "retry", debugProviderOptions=fake("success"))
        self.assertTrue(out["ok"], out)
        new = self.wait_asg(out["data"]["newAssignmentId"], "succeeded")
        self.assertEqual(new["attempt"], 2)
        self.assertEqual((self.asg(aid)["status"], self.asg(aid)["diagnosticCode"]), ("failed", "SUPERSEDED_BY_RETRY"))
        self.assertEqual(next(t for t in self.snap()["tasks"] if t["id"] == r["data"]["taskId"])["status"], "succeeded")
        self.assertEqual(self.provider_starts(aid), 1)
        self.assertEqual(self.provider_starts(new["id"]), 1)

    def test_saved_result_applied_when_the_report_was_lost(self):
        r = self.direct(self.a1, scenario="slow", duration=30000)
        aid = r["data"]["assignmentId"]
        a = self.wait_asg(aid, "running")
        wait_until(lambda: self.provider_starts(aid) == 1)
        os.kill(a["processPid"], signal.SIGSTOP)  # freeze the runner, then write what it would have saved
        result = {"protocol": REPORT_PROTOCOL, "assignmentId": aid, "agentId": self.a1, "providerId": "claude",
                  "attempt": 1, "policy": "read_only", "status": "succeeded", "exitCode": 0, "summary": "saved",
                  "artifacts": [], "attention": None, "diagnosticCode": None,
                  "evidence": {"providerTerminalEvent": True, "terminalOk": True, "signal": None, "timedOut": False,
                               "cancelRequested": False, "truncated": False, "validation": []}}
        with open(os.path.join(self.sb.state_dir, "runs", aid, "result.json"), "w") as f:
            json.dump(result, f)
        os.kill(a["processPid"], signal.SIGKILL)
        a = self.wait_asg(aid, "succeeded")
        self.assertEqual(a["result"]["summary"], "saved")
        rc, ev, _ = self.sb.run("events", "--team", self.team["teamId"], "--limit", "1000")
        rec = [e for e in ev["data"]["events"] if e["name"] == "assignment.reconciled" and e["entityId"] == aid]
        self.assertEqual(rec[0]["data"]["source"], "result.json")

    def test_dead_pane_mid_assignment(self):
        r = self.direct(self.a0, scenario="slow", duration=30000)
        aid = r["data"]["assignmentId"]
        self.wait_asg(aid, "running")
        pane = self.team["agents"][0]["paneId"]
        pid = int(self.sb.tmux("display-message", "-p", "-t", pane, "#{pane_pid}"))
        os.killpg(os.getpgid(pid), signal.SIGKILL)
        a = self.wait_asg(aid, ("reconciling", "cancelled"))
        self.assertNotEqual(a["status"], "succeeded")
        if a["status"] == "reconciling":
            self.assertEqual(self.resolve(aid, "retry")["error"]["code"], "AGENT_UNAVAILABLE")
            self.assertEqual(self.resolve(aid, "fail")["data"]["status"], "failed")
        self.assertIn(next(t for t in self.snap()["tasks"] if t["id"] == r["data"]["taskId"])["status"],
                      ("failed", "cancelled"))
        self.assertEqual(next(g for g in self.snap()["agents"] if g["id"] == self.a0)["availability"], "offline")


class ResolveDrills(Drill):
    def test_waiting_input_retry_with_explicit_policy_change(self):
        r = self.direct(self.a1, scenario="permission_denied")
        aid = r["data"]["assignmentId"]
        self.wait_asg(aid, "waiting_input")
        self.assertEqual(self.resolve(aid, "fail", policy="workspace_write")["error"]["code"], "BAD_REQUEST")
        out = self.resolve(aid, "retry", policy="workspace_write", debugProviderOptions=fake("success"))
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["data"]["policyChange"], {"from": "read_only", "to": "workspace_write"})
        new = self.wait_asg(out["data"]["newAssignmentId"], "succeeded")
        self.assertEqual(new["policy"], "workspace_write")
        rc, ev, _ = self.sb.run("events", "--team", self.team["teamId"], "--limit", "1000")
        retried = [e for e in ev["data"]["events"] if e["name"] == "task.retried"]
        self.assertEqual(retried[0]["data"]["policyChange"]["to"], "workspace_write")

    def test_waiting_input_fail_and_cancel(self):
        for action, status in (("fail", "failed"), ("cancel", "cancelled")):
            r = self.direct(self.a1, scenario="waiting_input")
            aid = r["data"]["assignmentId"]
            self.wait_asg(aid, "waiting_input")
            out = self.resolve(aid, action)
            self.assertEqual(out["data"]["status"], status)
            task = next(t for t in self.snap()["tasks"] if t["id"] == r["data"]["taskId"])
            self.assertEqual(task["status"], status)
            wait_until(lambda: next(g for g in self.snap()["agents"] if g["id"] == self.a1)["availability"] == "idle")

    def test_guards(self):
        r = self.direct(self.a0, scenario="slow", duration=20000)
        aid = r["data"]["assignmentId"]
        self.wait_asg(aid, "running")
        self.assertEqual(self.resolve(aid, "fail")["error"]["code"], "RESOLVE_NOT_ALLOWED")
        self.assertEqual(self.resolve(aid, "bogus")["error"]["code"], "BAD_REQUEST")

    def test_malformed_report_is_rejected_visibly(self):
        r = self.direct(self.a0, scenario="slow", duration=2500)
        aid = r["data"]["assignmentId"]
        self.wait_asg(aid, "running")
        conn = state.connect(state.db_path(self.sb.state_dir), role="runner")
        reports.submit(conn, aid, 900, "final", {"agentId": self.a0, "attempt": 1, "status": "succeeded"})
        rc, ev, _ = self.sb.run("events", "--team", self.team["teamId"], "--limit", "1000")
        wait_until(lambda: [e for e in self.sb.run("events", "--team", self.team["teamId"], "--limit", "1000")[1]
                            ["data"]["events"] if e["name"] == "assignment.report_rejected"], message="rejection event")
        self.assertEqual(self.asg(aid)["status"], "running")
        self.wait_asg(aid, "succeeded")  # the runner's real report still settles it

    def test_timeout_in_a_workflow_then_resume(self):
        ws = make_repo({"version": 1, "validation": {"argv": ["python3", "check.py"], "timeoutMs": 20000},
                        "stageDeadlineMs": 1500})
        rc, t, _ = self.sb.request(req("team.start", {"workspace": ws, "roster": [
            {"providerId": "agy", "role": "developer"}, {"providerId": "opencode", "role": "reviewer"}]},
            idempotencyKey=key()))
        dev_agent, rev_agent = (a["agentId"] for a in t["data"]["agents"])
        rc, r, _ = self.sb.request(req("workflow.start", {
            "teamId": t["data"]["teamId"], "developerAgentId": dev_agent, "reviewerAgentId": rev_agent, "text": "t",
            "debugStageOptions": {"developer": fake("timeout"), "reviewer": fake("verdict_pass")}},
            idempotencyKey=key()))
        wf = r["data"]["workflowRunId"]
        show = lambda: self.sb.run("workflow", "show", "--workflow", wf)[1]["data"]
        d = wait_until(lambda: show()["workflowRun"]["status"] == "paused" and show(), timeout=30, message="paused")
        paused = [e for e in d["events"] if e["name"] == "workflow_run.paused"][0]
        self.assertEqual(paused["data"]["diagnosticCode"], "TIMEOUT")
        dev = d["assignments"][0]["id"]
        out = self.resolve(dev, "retry", debugProviderOptions=fake("success", write="fixed.txt"))
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["data"]["stage"], "developer")
        d = wait_until(lambda: show()["workflowRun"]["status"] in TERMINAL and show(), timeout=40)
        self.assertEqual((d["workflowRun"]["status"], d["task"]["status"]), ("succeeded", "succeeded"))
        self.assertEqual([s["status"] for s in d["stageAttempts"]], ["abandoned", "completed", "completed", "completed"])   # S06: the validation stage is an attempt
        self.assertEqual(len([e for e in d["events"] if e["name"] == "workflow_run.resumed"]), 1)

    def test_direct_timeout_is_final_and_redone_as_a_new_task(self):
        r = self.direct(self.a0, scenario="timeout", deadlineMs=1500)
        a = self.wait_asg(r["data"]["assignmentId"], "failed")
        self.assertEqual(a["result"]["diagnosticCode"], "TIMEOUT")
        self.assertEqual(self.resolve(a["id"], "retry")["error"]["code"], "RESOLVE_NOT_ALLOWED")
        wait_until(lambda: next(g for g in self.snap()["agents"] if g["id"] == self.a0)["availability"] == "idle")
        again = self.direct(self.a0)
        self.wait_asg(again["data"]["assignmentId"], "succeeded")

    def test_paused_workflow_resolved_as_failed(self):
        rc, r, _ = self.sb.request(req("workflow.start", {
            "teamId": self.team["teamId"], "developerAgentId": self.a0, "reviewerAgentId": self.a1, "text": "t",
            "debugStageOptions": {"developer": fake("success", write="fixed.txt"), "reviewer": fake("verdict_malformed")}},
            idempotencyKey=key()))
        wf = r["data"]["workflowRunId"]
        show = lambda: self.sb.run("workflow", "show", "--workflow", wf)[1]["data"]
        wait_until(lambda: show()["workflowRun"]["status"] == "paused", timeout=40)
        reviewer_asg = show()["assignments"][1]["id"]
        self.assertEqual(self.resolve(reviewer_asg, "retry", policy="workspace_write")["error"]["code"], "BAD_REQUEST")
        self.assertEqual(self.resolve(reviewer_asg, "fail")["data"]["status"], "failed")
        d = show()
        self.assertEqual((d["workflowRun"]["status"], d["task"]["status"]), ("failed", "failed"))


class StartupAndStop(Drill):
    def test_orphan_sessions_at_startup(self):
        self.sb.run("coordinator", "stop")
        self.sb.tmux("new-session", "-d", "-s", "as-0000000000000000", "sleep 600")
        self.sb.tmux("set-option", "-t", "as-0000000000000000", "@agent_studio_team",
                     "99999999-9999-4999-8999-999999999999")
        from agent_studio.store import Store
        conn = state.connect(state.db_path(self.sb.state_dir), role="coordinator")
        st = Store(conn)
        with st.transaction() as tx:  # a stop that committed but crashed before killing the session
            tx.transition("team", self.team["teamId"], "stopping")
            tx.transition("team", self.team["teamId"], "stopped")
        conn.close()
        self.start_coordinator()
        runtime = json.load(open(os.path.join(self.sb.state_dir, "runtime.json")))
        orphans = {o["session_name"]: o["action"] for o in runtime["startupReconciliation"]["orphanSessions"]}
        self.assertEqual(orphans["as-0000000000000000"], "preserved")
        self.assertEqual(orphans["as-" + self.team["teamId"].replace("-", "")[:16]], "removed")
        sessions = self.sb.tmux("list-sessions", "-F", "#{session_name}")
        self.assertIn("as-0000000000000000", sessions)
        self.assertNotIn(self.team["teamId"].replace("-", "")[:16], sessions)

    def test_stop_waits_for_runners_and_leaves_no_process(self):
        r = self.direct(self.a0, scenario="slow", duration=30000)
        aid = r["data"]["assignmentId"]
        a = self.wait_asg(aid, "running")
        wait_until(lambda: self.provider_starts(aid) == 1)
        meta = json.load(open(os.path.join(self.sb.state_dir, "runs", aid, "meta.json")))
        rc, out, _ = self.sb.request(req("team.stop", {"teamId": self.team["teamId"]}, idempotencyKey=key()))
        self.assertTrue(out["ok"], out)
        runner = {"pid": a["processPid"], "startTime": a["processStartTime"], "bootId": a["processBootId"]}
        self.assertFalse(procid.matches(runner))
        self.assertFalse(procid.matches(meta["providerProcess"]))
        self.assertEqual(self.asg(aid)["status"], "cancelled")


if __name__ == "__main__":
    unittest.main()
