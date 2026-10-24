"""P04-S05 parity: scripts/team/team.py and `agent-studio team ...` do the same thing for the fixture story.

Both run review -> dev -> qa (fail) -> fix -> qa (pass) -> final -> commit -> run --story against the same fake
world. Per step we compare the dispatch command and args (team.py's cli(...) argv turned into a request with
cli._human_request; idempotency keys and timeouts ignored; `bindings` dropped because the new run-workflow resolves
them with workflow.validate), the git / validation subprocess calls, and the state file JSON. Deleted with team.py
(P04-S06).
"""
import contextlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

from tests import helpers  # noqa: F401  (puts backend on sys.path)
from agent_studio import cli, storycli
from agent_studio.protocol import envelope

os.environ.setdefault("AGENT_STUDIO", "/bin/true")
HERE = os.path.dirname(os.path.abspath(__file__))
FIX = os.path.join(HERE, "..", "fixtures", "p04_s05")
spec = importlib.util.spec_from_file_location("team_py_parity", os.path.join(HERE, "..", "..", "scripts", "team",
                                                                              "team.py"))
team = importlib.util.module_from_spec(spec)
spec.loader.exec_module(team)

ANSWERS = json.load(open(os.path.join(FIX, "answers.json")))
STORY = "phases/p/stories/P99-S01-x.md"
ROLES = ("TeamLead", "Developer", "QA")
TEAM_ID = "a" * 8 + "-0000-4000-8000-" + "a" * 12
WF = "e" * 8 + "-0000-4000-8000-" + "e" * 12
ASG = "c" * 8 + "-0000-4000-8000-" + "c" * 12
TASK = "d" * 8 + "-0000-4000-8000-" + "d" * 12


def aid(i):
    return f"{i}" * 8 + "-0000-4000-8000-" + f"{i}" * 12


class World:
    """Everything outside the two implementations: the agents' answers, git, the test command."""

    def __init__(self, ws):
        self.ws = ws
        self.events = []
        self.answers = []
        self.tests_ok = True
        self.status_calls = 0
        self.last_start = None

    def request(self, command, args):
        args = {k: v for k, v in args.items() if k != "bindings"}
        self.events.append(("dispatch", command, args))

    def run(self, argv, **kw):
        argv = list(argv)
        self.events.append(("run", argv, kw.get("cwd"), kw.get("timeout"), kw.get("input")))
        out = ""
        if argv[:3] == ["git", "status", "--porcelain"] and "--untracked-files=all" in argv:
            self.status_calls += 1
            out = " M phases/p/stories/P99-S01-x.md\n M notes.txt\n" if self.status_calls % 2 == 0 else ""
        elif argv[:3] == ["git", "rev-parse", "HEAD"]:
            out = "abc123def4567890\n"
        elif argv[0] == "git" and argv[1] == "diff" and argv[2:3] == ["--name-status"]:
            out = "M\tx.py\n"
        code = 0 if self.tests_ok or "validate.py" not in " ".join(argv) else 1
        return subprocess.CompletedProcess(argv, code, stdout=None if "stdout" not in kw else out)

    def direct_data(self, text):
        return {"assignments": [{"id": ASG, "status": "succeeded", "result": {"finalText": text}}]}

    def workflow_detail(self, args):
        if "developerAgentId" in args:
            return {"workflowRun": {"id": WF, "status": "failed"},
                    "stageAttempts": [{"verdict": {"verdict": "fail", "findings": ANSWERS["dev_findings"]},
                                       "validation": {"passed": False}}]}
        return {"workflowRun": {"id": WF, "status": "succeeded"}, "route": "build -> $succeed",
                "stageAttempts": [{"assignmentId": ASG, "outcome": "verdict_pass",
                                   "verdict": {"verdict": "pass", "findings": ["f1"]}}],
                "assignments": [{"id": ASG, "result": {"finalText": ANSWERS["run_stage_text"]}}]}


