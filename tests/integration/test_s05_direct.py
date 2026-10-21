"""P00-S05: direct dispatch to an idle agent, through the real coordinator, tmux workers, runner and fake provider.
Every peer provider ID is exercised via the debug-only fixture alias (fake adapter wearing that ID)."""
import json
import os
import signal
import subprocess
import tempfile
import time
import unittest

from tests.helpers import SHIM, Sandbox, key, req, wait_until
from agent_studio import procid

ALIASES = {"AGENT_STUDIO_TEST_FIXTURE_PROVIDERS": "codex=fake,claude=fake,agy=fake,opencode=fake"}
TERMINAL = ("succeeded", "failed", "cancelled")


class DirectCase(unittest.TestCase):
    extra_env = {}
    roster = ("codex", "claude", "agy", "opencode")

    def setUp(self):
        self.sb = Sandbox(extra_env=dict(ALIASES, **self.extra_env))
        rc, r, p = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(r["ok"], p.stderr)
        self.ws = tempfile.mkdtemp(prefix="as-ws-")
        self.team = self.start_team(self.ws, self.roster)
        self.agents = [a["agentId"] for a in self.team["agents"]]

    def tearDown(self):
        self.sb.cleanup()

    def start_team(self, ws, providers):
        roster = [{"providerId": p, "role": f"role-{i}"} for i, p in enumerate(providers)]
        rc, r, _ = self.sb.request(req("team.start", {"workspace": ws, "roster": roster}, idempotencyKey=key()))
        self.assertTrue(r["ok"], r)
        return r["data"]

    def direct(self, agent, policy="read_only", text="do the thing", scenario="success", duration=300, team=None,
               k=None, **extra):
        args = dict({"teamId": team or self.team["teamId"], "agentId": agent, "policy": policy, "text": text,
                     "debugProviderOptions": {"scenario": scenario, "durationMs": duration, "progressLines": 2}},
                    **extra)
        rc, r, _ = self.sb.request(req("task.direct", args, idempotencyKey=k or key("direct")))
        return r

    def cancel(self, asg):
        rc, r, _ = self.sb.request(req("assignment.cancel", {"assignmentId": asg}, idempotencyKey=key("cancel")))
        self.assertTrue(r["ok"], r)
        return r["data"]

    def snap(self):
        return self.sb.snapshot(self.team["teamId"])

    def asg(self, asg_id):
        return next(a for a in self.snap()["assignments"] if a["id"] == asg_id)

    def agent_state(self, agent):
        return next(a for a in self.snap()["agents"] if a["id"] == agent)["availability"]

    def wait_status(self, asg_id, statuses, timeout=20):
        statuses = (statuses,) if isinstance(statuses, str) else statuses
        return wait_until(lambda: self.asg(asg_id)["status"] in statuses and self.asg(asg_id), timeout=timeout,
                          message=f"assignment {asg_id[:8]} -> {statuses}")

    def events(self, asg_id):
        rc, r, _ = self.sb.run("events", "--team", self.team["teamId"], "--limit", "1000")
        return [e for e in r["data"]["events"] if e.get("assignmentId") == asg_id]

    def count_assignments(self):
        return len(self.sb.snapshot()["assignments"])


