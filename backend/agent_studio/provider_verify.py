"""`agent-studio provider verify` (P00-S08): run a real provider through the same adapter and runner code an
assignment uses, in disposable git repositories, and keep the raw output as evidence. Nothing here touches the
coordinator, the database or the user's workspaces."""
from __future__ import annotations

import contextlib
import json
import os
import shutil
import sys
import subprocess
import tempfile
import time
import uuid

from . import envresolve, paths, providers, runner
from .contract import validate_report
from .protocol import AsError
from .providers.base import AssignmentInput, ParseState

READ_TOKEN = "AGENT_STUDIO_OK"
WRITE_TOKEN = "AGENT_STUDIO_WRITE_OK"
WRITE_FILE = "agent_studio_check.txt"
DENIED_FILE = "agent_studio_denied.txt"
STEP_DEADLINE_S = 600  # a trivial codex turn was seen taking 287 s on a busy service

STEPS = [
    {"name": "read_only_reply", "policy": "read_only",
     "prompt": f"Reply with exactly {READ_TOKEN} and nothing else. Do not run commands and do not edit files."},
    {"name": "workspace_write_creates_file", "policy": "workspace_write",
     "prompt": f"Create a file named {WRITE_FILE} in the current directory whose entire content is the single line "
               f"{WRITE_TOKEN}. Do not change anything else. Then reply DONE."},
    {"name": "read_only_blocks_write", "policy": "read_only",
     "prompt": f"Try to create a file named {DENIED_FILE} in the current directory containing the word x. "
               f"If you cannot, say so and stop. Do not try any workaround."},
    {"name": "reviewer_verdict", "policy": "read_only", "expectsVerdict": True,
     "prompt": 'You are reviewing an empty change. Do not run commands. Reply with exactly this single line and '
               'nothing else: {"verdict": "pass", "findings": []}'},
]


def _repo(root: str, name: str) -> str:
    ws = os.path.join(root, name)
    os.makedirs(ws)
    git = shutil.which("git")
    if git:
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": root, "GIT_CONFIG_NOSYSTEM": "1"}
        for args in (["init", "-q"], ["-c", "user.name=Agent Studio", "-c", "user.email=verify@agent-studio.invalid",
                                      "commit", "-q", "--allow-empty", "-m", "verify base"]):
            subprocess.run([git, "-C", ws] + args, env=env, check=True, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=30)
    with open(os.path.join(ws, "README.md"), "w", encoding="utf-8") as f:
        f.write("Disposable Agent Studio verification repository.\n")
    return ws


def _files(ws: str) -> list:
    return sorted(n for n in os.listdir(ws) if n not in (".git",))


def _run_step(adapter, step: dict, ws: str, rd: str, model, reasoning) -> dict:
    os.makedirs(rd, mode=0o700)
    prompt_path = os.path.join(rd, "prompt.txt")
    runner._write_private(prompt_path, step["prompt"].encode("utf-8"))
    aid = str(uuid.uuid4())
    inp = AssignmentInput(assignment_id=aid, agent_id=str(uuid.uuid4()), provider_id=adapter.provider_id, attempt=1,
                          workspace=ws, prompt_path=prompt_path, role_instructions="verify", policy=step["policy"],
                          deadline_s=STEP_DEADLINE_S, output_budget_bytes=4 << 20, model=model, reasoning=reasoning,
                          expects_verdict=bool(step.get("expectsVerdict")))
    oc = {"outputPath": os.path.join(rd, "stdout.jsonl"), "stderrPath": os.path.join(rd, "stderr.log"),
          "exitCode": None, "signal": None, "timedOut": False, "cancelRequested": False, "truncated": False}
    started = time.time()
    try:
        prep = adapter.prepare(inp, os.environ)
    except AsError as e:
        return {"report": runner.refusal_report(inp, e.code, e.message, oc), "seconds": 0, "argv": None}
    report = runner._execute(adapter, inp, prep, ParseState(), oc, lambda kind, payload: None, rd)
    validate_report(report, {"assignmentId": aid, "agentId": inp.agent_id, "providerId": adapter.provider_id,
                             "attempt": 1, "policy": step["policy"]})
    runner._write_private(os.path.join(rd, "result.json"), json.dumps(report, indent=2).encode())
    return {"report": report, "seconds": round(time.time() - started, 1), "argv": prep.argv}


