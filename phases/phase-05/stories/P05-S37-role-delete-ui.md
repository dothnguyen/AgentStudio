# P05-S37 — Add safe role deletion UI

Status: To Do
Depends on: P05-S33, P05-S35
Architecture: [Roles catalog assumptions](../README.md#open-questions-and-planning-assumptions)

## Goal
Make role deletion explicit and understandable, prevent confirmation when usage discovery is incomplete, and present authoritative backend blockers without suggesting that assignments or routing can be silently repaired.

## Implement in this order
1. Add a Delete action to the selected role detail. Disable it with an explanation when usage is blocking/partial, catalog tokens are missing, the app is disconnected, or another mutation is pending; browsing remains available.
2. For a fully scanned unused role, open an accessible destructive dialog naming display name and stable id, stating whether the conventional instruction file will be removed or a custom/shared file preserved, and requiring explicit confirmation. Restore focus to the trigger on cancel/error.
3. Call `management.deleteRole` with fresh catalog/instruction tokens. Do not optimistically remove the item; after success reload, select the next visible role deterministically, and announce the result including preserved custom file/missing conventional file information.
4. Render `ROLE_IN_USE` references grouped as team members, board rules, workflow stages, legacy roster, and live runtime. Render `ROLE_USAGE_UNAVAILABLE` and `CONFIG_CHANGED` as retry/reload conditions; never offer force delete or automatic reference rewriting.
5. Add `app/test/roleDelete.test.tsx` and role-screen regression cases for zero/one/many roles, changed search filters, every blocker group, partial scans, stale confirmation, reload failure, and repeated submit prevention.
6. Include narrow-dialog, long-reference wrapping, keyboard/Escape, initial focus, focus return, live-region, and stale workspace/mutation-response assertions in the automated cases.

## Done when
- [ ] Delete is confirmable only for an authoritatively unused role and the dialog accurately describes instruction-file handling; cancel/error changes nothing and restores focus.
- [ ] Backend blockers override stale UI state, all structured reference groups are visible, and there is no force-delete or silent migration path.
- [ ] Success waits for reload, chooses a deterministic remaining selection, and handles deletion of the final role with the catalog empty state. Test: `npm --prefix app test -- roleDelete rolesScreen`.
- [ ] Destructive-dialog accessibility and narrow-layout tests prove long blockers do not overflow, repeated/stale responses cannot delete UI state, and focus/announcements are correct.

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
