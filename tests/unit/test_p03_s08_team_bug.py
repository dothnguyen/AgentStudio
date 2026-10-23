import importlib.util
import os
import tempfile
import types
import unittest
from unittest import mock

os.environ["AGENT_STUDIO"] = "/bin/true"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
spec = importlib.util.spec_from_file_location("team_bug_py", os.path.join(ROOT, "scripts", "team", "team.py"))
team = importlib.util.module_from_spec(spec)
spec.loader.exec_module(team)


class TeamBugTests(unittest.TestCase):
    def test_text_creates_bug_and_prints_key(self):
        with mock.patch.object(team, "cli", return_value={"ticket": {"key": "T-007"}}) as cli, mock.patch("builtins.print") as output:
            team.c_bug(types.SimpleNamespace(text="it crashes", file=None, attach=["trace.txt"]))
        cli.assert_called_once_with("ticket", "create", "--workspace", team.WS, "--kind", "bug", "--text", "it crashes", "--attach", "trace.txt")
        output.assert_called_once_with("T-007")

    def test_file_reads_utf8_forwards_attachments_and_exactly_one_source_is_required(self):
        handle, path = tempfile.mkstemp()
        os.write(handle, "from file".encode())
        os.close(handle)
        try:
            with mock.patch.object(team, "cli", return_value={"ticket": {"key": "T-008"}}) as cli:
                team.c_bug(types.SimpleNamespace(text=None, file=path, attach=["trace.txt"]))
            self.assertIn("from file", cli.call_args.args)
            self.assertEqual(cli.call_args.args[-2:], ("--attach", "trace.txt"))
        finally:
            os.unlink(path)
        for text, file in ((None, None), ("x", "a")):
            with self.subTest(text=text, file=file):
                with mock.patch("sys.stderr") as stderr, self.assertRaises(SystemExit) as raised:
                    team.c_bug(types.SimpleNamespace(text=text, file=file, attach=[]))
                self.assertEqual(raised.exception.code, 2)
                self.assertEqual(stderr.write.call_args_list,
                                 [mock.call("Give exactly one of TEXT or --file PATH."), mock.call("\n")])
