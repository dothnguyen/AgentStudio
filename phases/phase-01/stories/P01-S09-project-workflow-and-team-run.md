# P01-S09 — This project's `story-delivery` workflow and `team.py run`

Status: Done (2026-10-22)
Depends on: P01-S07, P01-S08
Architecture: [P01 design contract](../README.md#b-definition-format-version-1), section B; [`.agent-studio/README.md`](../../../.agent-studio/README.md)

## Goal

Use the feature on this project. Write the workflow that `team.py dev / fix / qa / final` drives by hand today as a definition, `story-delivery.yaml` (Developer → tests → QA → TeamLead, with QA fail and TeamLead fail going back to the Developer). Then let the operator tell the team to run any definition with one prompt: `team.py run NAME "prompt"`.

## Implement in this order

1. `.agent-studio/workflows/story-delivery.yaml` plus `.agent-studio/workflows/prompts/{develop,qa,final-review}.md`, matching the §B example: `develop` (Developer, `workspace_write`, maxVisits 4) → `tests` → `qa` (QA, `read_only`, `passRequires: [tests]`; fail → develop) → `final` (TeamLead, `read_only`; pass → `$succeed`, fail → develop). The prompts carry over what `team.py` writes today: "follow 'Implement in this order'", "do not edit the Status line", QA/FINAL REVIEW wording, and the `commit` fenced block for the lead. `maxSteps` fits four develop visits.
2. `team.py run NAME (PROMPT | --story PATH | --prompt-file PATH) [--bind ROLE=NAME …] [--no-wait]`: checks for a clean tree, calls `workflow start --definition NAME --text-file - --wait`, maps `--bind` agent *names* to IDs from the saved team, and prints the route, final status, last findings, and the final stage summary. `--story` builds the standard "Implement the story in PATH …" prompt and records per-story state as `team.py dev` does. When the last stage is a passing verdict stage whose summary contains a ```commit block, `run` saves it so `team.py commit STORY` works unchanged.
3. `team.py workflows` lists definitions (`workflow list`), and `team.py check NAME` validates one against the saved team.
4. Update `.agent-studio/README.md`: P01 can run configurable workflows; Workflow 2 becomes `team review` → `team run story-delivery --story S` → `team commit`, with `dev / fix / qa / final` kept as the manual fallback. Update the `team.py` docstring.

## Done when

- [x] `agent-studio workflow validate --definition story-delivery --team <project team>` reports no errors and binds lead / dev / qa.
- [x] A fake-adapter integration test runs `story-delivery.yaml` (copied into a fixture workspace) through qa fail → develop → qa pass → final pass, and the commit block from the final summary is saved.
- [x] `team.py run` unit tests (CLI calls stubbed) cover argument building, `--bind` name → ID mapping, a dirty-tree refusal, and commit-message capture.
- [x] `.agent-studio/README.md` describes the new flow, and every command in it exists.
- [x] Tests: `tests/unit/test_p01_s09_team_run.py` and `tests/integration/test_p01_s09_story_delivery.py`. The full suite stays green. (Real runs belong to S10. Per the P00 rules, no live provider runs against this checkout.)

## Evidence

Implemented 2026-10-22:
- `.agent-studio/workflows/story-delivery.yaml` + `workflows/prompts/{develop,qa,final-review}.md` (prompt files resolve from `.agent-studio/`, so the YAML says `workflows/prompts/...`); maxSteps 16; loads with no errors or warnings.
- `scripts/team/team.py`: `run`, `workflows`, `check` (docstring updated). `final` is read-only per the story, so it proposes the commit block; marking the story Done stays with `team final` or the operator (documented in the README).
- Fake provider gained a debug-only `finalText` option (adapter, fake_cli, dispatch validation) so tests can emit a commit block.
- Tests: `tests/unit/test_p01_s09_team_run.py` (6), `tests/integration/test_p01_s09_story_delivery.py` (3: validate binds three roles; qa fail -> develop -> qa pass -> final pass route; commit block captured). Unit suite green.
- Not run: live providers (S10).
