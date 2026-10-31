"""P06: delegated commands end to end - an agent asks, the coordinator runs the catalog command outside the agent,
and the same stage resumes with the result (fake provider under real peer ids, real coordinator)."""
import json
import os
import time
import unittest

from tests.helpers import key, req, wait_until
from tests.integration.test_p01_s04_start import FINAL, StartCase, fake

DEV = "Implement.\n{{task}}\n{{delegated_commands}}"
SHIP = {"version": 1, "stages": [
    {"id": "develop", "role": "Developer", "permission": "workspace_write", "maxVisits": 2, "prompt": DEV,
     "next": {"done": "qa"}},
    {"id": "qa", "role": "QA", "permission": "read_only", "maxVisits": 2, "prompt": "Review.\n{{diff}}",
     "next": {"pass": "$succeed", "fail": "develop"}}]}
ONLY_SETUP = {"version": 1, "stages": [dict(SHIP["stages"][0], delegates=["deps-setup"]), SHIP["stages"][1]]}
NO_DELEGATION = {"version": 1, "stages": [dict(SHIP["stages"][0], delegates=[]), SHIP["stages"][1]]}

SETUP = ("import os, sys; os.makedirs('deps', exist_ok=True); "
         "open('deps/installed.txt', 'w').write(sys.argv[1] if len(sys.argv) > 1 else 'all'); print('installed', "
         "sys.argv[1:] or 'all')")
CATALOG = {"version": 1, "defaults": {"maxPerVisit": 1}, "commands": {
    "deps-setup": {"description": "Install the dependencies into deps/", "argv": ["python3", "-c", SETUP],
                   "roles": ["Developer", "QA"]},
    "deps-add": {"description": "Add one dependency", "argv": ["python3", "-c", SETUP, "{name}"],
                 "params": {"name": {"pattern": "[a-z][a-z0-9-]{0,40}"}}, "approval": "human",
                 "roles": ["Developer"]},
    "touch-tracked": {"description": "Rewrites a tracked file (forbidden)",
                      "argv": ["python3", "-c", "open('check.py', 'a').write('# touched\\n')"], "roles": ["Developer"]},
    "slow": {"description": "Takes a while", "argv": ["python3", "-c", "import time; time.sleep(30)"],
             "roles": ["Developer"]},
}}


def marker(command, **params):
    return "Need deps.\nAGENT_STUDIO_DELEGATE " + json.dumps({"command": command, "params": params,
                                                               "reason": "deps missing"})


def asks(command, write=None, scenario="success", **params):
    return dict(fake(scenario, write), finalText=marker(command, **params))


class DelegationCase(StartCase):
    roster = [("codex", "Developer"), ("claude", "QA")]

    def setUp(self):
        super().setUp()
        with open(os.path.join(self.ws, ".agent-studio", "commands.json"), "w") as f:
            json.dump(CATALOG, f)
        for name, obj in (("dship", SHIP), ("only-setup", ONLY_SETUP), ("no-delegation", NO_DELEGATION)):
            self.write_def(name, obj)
        self.commit("catalog")

    def run_def(self, opts, name="dship", statuses=FINAL + ("paused",), timeout=60):
        r = self.start(name, debugStageOptions=opts)["data"]
        return r["workflowRunId"], self.wait(r["workflowRunId"], statuses, timeout)

    def attempts(self, d):
        return [(s["stage"], s["visit"], s["outcome"]) for s in d["stageAttempts"]]

    def prompt(self, d, i):
        return open(d["stageAttempts"][i]["promptPath"], encoding="utf-8").read()

    def requests(self, wf):
        rc, r, _ = self.sb.request(req("command.requests", {"workflowRunId": wf}))
        self.assertTrue(r["ok"], r)
        return r["data"]["requests"]

    def events(self, d, name):
        return [e for e in d["events"] if e["name"] == name]


