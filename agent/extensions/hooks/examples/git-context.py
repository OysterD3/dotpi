#!/usr/bin/env python3
"""SessionStart hook: tell the model the git branch and what is uncommitted.

Context for the model: hookSpecificOutput.additionalContext. (On SessionStart,
plain stdout on exit 0 does the same.) Outside a git work tree it says nothing.
"""
import json
import subprocess
import sys

cwd = json.load(sys.stdin).get("cwd", ".")


def git(*args):
    return subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True).stdout.strip()


if git("rev-parse", "--is-inside-work-tree") != "true":
    sys.exit(0)
changed = git("status", "--short").splitlines()
lines = [f"Git branch: {git('branch', '--show-current') or '(detached HEAD)'}."]
if changed:
    lines.append(f"Uncommitted changes ({len(changed)}):")
    lines += changed[:20]
    if len(changed) > 20:
        lines.append(f"... and {len(changed) - 20} more")
else:
    lines.append("The working tree is clean.")
print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "\n".join(lines)}}))
