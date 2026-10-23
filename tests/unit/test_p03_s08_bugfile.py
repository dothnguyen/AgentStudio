import unittest

from agent_studio import bugfile, schema


def valid(key="T-001"):
    return """# BUG-%s — Crash\nSeverity: major\n\n## Steps to reproduce\nOpen it\n\n## Expected\nWorks\n\n## Actual\nCrashes\n\n## Environment\nNone\n\n## Suspected area\nLogin\n\n## Done when\n- [ ] regression test passes\n\n## Out of scope\nNone\n\n## Open questions\nNone\n""" % key


class BugfileTests(unittest.TestCase):
    def test_valid_file_returns_severity_and_mapping(self):
        got = bugfile.check(valid(), "T-001", ["T-001"])
        self.assertEqual(got["errors"], [])
        self.assertEqual(got["severity"], "major")
        self.assertEqual(schema.BUG_SEVERITY_PRIORITY, {"blocker": 10, "major": 40, "minor": 70})

    def test_invalid_sections_are_named(self):
        cases = [(valid().replace("# BUG-T-001", "# BUG-T-999"), "heading"),
                 (valid().replace("# BUG-T-001 — Crash", "# BUG-T-001 —    "), "heading"),
                 (valid().replace("Severity: major", "Severity: urgent"), "Severity"),
                 (valid().replace("- [ ] regression test passes", "- [ ] tests pass"), "Done when")]
        for required in bugfile.REQUIRED_SECTIONS:
            cases.extend((
                (valid().replace("## " + required + "\n", ""), required),
                (valid().replace("## " + required + "\n" + {
                    "Steps to reproduce": "Open it", "Expected": "Works", "Actual": "Crashes",
                    "Environment": "None", "Suspected area": "Login",
                    "Done when": "- [ ] regression test passes", "Out of scope": "None",
                    "Open questions": "None"}[required], "## " + required + "\n"), required),
            ))
        for text, section in cases:
            with self.subTest(section=section):
                self.assertIn(section, [e["section"] for e in bugfile.check(text, "T-001", ["T-001"])["errors"]])

    def test_duplicate_needs_only_heading_and_severity(self):
        got = bugfile.check("# BUG-T-002 — Duplicate\nSeverity: minor\nDuplicate of: T-001\n", "T-002", ["T-001", "T-002"])
        self.assertEqual(got["errors"], [])
        self.assertEqual(got["duplicateOf"], "T-001")
        for duplicate in ("T-002", "T-999"):
            self.assertIn("Duplicate of", [e["section"] for e in bugfile.check(
                "# BUG-T-002 — Duplicate\nSeverity: minor\nDuplicate of: " + duplicate, "T-002", ["T-001", "T-002"])["errors"]])
