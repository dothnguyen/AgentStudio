import importlib.util
import json
import os
import types
import unittest
from unittest import mock

os.environ["AGENT_STUDIO"] = "/bin/true"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
spec = importlib.util.spec_from_file_location("team_board_py", os.path.join(ROOT, "scripts", "team", "team.py"))
team = importlib.util.module_from_spec(spec)
spec.loader.exec_module(team)
FIXTURES = os.path.join(ROOT, "tests", "fixtures", "board")
RED, RESET = "\033[31m", "\033[0m"


def fixture(name):
    with open(os.path.join(FIXTURES, name), encoding="utf-8") as f:
        return json.load(f) if name.endswith(".json") else f.read()


class RenderTests(unittest.TestCase):
    def test_render_board_matches_golden_without_color(self):
        text = team.render_board(fixture("board_show.json"), False)
        self.assertEqual(text + "\n", fixture("board_show.txt"))
        self.assertNotIn("\033", text)

    def test_render_board_colors_only_the_limit_line(self):
        colored = team.render_board(fixture("board_show.json"), True).splitlines()
        plain = team.render_board(fixture("board_show.json"), False).splitlines()
        for got, want in zip(colored, plain):
            if want.startswith("LIMIT:"):
                self.assertEqual(got, RED + want + RESET)
            else:
                self.assertEqual(got, want)

    def test_render_board_unknown_reset_and_reason(self):
        data = {"workspace": "/w/x", "board": {"status": "paused", "reason": "r"}, "held": [],
                "columns": [], "agents": [{"name": "a", "role": "Dev", "availability": "limit_reached", "limitResetAt": None}]}
        self.assertEqual(team.render_board(data, False), "board x: paused (r)\nLIMIT: a (Dev) until unknown")

    def test_render_boards_matches_golden(self):
        text = team.render_boards(fixture("board_list.json"), False)
        self.assertEqual(text + "\n", fixture("board_list.txt"))
        colored = team.render_boards(fixture("board_list.json"), True)
        self.assertIn(RED + "  LIMIT: qa-1 until 14:05Z" + RESET, colored)
        self.assertEqual(colored.count("\033[31m"), 1)


class BoardCommandTests(unittest.TestCase):
    AGENTS = [{"agentId": "id-qa", "name": "qa-1"}, {"agentId": "id-dev", "name": "dev-1"}]

    def ns(self, action, **kw):
        return types.SimpleNamespace(board_action=action, workspace="/ws", reason=None, agent=None, all=False, **kw)

    def run_board(self, ns, responses):
        with mock.patch.object(team, "cli", side_effect=responses) as cli, mock.patch("builtins.print") as out:
            team.c_board(ns)
        return cli, [c.args[0] for c in out.call_args_list]

    def test_resume_agent_matches_name_case_insensitively(self):
        ns = types.SimpleNamespace(board_action="resume", workspace="/ws", reason=None, agent="QA-1", all=False)
        cli, out = self.run_board(ns, [{"agents": self.AGENTS}, {"resumed": ["id-qa"]}])
        self.assertEqual(cli.call_args.args, ("board", "resume", "--workspace", "/ws", "--agent", "id-qa"))
        self.assertEqual(out, ["resumed: qa-1"])

    def test_resume_unknown_agent_exits_without_calling_resume(self):
        ns = types.SimpleNamespace(board_action="resume", workspace="/ws", reason=None, agent="nobody", all=False)
        with mock.patch.object(team, "cli", return_value={"agents": self.AGENTS}) as cli:
            with self.assertRaises(SystemExit) as raised:
                team.c_board(ns)
        self.assertEqual(raised.exception.code, "Unknown agent nobody. Agents: qa-1, dev-1")
        self.assertEqual(len(cli.call_args_list), 1)

    def test_resume_all_and_none_resumed(self):
        ns = types.SimpleNamespace(board_action="resume", workspace="/ws", reason=None, agent=None, all=True)
        cli, out = self.run_board(ns, [{"agents": self.AGENTS}, {"resumed": []}])
        self.assertEqual(cli.call_args.args, ("board", "resume", "--workspace", "/ws", "--all"))
        self.assertEqual(out, ["resumed: none"])

    def test_run_and_pause_send_matching_argv(self):
        cli, out = self.run_board(self.ns("run"), [{}])
        self.assertEqual(cli.call_args.args, ("board", "run", "--workspace", "/ws"))
        self.assertEqual(out, ["board running"])
        ns = self.ns("pause")
        ns.reason = "x"
        cli, out = self.run_board(ns, [{}])
        self.assertEqual(cli.call_args.args, ("board", "pause", "--workspace", "/ws", "--reason", "x"))
        self.assertEqual(out, ["board paused (x)"])

    def test_board_without_action_prints_kanban(self):
        cli, out = self.run_board(self.ns(None), [fixture("board_show.json")])
        self.assertEqual(cli.call_args.args, ("board", "show", "--workspace", "/ws"))
        self.assertEqual(out[0].splitlines()[0], "board api: running")

    def test_boards_prints_one_line_per_board(self):
        with mock.patch.object(team, "cli", return_value=fixture("board_list.json")) as cli, mock.patch("builtins.print") as out:
            team.c_boards(None)
        cli.assert_called_once_with("board", "list")
        self.assertIn("api  running", out.call_args.args[0])


class StatusTests(unittest.TestCase):
    def status(self, boards):
        def fake(*args, **kw):
            if args[:2] == ("board", "list"):
                return {"boards": boards}
            return {"agents": [], "workflowRuns": [], "assignments": []}
        with mock.patch.object(team, "cli", side_effect=fake), mock.patch.object(team, "team", return_value={"teamId": "t"}), \
                mock.patch("builtins.print") as out:
            team.c_status(None)
        return [c.args[0] for c in out.call_args_list if c.args and str(c.args[0]).startswith("board: ")]

    def board(self, status, workspace=None):
        b = dict(fixture("board_list.json")["boards"][0], status=status)
        b["workspace"] = workspace or team.WS
        return b

    def test_status_prints_board_line_only_for_running_or_paused_own_workspace(self):
        self.assertEqual(self.status([self.board("running")])[0][:21], "board: api  running  ")
        self.assertEqual(len(self.status([self.board("paused")])), 1)
        self.assertEqual(self.status([self.board("unavailable")]), [])
        self.assertEqual(self.status([self.board("running", "/somewhere/else")]), [])
        self.assertEqual(self.status([]), [])
