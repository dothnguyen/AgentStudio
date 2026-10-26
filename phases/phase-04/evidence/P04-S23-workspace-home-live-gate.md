# P04-S23 — Workspace home live gate (Windows + WSL): evidence index

Status: operator run PENDING. Nothing below marked "PENDING" has been observed; the headless workflow cannot perform the live actions.
No tokens, provider output, usernames, full environment dumps or unrelated workspace names belong in this file.

## Environment

| Item | Value |
| --- | --- |
| Date/time (with timezone) | PENDING |
| Windows version | PENDING |
| Node version | PENDING |
| Electron version | PENDING |
| WSL distro | PENDING |
| Backend commit | PENDING |
| App commit | PENDING |
| Gate root | PENDING (`/tmp/agent-studio-home-gate-*`) |
| State root | PENDING (`<gate-root>/state`) |
| `health` state dir | PENDING (must be `<gate-root>/state/agent-studio`) |

## Backend source snapshots (saved before launching Electron)

| Source | File / output | Status |
| --- | --- | --- |
| `workspace list --json` | PENDING | PENDING |
| `team status --team running --json` | PENDING | PENDING |
| `team status --team stopped --json` | PENDING | PENDING |
| `board show --json` | PENDING | PENDING |
| `team.list {"workspace":...}` via `agent-studio request` | PENDING | PENDING |
| `board.summary {"workspace":...,"limit":5}` | PENDING | PENDING |
| `activity.recent {"workspace":...,"limit":15}` | PENDING | PENDING |
| `events --after 0 --limit 1 --json` | PENDING | PENDING |

Baseline `dbId`: PENDING. Baseline `head`: PENDING.

## Cases

| Case | Result | Observed text/values | Files |
| --- | --- | --- | --- |
| LG-01 Build and launch | PENDING | PENDING | `P04-S23/01-picker.png` |
| LG-02 Selection and default Home | PENDING | PENDING | `P04-S23/02-home-populated.png` |
| LG-03 Values match backend | PENDING | PENDING | snapshots above |
| LG-04 Navigation | PENDING | PENDING | `P04-S23/03-navigation.png` |
| LG-05 Refresh and configured-board failure | PENDING | PENDING | `P04-S23/04-board-not-configured.png` |
| LG-06 One serve process | PENDING | before: PENDING; after Retry: PENDING | `serve-pids` output |
| LG-07 Connection loss and Retry | PENDING | PENDING | `P04-S23/05-connection-lost.png`, `P04-S23/06-retry-recovered.png` |
| LG-08 Switch and create | PENDING | PENDING | `P04-S23/07-empty-workspace.png`, `P04-S23/08-created-workspace.png` |
| LG-09 Read-only journal proof | PENDING | after `dbId`/`head`: PENDING | `events` output |
| LG-10 Cleanup | PENDING | removed: PENDING | `serve-pids` count 0 |

LG-06 command: `python3 scripts/live/app-live-helper.py serve-pids --state <gate-state>` (expect `{"pids":[<one pid>],"count":1}`).

## Automated commands

| Command | Exit | Result |
| --- | --- | --- |
| `python3 -m pytest tests/unit/test_p05_app_live_helper.py -q` | PENDING | PENDING |
| `npm --prefix app test` | PENDING | PENDING |
| `npm --prefix app run typecheck` | PENDING | PENDING |
| `npm --prefix app run build` | PENDING | PENDING |
| `python3 scripts/validate.py --touched` | PENDING | PENDING |
| Windows `npm --prefix app run build` (LG-01) | PENDING | PENDING |

## Overall operator result

PENDING

## Defects filed

None recorded yet. Every failed case must list the new ticket key here; no defect is fixed in this story.
