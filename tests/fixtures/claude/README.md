Captured from the real Claude Code 2.1.307 CLI (`claude -p --output-format stream-json --verbose ...` with the
adapter's exact flags), pointed at a local stand-in for the Anthropic Messages API (ANTHROPIC_BASE_URL) so the CLI's
own permission engine, tool set and stream format are real while the model replies are scripted.
Sanitised: the run directory is replaced with /tmp/agent-studio-fixture, and the init event's lists of the build
machine's slash commands / skills / agents / plugins are emptied.
missing_result.jsonl = success.jsonl without its final `result` line (what a killed run leaves behind).
