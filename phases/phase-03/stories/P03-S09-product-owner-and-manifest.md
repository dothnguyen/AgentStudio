# P03-S09 — ProductOwner role, unpack definition and manifest validator

Status: Done (2026-10-23)
Depends on: P03-S05
Architecture: [P03 design contract](../README.md#design-contract), §A (columns), §C (unpack), §F (unpack paths, manifest); brief §3b

## Goal

A new `ProductOwner` role takes the unpacking work off the TeamLead. The `board-unpack` definition asks the PO to write a phase README, one story file per story and a machine-readable `<out>/tickets.json` manifest. A pure validator checks that manifest and the story files it names, so that S10 can trust it before creating any child ticket. This story adds no outcome rows, no feature tickets and no child creation (all S10).

## Implement in this order

1. Role and team config:
   - `.agent-studio/roles/product-owner.md`: the unpack duties (restate the goal, open questions with assumptions, phases → epics → stories, planning files under OUT only, never edit code or tests), the manifest schema of step 3 and the story-file sections it requires.
   - A `ProductOwner` entry in `.agent-studio/roles.json` (description, `instructions: roles/product-owner.md`, skills `story-format`, `code-search`). The TeamLead description and `roles/team-lead.md` keep their unpack text, because the lead is still the fallback (step 5).
   - One PO agent in `.agent-studio/team.json`: `{"providerId": "claude", "role": "ProductOwner", "name": "po", "model": "claude-sonnet-5-5", "reasoning": "medium"}` (the operator may change the model).
2. Built-in `backend/agent_studio/workflows/board-unpack.json`: one `verdict` stage, role `ProductOwner`, `workspace_write`, `promptFile: prompts/board-unpack.md`, `next {pass: $succeed, fail: $fail}` (the same shape as `board-triage.json`). `prompts/board-unpack.md` is static text plus `{{task}}`; it states: use the story-format skill; write `<out>/README.md`, one story file per story and `<out>/tickets.json` under OUT only, never anything else; the manifest schema (step 3) with a short example; story `Status: To Do`; never run history-changing git; `pass` = plan written, `fail` = cannot plan (questions as findings, or in the manifest's `questions`).
3. `board._task(ticket)`: for `kind == "feature"` it adds the lines `Brief: <brief_path>` and `Out: <out_dir>` (the prompt file is static, so the brief path and OUT reach the PO only through `{{task}}`). Story and bug text is unchanged.
4. `backend/agent_studio/manifest.py`, pure apart from reading the story files: `validate(workspace, out_dir, data)` where `data` is the already-parsed JSON value and `out_dir` is workspace-relative (S10 checked it). It collects **all** errors, then either returns `{"stories": [{"path", "title", "dependsOn", "priority"}], "questions": [str]}` (defaults filled: `dependsOn` `[]`, `priority` `None`, `questions` `[]`) or raises `AsError(MANIFEST_INVALID, "Manifest is invalid.", data={"errors": [{path, message}, …]})` (the `board_config` shape). Add `MANIFEST_INVALID` to `protocol.py` beside the other P03 codes. Rules:
   - schema: the top level is an object with `stories` (required list) and `questions` (optional list of non-empty strings); each story is an object with `path` (required string), `title` (required non-empty string, ≤ 200 characters), `dependsOn` (optional list of strings), `priority` (optional integer 1–5, `bool` refused); any other key is an error;
   - 1–30 stories; with non-empty `questions`, 0 stories is allowed;
   - `path`: a relative POSIX path (no backslash, no NUL, not absolute, no `.` or `..` segment), starting with `<out_dir>/`, ending in `.md`, an existing file whose `realpath` stays inside `realpath(<workspace>/<out_dir>)`; unique in the manifest;
   - `dependsOn` names only `path` values of this manifest, not the story itself, and the graph is acyclic;
   - each story file has a line starting `# `, a line starting `Status:`, a line starting `Depends on:`, the headings `## Goal`, `## Implement in this order`, `## Done when` (with at least one `- [x]` line before the next `## ` heading) and `## Evidence

- Unit suite (`.agent-studio/workflow.json`): `Ran 420 tests in 10.576s — OK (skipped=3)`; validation PASSED. QA verdict: pass, no findings.
- Added: `.agent-studio/roles/product-owner.md`, `backend/agent_studio/manifest.py` (`validate` collects all errors, `MANIFEST_INVALID` with `{path, message}`; three-state DFS reports a cycle on its earliest manifest member), `backend/agent_studio/workflows/board-unpack.json`, `backend/agent_studio/workflows/prompts/board-unpack.md`, `tests/unit/test_p03_s09_manifest.py`, `tests/unit/test_p03_s09_builtins.py`, `tests/unit/test_p03_s09_team_unpack.py`.
- Changed: `.agent-studio/roles.json` (ProductOwner), `.agent-studio/team.json` (agent `po`), `.agent-studio/README.md` (Workflow 1 uses the PO), `backend/agent_studio/board.py` (`_task` adds `Brief:`/`Out:` for features), `backend/agent_studio/protocol.py` (`MANIFEST_INVALID`), `scripts/team/team.py` (`c_unpack` picks ProductOwner, falls back to TeamLead), `phases/phase-03/README.md` (§F manifest contract).
- Extra tests beyond the list: a dense 30-story DAG is accepted; a cycle 1→2→1 reached from story 0 is reported on `stories[1].dependsOn`.
- Not blocking: the example JSON in `prompts/board-unpack.md` is missing its closing backtick.
