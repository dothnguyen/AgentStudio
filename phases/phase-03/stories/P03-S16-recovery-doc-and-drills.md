# P03-S16 — Recovery doc and failure drills

Status: To Do
Depends on: P03-S13, P03-S14, P03-S15
Architecture: [P03 design contract](../README.md#design-contract), §D, §E, §G, §H

## Goal

Every board failure mode has a written recovery and a drill that proves the recovery works on the fake provider: the coordinator killed mid-ticket, a runner killed, a merge conflict, a round-limit block, a planning diff outside the allowed paths, a dirty main checkout, a usage limit, and a stuck claim. The operator can get any ticket moving again from the doc alone.

## Implement in this order

1. `backend/RECOVERY.md`, new section "Board". For each failure: the symptom (what `team.py board` / `board.show` shows), the cause, and the exact commands (`ticket.retry`, `ticket.move`, `ticket.unblock`, `assignment.resolve`, `board.resume`, cleaning the main checkout). Also document the danger zones: the operator editing the main checkout while the board runs, and worktrees on `/mnt/c`.
2. `scripts/live/board_drills.py`: runs each drill against a throwaway repo with the fake provider and writes `phases/phase-03/evidence/s16/<timestamp>/<drill>/` (`board.show` before and after, events, and the commands used).
3. One integration test per drill that runs the same steps without the evidence writer.

## Done when

- [ ] Drills, each ending with the ticket `merged` or deliberately `cancelled`:
  - kill the coordinator in `in_dev`;
  - kill the runner in `in_test`;
  - a merge conflict between two tickets;
  - `roundLimits.test = 1` with two QA fails, then `ticket.unblock`;
  - a refine that writes outside the phase folder;
  - a dirty main checkout blocking a merge;
  - `usage_limit` then `board.resume`;
  - a stuck claim then `ticket.retry`.
  Test: `tests/integration/test_p03_s16_drills.py`.
- [ ] `scripts/live/board_drills.py --provider fake` writes one evidence folder per drill, and its summary lists all pass.
- [ ] RECOVERY.md "Board" names every error code from §I that the operator can see, with a command for each. A unit test checks the doc against the code list.
- [ ] All existing tests stay green.

## Evidence

(filled in when the story is done)
