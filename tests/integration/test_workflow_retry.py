"""workflow.retry (fake provider)."""
import unittest

from tests.helpers import key, req, wait_until
from tests.integration.test_p01_s04_start import StartCase, fake
from tests.integration.test_p01_s08_cli import PAIR

FINAL = ("succeeded", "failed", "cancelled")


class Retry(StartCase):
    def setUp(self):
        super().setUp()
        self.write_def("pair", PAIR)
        self.commit("pair")

    def retry(self, wf, **extra):
        rc, r, _ = self.sb.request(req("workflow.retry", dict({"workflowRunId": wf}, **extra), idempotencyKey=key("r")))
        return r

    def test_retry_a_waiting_input_stage(self):
        wf = self.start("pair", debugStageOptions={"build": fake("waiting_input"),
                                                   "look": fake("verdict_pass")})["data"]["workflowRunId"]
        wait_until(lambda: self.show(wf)["assignments"][-1]["status"] == "waiting_input", timeout=40, message="waiting")
        r = self.retry(wf, debugProviderOptions=fake("success", "fixed.txt"))
        self.assertTrue(r["ok"], r)
        self.assertEqual((r["data"]["status"], r["data"]["stage"]), ("retried", "build"))
        d = self.wait(wf, FINAL, 60)
        self.assertEqual(d["workflowRun"]["status"], "succeeded")
        self.assertEqual(d["route"], "build → look (pass) → $succeed")

    def test_retry_refuses_a_healthy_running_stage_and_a_finished_run(self):
        wf = self.start("pair", debugStageOptions={"build": fake("success", "fixed.txt", duration=2500),
                                                   "look": fake("verdict_pass")})["data"]["workflowRunId"]
        r = self.retry(wf)
        self.assertFalse(r["ok"], r)
        self.assertEqual(r["error"]["code"], "RESOLVE_NOT_ALLOWED")
        self.wait(wf, FINAL, 60)
        self.assertFalse(self.retry(wf)["ok"])


if __name__ == "__main__":
    unittest.main()