class Parity(unittest.TestCase):
    def setUp(self):
        self.root = os.path.realpath(tempfile.mkdtemp(prefix="as-parity-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.ws = os.path.join(self.root, "proj")
        os.makedirs(os.path.join(self.ws, "phases", "p", "stories"))
        os.makedirs(os.path.join(self.ws, ".agent-studio"))
        shutil.copy(os.path.join(FIX, "story.md"), os.path.join(self.ws, STORY))
        json.dump({"version": 1, "validation": {"argv": ["python3", "scripts/validate.py", "--touched"],
                                                "timeoutMs": 90000}},
                  open(os.path.join(self.ws, ".agent-studio", "workflow.json"), "w"))
        from agent_studio import teamdefs, workspace
        workspace.init(self.ws)
        teamdefs.save(self.ws, {"id": "alpha", "name": "Alpha", "members": [
            {"id": r.lower(), "name": r, "role": r, "provider": "fake"} for r in ROLES]})

    # ---- the steps (same for both implementations) ----
    STEPS = [("review", "review", {}, False), ("dev", "dev", {}, False), ("qa", "qa", {}, True),
             ("fix", "fix", {}, False), ("qa", "qa", {}, False), ("final", "final", {}, False),
             ("commit", "commit", {}, False), ("run", "run-workflow", {}, False)]
    ANSWER_ORDER = ["review", "qa_fail", "fix", "qa_pass", "final"]

    def team_py_step(self, world, cmd, tests_fail):
        ns = types.SimpleNamespace(story=STORY, force=False, integration=False, skip_integration=True, name="story-delivery",
                                   prompt=None, prompt_file=None, bind=[], no_wait=False)
        if cmd == "run":
            ns.story = STORY

        def cli_stub(*args, stdin=None):
            with mock.patch("sys.stdin", mock.Mock(buffer=io.BytesIO((stdin or "").encode()))):
                req = cli._human_request(list(args))
            world.request(req["command"], req["args"])
            if req["command"] == "task.direct":
                return world.direct_data(world.answers.pop(0))
            return world.workflow_detail(req["args"])

        def sh_stub(*argv, check=True, cwd=None):
            return world.run(argv, cwd=self.ws, stdout=subprocess.PIPE)

        agents = {r: {"agentId": aid(i), "name": r, "role": r} for i, r in enumerate(ROLES)}
        with mock.patch.object(team, "WS", self.ws), mock.patch.object(team, "STATE", self.state_a), \
                mock.patch.object(team, "cli", cli_stub), mock.patch.object(team, "sh", sh_stub), \
                mock.patch.object(team, "team", lambda: {"teamId": TEAM_ID, "agents": agents}), \
                mock.patch.object(subprocess, "run", world.run), mock.patch("builtins.input", return_value="y"), \
                contextlib.redirect_stdout(io.StringIO()):
            getattr(team, {"review": "c_review", "dev": "c_dev", "qa": "c_qa", "fix": "c_fix", "final": "c_final",
                           "commit": "c_commit", "run": "c_run"}[cmd])(ns)

    def new_step(self, world, cmd, tests_fail):
        members = [{"memberId": r.lower(), "name": r, "role": r, "provider": "fake", "agentId": aid(i),
                    "availability": "idle", "paneState": "alive", "assignment": None} for i, r in enumerate(ROLES)]

        def handle(req, require_id=True):
            c, a = req["command"], req["args"]
            if c == "team.status":
                return envelope(None, True, data={"team": {"id": TEAM_ID, "teamDefId": "alpha", "name": "Alpha",
                                                           "status": "running", "workspace": self.ws},
                                                  "members": members})
            if c == "workflow.validate":
                return envelope(None, True, data={"definition": a["definition"], "stages": [], "bindings": {}})
            world.request(c, a)
            if c == "task.direct":
                world.pending = world.answers.pop(0)
                return envelope(None, True, data={"taskId": TASK, "assignmentId": ASG})
            world.last_start = a
            return envelope(None, True, data={"workflowRunId": WF, "baseCommit": "abc123def4567890"})

        argv = {"run": ["run-workflow", "story-delivery", "--story", STORY], "commit": ["commit", STORY, "--skip-integration"]
                }.get(cmd, [cmd, STORY])
        with mock.patch("agent_studio.dispatch.handle_request", handle), mock.patch.object(subprocess, "run", world.run), \
                mock.patch("agent_studio.watch.follow", lambda a, t, *x, **k: world.direct_data(world.pending)), \
                mock.patch("agent_studio.watch.follow_workflow", lambda w, *x, **k: world.workflow_detail(world.last_start)), \
                mock.patch("builtins.input", return_value="y"), contextlib.redirect_stdout(io.StringIO()), \
                contextlib.redirect_stderr(io.StringIO()):
            rc = cli.main(["team"] + argv + ["--workspace", self.ws])
        self.assertEqual(rc, 0)

    def play(self, impl):
        world = World(self.ws)
        world.answers = [ANSWERS[k] for k in self.ANSWER_ORDER]
        log = []
        for name, cmd, _, tests_fail in self.STEPS:
            world.tests_ok = not tests_fail
            world.events.clear()
            impl(world, {"run-workflow": "run"}.get(cmd, cmd), tests_fail)
            state_dir = self.state_a if impl == self.team_py_step else storycli.state_dir(self.ws)
            path = os.path.join(state_dir, "story-P99_S01_x.json")
            log.append((cmd, list(world.events), open(path).read()))
        return log

    def test_every_step_matches_team_py(self):
        self.state_a = os.path.join(self.root, "state-a", "agent-studio", "project-team", "x")
        with mock.patch.dict(os.environ, {"XDG_STATE_HOME": os.path.join(self.root, "state-b")}):
            old = self.play(self.team_py_step)
            new = self.play(self.new_step)
        self.assertEqual(len(old), len(new))
        for (cmd, old_ev, old_state), (_, new_ev, new_state) in zip(old, new):
            self.assertEqual(old_ev, new_ev, f"events of {cmd}")
            self.assertEqual(old_state, new_state, f"state file after {cmd}")
        keys = json.loads(old[-1][2])
        self.assertEqual(keys["commitMessage"], "Run commit message")
        self.assertIn("committed", keys)

    def test_the_run_covers_dispatch_and_validation(self):
        """Guard against a vacuous comparison: the steps really sent tasks, workflows and ran validation."""
        self.state_a = os.path.join(self.root, "state-a")
        with mock.patch.dict(os.environ, {"XDG_STATE_HOME": os.path.join(self.root, "state-b")}):
            log = self.play(self.new_step)
        flat = [e for _, evs, _ in log for e in evs]
        commands = [e[2] and e[1] for e in flat if e[0] == "dispatch"]
        self.assertEqual(commands.count("task.direct"), 5)
        self.assertEqual(commands.count("workflow.start"), 2)
        ran = [e[1] for e in flat if e[0] == "run" and e[1][0] == "python3"]
        self.assertIn(["python3", "scripts/validate.py", "--unit"], ran)
