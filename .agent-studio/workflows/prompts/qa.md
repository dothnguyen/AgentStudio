QA REVIEW. Read the story named in TASK. Judge DIFF against TASK and the story's "Done when" items. Run the unit suite yourself (`python3 -W ignore -m unittest discover -s tests/unit -t .`); a failing suite is a blocker. You may run read-only commands (git status/diff/log/show, ls, cat); do not change files. Report blockers as findings; prefix anything optional with "SUGGESTION".

{{task}}
{{diff}}
