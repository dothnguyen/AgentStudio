import contextlib
import importlib.util
import io
import json
import os
import re
import stat
import tempfile
import unittest
from unittest.mock import patch

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")


def load(name, rel):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, rel))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


helper = load("app_live_helper", "scripts/live/app-live-helper.py")
SAFE = re.compile(r"^[A-Za-z0-9._/:@+=~-]+$")
SERVE = b"python3\0-s\0/x/launch.py\0serve\0"


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


class AppLiveHelperTest(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self.tmp = self._td.name

    def make_proc(self):
        proc = os.path.join(self.tmp, "proc")
        for pid, cmd, env in [
            ("11", SERVE, b"A=1\0XDG_STATE_HOME=/tmp/S\0"),
            ("12", SERVE, b"XDG_STATE_HOME=/other\0"),
            ("13", b"python3\0-s\0/x/launch.py\0coordinator\0", b"XDG_STATE_HOME=/tmp/S\0"),
            ("14", SERVE, None),
            ("self", SERVE, b"XDG_STATE_HOME=/tmp/S\0"),
        ]:
            write(os.path.join(proc, pid, "cmdline"), cmd)
            if env is not None:
                write(os.path.join(proc, pid, "environ"), env)
        return proc

    def test_setup_creates_layout(self):
        r = helper.setup(self.tmp)
        self.assertEqual(os.path.dirname(r["root"]), os.path.realpath(self.tmp))
        self.assertRegex(os.path.basename(r["root"]), r"^agent-studio-live-[0-9a-f]{12}$")
        self.assertEqual(stat.S_IMODE(os.stat(r["state"]).st_mode), 0o700)
        self.assertTrue(os.path.isdir(r["workspace"]))

    def test_setup_names_are_safe_args(self):
        tmp = tempfile.mkdtemp(prefix="t", dir="/tmp")
        self.addCleanup(lambda: __import__("shutil").rmtree(tmp, ignore_errors=True))
        if not SAFE.match(tmp):
            self.skipTest("temp dir name is not a safe arg")
        for _ in range(20):
            r = helper.setup(tmp)
            for k in ("root", "state", "workspace"):
                self.assertRegex(r[k], SAFE)

    def test_find_serve_pids_matches_only_temp_state(self):
        self.assertEqual(helper.find_serve_pids("/tmp/S", self.make_proc(), uid=os.getuid()), [11])

    def test_find_serve_pids_skips_other_uid(self):
        self.assertEqual(helper.find_serve_pids("/tmp/S", self.make_proc(), uid=os.getuid() + 1), [])

    def test_serve_pids_reports_state_scoped_count(self):
        self.assertEqual(helper.serve_pids("/tmp/S", self.make_proc()), {"pids": [11], "count": 1})

    def test_main_serve_pids_prints_one_json_line(self):
        with patch.object(helper, "serve_pids", return_value={"pids": [11], "count": 1}):
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = helper.main(["serve-pids", "--state", "/tmp/S"])
        self.assertEqual(rc, 0)
        lines = buf.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(json.loads(lines[0]), {"pids": [11], "count": 1})

    def test_serve_pids_with_no_match_reports_zero(self):
        self.assertEqual(helper.serve_pids("/tmp/S-none", self.make_proc()), {"pids": [], "count": 0})

    def test_main_serve_pids_oserror_prints_error_and_exits_2(self):
        with patch.object(helper, "serve_pids", side_effect=OSError("no proc")):
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = helper.main(["serve-pids", "--state", "/tmp/S"])
        self.assertEqual(rc, 2)
        lines = buf.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(json.loads(lines[0]), {"error": "no proc"})

    def test_kill_serve_with_no_match(self):
        self.assertEqual(helper.kill_serve("/tmp/S-none", self.make_proc()), {"killed": []})

    def test_kill_serve_signals_only_matching_processes(self):
        proc = self.make_proc()
        with patch.object(helper.os, "kill") as kill:
            self.assertEqual(helper.kill_serve("/tmp/S", proc), {"killed": [11]})
        kill.assert_called_once_with(11, helper.signal.SIGKILL)

    def test_cleanup_kills_matching_serve_before_removing_temp_dir(self):
        r = helper.setup(self.tmp)
        proc = os.path.join(self.tmp, "proc2")
        write(os.path.join(proc, "11", "cmdline"), SERVE)
        write(os.path.join(proc, "11", "environ"), b"XDG_STATE_HOME=" + r["state"].encode() + b"\0")
        real_kill_serve = helper.kill_serve
        calls = []

        def checked_kill_serve(state, proc_root="/proc"):
            calls.append((state, os.path.isdir(r["root"])))
            return real_kill_serve(state, proc_root)

        with patch.object(helper, "kill_serve", side_effect=checked_kill_serve), patch.object(helper.os, "kill") as kill:
            self.assertEqual(
                helper.cleanup(r["root"], self.tmp, proc_root=proc),
                {"removed": r["root"]},
            )

        self.assertEqual(calls, [(r["root"] + "/state", True)])
        kill.assert_called_once_with(11, helper.signal.SIGKILL)
        self.assertFalse(os.path.exists(r["root"]))

    def test_cleanup_removes_live_dir(self):
        r = helper.setup(self.tmp)
        empty = os.path.join(self.tmp, "emptyproc")
        os.mkdir(empty)
        self.assertEqual(helper.cleanup(r["root"], self.tmp, proc_root=empty), {"removed": r["root"]})
        self.assertFalse(os.path.exists(r["root"]))

    def test_cleanup_refuses_other_dirs(self):
        other = os.path.join(self.tmp, "not-live")
        os.mkdir(other)
        with self.assertRaisesRegex(ValueError, "^refusing to remove"):
            helper.cleanup(other, self.tmp)
        self.assertTrue(os.path.isdir(other))

    def test_main_prints_one_json_line_and_error_exit(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = helper.main(["cleanup", "--root", "/etc"])
        self.assertEqual(rc, 2)
        lines = buf.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertTrue(json.loads(lines[0])["error"].startswith("refusing to remove /etc"))

    def test_main_setup_prints_one_json_line(self):
        with patch.object(helper, "setup", return_value={"root": "/tmp/agent-studio-live-a", "state": "/tmp/agent-studio-live-a/state", "workspace": "/tmp/agent-studio-live-a/ws"}):
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = helper.main(["setup"])

        self.assertEqual(rc, 0)
        lines = buf.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(json.loads(lines[0])["state"], "/tmp/agent-studio-live-a/state")


if __name__ == "__main__":
    unittest.main()
