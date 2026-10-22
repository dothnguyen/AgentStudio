# P03-S17 — Live gate: a real board run on a throwaway repository

Status: To Do
Depends on: P03-S01 … P03-S16; P01-S10 (P01 live gate passed)
Architecture: [P03 design contract](../README.md#design-contract), phase exit; the P01-S10 gate style

## Goal

Prove the board with real providers, operator-run like P01-S10. On a disposable git repository with a small Python project, a real team (lead, two developers, QA; any ready providers, Claude at least) takes three story tickets, one of which depends on another, from `refine` to `merged` after one `board.run`, including one QA fail and its fix round. Fake-provider results do not count here.

## Implement in this order

1. `scripts/live/board_gate.py`:
   - creates the fixture repo under the WSL state dir: three small stories (S3 depends on S1), and S2's story with a "Done when" item that the first implementation is told to skip, so QA fails it once (the same forcing approach as P01-S10, recorded in the script);
   - copies `.agent-studio` from this project with `team-two-devs.json`;
   - `team.start`, `ticket add` ×3, `board.run`;
   - polls `board.show` until all three tickets are `merged`, one is `blocked`, or a 90-minute timeout.
2. It writes `phases/phase-03/evidence/s17/<timestamp>/`: `board.show` snapshots each minute, the full `ticket.*` / `board.*` event list, `git log --graph --all`, each squash commit, each ticket's run IDs and providers, and a `summary.json`.
3. The operator runs it, attaches to tmux during the run, and records observations in this story's Evidence section.

## Done when

- [ ] All three tickets are `merged`. `main` has three squash commits plus the planning commits, each with a `Ticket:` trailer.
- [ ] The events show S3 never `in_dev` before S1's `ticket.merged`, and S3's `base_commit` contains S1's merge.
- [ ] One `fail_test` round on S2 with QA findings that appear in the next develop prompt, then `merged`.
- [ ] At one point two tickets were `in_dev` at once on two worktrees (from the events).
- [ ] No agent ran history-changing git: every commit on `main` and on `ticket/*` was made by the coordinator (from the events, plus `git log` committer checks).
- [ ] The evidence folder is complete, and `summary.json` lists the providers and models used.
- [ ] If the run blocks, the story stays In Progress or Blocked with the reason. It is never marked Done on a partial run.

## Evidence

(filled in when the story is done)
