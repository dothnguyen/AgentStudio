"""P03-S16: backend/RECOVERY.md covers every operator-visible board code and every drill."""
import glob
import importlib.util
import os
import re
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
CODES = (
    "TICKET_NOT_FOUND", "TICKET_TRANSITION_INVALID", "TICKET_BUSY", "TICKET_DEPENDENCY_CYCLE", "STORY_PATH_INVALID",
    "BOARD_CONFIG_INVALID", "WORKTREE_NOT_REGISTERED", "WORKTREE_EXISTS", "MAIN_CHECKOUT_DIRTY",
    "MAIN_CHECKOUT_WRONG_BRANCH", "PLANNING_DIFF_INVALID", "MANIFEST_INVALID", "BUG_FILE_INVALID", "MERGE_CONFLICT",
    "USAGE_LIMIT", "TICKET_ROLE_MISMATCH", "TICKET_DEPS_NOT_MERGED", "TEAM_CONFIG_INVALID",
    "RUN_PAUSED", "ROUND_LIMIT", "VERDICT_FAIL", "UNPACK_QUESTIONS", "RUN_FAILED", "OUTCOME_UNSUPPORTED",
    "WORKTREE_MISSING", "START_FAILED",
    "MAIN_CHECKOUT_BUSY",
    "NO_CHANGES",
)
SECTION = "## Board (P03)"


def board_section():
    with open(os.path.join(ROOT, "backend", "RECOVERY.md"), encoding="utf-8") as f:
        text = f.read()
    start = text.index(SECTION)
    nxt = re.search(r"^## ", text[start + len(SECTION):], re.M)
    return text[start:start + len(SECTION) + nxt.start()] if nxt else text[start:]


def drill_names():
    spec = importlib.util.spec_from_file_location("board_drills_doc", os.path.join(ROOT, "scripts", "live", "board_drills.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return list(module.DRILLS)


class RecoveryDocTests(unittest.TestCase):
    def test_every_code_exists_in_the_backend(self):
        source = ""
        for path in glob.glob(os.path.join(ROOT, "backend", "agent_studio", "*.py")):
            with open(path, encoding="utf-8") as f:
                source += f.read()
        self.assertEqual([code for code in CODES if code not in source], [])

    def test_every_code_is_in_a_table_row_with_a_backticked_command(self):
        rows = [line for line in board_section().splitlines() if line.startswith("|")]
        missing = []
        for code in CODES:
            hits = [r for r in rows if code in r]
            ok = False
            for row in hits:
                cells = [c.strip() for c in row.strip().strip("|").split("|")]
                if len(cells) >= 3 and re.search(r"`[^`]+`", cells[-1]):
                    ok = True
            if not ok:
                missing.append(code)
        self.assertEqual(missing, [])

    def test_every_drill_is_named_in_the_section(self):
        section = board_section()
        self.assertEqual([n for n in drill_names() if n not in section], [])

    def test_danger_zones_subsection_exists(self):
        section = board_section()
        self.assertRegex(section, r"(?m)^### Danger zones")
        for phrase in ("/mnt/c", "git reset --merge", "git merge --abort"):
            self.assertIn(phrase, section)


if __name__ == "__main__":
    unittest.main()
