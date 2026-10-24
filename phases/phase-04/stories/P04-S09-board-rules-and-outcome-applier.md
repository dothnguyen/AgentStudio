# P04-S09 — Board rules and outcome applier

Status: To Do
Depends on: P04-S07 (generic board model)
Architecture: [P04 design contract](../README.md#design-contract), §D, §E

## Goal
The board rules say who works which status and what happens on pass, fail and blocked. They are validated when loaded, and a finished workflow run is applied to its ticket by those rules.

## Implement in this order
1. Rules schema in `board.json`: `when.status`, `role`, `workflow`, `onPass`, `onFail`, optional `onBlocked`, `maxRounds`, `during`, `cap`, `requiresDeps`, `workspace` (`main|worktree|none`), `action`, `priority`. A rule has `action` or `role`+`workflow`, never both.
2. `board rules check`: every status named exists; every role exists in `roles.json`; every workflow exists and can be bound; the rule graph has a path from `initial` to `done`; at most one rule per `when.status`.
3. Outcome applier: given a finished run (pass, fail, paused/blocked) and its ticket, move the ticket to `onPass`/`onFail`/`onBlocked`, count rounds per ticket and rule, block with a reason when `maxRounds` is hit, and write events. Idempotent: applying the same run twice changes nothing.
4. Ticket keeps the run id it was last applied for, so a late outcome after restart is applied once.
5. `ticket unblock` returns a blocked ticket to its recorded return status.

## Done when
- [ ] `rules check` reports each misconfiguration (unknown status, role or workflow, two rules for one status, no path to done) at load time. Test: unit.
- [ ] Pass, fail, blocked and round-limit paths move the ticket as configured; a repeated apply is a no-op. Test: unit with synthetic run results.
- [ ] A real fake-provider workflow run result is applied through the applier. Test: integration.

## Evidence
(filled in when the story is done)
