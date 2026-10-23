"""Provider adapter contract (P00-S04). Every provider - the four real CLIs and the test-only fake - implements
this one interface. The runner and coordinator only ever see these types and the normalized report.

Operations: probe, prepare, start (done by the runner via Prepared), parse_line, finalize, cancel, reconcile.
Success rules live in `finalize` here, so all providers are judged the same way; an adapter only translates
its CLI's output into ParseState.
"""
from __future__ import annotations

import json
import os
import re
import signal
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from .. import procid  # noqa: F401  (kept for adapters)
from ..protocol import AsError

POLICIES = ("read_only", "workspace_write")
STATUSES = ("succeeded", "failed", "cancelled", "waiting_input", "inconclusive")
UNSUPPORTED = "unsupported"
REPORT_PROTOCOL = "agent-studio/assignment/v1"
POLICY_UNSUPPORTED = "POLICY_UNSUPPORTED"
PROVIDER_UNAVAILABLE = "PROVIDER_UNAVAILABLE"
SETTING_UNSUPPORTED = "SETTING_UNSUPPORTED"
MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$")

# Environment variables a provider may receive. Anything else (tokens in random variables, our own
# AGENT_STUDIO_* settings, the caller's TMUX) is dropped unless an adapter explicitly adds it.
BASE_ENV = ("PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR",
            "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR")

CAPABILITY_FIELDS = ("headless", "structuredProgress", "structuredFinal", "resume", "interactiveInput")


@dataclass
class AssignmentInput:
    assignment_id: str
    agent_id: str
    provider_id: str
    attempt: int
    workspace: str
    prompt_path: str
    role_instructions: str
    policy: str
    deadline_s: float
    output_budget_bytes: int
    model: Optional[str] = None
    reasoning: Optional[str] = None
    provider_session_id: Optional[str] = None
    options: dict = field(default_factory=dict)  # provider-specific, validated by the adapter
    expects_verdict: bool = False                # reviewer stages: read a verdict from the final message


@dataclass
class Prepared:
    argv: List[str]
    env_allowlist: Tuple[str, ...]
    stdin_path: Optional[str]
    cwd: str
    extra_env: Dict[str, str] = field(default_factory=dict)

    def __post_init__(self):
        if not self.argv or not all(isinstance(a, str) and "\x00" not in a for a in self.argv):
            raise AsError("BAD_ADAPTER", "prepare() must return a non-empty argv of strings.")
        if not os.path.isabs(self.argv[0]):
            raise AsError("BAD_ADAPTER", "argv[0] must be an absolute executable path (no PATH or shell lookup).")
        if not all(isinstance(k, str) and isinstance(v, str) for k, v in self.extra_env.items()):
            raise AsError("BAD_ADAPTER", "extra_env must map strings to strings.")

    def environment(self, source: Optional[dict] = None) -> Dict[str, str]:
        source = os.environ if source is None else source
        env = {k: source[k] for k in self.env_allowlist if k in source}
        env.update(self.extra_env)
        return env


MISSING = object()


@dataclass
class ParseState:
    session_id: Optional[str] = None
    terminal: Optional[dict] = None          # {"ok": bool, "summary": str, "code"/"limitResetAt": optional}
    denials: List[str] = field(default_factory=list)
    input_requests: List[str] = field(default_factory=list)
    malformed: int = 0
    verdict: object = MISSING
    usage: Optional[dict] = None
    events: int = 0
    final_text: Optional[str] = None          # the provider's last message, when it has one
    extra: dict = field(default_factory=dict)  # adapter-private parsing state


def extract_verdict(text: Optional[str]):
    """Find a reviewer verdict in free text: the last line (or fenced block) that parses as a JSON object with a
    "verdict" key. Returns the object or None. Never evaluates anything."""
    if not text:
        return None
    candidates = [l.strip().strip("`").strip() for l in text.strip().splitlines()]
    for blob in reversed(candidates):
        if blob.startswith("{") and '"verdict"' in blob:
            try:
                obj = json.loads(blob)
            except ValueError:
                continue
            if isinstance(obj, dict) and "verdict" in obj:
                return obj
    return None


FINAL_TEXT_LIMIT = 24 * 1024  # bytes of escaped JSON, so the report stays inside the 64 KiB event payload limit


