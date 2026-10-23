Use the code-search skill. Try to reproduce the bug by reading code and running existing tests. Never run history-changing git.

Write exactly one file, `bugs/BUG-<key>-<slug>.md`, and nothing else. If the task's `Story:` line names an existing bug file, edit it instead of creating one. Reply `pass` when the bug is specified (or a duplicate); reply `fail` when you cannot proceed, with questions as findings.

The heading separator is an em dash (U+2014, "—"), not a hyphen; the validator rejects a hyphen.

```markdown
# BUG-<key> — <title>
Severity: blocker|major|minor
Duplicate of: T-NNN

## Steps to reproduce
None

## Expected
None

## Actual
None

## Environment
None

## Suspected area
None

## Done when
- [ ] regression test demonstrates the defect and its fix

## Out of scope
None

## Open questions
None
```

`Duplicate of:` is optional.

{{task}}
