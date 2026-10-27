"""P05-S08: catalog writes never change a running team's frozen roster."""
import os

from tests.integration.test_p04_s03_team_lifecycle import LifecycleCase
from tests.helpers import req


class CatalogFrozenRoster(LifecycleCase):
    def test_catalog_writes_do_not_change_running_team(self):
        a = self.start("alpha")["data"]
        before = self.status("alpha")["members"]
        path = os.path.join(self.ws, ".agent-studio", "teams", "alpha.json")
        team_bytes = open(path, "rb").read()
        calls = [("agentdef.create", {"agent": {"id": "ada", "name": "Ada", "provider": "fake", "model": "fake-1"}}),
                 ("agentdef.update", {"agentDefId": "ada", "changes": {"model": "fake-2"}}),
                 ("agentdef.delete", {"agentDefId": "ada"})]
        for command, args in calls:
            rc, r, p = self.sb.request(req(command, dict(args, workspace=self.ws)))
            self.assertTrue(r["ok"], (command, r, p.stderr))
        keys = ("name", "providerId", "agentId", "memberId")
        pick = lambda ms: [{k: m.get(k) for k in keys} for m in ms]  # noqa: E731
        self.assertEqual(pick(self.status("alpha")["members"]), pick(before))
        self.assertEqual(len(self.sb.snapshot(a["teamId"])["agents"]), 2)
        self.assertEqual(open(path, "rb").read(), team_bytes)
        self.assertTrue(self.stop("alpha")["ok"])
