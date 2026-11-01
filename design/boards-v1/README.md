# Boards v1 (Phase A): Current Phase board and read-only ticket page

Design export for the Boards section. Phase A covers the sidebar group, the Current Phase kanban and a read-only ticket page. Backlog and Phases come in Phase B, actions (move, unblock, retry) in Phase C.

## Files

| File | What it shows |
|---|---|
| `board.html` / `board.png` | Current Phase board, empty columns hidden, Finished collapsed |
| `board-all-columns.html` / `.png` | Same board with "Hide empty columns" off and Finished expanded |
| `ticket-working.html` / `.png` | Ticket page, a ticket being worked (T-114) |
| `ticket-waiting.html` / `.png` | Ticket page, a ticket waiting on dependencies (T-118) |
| `ticket-blocked.html` / `.png` | Ticket page with the blocked banner (T-136) |
| `ticket-done.html` / `.png` | Ticket page, a finished ticket (T-112) |
| `boards-v1.dc.html` | Design canvas source. Props: `startView` (board or ticket), `startTicket`, `hideEmpty` (default true), `showFinished` (default false) |

## Structure

- Sidebar: Boards group (expandable) with children Current Phase (count badge), Backlog, Phases. Backlog and Phases are placeholders until Phase B.
- Current Phase header: phase name, "Current" pill, description, progress from done/total counts, one-line notice about automatic work.
- "Needs attention" card: blocked tickets, command requests awaiting approval, paused runs.
- Toolbar: search, Blocked only, Working now, Hide empty columns, ticket count.
- Lanes: Intake, Build, Review and merge, Finished (collapsed by default). Columns come from the board statuses; the worker line comes from the board routing rules.
- Cards: key, title (3-line clamp), priority tag when not 100, owner, activity chip (Working, Blocked, Waits for, Ready queued, Not started, Merged). Show more after 6 cards.
- Ticket page: breadcrumb, key + status + activity chips, title, blocked banner, Description (ticket body), Timeline, Work, Dependencies (clickable), Details.

## Data notes

- Blocked tickets have status `blocked`, `blockedReason` and `returnStatus`. Place them in the column of `returnStatus`; fall back to a "Blocked" column when unknown.
- `activity` is derived: `working` (agent, role, run, workflow), `not started` (`waitingFor`, `note`), `finished`, `blocked` (`note`).
- `ticket.list` returns full bodies today; the board needs a summary mode (see tickets).
- Timeline comes from `ticket.show` `events`; unknown event names use a generic fallback label.
