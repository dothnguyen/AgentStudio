"""Pure validation for structured board bug files."""
from __future__ import annotations

import re

REQUIRED_SECTIONS = ("Steps to reproduce", "Expected", "Actual", "Environment", "Suspected area",
                     "Done when", "Out of scope", "Open questions")


def check(text, key, known_keys):
    """Check a bug document, returning its parsed severity, duplicate and all errors."""
    errors = []
    lines = text.splitlines()
    first = next((line for line in lines if line.strip()), "")
    heading = re.fullmatch(r"# BUG-" + re.escape(key) + r" — (.*)", first)
    if not heading or not heading.group(1).strip():
        errors.append({"section": "heading", "message": "must be '# BUG-" + key + " — <title>'"})
    severity = None
    for line in lines:
        found = re.fullmatch(r"Severity: (blocker|major|minor)", line)
        if found:
            severity = found.group(1)
            break
    if severity is None:
        errors.append({"section": "Severity", "message": "must be blocker, major, or minor"})
    duplicate = None
    duplicate_lines = [line for line in lines if line.startswith("Duplicate of:")]
    if duplicate_lines:
        match = re.fullmatch(r"Duplicate of: (T-\d{3,})", duplicate_lines[0])
        if not match or match.group(1) == key or match.group(1) not in known_keys:
            errors.append({"section": "Duplicate of", "message": "must name another known ticket"})
        else:
            duplicate = match.group(1)
    if duplicate is None:
        headings = {name: None for name in REQUIRED_SECTIONS}
        for i, line in enumerate(lines):
            if line.startswith("## ") and line[3:] in headings:
                headings[line[3:]] = i
        for name, start in headings.items():
            if start is None:
                errors.append({"section": name, "message": "is required"})
                continue
            body = []
            for line in lines[start + 1:]:
                if line.startswith("## "):
                    break
                body.append(line)
            if not any(line.strip() for line in body):
                errors.append({"section": name, "message": "must not be empty"})
            if name == "Done when" and not any(re.match(r"- (?:\[ \] )?.*regression test", line, re.I) for line in body):
                errors.append({"section": name, "message": "needs a regression test list item"})
    return {"severity": severity, "duplicateOf": duplicate, "errors": errors}
