# Testing in this repository

- Python stdlib unittest only. Unit tests: tests/unit/test_*.py (fast, no tmux, no coordinator).
  Integration tests: tests/integration/test_*.py (real shim, isolated Sandbox from tests/helpers.py).
- Run unit tests: python3 -m unittest discover -s tests/unit -t .
- Run one module:  python3 -m unittest tests.unit.test_s09_claude
- Use tests.helpers.Sandbox for anything that starts the coordinator; never touch the real ~/.local/state.
- Fixtures for provider output live in tests/fixtures/<provider>/ (captured from the real CLI; do not invent shapes).
- Name tests after the behaviour: test_<what>_<expected>.