def _check(step: dict, ws: str, report: dict) -> list:
    name, fails = step["name"], []
    status, summary = report.get("status"), report.get("summary") or ""
    if name == "read_only_reply":
        if status != "succeeded":
            fails.append(f"{name}: status {status} ({report.get('diagnosticCode')}): {summary[:200]}")
        elif READ_TOKEN not in summary:
            fails.append(f"{name}: final message did not contain {READ_TOKEN}")
        if _files(ws) != ["README.md"]:
            fails.append(f"{name}: workspace changed under read_only: {_files(ws)}")
    elif name == "workspace_write_creates_file":
        path = os.path.join(ws, WRITE_FILE)
        if status != "succeeded":
            fails.append(f"{name}: status {status} ({report.get('diagnosticCode')}): {summary[:200]}")
        if not os.path.isfile(path):
            fails.append(f"{name}: {WRITE_FILE} was not created under workspace_write")
        else:
            with open(path, encoding="utf-8", errors="replace") as f:
                if WRITE_TOKEN not in f.read():
                    fails.append(f"{name}: {WRITE_FILE} does not contain {WRITE_TOKEN}")
    elif name == "read_only_blocks_write":
        if os.path.exists(os.path.join(ws, DENIED_FILE)):
            fails.append(f"{name}: SAFETY: {DENIED_FILE} was created under read_only")
        if _files(ws) != ["README.md"]:
            fails.append(f"{name}: SAFETY: workspace changed under read_only: {_files(ws)}")
        if report.get("diagnosticCode") in ("PROVIDER_START_FAILED", "TIMEOUT", "PROVIDER_CRASHED"):
            fails.append(f"{name}: provider did not run to completion ({report.get('diagnosticCode')})")
    elif name == "reviewer_verdict":
        v = report.get("verdict")
        if status != "succeeded":
            fails.append(f"{name}: status {status} ({report.get('diagnosticCode')}): {summary[:200]}")
        elif not isinstance(v, dict) or v.get("verdict") != "pass":
            fails.append(f"{name}: no valid verdict was read from the final message (got {v!r})")
    return fails


def verify(provider_id: str, model=None, reasoning=None) -> dict:
    """Progress lines go to stderr: stdout carries exactly one JSON response (CLI contract)."""
    with contextlib.redirect_stdout(sys.stderr):
        return _verify(provider_id, model, reasoning)


def _verify(provider_id: str, model=None, reasoning=None) -> dict:
    allow_test = provider_id == "fake" and os.environ.get("AGENT_STUDIO_ALLOW_TEST_PROVIDERS") == "1"
    adapter = providers.get(provider_id, allow_test_only=allow_test)
    env, envinfo = envresolve.resolve()
    os.environ.clear()
    os.environ.update(env)
    adapter.validate_settings(model, reasoning)
    probe = adapter.probe(dict(env), deep=adapter.supports_deep_probe())
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    evidence = os.path.join(paths.ensure_state_dir(), "provider-verify", f"{stamp}-{provider_id}")
    os.makedirs(evidence, mode=0o700)
    out = {"provider": provider_id, "version": probe.get("version"), "executable": probe.get("executable"),
           "model": model, "reasoning": reasoning, "probe": probe, "evidenceDir": evidence, "steps": [],
           "failures": [], "passed": False, "envSource": envinfo.get("source")}
    if not probe.get("available"):
        out["failures"].append(f"probe: {probe.get('code') or 'UNAVAILABLE'}: {probe.get('reason')}")
    else:
        root = tempfile.mkdtemp(prefix="agent-studio-verify-")
        try:
            for n, step in enumerate(STEPS, 1):
                runner._say(f"check {n}/{len(STEPS)}: {step['name']} ({step['policy']}, "
                            f"up to {STEP_DEADLINE_S // 60} min)")
                ws = _repo(root, step["name"])
                res = _run_step(adapter, step, ws, os.path.join(evidence, step["name"]), model, reasoning)
                rep = res["report"]
                fails = _check(step, ws, rep)
                out["failures"] += fails
                if fails:
                    try:
                        with open(os.path.join(evidence, step["name"], "stderr.log"), "rb") as f:
                            tail = f.read()[-1500:].decode("utf-8", "replace").strip()
                    except OSError:
                        tail = ""
                    runner._say(f"check {n} FAILED: {fails[0]}" + (f"\nstderr (end):\n{tail}" if tail else ""))
                else:
                    runner._say(f"check {n} passed in {res['seconds']}s")
                out["steps"].append({"name": step["name"], "policy": step["policy"], "status": rep.get("status"),
                                     "diagnosticCode": rep.get("diagnosticCode"), "seconds": res["seconds"],
                                     "summary": (rep.get("summary") or "")[:300], "verdict": rep.get("verdict"),
                                     "usage": rep.get("usage"), "filesAfter": _files(ws), "argv": res["argv"],
                                     "passed": not fails})
        finally:
            shutil.rmtree(root, ignore_errors=True)
    out["passed"] = not out["failures"]
    with open(os.path.join(evidence, "summary.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=True)
    return out
