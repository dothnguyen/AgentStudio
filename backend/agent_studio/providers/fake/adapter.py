"""Fake provider adapter (test-only). Drives fake_cli.py through exactly the same runner path as a real CLI."""
from __future__ import annotations

import json
import os
import re
import sys
from typing import Dict, List, Optional

from ...protocol import AsError
from ..base import BASE_ENV, POLICIES, UNSUPPORTED, Adapter, AssignmentInput, ParseState, Prepared
from .fake_cli import SCENARIOS

FAKE_CLI = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fake_cli.py")
SANDBOX = {"read_only": "read-only", "workspace_write": "workspace-write"}
SAFE_REL = re.compile(r"^(?!/)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$")


class FakeAdapter(Adapter):
    provider_id = "fake"
    test_only = True

    def capabilities(self) -> dict:
        return {"headless": True, "structuredProgress": True, "structuredFinal": True, "resume": UNSUPPORTED,
                "interactiveInput": UNSUPPORTED}

    def policy_mapping(self) -> Dict[str, Optional[List[str]]]:
        # Tests can narrow the supported set to exercise refusal: AGENT_STUDIO_FAKE_POLICIES=read_only
        allowed = os.environ.get("AGENT_STUDIO_FAKE_POLICIES")
        allowed = set(allowed.split(",")) if allowed else set(POLICIES)
        return {p: (["--sandbox", SANDBOX[p]] if p in allowed else None) for p in POLICIES}

    def version(self, env: dict) -> str:
        return "fake 1.0 (test-only)"

    def probe(self, env: dict) -> dict:
        return dict(self.describe(env), available=True, executable=FAKE_CLI, authenticated=True)

    def _prepare(self, inp: AssignmentInput, env: dict) -> Prepared:
        o = inp.options or {}
        scenario = o.get("scenario", "success")
        if scenario not in SCENARIOS:
            raise AsError("BAD_REQUEST", f"Unknown fake scenario {scenario!r}.")
        duration = o.get("durationMs", 1000)
        lines = o.get("progressLines", 3)
        for name, v, hi in (("durationMs", duration, 600000), ("progressLines", lines, 100000)):
            if isinstance(v, bool) or not isinstance(v, int) or not 0 <= v <= hi:
                raise AsError("BAD_REQUEST", f"fake {name} must be an integer 0..{hi}.")
        argv = [sys.executable, "-I", FAKE_CLI, "--scenario", scenario] + self.policy_mapping()[inp.policy] + \
               ["--duration-ms", str(duration), "--lines", str(lines)]
        write = o.get("writeFile")
        if write is not None:
            if not isinstance(write, str) or not SAFE_REL.match(write):
                raise AsError("BAD_REQUEST", "fake writeFile must be a relative path inside the workspace.")
            argv += ["--write", write]
        return Prepared(argv=argv, env_allowlist=BASE_ENV, stdin_path=inp.prompt_path, cwd=inp.workspace)

    def parse_line(self, line: bytes, state: ParseState):
        state.events += 1
        try:
            ev = json.loads(line.decode("utf-8"))
            if not isinstance(ev, dict):
                raise ValueError
        except (UnicodeDecodeError, ValueError):
            state.malformed += 1
            return [("attention", "unparseable provider output line")]
        t = ev.get("type")
        if t == "init":
            state.session_id = str(ev.get("session"))[:100]
            return [("progress", f"session {state.session_id} (sandbox {ev.get('sandbox')})")]
        if t == "progress":
            return [("progress", str(ev.get("message", "")))]
        if t == "file_written":
            return [("progress", f"wrote {ev.get('path')}")]
        if t == "tool_denied":
            item = f"{ev.get('tool')}: {ev.get('path') or ev.get('command') or ''}".strip()
            state.denials.append(item[:200])
            return [("attention", f"permission denied - {item}")]
        if t == "input_required":
            state.input_requests.append(str(ev.get("question", ""))[:500])
            return [("attention", f"provider asks: {ev.get('question')}")]
        if t == "result":
            ok = ev.get("status") == "success"
            state.terminal = {"ok": ok, "summary": str(ev.get("summary", ""))[:2000],
                              "code": None if ok else "PROVIDER_ERROR"}
            if "verdict" in ev:
                state.verdict = ev["verdict"]
            if isinstance(ev.get("usage"), dict):
                state.usage = {k: v for k, v in ev["usage"].items() if isinstance(v, int)}
            return [("progress", f"provider result: {ev.get('status')}")]
        return []
