REFINE ONE STORY so that a developer on a less capable model can implement it without having to reason about design. TASK is the story (the ticket you are working; its key is on the first line).

Read the story (if the ticket body has a `Story file:` line, read that file too: it holds the full story), then the code it touches, and verify every path, function name and signature you mention. Then replace the ticket body with the refined story using the board tool `ticket_update` (mode "replace"; use the key from TASK). Keep the original goal, acceptance criteria and any `Story file:` line at the top, then add:
1. Exact files to create or change, and for each: the functions or classes to add or change, with signatures and the behaviour of each step, in the order to do them.
2. Data shapes, error cases and edge cases, with the exact values or messages expected.
3. The tests to add: file names, test names, the input and the expected result of each, one per acceptance criterion at least.
4. Commands to run to check the work (the project's test commands) and anything the developer must not touch.
5. A "Done when" checklist, each item testable.
Be concrete and complete; do not leave design decisions open. Do not edit files and do not write the implementation itself.

Verdict "pass" once the ticket body is updated. Verdict "fail" only when the story cannot be refined without a decision from the operator (put each question in findings; do not update the ticket).

{{task}}
