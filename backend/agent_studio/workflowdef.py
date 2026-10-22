"""Workflow definitions: immutable model, JSON loader and static validation (P01-S01).

Two readers, one model:

    parse_obj(obj, source, prompts)   the SOURCE form a user writes (promptFile, no name/sourceSha256/warnings)
    from_json(obj)                    the FROZEN form a run stores (prompt + promptSource, name, sourceSha256, warnings)

Pure code: parse_obj and from_json never touch the filesystem. load() / list_definitions() read files, read each
prompt file once, and hand the texts to parse_obj. Design contract: phases/phase-01/README.md sections A and B.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass, replace
from types import MappingProxyType
from typing import Any, Mapping, Optional

from . import prompts as promptlib
from . import yamlsubset
from .protocol import AsError
from .roles import CONFIG_DIR, _inside

WORKFLOW_DEFINITION_INVALID = "WORKFLOW_DEFINITION_INVALID"
WORKFLOW_DEFINITION_NOT_FOUND = "WORKFLOW_DEFINITION_NOT_FOUND"
WORKFLOW_DEFINITION_AMBIGUOUS = "WORKFLOW_DEFINITION_AMBIGUOUS"

NAME_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,63}\Z")
STAGE_ID_RE = re.compile(r"[a-z][a-z0-9_]{0,31}\Z")
SHA_RE = re.compile(r"[0-9a-f]{64}\Z")
EXTENSIONS = (".json", ".yaml", ".yml")
WORKFLOWS_DIR = "workflows"
SUCCEED, FAIL = "$succeed", "$fail"
PERMISSIONS = ("read_only", "workspace_write")
MAX_DEFINITION_BYTES = 64 * 1024
MAX_PROMPT_BYTES = 32 * 1024
MAX_STAGES = 20
DEFAULT_MAX_STEPS = 20
DIFF_PLACEHOLDER = "{{diff}}"

_TOP_KEYS = ("version", "description", "maxSteps", "stages")
_FROZEN_TOP_KEYS = _TOP_KEYS + ("name", "sourceSha256", "warnings")
_STAGE_KEYS = ("id", "type", "role", "permission", "prompt", "promptFile", "maxVisits", "passRequires", "next")
_FROZEN_STAGE_KEYS = tuple(k for k in _STAGE_KEYS if k != "promptFile") + ("promptSource",)
_AGENT_ONLY = ("role", "permission", "prompt", "promptFile", "promptSource", "passRequires")


@dataclass(frozen=True)
class Stage:
    id: str
    type: str                       # agent | validation
    role: Optional[str]
    permission: Optional[str]
    prompt: Optional[str]           # template text (inline or read from the file); None for validation
    prompt_source: Optional[str]    # "inline" or the promptFile path as written; None for validation
    max_visits: int
    pass_requires: tuple
    next: Mapping[str, str]         # work: {done}; verdict / validation: {pass, fail}
    kind: str                       # work | verdict | validation


@dataclass(frozen=True)
class Definition:
    name: str
    version: int
    description: str
    max_steps: int
    stages: tuple
    source_sha256: str
    warnings: tuple


class _Problem:
    """A prompt file that could not be loaded; parse_obj reports it at the stage's promptFile."""
    def __init__(self, message: str):
        self.message = message


class _Obj(dict):
    """A JSON object that remembers keys that appeared more than once."""
    def __init__(self, *args, **kw):
        super().__init__(*args, **kw)
        self.dups: list = []


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


class _Collector:
    def __init__(self, file: str):
        self.file = file
        self.errors: list = []
        self.warnings: list = []

    def _item(self, path: str, message: str, line: Optional[int] = None) -> dict:
        return {"file": self.file, "path": path, "line": line, "message": message}

    def err(self, path: str, message: str, line: Optional[int] = None) -> None:
        self.errors.append(self._item(path, message, line))

    def warn(self, path: str, message: str) -> None:
        self.warnings.append(self._item(path, message))

    def raise_if_errors(self) -> None:
        if self.errors:
            raise AsError(WORKFLOW_DEFINITION_INVALID, f"{len(self.errors)} error(s) in {self.file}",
                          data={"errors": self.errors, "warnings": self.warnings})


def _text_problem(text: str, what: str = "prompt") -> Optional[str]:
    """Why a text is unusable (not encodable as UTF-8, or a prompt over the size limit), else None."""
    try:
        size = len(text.encode("utf-8"))
    except UnicodeEncodeError:
        return f"{what} is not valid text (lone surrogate)"
    return "prompt is larger than 32 KiB" if what == "prompt" and size > MAX_PROMPT_BYTES else None


