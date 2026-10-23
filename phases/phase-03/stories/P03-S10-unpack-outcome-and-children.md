# P03-S10 — Unpack outcome, child tickets, re-unpack and the plan gate

Status: To Do
Depends on: P03-S06, P03-S09
Architecture: [P03 design contract](../README.md#design-contract), §B (feature path), §C (unpack rows), §F; brief §3b

## Goal

A feature ticket (`ticket add --brief`) is unpacked by the ProductOwner. The coordinator validates the manifest and the planning diff, commits the planning files to base, and creates one child story ticket per manifest entry, with its dependencies, in `refine` (or `backlog` behind the optional plan gate). Questions block the parent instead. Unpacking again updates children by story path and never deletes a child that has already left `refine`.

## Implement in this order

1. `ticket.create` with `kind: feature` (S02 refuses it with `BAD_REQUEST` until now): `briefPath` + `outDir` → `ready_unpack`. `briefPath` passes `tickets.check_workspace_path` from S02 (`STORY_PATH_INVALID`); `outDir` is relative and stays inside `phases/` (`STORY_PATH_INVALID` otherwise; it need not exist yet).
2. Outcome hook (S06) for unpack:
   - read `<out>/tickets.json`;
   - check the planning paths (§F unpack glob);
   - validate the manifest (S09).
   Any failure → `blocked` with the errors, nothing created. Non-empty `questions` → planning commit (if the diff is valid), `blocked` with the questions, no children.
3. Otherwise: planning commit, then in one transaction create the children (`kind: story`, `parent_ticket_id`, title, priority per §G, deps from `dependsOn` mapped to the new keys plus any `Depends on:` matches as in S02, shown in `ticket.children_created`). The parent → `unpacked`.
4. Re-unpack (`ticket.move <parent> ready_unpack` by the operator from `unpacked` or `blocked`): children matched by `story_path`:
   - matched and still `refine` / `backlog` → title, priority and deps updated;
   - matched and further along → left unchanged and listed in the event;
   - new paths → created;
   - children no longer in the manifest → left unchanged and reported (never deleted or cancelled automatically).
5. `requirePlanApproval: true` → children are created in `backlog`, and `ticket.approve <parent>` moves them all to `refine` (`TICKET_TRANSITION_INVALID` if the parent is not `unpacked`).
6. CLI `agent-studio ticket create --brief PATH --out DIR`, `ticket approve KEY`. In `team.py`: `ticket add --brief PATH --out DIR`.

## Done when

- [ ] Fake PO writes 3 stories, where story 3 depends on story 1: the parent is `unpacked`, there are 3 children in `refine` with one dependency edge, and one planning commit on `main` contains exactly the out-folder files. Test: `tests/integration/test_p03_s10_unpack.py`.
- [ ] `questions` non-empty → the parent is `blocked` with them and there are no children. After `ticket.move ready_unpack` and a second fake run with no questions → children created.
- [ ] Re-unpack with one changed title, one child already `in_dev`, one new story and one removed story → the title updated, the `in_dev` child unchanged, one new child, the removed one reported and kept. Running it twice in a row with the same manifest changes nothing (idempotent).
- [ ] The PO writes a file outside `out_dir` → parent `blocked` / `PLANNING_DIFF_INVALID`, no commit, no children. An invalid manifest → `blocked` / `MANIFEST_INVALID`.
- [ ] With `requirePlanApproval` the children are in `backlog` until `ticket.approve`.
- [ ] All existing tests stay green.

## Evidence

(filled in when the story is done)
