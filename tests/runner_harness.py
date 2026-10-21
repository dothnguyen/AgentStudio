"""Run the real runner for one assignment without tmux (the S03 tests cover the pane path)."""
import json
import os
import subprocess

from tests.helpers import SHIM
from agent_studio import report_rules, reports, state, teams
from agent_studio.runner import request_path, run_dir
from agent_studio.store import Store


class RunnerHarness:
    def __init__(self, sandbox, workspace):
        self.sb = sandbox
        self.ws = workspace
        os.makedirs(sandbox.state_dir, mode=0o700, exist_ok=True)
        self.db = state.db_path(sandbox.state_dir)
        self.conn = state.connect(self.db, role="coordinator", create=True)
        state.migrate(self.conn, self.db)
        self.st = Store(self.conn)
        with self.st.transaction() as tx:
            self.team = tx.create("team", {"name": "harness", "workspace": workspace})
            self.agent = tx.create("agent", {"team_id": self.team, "ordinal": 0, "provider_id": "fake",
                                             "role": "developer", "display_name": "dev", "pane_state": "alive"})
            tx.transition("agent", self.agent, "idle")

    def claimed(self, goal="harness task", policy="read_only", options=None, **request_extra):
        request = dict({"providerOptions": options or {}}, **request_extra)
        with self.st.transaction() as tx:
            task = tx.create("task", {"team_id": self.team, "origin": "direct", "workspace": self.ws, "goal": goal})
            asg = tx.create("assignment", {"team_id": self.team, "task_id": task, "agent_id": self.agent, "attempt": 1,
                                           "policy": policy, "provider_id": "fake", "request_json": request})
            tx.transition("task", task, "assigned")
            tx.transition("assignment", asg, "claimed")
        teams.write_request(self.sb.state_dir, self.conn, asg)
        os.makedirs(os.path.dirname(request_path(self.sb.state_dir, self.agent, asg)), mode=0o700, exist_ok=True)
        os.replace(request_path(self.sb.state_dir, self.agent, asg, "inbox"),
                   request_path(self.sb.state_dir, self.agent, asg, "active"))  # what the worker shim does
        return task, asg

    def popen(self, asg, env=None):
        return subprocess.Popen([SHIM, "runner", "--agent", self.agent, "--assignment", asg],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=dict(self.sb.env, **(env or {})))

    def run(self, asg, env=None, timeout=60):
        p = self.popen(asg, env)
        out, err = p.communicate(timeout=timeout)
        return p.returncode, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")

    def apply(self):
        reports.apply_pending(self.st, report_rules.apply)

    def result(self, asg):
        with open(os.path.join(run_dir(self.sb.state_dir, asg), "result.json"), encoding="utf-8") as f:
            return json.load(f)

    def row(self, table, id_):
        return dict(self.conn.execute(f"SELECT * FROM {table} WHERE id = ?", (id_,)).fetchone())

    def evidence(self, asg, name):
        return os.path.join(run_dir(self.sb.state_dir, asg), name)
