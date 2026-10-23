"""P03-S14: two developers on one fake team work two tickets at once, never two each."""
import json
import os
import sqlite3
import unittest

from tests.integration.test_p03_s06_outcomes import git
from tests.helpers import Sandbox, key, make_repo, req, wait_until

TIMEOUT = int(os.environ.get("TEST_WAIT_SECONDS", "120"))


class TwoDevelopersIntegration(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox(extra_env={"AGENT_STUDIO_TEST_FIXTURE_PROVIDERS": "codex=fake,claude=fake,agy=fake"})
        _, started, proc = self.sb.run("coordinator", "start", "--enable-debug")
        self.assertTrue(started["ok"], proc.stderr)
        self.workspace = make_repo()
        self.story = "phases/phase-03/stories/example.md"
        os.makedirs(os.path.join(self.workspace, os.path.dirname(self.story)))
        with open(os.path.join(self.workspace, self.story), "w", encoding="utf-8") as f:
            f.write("# Example\n")
        base = git(self.workspace, "symbolic-ref", "--short", "HEAD")
        with open(os.path.join(self.workspace, ".agent-studio", "board.json"), "w", encoding="utf-8") as f:
            json.dump({"baseBranch": base, "maxParallelDev": 2}, f)
        git(self.workspace, "add", "-A")
        git(self.workspace, "commit", "-m", "board fixture")
        self.db = os.path.join(self.sb.state_dir, "state.db")
        conn = sqlite3.connect(self.db)
        try:  # fixture options land with the assignment insert, before any runner can claim it
            conn.execute("""CREATE TRIGGER two_devs_fixture_options
                AFTER INSERT ON assignments
                WHEN NEW.stage_attempt_id IS NOT NULL
                BEGIN
                  UPDATE assignments
                  SET request_json = json_set(request_json, '$.providerOptions', json(
                    CASE (SELECT stage FROM stage_attempts WHERE id = NEW.stage_attempt_id)
                      WHEN 'work' THEN '{"scenario":"success","writeFile":"fixed.txt","durationMs":3000,"progressLines":1}'
                      WHEN 'verdict' THEN CASE NEW.policy
                        WHEN 'workspace_write' THEN '{"scenario":"verdict_pass","writeFile":"phases/phase-03/stories/example.md","durationMs":50,"progressLines":1}'
                        ELSE '{"scenario":"verdict_pass","durationMs":50,"progressLines":1}' END
                    END))
                  WHERE id = NEW.id;
                END""")
            conn.commit()
        finally:
            conn.close()
        roster = [{"providerId": "codex", "role": "TeamLead", "name": "lead"},
                  {"providerId": "claude", "role": "Developer", "name": "dev-1"},
                  {"providerId": "claude", "role": "Developer", "name": "dev-2"},
                  {"providerId": "agy", "role": "QA", "name": "qa"}]
        _, team, _ = self.sb.request(req("team.start", {"workspace": self.workspace, "roster": roster},
                                         idempotencyKey=key()))
        self.assertTrue(team["ok"], team)
        self.developers = {a["agentId"] for a in team["data"]["agents"] if a["role"] == "Developer"}
        self.assertEqual(len(self.developers), 2)

    def tearDown(self):
        self.sb.cleanup()

    def call(self, name, **args):
        _, response, _ = self.sb.request(req(name, dict(args, workspace=self.workspace), idempotencyKey=key()))
        self.assertTrue(response["ok"], response)
        return response["data"]

    def query(self, sql, params=()):
        conn = sqlite3.connect(self.db, timeout=10)
        try:
            return conn.execute(sql, params).fetchall()
        finally:
            conn.close()

    def test_two_developers_work_two_tickets_at_once_and_all_merge(self):
        keys = []
        for _ in range(3):
            ticket = self.call("ticket.create", storyPath=self.story)["ticket"]
            self.call("ticket.move", key=ticket["key"], to="ready_dev")
            keys.append(ticket["key"])
        self.call("board.run")

        marks = ",".join("?" * len(keys))
        seen_pair, third_early, double_active = None, False, []

        def observe():
            nonlocal seen_pair, third_early
            for agent_id, count in self.query(
                    "SELECT agent_id, COUNT(*) FROM assignments WHERE status IN "
                    "('queued','claimed','running','waiting_input','reconciling') GROUP BY agent_id"):
                if count > 1:
                    double_active.append((agent_id, count))
            rows = self.query(f"SELECT key, assignee_agent_id, worktree_path FROM tickets WHERE key IN ({marks}) "
                              "AND status = 'in_dev'", keys)
            if len(rows) > 2:
                third_early = True
            if len(rows) == 2 and seen_pair is None:
                seen_pair = rows
            done = self.query(f"SELECT COUNT(*) FROM tickets WHERE key IN ({marks}) AND status = 'merged'", keys)[0][0]
            return done == len(keys)

        wait_until(observe, timeout=TIMEOUT, interval=0.1, message="all three tickets merged")
        self.assertIsNotNone(seen_pair, "two tickets were never in_dev at once")
        self.assertFalse(third_early, "a third ticket entered in_dev while two were running")
        self.assertEqual(len({r[1] for r in seen_pair}), 2)
        self.assertEqual(len({r[2] for r in seen_pair}), 2)
        self.assertEqual({r[1] for r in seen_pair}, self.developers)
        self.assertEqual(double_active, [])

        events = [(i, k, n, to, json.loads(payload)) for i, k, n, to, payload in self.query(
            f"SELECT e.id, t.key, e.name, e.to_status, e.payload_json FROM ticket_events e "
            f"JOIN tickets t ON t.id = e.ticket_id WHERE t.key IN ({marks}) ORDER BY e.id", keys)]
        claims = [(i, k, p["agentId"]) for i, k, n, to, p in events if n == "ticket.claimed" and to == "in_dev"]

        def leave(ticket_key, after):
            return next((i for i, k, n, to, _ in events if k == ticket_key and i > after and to not in (None, "in_dev")),
                        None)

        # Tickets that conflict on merge come back to in_dev, so a ticket may have several claims.
        ends = [leave(k, i) for i, k, _ in claims]
        self.assertTrue(all(e is not None for e in ends))
        first = {}
        for n, (i, k, _) in enumerate(claims):
            first.setdefault(k, n)
        self.assertEqual(len(first), 3)
        order = sorted(first.values())
        # The third ticket enters in_dev only after one of the first two left it.
        self.assertGreater(claims[order[2]][0], min(ends[order[0]], ends[order[1]]))

        # Per developer, in_dev intervals never overlap.
        for agent in self.developers:
            spans = sorted((i, ends[n]) for n, (i, _, a) in enumerate(claims) if a == agent)
            for (_, e1), (s2, _) in zip(spans, spans[1:]):
                self.assertLessEqual(e1, s2, f"overlapping in_dev intervals for {agent}")


if __name__ == "__main__":
    unittest.main()
