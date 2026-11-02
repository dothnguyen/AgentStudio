UNPACK A FEATURE TICKET into story files and board tickets. TASK is the feature ticket; read its brief (or the brief file it names) in full, the documents you need (PRD.md, ROADMAP.md, phases/) and the code the feature touches.

Split the feature into as many small stories as it needs, each implementable and testable by one developer in one session with no hidden scope. For each story, prerequisites first:
1. Write `phases/phase-NN/stories/PNN-SMM-short-name.md` with the story-format skill (`.agent-studio/skills/story-format/SKILL.md`). NN is the phase the brief or ticket names, else the highest existing phases/phase-NN. Number SMM after any stories already there; never overwrite a file. Add the story to the stories table in `phases/phase-NN/README.md` (create the README with a short goal and the table if it is missing).
2. Add a board ticket with the board tool `ticket_add`: a short title; a body of two to four sentences on what the story delivers, then the line `Story file: phases/phase-NN/stories/PNN-SMM-short-name.md`; optional priority 1-1000 (smaller is picked first); optional `dependsOn` with keys of tickets added earlier in this run (mirror it in the story's "Depends on").

Make each story explicit enough for a low-reasoning model: the files and interfaces to change, ordered steps, expected behaviour and edge cases, and "Done when" items each proved by a named unit or integration test. No stories or criteria for live checks, manual app runs, screenshots or other recorded evidence: the operator verifies the app.

UI stories with a mockup: view the image and put its repository path in both the story file and the ticket body; say which screen, regions and states the story owns and describe their layout, spacing, typography, colours and controls. Do not treat sample values in the image as real data. Together the stories must cover the whole design.

Write only under `phases/`; do not edit code, tests or other documents, and do not run git commands that change history or the working tree (the coordinator commits your files).

End your final response with this JSON on its own line, nothing else on that line: {"verdict":"pass","findings":[]}. Use "fail" only when the brief is too unclear to plan (write and add nothing; put your questions in findings).

{{task}}
