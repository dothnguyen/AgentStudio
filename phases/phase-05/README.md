# Phase 05 — Workspace dashboard redesign v2

## Goal

Redesign Home into the compact operational overview in [the visual reference](../../design/workspace-dashboard-v2.png), while preserving the dark theme, navigation, and read-only dashboard behavior. Operators should scan real workspace, team, board, and activity data quickly at desktop and narrow widths.

## Open questions and assumptions

- **Question:** Should “open” and “completed” cover every board phase? **Assumption:** No; `board.summary` returns the effective current phase only, so cards say “Current phase” and derive open from non-`done`/`closed` columns and completed from `done`/`closed` columns. No cross-phase value is claimed.
- **Question:** Should the five pictured agent portraits and a phase description be shown? **Assumption:** No; `team.list` exposes aggregate availability, member count, and assignment count, but not individual identities/presence; `board.summary` has phase name/status but no description. Use aggregate presence labels and phase name/status. Do not invent portraits or copy.
- **Question:** Which team should the panel emphasize when several exist? **Assumption:** Show a compact list of all returned teams, led by running teams, with a truncation notice when `team.list` says so. Never imply a single team represents the workspace.
- **Question:** What counts as “last updated”? **Assumption:** The last complete successful refresh of all three sections; keep the prior timestamp when any section fails and label partial/stale data clearly. This needs coordinated response tracking in the renderer, not a new backend command.

## Architecture

The existing renderer uses `WorkspaceShell.tsx` and `navModel.ts` for navigation, `DashboardHome.tsx` for composition, `useDashboardSection.ts` for per-section loading and stale-response protection, and `TeamsPanel.tsx`, `BoardPanel.tsx`, `ActivityPanel.tsx` for read-only content. `DashboardApi` in `app/src/renderer/api.ts` exposes `teams(workspaceId)`, `board(workspaceId)`, and `activity(workspaceId)`, mirrored in `app/src/shared/api.ts`; existing IPC maps those to `team.list`, `board.summary`, and `activity.recent`. The Home activity panel calls `activity.recent` with `{ limit: 15, kinds: ['ticket'] }`, so it lists ticket events only (moved, outcome applied, merged); the backend filters by kind before applying `limit`, and callers that omit `kinds` still get all kinds (`team`, `assignment`, `workflow`, `ticket`). Preserve these contracts and the allowlisted preload surface. `board.summary` contains current phase, configured status columns with counts/kinds, totals, and a bounded ticket projection; `team.list` contains up to 50 definitions, optional runtimes, aggregate availability, and `truncated`; `activity.recent` contains bounded entries with `summary`, `kind`, and ISO `at`. The sketch's numbers are illustrative; every rendered value must come from these responses or be explicitly unavailable.

Use the current CSS tokens and responsive foundations in `app/src/renderer/styles.css`. Keep one main landmark, one Home `h1`, panel `h2`s, text alongside status colors, native buttons for navigation/refresh/retry, and independent section errors. Existing destination placeholders remain outside scope.

## Epics → stories

| Epic | Story | Outcome |
|---|---|---|
| Shell and identity | [P05-S01](./stories/P05-S01-shell-and-header.md) | Compact sidebar and overview header |
| Scan metrics | [P05-S02](./stories/P05-S02-summary-metrics.md) | Four truthful summary cards |
| Operational panels | [P05-S03](./stories/P05-S03-board-status.md) | Current-phase board progress and counts |
| | [P05-S04](./stories/P05-S04-team-status.md) | Team runtime and aggregate availability |
| | [P05-S05](./stories/P05-S05-activity-feed.md) | Structured recent activity feed |
| State integrity | [P05-S06](./stories/P05-S06-refresh-coordination.md) | Truthful full-refresh timestamp and race handling |
| Finish | [P05-S07](./stories/P05-S07-responsive-accessibility.md) | Narrow-width and accessibility polish; full validation |

Dependencies allow the three panels to land independently after the shell, while the final validation story follows the whole layout.

## Teams management screen — T-037

**Goal.** Turn the approved Teams management concept into a workspace-scoped screen for reusable agents, team membership, live operation, and board routing. Every displayed value and action must reflect workspace configuration or runtime evidence.

