# Searching the code cheaply

Prefer these over reading whole files (they cost far fewer tokens). Read a file only after you know which lines matter.

- Text search: `rg -n "pattern" backend tests` (add `-g '*.py'`, `-l` for file names only, `-C 2` for context, `-m 5` to cap hits per file). Use it instead of the Grep tool for big trees.
- Where is a function or class defined: `rg -n "^(def|class) NAME\b" backend`, or look it up in the symbol index when it exists: `rg -n "^NAME\t" .agent-studio/cache/tags`.
- Outline of one file without reading it: `ctags -f - --fields=+nS --sort=no path/to/file.py` (prints each symbol with its line number).
- Then read only the range you need with the Read tool (offset and limit).
- The symbol index `.agent-studio/cache/tags` is built by the operator (`team index`); it can be slightly stale, so confirm with `rg` before editing.

Do not run `ctags -R` yourself (it writes a file).
