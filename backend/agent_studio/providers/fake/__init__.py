"""Test-only fake provider. Never selectable by a production (non-debug) coordinator."""
from .adapter import FakeAdapter

ADAPTER = FakeAdapter()
