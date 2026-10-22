"""A strict, stdlib-only YAML subset for workflow definitions (P01-S02).

    loads(text)             -> dict / list / str / int / bool / None
    loads_with_lines(text)  -> (value, {path segments: 1-based line})
    YamlSubsetError         .line (1-based) and .message

Anything outside the documented subset is refused with the line of the offending construct; nothing is guessed.
The accepted and refused forms are listed in backend/agent_studio/workflows/README.md.
"""
from __future__ import annotations

import re
from typing import Any

MAX_DEPTH = 32

_BAD_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ud800-\udfff]|\r(?!\n)")
_COMMENT = re.compile(r"[ \t]#")
_COLON = re.compile(r":(?: |$)")
_BLOCK_HEADER = re.compile(r"\|(-?)(?:[ \t]+#.*)?[ \t]*")
_INT = re.compile(r"0|-?[1-9][0-9]*")
_NUMBER_LIKE = re.compile(
    r"[-+]?(?:\.[0-9][0-9_]*|[0-9][0-9_]*(?:\.[0-9_]*)?)(?:[eE][-+]?[0-9]+)?"
    r"|[-+]?0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|[-+]?0[bB][01_]+|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+(?:\.[0-9_]*)?"
    r"|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN)")
_ESCAPES = {"\\": "\\", '"': '"', "n": "\n", "t": "\t"}
_HEX = "0123456789abcdefABCDEF"


class YamlSubsetError(Exception):
    def __init__(self, line: int, message: str):
        super().__init__(f"line {line}: {message}")
        self.line = line
        self.message = message


# ---- scalars ---------------------------------------------------------------------------------------------------

def _start_problem(t: str):
    """Why a plain scalar cannot start with t[0], else None."""
    c, nxt = t[0], t[1:2]
    if c in "&*":
        return "anchors and aliases are not supported"
    if c == "!":
        return "tags are not supported"
    if c == "%":
        return "% directives are not supported"
    if c == "?" and nxt in ("", " "):
        return "complex keys ('? ') are not supported"
    if c in "@`":
        return f"a plain value cannot start with {c!r}; quote it"
    if c in ",]}":
        return f"unexpected {c!r}"
    if c in "|>":
        return "'|' and '>' can only start a literal block scalar after a key"
    if c == "-" and nxt in ("", " "):
        return "a sequence item is not allowed here"
    if c == ":" and nxt in ("", " "):
        return "unexpected ':'"
    return None


def _resolve(text: str, line: int) -> Any:
    """Type of a plain scalar value. Forms YAML would read differently are refused."""
    if text in ("true", "false"):
        return text == "true"
    if text in ("null", "~"):
        return None
    if text in ("True", "TRUE", "False", "FALSE", "Null", "NULL"):
        raise YamlSubsetError(line, f"{text} is read differently by other YAML parsers; write it in lowercase or "
                                    f"quote it")
    if _INT.fullmatch(text):
        try:
            return int(text)
        except ValueError:  # beyond the interpreter's integer digit limit
            raise YamlSubsetError(line, "the integer is too large; quote it if it is text")
    if _NUMBER_LIKE.fullmatch(text):
        raise YamlSubsetError(line, f"{text} would be read as a number by other YAML parsers; only plain integers "
                                    f"are supported here, quote the value to keep it as text")
    return text


def _quoted(s: str, pos: int, line: int) -> tuple:
    """Parse the quoted scalar that starts at s[pos]; -> (text, position after the closing quote)."""
    n, i, out = len(s), pos + 1, []
    if s[pos] == "'":
        while i < n:
            ch = s[i]
            if ch == "'":
                if s[i + 1:i + 2] == "'":
                    out.append("'")
                    i += 2
                    continue
                return "".join(out), i + 1
            out.append(ch)
            i += 1
    else:
        while i < n:
            ch = s[i]
            if ch == '"':
                return "".join(out), i + 1
            if ch == "\\":
                e = s[i + 1:i + 2]
                if e in _ESCAPES:
                    out.append(_ESCAPES[e])
                    i += 2
                    continue
                if e == "u":
                    h = s[i + 2:i + 6]
                    if len(h) != 4 or any(c not in _HEX for c in h):
                        raise YamlSubsetError(line, "\\u needs four hex digits")
                    cp = int(h, 16)
                    if 0xD800 <= cp <= 0xDFFF:
                        raise YamlSubsetError(line, "a \\u escape of a surrogate is not allowed")
                    out.append(chr(cp))
                    i += 6
                    continue
                raise YamlSubsetError(line, f"unsupported escape '\\{e}' (only \\\\ \\\" \\n \\t \\uXXXX)")
            out.append(ch)
            i += 1
    raise YamlSubsetError(line, "unterminated quoted scalar (multi-line scalars are not supported)")


