import importlib.util
import os
import tempfile
import types
import unittest
from unittest import mock


os.environ["AGENT_STUDIO"] = "/bin/true"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
spec = importlib.util.spec_from_file_location("team_unpack_py", os.path.join(ROOT, "scripts", "team", "team.py"))
team = importlib.util.module_from_spec(spec)
spec.loader.exec_module(team)


class TeamUnpackTests(unittest.TestCase):
    def unpack(self, agents):
        with tempfile.TemporaryDirectory() as temp:
            brief = os.path.join(temp, "brief.md")
            with open(brief, "w") as f:
                f.write("Brief text")
            ns = types.SimpleNamespace(brief=brief, out="plans")
            with mock.patch.object(team, "team", return_value={"agents": agents}), \
                 mock.patch.object(team, "direct", return_value=("succeeded", "done")) as direct, \
                 mock.patch.object(team, "show"), mock.patch("builtins.print"):
                team.c_unpack(ns)
            return direct.call_args

    def test_unpack_uses_product_owner_and_requests_manifest(self):
        call = self.unpack({"TeamLead": {"agentId": "lead"}, "ProductOwner": {"agentId": "po"}})
        self.assertEqual(call.args[0]["agentId"], "po")
        self.assertIn("tickets.json", call.args[2])

    def test_unpack_falls_back_to_team_lead(self):
        call = self.unpack({"TeamLead": {"agentId": "lead"}})
        self.assertEqual(call.args[0]["agentId"], "lead")
        self.assertNotIn("tickets.json", call.args[2])
