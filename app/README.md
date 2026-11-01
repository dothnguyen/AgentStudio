# Agent Studio desktop app (Electron)

Isolated Electron project. The Python tooling (`scripts/validate.py`, `tests/`) does not use it.

The main process owns exactly one child: `wsl.exe [-d <distro>] --exec <entry> serve`, speaking
line-delimited JSON (`agent-studio/v1`). Boundary rules:

- The child is started with an argument array (never a shell or a joined command string).
- Only safe literals (`A-Z a-z 0-9 . _ / : @ + = ~ -`) may appear on the command line.
- All data travels as JSON on stdin; user text never appears on a command line.

## Prerequisites

- Windows 10/11 with WSL and a distro.
- Node 20+ on Windows.
- Inside WSL: `bash /mnt/c/Works/Projects/AgentStudio/backend/install.sh`

## Run

PowerShell:

```powershell
cd C:\Works\Projects\AgentStudio\app
npm ci
npm start
```

A window titled "Agent Studio" opens. The console logs `[serve] connecting`, then `[serve] connected`
(or `[serve] lost: <reason>`).

The startup window uses a compact dark workbench layout. It supports keyboard navigation throughout,
shows visible focus outlines, and disables nonessential loading animation when the operating system's
reduced-motion preference is enabled.

Opening a workspace shows its dashboard. The header reports the current connection state and the time
the latest team response reached the renderer. Team and Board status load independently; Refresh asks
both settled sections to reload without duplicating a request that is already in flight; callers wait
for that request to finish, and responses
from an older workspace or loader are ignored. The Board panel shows the current phase, configured
status counts, totals, and the high-priority active or blocked ticket projection. Recent activity remains
a labelled placeholder until its panel is implemented.

## Test

```
npm test
npm run typecheck
```

`npm run build` also runs `vite build` into `dist/renderer/`.

Both work on Windows or in WSL. In WSL skip the Electron binary: `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci`.
`node_modules` is platform-specific; re-run `npm ci` when you switch between Windows and WSL.

## Configure the distro and entry point

All connection settings live in `src/main/config.ts`. Sources, highest priority first:

1. Environment: `AGENT_STUDIO_DISTRO`, `AGENT_STUDIO_ENTRY`, `AGENT_STUDIO_REQUEST_TIMEOUT_MS`
2. `%APPDATA%\agent-studio-app\config.json`:
   ```json
   { "distro": "Ubuntu-24.04", "entryPath": "/home/me/.local/bin/agent-studio", "requestTimeoutMs": 30000 }
   ```
3. Defaults: the default WSL distro (no `-d`), `$HOME/.local/bin/agent-studio`, 30000 ms.

List distro names with `wsl -l -v`. Settings are re-read on every connect and Retry. Invalid values
(unsafe characters, relative `entryPath`, timeout outside 1000..600000) put the connection in `lost`
with a message naming the setting.

## Connection states

`connecting`, `connected`, `lost`. When the child dies, pending requests are rejected and the state
becomes `lost`. Nothing is re-sent or restarted automatically; `retry()` starts a new child.

The window shows Connecting, or Connection lost / Could not connect with the reason, Retry and
diagnostics (command, distro, last error). Retry reloads the window; main sees the reload
(`did-finish-load` after the first load) and, if the state is `lost`, calls `retry()`. The preload API
stays at the four calls of the brief.

`StartupScreen` owns the renderer's single connection subscription and passes the subscribed status
into the connected workspace tree. A lost connection therefore unmounts the workspace dashboard, and
late dashboard responses are ignored.

## Live check (Windows + WSL)

Proves the real boundary: the app's main-process client starts the real `wsl.exe --exec agent-studio serve`
and issues `workspace.list`, headless (no Electron window).

Prerequisites: the backend is installed in WSL, and `npm ci` has been run on Windows (PowerShell).

```powershell
cd C:\Works\Projects\AgentStudio\app
npm ci
npm run live-check -- [--distro <name>] [--entry <path>] [--repo-wsl <path>] [--out <file>] [--keep]
```

Steps:

- setup: creates a throwaway `/tmp/agent-studio-live-*` state in WSL, removed afterwards unless `--keep` is given.
- connect: starts `serve` with that `XDG_STATE_HOME` (forwarded through `WSLENV`).
- temp-state: `health` must report the temp state dir before anything is written.
- clean-list: `workspace.list` on a clean state is empty.
- init / list-after-init: `agent-studio init` in WSL, then `workspace.list` returns that workspace.
- kill-serve: killing `serve` gives state `lost` with `serve exited (code ...`.
- no-auto-reconnect: requests fail with `NOT_CONNECTED` while lost.
- retry: Retry reconnects and returns the same list.
- wsl-missing / distro-missing / not-installed / distinct: each failure mode gives its own reason string.

