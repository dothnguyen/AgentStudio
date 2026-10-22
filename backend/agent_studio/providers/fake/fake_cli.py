"""Deterministic fake provider CLI (test-only). Behaves like a headless coding-agent CLI: reads the prompt on
stdin, prints JSON events on stdout, exits. Never executes the prompt; only fixed enum/int arguments."""
import argparse
import hashlib
import json
import os
import signal
import sys
import time
import uuid

SCENARIOS = ("success", "provider_failure", "permission_denied", "malformed_final", "no_final", "crash",
             "waiting_input", "timeout", "slow", "flood", "nonzero_success", "verdict_pass", "verdict_fail",
             "verdict_malformed")


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def load_session(session_dir, sid):
    try:
        with open(os.path.join(session_dir, sid + ".json"), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and isinstance(data.get("turns"), list) else None


def save_session(session_dir, data):
    os.makedirs(session_dir, mode=0o700, exist_ok=True)
    path = os.path.join(session_dir, data["id"] + ".json")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--scenario", choices=SCENARIOS, required=True)
    p.add_argument("--sandbox", choices=("read-only", "workspace-write"), required=True)
    p.add_argument("--duration-ms", type=int, default=1000)
    p.add_argument("--lines", type=int, default=3)
    p.add_argument("--write")
    p.add_argument("--final-text")
    p.add_argument("--model")
    p.add_argument("--reasoning", choices=("low", "medium", "high"))
    p.add_argument("--session-dir")
    p.add_argument("--persist", action="store_true")
    p.add_argument("--resume")
    p.add_argument("--fork", action="store_true")
    p.add_argument("--force-session-missing", action="store_true")
    p.add_argument("--tool-use", action="append", default=[])
    a = p.parse_args()
    prompt = sys.stdin.buffer.read()
    sha = hashlib.sha256(prompt).hexdigest()
    parent = None
    if a.resume or a.force_session_missing:  # the flag also fails a fresh start (the fallback re-run)
        if not a.force_session_missing and a.session_dir:
            parent = load_session(a.session_dir, a.resume)
        if parent is None:
            emit({"type": "result", "status": "error", "code": "session_not_found",
                  "summary": "fake provider: no such session"})
            return 1
    prior = parent["turns"] if parent else []
    turn = {"promptSha256": sha, "promptBytes": len(prompt), "sandbox": a.sandbox}
    if parent and not a.fork:
        sid = parent["id"]
    else:
        sid = "fake-" + uuid.uuid4().hex[:12]
    emit({"type": "init", "session": sid, "promptSha256": sha, "promptBytes": len(prompt),
          "sandbox": a.sandbox, "cwd": os.getcwd(), "model": a.model, "reasoning": a.reasoning,
          "resumedFrom": a.resume if parent else None, "priorTurns": len(prior)})
    if a.session_dir and (a.persist or parent):
        save_session(a.session_dir, {"id": sid, "parent": parent["id"] if parent else None,
                                     "turns": prior + [turn]})
    duration = (60.0 if a.scenario == "slow" and a.duration_ms <= 1000 else a.duration_ms / 1000.0)
    if a.scenario == "timeout":
        time.sleep(3600)
    if a.scenario == "flood":
        for i in range(a.lines or 50000):
            emit({"type": "progress", "message": f"flood {i} " + "x" * 64})
    else:
        for i in range(a.lines):
            time.sleep(duration / max(a.lines, 1))
            emit({"type": "progress", "message": f"working {i + 1}/{a.lines}"})
        if a.lines == 0:
            time.sleep(duration)
    if a.write:
        if a.sandbox == "read-only":
            emit({"type": "tool_denied", "tool": "write_file", "path": a.write})
        else:
            target = os.path.join(os.getcwd(), a.write)
            os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
            with open(target, "w", encoding="utf-8") as f:
                f.write(f"written by the fake provider\nprompt sha256 {sha}\n")
            emit({"type": "file_written", "path": a.write})
    sys.stderr.write("fake provider diagnostics on stderr\n")
    s = a.scenario
    if s == "permission_denied":
        emit({"type": "tool_denied", "tool": "shell", "command": "rm -rf build"})
    if s == "crash":
        os.kill(os.getpid(), signal.SIGKILL)
    if s == "no_final":
        return 0
    if s == "waiting_input":
        emit({"type": "input_required", "question": "May I run the migration?"})
        return 0
    if s == "malformed_final":
        sys.stdout.write('{"type": "result", "status": "succ\n')
        sys.stdout.flush()
        return 0
    if s == "provider_failure":
        emit({"type": "result", "status": "error", "summary": "fake provider error: model unavailable"})
        return 1
    result = {"type": "result", "status": "success", "summary": f"fake {s} done", "promptSha256": sha,
              "usage": {"inputTokens": len(prompt), "cachedInputTokens": sum(
                  t.get("promptBytes", 0) for t in prior if isinstance(t, dict)), "outputTokens": 42}}
    tools = {}
    for item in a.tool_use:
        name, _, n = item.partition("=")
        tools[name] = int(n)
    if tools:
        result["toolUses"] = tools
    if a.final_text:
        result["summary"] = a.final_text
    if s == "verdict_pass":
        result["verdict"] = {"verdict": "pass", "findings": []}
    elif s == "verdict_fail":
        result["verdict"] = {"verdict": "fail", "findings": [
            "test_add fails: expected 4, got 5",
            "shell text is data: $(touch CANARY_FINDING) `touch CANARY_BACKTICK`; rm -rf ~ && echo pwned"]}
    elif s == "verdict_malformed":
        result["verdict"] = {"verdict": "maybe", "findings": "unclear"}
    emit(result)
    return 3 if s == "nonzero_success" else 0


if __name__ == "__main__":
    sys.exit(main())
