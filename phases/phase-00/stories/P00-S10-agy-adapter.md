# P00-S10 — Antigravity CLI (agy) provider adapter

Status: To Do
Depends on: P00-S04 (contract), P00-S05 (real direct-task check)
Architecture: [P00 implementation contract](../architecture.md), section F

Follow the **shared adapter checklist** in the [stories README](./README.md). This story lists only what is specific to `agy`. It may be marked Blocked with a recorded capability gap; any two Done adapters unblock S12.

## agy-specific steps

1. Confirm `agy` is installed in the distro and inspect version/help via the entry shim. Read the [Antigravity headless documentation](https://www.agy.dev/docs/cli/headless/) and record exact tested flags/output in `providers/agy/CONTRACT.md`. Candidate: headless mode with stream-json output.
2. Headless mode uses cached credentials per the docs; map unauthenticated output to `AUTH_REQUIRED` immediately.
3. Policy mapping: only scoped, verified permission rules. Never default to a skip-permissions flag.
4. Parse init, step-update, and terminal result events; decide from `result.status` (SUCCESS / ERROR / CANCELED / INTERRUPTED / WAITING / other), not exit code. Capture conversation ID.
5. Detect permission soft-denials in stderr/tool events: a run that exits zero after a required tool was denied normalizes to `waiting_input` or `failed` unless stage validation independently proves completion.

## agy-specific fixtures

SUCCESS, ERROR, WAITING, CANCELED, malformed stream, absent result, zero-exit soft-denial.

## Done when

- [ ] Shared checklist complete for providerId `agy`.
- [ ] Zero-exit soft-denial is never `succeeded`.