_INDEX_TAIL = re.compile(r"\[\d+\]\Z")
_SEG_RE = re.compile(r"^([^.\[]*)(?:\[(\d+)\])?(?:\.(.*))?$", re.S)


def _file_order(obj: dict, errors: list) -> list:
    """Stable-sort errors into the order their keys appear in the file (missing keys last)."""
    def pos(keys: list, k: str) -> int:
        return keys.index(k) if k in keys else len(keys)

    def key(e: dict) -> tuple:
        m = _SEG_RE.match(e["path"])
        if m is None:
            return (len(obj) + 1, 0, 0)
        top, idx, rest = m.group(1), m.group(2), m.group(3)
        if top == "$" or top not in obj:
            return (len(obj) + 1, 0, 0)
        k = (pos(list(obj), top), -1, -1)
        stages = obj[top]
        if top == "stages" and idx is not None and isinstance(stages, list) and int(idx) < len(stages):
            st = stages[int(idx)]
            sk = -1 if rest is None else pos(list(st), rest.split(".")[0].split("[")[0]) if isinstance(st, dict) else 0
            k = (k[0], int(idx), sk)
        return k
    return sorted(errors, key=key)


def _check_placeholders(c: _Collector, stages: list, frozen: bool) -> None:
    """Unknown {{names}} in a stage template are load errors, reported at the stage's prompt or promptFile."""
    for s in stages:
        if s["prompt"] is None:
            continue
        key = "promptFile" if not frozen and s["prompt_source"] != "inline" else "prompt"
        for name in sorted(promptlib.placeholders(s["prompt"]) - promptlib.ALLOWED):
            c.err(f"stages[{s['i']}].{key}",
                  f"unknown placeholder {{{{{name}}}}} (allowed: {', '.join(sorted(promptlib.ALLOWED))})")


# ---- one stage -------------------------------------------------------------------------------------------------

def _stage(c: _Collector, i: int, st: Any, ctx: dict) -> Optional[dict]:
    """Validate one stage; returns what the graph pass needs, or None when the stage is not an object."""
    p = f"stages[{i}]"
    if not isinstance(st, dict):
        c.err(p, "a stage must be an object")
        return None
    allowed = _FROZEN_STAGE_KEYS if ctx["frozen"] else _STAGE_KEYS
    typ = st.get("type", "agent")
    is_validation = typ == "validation"
    info = {"i": i, "id": None, "type": "validation" if is_validation else "agent", "role": None,
            "permission": None, "prompt": None, "prompt_source": None, "max_visits": 1, "pass_requires": (),
            "next": {}, "kind": None}

    for key, val in st.items():
        kp = f"{p}.{key}"
        if key not in allowed:
            c.err(kp, f'unknown key "{key}"')
        elif key == "id":
            if not isinstance(val, str) or not STAGE_ID_RE.match(val):
                c.err(kp, "id must match [a-z][a-z0-9_]{0,31}")
            elif val in ctx["seen"]:
                c.err(kp, f'duplicate stage id "{val}"')
            else:
                info["id"] = val
                ctx["seen"].add(val)
        elif key == "type":
            if val not in ("agent", "validation"):
                c.err(kp, 'type must be "agent" or "validation"')
        elif key == "maxVisits":
            if not _is_int(val) or not 1 <= val <= 10:
                c.err(kp, "maxVisits must be an integer from 1 to 10")
            else:
                info["max_visits"] = val
        elif key in _AGENT_ONLY and is_validation:
            c.err(kp, f"{key} is not allowed on validation stages")
    if "id" not in st:
        c.err(f"{p}.id", "id is required")

    if not is_validation:
        _agent_fields(c, p, st, info, ctx)
    _next(c, p, st, info, ctx, is_validation)
    if not is_validation and "passRequires" in st:
        _pass_requires(c, p, st, info, ctx)
    return info


