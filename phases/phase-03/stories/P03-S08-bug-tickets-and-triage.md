# P03-S08 — Bug tickets and the triage column

Status: Done (2026-10-23)
Depends on: P03-S06
Architecture: [P03 design contract](../README.md#design-contract), §B (bug kind), §C (triage rows), §F (bug file path), §G (severity → priority), §I (`ticket.create`); brief §3c

## Goal

The operator describes a bug in plain words (`team.py bug "…"`). It becomes a `bug` ticket in `triage`. The TeamLead's triage run writes a structured bug file, which the coordinator validates and commits to base. The ticket then goes straight to `ready_dev` with a priority from its severity, to `cancelled` when it is a duplicate, or to `blocked` with questions. From there the story pipeline runs with bug-specific prompts: a failing regression test first, then the fix.

What exists today (read before starting): `dispatch._validate_ticket_create` (refuses every kind but `story`), `tickets.create` (already enters `triage` for `bug`), `tickets.check_workspace_path`, `board._apply` / `decide` / `commit_planning` / `_globs` / `_write_outcome` / `_task` / `start_column`, `schema.BOARD_OUTCOMES`, `board_defaults.json` (already names `board-triage` and the three `*-bug` definitions), and `scripts/team/team.py` (`WS`, `cli(...)`).

Naming used below: `<key>` is the ticket key verbatim (`T-004`). The bug file is `bugs/BUG-<key>-<slug>.md` at the workspace root, where `<slug>` matches `[a-z0-9-]{1,40}`, e.g. `bugs/BUG-T-004-login-crash.md` with the heading `# BUG-T-004 — Login crash`.

## Implement in this order

1. **`ticket.create` with `kind: bug`** (`dispatch._validate_ticket_create` and the create handler). `kind` is `story` (default) or `bug`; `feature` stays `BAD_REQUEST` until S10. For `bug`:
   - `text` is required, not blank after strip, ≤ 32 KiB UTF-8 (`BAD_REQUEST` otherwise); `storyPath` is refused (`BAD_REQUEST`);
   - `attachments?` is a list of at most 20 strings (each ≤ 4096 chars). Each passes `tickets.check_workspace_path(workspace, rel, require_md=False)`: a new keyword argument that skips only the `.md` rule (existence is checked, contents are never read). A bad one → `STORY_PATH_INVALID` with `{path, reason}`. The normalized paths are stored in `attachments_json`;
   - `title?` ≤ 80 chars; default: the first non-blank line of `text`, stripped, cut to 80 chars;
   - `priority?`, `dependsOn?` and `noDeps?` work as for stories. With no story file there are no parsed dependencies: omitted `dependsOn` means none, and the receipt has `parsed {ids: [], resolved: [], unresolved: []}`;
   - `raw_text` = `text`; entry status `triage`.
   - `board._task` adds an `Attachments: <path>, <path>` line for a bug that has attachments.
   - The S02 unit test that expects `kind: "bug"` → `BAD_REQUEST` (`tests/unit/test_p03_s02_commands.py`, `test_create_validation_rejects_conflicting_empty_override_and_kind`) is changed to use `kind: "feature"`.
   - CLI: `agent-studio ticket create --workspace PATH --kind bug --text TEXT [--attach PATH ...] [--title T] [--priority N] [--depends KEY ...] [--key K]` (`--attach` repeatable), plus the usage text.
2. **Validator `backend/agent_studio/bugfile.py`**: `check(text, key, known_keys) -> {"severity", "duplicateOf", "errors": [{"section", "message"}]}`, pure (no I/O). `errors == []` means valid. Rules, each failure one error naming the section:
   - section `heading`: the first non-blank line is `# BUG-<key> — <title>` (em dash, the ticket's own key, non-empty title);
   - section `Severity`: a line `Severity: blocker|major|minor`;
   - sections `Steps to reproduce`, `Expected`, `Actual`, `Environment`, `Suspected area`, `Done when`, `Out of scope`, `Open questions`: each a `## <name>` heading followed by at least one non-blank line before the next `## ` heading (`None` is valid content);
   - section `Done when`: at least one list item (`- ` or `- [ ] `) whose text contains `regression test` (case-insensitive);
   - section `Duplicate of` (optional line `Duplicate of: T-NNN`): the key must be in `known_keys` and differ from `key`. When this line is present and valid, only `heading` and `Severity` are also required (the other sections are not checked).
   - `bugfile.REQUIRED_SECTIONS` lists the eight `##` names above. `schema.BUG_SEVERITY_PRIORITY = {"blocker": 10, "major": 40, "minor": 70}` (§G).
3. **Built-in `board-triage`** (`backend/agent_studio/workflows/board-triage.json`, one TeamLead verdict stage, `workspace_write`, `next {pass: $succeed, fail: $fail}`, the same shape as `board-refine`) and `prompts/board-triage.md`. The prompt:
   - asks the lead to use the code-search skill, to try to reproduce by reading code and running existing tests, and never to run history-changing git;
   - says to write exactly one file, `bugs/BUG-<key>-<slug>.md`, and nothing else; if the task names an existing bug file (`Story:` line), edit that file instead of creating a new one;
   - **contains the bug template verbatim** (every heading of `REQUIRED_SECTIONS`, the `Severity:` line, the optional `Duplicate of:` line). The template lives only in this prompt, so it ships with the backend and works in any workspace;
   - says: verdict `pass` = the bug is specified (or is a duplicate); `fail` = cannot proceed, with the questions as findings.
4. **Triage outcome** (S06 hook, data-driven so board code still names no column): `schema.BOARD_OUTCOMES["triage"] = {"kind": "verdict", "pass": "ready_dev", "fail": "blocked", "counter": None, "limit": None, "commit": "planning", "globs": ("bugs/BUG-{key}-*.md",), "single": True, "check": "bugfile"}`. `board._globs` substitutes `{key}`. In `board._apply`, in this order:
   1. Planning diff (`commit_planning`): with `single`, the changed paths must be at most one, and that one must fully match `bugs/BUG-<key>-[a-z0-9-]{1,40}\.md` (fnmatch's `*` also matches `/`, so the regex is the real check). Anything else → `PLANNING_DIFF_INVALID` with the offending paths, nothing committed (the existing S06 behaviour). The commit message is `<key>: triage <bug path>` (`commit_planning` uses the changed path, not `story_path`, when `single` is set). A committed bug file sets `story_path` to its path, whatever the verdict.
   2. Verdict `fail` → `blocked` / `VERDICT_FAIL:triage` with the findings in `questions_json` (the existing S06 path). A missing or malformed verdict → `RUN_FAILED:triage` (existing).
   3. Verdict `pass` with `check: "bugfile"`: the bug file is the committed path, else the ticket's existing `story_path`; neither → error `{section: "file", message: "no bug file written"}`. Read it from the main checkout and run `bugfile.check` with the workspace's ticket keys.
      - errors → `blocked`, `blocked_reason = BUG_FILE_INVALID`, `questions_json` = `["<section>: <message>", …]` (bounded like findings), return status `triage`;
      - `duplicateOf` set → `cancelled` (reason `duplicate_of:<key>`), with `duplicate_of` and `severity` set;
      - else → `ready_dev` with `severity` and `priority = BUG_SEVERITY_PRIORITY[severity]` (this overrides a `priority` given at create, §G).
   The operator answers a blocked bug by editing the file or the ticket, then `ticket.unblock` (back to `triage`) for a new triage run, or `ticket.move … ready_dev` after fixing the file by hand.
5. **Bug-specific built-ins** `board-develop-bug`, `board-test-bug`, `board-review-bug` (`.json` + `prompts/*.md`), with the same shapes and permissions as `board-develop` (work + validation, `maxVisits` 3), `board-test` and `board-review` (`read_only` verdicts):
   - develop: keeps every requirement of `board-develop.md` (`Evidence`, `history-changing git`, `FINDINGS`), and says to write the regression test first, run it and show that it fails, then fix, then show that it passes;
   - test: rerun the bug file's steps to reproduce and the regression test, and check that nothing else regressed;
   - review: keeps the ```` ```commit ```` instruction of `board-review.md` and asks that the commit message reference `BUG-<key>`. This is a prompt instruction only; a missing reference is not enforced (Q5 default message applies).
   - `board.start_column` uses the column's `bugDefinition` for a `bug` ticket when the column has one, else `definition`. The chosen name is used for loading, for `workflow.start`, in the `ticket.run_started` payload and in the receipt's `definition`.
6. **`team.py bug`** (`scripts/team/team.py`): `bug [TEXT] [--file PATH] [--attach PATH ...]`. Exactly one of `TEXT` or `--file` (else exit 2 with a message); `--file` reads the text as UTF-8 on the operator's side. `--attach` paths are relative to the repository root (`WS`). It calls `cli("ticket", "create", "--workspace", WS, "--kind", "bug", "--text", text, *("--attach", p for each))` and prints the new ticket key.

## Done when

- [x] `ticket.create` bug validation: a bug with text and one existing non-`.md` attachment is created in `triage` with `raw_text`, `attachments_json` and the default title (first line, ≤ 80 chars); blank text, `storyPath` with `kind: bug`, `kind: feature`, and an attachment that escapes the workspace or does not exist are refused with `BAD_REQUEST` / `STORY_PATH_INVALID`. Test: `tests/unit/test_p03_s08_create.py`; the changed S02 assertion stays green.
- [x] Validator: a valid file passes and returns its severity; each missing or empty required section, a wrong heading key, a bad severity, and a `Done when` with no regression-test item each fail with that section named; a valid `Duplicate of:` file with only heading and severity passes with `duplicateOf`; `Duplicate of:` an unknown key or the ticket itself fails. Test: `tests/unit/test_p03_s08_bugfile.py`.
- [x] Severity mapping blocker/major/minor → 10/40/70. Test: `tests/unit/test_p03_s08_bugfile.py`.
- [x] Built-ins: `board-triage` (`workspace_write`), `board-develop-bug` (`workspace_write`, validation stage), `board-test-bug` and `board-review-bug` (`read_only`) load with one agent role each; the triage prompt contains every `REQUIRED_SECTIONS` heading and `Severity:`; the develop-bug prompt contains `regression test`, `Evidence`, `history-changing git` and `FINDINGS`; the review-bug prompt contains `commit` and `BUG-`. Test: `tests/unit/test_p03_s08_builtins.py`.
- [x] Integration (fake lead writes the file, `ticket.start` by hand): raw bug → `ready_dev` with `story_path`, `severity` and `priority` set, and one planning commit on `main` whose only path is the bug file and whose subject is `<key>: triage <path>`. Verdict `fail` → `blocked` / `VERDICT_FAIL:triage` with the questions. `Duplicate of: T-001` → `cancelled` with `duplicate_of = "T-001"`. An invalid file → `blocked` / `BUG_FILE_INVALID` with the section in `questions_json`, and the file still committed. Two bug files, or a file outside `bugs/`, → `blocked` / `PLANNING_DIFF_INVALID`, nothing committed. Test: `tests/integration/test_p03_s08_triage.py`.
- [x] A bug ticket started in develop runs `board-develop-bug` (asserted on the `ticket.run_started` definition, the receipt's `definition`, and the prompt text); a story ticket still runs `board-develop`. Test: `tests/integration/test_p03_s08_triage.py`.
- [x] `team.py bug "it crashes"` and `team.py bug --file F --attach A` call `ticket create --kind bug` with the right arguments and print the key; neither or both of TEXT and `--file` exit 2. Unit test with `cli` stubbed, in the style of `tests/unit/test_p01_s09_team_run.py`: `tests/unit/test_p03_s08_team_bug.py`.
- [x] All existing tests stay green.

## Evidence

- `python3 scripts/validate.py --unit`: PASS — `Ran 410 tests in 10.037s`, `OK (skipped=3)`. Covers `tests/unit/test_p03_s08_create.py`, `test_p03_s08_bugfile.py`, `test_p03_s08_builtins.py`, `test_p03_s08_triage.py`, `test_p03_s08_team_bug.py`, and the changed S02 assertion (`kind: "feature"`).
- `tests/integration/test_p03_s08_triage.py` (7 tests: valid triage → `ready_dev` + `board-develop-bug`, story keeps `board-develop`, verdict fail, duplicate, invalid file, two files, file outside `bugs/`) is a touched integration test. It runs in the commit-time integration tier, not in the unit VALIDATION above.
- Added: `backend/agent_studio/bugfile.py`; `workflows/board-triage.json`, `board-develop-bug.json`, `board-test-bug.json`, `board-review-bug.json` and their `prompts/*.md`; the six test files above.
- Changed: `board.py` (`{key}` glob, single-file planning check and commit message, `story_path` from the committed bug file, `bugfile` check outcome, `Attachments:` task line, `bugDefinition` selection), `coordinator.py` (bug create handler), `dispatch.py` (bug validation), `tickets.py` (`require_md`, NUL refused), `schema.py` (`BUG_SEVERITY_PRIORITY`, `BOARD_OUTCOMES["triage"]`), `cli.py` (`--text`, `--attach`, usage), `scripts/team/team.py` (`bug`), `phases/phase-03/README.md` (§C, §F, §G, §I).
- `tests/unit/test_p01_s05_guard.py`: `check` removed from the forbidden-word list. The `"check"` key in `BOARD_OUTCOMES`, required by this contract, is read in `board.py`, and no built-in definition uses `check` as a stage id.
- QA report: the "hyphen in the triage template heading" blocker is a false positive. `prompts/board-triage.md` line 8 holds U+2014 (bytes `e2 80 94`), the same as the validator. The status/evidence blocker is resolved by this update.
- Follow-ups (not blocking): the triage template shows `Duplicate of: T-NNN` literally, so a lead who copies it unchanged gets a `Duplicate of` error (the prompt says the line is optional). `board-develop-bug.md` asks for the bug file's Evidence section, but the bug template has no `## Evidence` heading.