It never starts the coordinator. The default evidence file is `scripts/windows/app-live-check-evidence.json`.
If the repository path has a space or another character outside `SAFE_ARG`, pass `--repo-wsl`.

## Teams v4 visual check (Windows)

Renders the real Teams overview (`WorkspaceShell` + `TeamsScreen`) with the sample data of
`design/teams-overview-v4.html` from `capture/teamsOverviewV4Fixture.ts`, and compares the capture with
`design/teams-overview-v4.png`.

Prerequisites: `npm ci` has been run on Windows (PowerShell) and the Electron binary is present. The
command does not run in WSL when Electron was installed with `ELECTRON_SKIP_BINARY_DOWNLOAD=1`.

```powershell
cd C:\Works\Projects\AgentStudio\app
npm run capture:teams
```

The Teams capture page is read-only: it uses no backend or WSL connection. The command opens a hidden
1440x1000 window at device scale factor 1 and writes:

- `test-results/teams-overview-v4-actual.png` — the captured screen.
- `test-results/teams-overview-v4-compare.png` — design | actual | difference. Red marks a channel
  difference above 16; grey marks a matching pixel.

It prints the number of differing pixels and exits 0 even when pixels differ. It exits 1 on errors
(missing build, missing design image, capture page not ready within 15 s). The run is an operator check
and is not part of `npm test`.

### Roles v2 visual check (Windows)

Renders the real Roles screen (`WorkspaceShell` + `RolesScreen`) with the sample data of
`design/roles-catalog-v2/` from `capture/rolesCatalogV2Fixture.ts`, and writes the list, the role page and
each dialog to `design/roles-catalog-v2/captures/`.

Prerequisites: `npm ci` has been run on Windows (PowerShell) and the Electron binary is present.

```powershell
cd C:\Works\Projects\AgentStudio\app
npm run capture:roles
```

The command opens a hidden 1440x1240 window at device scale factor 1 and writes `list.png`, `detail.png`,
`edit-overview.png`, `edit-instructions.png`, `edit-skills.png`, `new-role.png`, `delete-role.png` and a
`manifest.json` with their sizes and checksums. It is an operator check and is not part of `npm test`.

### Skills visual check (Windows)

Renders the real Skills screen (`WorkspaceShell` + `SkillsScreen`) with the sample data of
`design/skills-v1/` from `capture/skillsV1Fixture.ts`, and writes the list, the skill page, the missing
skill page and each dialog to `design/skills-v1/captures/`. It needs the Electron binary and is an operator
check, not part of `npm test`.

```powershell
cd C:\Works\Projects\AgentStudio\app
npm run capture:skills
```

The command opens a hidden 1440x1160 window at device scale factor 1 and writes `list.png`, `detail.png`,
`detail-missing.png`, `edit-content.png`, `edit-roles.png`, `new-skill.png`, `delete-skill.png` and a
`manifest.json` with their sizes and checksums. It is an operator check and is not part of `npm test`.

The Boards sidebar item is an expandable group (the same interaction as Teams) with Current Phase, Backlog and Phases children. Boards and Current Phase both open `boards/current`; Backlog and Phases open `boards/backlog` and `boards/phases`, which say "Coming in the next update" until Phase B. The Current Phase child carries a badge with the current phase ticket count from `management.boardPhases`. Ticket cards open `boards/ticket/<key>`, which keeps Current Phase current in the sidebar. The group and its children are native buttons: Enter or Space opens the group, Tab reaches each child, and the open child carries `aria-current="page"` and the selected style. The team page's Open board action opens Current Phase.

The Current Phase screen reads `management.boardPhases`, `management.boardSettings` and the current phase's `management.boardTickets` summary. Its header shows the `Boards / Current Phase` breadcrumb, the phase name, a Current pill, the description and a progress bar counted only from returned ticket statuses (`done` and `close` are finished). The notice explains that routing works only the current phase. Below it, the lanes are Intake, Build, Review and merge, and Finished, in that order; each lane shows its name and ticket count, and Finished starts collapsed with a chevron to expand it. Column order and membership come from the board's status list, so a custom status appears in an Other lane. A column header shows the status name, its ticket count and the worker line from the first matching board rule (`Developer works this`; action rules say `Merges automatically`). Empty columns are hidden by default and summarised in a dashed `N empty hidden: names` placeholder in the lane. A blocked ticket sits in its `returnStatus` column; when that status is unknown, one Blocked column appears at the end of Build. Columns show six cards and a `Show N more` button expands the rest. The board itself scrolls horizontally; the page does not. A loading skeleton, an error card with Retry, the "No tickets in this phase yet" state and a no-current-phase state that links to Phases are distinct. The app has no pushed board-change event yet, so the reads poll every five seconds; polling updates the same header without a loading flash. A `board-changed` window event also triggers an immediate refresh for future callers.