class EveryProvider(DirectCase):
    def test_four_provider_ids_take_the_identical_path(self):
        receipts = [self.direct(a, text=f"task for {p}") for a, p in zip(self.agents, self.roster)]
        sequences = []
        for r, provider, agent in zip(receipts, self.roster, self.agents):
            self.assertTrue(r["ok"], r)
            d = r["data"]
            self.assertEqual((d["receipt"], d["providerId"], d["agentId"]), ("accepted", provider, agent))
            a = self.wait_status(d["assignmentId"], "succeeded")
            res = a["result"]
            self.assertEqual((res["assignmentId"], res["agentId"], res["providerId"], res["attempt"]),
                             (d["assignmentId"], agent, provider, 1))
            evs = self.events(d["assignmentId"])
            self.assertEqual({e["assignmentId"] for e in evs}, {d["assignmentId"]})
            self.assertEqual({e.get("taskId") for e in evs}, {d["taskId"]})
            sequences.append([e["name"] for e in evs if e["entity"] == "assignment" and e["name"] != "assignment.progress"])
        self.assertTrue(all(s == sequences[0] for s in sequences), sequences)
        self.assertEqual(sequences[0], ["assignment.created", "assignment.claimed", "assignment.running",
                                        "assignment.succeeded"])
        wait_until(lambda: {g["availability"] for g in self.snap()["agents"]} == {"idle"}, message="agents idle")
        self.assertEqual({t["status"] for t in self.snap()["tasks"]}, {"succeeded"})

    def test_receipt_is_not_success(self):
        r = self.direct(self.agents[0], scenario="slow", duration=3000)
        self.assertEqual(r["data"]["receipt"], "accepted")
        rc, show, _ = self.sb.run("task", "show", "--task", r["data"]["taskId"])
        self.assertNotEqual(show["data"]["task"]["status"], "succeeded")
        self.wait_status(r["data"]["assignmentId"], "succeeded")

    def test_serve_dispatch_and_cancel(self):
        p = self.sb.popen_serve()
        try:
            def send(obj):
                p.stdin.write(json.dumps(obj).encode() + b"\n")
                p.stdin.flush()
                return json.loads(p.stdout.readline())
            r = send(req("task.direct", {"teamId": self.team["teamId"], "agentId": self.agents[1], "policy": "read_only",
                                         "text": "via serve \U0001F600",
                                         "debugProviderOptions": {"scenario": "slow", "durationMs": 20000}},
                         id="d1", idempotencyKey=key()))
            self.assertEqual((r["id"], r["data"]["receipt"]), ("d1", "accepted"))
            self.wait_status(r["data"]["assignmentId"], "running")
            c = send(req("assignment.cancel", {"assignmentId": r["data"]["assignmentId"]}, id="c1", idempotencyKey=key()))
            self.assertEqual((c["id"], c["data"]["outcome"]), ("c1", "cancel_requested"))
        finally:
            p.stdin.close()
            p.wait(10)
            p.stdout.close()
            p.stderr.close()
        self.wait_status(r["data"]["assignmentId"], "cancelled")


