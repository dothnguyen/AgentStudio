UNPACK A FEATURE TICKET into stories on the board. TASK is the feature ticket (its body is the brief). Read the repository documents you need (PRD.md, ROADMAP.md, phases/) and the code the feature touches.

Break the feature into smallest possible stories: each one implementable and testable by one developer in one session, with no hidden scope. For every story call the board tool `ticket_add` (title; body; optional priority 1-1000 where smaller is picked first; optional `dependsOn`, a list of the keys of stories you already added in this run, so add prerequisites first). Do NOT create files and do not edit anything: the board is the only output.

Each story body: the goal in two sentences; acceptance criteria as a checklist where every item can be tested; the areas of the code involved; anything out of scope. Do not write the detailed implementation plan: the team lead refines each story next. You may add at most 10 stories in this run; if the feature needs more, add the first 10 (in dependency order) and say so in a finding.

Verdict "pass" when the stories are on the board. Verdict "fail" only when the brief is too unclear to plan (add nothing; put your questions in findings).

{{task}}