The Routing screen (its own sidebar section after Boards) shows workspace-wide board transitions as three summary cards (Autonomous execution, Worktrees, Role coverage) above the rules table, with role links and the workflow availability note. Routing belongs to the workspace board rather than to one team; the team page links to this screen instead of embedding a routing view. The page header follows the design with the heading and notice; the Refresh action sits in the page header so routing reads and the role catalog can be reloaded together. Operators add, edit, and remove routes in per-rule dialogs, edit the worktree base branch in its own dialog, and manage agent failure escalation policies. Protected routes can be edited but not removed. Routing saves apply workspace-wide to future claims and transitions; they do not change member roles or shared role instructions, cancel assignments, or reroute work already in flight. Saves check the configuration version and reload the latest settings. If a refresh reports invalid board or roles configuration, open drafts cannot be saved until the configuration is valid again. Configuration conflicts require an explicit reload before retrying. If the reload fails, the editor retains the draft and offers a retry; a successful write is reported only after fresh settings load.

The typed management API accepts ordered catalog agent IDs when adding or updating a member.
Named switch and resume calls resolve the workspace in the main process and submit coordinator
commands with fresh idempotency keys. Switching an active assignment requires its exact ID and
an explicit cancellation confirmation; backend errors and cancellation results are passed through.
The same API carries the read-only skill catalog and one skill detail, plus skill create, update,
delete and role-assignment writes. Skill writes send no generated idempotency key, matching role
writes, and rely on the catalog SHA tokens to reject stale edits. It also exposes the board reads the
Current Phase board and ticket page need: `management.boardPhases(workspaceId)` for
`phase.list`, `management.boardTickets(workspaceId, { phase? })` for `ticket.list` with
`summary: true` (no bodies, dependency keys included), and `management.boardTicket(workspaceId, { key })`
for `ticket.show` (body, links, events and `eventsTruncated`).

Member detail shows identity, shared role, ticket permission, saved options, and live state separately. Ticket permission is loaded from the saved team definition and can be edited when available. Team member editing shows saved catalog options in order, with the first as the default for the next team start. Inline members can be explicitly converted to catalog options. Live agent details and switch and resume controls use the options frozen at team start, separately from saved configuration. Resuming a hold does not verify quota.

The Agents screen loads the saved catalog and team usage independently, reports connection and configuration problems, and browses saved agent configurations, with search, provider and reasoning filters, and saved team-member references. Saved agents can be created, edited, and duplicated using backend-provided provider options. Deleting a saved definition requires confirmation and is blocked when saved team-member references are known; the backend also checks references when usage is incomplete or changes. Deletion does not change team membership or live runtime. Other saved changes apply on a future team start; live agent controls remain in Teams.

The agent form scrolls within the viewport when needed. If a pending save fails after its form is cancelled, the failure remains visible on the Agents screen.

An open agent draft and selection remain available during a catalog refresh. Saving is unavailable until the refresh succeeds, and catalog validation problems must be repaired on disk before saved agents can be changed. Keyboard focus stays within the form until it is closed; validation focuses the first invalid field.

When a form is cancelled while disconnected, focus returns to its action after reconnection and a successful catalog refresh, unless the user has moved focus elsewhere.

When a form is cancelled while its invoking action is disabled by a pending save or a lost connection, focus moves to Search and returns to the action when it is available again, provided focus has not moved elsewhere.

Saved values are displayed with their original whitespace. When a new submission fails client validation, its validation message replaces any previous server error in the form.

The Teams view shows each running catalog member's live agent options and quota holds
from runtime state. Switch requests with an active assignment require confirmation of
its exact ID. Resume clears a recorded hold; it does not verify provider quota. Saved
options apply on the next team start and do not determine live switch eligibility.
Switch evidence includes any backend code and message in every state, and a dead pane is
reported even when no live options are available. Reset times without a valid explicit
time zone are shown as unknown. Concurrent
member switch requests refresh independently until their results appear or polling
reaches its limit.