def _agent_fields(c: _Collector, p: str, st: dict, info: dict, ctx: dict) -> None:
    if "role" not in st:
        c.err(f"{p}.role", "role is required on agent stages")
    elif not isinstance(st["role"], str) or not st["role"].strip():
        c.err(f"{p}.role", "role must be non-empty text")
    elif _text_problem(st["role"], "role"):
        c.err(f"{p}.role", _text_problem(st["role"], "role"))
    else:
        info["role"] = st["role"]
    if "permission" not in st:
        c.err(f"{p}.permission", "permission is required on agent stages")
    elif st["permission"] not in PERMISSIONS:
        c.err(f"{p}.permission", "permission must be read_only or workspace_write")
    else:
        info["permission"] = st["permission"]

    if ctx["frozen"]:
        text, src = st.get("prompt"), st.get("promptSource")
        if not isinstance(text, str) or not text.strip():
            c.err(f"{p}.prompt", "frozen agent stages need non-empty prompt text")
        elif _text_problem(text):
            c.err(f"{p}.prompt", _text_problem(text))
        else:
            info["prompt"] = text
        if not isinstance(src, str) or not src:
            c.err(f"{p}.promptSource", 'promptSource must be "inline" or a prompt file path')
        else:
            info["prompt_source"] = src
        return

    has_inline, has_file = "prompt" in st, "promptFile" in st
    if has_inline == has_file:
        c.err(p, "an agent stage needs exactly one of prompt / promptFile")
    elif has_inline:
        text = st["prompt"]
        if not isinstance(text, str):
            c.err(f"{p}.prompt", "prompt must be text")
        elif not text.strip():
            c.err(f"{p}.prompt", "prompt must not be empty")
        elif _text_problem(text):
            c.err(f"{p}.prompt", _text_problem(text))
        else:
            info["prompt"], info["prompt_source"] = text, "inline"
    else:
        path, prompts = st["promptFile"], ctx["prompts"]
        if not isinstance(path, str) or not path:
            c.err(f"{p}.promptFile", "promptFile must be a relative file path")
        elif path not in prompts:
            c.err(f"{p}.promptFile", "prompt file was not loaded")
        elif isinstance(prompts[path], _Problem):
            c.err(f"{p}.promptFile", prompts[path].message)
        else:
            text = prompts[path]
            if len(text.encode("utf-8")) > MAX_PROMPT_BYTES:
                c.err(f"{p}.promptFile", "prompt file is larger than 32 KiB")
            elif not text.strip():
                c.err(f"{p}.promptFile", "prompt file is empty")
            else:
                info["prompt"], info["prompt_source"] = text, path


def _next(c: _Collector, p: str, st: dict, info: dict, ctx: dict, is_validation: bool) -> None:
    np = f"{p}.next"
    if "next" not in st:
        if not is_validation:
            c.err(np, "next is required on agent stages")
            return
        raw = {}
    else:
        raw = st["next"]
        if not isinstance(raw, dict):
            c.err(np, "next must be an object")
            return
        if not raw and not is_validation:
            c.err(np, "next must not be empty")
            return
    ok = True
    allowed = ("pass", "fail") if is_validation else ("done", "pass", "fail")
    for key in raw:
        if key not in allowed:
            c.err(f"{np}.{key}", "done is not allowed on validation stages" if key == "done"
                  else f'unknown key "{key}" in next')
            ok = False
    if "done" in raw and ("pass" in raw or "fail" in raw) and not is_validation:
        c.err(np, "done cannot be combined with pass / fail")
        ok = False
    targets = {}
    for key, val in raw.items():
        if key not in allowed:
            continue
        if not isinstance(val, str):
            c.err(f"{np}.{key}", "a target must be text")
            ok = False
        elif val not in ctx["ids"] and val not in (SUCCEED, FAIL):
            c.err(f"{np}.{key}", f'unknown target "{val}"')
            ok = False
        else:
            targets[key] = val
    if not ok:
        return
    if "done" in targets:
        info["kind"] = "work"
    else:
        info["kind"] = "validation" if is_validation else "verdict"
        default_pass = ctx["default_pass"](info["i"])
        if default_pass is not None:
            targets.setdefault("pass", default_pass)
        targets.setdefault("fail", FAIL)
    info["next"] = targets


def _pass_requires(c: _Collector, p: str, st: dict, info: dict, ctx: dict) -> None:
    pp = f"{p}.passRequires"
    val = st["passRequires"]
    if info["kind"] == "work":
        c.err(pp, "passRequires is allowed only on verdict stages")
    elif not isinstance(val, list):
        c.err(pp, "passRequires must be a list of validation stage ids")
    else:
        ok = True
        for j, ref in enumerate(val):
            if not isinstance(ref, str) or ref not in ctx["ids"]:
                c.err(f"{pp}[{j}]", f"passRequires names an unknown stage id {ref!r}")
                ok = False
            elif ref not in ctx["validation_ids"]:
                c.err(f"{pp}[{j}]", f'passRequires "{ref}" is not a validation stage')
                ok = False
        if ok:
            info["pass_requires"] = tuple(val)


