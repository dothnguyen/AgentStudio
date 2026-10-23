# P03-S03 — Worktree service, commit-on-branch and planning commits

Status: Done (2026-10-23)
Depends on: — (pure git; can run in parallel with S01–S02)
Architecture: [P03 design contract](../README.md#design-contract), §E (git and worktrees), §F (planning commits)

## Goal

One module, `backend/agent_studio/worktrees.py`, does every git operation the board needs, with argv lists and no shell: create, list and remove ticket worktrees and branches (the primitives S12's startup reconcile uses), commit a round on a branch, compute a branch diff, and commit an exact list of planning paths to the base branch in the main checkout after checking them against an allow-list. It has no database access, so it is unit-testable on throwaway repositories.

Conventions for every function below:
- Every git call goes through `gitws.run` (argv list, `SAFE` options, `GIT_*` env stripped). No `subprocess` call with `shell=True`, no `os.system` / `os.popen`.
- Errors are raised as `AsError` (like `gitws`): git failures as `GIT_FAILED` with git's stderr in the message; the other codes are named per step.
- `state_dir` is an optional keyword argument (`state_dir: Optional[str] = None`) on every function that needs the root; `None` means `paths.ensure_state_dir()`. Tests pass a temp dir. Dependent stories (S04, S05, S12) call without it.
- All paths compared or returned are `os.path.realpath`-canonical.

## Implement in this order

1. `root_for(workspace, *, state_dir=None)` → `<state>/worktrees/<sha256(realpath(workspace))[:12]>/` (§E). It refuses a root for which `paths.is_windows_or_network_path` is true (covers `/mnt/…`) with `STATE_DIR_UNUSABLE`. `slug(title)` → lowercase, every run of characters outside `[a-z0-9]` becomes one `-`, leading/trailing `-` stripped, cut to 40 characters and stripped again; an empty result becomes `ticket`. The result always matches `^[a-z0-9-]{1,40}$`.
2. `create(workspace, key, slug, base_branch, *, state_dir=None)` → `{branch, path, baseCommit}`, where `path = root_for(...)/<key>` and `branch = ticket/<key>-<slug>`, via `git worktree add -b <branch> <path> <base_branch>` run in the main checkout. `baseCommit` is the commit of `base_branch` at creation. It refuses (`AsError`, nothing created) when: `key` does not match `^T-\d{3,}$` or `slug` does not match the slug pattern (`BAD_REQUEST`); the branch already exists or the path already exists (`WORKTREE_EXISTS`); git fails (`GIT_FAILED`).
3. `list_registered(workspace, *, state_dir=None)`: parses `git worktree list --porcelain -z` of the main checkout and returns `[{path, branch, head}]` for worktrees whose path is under `root_for(workspace)` only (the main checkout is never listed). `branch` is the short name (`refs/heads/` stripped), or `None` for a detached HEAD.
4. `remove(workspace, path, *, state_dir=None)`: `git worktree remove --force <path>`, then `git worktree prune`. The branch is kept. It refuses a path that is not strictly under `root_for(workspace)` with `WORKTREE_NOT_REGISTERED`, without calling git.
5. `commit_round(path, message)` → `{commit: <sha>}`, or `{commit: None}` when nothing changed: `git add -A`, then, only if `git diff --cached --quiet` reports changes, `git commit -m <message>` in the worktree.
6. `branch_diff(workspace, base_branch, branch, out_dir)`: the diff from `git merge-base <base_branch> <branch>` to `<branch>`, run in the main checkout (no working-tree or untracked content). It writes `out_dir/diff.patch` and returns the same shape as `gitws.capture_diff`: `{path, bytes, truncated, changedFiles, empty}`, bounded by `gitws.MAX_DIFF_BYTES` with the same truncation marker, `changedFiles` capped at 200.
7. Planning commits (§F):
   - `changed_paths(workspace)` → sorted, de-duplicated list of repository-relative paths from `git status --porcelain=v1 -z --untracked-files=all`, untracked included. A rename or copy contributes both its old and new path.
   - `check_paths(paths, allowed_globs, *, max_paths=None)` → `(ok, offending)`. A path is offending when it is empty, absolute, contains a `..` component or a backslash, differs from its `posixpath.normpath`, or matches none of `allowed_globs` (`fnmatch.fnmatchcase`, so `*` also matches `/`; `phases/phase-03/*` covers every depth). When `max_paths` is set and more paths than that are given, `ok` is false and every path is offending (triage uses `max_paths=1`, §F "exactly one"). `offending` is sorted; `ok` is `not offending` otherwise. An empty `paths` list is ok.
   - `commit_paths(workspace, base_branch, paths, message)` → `{commit}` (or `{commit: None}` for an empty list, with no git write). It first checks that HEAD is the branch `base_branch` (`git symbolic-ref --short -q HEAD`; a detached HEAD or another branch → `MAIN_CHECKOUT_WRONG_BRANCH`, nothing staged). Then `git add -A -- <paths>` (so deletions are staged too) and `git commit -m <message> -- <paths>`, so nothing else that is staged or untracked is committed.
8. `is_clean(workspace)` → `True` when `git status --porcelain=v1 -z --untracked-files=all` is empty, for S07's merge check and the §D main-checkout hold.
9. Add `WORKTREE_EXISTS` next to the other P03 codes in `protocol.py` (and `WORKTREE_NOT_REGISTERED`, `MAIN_CHECKOUT_WRONG_BRANCH` if they are not there yet), and add `test_worktrees_is_clean` to `tests/unit/test_p01_s05_guard.py` (§A: no role, stage id or provider names in `worktrees.py`), in the style of `test_tickets_is_clean`.

## Done when

Every test builds its own temp repository with one commit on `main` (and sets `user.name` / `user.email` in that repository's config) and passes a temp `state_dir`.

- [x] `slug` on a title with `$(rm -rf /)`, quotes, backticks, `;`, newlines and non-ASCII gives a value matching `^[a-z0-9-]{1,40}$`; an all-symbol title gives `ticket`; a 100-character title gives at most 40 characters.
- [x] `root_for` gives `<state>/worktrees/<12 hex>/`, the same value for the same workspace, and refuses `state_dir="/mnt/c/x"` with `STATE_DIR_UNUSABLE`.
- [x] `create` gives a worktree at `root_for(...)/T-001` on `ticket/T-001-<slug>` with `baseCommit` = `main`'s HEAD, and `list_registered` returns exactly that entry (not the main checkout). A second `create` with key `T-001` is refused with `WORKTREE_EXISTS`, and a key `../x` is refused with `BAD_REQUEST`; neither creates a branch or a directory.
- [x] `commit_round` after writing a file in the worktree returns a commit that is the branch head, `main`'s HEAD is unchanged, and a second call with no changes returns `{commit: None}`.
- [x] `branch_diff` after `main` moved forward with an independent commit shows the branch's file and not `main`'s new file, and returns the `capture_diff` shape; a diff larger than `MAX_DIFF_BYTES` comes back with `truncated: true`.
- [x] `changed_paths` lists a modified tracked file, a deleted file and an untracked file in a new subfolder.
- [x] `check_paths` with `["phases/phase-03/*"]` accepts `phases/phase-03/stories/x.md` and rejects `phases/phase-03/../../etc/passwd`, `/abs`, `phases/phase-04/x.md`; with `["bugs/BUG-T-001-*.md"]` and `max_paths=1`, one bug file is ok and two bug files are both offending.
- [x] `commit_paths` commits exactly the given paths (asserted with `git show --name-only`), and an unrelated untracked file and an unrelated staged file stay uncommitted. With HEAD on another branch, and with a detached HEAD, it fails with `MAIN_CHECKOUT_WRONG_BRANCH` and the index is unchanged.
- [x] `is_clean` is true on a fresh repo and false with one untracked file.
- [x] `remove` deletes the worktree directory, `list_registered` no longer returns it, the branch still exists, and a path outside the root (the main checkout, and `<root>/../x`) is refused with `WORKTREE_NOT_REGISTERED`.
- [x] No shell: a test patches `subprocess.run` (wrapping the real one) during `create`, `commit_round`, `commit_paths` and `remove`, and asserts every call's first argument is a list and `shell` is not true; a source check asserts `worktrees.py` contains no `shell=True`, `os.system` or `os.popen`.
- [x] Guard: `test_worktrees_is_clean` in `tests/unit/test_p01_s05_guard.py` passes.
- [x] Tests: `tests/unit/test_p03_s03_worktrees.py`. All existing tests stay green.

## Evidence

- Implemented: `backend/agent_studio/worktrees.py` (new): `root_for`, `slug`, `create`, `list_registered`, `remove`, `commit_round`, `branch_diff`, `changed_paths`, `check_paths`, `commit_paths`, `is_clean`. Every git call goes through `gitws.run` (argv, no shell). `branch_diff` uses `gitws.MAX_DIFF_BYTES` and the same truncation marker as `gitws.capture_diff`.
- `backend/agent_studio/protocol.py`: added `WORKTREE_EXISTS`, `WORKTREE_NOT_REGISTERED`, `MAIN_CHECKOUT_WRONG_BRANCH`. `phases/phase-03/README.md` §I lists `WORKTREE_EXISTS`.
- Tests: `tests/unit/test_p03_s03_worktrees.py` (new, 9 tests on throwaway repos with a temp `state_dir`); `tests/unit/test_p01_s05_guard.py` gains `test_worktrees_is_clean`.
- Validation: unit suite, `Ran 355 tests in 10.043s — OK (skipped=3)`. QA passed with no findings. The ResourceWarnings in the output come from the older `test_s06_parts.py`, not from this story.
- Note: the `../x` key refusal test checks that no directory is created. That no branch is created follows from the code (validation runs before any git write), but the test does not assert it.
