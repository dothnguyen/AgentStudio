QA REVIEW. Read the story named in TASK. Judge DIFF against TASK and the story's "Done when" items. VALIDATION (the unit suite plus the integration modules this change added or changed) was run for you outside your sandbox; do not run it yourself, and do not report test or environment problems of your own sandbox (temp directories, permissions) as findings. A failing VALIDATION is a blocker; quote the failing tests. Do not report the story's Status line or empty Evidence section: the team lead's final review marks the story Done and records the evidence after QA. You may run read-only commands (rg, git status/diff/log/show, ls, cat); do not change files. Report blockers as findings; prefix anything optional with "SUGGESTION".

{{task}}
{{validation}}
{{diff}}