def _skip(s: str, pos: int) -> int:
    while pos < len(s) and s[pos] in " \t":
        pos += 1
    return pos


def _is_dash(t: str) -> bool:
    return t == "-" or t.startswith("- ")


def _join(path: tuple, key: str) -> tuple:
    return path + (key,)


def _path_text(path: tuple) -> str:
    out = ""
    for seg in path:
        out += f"[{seg}]" if isinstance(seg, int) else (f".{seg}" if out else seg)
    return out


def _dup_message(key: str, path: tuple) -> str:
    return f'duplicate key "{key}" in ' + (_path_text(path) if path else "the top-level object")


# ---- parser ----------------------------------------------------------------------------------------------------

class _Parser:
    def __init__(self, text: str):
        if text.startswith("﻿"):
            raise YamlSubsetError(1, "a byte-order mark is not allowed")
        m = _BAD_CHARS.search(text)
        if m:
            ch = m.group()
            raise YamlSubsetError(text.count("\n", 0, m.start()) + 1,
                                  "a lone carriage return is not allowed" if ch == "\r"
                                  else f"control character U+{ord(ch):04X} is not allowed")
        self.raw = [ln[:-1] if ln.endswith("\r") else ln for ln in text.split("\n")]
        self._markers()
        self.ind, self.txt, self.skip, self.tab = [], [], [], []
        for ln in self.raw:
            body = ln.lstrip(" ")
            t = body.rstrip(" \t")
            self.ind.append(len(ln) - len(body))
            self.txt.append(t)
            self.tab.append(t.startswith("\t"))
            self.skip.append(t == "" or t.lstrip(" \t").startswith("#"))
        self.i = 0
        self.lm: dict = {(): 1}

    def _markers(self) -> None:
        """Reject directives and extra documents; blank out one optional leading '---'."""
        seen_content = seen_marker = False
        for i, ln in enumerate(self.raw):
            if ln.startswith("%"):
                raise YamlSubsetError(i + 1, "% directives are not supported")
            if ln[:3] in ("---", "...") and (len(ln) == 3 or ln[3] in " \t"):
                tail = ln[3:].strip(" \t")
                if ln[:3] == "...":
                    raise YamlSubsetError(i + 1, "the document end marker '...' is not supported")
                if seen_content or seen_marker:
                    raise YamlSubsetError(i + 1, "multiple documents are not supported")
                if tail and not tail.startswith("#"):
                    raise YamlSubsetError(i + 1, "'---' must be on a line of its own")
                seen_marker = True
                self.raw[i] = ""
            elif ln.strip(" \t") and not ln.lstrip(" \t").startswith("#"):
                seen_content = True

    def _fail(self, i: int, message: str):
        raise YamlSubsetError(i + 1, message)

    def _sig(self):
        """Index of the next line with content (skipping blanks and comments), or None; does not consume it."""
        i = self.i
        while i < len(self.raw) and self.skip[i]:
            i += 1
        self.i = i
        if i >= len(self.raw):
            return None
        if self.tab[i]:
            self._fail(i, "tabs are not allowed in indentation")
        return i

    def parse(self) -> Any:
        i = self._sig()
        if i is None:
            raise YamlSubsetError(1, "the document is empty; it must be a block mapping")
        if _is_dash(self.txt[i]) or self._split_key(i, self.txt[i]) is None:
            self._fail(i, "the document must be a block mapping (key: value lines)")
        root = self._mapping(self.ind[i], (), 1)
        j = self._sig()
        if j is not None:
            self._fail(j, "inconsistent indentation")
        return root

    # -- block structure --

    def _split_key(self, i: int, t: str):
        """A mapping entry on this text -> (key, rest of the line); None when it is not one."""
        line = i + 1
        if t[0] in "[{|>":
            return None
        if t[0] in "\"'":
            key, pos = _quoted(t, 0, line)
            after = t[pos:].lstrip(" \t")
            if after[:1] != ":" or (len(after) > 1 and after[1] != " "):
                return None
            return key, after[1:].lstrip(" \t")
        problem = _start_problem(t)
        if problem:
            raise YamlSubsetError(line, problem)
        m = _COMMENT.search(t)
        k = _COLON.search(t[:m.start()] if m else t)
        if k is None:
            return None
        return t[:k.start()].rstrip(" \t"), t[k.end():].lstrip(" \t")

    def _mapping(self, n: int, path: tuple, depth: int) -> dict:
        if depth > MAX_DEPTH:
            self._fail(self.i, f"nesting is deeper than {MAX_DEPTH} levels")
        out: dict = {}
        while True:
            i = self._sig()
            if i is None or self.ind[i] < n:
                return out
            if self.ind[i] > n:
                self._fail(i, "inconsistent indentation (a line must align with an open block; multi-line scalars "
                              "are not supported)")
            t = self.txt[i]
            if _is_dash(t):
                self._fail(i, "a sequence item cannot appear among mapping keys")
            entry = self._split_key(i, t)
            if entry is None:
                self._fail(i, "expected 'key: value' (multi-line scalars are not supported)")
            key, rest = entry
            if key in out:
                self._fail(i, _dup_message(key, path))
            kp = _join(path, key)
            self.lm[kp] = i + 1
            out[key] = None
            self.i = i + 1
            out[key] = self._value(rest, i, n, kp, depth + 1, True)

    def _sequence(self, n: int, path: tuple, depth: int) -> list:
        if depth > MAX_DEPTH:
            self._fail(self.i, f"nesting is deeper than {MAX_DEPTH} levels")
        out: list = []
        while True:
            i = self._sig()
            if i is None or self.ind[i] != n or not _is_dash(self.txt[i]):
                return out
            ip = path + (len(out),)
            self.lm[ip] = i + 1
            body = self.txt[i][1:]
            stripped = body.lstrip(" ")
            col = n + 1 + len(body) - len(stripped)
            if stripped.startswith("\t"):
                self._fail(i, "tabs are not allowed in indentation")
            if stripped == "" or stripped[0] == "#":
                self.i = i + 1
                out.append(self._value("", i, n, ip, depth + 1, False))
            elif _is_dash(stripped) or self._split_key(i, stripped) is not None:
                # a collection that starts on the dash line: treat the rest as a line indented to its column
                self.ind[i], self.txt[i] = col, stripped
                self.i = i
                out.append(self._block(col, ip, depth + 1))
            else:
                self.i = i + 1
                out.append(self._inline(stripped, i, n, ip, depth + 1))

    def _block(self, m: int, path: tuple, depth: int) -> Any:
        if _is_dash(self.txt[self.i]):
            return self._sequence(m, path, depth)
        return self._mapping(m, path, depth)

    def _value(self, rest: str, i: int, n: int, path: tuple, depth: int, indentless: bool) -> Any:
        """The value after 'key:' or '-'. n is the indent of the owning mapping / sequence."""
        if rest == "" or rest[0] == "#":
            j = self._sig()
            if j is None:
                return None
            m = self.ind[j]
            if m > n:
                return self._block(m, path, depth)
            if indentless and m == n and _is_dash(self.txt[j]):
                return self._sequence(n, path, depth)
            return None
        return self._inline(rest, i, n, path, depth)

    def _inline(self, s: str, i: int, n: int, path: tuple, depth: int) -> Any:
        line = i + 1
        c = s[0]
        if c in "\"'":
            v, pos = _quoted(s, 0, line)
            self._tail(s[pos:], line)
            return v
        if c in "[{":
            v, pos = self._flow_value(s, 0, line, path, depth)
            self._tail(s[pos:], line)
            return v
        if c == "|":
            m = _BLOCK_HEADER.fullmatch(s)
            if m is None:
                raise YamlSubsetError(line, "only the block scalar indicators '|' and '|-' are supported")
            return self._block_scalar(i, n, m.group(1) == "-")
        if c == ">":
            raise YamlSubsetError(line, "folded scalars ('>') are not supported; use '|'")
        problem = _start_problem(s)
        if problem:
            raise YamlSubsetError(line, problem)
        m = _COMMENT.search(s)
        text = (s[:m.start()] if m else s).rstrip(" \t")
        if _COLON.search(text):
            raise YamlSubsetError(line, "a plain value cannot contain ': ' or end with ':'; quote it")
        return _resolve(text, line)

    @staticmethod
    def _tail(rest: str, line: int) -> None:
        if rest and not (rest[0] in " \t" and rest.lstrip(" \t")[:1] in ("", "#")):
            raise YamlSubsetError(line, "unexpected text after the value")

    def _block_scalar(self, i: int, n: int, strip: bool) -> str:
        raw = self.raw
        start = i + 1
        k = start
        while k < len(raw) and raw[k].strip(" \t") == "":
            k += 1
        c = (len(raw[k]) - len(raw[k].lstrip(" "))) if k < len(raw) else 0
        if k >= len(raw) or c <= n:
            self._fail(i, "a block scalar needs content indented deeper than its key")
        out: list = []
        m = start
        while m < len(raw):
            r = raw[m]
            if r.strip(" \t") == "":
                out.append("")
            elif len(r) - len(r.lstrip(" ")) < c:
                break
            else:
                out.append(r[c:])
            m += 1
        while out and out[-1] == "":
            out.pop()
        self.i = m
        text = "\n".join(out)
        return text if strip else text + "\n"

    # -- flow collections (one line) --

    def _flow_value(self, s: str, pos: int, line: int, path: tuple, depth: int) -> tuple:
        pos = _skip(s, pos)
        if pos >= len(s):
            raise YamlSubsetError(line, "a flow collection must open and close on one line")
        c = s[pos]
        if c == "[":
            return self._flow_seq(s, pos, line, path, depth)
        if c == "{":
            return self._flow_map(s, pos, line, path, depth)
        if c in "\"'":
            return _quoted(s, pos, line)
        text, pos = self._flow_plain(s, pos, line)
        return _resolve(text, line), pos

    @staticmethod
    def _flow_plain(s: str, pos: int, line: int) -> tuple:
        """A plain scalar inside a flow collection -> (text, position of the character that ended it)."""
        if s[pos] == "#":
            raise YamlSubsetError(line, "unexpected '#' in a flow collection")
        problem = _start_problem(s[pos:])
        if problem:
            raise YamlSubsetError(line, problem)
        n, j = len(s), pos
        while j < n:
            ch = s[j]
            if ch in ",[]{}":
                break
            if ch == ":" and (j + 1 >= n or s[j + 1] in " ,]}"):
                break
            if ch == "#" and s[j - 1] in " \t":
                break
            j += 1
        text = s[pos:j].rstrip(" \t")
        if text == "":
            raise YamlSubsetError(line, f"unexpected {s[pos]!r} in a flow collection")
        return text, j

    def _flow_seq(self, s: str, pos: int, line: int, path: tuple, depth: int) -> tuple:
        if depth > MAX_DEPTH:
            raise YamlSubsetError(line, f"nesting is deeper than {MAX_DEPTH} levels")
        out: list = []
        pos = _skip(s, pos + 1)
        if s[pos:pos + 1] == "]":
            return out, pos + 1
        while True:
            ip = path + (len(out),)
            self.lm[ip] = line
            v, pos = self._flow_value(s, pos, line, ip, depth + 1)
            out.append(v)
            pos = _skip(s, pos)
            ch = s[pos:pos + 1]
            if ch == ",":
                pos = _skip(s, pos + 1)
                continue
            if ch == "]":
                return out, pos + 1
            raise YamlSubsetError(line, "expected ',' or ']' in a flow sequence (flow collections must open and "
                                        "close on one line)")

    def _flow_map(self, s: str, pos: int, line: int, path: tuple, depth: int) -> tuple:
        if depth > MAX_DEPTH:
            raise YamlSubsetError(line, f"nesting is deeper than {MAX_DEPTH} levels")
        out: dict = {}
        pos = _skip(s, pos + 1)
        if s[pos:pos + 1] == "}":
            return out, pos + 1
        while True:
            first = s[pos:pos + 1]
            if first == "":
                raise YamlSubsetError(line, "a flow collection must open and close on one line")
            if first in ("[", "{"):
                raise YamlSubsetError(line, "a flow collection cannot be a key")
            if first in ("\"", "'"):
                key, pos = _quoted(s, pos, line)
            else:
                key, pos = self._flow_plain(s, pos, line)
            pos = _skip(s, pos)
            if s[pos:pos + 1] != ":":
                raise YamlSubsetError(line, "expected ':' after a key in a flow mapping")
            if key in out:
                raise YamlSubsetError(line, _dup_message(key, path))
            kp = _join(path, key)
            self.lm[kp] = line
            pos = _skip(s, pos + 1)
            if s[pos:pos + 1] in (",", "}"):
                out[key] = None
            else:
                out[key], pos = self._flow_value(s, pos, line, kp, depth + 1)
            pos = _skip(s, pos)
            ch = s[pos:pos + 1]
            if ch == ",":
                pos = _skip(s, pos + 1)
                continue
            if ch == "}":
                return out, pos + 1
            raise YamlSubsetError(line, "expected ',' or '}' in a flow mapping (flow collections must open and "
                                        "close on one line)")


def loads_with_lines(text: str) -> tuple:
    """-> (value, line map). The map has an entry for `()` (the root) and for every mapping value / sequence item."""
    p = _Parser(text)
    value = p.parse()
    return value, p.lm


def loads(text: str) -> Any:
    return loads_with_lines(text)[0]