class Happy(DelegationCase):
    def test_marker_request_runs_and_the_same_stage_resumes_with_its_result(self):
        wf, d = self.run_def({"develop": asks("deps-setup", "feature.txt"), "qa": fake("verdict_pass")})
        self.assertEqual(d["workflowRun"]["status"], "succeeded", d["workflowRun"])
        # parked, resumed on the SAME visit, then routed on as usual
        self.assertEqual(self.attempts(d), [("develop", 1, "delegated"), ("develop", 1, "done"), ("qa", 1, "verdict_pass")])
        reqs = d["commandRequests"]
        self.assertEqual([(r["command"], r["status"], r["source"]) for r in reqs], [("deps-setup", "succeeded", "marker")])
        self.assertEqual(reqs[0]["result"]["exitCode"], 0)
        self.assertEqual(open(os.path.join(self.ws, "deps", "installed.txt")).read(), "all")
        # the first prompt lists what may be delegated; the resumed one is the original plus the results
        first, resumed = self.prompt(d, 0), self.prompt(d, 1)
        self.assertIn("===== DELEGATED_COMMANDS =====", first)
        self.assertIn("- deps-setup: Install the dependencies into deps/", first)
        self.assertNotIn("touch-tracked", first.split("===== DELEGATED_COMMANDS =====")[0])
        self.assertTrue(resumed.startswith(first))
        self.assertIn("===== DELEGATED =====", resumed)
        self.assertIn("deps-setup", resumed.split("===== DELEGATED =====")[1])
        self.assertIn("SUCCEEDED", resumed)
        self.assertIn("installed all", resumed)
        self.assertIn("===== PREVIOUS_SUMMARY =====", resumed)
        # the resumed attempt asked again (same debug options); maxPerVisit 1 refused it and the run went on
        refused = self.events(d, "workflow_run.delegation_refused")
        self.assertEqual([e["data"]["code"] for e in refused], ["DELEGATION_LIMIT"])
        self.assertEqual(len(self.events(d, "workflow_run.delegation_resumed")), 1)
        ids = [a["id"] for a in d["assignments"]]
        self.assertEqual(self.events(d, "workflow_run.delegation_resumed")[0]["data"]["fromAssignmentId"], ids[0])

    def test_a_denied_permission_with_a_request_delegates_instead_of_pausing(self):
        # the same debug options drive the resumed attempt: denied again, and this time its request is over the
        # cap, so that attempt pauses as before - one delegation, then today's behaviour
        wf, d = self.run_def({"develop": asks("deps-setup", scenario="permission_denied"),
                              "qa": fake("verdict_pass")})
        a0, a1 = d["assignments"]
        self.assertEqual((a0["status"], a0["diagnosticCode"]), ("failed", "DELEGATED"))
        self.assertEqual(d["stageAttempts"][0]["outcome"], "delegated")
        self.assertTrue(self.events(d, "stage_attempt.delegating")[0]["data"]["afterDenial"])
        self.assertEqual([x["status"] for x in d["commandRequests"]], ["succeeded"])
        self.assertEqual((d["workflowRun"]["status"], a1["status"]), ("paused", "waiting_input"))
        self.assertEqual([e["data"]["code"] for e in self.events(d, "workflow_run.delegation_refused")],
                         ["DELEGATION_LIMIT"])
        self.cancel(wf)

    def test_a_denial_without_a_request_still_pauses(self):
        wf, d = self.run_def({"develop": fake("permission_denied")})
        self.assertEqual(d["workflowRun"]["status"], "paused")
        self.assertEqual(d["commandRequests"], [])
        self.cancel(wf)


