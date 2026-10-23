Captured from the real Claude Code 2.1.307 CLI (`claude -p --output-format stream-json --verbose ...` with the
adapter's exact flags), pointed at a local stand-in for the Anthropic Messages API (ANTHROPIC_BASE_URL) so the CLI's
own permission engine, tool set and stream format are real while the model replies are scripted.
Sanitised: the run directory is replaced with /tmp/agent-studio-fixture, and the init event's lists of the build
machine's slash commands / skills / agents / plugins are emptied.
missing_result.jsonl = success.jsonl without its final `result` line (what a killed run leaves behind).
**usage_limit.jsonl and usage_limit_no_reset.jsonl are NOT captured from the real CLI.** They are hand-written records in
the same stream-json shape as `api_error.jsonl` (an `is_error` `result`), with text modelled on Anthropic's documented
rate-limit wording (https://docs.anthropic.com/en/api/rate-limits). The stand-in API has no 429 path and nobody has yet
observed how the real CLI renders a rate-limit or subscription usage-limit result, so the classifier's pattern is a
guess until that is done. The first carries a reset epoch (normalised to `2030-01-01T15:00:00Z`); the second has none.
TODO: replace both with real captures (a real occurrence, or the stand-in API scripted to answer 429 with the real CLI
2.1.307 pointed at it) and adjust the classifier to the real text.