# ---- whole definition ------------------------------------------------------------------------------------------

def _build(obj: Any, source: str, frozen: bool, prompts: Mapping, name: str, sha: str) -> Definition:
    c = _Collector(source)
    if not isinstance(obj, dict):
        c.err("$", "the top level must be an object")
        c.raise_if_errors()
    allowed = _FROZEN_TOP_KEYS if frozen else _TOP_KEYS
    version, description, max_steps, stages_val, warnings = None, "", DEFAULT_MAX_STEPS, None, ()
    for key, val in obj.items():
        if key not in allowed:
            c.err(key, f'unknown key "{key}"')
        elif key == "version":
            if type(val) is not int or val != 1:
                c.err(key, "version must be 1")
            else:
                version = 1
        elif key == "description":
            if not isinstance(val, str):
                c.err(key, "description must be text")
            elif _text_problem(val, "description"):
                c.err(key, _text_problem(val, "description"))
            else:
                description = val
        elif key == "maxSteps":
            if not _is_int(val) or not 1 <= val <= 100:
                c.err(key, "maxSteps must be an integer from 1 to 100")
            else:
                max_steps = val
        elif key == "stages":
            stages_val = val
        elif key == "name":
            if not isinstance(val, str) or not NAME_RE.match(val):
                c.err(key, "name must match [a-z0-9][a-z0-9-]{0,63}")
            else:
                name = val
        elif key == "sourceSha256":
            if not isinstance(val, str) or not SHA_RE.match(val):
                c.err(key, "sourceSha256 must be 64 lowercase hex digits")
            else:
                sha = val
        elif key == "warnings":
            if not isinstance(val, list) or not all(
                    isinstance(w, dict) and set(w) == {"file", "path", "line", "message"} for w in val):
                c.err(key, "warnings must be a list of {file, path, line, message} objects")
            else:
                warnings = tuple(MappingProxyType(dict(w)) for w in val)
    if not frozen:
        if not NAME_RE.match(name):
            c.err("$", f"definition name {name!r} must match [a-z0-9][a-z0-9-]{{0,63}}")
        if not SHA_RE.match(sha):
            c.err("$", "source sha256 must be 64 lowercase hex digits")
    if "version" not in obj:
        c.err("version", "version is required and must be 1")
    if "stages" not in obj:
        c.err("stages", "stages is required")
    if frozen:
        for key in ("name", "sourceSha256", "warnings"):
            if key not in obj:
                c.err(key, f"{key} is required in the frozen form")

    infos: list = []
    if "stages" in obj:
        if not isinstance(stages_val, list):
            c.err("stages", "stages must be a list")
        elif not stages_val:
            c.err("stages", "stages must not be empty")
        else:
            if len(stages_val) > MAX_STAGES:
                c.err("stages", f"a definition may have at most {MAX_STAGES} stages")
            ids = [s.get("id") if isinstance(s, dict) and isinstance(s.get("id"), str)
                   and STAGE_ID_RE.match(s["id"]) else None for s in stages_val]

            def default_pass(i: int) -> Optional[str]:
                if i + 1 >= len(ids):
                    return SUCCEED
                return ids[i + 1]

            ctx = {"frozen": frozen, "prompts": prompts, "seen": set(), "ids": {x for x in ids if x},
                   "validation_ids": {ids[i] for i, s in enumerate(stages_val)
                                      if isinstance(s, dict) and s.get("type") == "validation" and ids[i]},
                   "default_pass": default_pass}
            infos = [_stage(c, i, s, ctx) for i, s in enumerate(stages_val)]

    if not c.errors:
        _check_placeholders(c, infos, frozen)
        _graph_errors(c, infos)
    c.errors = _file_order(obj, c.errors)
    c.raise_if_errors()
    if not frozen:
        warnings = _graph_warnings(c, infos)

    stages = tuple(Stage(id=s["id"], type=s["type"], role=s["role"], permission=s["permission"],
                         prompt=s["prompt"], prompt_source=s["prompt_source"], max_visits=s["max_visits"],
                         pass_requires=s["pass_requires"], next=MappingProxyType(dict(s["next"])), kind=s["kind"])
                   for s in infos)
    return Definition(name=name, version=1, description=description, max_steps=max_steps, stages=stages,
                      source_sha256=sha, warnings=warnings)


