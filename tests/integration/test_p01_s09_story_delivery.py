"""P01-S09: this project's story-delivery definition runs on the fake provider: qa fail -> develop -> qa pass -> final."""
import os
import shutil
import unittest

from tests.integration.test_p01_s04_start import StartCase, fake
from tests.integration.test_p01_s05_routing import FINAL

PROJECT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".agent-studio")
COMMIT = "Implement the story\n\nShort body."


class StoryDelivery(StartCase):
    roster = [("claude", "TeamLead"), ("claude", "Developer"), ("claude", "QA")]

    def setUp(self):
        super().setUp()
        dst = os.path.join(self.ws, ".agent-studio", "workflows")
        os.makedirs(dst, exist_ok=True)
        shutil.copy(os.path.join(PROJECT, "workflows", "story-delivery.yaml"), dst)
        shutil.copytree(os.path.join(PROJECT, "workflows", "prompts"), os.path.join(dst, "prompts"))
        self.commit("story-delivery")

    def test_validate_binds_three_roles(self):
        rc, r, p = self.sb.run("workflow", "validate", "--team", self.team["teamId"], "--definition",
                               "story-delivery")
        self.assertTrue(r["ok"], r)
        self.assertEqual(set(r["data"]["bindings"]), {"TeamLead", "Developer", "QA"})
        self.assertEqual(r["data"]["warnings"], [])

    def test_qa_fail_then_pass_then_final_commit_block(self):
        final = fake("verdict_pass")
        final["finalText"] = "Looks complete.\n```commit\n" + COMMIT + "\n```"
        opts = {"review": fake("verdict_pass"), "develop": fake("success", "fixed.txt"), "qa": [fake("verdict_fail"), fake("verdict_pass")],
                "final": final}
        r = self.start("story-delivery", debugStageOptions=opts)["data"]
        d = self.wait(r["workflowRunId"], FINAL + ("paused",), 90)
        self.assertEqual(d["workflowRun"]["status"], "succeeded", d["route"])
        self.assertEqual(d["route"], "review (pass) → develop → tests (pass) → qa (fail) → develop → tests (pass) → qa (pass) → "
                                     "final (pass) → $succeed")
        a = {x["id"]: x for x in d["assignments"]}
        last = a[d["stageAttempts"][-1]["assignmentId"]]["result"]
        self.assertIn("```commit", last.get("finalText") or last.get("summary"))

    def test_review_fail_stops_before_develop(self):
        r = self.start("story-delivery", debugStageOptions={"review": fake("verdict_fail")})["data"]
        d = self.wait(r["workflowRunId"], FINAL + ("paused",), 60)
        self.assertEqual(d["workflowRun"]["status"], "failed")
        self.assertEqual([x["stage"] for x in d["stageAttempts"]], ["review"])

    def test_verdict_stages_tell_the_runner_to_read_a_verdict(self):
        r = self.start("story-delivery", debugStageOptions={"review": fake("verdict_pass"),
                                                            "develop": fake("success", "fixed.txt"),
                                                            "qa": fake("verdict_pass"), "final": fake("verdict_pass")})
        d = self.wait(r["data"]["workflowRunId"], FINAL + ("paused",), 90)
        stage = {x["assignmentId"]: x["stage"] for x in d["stageAttempts"]}
        flags = {stage[a["id"]]: (a.get("request") or {}).get("expectsVerdict") for a in d["assignments"]}
        self.assertEqual(flags, {"review": True, "develop": False, "qa": True, "final": True})


if __name__ == "__main__":
    unittest.main()
