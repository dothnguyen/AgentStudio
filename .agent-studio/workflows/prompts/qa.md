QA REVIEW. Read the story named in TASK. Judge DIFF against TASK and the story's "Done when" items. VALIDATION (the unit suite) was run for you outside your sandbox; integration tests run at commit time, so do not report their absence: do not run it yourself, and do not report test or environment problems of your own sandbox (temp directories, permissions) as findings. A failing VALIDATION is a blocker; quote the failing tests. You may run read-only commands (rg, git status/diff/log/show, ls, cat); do not change files. Report blockers as findings; prefix anything optional with "SUGGESTION".

{{task}}
{{validation}}
{{diff}}
