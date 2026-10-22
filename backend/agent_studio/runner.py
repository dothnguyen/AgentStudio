"""Assignment runner: started by the worker shim in the foreground of the agent's tmux pane.

For one assignment it: reads the coordinator-written request; reports start evidence (its own PID + start time
+ boot ID, plus the provider's version, capabilities and policy mapping); writes a private prompt file; asks the
provider adapter to `prepare` an argv (never a shell string); runs the provider in its own process group with
a deadline and an output budget; saves raw stdout/stderr and metadata as private evidence; prints readable
progress to the pane; and submits an immutable, validated final report. It never changes state itself, and it
keeps working while the coordinator is down (reports wait in the inbox).

Signals: SIGTERM/SIGHUP/SIGINT to the runner are a cancellation request - the provider's process group is
terminated and the report says `cancelled`. If the runner itself is killed, the kernel kills the provider too
(PR_SET_PDEATHSIG), so no orphaned CLI keeps editing the workspace.
"""
from __future__ import annotations

import ctypes
import json
import os
import select
import signal
import subprocess
import sys
import threading
import time

from . import contract, paths, procid, providers, reports, state
from .protocol import AsError
from .providers.base import REPORT_PROTOCOL, AssignmentInput, ParseState
from .store import validate_uuid
from .textsafe import one_line

FINAL_STATUSES = ("succeeded", "failed", "cancelled", "waiting_input", "inconclusive")
DEFAULT_DEADLINE_MS = 30 * 60 * 1000
MAX_DEADLINE_MS = 6 * 3600 * 1000
DEFAULT_BUDGET = 4 * 1024 * 1024
MAX_BUDGET = 64 * 1024 * 1024
MAX_LINE = 1024 * 1024
STDERR_CAP = 256 * 1024
MAX_PROGRESS_REPORTS = 200
PROGRESS_REPORT_INTERVAL_S = 0.5
KILL_GRACE_S = 3.0


def request_path(state_dir: str, agent_id: str, assignment_id: str, box: str = "active") -> str:
    return os.path.join(state_dir, "agents", agent_id, box, f"{assignment_id}.request")


def run_dir(state_dir: str, assignment_id: str) -> str:
    return os.path.join(state_dir, "runs", assignment_id)


def _say(msg: str) -> None:
    try:
        sys.stdout.write(f"[{time.strftime('%H:%M:%S')}] {msg}\n")
        sys.stdout.flush()
    except (OSError, ValueError):
        pass  # the pane may already be gone (tmux session killed); evidence and reports still go out


def _write_private(path: str, data: bytes) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)


def _child_setup() -> None:  # runs in the child between fork and exec
    os.setpgrp()  # own process group: cancel signals the whole provider tree and nothing else
    try:
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        libc.prctl(1, signal.SIGKILL)  # PR_SET_PDEATHSIG: die if the runner dies
    except Exception:
        pass


def _clamp(value, default, lo, hi) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        return default
    return max(lo, min(hi, value))


CANCEL_MARKER = "cancel.requested"  # written by the coordinator's assignment.cancel


def refusal_report(inp: AssignmentInput, code: str, summary: str, oc: dict, status: str = "failed") -> dict:
    return {"protocol": REPORT_PROTOCOL, "assignmentId": inp.assignment_id, "agentId": inp.agent_id,
            "providerId": inp.provider_id, "attempt": inp.attempt, "policy": inp.policy, "status": status,
            "exitCode": None, "summary": summary[:2000], "artifacts": [], "attention": None, "diagnosticCode": code,
            "providerSessionId": None, "usage": None, "verdict": None,
            "evidence": {"outputPath": None, "stderrPath": None, "providerTerminalEvent": False, "terminalOk": False,
                         "signal": None, "timedOut": False, "cancelRequested": status == "cancelled",
                         "truncated": False, "malformedLines": 0, "validation": []}}


