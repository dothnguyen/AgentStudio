"""P00-S04: the real runner with the fake provider - every scenario, evidence, limits, cancel, timeout,
injection safety, coordinator-down operation, and the full tmux worker path."""
import hashlib
import json
import os
import signal
import stat
import tempfile
import time
import unittest

from tests.helpers import REPO, Sandbox, key, req, wait_until
from tests.runner_harness import RunnerHarness
from agent_studio import procid

FIX = os.path.join(REPO, "tests", "fixtures", "contract", "scenarios.json")
HOSTILE_GOAL = ("Fix it'; rm -rf ~; echo \"$(touch CANARY_DOLLAR)\" `touch CANARY_BACKTICK` && touch CANARY_AND\n"
                "second line\t漢字 \U0001F600 %PATH% $HOME ${IFS} | > CANARY_REDIRECT")


class Scenarios(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sb = Sandbox()
        cls.ws = tempfile.mkdtemp(prefix="as-ws-")
        cls.h = RunnerHarness(cls.sb, cls.ws)

    @classmethod
    def tearDownClass(cls):
        cls.sb.cleanup()

    def test_every_fixture_scenario(self):
        with open(FIX, encoding="utf-8") as f:
            cases = json.load(f)["cases"]
        for case in cases:
            with self.subTest(case["scenario"]):
                options = dict({"scenario": case["scenario"], "durationMs": 50, "progressLines": 2},
                               **case.get("options", {}))
                extra = {k: case[k] for k in ("deadlineMs", "outputBudgetBytes") if k in case}
                task, asg = self.h.claimed(options=options, **extra)
                rc, out, err = self.h.run(asg)
                r = self.h.result(asg)
                for k, v in case["expect"].items():
                    actual = r["evidence"][k] if k == "providerTerminalEvent" else r.get(k)
                    self.assertEqual(actual, v, (case["scenario"], k, out[-800:]))
                self.assertEqual(rc, 0 if r["status"] == "succeeded" else 1)
                self.h.apply()
                row = self.h.row("assignments", asg)
                a_state = {"succeeded": "succeeded", "failed": "failed", "cancelled": "cancelled",
                           "waiting_input": "waiting_input", "inconclusive": "reconciling"}[r["status"]]
                self.assertEqual(row["status"], a_state)
                self.assertEqual(json.loads(row["result_json"])["status"], r["status"])
                meta = json.load(open(self.h.evidence(asg, "meta.json")))
                self.assertFalse(procid.matches(meta["providerProcess"]), "provider must not outlive the runner")
                if case["scenario"] == "flood":
                    self.assertTrue(r["evidence"]["truncated"])
                    self.assertLessEqual(os.path.getsize(self.h.evidence(asg, "stdout.jsonl")), 4096)
                with self.h.conn:
                    # reset the agent for the next case (operator resolution arrives in S07)
                    self.h.conn.execute("UPDATE agents SET availability = 'idle' WHERE id = ?", (self.h.agent,))

    def test_prompt_reaches_provider_unchanged_and_is_never_executed(self):
        task, asg = self.h.claimed(goal=HOSTILE_GOAL, options={"scenario": "success", "durationMs": 10})
        rc, out, err = self.h.run(asg)
        self.assertEqual(rc, 0, out)
        prompt = open(self.h.evidence(asg, "prompt.txt"), "rb").read()
        self.assertTrue(prompt.endswith(("===== TASK =====\n" + HOSTILE_GOAL + "\n===== END TASK =====\n").encode("utf-8")))
        events = [json.loads(l) for l in open(self.h.evidence(asg, "stdout.jsonl"), encoding="utf-8")]
        self.assertEqual(events[0]["promptSha256"], hashlib.sha256(prompt).hexdigest())
        for where in (self.ws, os.getcwd(), os.path.expanduser("~")):
            self.assertEqual([n for n in os.listdir(where) if n.startswith("CANARY")], [], where)
        meta = json.load(open(self.h.evidence(asg, "meta.json")))
        self.assertNotIn(HOSTILE_GOAL, json.dumps(meta["argv"]))

    def test_evidence_is_private_and_env_is_allowlisted(self):
        task, asg = self.h.claimed(options={"scenario": "success", "durationMs": 10})
        rc, out, err = self.h.run(asg, env={"SECRET_TOKEN": "s3cr3t", "AGENT_STUDIO_EXTRA": "x"})
        meta = json.load(open(self.h.evidence(asg, "meta.json")))
        self.assertNotIn("SECRET_TOKEN", meta["envKeys"])
        self.assertNotIn("AGENT_STUDIO_EXTRA", meta["envKeys"])
        self.assertIn("PATH", meta["envKeys"])
        for name in ("prompt.txt", "stdout.jsonl", "stderr.log", "meta.json", "result.json"):
            self.assertEqual(stat.S_IMODE(os.stat(self.h.evidence(asg, name)).st_mode), 0o600, name)
        self.assertIn("diagnostics on stderr", open(self.h.evidence(asg, "stderr.log")).read())
        self.assertNotIn("s3cr3t", open(self.h.evidence(asg, "stdout.jsonl")).read())

    def test_policy_controls_writes(self):
        task, asg = self.h.claimed(policy="read_only", options={"scenario": "success", "durationMs": 10,
                                                                "writeFile": "out/ro.txt"})
        self.h.run(asg)
        self.assertEqual(self.h.result(asg)["status"], "waiting_input")
        self.assertFalse(os.path.exists(os.path.join(self.ws, "out", "ro.txt")))
        task, asg = self.h.claimed(policy="workspace_write", options={"scenario": "success", "durationMs": 10,
                                                                      "writeFile": "out/rw.txt"})
        self.h.run(asg)
        self.assertEqual(self.h.result(asg)["status"], "succeeded")
        self.assertTrue(os.path.exists(os.path.join(self.ws, "out", "rw.txt")))

    def test_unmapped_policy_refused_before_any_process(self):
        task, asg = self.h.claimed(policy="workspace_write", options={"scenario": "success"})
        rc, out, err = self.h.run(asg, env={"AGENT_STUDIO_FAKE_POLICIES": "read_only"})
        r = self.h.result(asg)
        self.assertEqual((r["status"], r["diagnosticCode"]), ("failed", "POLICY_UNSUPPORTED"))
        self.assertFalse(os.path.exists(self.h.evidence(asg, "meta.json")))  # nothing was started

    def test_cancel_by_signal_to_runner(self):
        task, asg = self.h.claimed(options={"scenario": "slow", "durationMs": 30000, "progressLines": 30})
        p = self.h.popen(asg)
        wait_until(lambda: os.path.exists(self.h.evidence(asg, "meta.json")), message="provider start")
        meta = json.load(open(self.h.evidence(asg, "meta.json")))
        p.send_signal(signal.SIGTERM)
        p.communicate(timeout=20)
        r = self.h.result(asg)
        self.assertEqual((r["status"], r["diagnosticCode"]), ("cancelled", "CANCELLED"))
        self.assertTrue(r["evidence"]["cancelRequested"])
        self.assertFalse(procid.matches(meta["providerProcess"]))

    def test_killed_runner_takes_the_provider_with_it(self):
        task, asg = self.h.claimed(options={"scenario": "slow", "durationMs": 30000, "progressLines": 30})
        p = self.h.popen(asg)
        wait_until(lambda: os.path.exists(self.h.evidence(asg, "meta.json")), message="provider start")
        meta = json.load(open(self.h.evidence(asg, "meta.json")))
        p.kill()
        p.communicate(timeout=20)
        wait_until(lambda: not procid.matches(meta["providerProcess"]), timeout=5, message="provider to die")
        self.assertFalse(os.path.exists(self.h.evidence(asg, "result.json")))
        self.h.apply()
        self.assertEqual(self.h.row("assignments", asg)["status"], "running")  # explicit, never invented success

    def test_report_for_another_assignment_cannot_finish_this_one(self):
        task_a, a = self.h.claimed(options={"scenario": "success", "durationMs": 10})
        task_b, b = self.h.claimed(options={"scenario": "success", "durationMs": 10})
        self.h.run(a)
        self.h.apply()
        from agent_studio import reports, state
        forged = dict(self.h.result(a))  # a valid report, but for assignment a
        runner_conn = state.connect(self.h.db, role="runner")
        reports.submit(runner_conn, b, 0, "start", {"agentId": self.h.agent, "attempt": 1, "pid": os.getpid(),
                                                   "startTime": procid.start_time(os.getpid()), "bootId": procid.boot_id()})
        reports.submit(runner_conn, b, 1, "final", forged)
        self.h.apply()
        self.assertEqual(self.h.row("assignments", b)["status"], "running")
        outcome = self.h.conn.execute("SELECT outcome FROM report_applications ORDER BY report_id DESC LIMIT 1").fetchone()[0]
        self.assertEqual(outcome, "rejected:REPORT_MISMATCH")


class ThroughTheTeam(unittest.TestCase):
    """Fake assignments flow through worker shim, runner, report inbox, coordinator, and snapshot."""

    def setUp(self):
        self.sb = Sandbox()
        rc, r, p = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(r["ok"], p.stderr)
        self.ws = tempfile.mkdtemp(prefix="as-ws-")
        rc, r, p = self.sb.request(req("team.start", {"workspace": self.ws, "roster": [
            {"providerId": "fake", "role": "developer"}, {"providerId": "fake", "role": "reviewer"}]},
            idempotencyKey=key()))
        self.assertTrue(r["ok"], r)
        self.team = r["data"]

    def tearDown(self):
        self.sb.cleanup()

    def assign(self, agent, **args):
        rc, r, _ = self.sb.request(req("debug.assign", dict({"agentId": agent}, **args), idempotencyKey=key()))
        self.assertTrue(r["ok"], r)
        return r["data"]["assignmentId"]

    def assignment(self, asg):
        return next(a for a in self.sb.snapshot(self.team["teamId"])["assignments"] if a["id"] == asg)

    def test_authoritative_results_through_tmux(self):
        dev, rev = (a["agentId"] for a in self.team["agents"])
        ok = self.assign(dev, goal=HOSTILE_GOAL, policy="workspace_write",
                         fake={"scenario": "success", "durationMs": 300, "writeFile": "from-dev.txt"})
        bad = self.assign(rev, fake={"scenario": "nonzero_success", "durationMs": 300})
        wait_until(lambda: self.assignment(ok)["status"] == "succeeded", message="dev succeeded")
        wait_until(lambda: self.assignment(bad)["status"] == "reconciling", message="contradiction -> reconciling")
        snap = self.sb.snapshot(self.team["teamId"])
        res = self.assignment(ok)["result"]
        self.assertEqual((res["providerId"], res["policy"], res["exitCode"]), ("fake", "workspace_write", 0))
        self.assertTrue(os.path.exists(os.path.join(self.ws, "from-dev.txt")))
        self.assertEqual(self.assignment(bad)["result"]["diagnosticCode"], "CONTRADICTORY_EVIDENCE")
        self.assertEqual([n for n in os.listdir(self.ws) if n.startswith("CANARY")], [])
        rc, ev, _ = self.sb.run("events", "--team", self.team["teamId"], "--limit", "1000")
        started = [e for e in ev["data"]["events"] if e["name"] == "assignment.running" and e["entityId"] == ok][0]
        self.assertEqual(started["data"]["provider"]["version"], "fake 1.0 (test-only)")
        self.assertEqual(started["data"]["provider"]["policies"]["workspace_write"], ["--sandbox", "workspace-write"])
        caps = [a["capabilities"] for a in snap["agents"]]
        self.assertTrue(all(c and c["available"] for c in caps))

    def test_runner_keeps_working_while_coordinator_is_down(self):
        dev = self.team["agents"][0]["agentId"]
        asg = self.assign(dev, fake={"scenario": "slow", "durationMs": 4000, "progressLines": 4})
        wait_until(lambda: self.assignment(asg)["status"] == "running", message="running")
        self.sb.run("coordinator", "stop")
        time.sleep(5)  # the run finishes while nothing is applying reports
        from agent_studio import state
        conn = state.connect(state.db_path(self.sb.state_dir), role="reader")
        pending = conn.execute("SELECT COUNT(*) FROM worker_reports r LEFT JOIN report_applications a "
                               "ON a.report_id = r.id WHERE a.report_id IS NULL").fetchone()[0]
        self.assertGreaterEqual(pending, 1)
        self.assertEqual(self.assignment(asg)["status"], "running")
        self.sb.run("coordinator", "start", "--enable-debug")
        wait_until(lambda: self.assignment(asg)["status"] == "succeeded", message="applied after restart")

    def test_preflight_reports_providers_and_policies(self):
        rc, r, _ = self.sb.run("preflight", "--workspace", self.ws, "--provider", "fake")
        self.assertTrue(r["ok"], r)
        self.sb.env["AGENT_STUDIO_FAKE_POLICIES"] = "read_only"
        rc, r, _ = self.sb.run("preflight", "--workspace", self.ws, "--provider", "fake", "--policy", "workspace_write")
        self.assertEqual(r["error"]["code"], "POLICY_UNSUPPORTED")
        rc, r, _ = self.sb.run("preflight", "--workspace", self.ws, "--provider", "fake", "--policy", "read_only")
        self.assertTrue(r["ok"], r)
        rc, r, _ = self.sb.run("preflight", "--workspace", self.ws, "--provider", "claude")
        self.assertEqual(r["error"]["code"], "PROVIDER_UNAVAILABLE")

    def test_team_start_refuses_unavailable_provider_without_substitution(self):
        rc, r, _ = self.sb.request(req("team.start", {"workspace": self.ws, "roster": [
            {"providerId": "fake", "role": "dev"}, {"providerId": "opencode", "role": "rev"}]}, idempotencyKey=key()))
        self.assertEqual(r["error"]["code"], "PROVIDER_UNAVAILABLE")
        self.assertIn("opencode", r["error"]["message"])
        self.assertEqual(len(self.sb.snapshot()["teams"]), 1)  # only the setUp team


if __name__ == "__main__":
    unittest.main()
