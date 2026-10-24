# P04-S01 — Workspace init and resolution

Status: Done (2026-10-24)
Depends on: —
Architecture: [P04 design contract](../README.md#design-contract), §A, §B

## Goal
`agent-studio init` creates and registers a workspace, and every new command finds its workspace by walking up from the current directory, with `--workspace` as an override. A shared output helper gives every new command human text by default and JSON with `--json`, while `request` and `serve` stay JSON.

## Implement in this order
1. New module `backend/agent_studio/workspace.py` with the resolver `resolve(cwd, override=None)` returning `{id, name, path}` (`path` is the canonical `os.path.realpath`):
   - With `override` (`--workspace PATH`): PATH itself must contain `.agent-studio/workspace.json` (no walking up).
   - Without it: walk up from `cwd` to the first directory that has `.agent-studio/workspace.json`. A `.agent-studio/` folder without `workspace.json` (e.g. a pre-P04 repo) is not a workspace and the walk continues upwards.
   - No match raises `AsError(WORKSPACE_NOT_FOUND, ..., remediation="run agent-studio init")` (the code already exists in `protocol.py`).
   - A `workspace.json` that is not a JSON object with string `id` and `name` raises `BAD_REQUEST` naming the file.
   - The resolver reads files only; it does not consult or write the registry. Existing commands do not call it in this story.
2. `init [--name N] [--path P]` (target defaults to cwd; P must be an existing directory, otherwise `BAD_REQUEST`):
   - Creates `.agent-studio/` if needed and writes `workspace.json` `{"id": <uuid4 string>, "name": N or the folder's basename}` with two-space indentation. The id is written once and never changed by any command.
   - Registers the workspace (step 3).
   - If `workspace.json` already exists: changes nothing in the folder (a different `--name` does not rename), registers it if it is not registered yet, and prints the existing workspace. A `.agent-studio/` that exists without `workspace.json` gets only the new file; other files in it are untouched.
   - `init` inside a folder whose parent is already a workspace creates a nested workspace; resolution then picks the innermost one.
3. Registry: the file `workspaces.json` in the state dir (`paths.ensure_state_dir()`, next to `state.db`; README Q2), shape `{"workspaces": [{"id", "name", "path"}]}`, one entry per canonical path, written atomically (temp file + `os.replace`). It is not part of `state.db` and needs no migration. `workspace list` reads it; an entry whose path (or its `workspace.json`) no longer exists is shown with `missing: true` and is never removed or rewritten by `list`.
4. Output helper (in `cli.py` or a small new module): `emit(resp, human_renderer, json_flag, pretty)`:
   - `--json` given: print the existing response envelope (`{ok, data}` / `{ok, error}`) exactly as `_emit` does today (`--pretty` still indents).
   - Otherwise: print `human_renderer(data)` on stdout; an error prints `CODE: message` and, on the next line, the remediation, on stderr.
   - Exit code 0 on success, 1 on error, in both modes.
   - Wire only `init` and `workspace list` now; later stories reuse it. Add both to `USAGE`.
   - `init` and `workspace list` run in the CLI process; they are not added to `dispatch.COMMANDS`, so `request` and `serve` are unchanged.
   - Human text: `init` prints the name, id and path (and says when the workspace already existed); `workspace list` prints one line per workspace with name, id, path and `(missing)` when missing, or `no workspaces registered`.
5. Existing commands keep their `--workspace` handling unchanged (required where it is required today, optional where it is optional); none of them is switched to the resolver in this story.

## Done when
- [x] `init` in an empty temp folder writes `.agent-studio/workspace.json` with a uuid id and the folder name, and adds one registry entry; a second `init` (also with a different `--name`) leaves `workspace.json` byte-identical and the registry unchanged; `init` in a folder with `.agent-studio/` but no `workspace.json` keeps the other files. Test: unit, `tests/unit/test_p04_s01_workspace.py`, with a temp `XDG_STATE_HOME`.
- [x] `--path P` initialises P; a missing P gives `BAD_REQUEST`. Test: unit.
- [x] Resolution works from a nested subfolder, skips a `.agent-studio/` that has no `workspace.json`, picks the innermost of two nested workspaces, `--workspace` overrides the cwd, and a folder with no `workspace.json` at or above it (or a `--workspace` path without one) gives `WORKSPACE_NOT_FOUND` with remediation `run agent-studio init`. Test: unit.
- [x] `workspace list` shows every registered workspace; after the folder is deleted it is listed with `missing: true` and the registry file is unchanged. Test: unit.
- [x] With `--json` the output of `init`, `workspace list` and an error case parses as the response envelope; without it the output is the human text and an error prints `CODE: message` plus the remediation; exit codes are 0/1. Test: unit (call `cli.main` and capture stdout/stderr).
- [x] `init` then `workspace list --json` work through the real CLI entry (the `backend/bin/agent-studio` shim via the sandbox helper in `tests/helpers.py`, with its temp `XDG_STATE_HOME` and a temp cwd), and `request` with a `health` request still returns the JSON envelope. Test: integration, `tests/integration/test_p04_s01_init_cli.py`.
- [x] Existing `team start --workspace`, `task direct` and `workflow start` still work and `init`/`workspace` are not dispatch commands. Test: existing suites stay green (`python3 scripts/validate.py --unit`) plus a unit assertion that `dispatch.COMMANDS` has no `init` or `workspace.*` key.

## Evidence
- Tests: `python3 scripts/validate.py --unit` — Validation PASSED, 549 unit tests OK (skipped=3); integration `tests.integration.test_p04_s01_init_cli` — 1 test OK.
- Added: `backend/agent_studio/workspace.py` (resolver `resolve(cwd, override)`, `init`, registry `workspaces.json` in the state dir with atomic replace, `list_workspaces` flagging missing entries without rewriting).
- Changed: `backend/agent_studio/cli.py` — shared `emit(resp, human_renderer, json_flag, pretty)` helper; `init` and `workspace list` run in the CLI process (not in `dispatch.COMMANDS`) and are listed in `USAGE`.
- Tests added: `tests/unit/test_p04_s01_workspace.py` (init/re-init byte-identical, `--path`, resolution cases, missing listing, JSON/human/error output and exit codes, no dispatch keys); `tests/integration/test_p04_s01_init_cli.py` (init + `workspace list --json` through the shim, `request health` still JSON).
- QA: pass, no findings.
