# Built-in workflow definitions

This folder holds the definitions that ship with Agent Studio (P01-S06 fills it). The loader reads only `*.json` here, so this README is never listed as a definition. The format is described in `phases/phase-01/README.md`, section B.

Operators write their own definitions in `<workspace>/.agent-studio/workflows/` as `.json`, `.yaml` or `.yml`. Both formats give the same model.

## YAML subset

YAML is read by `backend/agent_studio/yamlsubset.py`, a small stdlib parser. It accepts a documented subset that covers every definition shape and refuses everything else with the line number, rather than guessing what a full YAML parser would do.

**Accepted**

- Block mappings and block sequences, indented with spaces. A sequence may sit at the same indentation as its parent key (`stages:` then `- id: x` in column 1) or deeper; an item may start a mapping on the dash line (`- id: develop`).
- Flow mappings `{ a: b }` and flow sequences `[a, b]` that open and close on one line, nested, empty (`{}`, `[]`) or with quoted scalars.
- Plain, `'single'` (only `''` as escape) and `"double"` quoted scalars (escapes `\\ \" \n \t \uXXXX` only; a surrogate `\u` escape is an error). Scalars are single-line.
- Literal block scalars `|` and `|-` (a `#` comment may follow the indicator). Content is taken as written, `#` inside is text. `|` ends with one newline, `|-` with none. Whitespace-only lines inside are kept as empty lines.
- `#` comments, blank lines, one optional `---` before the content, `\n` and `\r\n` line breaks.
- Mapping keys are always text (`on:` is the key `"on"`, which the loader then reports as an unknown key). Plain values: `0` / `-?[1-9][0-9]*` are integers of any length (only a number past Python's own limit of 4300 digits is refused, with its line), `true` / `false` booleans, `null`, `~` or an empty value `None`; everything else is text (`$succeed`, `on`, `yes`, `no` stay text). Quoted values are always text.

**Refused** (each error names the line)

- Anchors, aliases, tags (`&`, `*`, `!`) and `%` directives.
- More than one document (`---` after content, any `...`).
- Folded scalars `>` / `>-` and block scalar indicators other than `|` / `|-` (`|+`, `|2`).
- Multi-line flow collections, multi-line plain or quoted scalars.
- Complex keys (`? `) and plain values that start with `@`, a backtick, `,`, `]`, `}`, `%`, or with `|` / `>` outside a block header.
- Values that other YAML parsers would read differently: numbers other than a plain integer (`007`, `+1`, `1.5`, `1e3`, `0x1F`, `0b101`, `1:20`, `.inf`) and `True`, `TRUE`, `False`, `FALSE`, `Null`, `NULL`. **Quote the value** to keep it as text.
- Duplicate keys, tabs in indentation, inconsistent indentation.
- Control characters other than tab and line breaks, a lone CR, a leading byte-order mark.
- Nesting deeper than 32 levels.
- A document whose root is not a block mapping, including an empty document.

**Why `next` and not `on`**: YAML 1.1 parsers read an unquoted `on:` as the boolean `true`, so a key named `on` would silently change meaning between tools. The key is `next`.
