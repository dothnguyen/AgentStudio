# P04-S04 — Ask and one-off workflows

Status: To Do
Depends on: P04-S03 (team lifecycle by id)
Architecture: [P04 design contract](../README.md#design-contract), §B, §C

## Goal
The operator asks a free member to do something and runs a one-off workflow with roles bound to members, with no board. The helper operations the operator uses today (`workflows`, `check`, `retry`, blocked/resolve) become real `team` commands.

## Implement in this order
1. `team ask --team T --member M [--wait] [--permission P] "text"`: wraps `task.direct`; a busy member returns `AGENT_BUSY`; `--wait` blocks until the result and prints it.
2. `team run-workflow --team T NAME [--bind ROLE=MEMBER ...] [--wait] "text"`: wraps `workflow.start`; unbound roles resolve to the team's members by role; ambiguity is an error naming the roles.
3. `team workflows` lists definitions; `team check` runs `workflow validate` against the team; `team retry` wraps `workflow retry`; `team blocked` lists paused/blocked assignments; `team resolve` wraps `assignment.resolve`.
4. Human output shows member names, the route taken and the result; `--json` gives the raw response.

## Done when
- [ ] `ask` to a free member returns the result; to a busy member returns `AGENT_BUSY`. Test: integration with the fake provider.
- [ ] `run-workflow` binds roles to members, honours `--bind`, and a paused run shows in `blocked` and clears with `resolve`. Test: integration.
- [ ] `workflows`, `check`, `retry` match the `team.py` behaviour on the same fixture. Test: unit/integration.
- [ ] No command calls board code. Test: grep-style unit test on imports.

## Evidence
(filled in when the story is done)
