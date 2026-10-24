#!/usr/bin/env python3
"""P04-S11 board live gate - the WSL side. Run inside the target distro, from anywhere:

    python3 /mnt/c/Works/Projects/AgentStudio/scripts/live/board_live_gate.py run
            [--providers codex,claude] [--non-interactive] [--keep-teams]

Drives the generic board through `team run-board` on REAL providers (the fake provider is refused) in
uniquely named disposable git workspaces, and writes an evidence bundle to <state>/board-live-gate/<time>/.

Scenario (the S11 story, step 5): three tickets in a new phase made current with `board phase set-current`
(one depending on another, one told to fail its first review), all reaching `done`; a ticket in another
phase is left alone; a second team in a second workspace stays free for `ask` while the board runs.

    --dry-run runs the same machinery on the fake provider (plumbing proof only; the summary is marked
    DRY-RUN and is not live-gate evidence).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SHIM = os.path.join(REPO, "backend", "bin", "agent-studio")
IMPL = {"version": 1, "description": "one agent stage", "stages": [
    {"id": "work", "role": "Implementer", "permission": "workspace_write", "prompt":
     "You are working one board ticket. Do what the ticket text asks, briefly.\n{{task}}",
     "next": {"done": "$succeed"}}]}
REVIEW = {"version": 1, "description": "one reviewer stage", "stages": [
    {"id": "look", "role": "Reviewer", "permission": "read_only", "prompt":
     "You are reviewing one board ticket. Judge what the ticket text asks. End with a verdict line "
     '{"verdict": "pass"} or {"verdict": "fail", "findings": [...]}.\n{{task}}',
     "next": {"pass": "$succeed", "fail": "$fail"}}]}
REVIEW_DONE = {"version": 1, "description": "one reviewer stage (verdict-free, for the dry run)", "stages": [
    {"id": "look", "role": "Reviewer", "permission": "read_only", "prompt":
     "You are reviewing one board ticket.\\n{{task}}", "next": {"done": "$succeed"}}]}
ROLES = {"version": 1, "roles": {"Implementer": {"description": "works tickets"},
                                 "Reviewer": {"description": "reviews tickets"}}}
BOARD = {"version": 2, "leaseSeconds": 1800, "statuses": [
    {"id": "build", "kind": "initial"}, {"id": "review"}, {"id": "done", "kind": "done"}],
    "ticketFields": [], "rules": [
        {"when": {"status": "build"}, "role": "Implementer", "workflow": "impl",
         "onPass": "review", "onFail": "build", "maxRounds": 3, "requiresDeps": True},
        {"when": {"status": "review"}, "role": "Reviewer", "workflow": "review",
         "onPass": "done", "onFail": "build", "maxRounds": 3}]}
FAIL_ONCE_BODY = ("This ticket must fail its FIRST review on purpose: the reviewer's first verdict for it "
                  "must be fail with the finding 'gate: forced first-round fail'. On the second round, "
                  "write the file gate-3.txt with the text: gate three, and pass.")


class Fail(Exception):
    pass


def sh(*argv, timeout=120):
    p = subprocess.run(list(argv), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                       timeout=timeout)
    if p.returncode != 0:
        raise Fail(f"{' '.join(argv[:3])} failed ({p.returncode}):\n{p.stdout[-2000:]}")
    return p.stdout


def cli(*args, timeout=120):
    """One agent-studio command -> the response envelope's data, or raises with the error."""
    out = sh(SHIM, *args, timeout=timeout)
    lines = [l for l in out.splitlines() if l.strip()]
    try:
        resp = json.loads(lines[-1]) if lines else None
    except ValueError:
        raise Fail(f"non-JSON answer to {args[:3]}:\n{out[-2000:]}")
    if not isinstance(resp, dict) or not resp.get("ok"):
        raise Fail(f"{' '.join(args[:3])} answered:\n{json.dumps(resp)[:2000]}")
    return resp.get("data")


