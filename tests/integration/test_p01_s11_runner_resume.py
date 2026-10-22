"""P01-S11: the real runner with the fake provider and hand-written request.session blocks (no coordinator)."""
import json
import os
import tempfile
import unittest

from tests.helpers import Sandbox
from tests.runner_harness import RunnerHarness
from agent_studio.runner import CANCEL_MARKER, RESUME_ATTEMPT_DIR, RESUME_ATTEMPT_FILES

UNKNOWN = "fake-0123456789ab"
GOLDEN_DIRECT = (b"===== AGENT STUDIO ROLE: developer =====\n(no role configuration)\n===== END ROLE =====\n"
                 b"\n===== TASK =====\nsame goal\n===== END TASK =====\n")
GOLDEN_WORKFLOW = (b"===== AGENT STUDIO ROLE: developer =====\n(no role configuration)\n===== END ROLE =====\n"
                   b"\nSTAGE PROMPT\nline two\n")
FAST = {"durationMs": 50, "progressLines": 1}


class RunnerResume(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sb = Sandbox()
        cls.ws = tempfile.mkdtemp(prefix="as-ws-")
        cls.sdir = os.path.join(cls.sb.root, "fake-sessions")
        cls.h = RunnerHarness(cls.sb, cls.ws)

    @classmethod
    def tearDownClass(cls):
        cls.sb.cleanup()

    def go(self, session=None, options=None, goal="do the thing", **extra):
        if session is not None:
            extra["session"] = session
        _, asg = self.h.claimed(goal=goal, options=dict(FAST, **(options or {})), **extra)
        rc, out, err = self.h.run(asg, env={"AGENT_STUDIO_FAKE_SESSION_DIR": self.sdir})
        return asg, self.h.result(asg)

    def kinds(self, asg):
        rows = self.h.conn.execute("SELECT kind FROM worker_reports WHERE assignment_id = ? ORDER BY report_seq",
                                   (asg,)).fetchall()
        return [r["kind"] for r in rows]

    def prompt(self, asg):
        with open(self.h.evidence(asg, "prompt.txt"), "rb") as f:
            return f.read()

    def attempt_dir(self, asg):
        return self.h.evidence(asg, RESUME_ATTEMPT_DIR)

    def test_prompt_is_unchanged_for_none_unsupported_and_fresh(self):
        prompts = []
        for session in (None, {"key": "k", "mode": "unsupported", "persist": False},
                        {"key": "k", "mode": "fresh", "resumeFrom": None, "persist": False}):
            asg, res = self.go(session=session, goal="same goal")
            prompts.append(self.prompt(asg))
            self.assertEqual(res["status"], "succeeded")
            if session is None:
                self.assertNotIn("session", res)
            else:
                self.assertEqual(res["session"], {"mode": session["mode"], "resumeFrom": None})
        self.assertEqual(prompts[0], prompts[1])
        self.assertEqual(prompts[0], prompts[2])
        self.assertEqual(prompts[0], GOLDEN_DIRECT)

    def test_workflow_prompt_file_bytes_are_unchanged(self):
        wdir = os.path.join(self.sb.state_dir, "workflows")
        os.makedirs(wdir, mode=0o700, exist_ok=True)
        pf = os.path.join(wdir, "stage-prompt.txt")
        with open(pf, "wb") as f:
            f.write(b"STAGE PROMPT\nline two\n")
        for session in (None, {"key": "k", "mode": "fresh", "resumeFrom": None, "persist": False}):
            asg, res = self.go(session=session, promptFile=pf)
            self.assertEqual(res["status"], "succeeded")
            self.assertEqual(self.prompt(asg), GOLDEN_WORKFLOW)

    def test_resume_uses_the_short_prompt_and_reports_the_session(self):
        a1, r1 = self.go(session={"key": "story:S1", "mode": "fresh", "persist": True}, goal="first")
        sid = r1["providerSessionId"]
        a2, r2 = self.go(session={"key": "story:S1", "mode": "resume", "resumeFrom": sid, "persist": True},
                         goal="second")
        self.assertEqual(r2["status"], "succeeded")
        self.assertEqual(r2["session"], {"mode": "resume", "resumeFrom": sid})
        self.assertNotEqual(r2["providerSessionId"], sid)
        p = self.prompt(a2).decode()
        self.assertTrue(p.startswith("===== AGENT STUDIO SESSION =====\nYou are continuing your earlier session "
                                     "for story:S1.\n"))
        self.assertIn("Your permission for this task is read_only.\n===== END SESSION =====\nYou are developer.\n\n"
                      "===== TASK =====\nsecond", p)
        self.assertNotIn("===== AGENT STUDIO ROLE", p)
        self.assertEqual(r2["usageNormalized"]["cachedInputTokens"], len(self.prompt(a1)))
        self.assertFalse(os.path.exists(self.attempt_dir(a2)))

    def test_unknown_session_falls_back_once_in_the_same_assignment(self):
        asg, res = self.go(session={"key": "k", "mode": "resume", "resumeFrom": UNKNOWN, "persist": True},
                           deadlineMs=20000)
        self.assertEqual(res["status"], "succeeded")
        self.assertEqual(res["session"], {"mode": "fresh", "resumeFrom": None, "fallbackFrom": UNKNOWN,
                                          "warning": "PROVIDER_SESSION_MISSING"})
        self.assertEqual(self.kinds(asg).count("start"), 1)
        self.assertEqual(self.kinds(asg).count("final"), 1)
        old = self.attempt_dir(asg)
        self.assertEqual(sorted(os.listdir(old)), sorted(RESUME_ATTEMPT_FILES))
        for n in RESUME_ATTEMPT_FILES:
            self.assertTrue(os.path.exists(self.h.evidence(asg, n)))
        with open(os.path.join(old, "prompt.txt"), "rb") as f:
            self.assertTrue(f.read().startswith(b"===== AGENT STUDIO SESSION"))
        self.assertTrue(self.prompt(asg).startswith(b"===== AGENT STUDIO ROLE"))
        with open(self.h.evidence(asg, "meta.json")) as f:
            self.assertLess(json.load(f)["deadlineSeconds"], 20)
        self.assertTrue(os.path.exists(os.path.join(self.sdir, res["providerSessionId"] + ".json")))

    def test_second_missing_session_fails_without_a_third_run(self):
        asg, res = self.go(session={"key": "k", "mode": "resume", "resumeFrom": UNKNOWN, "persist": True},
                           options={"forceSessionMissing": True})
        self.assertEqual((res["status"], res["diagnosticCode"]), ("failed", "PROVIDER_SESSION_MISSING"))
        self.assertEqual(self.kinds(asg).count("final"), 1)
        self.assertEqual(os.listdir(self.attempt_dir(asg)).__len__(), len(RESUME_ATTEMPT_FILES))

    def test_cancel_marker_before_the_run_means_cancelled_without_rerun(self):
        _, asg = self.h.claimed(options=FAST, session={"key": "k", "mode": "resume", "resumeFrom": UNKNOWN})
        rd = os.path.dirname(self.h.evidence(asg, "x"))
        os.makedirs(rd, mode=0o700, exist_ok=True)
        open(os.path.join(rd, CANCEL_MARKER), "w").close()
        self.h.run(asg, env={"AGENT_STUDIO_FAKE_SESSION_DIR": self.sdir})
        self.assertEqual(self.h.result(asg)["status"], "cancelled")
        self.assertFalse(os.path.exists(self.attempt_dir(asg)))

    def test_under_one_second_left_keeps_the_first_report(self):
        asg, res = self.go(session={"key": "k", "mode": "resume", "resumeFrom": UNKNOWN, "persist": True},
                           deadlineMs=500)
        self.assertEqual((res["status"], res["diagnosticCode"]), ("failed", "PROVIDER_SESSION_MISSING"))
        self.assertFalse(os.path.exists(self.attempt_dir(asg)))


if __name__ == "__main__":
    unittest.main()
