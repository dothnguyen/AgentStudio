# P04-S13 — What a development board needs

Status: Done (2026-10-25), except the live run on real providers, which the operator does (see Evidence)
Depends on: P04-S10 (scheduler), P04-S12 (MCP server)
Architecture: [P04 design contract](../README.md#design-contract), §D, §E, §G

## Goal
The generic board can run a real development flow (backlog → unpack → refine → dev → qa → review → merge → done, failures returning to the previous status) without losing work or context between agents. Found by configuring this project's own board.

## Implement in this order
1. **Commit ticket worktrees.** Before a finished run's outcome is applied, the coordinator commits whatever the agent changed in the ticket worktree on the ticket branch (`ticket.committed` event; `ticket.commit_failed` when git refuses). Without it the next stage cannot start (a run needs a clean tree) and the coordinator merge finds nothing to merge and removes the worktree.
2. **Findings travel with the ticket.** When a run does not pass, the findings of its last verdict are appended to the ticket body (`## Findings from <status>, round N`), as is a merge conflict's file list; the body stays under 32 KB (head kept, older notes trimmed).
3. **`onFailPriority`** (rule key, integer ≥ 0): a ticket that fails the rule (or a failed merge) gets this priority, so it is claimed before others in the status it returns to (smaller numbers first).
4. **`agentTicketStatus`** (board key): tickets added by agents over MCP land in this status (default: the initial status); it must be a configured, non-terminal status. The rules check accepts a path to done that starts at either entry point.
5. **`ticket_update`** MCP tool (and `ticket.update` command): an agent with `canAddTickets` replaces or appends to the body of the ticket its own assignment is working (`FORBIDDEN` for any other ticket, an inactive assignment or a member without the flag), with a `ticket.updated` event. This is how the refine stage writes the implementation plan the developer receives as its task.

## Done when
- [x] A worktree change is committed when the outcome is applied; nothing new means no commit; non-worktree rules are untouched. Test: unit with a real worktree.
- [x] A failed run's findings and a priority bump reach the ticket, a pass changes neither, the failed ticket sorts first, the body cap holds. Test: unit.
- [x] Agent tickets land in `agentTicketStatus`, operator tickets in the initial status; invalid values are refused; the rules check accepts the agent entry point. Test: unit.
- [x] `ticket_update` works only for the claimed ticket of an active, allowed assignment and writes an event; the tool is listed and allowlisted for Claude. Test: unit.
- [x] This project's `board.json` with the six rules passes `board rules check`. Evidence below.
- [ ] A real run of the flow with real providers on a throwaway ticket (operator).

## Evidence
- Unit: `tests/unit/test_p04_s13_dev_board_flow.py` (11 tests); the full unit suite and `test_p04_s10_run_board`, `test_p04_s12_mcp_run` integration modules pass.
- `agent-studio board rules check` → `board rules: OK (6 rule(s))` with the project's board.json, `board-*.yaml` workflows and prompts.
- Not run: real Claude/Codex runs (the S12 live spike is still open too).
