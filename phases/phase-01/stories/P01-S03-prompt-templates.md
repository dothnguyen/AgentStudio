# P01-S03 — Prompt templates, placeholders, and the verdict footer

Status: Done (2026-10-22)
Depends on: P01-S01
Architecture: [P01 design contract](../README.md#c-prompts), section C

## Goal

Render each stage's prompt template into the final stage prompt: placeholders filled with bounded data sections, the operator's task always present, and the fixed verdict footer added on verdict stages. This replaces P00's hard-coded `TEMPLATES` / `compose_prompt` with a pure, testable renderer. No engine wiring happens in this story.

## Implement in this order

1. Create `backend/agent_studio/prompts.py` with `placeholders(template) -> set[str]` and `render(template, *, kind, task, diff=None, validation=None, findings=None, summary=None, stage, visit) -> str`.
2. Recognise `{{name}}` with optional inner spaces (`{{ task }}`). Allowed names: `task`, `diff`, `validation`, `findings`, `summary`, `stage`, `visit`. Wire `placeholders` into the S01 validation hook so an unknown name fails loading with the stage's path.
3. Data placeholders expand to `===== NAME ===== … ===== END NAME =====` sections. Move `_section` and `PROMPT_LIMITS` from `workflow.py` into `prompts.py` and add `summary: 16 KiB`. `stage` and `visit` expand inline. A missing value yields the documented empty text (`(no changes)`, `(not run yet)`, `(none)`).
4. Single-pass substitution. Data that itself contains `{{task}}` or `===== END TASK =====` is inserted literally and never re-expanded.
5. If the template does not mention `{{task}}`, append the TASK section. On `kind == "verdict"`, append the fixed footer (the exact P00 reviewer sentence about one final JSON line).
6. Keep `workflow.compose_prompt` working for P00 by having it call `render`. Its output for the four P00 stages must be byte-identical to today's, or the P00 tests' expected strings are updated with a recorded reason.

## Done when

- [x] Every placeholder renders with its bounds. Over-limit data is truncated with the P00 truncation note.
- [x] An unknown placeholder fails definition loading with `stages[i].prompt` (or `promptFile`) in the error path.
- [x] A template without `{{task}}` still contains the TASK section. Verdict stages always end with the footer, and work stages never get it.
- [x] Hostile data (`{{task}}`, `===== END DIFF =====`, `$(...)`, backticks, CJK, emoji) appears literally and once.
- [x] The P00 prompt tests stay green.
- [x] Tests: `tests/unit/test_p01_s03_prompts.py`. The full unit suite stays green.

## Evidence

- Tests: `python3 -m unittest discover -s tests/unit -t .` → 293 tests OK (5 skipped), including 31 new in
  `tests/unit/test_p01_s03_prompts.py`. P00 integration: `tests.integration.test_s06_workflow` (10) and
  `test_s07_recovery` (17) OK.
- Added: `backend/agent_studio/prompts.py` (`placeholders`, `render`, `section`, `PROMPT_LIMITS` incl. `summary`,
  `VERDICT_FOOTER`). Changed: `workflow.py` (`compose_prompt` calls `render`; `_section` and `PROMPT_LIMITS` removed),
  `workflowdef.py` (`_check_placeholders` rejects unknown names at `stages[i].prompt` / `.promptFile`; the
  "no `{{diff}}`" warning now also accepts `{{ diff }}`).
- Placeholder names are identifiers (`[A-Za-z_][A-Za-z0-9_]*`). Anything else in double braces (`{{}}`,
  `{{"a":1}}`, `{{a b}}`) is ordinary text, so JSON-like content in a template is not rejected.
- P00 byte-identity: developer and repair prompts are byte-identical (tested). **Recorded change:** the reviewer
  prompt is not. P00 put the JSON-verdict sentence inside the template before the data sections; the contract says
  verdict stages always end with the footer, so the sentence now comes last and `TEMPLATES["reviewer"]` no longer
  contains it. Content is the same; only its position moved. `test_s06_parts` only checks that "JSON" appears, and
  the new `P00Compatibility` tests pin the new shape.
- Edge: P00 gave an empty `validation_text` an empty section; it now reads `(not run yet)`.
- Not done here (by design): engine wiring (S04–S06 call `render` with stage kind, visit and summary).
