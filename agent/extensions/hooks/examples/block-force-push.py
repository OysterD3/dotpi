#!/usr/bin/env python3
"""PreToolUse hook for Bash: refuse a force push.

The simplest answer a hook can give: exit 2 blocks the call, and stderr is
the reason the model reads. --force-with-lease is let through.
"""
import json
import re
import sys

command = json.load(sys.stdin).get("tool_input", {}).get("command", "")
if re.search(r"\bgit\b.*\bpush\b", command) and re.search(r"(?<!\S)(--force|-f)(?!\S)", command):
    print("A hook blocks force pushes. --force-with-lease is allowed.", file=sys.stderr)
    sys.exit(2)
