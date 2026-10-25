import io
import json
import os
import shutil

from tests import helpers
from tests.helpers import req
from tests.unit.test_p04_s01_workspace import Base
from agent_studio import dispatch, serve


class ServeWorkspaceTests(Base):
    def serve_calls(self, *reqs):
        data = b""
        for i, r in enumerate(reqs, 1):
            r = dict(r)
            r.setdefault("id", i)
            data += json.dumps(r).encode("utf-8") + b"\n"
        out = io.BytesIO()
        serve.run(inp=io.BytesIO(data), out=out)
        return [json.loads(l) for l in out.getvalue().splitlines() if l.strip()]

    def call(self, command, args=None):
        return self.serve_calls(req(command, args))[0]

    def init(self, path, **kw):
        return self.call("workspace.init", dict(path=path, **kw))

    def mk(self, name):
        p = os.path.join(self.root, name)
        os.makedirs(p)
        return p

    def read(self, p):
        with open(p, "rb") as f:
            return f.read()

    def marker(self, ws):
        return os.path.join(ws, ".agent-studio", "workspace.json")

    def test_list_registry_order_and_exists(self):
        c, a, b = self.mk("c"), self.mk("a"), self.mk("b")
        for p in (c, a, b):
            self.assertTrue(self.init(p)["ok"])
        shutil.rmtree(b)
        before = self.read(self.registry)
        r = self.call("workspace.list")
        self.assertTrue(r["ok"])
        ws = r["data"]["workspaces"]
        self.assertEqual([w["path"] for w in ws], [c, a, b])
        for w in ws:
            self.assertEqual(set(w), {"id", "name", "path", "missing", "exists"})
        self.assertEqual([w["exists"] for w in ws], [True, True, False])
        self.assertEqual(self.read(self.registry), before)
        self.assertFalse(os.path.exists(os.path.join(self.root, "state", "agent-studio", "state.db")))

    def test_list_empty(self):
        r = self.call("workspace.list")
        self.assertTrue(r["ok"])
        self.assertEqual(r["data"], {"workspaces": []})

    def test_init_creates_marker_and_entry(self):
        r = self.init(self.ws)
        self.assertTrue(r["ok"])
        d = r["data"]
        self.assertFalse(d["existed"])
        self.assertEqual(d["name"], "proj")
        self.assertEqual(d["path"], self.ws)
        self.assertEqual(json.loads(self.read(self.marker(self.ws)))["id"], d["id"])
        self.assertEqual(self.reg()["workspaces"], [{"id": d["id"], "name": "proj", "path": self.ws}])

    def test_init_name_and_empty_name(self):
        self.assertEqual(self.init(self.ws, name="Named")["data"]["name"], "Named")
        ws2 = self.mk("proj2")
        self.assertEqual(self.init(ws2, name="")["data"]["name"], "proj2")

    def test_init_idempotent(self):
        first = self.init(self.ws)["data"]
        m, g = self.read(self.marker(self.ws)), self.read(self.registry)
        second = self.init(self.ws, name="other")
        self.assertTrue(second["ok"])
        d = second["data"]
        self.assertTrue(d["existed"])
        self.assertEqual((d["id"], d["name"]), (first["id"], "proj"))
        self.assertEqual(self.read(self.marker(self.ws)), m)
        self.assertEqual(self.read(self.registry), g)
        self.assertEqual(len(self.reg()["workspaces"]), 1)

    def test_init_refuses_non_directory(self):
        nope = os.path.join(self.root, "nope")
        r = self.init(nope)
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"]["code"], "BAD_REQUEST")
        self.assertEqual(r["error"]["message"], f"--path {nope} is not an existing directory")
        self.assertFalse(os.path.exists(nope))
        self.assertFalse(os.path.exists(self.registry))
        f = os.path.join(self.root, "file.txt")
        with open(f, "w") as fh:
            fh.write("x")
        r = self.init(f)
        self.assertEqual(r["error"]["code"], "BAD_REQUEST")
        self.assertEqual(r["error"]["message"], f"--path {f} is not an existing directory")
        self.assertFalse(os.path.exists(os.path.join(self.root, ".agent-studio")))

    def test_init_argument_errors(self):
        cases = [
            ({}, "Missing required argument 'path'."),
            ({"path": None}, "Missing required argument 'path'."),
            ({"path": ""}, "Argument 'path' must not be empty."),
            ({"path": 5}, "Argument 'path' must be a string."),
            ({"path": self.ws, "name": 5}, "Argument 'name' must be a string."),
        ]
        for args, msg in cases:
            r = self.call("workspace.init", args)
            self.assertFalse(r["ok"], args)
            self.assertEqual(r["error"]["code"], "BAD_REQUEST")
            self.assertEqual(r["error"]["message"], msg)
        self.assertFalse(os.path.exists(os.path.join(self.ws, ".agent-studio")))
        self.assertFalse(os.path.exists(self.registry))

    def test_init_rejects_broken_existing_marker(self):
        marker = self.marker(self.ws)
        os.makedirs(os.path.dirname(marker))
        with open(marker, "w", encoding="utf-8") as f:
            f.write('{"id": 1}')
        r = self.init(self.ws, name="Ignored")
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"]["code"], "BAD_REQUEST")
        self.assertEqual(r["error"]["message"],
                         f"{marker} must be a JSON object with string id and name")
        self.assertFalse(os.path.exists(self.registry))

    def test_list_rejects_unreadable_registry(self):
        os.makedirs(os.path.dirname(self.registry), exist_ok=True)
        with open(self.registry, "w", encoding="utf-8") as f:
            f.write("{")
        r = self.call("workspace.list")
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"]["code"], "BAD_REQUEST")
        self.assertTrue(r["error"]["message"].startswith("workspaces.json is unreadable:"))

    def test_error_envelope_has_request_id_and_non_retryable_bad_request(self):
        r = self.serve_calls(req("workspace.init", {"path": ""}))[0]
        self.assertEqual(r["id"], 1)
        self.assertFalse(r["ok"])
        self.assertEqual(r["error"], {
            "code": "BAD_REQUEST",
            "message": "Argument 'path' must not be empty.",
            "retryable": False,
        })

    def test_cli_and_serve_agree(self):
        a, b = self.mk("A"), self.mk("B")
        rc, out, _ = self.cli("init", "--path", a, "--json")
        dA = json.loads(out)["data"]
        sA = self.init(a)["data"]
        self.assertIs(dA["existed"], False)
        self.assertEqual(sA, dict(dA, existed=True))
        sB = self.init(b)["data"]
        rc, out, _ = self.cli("init", "--path", b, "--json")
        self.assertEqual(json.loads(out)["data"], dict(sB, existed=True))
        rc, out, _ = self.cli("workspace", "list", "--json")
        cl = json.loads(out)["data"]
        self.assertEqual(cl, self.call("workspace.list")["data"])
        self.assertEqual([w["path"] for w in cl["workspaces"]], [a, b])
        nope = os.path.join(self.root, "nope")
        rc, out, err = self.cli("init", "--path", nope, "--json")
        env = json.loads(out or err)
        self.assertEqual(env["error"], self.init(nope)["error"])

    def test_request_one_shot(self):
        r = dispatch.handle_request(req("workspace.list"), require_id=False)
        self.assertTrue(r["ok"])
