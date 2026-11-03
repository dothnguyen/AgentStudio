"""What a board ticket waiting for input shows (needsInput); shared by boardmodel, teamview and workflow."""
from __future__ import annotations

import json

QUESTION_LIMIT = 500
DEFAULT_QUESTION = "The agent is waiting for input."


def input_question(result) -> str:
    """The question the agent asked, from its report's attention items, else its summary."""
    if not isinstance(result, dict):
        result = {}
    att = result.get("attention")
    items = []
    if isinstance(att, dict):
        items = [str(x) for x in (att.get("items") or []) if str(x).strip()]
    if items:
        text = "; ".join(items)
        if att.get("kind") == "permission_denied":
            text = "Permission denied: " + text
    else:
        text = str(result.get("summary") or "").strip() or DEFAULT_QUESTION
    return text[:QUESTION_LIMIT]


def needs_input(status, result_json, since):
    """`{"question", "since"}` for a waiting assignment, else None."""
    if status != "waiting_input":
        return None
    result = {}
    if isinstance(result_json, str) and result_json:
        try:
            result = json.loads(result_json)
        except ValueError:
            result = {}
    if not isinstance(result, dict):
        result = {}
    return {"question": input_question(result), "since": since}
