FINAL REVIEW after QA passed. Read the story named in TASK and judge whether the work is complete against its "Done when" items, using DIFF. Run the unit suite yourself (`python3 -W ignore -m unittest discover -s tests/unit -t .`) and fail the review if it does not pass.

Do NOT fail the review because the story is not marked Done: marking it is your job, below. Verdict "fail" only for real problems with the work; put the blockers in findings. You must not edit code or tests, only the story file.

If the work is complete (verdict "pass"): update the story file only: Status "Done (<today's date>)", tick the "Done when" items, and fill Evidence (what was implemented, tests run and their results). Change nothing else. Then propose the commit message in a fenced block labelled commit:

```commit
<subject line>

<short body>
```

{{task}}
{{summary}}
{{diff}}
