import importlib.util
import os
import types
import unittest
from unittest import mock

os.environ["AGENT_STUDIO"] = "/bin/true"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
spec = importlib.util.spec_from_file_location("team_ticket_py", os.path.join(ROOT, "scripts", "team", "team.py"))
team = importlib.util.module_from_spec(spec)
spec.loader.exec_module(team)


def ns(action, **kw):
    base = dict(ticket_action=action, workspace="/ws", story=None, brief=None, out=None, depends=[], no_deps=False,
                priority=None, key=None, status=None, reason=None, on=[])
    return types.SimpleNamespace(**dict(base, **kw))


def run(namespace, responses):
    with mock.patch.object(team, "cli", side_effect=responses) as cli, mock.patch("builtins.print") as out:
        team.c_ticket(namespace)
    return cli, [c.args[0] for c in out.call_args_list]


def receipt(deps, resolved, unresolved):
    return {"ticket": {"key": "T-004"}, "dependsOn": deps, "parsed": {"ids": resolved, "resolved": resolved, "unresolved": unresolved}}


class TicketAddTests(unittest.TestCase):
    def test_add_story_prints_key_resolved_and_unresolved(self):
        cli, out = run(ns("add", story="s.md"), [receipt(["T-001"], ["T-001"], ["P03-S99"])])
        self.assertEqual(cli.call_args.args, ("ticket", "create", "--workspace", "/ws", "--story", "s.md"))
        self.assertEqual(out, ["T-004", "depends on: T-001", "parsed: T-001", "unresolved: P03-S99"])

    def test_add_story_with_nothing_parsed(self):
        _, out = run(ns("add", story="s.md"), [receipt([], [], [])])
        self.assertEqual(out, ["T-004", "depends on: none", "parsed: none"])

    def test_no_deps_and_explicit_depends_are_marked_overridden(self):
        cli, out = run(ns("add", story="s.md", no_deps=True, priority=5), [receipt([], ["T-001"], [])])
        self.assertEqual(cli.call_args.args[-3:], ("--no-deps", "--priority", "5"))
        self.assertEqual(out, ["T-004", "depends on: none", "dependencies overridden"])
        cli, out = run(ns("add", story="s.md", depends=["T-002"]), [receipt(["T-002"], [], [])])
        self.assertEqual(cli.call_args.args[-2:], ("--depends", "T-002"))
        self.assertEqual(out, ["T-004", "depends on: T-002", "dependencies overridden"])

    def test_add_brief_creates_feature_ticket(self):
        cli, out = run(ns("add", brief="b.md", out="phases"), [receipt([], [], [])])
        self.assertEqual(cli.call_args.args, ("ticket", "create", "--workspace", "/ws", "--kind", "feature",
                                              "--brief", "b.md", "--out", "phases"))
        self.assertEqual(out, ["T-004", "depends on: none"])

    def test_story_with_brief_or_neither_exits_2(self):
        for kw in ({"story": "s.md", "brief": "b.md", "out": "o"}, {}, {"brief": "b.md"}):
            with self.subTest(kw=kw), mock.patch.object(team, "cli") as cli, mock.patch("sys.stderr"), \
                    self.assertRaises(SystemExit) as raised:
                team.c_ticket(ns("add", **kw))
            self.assertEqual(raised.exception.code, 2)
            cli.assert_not_called()


class TicketOtherTests(unittest.TestCase):
    DETAIL = {"ticket": {"key": "T-004", "kind": "story", "status": "blocked", "title": "Do it", "storyPath": "s.md",
                         "blockedReason": "ROUND_LIMIT:dev"},
              "dependsOn": ["T-001"], "dependents": [],
              "events": [{"at": f"t{i}", "name": "ticket.moved", "fromStatus": "a", "toStatus": "b"} for i in range(7)]}

    def test_move_prints_from_and_to(self):
        cli, out = run(ns("move", key="T-004", status="ready_dev", reason="ok"),
                       [{"ticket": {"status": "refine"}}, {"ticket": {"status": "ready_dev"}}])
        self.assertEqual(cli.call_args.args, ("ticket", "move", "T-004", "--workspace", "/ws", "--to", "ready_dev", "--reason", "ok"))
        self.assertEqual(out, ["T-004: refine -> ready_dev"])

    def test_show_prints_summary_and_last_five_events(self):
        cli, out = run(ns("show", key="T-004"), [self.DETAIL])
        self.assertEqual(cli.call_args.args, ("ticket", "show", "T-004", "--workspace", "/ws"))
        self.assertEqual(out[:5], ["T-004 story blocked  Do it", "s.md", "depends on: T-001", "dependents: none",
                                   "blocked: ROUND_LIMIT:dev"])
        self.assertEqual(out[5:], [f"t{i} ticket.moved a->b" for i in range(2, 7)])

    def test_depend_sends_argv_and_prints_dependencies(self):
        cli, out = run(ns("depend", key="T-004", on=["T-001", "T-002"]), [{}, {"dependsOn": ["T-001", "T-002"]}])
        self.assertEqual(cli.call_args_list[0].args, ("ticket", "depend", "T-004", "--workspace", "/ws", "--on", "T-001", "--on", "T-002"))
        self.assertEqual(out, ["depends on: T-001, T-002"])
