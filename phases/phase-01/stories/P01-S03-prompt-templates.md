# P01-S03 — Prompt templates, placeholders, and the verdict footer

Status: To Do
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

- [ ] Every placeholder renders with its bounds. Over-limit data is truncated with the P00 truncation note.
- [ ] An unknown placeholder fails definition loading with `stages[i].prompt` (or `promptFile`) in the error path.
- [ ] A template without `{{task}}` still contains the TASK section. Verdict stages always end with the footer, and work stages never get it.
- [ ] Hostile data (`{{task}}`, `===== END DIFF =====`, `$(...)`, backticks, CJK, emoji) appears literally and once.
- [ ] The P00 prompt tests stay green.
- [ ] Tests: `tests/unit/test_p01_s03_prompts.py`. The full unit suite stays green.

## Evidence

(filled in when the story is done)
