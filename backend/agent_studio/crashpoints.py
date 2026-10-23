"""Test-only crash points for the S07 failure drills.

A DEBUG coordinator started with AGENT_STUDIO_TEST_CRASH_AT=<name> dies with os._exit(137) the first time it
reaches that point (a marker file in the state directory makes it one-shot), exactly as if it had been killed
there. Production coordinators never read the variable.
"""
import os

POINTS = ("before_command_commit", "after_command_commit", "after_claim_commit", "before_report_apply_commit",
          "before_route_commit", "after_advance_commit", "after_verdict_before_route", "while_validating",
          "after_validator_spawn", "before_outcome_apply", "after_outcome_git_commit", "after_outcome_commit")
_ctx = {"debug": False, "stateDir": None}


def configure(debug: bool, state_dir: str) -> None:
    _ctx.update(debug=debug, stateDir=state_dir)


def hit(name: str) -> None:
    if not _ctx["debug"] or os.environ.get("AGENT_STUDIO_TEST_CRASH_AT") != name:
        return
    marker = os.path.join(_ctx["stateDir"], f"crashed-at-{name}")
    if os.path.exists(marker):
        return
    open(marker, "w").close()
    os._exit(137)
