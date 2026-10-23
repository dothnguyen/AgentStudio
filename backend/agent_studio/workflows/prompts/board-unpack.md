Use the story-format skill to unpack this feature. Write `<out>/README.md`, one story file per story, and `<out>/tickets.json` under OUT only; never write anything else. Every story has `Status: To Do`.

`tickets.json` is an object with `stories` and optional `questions`, and no other keys. `stories` contains 1-30 objects (or zero when `questions` is non-empty). Each story has `path` (a workspace-relative `.md` path under OUT) and `title`, plus optional `dependsOn` (other manifest paths) and integer `priority` 1-5. `questions` is a list of non-empty strings. Example: `{"stories":[{"path":"<out>/P04-S01-example.md","title":"Example","dependsOn":[],"priority":3}],"questions":[]}.

Never run history-changing git. Reply `pass` when the plan is written. Reply `fail` only when you cannot plan; provide questions as findings or in the manifest's `questions`.

{{task}}