class TypedErrors(DirectCase):
    def assertRejected(self, resp, code):
        self.assertFalse(resp["ok"], resp)
        self.assertEqual(resp["error"]["code"], code, resp)

    def test_errors_create_no_assignment(self):
        running = self.direct(self.agents[0], policy="workspace_write", scenario="slow", duration=20000)
        self.wait_status(running["data"]["assignmentId"], "running")
        before = self.count_assignments()
        self.assertRejected(self.direct(self.agents[0]), "AGENT_BUSY")
        self.assertRejected(self.direct(self.agents[1], policy="workspace_write"), "WORKSPACE_BUSY")
        other = self.start_team(tempfile.mkdtemp(prefix="as-ws2-"), ("codex",))
        self.assertRejected(self.direct(other["agents"][0]["agentId"]), "AGENT_NOT_IN_TEAM")
        self.assertRejected(self.direct("44444444-4444-4444-8444-444444444444"), "NOT_FOUND")
        self.assertRejected(self.direct(self.agents[1], policy="unrestricted"), "BAD_REQUEST")
        self.assertRejected(self.direct(self.agents[1], text="   "), "BAD_REQUEST")
        self.assertRejected(self.direct(self.agents[1], text="x" * (32 * 1024 + 1)), "BAD_REQUEST")
        self.assertEqual(self.count_assignments(), before)
        rc, r, _ = self.sb.request(req("team.stop", {"teamId": other["teamId"]}, idempotencyKey=key()))
        self.assertRejected(self.direct(other["agents"][0]["agentId"], team=other["teamId"]), "TEAM_NOT_RUNNING")
        self.assertEqual(self.count_assignments(), before)

    def test_read_only_runs_beside_one_mutating_task(self):
        writer = self.direct(self.agents[0], policy="workspace_write", scenario="slow", duration=5000)
        self.wait_status(writer["data"]["assignmentId"], "running")
        reader = self.direct(self.agents[1], policy="read_only")
        self.assertTrue(reader["ok"], reader)
        self.wait_status(reader["data"]["assignmentId"], "succeeded")
        self.assertEqual(self.asg(writer["data"]["assignmentId"])["status"], "running")
        self.wait_status(writer["data"]["assignmentId"], "succeeded")
        follow_up = self.direct(self.agents[1], policy="workspace_write")  # workspace is free again
        self.assertTrue(follow_up["ok"], follow_up)

    def test_two_concurrent_dispatches_one_claim(self):
        target = self.agents[2]
        body = lambda: json.dumps(req("task.direct", {"teamId": self.team["teamId"], "agentId": target,
                                                      "policy": "read_only", "text": "race"},
                                      idempotencyKey=key("race"))).encode()
        procs = [subprocess.Popen([SHIM, "request"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=self.sb.env)
                 for _ in range(2)]
        outs = [json.loads(p.communicate(body(), timeout=60)[0]) for p in procs]
        self.assertEqual(sorted(o["ok"] for o in outs), [False, True])
        self.assertEqual([o["error"]["code"] for o in outs if not o["ok"]], ["AGENT_BUSY"])
        mine = [a for a in self.snap()["assignments"] if a["agentId"] == target]
        self.assertEqual(len(mine), 1)
        claims = [e for e in self.events(mine[0]["id"]) if e["name"] == "assignment.claimed"]
        self.assertEqual(len(claims), 1)


class NarrowPolicy(DirectCase):
    extra_env = {"AGENT_STUDIO_FAKE_POLICIES": "read_only"}
    roster = ("claude",)

    def test_unsupported_policy_rejected_before_any_assignment(self):
        r = self.direct(self.agents[0], policy="workspace_write")
        self.assertEqual(r["error"]["code"], "POLICY_UNSUPPORTED")
        self.assertEqual(self.count_assignments(), 0)
        self.assertTrue(self.direct(self.agents[0], policy="read_only")["ok"])


class Durability(DirectCase):
    roster = ("codex", "opencode")

    def test_idempotent_retry_conflict_and_pending(self):
        k = key("idem")
        first = self.direct(self.agents[0], text="once", k=k)
        again = self.direct(self.agents[0], text="once", k=k)
        self.assertEqual(first, again)
        conflict = self.direct(self.agents[0], text="different", k=k)
        self.assertEqual(conflict["error"]["code"], "IDEMPOTENCY_CONFLICT")
        pid = self.sb.run("health")[1]["data"]["coordinator"]["pid"]
        k2 = key("pending")
        args = {"teamId": self.team["teamId"], "agentId": self.agents[1], "policy": "read_only", "text": "later"}
        os.kill(pid, signal.SIGSTOP)
        try:
            rc, pend, _ = self.sb.request(req("task.direct", args, idempotencyKey=k2, timeoutMs=300))
            self.assertEqual(pend["error"]["code"], "PENDING")
        finally:
            os.kill(pid, signal.SIGCONT)
        rc, done, _ = self.sb.request(req("task.direct", args, idempotencyKey=k2))
        self.assertTrue(done["ok"], done)
        rc, again2, _ = self.sb.request(req("task.direct", args, idempotencyKey=k2))
        self.assertEqual(done["data"], again2["data"])
        self.assertEqual(len([t for t in self.snap()["tasks"] if t["goal"] == "later"]), 1)

    def test_cli_exit_mid_task_then_new_cli(self):
        p = subprocess.Popen([SHIM, "task", "direct", "--team", self.team["teamId"], "--agent", self.agents[0],
                              "--policy", "read_only", "--text", "long one", "--wait", "--scenario", "slow",
                              "--duration-ms", "4000"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self.sb.env)
        wait_until(lambda: any(a["status"] == "running" for a in self.snap()["assignments"]), message="running")
        p.kill()
        p.communicate(timeout=10)
        task = self.snap()["tasks"][0]
        rc, show, _ = self.sb.run("task", "show", "--task", task["id"])
        self.assertEqual(show["data"]["task"]["status"], "running")
        wait_until(lambda: self.sb.run("task", "show", "--task", task["id"])[1]["data"]["task"]["status"] == "succeeded",
                   message="task finished without the CLI")
        self.assertEqual(len(self.snap()["assignments"]), 1)

    def test_wait_returns_final_detail(self):
        p = subprocess.run([SHIM, "task", "direct", "--team", self.team["teamId"], "--agent", self.agents[1],
                            "--policy", "read_only", "--text-file", "-", "--wait", "--scenario", "success"],
                           input="from stdin: it's \"quoted\" $(nope)".encode(), stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, env=self.sb.env, timeout=60)
        d = json.loads(p.stdout)["data"]
        self.assertEqual(d["task"]["status"], "succeeded")
        self.assertEqual(d["task"]["goal"], "from stdin: it's \"quoted\" $(nope)")
        self.assertIn(b"assignment.succeeded", p.stderr)


class Cancellation(DirectCase):
    roster = ("codex", "claude")

    def terminal_events(self, asg_id):
        return [e for e in self.events(asg_id) if e["entity"] == "assignment" and e.get("to") in TERMINAL]

    def test_cancel_running(self):
        r = self.direct(self.agents[0], scenario="slow", duration=20000)["data"]
        self.wait_status(r["assignmentId"], "running")
        wait_until(lambda: any(e["data"].get("providerProcess") for e in self.events(r["assignmentId"])),
                   message="provider started")
        provider = [e["data"]["providerProcess"] for e in self.events(r["assignmentId"])
                    if e["data"].get("providerProcess")][0]
        self.assertEqual(self.cancel(r["assignmentId"])["outcome"], "cancel_requested")
        a = self.wait_status(r["assignmentId"], "cancelled")
        self.assertEqual(a["result"]["diagnosticCode"], "CANCELLED")
        self.assertEqual(len(self.terminal_events(r["assignmentId"])), 1)
        wait_until(lambda: self.agent_state(self.agents[0]) == "idle")
        self.assertFalse(procid.matches(provider))
        self.assertEqual(self.cancel(r["assignmentId"])["outcome"], "already_finished")

    def test_cancel_unblocks_waiting_input(self):
        r = self.direct(self.agents[1], scenario="waiting_input")["data"]
        self.wait_status(r["assignmentId"], "waiting_input")
        wait_until(lambda: self.agent_state(self.agents[1]) == "waiting_input")
        self.assertEqual(self.direct(self.agents[1])["error"]["code"], "AGENT_BUSY")
        self.assertEqual(self.cancel(r["assignmentId"])["outcome"], "cancelled")
        self.assertEqual(self.agent_state(self.agents[1]), "idle")
        self.assertTrue(self.direct(self.agents[1])["ok"])

    def test_cancel_queued_never_runs(self):
        busy = self.direct(self.agents[0], scenario="slow", duration=20000)["data"]
        self.wait_status(busy["assignmentId"], "running")
        rc, q, _ = self.sb.request(req("debug.assign", {"agentId": self.agents[0], "fake": {"scenario": "success"}},
                                       idempotencyKey=key()))
        queued = q["data"]["assignmentId"]
        self.assertEqual(self.asg(queued)["status"], "queued")
        self.assertEqual(self.cancel(queued)["outcome"], "cancelled")
        self.cancel(busy["assignmentId"])
        self.wait_status(busy["assignmentId"], "cancelled")
        time.sleep(1.5)
        self.assertEqual(self.asg(queued)["status"], "cancelled")
        self.assertFalse(os.path.exists(os.path.join(self.sb.state_dir, "runs", queued)))

    def test_cancel_and_completion_race_has_one_winner(self):
        for i in range(4):
            r = self.direct(self.agents[i % 2], scenario="success", duration=700)["data"]
            self.wait_status(r["assignmentId"], ("running",) + TERMINAL)
            time.sleep(0.45 + 0.1 * i)
            self.cancel(r["assignmentId"])
            a = self.wait_status(r["assignmentId"], TERMINAL)
            self.assertEqual(len(self.terminal_events(r["assignmentId"])), 1, a["status"])
            task = next(t for t in self.snap()["tasks"] if t["id"] == r["taskId"])
            self.assertEqual(task["status"], a["status"])
            wait_until(lambda: self.agent_state(self.agents[i % 2]) == "idle")


if __name__ == "__main__":
    unittest.main()
