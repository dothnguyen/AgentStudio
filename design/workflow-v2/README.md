# Workflow screens v2 (Statuses, Workflow prompts, Routing)

Design for the **Workflow** sidebar group that replaces the single Routing item: **Statuses**, **Workflow prompts** and **Routing**. It follows the Phase 09 backend model (board workflows): a workflow starts when a ticket reaches a workflow status, runs steps (agent, check, merge action, approval), and ends by setting the ticket's next status. Built on the Design canvas "Routing v2 - stage-based workflow editor"; looks follow `design/routing-v1/`.

| File | What it is |
| --- | --- |
| `Main.png` / `.html` | **Workflow › Routing**: filter, expand/collapse, the "in every workflow" note, then one card per workflow grouped Main path / Detours. Each card shows everything: Picks up (starts at, while running, role, works in), every step with its pass/fail route, and Ends (pass, fail, blocked) with Limits and created tickets. |
| `EditStage.png` / `.html` | **Edit workflow** dialog (Develop): 1 name and statuses, 2 who and where, 3 steps (agent step card, check step card with "go back to … up to N times", add-step buttons), 4 where it ends (+ tickets this workflow creates), 5 limits, 6 starting here. |
| `AddStage.png` / `.html` | **Add workflow** dialog for a non-code board: approval step, agent step with an inline new prompt, warning when nothing reaches the start status. |
| `Generic.png` / `.html` | Routing for a non-code (content) board: same cards, a "not reachable" problem, and the empty state. |
| `NeedsYou.png` / `.html` | Tickets that need a person: board cards (waiting for approval, needs your answer, paused), ticket-page panels (approve/reject with note, answer a question), Needs attention counts. |
| `Statuses.png` / `.html` | **Workflow › Statuses**: summary cards, table (name, id, type, used by, board column, rename/remove), the "back to Add workflow" banner when opened from a workflow dialog. |
| `AddStatus.png` / `.html` | Add status dialog: name, id from the name, type Normal or Done. |
| `Prompts.png` / `.html` | **Workflow › Workflow prompts**: prompt list with users and word counts, editor with placeholder chips, word/token count, save/revert, duplicate/delete. |
| `NewPrompt.png` / `.html` | New prompt and Delete prompt dialogs. |
| `*.dc.html` | Source artboards (need the Design canvas runtime). The `.html` files are static renders of them and open in any browser. |

Tokens: page `#111316`, card `#16191d`, card border `#262a30`, text `#e7e9ec`, muted `#8d949e`, accent `#5b9cff`, success `#6fd38b`, warning `#f0b453`, danger `#f48771`. Step kinds: AGENT blue, CHECK green, ACTION purple, APPROVAL amber. Fonts: Inter, JetBrains Mono.

## Notes for the implementation

- Everything shown comes from the backend (`board.workflows`, `boardworkflow.*`, `prompt.*`, board settings, the role and command catalogs). No status, role or workflow name is hard-coded; the dev-board data here is this repo's board after `board upgrade` (T-206).
- Main path / Detours: a workflow is on the main path when it is reached from a start status by pass results only; everything else is a detour; workflows nothing reaches are shown with a "not reachable" problem.
- Git-only controls (Worktrees button, sync base) appear only when a workflow works in a worktree.
- Word counts on the prompts screen are illustrative.
- No accessibility work is required beyond using real buttons, inputs and labels.
- Static renders use fallback fonts if Inter / JetBrains Mono are not installed.
