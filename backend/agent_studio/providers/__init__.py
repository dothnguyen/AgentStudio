"""Provider registry. A provider is a package directory under providers/ that exposes ADAPTER; adding or
replacing one never requires a coordinator, runner, or workflow change."""
from __future__ import annotations

import copy
import importlib
import os
from typing import Dict, List

from .. import schema
from ..protocol import AsError
from .base import PROVIDER_UNAVAILABLE, Adapter

PEERS = ("codex", "claude", "agy", "opencode")
TEST_ONLY = ("fake",)
_HERE = os.path.dirname(os.path.abspath(__file__))


def available_ids() -> List[str]:
    return [d for d in sorted(os.listdir(_HERE))
            if d in schema.PROVIDERS and os.path.exists(os.path.join(_HERE, d, "__init__.py"))]


def get(provider_id: str, allow_test_only: bool = False) -> Adapter:
    if provider_id not in schema.PROVIDERS:
        raise AsError("BAD_REQUEST", f"Unknown provider {provider_id!r}.")
    if provider_id in TEST_ONLY and not allow_test_only:
        raise AsError("BAD_REQUEST", f"Provider {provider_id!r} is test-only.")
    if provider_id not in available_ids():
        raise AsError(PROVIDER_UNAVAILABLE, f"No adapter directory for {provider_id!r}.")
    adapter = importlib.import_module(f"{__name__}.{provider_id}").ADAPTER
    if adapter.provider_id != provider_id:
        raise AsError("BAD_ADAPTER", f"providers/{provider_id} exposes an adapter for {adapter.provider_id!r}.")
    return adapter


FIXTURE_ENV = "AGENT_STUDIO_TEST_FIXTURE_PROVIDERS"


def fixture_aliases(env: dict, debug: bool) -> Dict[str, str]:
    """Test-only: in a DEBUG coordinator, `codex=fake,claude=fake,...` runs a test-only adapter under a peer's ID
    so tests can prove every provider ID takes the identical path. Ignored by production coordinators."""
    if not debug:
        return {}
    out = {}
    for item in filter(None, (env.get(FIXTURE_ENV) or "").split(",")):
        pid, _, base = item.partition("=")
        if pid in PEERS and base in TEST_ONLY:
            out[pid] = base
    return out


def resolve(provider_id: str, allow_test_only: bool = False, fixture: str = None) -> Adapter:
    """The adapter for provider_id, or - for a test fixture alias - a test-only adapter wearing that ID."""
    if not fixture:
        return get(provider_id, allow_test_only)
    if provider_id not in PEERS or fixture not in TEST_ONLY:
        raise AsError("BAD_REQUEST", f"Invalid fixture alias {provider_id}={fixture}.")
    adapter = copy.copy(get(fixture, allow_test_only=True))
    adapter.provider_id = provider_id
    adapter.fixture_of = fixture
    return adapter


def probe_many(provider_ids, env: dict, allow_test_only: bool, aliases: Dict[str, str] = None,
               deep: bool = False) -> Dict[str, dict]:
    out = {}
    for pid in dict.fromkeys(provider_ids):
        try:
            adapter = resolve(pid, allow_test_only, (aliases or {}).get(pid))
            probe = adapter.probe(env, deep=True) if deep and adapter.supports_deep_probe() else adapter.probe(env)
            if (aliases or {}).get(pid):
                probe["fixtureOf"] = aliases[pid]
            out[pid] = probe
        except AsError as e:
            out[pid] = {"providerId": pid, "available": False, "reason": e.message, "code": e.code}
    return out