def _edges(infos: list) -> dict:
    return {s["id"]: [t for t in s["next"].values() if t not in (SUCCEED, FAIL)] for s in infos}


def _reach(edges: dict, starts: list) -> set:
    seen, todo = set(), list(starts)
    while todo:
        cur = todo.pop()
        if cur not in seen:
            seen.add(cur)
            todo.extend(edges[cur])
    return seen


def _graph_errors(c: _Collector, infos: list) -> None:
    edges = _edges(infos)
    reached = _reach(edges, [infos[0]["id"]])
    for s in infos:
        if s["id"] not in reached:
            c.err(f"stages[{s['i']}]", f'stage "{s["id"]}" is not reachable from the first stage')
    if not any(SUCCEED in s["next"].values() for s in infos if s["id"] in reached):
        c.err("stages", "$succeed is not reachable from the first stage")


def _graph_warnings(c: _Collector, infos: list) -> tuple:
    edges = _edges(infos)
    after = {s["id"]: _reach(edges, edges[s["id"]]) for s in infos}   # reachable in one or more steps
    from_writers = set()
    for s in infos:
        if s["permission"] == "workspace_write":
            from_writers |= after[s["id"]]
    for s in infos:
        p = f"stages[{s['i']}]"
        if s["id"] in after[s["id"]] and s["max_visits"] == 1:
            c.warn(p, f'stage "{s["id"]}" can be re-entered but has maxVisits 1')
        if (s["permission"] == "read_only" and s["id"] in from_writers
                and "diff" not in promptlib.placeholders(s["prompt"])):
            c.warn(p, f'read_only stage "{s["id"]}" follows a workspace_write stage but its prompt has no '
                      f'{DIFF_PLACEHOLDER}')
    return tuple(MappingProxyType(w) for w in c.warnings)


def parse_obj(obj: Any, source: str, prompts: Optional[Mapping] = None, *, name: Optional[str] = None,
              source_sha256: Optional[str] = None) -> Definition:
    """Source form -> Definition, or AsError(WORKFLOW_DEFINITION_INVALID) listing every violation.

    name defaults to the file stem of source; source_sha256 defaults to the hash of the canonical JSON of obj.
    """
    if name is None:
        name = os.path.splitext(os.path.basename(source.split(":", 1)[-1]))[0]
    if source_sha256 is None:
        canon = json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str)
        source_sha256 = hashlib.sha256(canon.encode("utf-8", "replace")).hexdigest()
    return _build(obj, source, False, prompts or {}, name, source_sha256)


# ---- frozen form -----------------------------------------------------------------------------------------------

def to_json(d: Definition) -> str:
    stages = []
    for s in d.stages:
        item = {"id": s.id, "type": s.type, "maxVisits": s.max_visits, "next": dict(s.next)}
        if s.type == "agent":
            item.update(role=s.role, permission=s.permission, prompt=s.prompt, promptSource=s.prompt_source)
            if s.kind == "verdict":
                item["passRequires"] = list(s.pass_requires)
        stages.append(item)
    obj = {"name": d.name, "version": d.version, "description": d.description, "maxSteps": d.max_steps,
           "sourceSha256": d.source_sha256, "warnings": [dict(w) for w in d.warnings], "stages": stages}
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def from_json(obj: Any, source: str = "frozen definition") -> Definition:
    """Frozen form -> Definition. Re-runs the structural and graph checks; never touches the filesystem."""
    return _build(obj, source, True, {}, "", "")


# ---- files -----------------------------------------------------------------------------------------------------

def _hook(pairs: list) -> _Obj:
    d, dups = _Obj(), []
    for k, v in pairs:
        if k in d:
            dups.append(k)
        d[k] = v
    d.dups = dups
    return d


def _duplicates(v: Any, path: str, out: list) -> None:
    if isinstance(v, _Obj):
        where = path or "the top-level object"
        out.extend(f'duplicate key "{k}" in {where}' for k in v.dups)
        for k, child in v.items():
            _duplicates(child, f"{path}.{k}" if path else k, out)
    elif isinstance(v, list):
        for j, child in enumerate(v):
            _duplicates(child, f"{path}[{j}]", out)


