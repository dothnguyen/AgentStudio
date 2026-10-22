# P03-S09 — ProductOwner role, unpack definition and manifest validator

Status: To Do
Depends on: P03-S05
Architecture: [P03 design contract](../README.md#design-contract), §A (columns), §C (unpack), §F (unpack paths); brief §3b

## Goal

A new `ProductOwner` role takes the unpacking work off the TeamLead. The `board-unpack` definition asks the PO to write a phase README, one story file per story and a machine-readable `<out>/tickets.json` manifest. A pure validator checks that manifest and the story files it names, so that S10 can trust it before creating any child ticket.

## Implement in this order

1. `.agent-studio/roles/product-owner.md` and a `ProductOwner` entry in `.agent-studio/roles.json` (skills `story-format`, `code-search`). Add one PO agent to `.agent-studio/team.json` (Claude, model chosen by the operator; default `claude-sonnet-5-5`).
2. Built-in `board-unpack`: one ProductOwner verdict stage, `workspace_write`. The prompt includes the brief path, `out_dir`, the story-format skill reference, the manifest schema and the rule "planning files under OUT only". `pass` = plan written; `fail` = cannot plan.
3. `manifest.py` `validate(workspace, out_dir, data)` → `{stories, questions}` or `MANIFEST_INVALID` with `{path, message}` errors:
   - schema `{"stories": [{"path", "title", "dependsOn": [path], "priority": 1..5}], "questions": [str]}`, no unknown keys;
   - 1–30 stories;
   - paths unique, relative, inside `out_dir`, existing `.md` files;
   - `dependsOn` only names manifest paths, and the graph is acyclic;
   - each story file has `# `, `Status:`, `Depends on:`, `## Goal`, `## Implement in this order`, `## Done when` with at least one `- [ ]`, and `## Evidence`.
   With non-empty `questions`, an empty `stories` list is allowed.
4. `team.py unpack BRIEF --out DIR` uses the ProductOwner when the team has one, and the TeamLead otherwise (the behaviour today).

## Done when

- [ ] Validator unit tests: a valid 3-story manifest passes. Each of a cycle, a duplicate path, `../escape.md`, an absolute path, a path outside `out_dir`, an unknown `dependsOn`, a missing file, a story file without `## Done when`, an unknown key and 31 stories fails with the right `path`. Test: `tests/unit/test_p03_s09_manifest.py`.
- [ ] `board-unpack` loads with `workflow.validate` and no errors. The roles file loads, and `team.start` on the project's `team.json` gives four panes (fake providers via the existing fixture alias).
- [ ] `team.py unpack` picks the PO when present and the lead when not (unit test, stubbed CLI).
- [ ] All existing tests stay green.

## Evidence

(filled in when the story is done)
