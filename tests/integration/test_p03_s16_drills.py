"""P03-S16: each board failure drill runs end to end on the fake provider and ends with every ticket merged."""
import importlib.util
import os
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
spec = importlib.util.spec_from_file_location("board_drills", os.path.join(ROOT, "scripts", "live", "board_drills.py"))
drills = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drills)


class BoardDrillsIntegration(unittest.TestCase):
    def drill(self, name):
        result = drills.run_drill(name, None)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["finalStatus"], "merged", result)

    def test_coordinator_killed(self):
        self.drill("coordinator_killed")

    def test_runner_killed(self):
        self.drill("runner_killed")

    def test_merge_conflict(self):
        self.drill("merge_conflict")

    def test_round_limit(self):
        self.drill("round_limit")

    def test_planning_outside(self):
        self.drill("planning_outside")

    def test_dirty_main(self):
        self.drill("dirty_main")

    def test_usage_limit(self):
        self.drill("usage_limit")

    def test_stuck_claim(self):
        self.drill("stuck_claim")

    def test_every_registered_drill_has_a_test(self):
        tested = {n[len("test_"):] for n in dir(self) if n.startswith("test_") and n[5:] in drills.DRILLS}
        self.assertEqual(tested, set(drills.DRILLS))


if __name__ == "__main__":
    unittest.main()