def _read_prompt(base: str, rel: Any) -> Any:
    if not isinstance(rel, str) or not rel:
        return _Problem("promptFile must be a relative file path")
    path = _inside(base, rel)
    if path is None:
        return _Problem("promptFile must stay inside the .agent-studio folder (no '..', absolute path or symlink "
                        "escape)")
    if not os.path.isfile(path):
        return _Problem(f"prompt file {rel} was not found")
    try:
        with open(path, "rb") as f:
            data = f.read(MAX_PROMPT_BYTES + 1)
    except OSError as e:
        return _Problem(f"prompt file {rel} cannot be read: {e.strerror or e}")
    if len(data) > MAX_PROMPT_BYTES:
        return _Problem("prompt file is larger than 32 KiB")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return _Problem("prompt file is not valid UTF-8")


def _whole_file_error(file: str, message: str, line: Optional[int] = None) -> AsError:
    c = _Collector(file)
    c.err("$", message, line)
    try:
        c.raise_if_errors()
    except AsError as e:
        return e
    raise AssertionError("unreachable")


def _parse_file(path: str, label: str, name: str, prompt_base: str) -> Definition:
    try:
        with open(path, "rb") as f:
            raw = f.read(MAX_DEFINITION_BYTES + 1)
    except OSError as e:
        raise _whole_file_error(label, f"the definition file cannot be read: {e.strerror or e}")
    if len(raw) > MAX_DEFINITION_BYTES:
        raise _whole_file_error(label, "the definition file is larger than 64 KiB")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise _whole_file_error(label, "the definition file is not valid UTF-8")
    lines: Optional[dict] = None
    if path.endswith((".yaml", ".yml")):
        try:
            obj, lines = yamlsubset.loads_with_lines(text)
        except yamlsubset.YamlSubsetError as e:
            raise _whole_file_error(label, e.message, e.line)
        except RecursionError:
            raise _whole_file_error(label, "YAML is nested too deeply")
    else:
        try:
            obj = json.loads(text, object_pairs_hook=_hook)
        except json.JSONDecodeError as e:
            raise _whole_file_error(label, f"JSON syntax error: {e.msg}", e.lineno)
        except RecursionError:
            raise _whole_file_error(label, "JSON is nested too deeply")
        except ValueError:
            raise _whole_file_error(label, "JSON contains an integer literal that is too long")
    dups: list = []
    _duplicates(obj, "", dups)
    c = _Collector(label)
    for message in dups:
        c.err("$", message)
    prompts: dict = {}
    stages = obj.get("stages") if isinstance(obj, dict) else None
    if isinstance(stages, list):
        for st in stages:
            if isinstance(st, dict) and st.get("type", "agent") == "agent" and "promptFile" in st \
                    and "prompt" not in st:
                rel = st["promptFile"]
                key = rel if isinstance(rel, str) else None
                if key is None:
                    continue
                if key not in prompts:
                    prompts[key] = _read_prompt(prompt_base, key)
    try:
        d = parse_obj(obj, label, prompts, name=name, source_sha256=hashlib.sha256(raw).hexdigest())
    except AsError as e:
        if e.code != WORKFLOW_DEFINITION_INVALID:
            raise
        if lines is not None:
            for item in e.data["errors"] + e.data["warnings"]:
                item["line"] = _yaml_line(lines, item["path"])
        if not c.errors:
            raise
        c.errors.extend(e.data["errors"])
        c.warnings.extend(e.data["warnings"])
        c.raise_if_errors()
    c.raise_if_errors()
    if lines is not None:
        d = replace(d, warnings=tuple(MappingProxyType({**w, "line": _yaml_line(lines, w["path"])})
                                      for w in d.warnings))
    return d


def _yaml_line(lines: dict, path: str) -> int:
    """Line of the exact path in the YAML source, else of its nearest ancestor that exists (1 for the root)."""
    children: dict = {}
    for seg in lines:
        if seg:
            children.setdefault(seg[:-1], []).append(seg[-1])
    best: list = [0, 0, ()]  # [characters of path consumed, -segments, segments]

    def walk(seg: tuple, pos: int) -> None:
        if (pos, -len(seg)) > (best[0], best[1]):
            best[:] = [pos, -len(seg), seg]
        for k in children.get(seg, ()):
            token = f"[{k}]" if isinstance(k, int) else (f".{k}" if seg else k)
            end = pos + len(token)
            if path.startswith(token, pos) and (end == len(path) or path[end] in ".["):
                walk(seg + (k,), end)

    walk((), 0 if path != "$" else 1)
    return lines[best[2]]


