# P01-S17 — Live evidence: a real story cycle with resumed sessions (E4 gate)

Status: To Do
Depends on: P01-S15 (Done, not Blocked), P01-S16
Architecture: [P01 design contract](../README.md#h-session-continuity-e4), section H; brief [success measures](../../briefs/feature-workflow-session-context.md)

## Goal

Prove the brief's success measures with real Claude Code agents (this project's team) on a disposable fixture: within one story, every agent resumes its own session from task to task, and that saves work. Each trigger that should start a fresh session does so. Fake-adapter tests support this story but never replace it.

## Implement in this order

1. Fixture: a disposable git repository with `.agent-studio/` copied from this project (team.json, roles, skills, workflow.json with a fast test command), plus two small stories, A and B. Story A should be small but leave room for a fix round (for example, an input-validation edge case the story asks for explicitly).
2. Story A, keyed: `team.py start`, then `review A` → `dev A` → `fix A` → `qa A` → `final A` → `commit A`. If QA passes in `dev`, run `fix A` anyway with a recorded operator finding. The measure is resumption, not the model failing.
3. Comparison: the same `fix` task once more after `team.py reset dev A` (fresh). Record both tasks' tool reads and normalized tokens.
4. Fresh-start triggers, each checked in `task show`:
   - first task of story B;
   - after `reset qa A`, the next `qa A`;
   - the first task after `commit A`;
   - the first keyed task after `team.py stop` + `start`.
5. Missing-session fallback in a team: end nothing, but delete the developer's pointed-to Claude session file by hand (operator step), then run `fix A`. The report shows the fallback warning and the row is re-pointed.
6. Save `team.py usage A` and `usage` output, `session list --include-ended`, and the relevant `task show` outputs (sanitized) to `phases/phase-01/evidence/s17/`.

## Done when

- [ ] In story A, `fix A`'s developer assignment has `mode: resume` with `resumeFrom` equal to the `providerSessionId` of the developer's last succeeded `dev A` stage. QA's and the lead's later tasks resume their own earlier sessions, and no task resumes another agent's session.
- [ ] The resumed `fix` task reads fewer files (`Read`+`Grep`+`Glob`) than the fresh comparison `fix`. `team.py usage A` shows input, cached and output tokens per agent for both.
- [ ] Each trigger in step 4 gives `mode: fresh` (or a new row), and step 5 gives one fallback with a warning and no second retry.
- [ ] A resumed `read_only` task (QA or lead) after the developer's writes wrote nothing (`git status` unchanged by it).
- [ ] The full test suite passes on the operator machine (log in the evidence folder).

## Evidence

(filled in when the story is done)
