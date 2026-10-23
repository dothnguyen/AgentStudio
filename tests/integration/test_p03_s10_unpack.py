"""Live fake-provider coverage for feature unpack outcomes and its plan gate."""
import json
import os
import shutil
import tempfile
import unittest

from tests.helpers import key, req
from tests.integration import test_p03_s06_outcomes as outcomes


STORY = """# Child story
Status: To Do
Depends on:

## Goal
Child.

## Implement in this order
1. Do it.

## Done when
- [ ] covered

## Evidence
"""


class UnpackIntegration(unittest.TestCase):
    def setUp(self):
        self.fx = outcomes.OutcomeIntegration()
        self.fx.setUp()
        self.out = "phases/phase-04"
        self.brief = "brief.md"
        with open(os.path.join(self.fx.workspace, self.brief), "w", encoding="utf-8") as f:
            f.write("# New feature\n")
        with open(os.path.join(self.fx.workspace, ".agent-studio", "board.json"), "w", encoding="utf-8") as f:
            json.dump({"baseBranch": self.fx.base_branch, "requirePlanApproval": True,
                       "columns": {"unpack": {"role": "TeamLead", "definition": "board-unpack"}}}, f)
        outcomes.git(self.fx.workspace, "add", "-A")
        outcomes.git(self.fx.workspace, "commit", "-m", "feature fixture")

    def tearDown(self):
        self.fx.tearDown()

    def create_feature(self, out=None):
        _, response, _ = self.fx.sb.request(req("ticket.create", {"workspace": self.fx.workspace, "kind": "feature",
                                                                "briefPath": self.brief, "outDir": out or self.out}, idempotencyKey=key()))
        self.assertTrue(response["ok"], response)
        return response["data"]["ticket"]

    def write(self, path, text=STORY):
        os.makedirs(os.path.dirname(os.path.join(self.fx.workspace, path)), exist_ok=True)
        with open(os.path.join(self.fx.workspace, path), "w", encoding="utf-8") as f:
            f.write(text)

    def manifest(self, out, stories, questions=None, raw=None):
        os.makedirs(os.path.join(self.fx.workspace, out), exist_ok=True)
        with open(os.path.join(self.fx.workspace, out, "tickets.json"), "w", encoding="utf-8") as f:
            if raw is None:
                json.dump({"stories": stories, "questions": questions or []}, f)
            else:
                f.write(raw)

    def set_plan_gate(self, required):
        with open(os.path.join(self.fx.workspace, ".agent-studio", "board.json"), "w", encoding="utf-8") as f:
            json.dump({"baseBranch": self.fx.base_branch, "requirePlanApproval": required,
                       "columns": {"unpack": {"role": "TeamLead", "definition": "board-unpack"}}}, f)
        outcomes.git(self.fx.workspace, "add", ".agent-studio/board.json")
        outcomes.git(self.fx.workspace, "commit", "-m", "change plan gate")

    def children(self, parent):
        rows = self.fx.sb.run("ticket", "list", "--workspace", self.fx.workspace)[1]["data"]["tickets"]
        return [row for row in rows if row["parentTicketId"] == parent["id"]]

    def begin(self, ticket, role, stage, option):
        """Start a run.  ticket.start refuses a dirty workspace, so planning files the test has written for the
        agent are set aside for the start and restored while the fake run is still in flight."""
        status = outcomes.git(self.fx.workspace, "status", "--porcelain", "--untracked-files=all")
        # git() strips its output, which can eat the first line's leading space, so split on whitespace.
        entries = [line.strip().split(None, 1) for line in status.splitlines() if line.strip()]
        files = [path for code, path in entries if code == "??"]
        modified = [path for code, path in entries if code == "M"]
        stash = tempfile.mkdtemp(prefix="as-stash-")
        try:
            for rel in files + modified:
                os.makedirs(os.path.dirname(os.path.join(stash, rel)), exist_ok=True)
                shutil.copy2(os.path.join(self.fx.workspace, rel), os.path.join(stash, rel))
            for rel in files:
                os.unlink(os.path.join(self.fx.workspace, rel))
            for rel in modified:
                outcomes.git(self.fx.workspace, "checkout", "--", rel)
            return self.fx.start(ticket, role, stage, option)
        finally:
            for rel in files + modified:
                os.makedirs(os.path.dirname(os.path.join(self.fx.workspace, rel)), exist_ok=True)
                shutil.copy2(os.path.join(stash, rel), os.path.join(self.fx.workspace, rel))
            shutil.rmtree(stash, ignore_errors=True)

    def serve(self, command, args, idem):
        process = self.fx.sb.popen_serve()
        try:
            process.stdin.write(json.dumps(req(command, args, id="serve", idempotencyKey=idem)).encode("utf-8") + b"\n")
            process.stdin.flush()
            return json.loads(process.stdout.readline())
        finally:
            process.stdin.close()
            process.wait(10)
            process.stdout.close()
            process.stderr.close()

    def test_cli_feature_create_matches_serve_response(self):
        idem = key()
        _, cli_response, _ = self.fx.sb.run("ticket", "create", "--workspace", self.fx.workspace, "--kind", "feature",
                                             "--brief", self.brief, "--out", self.out, "--key", idem)
        served = self.serve("ticket.create", {"workspace": self.fx.workspace, "kind": "feature",
                                                "briefPath": self.brief, "outDir": self.out}, idem)
        self.assertEqual(cli_response["data"], served["data"])

    def test_unpack_creates_three_held_children_with_dependency_then_approve_releases_them(self):
        parent = self.create_feature()
        paths = [self.out + "/stories/" + name + ".md" for name in ("one", "two", "three")]
        for path in paths:
            self.write(path)
        self.manifest(self.out, [{"path": paths[0], "title": "One", "priority": 1, "dependsOn": []},
                                 {"path": paths[1], "title": "Two", "priority": 3, "dependsOn": []},
                                 {"path": paths[2], "title": "Three", "priority": 5, "dependsOn": [paths[0]]}])
        self.begin(parent, "TeamLead", "verdict", outcomes.fake("verdict_pass", duration=4000))
        detail = self.fx.wait_ticket(parent, "unpacked")
        self.assertEqual(outcomes.git(self.fx.workspace, "log", "-1", "--format=%s"), parent["key"] + ": unpack " + self.out)
        self.assertEqual(sorted(outcomes.git(self.fx.workspace, "show", "--format=", "--name-only", "HEAD").splitlines()),
                         sorted(paths + [self.out + "/tickets.json"]))
        children = sorted(self.children(parent), key=lambda row: row["title"])
        self.assertEqual([(row["title"], row["status"], row["priority"], row["parentTicketId"]) for row in children],
                         [("One", "backlog", 60, parent["id"]), ("Three", "backlog", 100, parent["id"]), ("Two", "backlog", 80, parent["id"])])
        self.assertEqual(self.fx.detail(children[1])["dependsOn"], [children[0]["key"]])
        idem = key()
        _, approved, _ = self.fx.sb.run("ticket", "approve", "--workspace", self.fx.workspace, parent["key"], "--key", idem)
        self.assertTrue(approved["ok"], approved)
        served = self.serve("ticket.approve", {"workspace": self.fx.workspace, "key": parent["key"]}, idem)
        self.assertEqual(approved["data"], served["data"])
        self.assertEqual(sorted(approved["data"]["approved"]), sorted(row["key"] for row in children))
        self.assertEqual([self.fx.detail(row)["ticket"]["status"] for row in children], ["refine"] * 3)
        event = [e for e in detail["events"] if e["name"] == "ticket.children_created"][-1]
        self.assertEqual(sorted(event["payload"]["keys"]), sorted(row["key"] for row in children))

    def test_unpack_with_plan_gate_disabled_creates_children_in_refine(self):
        self.set_plan_gate(False)
        parent = self.create_feature()
        paths = [self.out + "/stories/" + name + ".md" for name in ("one", "two", "three")]
        for path in paths:
            self.write(path)
        self.manifest(self.out, [{"path": path, "title": title, "dependsOn": []}
                                 for path, title in zip(paths, ("One", "Two", "Three"))])
        self.begin(parent, "TeamLead", "verdict", outcomes.fake("verdict_pass", duration=4000))
        self.fx.wait_ticket(parent, "unpacked")
        children = self.children(parent)
        self.assertEqual(len(children), 3)
        self.assertEqual([self.fx.detail(row)["ticket"]["status"] for row in children], ["refine"] * 3)

    def test_questions_retry_and_verdict_failure_block_without_children(self):
        parent = self.create_feature()
        path = self.out + "/stories/question.md"
        story = {"path": path, "title": "Question", "dependsOn": []}
        self.write(path)
        self.manifest(self.out, [story], ["Which provider?"])
        self.begin(parent, "TeamLead", "verdict", outcomes.fake("verdict_pass", duration=4000))
        blocked = self.fx.wait_ticket(parent, "blocked")["ticket"]
        self.assertEqual((blocked["blockedReason"], blocked["returnStatus"], blocked["questions"]),
                         ("UNPACK_QUESTIONS", "ready_unpack", ["Which provider?"]))
        self.assertFalse(self.children(parent))
        _, reply, _ = self.fx.sb.request(req("ticket.unblock", {"workspace": self.fx.workspace, "key": parent["key"]}, idempotencyKey=key()))
        self.assertTrue(reply["ok"], reply)
        self.manifest(self.out, [story])
        self.begin(parent, "TeamLead", "verdict", outcomes.fake("verdict_pass", duration=4000))
        self.fx.wait_ticket(parent, "unpacked")
        self.assertEqual(len(self.children(parent)), 1)
        failed = self.create_feature("phases/phase-05")
        self.begin(failed, "TeamLead", "verdict", outcomes.fake("verdict_fail", duration=4000))
        failure = self.fx.wait_ticket(failed, "blocked")["ticket"]
        self.assertEqual((failure["blockedReason"], failure["returnStatus"]), ("VERDICT_FAIL:unpack", "ready_unpack"))
        self.assertFalse(self.children(failed))

    def test_reunpack_updates_and_keeps_children_without_a_second_commit(self):
        self.set_plan_gate(False)
        parent = self.create_feature()
        first, started, removed = [self.out + "/stories/" + n + ".md" for n in ("first", "started", "removed")]
        for path in (first, started, removed):
            self.write(path)
        self.manifest(self.out, [{"path": first, "title": "First", "priority": 1, "dependsOn": []},
                                 {"path": started, "title": "Started", "priority": 2, "dependsOn": []},
                                 {"path": removed, "title": "Removed", "priority": 3, "dependsOn": []}])
        self.begin(parent, "TeamLead", "verdict", outcomes.fake("verdict_pass", duration=4000))
        self.fx.wait_ticket(parent, "unpacked")
        children = {row["storyPath"]: row for row in self.children(parent)}
        self.begin(children[started], "TeamLead", "verdict", outcomes.fake("verdict_pass", duration=4000))
        self.fx.wait_ticket(children[started], "ready_dev")
        self.begin(children[started], "Developer", "work", outcomes.fake("success", duration=15000))
        self.fx.move(parent, "ready_unpack")
        added = self.out + "/stories/added.md"
        self.write(added)
        self.manifest(self.out, [{"path": first, "title": "First revised", "priority": 5, "dependsOn": []},
                                 {"path": started, "title": "Ignored", "priority": 5, "dependsOn": []},
                                 {"path": added, "title": "Added", "dependsOn": []}])
        self.begin(parent, "TeamLead", "verdict", outcomes.fake("verdict_pass", duration=4000))
        detail = self.fx.wait_ticket(parent, "unpacked")
        after = {row["storyPath"]: row for row in self.children(parent)}
        self.assertEqual((after[first]["title"], after[first]["priority"]), ("First revised", 100))
        self.assertEqual((after[started]["title"], after[started]["status"]), ("Started", "in_dev"))
        self.assertIn(added, after)
        event = [event for event in detail["events"] if event["name"] == "ticket.children_created"][-1]["payload"]
        self.assertEqual((event["kept"], event["removed"]), ([children[started]["key"]], [children[removed]["key"]]))
        before = outcomes.git(self.fx.workspace, "rev-parse", "HEAD")
        before_children = {row["key"]: (row["title"], row["priority"], row["status"], row["parentTicketId"],
                                         tuple(self.fx.detail(row)["dependsOn"])) for row in self.children(parent)}
        self.fx.move(parent, "ready_unpack")
        self.begin(parent, "TeamLead", "verdict", outcomes.fake("verdict_pass", duration=4000))
        self.fx.wait_ticket(parent, "unpacked")
        self.assertEqual(outcomes.git(self.fx.workspace, "rev-parse", "HEAD"), before)
        self.assertEqual({row["key"]: (row["title"], row["priority"], row["status"], row["parentTicketId"],
                                       tuple(self.fx.detail(row)["dependsOn"])) for row in self.children(parent)},
                         before_children)

    def test_invalid_planning_paths_and_manifests_block_without_children(self):
        parent = self.create_feature()
        before = outcomes.git(self.fx.workspace, "rev-parse", "HEAD")
        self.begin(parent, "TeamLead", "verdict", outcomes.fake("verdict_pass", duration=4000))
        self.write("outside.md")
        self.assertEqual(self.fx.wait_ticket(parent, "blocked")["ticket"]["blockedReason"], "PLANNING_DIFF_INVALID")
        os.unlink(os.path.join(self.fx.workspace, "outside.md"))   # it would otherwise taint the later cases
        self.assertEqual(outcomes.git(self.fx.workspace, "rev-parse", "HEAD"), before)
        self.assertFalse(self.children(parent))
        for number, raw, stories in (("05", None, None), ("06", "{bad json", None),
                                    ("07", None, [{"path": "phases/phase-07/stories/missing.md", "title": "Missing", "dependsOn": []}])):
            with self.subTest(number=number):
                outcomes.git(self.fx.workspace, "clean", "-fdq", "--", "phases")   # drop the previous case's blocked files
                out = "phases/phase-" + number
                candidate = self.create_feature(out)
                if raw is not None or stories is not None:
                    self.manifest(out, stories or [], raw=raw)
                self.begin(candidate, "TeamLead", "verdict", outcomes.fake("verdict_pass", duration=4000))
                ticket = self.fx.wait_ticket(candidate, "blocked")["ticket"]
                self.assertEqual(ticket["blockedReason"], "MANIFEST_INVALID")
                self.assertTrue(ticket["questions"])
                self.assertFalse(self.children(candidate))