def _locate(workspace: str, name: str, builtin_dir: Optional[str]) -> tuple:
    """-> (path, label, ext, prompt_base, builtin). Raises NOT_FOUND / AMBIGUOUS."""
    if not isinstance(name, str) or not NAME_RE.match(name):
        raise AsError(WORKFLOW_DEFINITION_NOT_FOUND,
                      f"No workflow definition named {name!r}: names match [a-z0-9][a-z0-9-]{{0,63}}.")
    folder = os.path.join(workspace, CONFIG_DIR, WORKFLOWS_DIR)
    found = [ext for ext in EXTENSIONS if os.path.isfile(os.path.join(folder, name + ext))]
    rel = lambda ext: f"{CONFIG_DIR}/{WORKFLOWS_DIR}/{name}{ext}"
    if len(found) > 1:
        files = [rel(e) for e in found]
        raise AsError(WORKFLOW_DEFINITION_AMBIGUOUS,
                      f"More than one definition file for {name!r}: {', '.join(files)}. Keep one.",
                      data={"files": files})
    if found and builtin_dir and os.path.isfile(os.path.join(builtin_dir, name + ".json")):
        raise _whole_file_error(rel(found[0]), f'the name "{name}" is reserved for a built-in definition')
    if found:
        return (os.path.join(folder, name + found[0]), rel(found[0]), found[0],
                os.path.join(workspace, CONFIG_DIR), False)
    if builtin_dir and os.path.isfile(os.path.join(builtin_dir, name + ".json")):
        return os.path.join(builtin_dir, name + ".json"), f"builtin:{name}.json", ".json", builtin_dir, True
    raise AsError(WORKFLOW_DEFINITION_NOT_FOUND, f"No workflow definition named {name!r} in "
                                                 f"{CONFIG_DIR}/{WORKFLOWS_DIR}.")


def load(workspace: str, name: str, builtin_dir: Optional[str] = None) -> Definition:
    path, label, _ext, base, _builtin = _locate(workspace, name, builtin_dir)
    return _parse_file(path, label, name, base)


def list_definitions(workspace: str, builtin_dir: Optional[str] = None) -> list:
    names: set = set()
    folder = os.path.join(workspace, CONFIG_DIR, WORKFLOWS_DIR)
    scans = [(folder, EXTENSIONS)] + ([(builtin_dir, (".json",))] if builtin_dir else [])
    for scan, exts in scans:
        try:
            entries = os.listdir(scan)
        except OSError:
            continue
        for entry in entries:
            stem, ext = os.path.splitext(entry)
            if ext in exts and os.path.isfile(os.path.join(scan, entry)):
                names.add(stem)
    out = []
    for name in sorted(names):
        files = [f"{CONFIG_DIR}/{WORKFLOWS_DIR}/{name}{e}" for e in EXTENSIONS
                 if os.path.isfile(os.path.join(folder, name + e))]
        builtin = not files
        if not NAME_RE.match(name):
            out.append(_bad_name_entry(name, files or [f"builtin:{name}.json"], builtin))
            continue
        entry = {"name": name, "files": files or [f"builtin:{name}.json"], "builtin": builtin, "description": "",
                 "stages": [], "roles": [], "errors": [], "warnings": []}
        try:
            d = load(workspace, name, builtin_dir)
            entry["description"] = d.description
            entry["stages"] = [s.id for s in d.stages]
            entry["roles"] = list(dict.fromkeys(s.role for s in d.stages if s.role))
            entry["warnings"] = [dict(w) for w in d.warnings]
        except AsError as e:
            if e.code == WORKFLOW_DEFINITION_INVALID:
                entry["errors"] = e.data["errors"]
                entry["warnings"] = e.data["warnings"]
            else:
                entry["errors"] = [{"file": e.data["files"][0] if e.data else name, "path": "$", "line": None,
                                    "message": e.message}]
        out.append(entry)
    return out


def _bad_name_entry(name: str, files: list, builtin: bool) -> dict:
    message = "the definition file name must match [a-z0-9][a-z0-9-]{0,63}"
    return {"name": name, "files": files, "builtin": builtin, "description": "", "stages": [], "roles": [],
            "errors": [{"file": files[0], "path": "$", "line": None, "message": message}], "warnings": []}