class Gate:
    def __init__(self, providers, keep, dry):
        self.providers = list(providers)
        self.keep = keep
        self.dry = dry
        self.stamp = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
        self.steps = []
        self.workspaces = []

    def state_dir(self):
        return os.path.join(os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state"),
                            "agent-studio")

    def bundle_dir(self):
        return os.path.join(self.state_dir(), "board-live-gate", self.stamp)

    def record(self, step, result, **extra):
        entry = dict({"id": step, "result": result, "at": time.strftime("%H:%M:%S")}, **extra)
        self.steps.append(entry)
        print(f"[{entry['result']:>4}] {step} " + " ".join(f"{k}={v}" for k, v in extra.items()
                                                           if isinstance(v, (str, int, bool))), flush=True)

    def make_workspace(self, name):
        root = tempfile.mkdtemp(prefix=f"as-boardgate-{name}-")
        ws = os.path.join(root, "repo")
        self.workspaces.append(root)
        cfg = os.path.join(ws, ".agent-studio")
        os.makedirs(os.path.join(cfg, "workflows"))
        os.makedirs(os.path.join(cfg, "teams"))

        def put(rel, obj):
            with open(os.path.join(cfg, rel), "w") as f:
                json.dump(obj, f)

        put("workflow.json", {"version": 1, "validation": {"argv": ["python3", "-c", "pass"],
                                                           "timeoutMs": 60000}})
        put("roles.json", ROLES)
        put("workflows/impl.json", IMPL)
        put("workflows/review.json", REVIEW_DONE if self.dry else REVIEW)  # the fake gives no verdicts
        put("board.json", BOARD)
        put("teams/main.json", {"id": "main", "name": "Board team", "members": [
            {"id": "implementer", "name": "Implementer", "role": "Implementer",
             "provider": self.providers[0]},
            {"id": "reviewer", "name": "Reviewer", "role": "Reviewer",
             "provider": self.providers[-1]}]})
        put("teams/other.json", {"id": "other", "name": "Other team", "members": [
            {"id": "helper", "name": "Helper", "role": "Implementer", "provider": self.providers[0]}]})
        sh("git", "-C", ws, "init", "-q", "-b", "main")
        sh("git", "-C", ws, "config", "user.email", "gate@example.invalid")
        sh("git", "-C", ws, "config", "user.name", "board gate")
        sh("git", "-C", ws, "add", "-A")
        sh("git", "-C", ws, "commit", "-qm", "board gate fixture")
        return ws

    def ticket(self, ws, key):
        return cli("ticket", "show", key, "--workspace", ws, "--json")

    def wait_status(self, ws, key, statuses, timeout):
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            last = self.ticket(ws, key)
            if last["ticket"]["status"] in statuses:
                return last
            time.sleep(0.5 if self.dry else 10)
        raise Fail(f"{key} never reached {statuses}; last={json.dumps(last)[:1500]}")

    def run(self):
        started = time.time()
        cli("coordinator", "start", *(["--enable-debug"] if self.dry else []))
        ws = self.make_workspace("main")
        other_ws = self.make_workspace("other")

        rules = cli("board", "rules", "check", "--workspace", ws, "--json")
        self.record("0-rules", "PASS", problems=len(rules["problems"]))

        cli("team", "start", "--workspace", ws, "--team", "main")
        cli("team", "start", "--workspace", other_ws, "--team", "other")
        self.record("1-teams", "PASS")

        cli("board", "phase", "add", "--workspace", ws, "--id", "sprint-2", "--name", "Sprint 2", "--json")
        cli("board", "phase", "set-current", "--workspace", ws, "sprint-2", "--json")
        self.record("2-phase-current", "PASS", phase="sprint-2")

        one = cli("ticket", "add", "--workspace", ws, "--title", "Gate ticket one", "--phase", "sprint-2",
                  "--body", "Write the file gate-1.txt with exactly the text: gate one", "--json")["ticket"]
        two = cli("ticket", "add", "--workspace", ws, "--title", "Gate ticket two (depends on one)",
                  "--phase", "sprint-2", "--body",
                  "Write the file gate-2.txt with exactly the text: gate two", "--json")["ticket"]
        three = cli("ticket", "add", "--workspace", ws, "--title", "Gate ticket three (fails review once)",
                    "--phase", "sprint-2", "--body", FAIL_ONCE_BODY, "--json")["ticket"]
        out_of_phase = cli("ticket", "add", "--workspace", ws, "--title", "Not in this phase",
                           "--json")["ticket"]
        cli("ticket", "depend", "--workspace", ws, two["key"], "--on", one["key"], "--json")
        self.record("3-tickets", "PASS", keys=f"{one['key']},{two['key']},{three['key']}+"
                                              f"{out_of_phase['key']}(other phase)")

        cli("team", "run-board", "--workspace", ws, "--team", "main", "--json")
        self.record("4-run-board", "PASS")

        asked = cli("team", "ask", "--workspace", other_ws, "--team", "other", "--member", "Helper",
                    "--wait", "--json", "Reply with the single word: ready", timeout=1800)
        self.record("5-other-team-ask", "PASS", status=str(asked.get("status"))[:40])

        timeout = 300 if self.dry else 5400
        self.wait_status(ws, one["key"], ("done",), timeout)
        self.wait_status(ws, two["key"], ("done",), timeout)
        self.wait_status(ws, three["key"], ("done",), timeout)
        self.record("6-three-done", "PASS")

        two_detail = self.ticket(ws, two["key"])
        one_done_at = next((e for e in self.ticket(ws, one["key"])["events"][::-1]
                            if e["name"] == "ticket.outcome_applied"), None)
        two_claimed_at = next((e for e in two_detail["events"][::-1] if e["name"] == "ticket.claimed"), None)
        if not one_done_at or not two_claimed_at or two_claimed_at["id"] <= one_done_at["id"]:
            raise Fail("the dependency was not honored: ticket two was claimed before one finished")
        if self.dry:
            self.record("7-dependency-and-forced-fail", "SKIP",
                        note="the fake provider gives no verdicts; the forced fail is proven on real providers")
        else:
            three_events = self.ticket(ws, three["key"])["events"]
            failed_once = any(e["name"] == "ticket.outcome_applied"
                              and e.get("payload", {}).get("outcome") == "fail" for e in three_events)
            if not failed_once:
                raise Fail("ticket three never failed a review round (the forced fail did not happen)")
            self.record("7-dependency-and-forced-fail", "PASS")

        untouched = self.ticket(ws, out_of_phase["key"])
        cli("team", "stop-board", "--workspace", ws, "--team", "main", "--json")
        if untouched["ticket"]["status"] != "build" or untouched["ticket"]["assignee"] is not None \
                or any(e["name"] == "ticket.claimed" for e in untouched["events"]):
            raise Fail(f"the other-phase ticket was not left alone: "
                       f"{json.dumps(untouched['ticket'])[:500]}")
        self.record("8-other-phase-untouched", "PASS", key=out_of_phase["key"])

        bundle = self.bundle_dir()
        os.makedirs(bundle, exist_ok=True)
        summary = {"gate": "DRY-RUN (fake provider; plumbing proof, not live-gate evidence)" if self.dry
                   else "PASS", "stamp": self.stamp, "providers": self.providers, "dryRun": self.dry,
                   "steps": self.steps, "seconds": round(time.time() - started, 1),
                   "workspaces": self.workspaces}
        with open(os.path.join(bundle, "summary.json"), "w") as f:
            json.dump(summary, f, indent=1)
        for key in (one["key"], two["key"], three["key"], out_of_phase["key"]):
            with open(os.path.join(bundle, f"{key}.json"), "w") as f:
                json.dump(self.ticket(ws, key), f, indent=1)
        print(f"Evidence: {bundle}")
        self.cleanup()
        return 0

    def cleanup(self):
        if self.keep:
            return
        for root in list(self.workspaces):
            shutil.rmtree(root, ignore_errors=True)
        self.workspaces = []


def main():
    ap = argparse.ArgumentParser(prog="board_live_gate.py")
    sub = ap.add_subparsers(dest="cmd", required=True)
    runp = sub.add_parser("run")
    runp.add_argument("--providers", default="codex,claude")
    runp.add_argument("--non-interactive", action="store_true")
    runp.add_argument("--keep-teams", action="store_true")
    runp.add_argument("--dry-run", action="store_true",
                      help="run the machinery on the fake provider (not live-gate evidence)")
    args = ap.parse_args()
    providers = [p.strip() for p in args.providers.split(",") if p.strip()]
    if args.dry_run:
        providers = ["fake", "fake"]
    if not args.dry_run and "fake" in providers:
        print("refusing: the live gate needs real providers (use --dry-run for the plumbing check)")
        return 2
    gate = Gate(providers, args.keep_teams, args.dry_run)
    try:
        return gate.run()
    except Fail as e:
        print(f"GATE FAILED:\n{e}")
        bundle = gate.bundle_dir()
        os.makedirs(bundle, exist_ok=True)
        with open(os.path.join(bundle, "summary.json"), "w") as f:
            json.dump({"gate": "FAIL", "error": str(e), "steps": gate.steps}, f, indent=1)
        print(f"Evidence: {bundle}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