def workspace_fingerprint(workspace: str):
    """A hash of everything git can see changing in the workspace (HEAD, tracked diff, untracked file contents), or
    None when it is not a git checkout. Ignored files (caches, __pycache__) are not part of it."""
    import hashlib
    from . import gitws
    try:
        h = hashlib.sha256()
        h.update(gitws.run(workspace, "rev-parse", "HEAD", check=False).stdout)
        h.update(gitws.run(workspace, "diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--",
                           check=False).stdout)
        for rel in sorted(gitws.untracked(workspace)):
            path = os.path.join(workspace, rel)
            h.update(rel.encode("utf-8", "surrogateescape") + b"\0")
            try:
                if os.path.isfile(path) and not os.path.islink(path) and os.path.getsize(path) <= 8 * 1024 * 1024:
                    with open(path, "rb") as f:
                        h.update(hashlib.sha256(f.read()).digest())
            except OSError:
                pass
        return h.hexdigest()
    except Exception:
        return None


def guard_violation(adapter, inp, before, final: dict) -> dict:
    """read_only stages on an adapter whose sandbox is looser than read-only: fail the report when the workspace
    changed. Nothing is reverted; the operator decides (git status / git diff show what changed)."""
    if before is None or final.get("status") in ("cancelled",):
        return final
    after = workspace_fingerprint(inp.workspace)
    if after is None or after == before:
        return final
    return dict(final, status="failed", diagnosticCode="READ_ONLY_VIOLATION",
                summary=("A read-only stage changed files in the workspace (check git status / git diff). "
                         + str(final.get("summary") or ""))[:2000])


class _Cancel:
    requested = False
    signame = None


