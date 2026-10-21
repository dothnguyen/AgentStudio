"""Make text safe to print into a terminal pane (no escape sequences or other control characters)."""
import re

_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f  ‪-‮⁦-⁩]")


def terminal_safe(text: str, limit: int = 2000) -> str:
    text = _CONTROL.sub("\N{REPLACEMENT CHARACTER}", text.replace("\r\n", "\n").replace("\t", "    "))
    return text if len(text) <= limit else text[:limit] + " ..."


def one_line(text: str, limit: int = 200) -> str:
    return terminal_safe(text.replace("\n", " "), limit)
