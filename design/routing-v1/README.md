# Routing screen v1 (its own menu item)

Design for a new top-level **Routing** screen, built on the Design canvas "Agent Studio Teams Redesign", artboard
"Routing - board to team". It replaces the Routing tab of the team page: routing is not a property of one team. It is the
workflow that connects the workspace board to the running team so work can proceed on its own. A team can work without a
board and a board can be worked by hand, so the screen has its own sidebar item (after Boards). It follows the look of the
Teams, Member details v7 and Roles v2 designs (`design/teams-member-detail-v7/`, `design/roles-catalog-v2/`).

| File | What it is |
| --- | --- |
| `overview.png` / `overview.html` | The screen: header, notice row, three summary cards (Autonomous execution, Worktrees, Role coverage) and the Rules table with Add rule and a per-row Edit |
| `edit-rule.png` / `.html` | Dialog "Edit rule 3" for an agent rule that is a protected route (workflow and workspace locked, Remove rule disabled) |
| `edit-action-rule.png` / `.html` | Dialog "Edit rule 1" for the built-in merge action (no role or workflow; Remove rule enabled) |
| `new-rule.png` / `.html` | Dialog "Add rule": status without a rule, agent or merge action, role, workflow, workspace, sync base, next statuses, escalation |
| `remove-rule.png` / `.html` | Confirmation for removing a rule |
| `worktrees.png` / `.html` | Dialog "Edit worktrees": base branch |
| `routing-v1.dc.html` | The source artboard. All states are driven by its `openDialog` prop (`none`, `rule`, `action-rule`, `new-rule`, `remove-rule`, `worktrees`). It needs the Design canvas runtime to run; the static `.html` files are plain HTML and open in any browser |

The static files are rendered from the source with sample data, so use their markup and inline styles for exact colours,
sizes and spacing. Tokens: page `#111316`, card `#16191d`, card border `#262a30`, text `#e7e9ec`, muted `#8d949e`, accent
`#5b9cff`, success `#6fd38b`, warning `#f0b453`, danger border `#4a2c2c` / text `#f0a3a3`. Status dots: backlog and closed
grey, ready statuses blue, needs escalation amber, conflicts red, done green. Fonts: Inter, JetBrains Mono. The sidebar is
the existing app sidebar plus the new Routing item.

Notes for the implementation:

- The rules, the validation (one rule per status, roles and workflows must exist, a path to done), the protected routes and the
  save with a concurrency check already exist (`RoutingSettingsPanel`, `routingSettingsModel`, `updateBoardSettings`). The
  design changes how they are shown and edited, and adds Add rule and Remove rule. Keep the existing rules and messages.
- Sample data (roles, members, team name, workflows, rule 10's statuses) are placeholders; use the real data.
- Not designed here: the problems list that the old panel shows for an invalid board configuration. Keep showing it, above the Rules table, in the same amber note style used for warnings in the other designs.