def _execute(adapter, inp, prep, st: ParseState, oc: dict, report, rd: str) -> dict:
    cancel = _Cancel()

    def on_signal(signum, frame):
        cancel.requested = True
        cancel.signame = signal.Signals(signum).name

    for s in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(s, on_signal)

    stdin = open(prep.stdin_path, "rb") if prep.stdin_path else subprocess.DEVNULL
    try:
        proc = subprocess.Popen(prep.argv, stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                cwd=prep.cwd, env=prep.environment(), preexec_fn=_child_setup, close_fds=True)
    except OSError as e:
        return refusal_report(inp, "PROVIDER_START_FAILED", f"The provider could not be started: {e.strerror}.", oc)
    finally:
        if stdin is not subprocess.DEVNULL:
            stdin.close()
    pident = procid.identity(proc.pid)
    meta = {"argv": prep.argv, "cwd": prep.cwd, "envKeys": sorted(prep.environment()), "providerProcess": pident,
            "deadlineSeconds": inp.deadline_s, "outputBudgetBytes": inp.output_budget_bytes}
    _write_private(os.path.join(rd, "meta.json"), json.dumps(meta, ensure_ascii=True, indent=2).encode())
    report("progress", {"message": "provider process started", "providerProcess": pident})
    _say(f"provider started (pid {proc.pid})")

    err_f = os.open(oc["stderrPath"], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)

    def drain_stderr():
        kept = 0
        for chunk in iter(lambda: proc.stderr.read(65536), b""):
            if kept < STDERR_CAP:
                piece = chunk[:STDERR_CAP - kept]
                os.write(err_f, piece)
                kept += len(piece)
        os.close(err_f)

    t = threading.Thread(target=drain_stderr, daemon=True)
    t.start()

    out_f = os.open(oc["outputPath"], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    written = 0
    sent = {"n": 0, "last": 0.0}

    def handle_line(line: bytes):
        nonlocal written
        if written < inp.output_budget_bytes:
            piece = (line + b"\n")[:inp.output_budget_bytes - written]
            os.write(out_f, piece)
            written += len(piece)
            if len(piece) < len(line) + 1:
                oc["truncated"] = True
        else:
            oc["truncated"] = True
        for kind, msg in adapter.parse_line(line, st):
            text = one_line(str(msg), 300)
            _say(("! " if kind == "attention" else "") + text)
            now = time.monotonic()
            if sent["n"] < MAX_PROGRESS_REPORTS and (kind == "attention" or now - sent["last"] >= PROGRESS_REPORT_INTERVAL_S):
                report("attention" if kind == "attention" else "progress", {"message": text})
                sent["n"] += 1
                sent["last"] = now

    def terminate():
        for sig, wait in ((signal.SIGTERM, KILL_GRACE_S), (signal.SIGKILL, KILL_GRACE_S)):
            try:
                os.killpg(proc.pid, sig)
            except ProcessLookupError:
                return
            try:
                proc.wait(timeout=wait)
                return
            except subprocess.TimeoutExpired:
                continue

    marker = os.path.join(rd, CANCEL_MARKER)

    def check_marker():
        if not cancel.requested and os.path.exists(marker):
            cancel.requested = True
            cancel.signame = "cancel request"

    fd = proc.stdout.fileno()
    os.set_blocking(fd, False)
    end = time.monotonic() + inp.deadline_s
    buf = b""
    eof = False
    try:
        while not eof:
            check_marker()
            if cancel.requested:
                oc["cancelRequested"] = True
                _say(f"cancellation requested ({cancel.signame}); stopping the provider")
                terminate()
                break
            remaining = end - time.monotonic()
            if remaining <= 0:
                oc["timedOut"] = True
                _say(f"deadline of {inp.deadline_s:g}s reached; stopping the provider")
                terminate()
                break
            try:
                ready = select.select([fd], [], [], min(0.2, remaining))[0]
            except InterruptedError:
                continue
            if not ready:
                continue
            try:
                chunk = os.read(fd, 65536)
            except BlockingIOError:
                continue
            if not chunk:
                eof = True
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                handle_line(line.rstrip(b"\r"))
            if len(buf) > MAX_LINE:
                handle_line(buf[:MAX_LINE])
                buf = b""
        if buf:
            handle_line(buf.rstrip(b"\r"))
        if eof:
            while proc.poll() is None:
                check_marker()
                if cancel.requested:
                    oc["cancelRequested"] = True
                    terminate()
                    break
                if time.monotonic() >= end:
                    oc["timedOut"] = True
                    terminate()
                    break
                time.sleep(0.05)
        proc.wait()
    finally:
        os.close(out_f)
        t.join(timeout=5)
    rc = proc.returncode
    oc["exitCode"], oc["signal"] = (rc, None) if rc >= 0 else (None, -rc)
    return adapter.finalize(inp, st, oc)


def run(agent_id: str, assignment_id: str) -> int:
    try:
        validate_uuid(agent_id, "agent")
        validate_uuid(assignment_id, "assignment")
        sd = paths.ensure_state_dir()
        with open(request_path(sd, agent_id, assignment_id), encoding="utf-8") as f:
            req = json.load(f)
        if req.get("agentId") != agent_id or req.get("assignmentId") != assignment_id:
            _say("request file does not belong to this agent; refusing to run it")
            return 3
        conn = state.connect(state.db_path(sd), role="runner")
    except (OSError, ValueError, AsError) as e:
        _say(f"cannot start assignment: {e}")
        return 3

    attempt = req.get("attempt")
    seq = 0

    def report(kind: str, payload: dict) -> None:
        nonlocal seq
        try:
            reports.submit(conn, assignment_id, seq, kind, dict(payload, agentId=agent_id, attempt=attempt))
        except AsError as e:
            _say(f"could not record {kind} report: {e.message}")
        seq += 1

    provider_id = req.get("providerId")
    try:
        adapter = providers.resolve(provider_id, allow_test_only=True,
                                    fixture=(req.get("request") or {}).get("fixtureAdapter"))
        desc = adapter.describe(os.environ)
    except AsError as e:
        adapter, desc = None, {"providerId": provider_id, "error": e.message}
    ident = procid.identity(os.getpid())
    report("start", {"pid": ident["pid"], "startTime": ident["startTime"], "bootId": ident["bootId"], "provider": desc})
    rq = req.get("request") or {}
    settings = ", ".join(x for x in (rq.get("model") and f"model {rq['model']}",
                                     rq.get("reasoning") and f"reasoning {rq['reasoning']}") if x)
    _say(f"assignment {assignment_id[:8]} started - {provider_id} {desc.get('version') or ''}, "
         f"attempt {attempt}, policy {req.get('policy')}" + (f", {settings}" if settings else ""))
    _say("task: " + one_line(str(req.get("goal", ""))))

    rd = run_dir(sd, assignment_id)
    os.makedirs(rd, mode=0o700, exist_ok=True)
    role = str(req.get("role") or "")
    prompt_path = os.path.join(rd, "prompt.txt")
    r = req.get("request") or {}
    prompt = None
    if r.get("promptFile"):  # workflow stages: the coordinator composed template + task + inputs as a data file
        src = os.path.realpath(str(r["promptFile"]))
        if src.startswith(os.path.realpath(os.path.join(sd, "workflows")) + os.sep):
            with open(src, "rb") as f:
                prompt = f.read(2 * 1024 * 1024)
    if prompt is None:
        prompt = ("===== TASK =====\n" + str(req.get("goal", "")) + "\n===== END TASK =====\n").encode("utf-8")
    role_text = ((r.get("roleContext") or {}).get("text") or "")
    if not role_text and role:
        role_text = f"===== AGENT STUDIO ROLE: {role} =====\n(no role configuration)\n===== END ROLE =====\n"
    _write_private(prompt_path, role_text.encode("utf-8") + (b"\n" if role_text else b"") + prompt)
    inp = AssignmentInput(
        assignment_id=assignment_id, agent_id=agent_id, provider_id=str(provider_id), attempt=attempt,
        workspace=str(req.get("workspace")), prompt_path=prompt_path, role_instructions=role,
        policy=str(req.get("policy")), deadline_s=_clamp(r.get("deadlineMs"), DEFAULT_DEADLINE_MS, 100,
                                                          MAX_DEADLINE_MS) / 1000.0,
        output_budget_bytes=_clamp(r.get("outputBudgetBytes"), DEFAULT_BUDGET, 1024, MAX_BUDGET),
        model=r.get("model"), reasoning=r.get("reasoning"), options=r.get("providerOptions") or {},
        expects_verdict=bool(r.get("expectsVerdict")) or r.get("stage") in ("reviewer", "reviewer_recheck"))
    oc = {"outputPath": os.path.join(rd, "stdout.jsonl"), "stderrPath": os.path.join(rd, "stderr.log"),
          "exitCode": None, "signal": None, "timedOut": False, "cancelRequested": False, "truncated": False}
    st = ParseState()

    if os.path.exists(os.path.join(rd, CANCEL_MARKER)):
        final = refusal_report(inp, "CANCELLED", "Cancelled before the provider was started.", oc, status="cancelled")
    elif adapter is None:
        final = refusal_report(inp, "PROVIDER_UNAVAILABLE", desc.get("error", "Provider unavailable."), oc)
    else:
        try:
            prep = adapter.prepare(inp, os.environ)
        except AsError as e:
            final = refusal_report(inp, e.code, e.message, oc)
        else:
            guard = getattr(adapter, "guard_read_only", False) and inp.policy == "read_only"
            before = workspace_fingerprint(inp.workspace) if guard else None
            final = _execute(adapter, inp, prep, st, oc, report, rd)
            if guard:
                final = guard_violation(adapter, inp, before, final)
    expect = {"assignmentId": assignment_id, "agentId": agent_id, "providerId": provider_id, "attempt": attempt,
              "policy": req.get("policy")}
    try:
        contract.validate_report(final, expect)
    except AsError as e:
        _say(f"adapter produced an invalid report ({e.code}); reporting inconclusive")
        final = dict(final, status="inconclusive", diagnosticCode=e.code)
    _write_private(os.path.join(rd, "result.json"), json.dumps(final, ensure_ascii=True, indent=2).encode())
    report("final", final)
    _say(f"assignment {assignment_id[:8]} finished: {final['status']}"
         + (f" ({final['diagnosticCode']})" if final.get("diagnosticCode") else ""))
    return 0 if final["status"] == "succeeded" else 1
