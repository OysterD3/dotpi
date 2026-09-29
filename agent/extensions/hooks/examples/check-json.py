#!/usr/bin/env python3
"""PostToolUse hook for Edit|Write: check that a changed .json file still parses.

The JSON answer: {"decision": "block", "reason": ...} after a tool has run
puts the reason next to the tool result, where the model reads it. Note the
input field: pi's tools take `path`, not Claude Code's `file_path`.
"""
import json
import os
import sys

payload = json.load(sys.stdin)
path = payload.get("tool_input", {}).get("path", "")
name = os.path.basename(path)
# tsconfig and jsconfig files may hold comments, which JSON does not allow.
if not name.endswith(".json") or name.startswith(("tsconfig", "jsconfig")):
    sys.exit(0)
try:
    with open(os.path.join(payload.get("cwd", ""), path), encoding="utf-8") as file:
        json.load(file)
except OSError:
    sys.exit(0)
except ValueError as error:
    print(json.dumps({"decision": "block", "reason": f"{path} is not valid JSON after this change: {error}"}))