### Roles list and role page

The Roles screen shows the saved catalog as a full-width table with a search field, a role count and each role's description, skills and usage. Selecting a row opens that role's page; the breadcrumb returns to the same filtered list and puts focus back on the row that was opened. A deep link from a member page opens the requested role page directly, and an unknown role id keeps the fallback notice while showing the list.

The role page repeats the role name, id, usage count, running assignments, the saved-changes notice and Delete role. Its Overview and Shared instructions cards sit beside the Skills and Used by cards, wrapping to one column at 900 px. Shared instructions keep every catalog state (missing, unreadable, not configured, truncated) and show a read-only 300 px preview; warnings and assignment-source problems appear in an amber card only when there are some. Used by rows link to the member page when both ids are known. Each skill chip is a link-style button that opens that skill's page (including the missing page for a missing skill) through the same deep-link handling as roles. Each card's Edit button opens that section's dialog: Edit overview (name and locked role id plus description), Edit shared instructions (the same dialog the member page uses, with the prompt file and byte limit), and Edit skills (a checklist that keeps missing skills visible until they are removed). The Edit skills footer has a **Manage skills** link that discards the draft and opens the Skills list. Cancel or Escape discards the draft; a successful save refreshes the catalog and announces that new assignments use the new values. New role creates only the role id, name and optional description, then opens the new role page so instructions and skills can be added there. The Delete role confirmation is a compact dialog with the instruction-file outcome and returns to the refreshed list after a successful delete. Edit actions stay disabled while a write or delete is pending, while the backend is disconnected, or after a role delete until Roles is refreshed, with the reason attached through `aria-describedby`.

### Skills

A skill is a reusable instruction file that a role loads into its context when an assignment starts. Each
skill lives in `.agent-studio/skills/<id>/SKILL.md`; the folder name is the immutable skill id (lowercase
letters, numbers, dots, dashes and underscores, up to 64 characters). Roles list the ids they use in
`.agent-studio/roles.json`. Limits are 32 KiB per skill and 96 KiB for a role's whole context (its shared
instructions plus all its `ok` skills); a skill that does not fit is skipped. Saved changes apply to new
assignments, while assignments already running keep the skills they started with.

The Skills screen (its own sidebar section after Roles) loads `management.skills(workspaceId)` once per workspace with the shared section controller, so loading, retry, stale-data and focus behaviour match Roles. The header carries **New skill**, the saved-changes notice, a search field that matches skill ids and titles case-insensitively, and a count that reports both the total and the filtered matches. Catalog problems appear above the table in an amber note. New skill is disabled with a reason while a creation is saving or the backend is disconnected.

Each row shows the skill id and file path, its summary title, the first two roles that use it with a remainder count, and its size against the 32 KiB limit. Missing skills keep an amber row with "Missing" and "File not found"; unreadable skills show "Unreadable"; skills over the limit show their real size in amber. Selecting a row opens the read-only skill page with a `Skills / <id>` breadcrumb. Going back restores the same search text and focuses the row that was opened. Workspace changes reset the screen to the unfiltered list. A role's skill chip deep-links straight to that skill's page, including its missing page; an id the catalog does not know keeps the list visible with a fallback notice. The screen reloads its catalog whenever it is opened again, so a role's skill change made in Roles is visible the next time Skills is opened.

The skill page repeats the id, the usage pill (`Used by n roles`, `Not used`, or `Missing`), the title or the missing-file explanation, and the saved-changes notice. Its Content card loads `management.skill(workspaceId, id)` for the preview, line and byte counts and the 360 px fade, keeping loading, error and Retry states; truncated files carry the limit note and unreadable files replace the preview with an explanation. Missing skills show the amber explanation, a **Create this skill** action in the header and on the Create the file row of the two fixing options. Both open the New skill dialog with the missing id prefilled and locked.

The New skill dialog takes a skill id and markdown content. The id follows the backend rule (`^[a-z0-9][a-z0-9._-]{0,63}$`), shows the live `skills/<id>/SKILL.md` path, and is blocked when the id already has a file; a missing skill's id is allowed so its file can be created. The content starts from a template and refuses more than the catalog's 32 KiB. Create sends only `{ id, text }`; success closes the dialog, reloads the list, opens the new skill page with focus on its heading and announces `Created skill <id>.`. A raced `SKILL_EXISTS` stays in the dialog, refreshes the list in the background, and validation and unknown failures are reported there with Retry for the latter. Cancel or Escape discards the draft. The Details card shows the id, file path, title and size, while Used by roles lists every role with its context size against 96 KiB (amber above 80%) and an Open action that navigates to that role's page. A skill that disappears while open leaves "This skill no longer exists." and a way back to the list.