def bounded_text(text: Optional[str], limit: int = FINAL_TEXT_LIMIT) -> Optional[str]:
    """The agent's last message, cut (with a marker) so its ASCII-escaped JSON form fits in `limit` bytes."""
    if not text:
        return None
    if len(json.dumps(text)) <= limit:
        return text
    marker = "\n[... cut by Agent Studio; the full text is in the run's output file]"
    room = limit - len(json.dumps(marker)) + 2  # the two quotes are counted once
    lo, hi = 0, len(text)
    while lo < hi:  # longest prefix whose escaped form fits, leaving room for the marker
        mid = (lo + hi + 1) // 2
        if len(json.dumps(text[:mid])) <= room:
            lo = mid
        else:
            hi = mid - 1
    return text[:lo] + marker


def valid_verdict(v) -> bool:
    return (isinstance(v, dict) and v.get("verdict") in ("pass", "fail") and isinstance(v.get("findings", []), list)
            and all(isinstance(f, str) for f in v.get("findings", [])))


class Adapter:
    provider_id = "base"
    test_only = False

    # ---- capability + policy declaration -------------------------------------------------------
    def capabilities(self) -> dict:
        return {f: UNSUPPORTED for f in CAPABILITY_FIELDS}

    def policy_mapping(self) -> Dict[str, Optional[List[str]]]:
        """policy -> the exact provider flags used, or None when unsupported (then the policy is refused)."""
        return {p: None for p in POLICIES}

    def version(self, env: dict) -> Optional[str]:
        return None

    def reasoning_levels(self) -> Tuple[str, ...]:
        """Reasoning levels this adapter can map to a verified provider setting; () when it cannot."""
        return ()

    def model_selectable(self) -> bool:
        return False

    def validate_settings(self, model: Optional[str], reasoning: Optional[str]) -> None:
        if model is not None:
            if not self.model_selectable():
                raise AsError(SETTING_UNSUPPORTED, f"{self.provider_id}: choosing a model is not supported.")
            if not isinstance(model, str) or not MODEL_RE.match(model):
                raise AsError(SETTING_UNSUPPORTED, f"{self.provider_id}: invalid model name {model!r}.")
        if reasoning is not None:
            levels = self.reasoning_levels()
            if reasoning not in levels:
                raise AsError(SETTING_UNSUPPORTED, f"{self.provider_id}: reasoning level {reasoning!r} is not "
                                                   f"supported (supported: {', '.join(levels) or 'none'}).")

    def describe(self, env: dict) -> dict:
        mapping = self.policy_mapping()
        return {"providerId": self.provider_id, "version": self.version(env), "testOnly": self.test_only,
                "capabilities": self.capabilities(), "modelSelectable": self.model_selectable(),
                "reasoningLevels": list(self.reasoning_levels()),
                "policies": {p: (mapping.get(p) if mapping.get(p) is not None else UNSUPPORTED) for p in POLICIES}}

    def probe(self, env: dict, deep: bool = False) -> dict:
        """Real adapters must prove authentication with a disposable read-only task, never by --version alone."""
        return dict(self.describe(env), available=False, reason="probe() not implemented")

    def supports_deep_probe(self) -> bool:
        return False

    # ---- execution -----------------------------------------------------------------------------
    def prepare(self, inp: AssignmentInput, env: dict) -> Prepared:
        if inp.policy not in POLICIES:
            raise AsError(POLICY_UNSUPPORTED, f"Unknown policy {inp.policy!r}.")
        if self.policy_mapping().get(inp.policy) is None:
            raise AsError(POLICY_UNSUPPORTED, f"{self.provider_id} has no verified mapping for policy "
                                              f"{inp.policy!r}; refusing rather than guessing or broadening.")
        return self._prepare(inp, env)

    def _prepare(self, inp: AssignmentInput, env: dict) -> Prepared:
        raise AsError(PROVIDER_UNAVAILABLE, f"{self.provider_id} cannot run assignments yet.")

    def parse_line(self, line: bytes, state: ParseState) -> List[Tuple[str, object]]:
        """Translate one raw output line into state updates. Return display events for the pane:
        ("progress", message) or ("attention", message). Never raises on bad input; count it as malformed."""
        return []

    # ---- outcome (shared rules) -----------------------------------------------------------------
    def finalize(self, inp: AssignmentInput, st: ParseState, oc: dict) -> dict:
        """oc: exitCode, signal, timedOut, cancelRequested, truncated, outputPath, stderrPath."""
        term, attention, code = st.terminal, None, None
        if st.verdict is MISSING and inp.expects_verdict and term is not None and term.get("ok"):
            found = extract_verdict(st.final_text)
            if found is not None:
                st.verdict = found
        verdict = None if st.verdict is MISSING else st.verdict
        if oc.get("cancelRequested"):
            status, code = "cancelled", "CANCELLED"
        elif oc.get("timedOut"):
            status, code = "failed", "TIMEOUT"
        elif term is not None and not term.get("ok"):
            status, code = "failed", term.get("code") or "PROVIDER_ERROR"
        elif term is not None:
            if st.denials:
                status, code = "waiting_input", "PERMISSION_DENIED"
                attention = {"kind": "permission_denied", "items": st.denials[:10]}
            elif oc.get("signal") is not None or oc.get("exitCode") != 0:
                status, code = "inconclusive", "CONTRADICTORY_EVIDENCE"
            elif verdict is not None and not valid_verdict(verdict):
                status, code = "inconclusive", "MALFORMED_VERDICT"
            else:
                status = "succeeded"
        elif st.input_requests:
            status, code = "waiting_input", "INPUT_REQUIRED"
            attention = {"kind": "input_required", "items": st.input_requests[:10]}
        elif st.denials:
            status, code = "waiting_input", "PERMISSION_DENIED"
            attention = {"kind": "permission_denied", "items": st.denials[:10]}
        elif oc.get("signal") is not None:
            status, code = "failed", "PROVIDER_CRASHED"
        elif st.malformed:
            status, code = "inconclusive", "MALFORMED_OUTPUT"
        elif oc.get("exitCode") == 0:
            status, code = "inconclusive", "NO_TERMINAL_EVENT"
        else:
            status, code = "failed", f"PROVIDER_EXIT_{oc.get('exitCode')}"
        summary = (term or {}).get("summary") or {
            "CANCELLED": "Cancelled on request.", "TIMEOUT": "Stopped at the deadline.",
            "PROVIDER_CRASHED": "The provider process died without a final result.",
            "NO_TERMINAL_EVENT": "The provider exited without a final result.",
            "MALFORMED_OUTPUT": "The provider output could not be parsed.",
            "INPUT_REQUIRED": "The provider asked for input, which headless mode cannot give.",
        }.get(code, code or "")
        report = {
            "protocol": REPORT_PROTOCOL, "assignmentId": inp.assignment_id, "agentId": inp.agent_id,
            "providerId": inp.provider_id, "attempt": inp.attempt, "policy": inp.policy, "status": status,
            "exitCode": oc.get("exitCode"), "summary": str(summary)[:2000], "finalText": bounded_text(st.final_text),
            "artifacts": [], "attention": attention,
            "diagnosticCode": code, "providerSessionId": st.session_id, "usage": st.usage,
            "verdict": verdict if verdict is None or valid_verdict(verdict) else {"malformed": True},
            "evidence": {"outputPath": oc.get("outputPath"), "stderrPath": oc.get("stderrPath"),
                         "providerTerminalEvent": term is not None, "terminalOk": bool(term and term.get("ok")),
                         "signal": oc.get("signal"), "timedOut": bool(oc.get("timedOut")),
                         "cancelRequested": bool(oc.get("cancelRequested")), "truncated": bool(oc.get("truncated")),
                         "malformedLines": st.malformed, "validation": []},
        }
        if term is not None and "limitResetAt" in term:
            report["limitResetAt"] = term["limitResetAt"]
        return report

    # ---- control -------------------------------------------------------------------------------
    def cancel(self, ident: dict, sig: int = signal.SIGTERM) -> bool:
        """Signal only the recorded process group, and only if the identity still matches."""
        from .. import procid as p
        if not p.matches(ident):
            return False
        try:
            os.killpg(ident["pid"], sig)
            return True
        except ProcessLookupError:
            return False

    def reconcile(self, ident: Optional[dict], evidence_dir: str) -> dict:
        """running | terminal (with the saved report) | uncertain. Never re-dispatches anything."""
        from .. import procid as p
        result = os.path.join(evidence_dir, "result.json")
        if os.path.exists(result):
            with open(result, encoding="utf-8") as f:
                return {"state": "terminal", "report": json.load(f)}
        if ident and p.matches(ident):
            return {"state": "running"}
        return {"state": "uncertain", "reason": "no saved result and the recorded process is gone"}


class NotImplementedAdapter(Adapter):
    """Honest placeholder until the provider's own story (S08-S11) verifies its installed CLI."""

    def __init__(self, provider_id: str, story: str):
        self.provider_id = provider_id
        self.story = story

    def probe(self, env: dict, deep: bool = False) -> dict:
        return dict(self.describe(env), available=False,
                    reason=f"The {self.provider_id} adapter is not implemented yet ({self.story}).")
