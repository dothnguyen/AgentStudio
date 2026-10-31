"""Helpers shared by real-CLI adapters (S08+): quiet subprocess runs for inspection, and the deep-probe cache.
Nothing provider-specific lives here."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from datetime import datetime, timedelta, timezone
from typing import Iterable, Optional

from ..protocol import AsError
from .base import AssignmentInput, ParseState

DEEP_PROBE_TTL_S = 24 * 3600
PROBE_TOKEN = "AGENT_STUDIO_OK"

AUTH_RE = re.compile(r"not logged in|/login|invalid api key|authentication_error|oauth token|\b401\b", re.I)
LIMIT_RE = re.compile(
    r"(?:rate[ -]?limit|usage[ -]?limit|quota)\s*(?:has been |is )?(?:reached|exceeded)"
    r"|\b(?:you(?:'ve| have)\s+)?(?:hit|reached|exceeded)\s+(?:your\s+)?"
    r"(?:current\s+)?(?:weekly|daily|monthly|session|usage|rate|quota)\s*(?:limit)?\b"
    r"|\b\d+[- ]hour\s+limit\s+(?:reached|exceeded|hit)\b"
    r"|\binsufficient_quota\b"
    r"|too many requests|\b429\b", re.I)
EPOCH_RE = re.compile(r"\b(1\d{9}(?:\.\d+)?)\b")
CLOCK_RE = re.compile(r"\b(\d{1,2}:\d{2}(?::\d{2})?\s*(?:UTC|GMT|[+-]\d{2}:?\d{2}))\b", re.I)
# Claude: "resets 5:40pm (Australia/Brisbane)", "resets Oct 29, 5am (Australia/Brisbane)"
ZONED_RE = re.compile(
    r"\bresets\s+(?:at\s+)?(?:(?P<mon>jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(?P<day>\d{1,2}),?\s+)?"
    r"(?P<h>\d{1,2})(?::(?P<m>\d{2}))?\s*(?P<ampm>am|pm)?\s*\((?P<tz>[A-Za-z_]+(?:/[A-Za-z0-9_+-]+)+|UTC)\)", re.I)
MONTHS = ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _zoned_reset(text: str) -> Optional[str]:
    """A local reset time with an IANA zone, as the next such moment (or the dated one) in UTC; None if unclear."""
    m = ZONED_RE.search(text)
    if not m:
        return None
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(m.group("tz"))
    except Exception:  # no tzdata, unknown zone, Python < 3.9: never guess
        return None
    hour, minute, ampm = int(m.group("h")), int(m.group("m") or 0), (m.group("ampm") or "").lower()
    if ampm:
        if not 1 <= hour <= 12:
            return None
        hour = hour % 12 + (12 if ampm == "pm" else 0)
    elif m.group("m") is None or hour > 23:   # a bare number with no am/pm and no minutes is not a time
        return None
    if minute > 59:
        return None
    local_now = _now().astimezone(tz)
    try:
        if m.group("mon"):
            month, day = MONTHS.index(m.group("mon")[:3].lower()) + 1, int(m.group("day"))
            when = datetime(local_now.year, month, day, hour, minute, tzinfo=tz)
            if when < local_now - timedelta(days=180):   # "Jan 2" seen in late December
                when = when.replace(year=when.year + 1)
        else:
            when = local_now.replace(hour=hour, minute=minute, second=0, microsecond=0)
            if when <= local_now:
                when += timedelta(days=1)
    except ValueError:
        return None
    return when.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def limit_reset_at(text: Optional[str]) -> Optional[str]:
    """Best-effort normalization of provider-supplied reset hints; never invent a time."""
    epoch = EPOCH_RE.search(text or "")
    if epoch:
        try:
            return datetime.fromtimestamp(float(epoch.group(1)), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        except (OverflowError, OSError, ValueError):
            pass
    clock = CLOCK_RE.search(text or "")
    if clock:
        value = clock.group(1).replace("GMT", "UTC").upper().replace("UTC", "+00:00")
        for fmt in ("%H:%M%z", "%H:%M:%S%z"):
            try:
                return datetime.strptime(value.replace(" ", ""), fmt).replace(
                    year=datetime.now(timezone.utc).year,
                    month=datetime.now(timezone.utc).month,
                    day=datetime.now(timezone.utc).day,
                ).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            except ValueError:
                pass
    return _zoned_reset(text or "")


def short(text, n: int = 300) -> str:
    return " ".join(str(text).split())[:n]


def run_quiet(argv, env: dict, keys: Iterable[str], timeout: float = 30, cwd: Optional[str] = None):
    """Run an inspection command with only allowlisted environment keys. Returns CompletedProcess or raises
    OSError / SubprocessError."""
    run_env = {k: env[k] for k in keys if k in env}
    return subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          env=run_env, timeout=timeout, cwd=cwd or tempfile.gettempdir())


def _cache_path() -> Optional[str]:
    from .. import paths
    try:
        return os.path.join(paths.ensure_state_dir(), "provider-probes.json")
    except AsError:
        return None


def cached_deep(key: str) -> Optional[dict]:
    path = _cache_path()
    try:
        with open(path, encoding="utf-8") as f:
            entry = json.load(f).get(key)
    except (OSError, ValueError, TypeError):
        return None
    if entry and time.time() - entry.get("at", 0) < DEEP_PROBE_TTL_S:
        return entry
    return None


def _store(key: str, entry: dict) -> None:
    path = _cache_path()
    if not path:
        return
    try:
        with open(path, encoding="utf-8") as f:
            cache = json.load(f)
    except (OSError, ValueError):
        cache = {}
    cache[key] = entry
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cache, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def deep_probe(adapter, env: dict, key: str, timeout: float = 180) -> dict:
    """Prove authentication with a disposable read-only micro-task through the adapter's own prepare/parse."""
    ws = tempfile.mkdtemp(prefix=f"agent-studio-{adapter.provider_id}-probe-")
    prompt = os.path.join(ws, ".prompt")
    with open(prompt, "w", encoding="utf-8") as f:
        f.write(f"Reply with exactly {PROBE_TOKEN} and nothing else. Do not run commands or edit files.")
    inp = AssignmentInput(assignment_id="00000000-0000-4000-8000-000000000000",
                          agent_id="00000000-0000-4000-8000-000000000000", provider_id=adapter.provider_id, attempt=1,
                          workspace=ws, prompt_path=prompt, role_instructions="", policy="read_only",
                          deadline_s=timeout, output_budget_bytes=1 << 20)
    st = ParseState()
    started = time.time()
    try:
        prep = adapter.prepare(inp, env)
        with open(prompt, "rb") as stdin:
            p = subprocess.run(prep.argv, stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               cwd=prep.cwd, env=prep.environment(env), timeout=timeout)
        for line in p.stdout.splitlines():
            adapter.parse_line(line, st)
        ok = bool(st.terminal and st.terminal.get("ok")) and PROBE_TOKEN in (st.final_text or "")
        detail = "ok" if ok else short((st.terminal or {}).get("summary") or p.stderr.decode("utf-8", "replace")
                                       or f"exit {p.returncode}")
    except subprocess.TimeoutExpired:
        ok, detail = False, f"timed out after {timeout:g}s (network or authentication problem?)"
    except AsError as e:
        ok, detail = False, e.message
    finally:
        shutil.rmtree(ws, ignore_errors=True)
    entry = {"ok": ok, "detail": detail, "at": time.time(), "seconds": round(time.time() - started, 1)}
    _store(key, entry)
    return entry


def apply_deep(out: dict, adapter, info: dict, env: dict, deep: bool) -> dict:
    """Add the (cached or fresh) authentication proof to a probe result."""
    key = f"{adapter.provider_id}:{info['path']}:{info['version']}"
    entry = deep_probe(adapter, env, key) if deep else cached_deep(key)
    out["authVerified"] = bool(entry and entry.get("ok"))
    if entry:
        out["deepProbe"] = entry
        if not entry.get("ok"):
            out.update(available=False, code="AUTH_REQUIRED",
                       reason=f"{adapter.provider_id} could not complete a read-only micro-task: {entry.get('detail')}")
    return out
