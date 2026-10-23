"""Validation for ProductOwner unpack manifests."""
from __future__ import annotations

import os

from .protocol import AsError, MANIFEST_INVALID


def _inside(path, root):
    return path == root or path.startswith(root + os.sep)


def validate(workspace, out_dir, data):
    """Validate parsed manifest *data*, returning its normalized representation.

    This intentionally has no dependency on coordinator state; it only reads the
    story files named by a structurally valid manifest.
    """
    errors = []

    def bad(path, message):
        errors.append({"path": path, "message": message})

    if not isinstance(data, dict):
        bad("", "top level must be an object")
        raise AsError(MANIFEST_INVALID, "Manifest is invalid.", data={"errors": errors})

    allowed_top = {"stories", "questions"}
    for key in data:
        if key not in allowed_top:
            bad(str(key), "unknown key")

    questions = data.get("questions", [])
    questions_valid = isinstance(questions, list)
    if not questions_valid:
        bad("questions", "must be a list")
        questions = []
    else:
        for index, question in enumerate(questions):
            if not isinstance(question, str) or not question:
                bad(f"questions[{index}]", "must be a non-empty string")

    if "stories" not in data or not isinstance(data.get("stories"), list):
        bad("stories", "is required and must be a list")
        stories = []
        stories_valid = False
    else:
        stories = data["stories"]
        stories_valid = True
        if len(stories) > 30 or (not stories and not (questions_valid and any(isinstance(q, str) and q for q in questions))):
            bad("stories", "must contain 1-30 stories unless there are questions")

    root = os.path.realpath(os.path.join(workspace, out_dir))
    expected_prefix = out_dir.rstrip("/") + "/"
    valid_paths = {}
    parsed = []
    fields = {"path", "title", "dependsOn", "priority"}
    for index, story in enumerate(stories):
        base = f"stories[{index}]"
        if not isinstance(story, dict):
            bad(base, "must be an object")
            continue
        for key in story:
            if key not in fields:
                bad(base + "." + str(key), "unknown key")

        path = story.get("path")
        path_ok = isinstance(path, str)
        if not path_ok:
            bad(base + ".path", "is required and must be a string")
        elif (not path or "\\" in path or "\x00" in path or os.path.isabs(path)
              or any(part in (".", "..") for part in path.split("/"))
              or not path.startswith(expected_prefix) or not path.endswith(".md")):
            bad(base + ".path", "must be a relative POSIX .md path under out_dir")
            path_ok = False
        elif path in valid_paths:
            bad(base + ".path", "duplicate path")
            path_ok = False
        else:
            valid_paths[path] = index

        title = story.get("title")
        if not isinstance(title, str) or not title or len(title) > 200:
            bad(base + ".title", "is required and must be a non-empty string of at most 200 characters")

        depends = story.get("dependsOn", [])
        depends_ok = isinstance(depends, list)
        if not depends_ok:
            bad(base + ".dependsOn", "must be a list of strings")
            depends = []
        else:
            for dep_index, dependency in enumerate(depends):
                if not isinstance(dependency, str):
                    bad(f"{base}.dependsOn[{dep_index}]", "must be a string")

        priority = story.get("priority", None)
        if "priority" in story and (isinstance(priority, bool) or not isinstance(priority, int) or not 1 <= priority <= 5):
            bad(base + ".priority", "must be an integer from 1 to 5")

        parsed.append({"index": index, "path": path, "path_ok": path_ok, "title": title,
                       "dependsOn": depends, "depends_ok": depends_ok, "priority": priority})

    # Dependencies are checked after every manifest path is known.
    paths = {item["path"] for item in parsed if item["path_ok"]}
    graph = {}
    for item in parsed:
        if not item["path_ok"] or not item["depends_ok"]:
            continue
        good = []
        for dep_index, dependency in enumerate(item["dependsOn"]):
            if not isinstance(dependency, str) or dependency not in paths or dependency == item["path"]:
                bad(f"stories[{item['index']}].dependsOn[{dep_index}]", "must name another manifest story path")
            else:
                good.append(dependency)
        graph[item["path"]] = good

    # A three-state DFS visits every dependency edge once. Keep all nodes in
    # back-edge cycles so the error belongs to the earliest cycle member in
    # manifest order, not an earlier acyclic predecessor.
    state = {path: 0 for path in graph}  # 0 = unseen, 1 = visiting, 2 = done
    stack = []
    stack_positions = {}
    cycle_indexes = []

    def visit(path):
        state[path] = 1
        stack_positions[path] = len(stack)
        stack.append(path)
        for dependency in graph[path]:
            if state[dependency] == 0:
                visit(dependency)
            elif state[dependency] == 1:
                cycle_indexes.extend(valid_paths[node] for node in stack[stack_positions[dependency]:])
        stack.pop()
        del stack_positions[path]
        state[path] = 2

    for item in parsed:
        path = item["path"]
        if item["path_ok"] and path in graph and state[path] == 0:
            visit(path)
    if cycle_indexes:
        bad(f"stories[{min(cycle_indexes)}].dependsOn", "dependency graph contains a cycle")

    for item in parsed:
        if not item["path_ok"]:
            continue
        candidate = os.path.realpath(os.path.join(workspace, item["path"]))
        path_error = f"stories[{item['index']}].path"
        if not _inside(candidate, root):
            bad(path_error, "story file escapes out_dir")
        elif not os.path.isfile(candidate):
            bad(path_error, "story file is missing")
        else:
            try:
                with open(candidate, encoding="utf-8") as f:
                    lines = f.read().splitlines()
            except OSError as exc:
                bad(path_error, "story file cannot be read: " + str(exc))
                continue
            required = (("# ", "title", True), ("Status:", "Status:", True), ("Depends on:", "Depends on:", True),
                        ("## Goal", "## Goal", False), ("## Implement in this order", "## Implement in this order", False),
                        ("## Done when", "## Done when", False), ("## Evidence", "## Evidence", False))
            for prefix, section, starts_with in required:
                if not any(line.startswith(prefix) if starts_with else line == prefix for line in lines):
                    bad(path_error, "missing " + section)
            done_at = next((i for i, line in enumerate(lines) if line == "## Done when"), None)
            if done_at is not None:
                following = lines[done_at + 1:]
                end = next((i for i, line in enumerate(following) if line.startswith("## ")), len(following))
                if not any(line.startswith("- [ ]") for line in following[:end]):
                    bad(path_error, "## Done when needs an unchecked item")

    if errors:
        raise AsError(MANIFEST_INVALID, "Manifest is invalid.", data={"errors": errors})
    return {"stories": [{"path": item["path"], "title": item["title"], "dependsOn": item["dependsOn"],
                         "priority": item["priority"]} for item in parsed], "questions": questions}
