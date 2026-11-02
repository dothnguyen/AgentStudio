# Boards v1 (Phase A): Current Phase board and read-only ticket page

Design export for the Boards section. Phase A covers the sidebar group, the Current Phase kanban and a read-only ticket page. Phase B adds Backlog and Phases; actions (move, unblock, retry) are planned for Phase C.

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

## Captures

`npm --prefix app run capture:boards` builds the operator capture page, renders the real
Current Phase screen and ticket page through `WorkspaceShell`, and writes these files:

| Capture | What it shows |
|---|---|
| `captures/board.png` | Current Phase board with empty columns hidden and Finished collapsed |
| `captures/board-all-columns.png` | The same board with empty columns shown and Finished expanded |
| `captures/ticket-working.png` | Ticket page for a working ticket (T-114) |
| `captures/ticket-waiting.png` | Ticket page for a ticket waiting on dependencies (T-118) |
| `captures/ticket-blocked.png` | Ticket page with the blocked banner (T-136) |
| `captures/ticket-done.png` | Ticket page for a finished ticket (T-112) |

The capture page uses `app/capture/boardsV1Fixture.ts` for the same sample keys, titles,
columns and ticket text as the design. The generated `manifest.json` records each image's
size and SHA-256 so `boardsCapture.test.tsx` fails when a capture is stale.

## Phase B

There is no Phase B mockup. The capture harness is configured to record the implementation as `captures/backlog.png`, `captures/backlog-filtered.png`, `captures/backlog-collapsed.png`, and `captures/phases.png` (including blocked and empty phases). These captures have not yet been generated.

## Intended differences from the design PNGs

- The captures show the app's own sidebar and real workspace values; the design canvas uses
  the same illustrative `Agent Studio` workspace. The fixture has one team, so the sidebar
  shows `1` beside Teams and a `New team` row where the design shows six members.
- The capture fixture has 16 sample tickets like the design, but the real board hides empty columns
  and collapses Finished by default, so `board.png` is narrower than
  `board-all-columns.png` in the same way as the design.
- The real board and ticket page use live component text and rules; illustrative counts in
  the design that are not backed by the sample tickets are not invented. The ticket page
  shows the full phase name (`Phase 06 - Roles, Routing and Skills redesign`) where the
  design abbreviates it to `Phase 06`.
- The real board is a scroll container, so the headless capture shows its horizontal
  scrollbar; the design PNG omits it. Timeline labels for unknown event names use the
  generic fallback instead of the design's hand-written labels.
- Focus rings and native buttons appear where the design shows static controls; they are
  intentionally visible for accessibility and keyboard use.

## Structure

- Sidebar: Boards group (expandable) with children Current Phase (count badge), Backlog, Phases. Backlog and Phases open their respective screens.
- Current Phase header: phase name, "Current" pill, description, progress from done/total counts, one-line notice about automatic work.
- "Needs attention" card: blocked tickets, command requests awaiting approval, paused runs.
- Toolbar: search, Blocked only, Working now, Hide empty columns, ticket count.
- Lanes: Intake, Build, Review and merge, Finished (collapsed by default). Columns come from the board statuses; the worker line comes from the board routing rules.
- Cards: key, title (3-line clamp), priority tag when not 100, owner, activity chip (Working, Blocked, Waits for, Ready queued, Not started, Merged). Show more after 6 cards.
- Ticket page: breadcrumb, key + status + activity chips, title, blocked banner, Description (ticket body), Timeline, Work, Dependencies (clickable), Details.

## Data notes

- Blocked tickets have status `blocked`, `blockedReason` and `returnStatus`. Place them in the column of `returnStatus`; fall back to a "Blocked" column when unknown.
- `activity` is derived: `working` (agent, role, run, workflow), `not started` (`waitingFor`, `note`), `finished`, `blocked` (`note`).
- `ticket.list` supports a summary mode (`summary: true`): it omits bodies and adds `dependsOn` and `openDependsOn` for the board cards.
- Timeline comes from `ticket.show` `events`; unknown event names use a generic fallback label.
