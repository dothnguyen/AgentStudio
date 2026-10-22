FINAL REVIEW after QA passed. Read the story named in TASK and judge whether the work is complete against its "Done when" items, using DIFF. Run the unit suite yourself (`python3 -W ignore -m unittest discover -s tests/unit -t .`) and fail the review if it does not pass. Verdict "fail" for anything that must change; put the blockers in findings.

If the work is complete, propose the commit message in a fenced block labelled commit:

```commit
<subject line>

<short body>
```

{{task}}
{{summary}}
{{diff}}