The Used by roles card has **Edit** (and a missing skill also has **Edit roles** on its Remove it from the roles row). Both open the 560 px **Roles that use &lt;id&gt;** dialog, which lists every role from the Roles catalog, not just the roles that currently use the skill. Each row is a checkbox showing the role name and "Uses this skill" or "Does not use it"; checked rows use the blue border and fill. Rows can be toggled with the pointer, Space or Enter. For a missing skill, roles that do not list it stay disabled with "Create the skill first to add it to a role.", while roles that list it can be unchecked. Save is disabled until the checked set differs from the saved set; it sends the complete checked role list with the skills catalog's `rolesSha256` through `management.updateSkillRoles`. Success closes, reloads both the skills list and the roles catalog so the page and Roles screen show the new skill chips and context sizes, announces `Saved roles for <id>.` and returns focus to the Edit action. `CONFIG_CHANGED` stays in the dialog with a Reload latest action that re-reads both catalogs and keeps the person's checks where the role still exists; `ROLE_NOT_FOUND` reports the missing role and reloads; `SKILL_NOT_FOUND` explains that the file is gone; other failures offer Retry. The action is disabled with a reason while a write is pending, the backend is disconnected, either catalog is loading or stale, or the roles catalog is not usable by the same rule the Roles screen applies before editing a role. If the roles section itself fails, that reason names its error and the screen shows a Roles catalog alert with a Retry loading roles action. A successful Reload latest clears the conflict alert; editing the draft afterwards keeps the conflict and its reload action until the catalogs are reloaded.

### Deleting a skill

A skill page shows **Delete skill** in its header (a missing skill has no file to delete and hides it). The button is bordered red, and the reason line below the header is linked through `aria-describedby`: while any role lists the skill it is disabled with an amber "Used by n role(s). Remove it from them before deleting it."; an unused skill says "No role uses this skill, so it can be deleted." in muted text. A pending skill write or a lost backend connection disables it with its own reason. Truncated and unreadable files stay deletable so a broken file can be removed, and their confirmation says the content cannot be checked.

The confirmation is a 480 px alertdialog titled `Delete <id>?` that names `skills/<id>` and its `SKILL.md`, puts initial focus on Cancel and sends `management.deleteSkill(workspaceId, id, rolesSha256, sha256)` from its red **Delete skill** action; `sha256` is null for an unreadable or truncated file because it has no stable full-file token. Cancel and Escape close it without a write; Escape is ignored while the delete runs. Success closes it, returns to the list, reloads the skills list and roles catalog, focuses the catalog heading (or the page heading when the list is empty) and announces `Deleted skill <id>.` in the green status chip; `folder: kept` adds "The folder was kept because it contains other files." `SKILL_IN_USE` keeps the dialog open with the role display names (the backend sends ids; the roles catalog maps them) and an **Edit roles** action that opens the Roles that use dialog; `CONFIG_CHANGED` explains that the skill or roles changed and offers Reload latest, which re-reads both catalogs and keeps the dialog mounted with a retry if that reload fails; `SKILL_NOT_FOUND` is treated as already deleted and returns to the refreshed list with `<id> was already deleted.`; other failures offer Retry in place. If either the skills list or roles catalog refresh after a successful delete fails, the stale list stays visible with the Roles-style "deleted, but could not be refreshed" alert and a Retry loading action; success is only announced once both reloads succeed.

### Deleting a role

The Roles screen offers **Delete role** for the role shown on its page only when its usage was scanned completely and shows no references, its catalog and instruction version tokens are present, and the backend connection is ready. The confirmation dialog states whether the instruction file is removed (conventional, unshared file) or preserved (custom or shared file). The backend rescans usage on delete; if it reports `ROLE_IN_USE`, every reference group is listed and nothing is changed — there is no force-delete or reference rewrite. The role list updates only after the delete succeeds and Roles reloads; if the reload fails, further role changes stay disabled until Roles is retried.

The Teams Members tab presents a compact roster of returned member identity, role, live or saved agent, availability, and current work. Select a member to view its details and controls; returning to the roster restores focus to that member. A member that disappears on refresh returns to the roster with an explanatory notice.

The selected team’s Overview shows its definition, runtime, returned-member availability, coordinator and live-state status, and board runner relationship. Member counts identify truncated results. Team rename and delete and board run and stop are available in Overview; team creation remains in the team browser.