class Refusals(DelegationCase):
    def test_commands_outside_the_role_or_the_stage_delegates_are_refused(self):
        # touch-tracked exists for the Developer role, but only-setup narrows the stage to deps-setup
        wf, d = self.run_def({"develop": asks("touch-tracked", "feature.txt"), "qa": fake("verdict_pass")},
                             name="only-setup")
        self.assertEqual(d["workflowRun"]["status"], "succeeded")
        self.assertEqual(d["commandRequests"], [])
        self.assertEqual([e["data"]["code"] for e in self.events(d, "workflow_run.delegation_refused")],
                         ["COMMAND_NOT_ALLOWED"])
        self.assertNotIn("# touched", open(os.path.join(self.ws, "check.py")).read())

    def test_an_empty_delegates_list_turns_delegation_off_for_the_stage(self):
        wf, d = self.run_def({"develop": asks("deps-setup", "feature.txt"), "qa": fake("verdict_pass")},
                             name="no-delegation")
        self.assertEqual(self.attempts(d), [("develop", 1, "done"), ("qa", 1, "verdict_pass")])
        self.assertIn("no delegated commands are available", self.prompt(d, 0))
        self.assertEqual([e["data"]["code"] for e in self.events(d, "workflow_run.delegation_refused")],
                         ["DELEGATION_NOT_ALLOWED"])

    def test_a_tracked_change_fails_the_request_and_the_agent_is_told(self):
        wf, d = self.run_def({"develop": asks("touch-tracked", "feature.txt"), "qa": fake("verdict_pass")})
        self.assertEqual(d["workflowRun"]["status"], "succeeded")
        r = d["commandRequests"][0]
        self.assertEqual((r["status"], r["result"]["trackedChanges"]), ("failed", ["check.py"]))
        self.assertIn("FAILED - it changed tracked files", self.prompt(d, 1))

    def test_a_bad_param_is_refused(self):
        wf, d = self.run_def({"develop": asks("deps-add", "feature.txt", name="-rf"), "qa": fake("verdict_pass")})
        self.assertEqual(d["commandRequests"], [])
        self.assertEqual([e["data"]["code"] for e in self.events(d, "workflow_run.delegation_refused")],
                         ["BAD_REQUEST"])


class Approval(DelegationCase):
    def wait_request(self, wf, status):
        return wait_until(lambda: [r for r in self.requests(wf) if r["status"] == status], timeout=40,
                          message=f"request -> {status}")[0]

    def test_human_approval_waits_then_runs(self):
        r = self.start("dship", debugStageOptions={"develop": asks("deps-add", "feature.txt", name="left-pad"),
                                                   "qa": fake("verdict_pass")})["data"]
        wf = r["workflowRunId"]
        pending = self.wait_request(wf, "requested")
        self.assertEqual(pending["argv"][-1], "left-pad")
        time.sleep(1.0)  # the run waits; nothing runs before approval
        self.assertFalse(os.path.exists(os.path.join(self.ws, "deps")))
        self.assertEqual(self.show(wf)["workflowRun"]["status"], "running")
        rc, resp, _ = self.sb.request(req("command.approve", {"requestId": pending["id"]}, idempotencyKey=key()))
        self.assertTrue(resp["ok"], resp)
        d = self.wait(wf, FINAL)
        self.assertEqual(d["workflowRun"]["status"], "succeeded")
        self.assertEqual(open(os.path.join(self.ws, "deps", "installed.txt")).read(), "left-pad")

    def test_rejection_resumes_the_agent_with_the_reason(self):
        r = self.start("dship", debugStageOptions={"develop": asks("deps-add", "feature.txt", name="left-pad"),
                                                   "qa": fake("verdict_pass")})["data"]
        wf = r["workflowRunId"]
        pending = self.wait_request(wf, "requested")
        rc, resp, _ = self.sb.request(req("command.reject", {"requestId": pending["id"], "reason": "not this one"},
                                          idempotencyKey=key()))
        self.assertTrue(resp["ok"], resp)
        d = self.wait(wf, FINAL)
        self.assertEqual(d["workflowRun"]["status"], "succeeded")
        self.assertIn("NOT RUN - rejected: not this one", self.prompt(d, 1))
        self.assertFalse(os.path.exists(os.path.join(self.ws, "deps")))

    def test_cancelling_the_run_stops_a_running_command(self):
        r = self.start("dship", debugStageOptions={"develop": asks("slow")})["data"]
        wf = r["workflowRunId"]
        self.wait_request(wf, "running")
        self.cancel(wf)
        d = self.wait(wf, FINAL)
        self.assertEqual(d["workflowRun"]["status"], "cancelled")
        self.assertEqual([x["status"] for x in d["commandRequests"]], ["cancelled"])


