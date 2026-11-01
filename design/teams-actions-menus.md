# Teams actions menus — action review and menu design

Status: design for T-098 (data and IPC), T-099 (menu component and team menu), T-100 (member menu), T-101 (start and safe stop).
Scope: the team Overview page (`app/src/renderer/teams/`) — one **team menu** in the page header and one **member menu** on every row of the Members table.

## 1. Review: every action the system has, and what to do with it

"Backend" is the command in `backend/agent_studio/dispatch.py`. "App today" says whether the Electron app can already call it (`app/src/main/managementSpecs.ts`).

### Team-level candidates

| Action | Backend | App today | Decision |
|---|---|---|---|
| Rename team | `teamdef.rename` | yes (header button) | Keep as the visible header button. Not in the menu. |
| Delete team | `teamdef.delete` | yes (header ⋯) | Keep in the menu, last, danger style. |
| Reset usage limits (per provider) | `team.usage.reset` | **no** | **Add** — "Reset usage limits ▸" with one item per provider plus "All providers". |
| Unblock a blocked ticket | `ticket.unblock` | **no** | **Add** — "Blocked tickets ▸" (the workspace's blocked tickets), each with "Unblock to <return status>" and "Unblock to…". |
| Retry paused runs | `workflow.retry` | **no** | **Add** — "Retry paused runs (N)…" bulk item with a confirmation listing the runs. |
| Approve / reject / cancel a delegated command | `command.approve` / `reject` / `cancel` | **no** | **Add** — "Command approvals ▸", only shown when something is waiting or running. |
| Copy ids and the tmux attach command | `team.attach` (read-only) | **no** | **Add** — "Copy ▸ Team id, Runtime id, Attach command (WSL), Attach command (Windows Terminal)". |
| Start team | `team.start` | **no** | **Add** (T-101) — "Start team" when the team is stopped. |
| Stop team | `team.stop` | **no** | **Add** (T-101) — "Stop team…" with a safe path (see §4). Stopping cancels running work and blocks the tickets, which has already happened to real tickets (T-090, T-091, T-093). |
| Run board / Stop board | `board.run`, `board.stop` | yes (Board card) | Stay on the Board card. Not duplicated. |
| Open board | — | link | Stay on the Board card. |
| Resume limited members | `board.resume` | no | **Exclude.** Redundant: `team.usage.reset` clears the provider holds and recovers the members, and `team.member.resume` clears one member's hold. |
| Add member | `teamdef.member.add` | yes (Members card) | Stay on the Members card. |
| Re-check definition | `teamdef.validate` | yes | **Exclude.** The header already shows the definition state; Refresh re-reads it. |
| Team workflows, story commands (`team dev`, `qa`, `final`, `commit`, `unpack`, `index`), `workflow.start` | `workflow.*`, CLI only | no | **Exclude.** These belong to a future run/stories screen; the board starts its own workflows. |
| Ask a member (one-off task) | `task.direct` | no | **Defer.** Needs a prompt dialog, a policy choice and a result view. Worth its own ticket. |
| Coordinator start/stop, workspace init, agent/role/phase/ticket editing, debug.* | various | partly | **Exclude.** App-level or other screens (Agents, Roles, Boards). |

### Member-level candidates

| Action | Backend | App today | Decision |
|---|---|---|---|
| Open details | — | row click | Keep. First item of the menu too. |
| Switch agent | `team.member.switch` | yes (detail) | **Add to the row menu** — "Switch agent ▸" listing the member's live options, reusing the detail's logic and its confirmation before cancelling active work. |
| Resume an agent on hold | `team.member.resume` | yes (detail) | **Add to the row menu** — "Resume agent ▸", only options on a usage hold. |
| Retry the stuck stage | `workflow.retry` | **no** | **Add** — "Current work ▸ Retry stage", for a paused run or a waiting/reconciling assignment. |
| Requeue the ticket | `ticket.retry` | **no** | **Add** — "Current work ▸ Requeue ticket…": releases the claim and cancels the run; the ticket returns to its queue. |
| Stop the run and block the ticket | `workflow.cancel` | **no** | **Add** — "Current work ▸ Stop run and block ticket…" (danger): cancels the run and parks the ticket as blocked for a person to decide. |
| Unblock the member's last blocked ticket | `ticket.unblock` | **no** | **Add** — "Unblock ▸", fed by the blocked-ticket list linked back to the member who last ran it (a blocked ticket has no assignee, so this link needs new data). |
| Approve / reject / cancel a delegated command of this member's run | `command.*` | **no** | **Add** — "Command requests ▸". |
| Edit saved configuration | `teamdef.member.update` | yes (detail) | **Add** — "Edit configuration…" opens the detail with the saved editor open. |
| View role | — | link in detail | **Add** — "View role in Roles". |
| Remove member | `teamdef.member.remove` | yes (detail) | **Add** — "Remove member…" (danger, last) opens the existing removal confirmation. The backend still refuses while the team runs. |
| Copy member id / ticket key / run id | — | no | **Add** — "Copy ▸". |
| Cancel a single assignment, resolve a waiting assignment (`assignment.cancel`, `assignment.resolve`) | yes | no | **Exclude for now.** For board runs the retry/requeue/stop actions cover it. They matter for direct tasks, which the app cannot start yet; revisit with "Ask a member". |
| Attach to the member's tmux pane, view live output | — | no | **Defer.** No per-member backend API; the team-level attach command is the interim. |

## 2. Menus

`▸` opens a submenu. `[…]` is shown only when it applies. Disabled items stay visible and say why (§3).

### Team menu (header ⋯, after Refresh and Rename)

```
Reset usage limits ▸
    All providers            (N members on hold)
    ──────────
    Claude                   (2 members on hold)
    Codex                    (no hold)            ← disabled
Blocked tickets (3) ▸
    T-090  Finish Teams v4/v6 states…  · ROUND_LIMIT:qa-ready ▸
        Unblock to qa-ready
        Unblock to… ▸        (working statuses of the board)
Retry paused runs (2)…
[Command approvals (1) ▸]
    app-dev-dependency-add · T-091 ▸
        Approve
        Reject
        [Cancel running command]
──────────
Copy ▸
    Team id
    Runtime id
    Attach command (WSL)
    Attach command (Windows Terminal)
──────────
Start team   |   Stop team… / Restart team…   (T-101)
Delete team…                       (danger)
```

### Member menu (⋯ at the right end of every row, also right-click / the Menu key on the row)

```
Open details
Switch agent ▸
    ● Claude Opus 5.5 medium        (active)
      Codex 6.1 Terra high
      OpenCode Deepseek Flash       (on hold until 17:40)  ← disabled
[Resume agent ▸]                    (options on a usage hold)
──────────
[Current work ▸]                    (member has a run or a claimed ticket)
    Retry stage
    Requeue ticket…
    Stop run and block ticket…      (danger)
[Unblock ▸]                         (tickets blocked after this member's run)
    T-090 · ROUND_LIMIT:qa-ready ▸
        Unblock to qa-ready
        Unblock to… ▸
[Command requests ▸]
──────────
Edit configuration…
View role in Roles
Copy ▸
    Member id
    Ticket key         [if any]
    Run id             [if any]
──────────
Remove member…                      (danger)
```

## 3. Enablement rules (what makes an item enabled, hidden or disabled)

Global: every item that changes something is disabled when the app is disconnected, read-only, or another write is pending (the same `pending` / `readOnly` flags the Teams screen already uses). Items for something that does not exist (no blocked tickets, no pending approvals, no run) are hidden when the whole group is empty, except the three always-visible groups below, which show a disabled item with the reason.

| Item | Enabled when | Otherwise |
|---|---|---|
| Reset usage limits ▸ provider | team runtime is running **and** at least one member has a hold for that provider (a `quotaHolds` entry whose catalog agent has that provider, or availability `limit_reached`) | disabled: "No usage hold for <provider>." / "The team is not running." |
| Reset ▸ All providers | same, any provider | same |
| Blocked tickets ▸ | at least one blocked ticket | group shown disabled: "No blocked tickets." |
| Unblock to <status> | the ticket is still blocked (re-read before acting; a stale menu must not unblock a ticket that has moved) | feedback shows the backend error |
| Retry paused runs (N)… | N ≥ 1 paused runs with a live agent | disabled: "No paused runs." |
| Command approvals ▸ | shown only when ≥ 1 request is requested/approved/running | hidden |
| Switch agent ▸ option | exactly the rules of the member detail's live options (`memberAgentActionsModel.ts`): not the active one, no hold, no pending switch, team running | disabled with the same reason text |
| Resume agent ▸ option | option has a hold | group hidden if none |
| Retry stage | the member's run is `paused`, or its assignment is `waiting_input` / `reconciling` | disabled: "The current stage is not stuck." |
| Requeue ticket… / Stop run and block ticket… | the member has a run or a claimed ticket | group hidden |
| Unblock ▸ | ≥ 1 blocked ticket whose last member is this one | hidden |
| Edit configuration… | the member has saved configuration and the team is editable (`canEditMember`) | disabled: the team's `uneditableNote`, or "Saved configuration and removal are not available for runtime-only members." |
| Remove member… | the member has saved configuration and the team is editable (`canEditMember`) | disabled with the same reason as Edit configuration; when the team is running the existing backend refusal is shown as feedback |

## 4. Confirmations and safety

- No confirmation (reversible, no data loss): Reset usage limits, Unblock, Retry stage, Approve, Resume agent, Copy.
- Confirmation dialog (names the exact team/ticket/run, says what happens, default focus on Cancel): Retry paused runs, Requeue ticket, Stop run and block ticket, Reject (optional reason), Cancel running command, Stop team, Remove member, Delete team (existing).
- Switch agent keeps its existing confirmation before cancelling active work.
- **Stop team** must not be a one-click way to block tickets. The dialog shows who is working on what and offers, as the default, "Stop the board and wait for the running work to finish, then stop the team"; "Stop now" is a separate danger button that says tickets with running work become blocked and need unblocking. "Restart team…" uses the same dialog and sequence and starts the team again at the end.
- Every action reports through the Teams screen's existing feedback line (success text or `CODE: message` plus the backend's remediation) and then refreshes the overview.

## 5. Visual design

Same v4 dark tokens as the rest of the screen. Popover: background `#16191d`, border `#262a30`, radius 8, shadow `0 8px 24px rgba(0,0,0,.4)`, padding 4. Item: 32 px high, 13 px text, hover `#1b1f25`, danger text `#f48771`, disabled text `#8d949e` with the reason as 11.5 px text under the label, separators `#23262c`. The ⋯ trigger is a 28×28 icon button (`aria-label="Actions for <member>"`).

The Members table gets one extra 28 px column for the ⋯ button, right before the chevron. This is a deliberate difference from `design/teams-overview-v4.png`, which has no per-row menu.
