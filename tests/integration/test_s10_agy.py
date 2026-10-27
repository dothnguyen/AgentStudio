"""Registry discovery remains honest while the live discovery gate is blocked."""
import unittest
import tempfile
import shutil

from tests.helpers import Sandbox, key, req  # Adds backend to the import path.
from agent_studio import providers
from agent_studio.providers.base import NotImplementedAdapter


class AgyDiscovery(unittest.TestCase):
    def test_provider_registry_keeps_blocked_adapter_unavailable(self):
        self.assertIn("agy", providers.available_ids())
        adapter = providers.get("agy")
        self.assertIsInstance(adapter, NotImplementedAdapter)
        result = adapter.probe({"PATH": ""})
        self.assertEqual(result["providerId"], "agy")
        self.assertFalse(result["available"])
        self.assertTrue(all(value == "unsupported" for value in result["policies"].values()))


class AgyTeamStart(unittest.TestCase):
    def test_unavailable_provider_does_not_create_team_or_pane(self):
        sb = Sandbox()
        ws = tempfile.mkdtemp(prefix="as-agy-ws-")
        self.addCleanup(shutil.rmtree, ws, ignore_errors=True)
        self.addCleanup(sb.cleanup)
        _, response, process = sb.run("coordinator", "start")
        self.assertTrue(response["ok"], process.stderr)
        _, response, _ = sb.request(req("team.start", {"workspace": ws, "roster": [
            {"providerId": "agy", "role": "Reviewer"}]}, idempotencyKey=key()))
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "PROVIDER_UNAVAILABLE")
        self.assertIn("agy", response["error"]["message"])
        self.assertIn("not implemented", response["error"]["message"])
        self.assertEqual(sb.snapshot()["teams"], [])
        self.assertEqual(sb.tmux("list-panes", "-a", check=False), "")
