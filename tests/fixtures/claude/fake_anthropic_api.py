"""Local scripted stand-in for the Anthropic Messages API, used to run the REAL claude CLI in tests without network.
Scripted by the latest user turn. Logs request paths and tool names only (never headers)."""
import json, sys, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = open(sys.argv[2], "a")


def sse(w, ev, data):
    w.write(f"event: {ev}\ndata: {json.dumps(data)}\n\n".encode())


def workdir(body):
    import re
    m = re.search(r"(?:Primary working directory|Working directory|cwd)[^/]{0,20}(/[^\s\"\\<]+)", json.dumps(body))
    return m.group(1) if m else CWD[0]


def blocks_for(body):
    msgs = body.get("messages", [])
    last = msgs[-1] if msgs else {}
    content = last.get("content")
    texts, results = [], []
    if isinstance(content, str):
        texts.append(content)
    else:
        for c in content or []:
            if c.get("type") == "text":
                texts.append(c["text"])
            elif c.get("type") == "tool_result":
                results.append(c)
    first = ""
    for m in msgs:
        if m.get("role") == "user":
            c = m.get("content")
            first = c if isinstance(c, str) else " ".join(x.get("text", "") for x in c if x.get("type") == "text")
            break
    tools = [t.get("name") for t in body.get("tools", [])]
    LOG.write(json.dumps({"tools": tools, "results": [{"is_error": r.get("is_error"), "content": str(r.get("content"))[:300]} for r in results],
                          "model": body.get("model"), "thinking": body.get("thinking"), "effort": body.get("output_config") or body.get("effort")}) + "\n"); LOG.flush()
    if results:
        if any(r.get("is_error") for r in results):
            return [{"type": "text", "text": "I could not do that: permission was denied."}]
        return [{"type": "text", "text": "DONE"}]
    import re
    m = re.search(r"Create a file named (\S+) in the current directory", first)
    if m:
        import os
        body_txt = re.search(r"single line (\S+)", first)
        return [{"type": "text", "text": "Creating it."},
                {"type": "tool_use", "id": "toolu_" + uuid.uuid4().hex[:20], "name": "Write",
                 "input": {"file_path": os.path.join(workdir(body), m.group(1)), "content": (body_txt.group(1) if body_txt else "x") + "\n"}}]
    m = re.search(r"Run the shell command: (.+)$", first, re.M)
    if m:
        return [{"type": "tool_use", "id": "toolu_" + uuid.uuid4().hex[:20], "name": "Bash", "input": {"command": m.group(1), "description": "run"}}]
    m = re.search(r"Reply with exactly (\S+) and nothing else", first)
    if m:
        return [{"type": "text", "text": m.group(1)}]
    m = re.search(r"nothing else: (\{.*\})", first)
    if m:
        return [{"type": "text", "text": m.group(1)}]
    if "FAIL_WITH_500" in first:
        return None
    return [{"type": "text", "text": "ok"}]


CWD = [sys.argv[3] if len(sys.argv) > 3 else "/tmp"]  # fallback when the request names no working directory


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def do_GET(self):
        LOG.write(json.dumps({"GET": self.path}) + "\n"); LOG.flush()
        self.send_response(404); self.send_header("content-length", "0"); self.end_headers()

    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        LOG.write(json.dumps({"POST": self.path, "stream": body.get("stream")}) + "\n"); LOG.flush()
        if "count_tokens" in self.path:
            data = json.dumps({"input_tokens": 10}).encode()
            self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data); return
        if not self.path.startswith("/v1/messages"):
            self.send_response(404); self.send_header("content-length", "0"); self.end_headers(); return
        blocks = blocks_for(body)
        if blocks is None:
            data = json.dumps({"type": "error", "error": {"type": "api_error", "message": "Internal server error"}}).encode()
            self.send_response(400); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data); return
        stop = "tool_use" if any(b["type"] == "tool_use" for b in blocks) else "end_turn"
        mid = "msg_" + uuid.uuid4().hex[:24]
        model = body.get("model", "claude-test")
        usage = {"input_tokens": 50, "output_tokens": 5, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}
        if not body.get("stream"):
            data = json.dumps({"id": mid, "type": "message", "role": "assistant", "model": model, "content": blocks,
                               "stop_reason": stop, "stop_sequence": None, "usage": usage}).encode()
            self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data); return
        self.send_response(200); self.send_header("content-type", "text/event-stream"); self.send_header("connection", "close"); self.end_headers()
        w = self.wfile
        sse(w, "message_start", {"type": "message_start", "message": {"id": mid, "type": "message", "role": "assistant", "model": model, "content": [], "stop_reason": None, "stop_sequence": None, "usage": usage}})
        for i, b in enumerate(blocks):
            if b["type"] == "text":
                sse(w, "content_block_start", {"type": "content_block_start", "index": i, "content_block": {"type": "text", "text": ""}})
                sse(w, "content_block_delta", {"type": "content_block_delta", "index": i, "delta": {"type": "text_delta", "text": b["text"]}})
            else:
                sse(w, "content_block_start", {"type": "content_block_start", "index": i, "content_block": {"type": "tool_use", "id": b["id"], "name": b["name"], "input": {}}})
                sse(w, "content_block_delta", {"type": "content_block_delta", "index": i, "delta": {"type": "input_json_delta", "partial_json": json.dumps(b["input"])}})
            sse(w, "content_block_stop", {"type": "content_block_stop", "index": i})
        sse(w, "message_delta", {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None}, "usage": {"output_tokens": 5}})
        sse(w, "message_stop", {"type": "message_stop"})
        w.flush()
        self.close_connection = True


ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
