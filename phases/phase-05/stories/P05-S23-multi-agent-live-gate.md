# P05-S23 — Multi-agent Teams accessibility and live gate

Status: To Do
Depends on: P05-S21, P05-S22, T-047 (not yet merged)
Architecture: [Multi-agent member options](../README.md#multi-agent-member-options--t-048)

## Goal
Validate multi-agent Teams accessibility and extend the T-047 Windows Electron plus WSL live-gate evidence.

## Implement in this order
1. Run full backend and app suites, typecheck and build. Add `app/test/teamsMultiAgentA11y.test.tsx` and relevant style assertions at 1280px and the existing supported narrow breakpoint, extending T-047's completed baseline audit.
2. Operator check: in Windows Electron connected to the real WSL backend, configure two real catalog options, reorder/save, start the team, switch idle without restart, confirm busy cancellation on a disposable ticket and observe recovery. Record a quota hold if a safe real-provider limit fixture is unavailable, resume the inactive hold, restart and verify selection/holds. Capture screenshots and backend events.
3. A real usage-limit claim requires a real provider response; otherwise record that portion as not exercised. Mocks do not prove a real provider.

## Done when
- [ ] Automated accessibility and responsive tests cover keyboard controls, labels, focus and narrow layout, and the full suites pass.
- [ ] Operator evidence records the Windows/WSL checks and any unexercised real quota behavior; T-047 supplies baseline evidence, not a callable interface.
- [ ] Run the applicable checks below; integration and live checks use the appropriate environment.

## Project validation commands
- `python3 -m unittest tests.unit.test_member_agent_switch tests.unit.test_p05_s10_management_read_model tests.unit.test_p04_s10_scheduler`
- `python3 -m unittest tests.integration.test_member_agent_switch`
- `python3 -m unittest discover -s tests -t .`
- `npm --prefix app test`
- `npm --prefix app run typecheck`
- `npm --prefix app run build`

## Evidence
(filled in when the story is done: commands run, results, links to evidence files)
