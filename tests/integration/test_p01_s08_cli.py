"""P01-S08: workflow list / validate / start --definition --bind, route text, P00 form."""
import json
import unittest

from tests.helpers import req, key

from tests.integration.test_p01_s04_start import StartCase, fake
from tests.integration.test_p01_s05_routing import agent

PAIR = {"version": 1, "description": "pair", "stages": [
    agent("build", "Developer", "workspace_write", {"done": "look"}, 2, "Do.\n{{task}}"),
    agent("look", "QA", "read_only", {"pass": "$succeed", "fail": "build"}, 2, "Look.\n{{task}}")]}


class Cli(StartCase):
    def setUp(self):
        super().setUp()
        self.write_def("pair", PAIR)
        self.commit("pair")

    def run_ok(self, *a):
        rc, r, p = self.sb.run(*a)
        self.assertTrue(r["ok"], (r, p.stderr))
        return r["data"]

    def run_err(self, *a):
        rc, r, p = self.sb.run(*a)
        self.assertFalse(r["ok"], r)
        return r["error"]

    def test_list_has_builtin_and_workspace_definitions(self):
        d = self.run_ok("workflow", "list", "--team", self.team["teamId"])
        names = {x["name"]: x for x in d["definitions"]}
        self.assertTrue(names["developer-reviewer"]["builtin"])
        self.assertFalse(names["pair"]["builtin"])
        self.assertIn("bad", names)

    def test_validate_ok_writes_nothing(self):
        d = self.run_ok("workflow", "validate", "--team", self.team["teamId"], "--definition", "pair")
        self.assertEqual([s["id"] for s in d["stages"]], ["build", "look"])
        self.assertEqual(set(d["bindings"]), {"Developer", "QA"})
        snap = self.run_ok("snapshot")
        self.assertFalse(snap.get("workflowRuns"))

    def test_validate_errors(self):
        t = self.team["teamId"]
        self.assertEqual(self.run_err("workflow", "validate", "--team", t, "--definition", "nobody")["code"],
                         "ROLE_UNBOUND")
        self.assertEqual(self.run_err("workflow", "validate", "--team", t, "--definition", "bad")["code"],
                         "WORKFLOW_DEFINITION_INVALID")
        self.assertEqual(self.run_err("workflow", "validate", "--team", t, "--definition", "pair",
                                      "--bind", "Nope=" + self.agent("QA"))["code"], "BAD_REQUEST")
        self.assertEqual(self.run_err("workflow", "validate", "--team", t, "--definition", "pair",
                                      "--bind", "oops")["code"], "BAD_REQUEST")

    def test_start_with_bind_and_route(self):
        r = self.run_ok("workflow", "start", "--team", self.team["teamId"], "--definition", "pair", "--text", "go",
                        "--bind", "QA=" + self.agent("QA"))
        wf = r["workflowRunId"]
        d = self.wait(wf)
        self.assertIn(d["workflowRun"]["status"], ("succeeded", "failed", "paused", "cancelled"))
        self.assertTrue(d["route"].startswith("build"), d["route"])
        self.assertEqual(d["visits"]["build"], 1)

    def test_p00_form_and_mixing_rejected(self):
        t = self.team["teamId"]
        self.assertEqual(self.run_err("workflow", "start", "--team", t, "--definition", "pair", "--developer",
                                      self.agent("Developer"), "--text", "x")["code"], "BAD_REQUEST")
        self.assertEqual(self.run_err("workflow", "start", "--team", t, "--developer", self.agent("Developer"),
                                      "--reviewer", self.agent("QA"), "--bind", "A=b", "--text", "x")["code"],
                         "BAD_REQUEST")

    def test_unknown_agent_bind_writes_nothing(self):
        t = self.team["teamId"]
        e = self.run_err("workflow", "start", "--team", t, "--definition", "pair", "--text", "x",
                         "--bind", "QA=00000000-0000-4000-8000-000000000000")
        self.assertEqual(e["code"], "NOT_FOUND")
        self.assertFalse(self.run_ok("snapshot").get("workflowRuns"))

    def test_serve_round_trip_with_hostile_text(self):
        text = 'quote " back\\slash \u2028 \u00e9 $(touch x) `x` \n{{task}}'
        t = self.team["teamId"]
        lines = [req("workflow.list", {"teamId": t}, id=1), req("workflow.validate", {"teamId": t,
                 "definition": "pair"}, id=2), req("workflow.start", {"teamId": t, "definition": "pair",
                 "text": text}, id=3, idempotencyKey=key("s08"))]
        p = self.sb.popen_serve()
        try:
            out, _ = p.communicate(b"".join(json.dumps(l).encode() + b"\n" for l in lines), timeout=60)
        finally:
            if p.poll() is None:
                p.kill()
        r = [json.loads(l) for l in out.splitlines()]
        self.assertTrue(all(x["ok"] for x in r), r)
        d = self.wait(r[2]["data"]["workflowRunId"])
        task = self.run_ok("task", "show", "--task", d["workflowRun"]["taskId"])
        self.assertEqual(task["task"]["goal"], text)


if __name__ == "__main__":
    unittest.main()
