"""Deterministic fake provider CLI (test-only). Behaves like a headless coding-agent CLI: reads the prompt on
stdin, prints JSON events on stdout, exits. Never executes the prompt; only fixed enum/int arguments."""
import argparse
import hashlib
import json
import os
import signal
import subprocess
import sys
import time
import uuid

SCENARIOS = ("success", "provider_failure", "permission_denied", "malformed_final", "no_final", "crash",
             "waiting_input", "timeout", "slow", "flood", "nonzero_success", "verdict_pass", "verdict_fail",
             "verdict_malformed", "usage_limit", "usage_limit_no_reset", "mcp_tickets")


def mcp(session, method, params=None, request_id=None):
    """One JSON-RPC exchange with the Agent Studio MCP server (P04-S12) over its stdin/stdout."""
    payload = {"jsonrpc": "2.0", "id": request_id, "method": method}
    if params is not None:
        payload["params"] = params
    session.stdin.write(json.dumps(payload).encode("utf-8") + b"\n")
    session.stdin.flush()
    line = session.stdout.readline()
    return json.loads(line.decode("utf-8")) if line else {"error": {"message": "server closed"}}


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")
    sys.stdout.flush()


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
    p.add_argument("--mcp", action="store_true",
                   help="launch the agent-studio board MCP server per AGENT_STUDIO_MCP_COMMAND (test-only)")
    a = p.parse_args()
    prompt = sys.stdin.buffer.read()
    sha = hashlib.sha256(prompt).hexdigest()
    emit({"type": "init", "session": "fake-" + uuid.uuid4().hex[:12], "promptSha256": sha, "promptBytes": len(prompt),
          "sandbox": a.sandbox, "cwd": os.getcwd(), "model": a.model, "reasoning": a.reasoning})
    session = None
    if a.mcp:  # the runner started us with the board MCP server available (P04-S12)
        command = os.environ.get("AGENT_STUDIO_MCP_COMMAND")
        if command:
            argv = json.loads(command)  # [python, launch.py, mcp] — how a real CLI would launch it
            session = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       env=dict(os.environ))
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
    if s in ("usage_limit", "usage_limit_no_reset"):
        result = {"type": "result", "status": "error", "code": "usage_limit", "summary": "fake usage limit reached"}
        if s == "usage_limit":
            result["resetAt"] = "2030-01-01T15:00:00Z"
        emit(result)
        return 1
    result = {"type": "result", "status": "success", "summary": f"fake {s} done", "promptSha256": sha,
              "usage": {"inputTokens": len(prompt), "outputTokens": 42}}
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
    if session is not None:  # an MCP-enabled assignment: exercise the tools like a real agent would
        try:
            hello = mcp(session, "initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                                "clientInfo": {"name": "fake", "version": "1"}}, 1)
            tools = mcp(session, "tools/list", {}, 2)
            first = mcp(session, "tools/call",
                        {"name": "ticket_add", "arguments": {"title": "Finding: retry swallows errors",
                                                             "body": "added by the fake provider",
                                                             "priority": 50}}, 3)
            again = mcp(session, "tools/call",
                        {"name": "ticket_add", "arguments": {"title": "Finding: retry swallows errors"}}, 3)
            second = mcp(session, "tools/call",
                         {"name": "ticket_add", "arguments": {"title": "Finding: cache never invalidates",
                                                              "phase": os.environ.get("FAKE_MCP_PHASE") or "default"}},
                         4)
            listed = mcp(session, "tools/call", {"name": "ticket_list", "arguments": {}}, 5)
            emit({"type": "progress", "message": f"mcp: state={os.environ.get('XDG_STATE_HOME')} "
                                                 f"first={json.dumps(first.get('result', {}))}"})
            session.stdin.close()
            session.wait(timeout=30)
            result["summary"] = (f"mcp ok: {json.dumps(first.get('result', {}).get('ticket', {}))[:200]} "
                                 f"dup-is-error={again.get('result', {}).get('isError')} "
                                 f"listed={len((listed.get('result', {}) or {}).get('tickets', []))} "
                                 f"init={json.dumps(hello.get('result', {}).get('serverInfo', {}))}")
        finally:
            if session.poll() is None:
                session.kill()
    emit(result)
    return 3 if s == "nonzero_success" else 0


if __name__ == "__main__":
    sys.exit(main())
