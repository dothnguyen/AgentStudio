# P03-S08 — Bug tickets and the triage column

Status: To Do
Depends on: P03-S06
Architecture: [P03 design contract](../README.md#design-contract), §B (bug kind), §C (triage rows), §F (bug file path), §G (severity → priority); brief §3c

## Goal

The operator describes a bug in plain words (`team.py bug "…"`). It becomes a `bug` ticket in `triage`. The TeamLead's triage run writes a structured bug file, which the coordinator validates and commits to base. The ticket then goes straight to `ready_dev` with a priority from its severity, to `cancelled` when it is a duplicate, or to `blocked` with questions. From there the story pipeline runs with bug-specific prompts: a failing regression test first, then the fix.

## Implement in this order

1. `ticket.create` with `kind: bug` (S02 refuses it with `BAD_REQUEST` until now): `text` is required (≤ 32 KiB), plus `attachments?` and `title?` (default: the first line of the text, ≤ 80 chars). Each attachment passes `tickets.check_workspace_path` from S02 except the `.md` rule (existence checked, contents never read). Entry status `triage`.
2. Bug template `.agent-studio/templates/bug.md` and `bugfile.py` validator. Required sections:
   - `# BUG-<key> — title`;
   - `Severity: blocker|major|minor`;
   - `## Steps to reproduce`, `## Expected`, `## Actual`, `## Environment`, `## Suspected area`;
   - `## Done when` (at least one item that mentions a regression test);
   - `## Out of scope`, `## Open questions`;
   - an optional `Duplicate of: T-NNN` line.
   Each problem → `BUG_FILE_INVALID` with `{section, message}`.
3. Built-in `board-triage` (TeamLead verdict stage, `workspace_write`). The prompt asks the lead to use the code-search skill, to try to reproduce by reading code and running existing tests, and to write `bugs/BUG-<key>-<slug>.md` from the template.
4. Outcome (S06 hook):
   - `pass` + valid file → planning commit (§F triage glob), `story_path` = the file, `severity` and priority (§G), `ready_dev`;
   - `Duplicate of:` set → planning commit, `duplicate_of`, `cancelled`;
   - `fail` → `blocked` with the findings in `questions_json`;
   - invalid file → `blocked` with `BUG_FILE_INVALID` (the file is still committed if its path is allowed, so the operator can fix it).
   The operator answers and moves the ticket to `triage`.
5. Bug-specific built-ins `board-develop-bug`, `board-test-bug` and `board-review-bug`:
   - develop: write the regression test first and show that it fails, then fix;
   - test: rerun the repro steps and the regression test, and check for regressions;
   - review: the commit message references `BUG-<key>`.
   The board picks `bugDefinition` for bug tickets.
6. `team.py bug "text" [--file PATH] [--attach PATH ...]` calls `ticket create --kind bug`.

## Done when

- [ ] Validator unit tests: a valid file passes; each missing section, a bad severity, and a `Done when` with no regression-test item fail with the section named. Test: `tests/unit/test_p03_s08_bugfile.py`.
- [ ] Severity mapping blocker/major/minor → 10/40/70, tested.
- [ ] Integration (fake lead writes the file): raw bug → `ready_dev` with `story_path`, severity and priority set, and one planning commit on `main` holding only the bug file. Not reproducible (`fail`) → `blocked` with the questions. `Duplicate of: T-001` → `cancelled` with `duplicate_of`. An invalid file → `blocked` / `BUG_FILE_INVALID`. Test: `tests/integration/test_p03_s08_triage.py`.
- [ ] A bug ticket in develop runs `board-develop-bug` (asserted on the run's definition name and prompt text).
- [ ] `team.py bug "it crashes"` creates the ticket and prints its key (unit test with the CLI stubbed, in the style of `test_p01_s09_team_run.py`).
- [ ] All existing tests stay green.

## Evidence

(filled in when the story is done)
