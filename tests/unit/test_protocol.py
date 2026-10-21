import io
import json
import unittest

from tests import helpers  # noqa: F401  (puts backend on sys.path)
from agent_studio import dispatch, serve
from agent_studio.protocol import dumps


def handle(obj, require_id=True):
    return dispatch.handle_bytes(json.dumps(obj).encode("utf-8"), require_id)


class ProtocolValidation(unittest.TestCase):
    def test_malformed_json(self):
        r = dispatch.handle_bytes(b'{"protocol": ', True)
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"]["code"], "BAD_REQUEST")
        self.assertIsNone(r["id"])

    def test_invalid_utf8(self):
        r = dispatch.handle_bytes(b'{"protocol":"agent-studio/v1","id":1,"command":"health","args":{"x":"\xff"}}', True)
        self.assertEqual(r["error"]["code"], "BAD_REQUEST")

    def test_not_an_object(self):
        self.assertEqual(handle([1, 2])["error"]["code"], "BAD_REQUEST")

    def test_missing_id_in_serve_mode(self):
        r = handle({"protocol": "agent-studio/v1", "command": "health"}, require_id=True)
        self.assertEqual(r["error"]["code"], "BAD_REQUEST")
        self.assertIn("id", r["error"]["message"])

    def test_id_optional_for_one_shot(self):
        r = handle({"protocol": "agent-studio/v1", "command": "health"}, require_id=False)
        self.assertTrue(r["ok"])

    def test_bad_id_types(self):
        for bad in (True, None, 1.5, {"a": 1}, "", "x" * 129):
            r = handle({"protocol": "agent-studio/v1", "id": bad, "command": "health"})
            self.assertEqual(r["error"]["code"], "BAD_REQUEST", bad)

    def test_unicode_id_echoed(self):
        rid = "req-\u6f22\u5b57-\U0001F600"
        r = handle({"protocol": "agent-studio/v1", "id": rid, "command": "health"})
        self.assertTrue(r["ok"])
        self.assertEqual(r["id"], rid)

    def test_missing_and_unsupported_protocol(self):
        self.assertEqual(handle({"id": 1, "command": "health"})["error"]["code"], "BAD_REQUEST")
        r = handle({"protocol": "agent-studio/v2", "id": 1, "command": "health"})
        self.assertEqual(r["error"]["code"], "UNSUPPORTED_PROTOCOL")

    def test_unknown_command(self):
        r = handle({"protocol": "agent-studio/v1", "id": 1, "command": "rm -rf /"})
        self.assertEqual(r["error"]["code"], "UNKNOWN_COMMAND")

    def test_args_must_be_object(self):
        r = handle({"protocol": "agent-studio/v1", "id": 1, "command": "health", "args": "x"})
        self.assertEqual(r["error"]["code"], "BAD_REQUEST")

    def test_mutating_command_requires_idempotency_key(self):
        base = {"protocol": "agent-studio/v1", "id": 1, "command": "debug.echo", "args": {"text": "hi"}}
        self.assertEqual(handle(base)["error"]["code"], "BAD_REQUEST")
        for bad in ("short", "has space in it", "x" * 129, 12345678):
            r = handle(dict(base, idempotencyKey=bad))
            self.assertEqual(r["error"]["code"], "BAD_REQUEST", bad)

    def test_oversized_field_rejected_before_backend(self):
        r = handle({"protocol": "agent-studio/v1", "id": 1, "command": "debug.echo", "idempotencyKey": "k" * 16,
                    "args": {"text": "x" * (dispatch.MAX_ECHO_BYTES + 1)}})
        self.assertEqual(r["error"]["code"], "BAD_REQUEST")
        self.assertIn("limit", r["error"]["message"])

    def test_lone_surrogate_and_nul_rejected(self):
        for text in ("\ud800", "a\x00b"):
            r = dispatch.handle_bytes(dumps({"protocol": "agent-studio/v1", "id": 1, "command": "debug.echo",
                                             "idempotencyKey": "k" * 16, "args": {"text": text}}), True)
            self.assertEqual(r["error"]["code"], "BAD_REQUEST")

    def test_bom_tolerated(self):
        raw = b"\xef\xbb\xbf" + json.dumps({"protocol": "agent-studio/v1", "id": 1, "command": "health"}).encode()
        self.assertTrue(dispatch.handle_bytes(raw + b"\xef\xbb\xbf", True)["ok"])

    def test_wire_output_is_ascii(self):
        out = dumps({"text": "\U0001F600 \u6f22\u5b57 \"q\" \n"})
        out.decode("ascii")
        self.assertEqual(json.loads(out)["text"], "\U0001F600 \u6f22\u5b57 \"q\" \n")


class ServeLoop(unittest.TestCase):
    def run_serve(self, data: bytes):
        out = io.BytesIO()
        rc = serve.run(io.BytesIO(data), out)
        return rc, [json.loads(l) for l in out.getvalue().splitlines()]

    def test_bad_line_does_not_end_session(self):
        lines = (b'{"protocol":"agent-studio/v1","id":"a","command":"health"}\n'
                 b'not json\n'
                 b'\n'
                 b'{"protocol":"agent-studio/v1","id":"b","command":"nope"}\r\n'
                 b'{"protocol":"agent-studio/v1","id":"c","command":"health"}')
        rc, resps = self.run_serve(lines)
        self.assertEqual(rc, 0)
        self.assertEqual([r["id"] for r in resps], ["a", None, "b", "c"])
        self.assertEqual([r["ok"] for r in resps], [True, False, False, True])
        self.assertEqual(resps[2]["error"]["code"], "UNKNOWN_COMMAND")

    def test_oversized_line_discarded(self):
        from agent_studio.protocol import MAX_LINE_BYTES
        big = b'{"x":"' + b"a" * (MAX_LINE_BYTES + 10) + b'"}\n'
        ok = b'{"protocol":"agent-studio/v1","id":9,"command":"health"}\n'
        rc, resps = self.run_serve(big + ok)
        self.assertEqual(resps[0]["error"]["code"], "BAD_REQUEST")
        self.assertEqual(resps[1]["id"], 9)
        self.assertTrue(resps[1]["ok"])


if __name__ == "__main__":
    unittest.main()