class DirectRequests(DelegationCase):
    def test_the_mcp_tool_files_the_request_and_the_stage_resumes(self):
        dev = dict(fake("success", "feature.txt"), mcpDelegate={"command": "deps-add", "params": {"name": "left-pad"},
                                                                "reason": "node_modules missing"})
        r = self.start("dship", debugStageOptions={"develop": dev, "qa": fake("verdict_pass")})["data"]
        wf = r["workflowRunId"]
        pending = wait_until(lambda: [x for x in self.requests(wf) if x["status"] == "requested"], timeout=40)[0]
        self.assertEqual((pending["source"], pending["reason"]), ("mcp", "node_modules missing"))
        rc, resp, _ = self.sb.request(req("command.approve", {"requestId": pending["id"]}, idempotencyKey=key()))
        self.assertTrue(resp["ok"], resp)
        d = self.wait(wf, FINAL)
        self.assertEqual(d["workflowRun"]["status"], "succeeded")
        self.assertEqual(open(os.path.join(self.ws, "deps", "installed.txt")).read(), "left-pad")
        # the resumed attempt asked again through MCP; maxPerVisit 1 refused it in the tool call itself
        self.assertEqual([x["status"] for x in d["commandRequests"]], ["succeeded"])


    def test_the_request_command_needs_the_live_assignment_of_the_calling_agent(self):
        r = self.start("dship", debugStageOptions={"develop": fake("success", "feature.txt", duration=4000),
                                                   "qa": fake("verdict_pass")})["data"]
        wf, asg, dev = r["workflowRunId"], r["assignmentId"], self.agent("Developer")
        wait_until(lambda: self.show(wf)["assignments"][0]["status"] == "running", timeout=20)
        rc, lst, _ = self.sb.request(req("command.list", {"assignment": asg, "agentId": dev}))
        self.assertTrue(lst["ok"], lst)
        self.assertEqual([c["id"] for c in lst["data"]["commands"]], ["deps-add", "deps-setup", "slow", "touch-tracked"])
        rc, bad, _ = self.sb.request(req("command.request", {"assignment": asg, "agentId": self.agent("QA"),
                                                             "command": "deps-setup"}, idempotencyKey=key()))
        self.assertEqual(self.code(bad), "DELEGATION_NOT_ALLOWED")
        rc, ok, _ = self.sb.request(req("command.request", {"assignment": asg, "agentId": dev, "command": "deps-setup",
                                                            "reason": "node_modules missing"}, idempotencyKey=key()))
        self.assertTrue(ok["ok"], ok)
        self.assertEqual((ok["data"]["status"], ok["data"]["argv"][0]), ("approved", "python3"))
        rc, again, _ = self.sb.request(req("command.request", {"assignment": asg, "agentId": dev,
                                                               "command": "deps-setup"}, idempotencyKey=key()))
        self.assertEqual(self.code(again), "DELEGATION_LIMIT")
        d = self.wait(wf, FINAL)
        self.assertEqual(d["workflowRun"]["status"], "succeeded")
        self.assertEqual([(x["command"], x["source"], x["status"]) for x in d["commandRequests"]],
                         [("deps-setup", "mcp", "succeeded")])
        self.assertEqual(self.attempts(d)[:2], [("develop", 1, "delegated"), ("develop", 1, "done")])


if __name__ == "__main__":
    unittest.main()