**Goal, restated.** Operators can maintain reusable agent definitions and assemble teams while seeing each member's provider, model, availability, and current work. They can configure worktree and routing policy and control a live team board from the Teams screen, with Team Lead assigned to merge conflicts.

### Open questions and planning assumptions

| Question | Assumption for this story set |
|---|---|
| Where is `design/teams-screen-v1.png`? | It is absent from this checkout. Treat the ticket's enumerated capabilities as the approved functional reference; visual details require the image before visual acceptance. Pictured names, counts, providers, statuses, and models are illustrative only. |
| Is an agent definition shared across workspaces? | Scope the catalog to one workspace under `.agent-studio/`, consistent with teams, roles, workflows, and board configuration. Team members reference stable catalog ids; editing a catalog entry updates future starts, while a running roster remains frozen. |
| Can a member override a reusable agent definition? | Keep a member's identity and role in the team; use the catalog's provider/model/reasoning defaults. An explicit team override needs a later product decision. Existing inline members remain readable and editable during migration. |
| What does “merge on success” mean? | Show and edit the existing board action rule's merge behavior and worktree mode; never imply every workflow success merges. Preserve the board's outcome applier and safety checks. |
| Which board can the screen control? | The current workspace's one board and its selected running team. Start/stop reflect `board.run`/`board.stop`; a stopped or disconnected board is shown as such. |
| Are role descriptions editable here? | Read them from `roles.json` and offer workspace-scoped editing through a validated API. Role ids used by workflows and board rules remain stable unless explicitly migrated. |
| How are rules edited? | Edit the configured status → role → workflow → next-status graph using validated `board.json` writes. Keep action rules visible and protect merge-conflict and plan-merge-conflict routing to TeamLead in this workspace's default configuration; show validation errors rather than silently rewriting rules. |

### Architecture and gaps

`WorkspaceShell.tsx` already routes to a Teams placeholder, and the Home `TeamsPanel` links there. Reuse its shell, tokens, status labels, section loading pattern, and allowlisted preload/IPC boundary. `team.list` only returns a bounded definition summary plus aggregate runtime; it has no member identities, provider/model, role descriptions, or current assignment details. `board.summary` is read-only and omits the rule graph and board runner state. `teamdefs.py` stores inline members and has add/remove but no reusable agent catalog or general edit contract. `roles.json`, `board.json`, `team.status`, `board.show`, `board.run`, and `board.stop` supply foundations; safe workspace-scoped reads/writes, validation, and desktop IPC are still needed. The current board rules already route both `merge-conflict` and `plan-merge-conflict` to `TeamLead`; maintain that explicit mapping.

### Epics → stories

| Epic | Story | Outcome |
|---|---|---|
| Management contracts | [P05-S08](./stories/P05-S08-agent-catalog.md) | Reusable workspace agent definitions |
| | [P05-S09](./stories/P05-S09-team-edit-contract.md) | Team creation and membership against catalog definitions |
| | [P05-S10](./stories/P05-S10-management-read-model.md) | Member, role, provider/model and truthful live state projection |
| | [P05-S11](./stories/P05-S11-board-settings-contract.md) | Validated worktree, merge, routing, and board-control contracts |
| Desktop boundary | [P05-S12](./stories/P05-S12-management-ipc.md) | Typed, allowlisted management IPC |
| Teams UI | [P05-S13](./stories/P05-S13-teams-screen.md) | Team and reusable agent overview |
| | [P05-S14](./stories/P05-S14-team-membership-ui.md) | Team and member editing |
| | [P05-S15](./stories/P05-S15-live-team-controls.md) | Live status and board controls |
| | [P05-S16](./stories/P05-S16-routing-settings-ui.md) | Worktree, merge and routing editor |
| Acceptance | [P05-S17](./stories/P05-S17-teams-live-gate.md) | Responsive, accessible, Windows plus WSL live validation |

These ten stories form one dependency-ordered delivery set. Child tickets stay in backlog while this planning worktree is merged; the existing `plan-merge-ready` rule promotes this run's children to `refine-ready` after a successful merge.
