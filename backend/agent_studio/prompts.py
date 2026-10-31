"""Stage prompt rendering (P01-S03). Design contract: phases/phase-01/README.md section C.

    placeholders(template)  -> the set of {{name}} names a template mentions
    render(template, ...)   -> the final stage prompt

Everything the renderer inserts is data for the provider. Expansion is a single pass over the template, so text inside
the data (task, diff, findings ...) is never expanded again, executed, or put on a command line.
"""
from __future__ import annotations

import re
from typing import Iterable, Optional, Union

PROMPT_LIMITS = {"task": 32 * 1024, "diff": 256 * 1024, "validation": 32 * 1024, "findings": 16 * 1024,
                 "summary": 16 * 1024, "delegated_commands": 16 * 1024, "delegated": 32 * 1024}

DATA_PLACEHOLDERS = ("task", "diff", "validation", "findings", "summary", "delegated_commands")
INLINE_PLACEHOLDERS = ("stage", "visit")
ALLOWED = frozenset(DATA_PLACEHOLDERS + INLINE_PLACEHOLDERS)

EMPTY = {"task": "(none)", "diff": "(no changes)", "validation": "(not run yet)", "findings": "(none)",
         "summary": "(none)", "delegated_commands": "(no delegated commands are available to this stage)"}

# The fixed footer of every verdict stage: the contract P00 already parses (providers.base.extract_verdict).
VERDICT_FOOTER = (
    "End your reply with exactly one line of\n"
    "JSON: {\"verdict\": \"pass\" or \"fail\", \"findings\": [\"...\"]}. Use \"fail\" for anything that must change.\n")

KINDS = ("work", "verdict")

_PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")


def placeholders(template: str) -> set:
    """Every {{name}} (inner spaces allowed) the template mentions, allowed or not."""
    return {m.group(1) for m in _PLACEHOLDER.finditer(template)}


def section(name: str, text: str, limit: int) -> str:
    """One bounded data section. Over-limit text is cut at a character boundary with the P00 truncation note."""
    data = text.encode("utf-8", "replace")
    note = ""
    if len(data) > limit:
        text = data[:limit].decode("utf-8", "ignore")
        note = f"\n[{name} truncated by Agent Studio at {limit} bytes]"
    return f"\n===== {name} =====\n{text}{note}\n===== END {name} =====\n"


def _lines(findings: Union[None, str, Iterable[str]]) -> str:
    if findings is None:
        return ""
    if isinstance(findings, str):
        return findings
    return "\n".join(f"- {f}" for f in findings)


def render(template: str, *, kind: str, task: str, diff: Optional[str] = None, validation: Optional[str] = None,
           findings: Union[None, str, Iterable[str]] = None, summary: Optional[str] = None, stage: str,
           visit: int, delegated_commands: Optional[str] = None) -> str:
    """Template with its placeholders filled, the TASK section when the template has none, and the verdict footer
    on verdict stages. A stage that may delegate commands (P06) gets the DELEGATED_COMMANDS section even when its
    template has no {{delegated_commands}}, so an agent always learns what it may ask for. Raises ValueError for an unknown kind or placeholder (the loader rejects those earlier)."""
    if kind not in KINDS:
        raise ValueError(f"unknown prompt kind {kind!r}")
    names = placeholders(template)
    unknown = sorted(names - ALLOWED)
    if unknown:
        raise ValueError(f"unknown placeholder {{{{{unknown[0]}}}}}")
    values = {
        "task": task if task else EMPTY["task"],
        "diff": diff or EMPTY["diff"],
        "validation": validation or EMPTY["validation"],
        "findings": _lines(findings) or EMPTY["findings"],
        "summary": summary or EMPTY["summary"],
        "delegated_commands": delegated_commands or EMPTY["delegated_commands"],
    }

    def fill(m: "re.Match") -> str:
        name = m.group(1)
        if name == "stage":
            return str(stage)
        if name == "visit":
            return str(visit)
        return section(name.upper(), values[name], PROMPT_LIMITS[name])

    out = _PLACEHOLDER.sub(fill, template)
    if "task" not in names:
        if out and not out.endswith("\n"):
            out += "\n"
        out += section("TASK", values["task"], PROMPT_LIMITS["task"])
    if delegated_commands and "delegated_commands" not in names:
        out += section("DELEGATED_COMMANDS", delegated_commands, PROMPT_LIMITS["delegated_commands"])
    if kind == "verdict":
        out += "\n" + VERDICT_FOOTER
    return out


def resume_prompt(original: str, delegated: str, summary: Optional[str]) -> str:
    """The prompt of a stage re-dispatched after delegated commands ran (P06): the attempt's original prompt, the
    summary the agent left, and the commands' results. Appended as data sections, never expanded."""
    out = original if original.endswith("\n") else original + "\n"
    out += ("\nThis is a continuation. Your previous attempt at this stage asked the Agent Studio coordinator to run "
            "delegated commands and ended its turn. The workspace is as you left it. Continue the task from where you "
            "stopped, using the results below; do not repeat finished work.\n")
    out += section("PREVIOUS_SUMMARY", summary or EMPTY["summary"], PROMPT_LIMITS["summary"])
    out += section("DELEGATED", delegated, PROMPT_LIMITS["delegated"])
    return out
