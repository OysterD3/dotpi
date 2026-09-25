---
name: subagent-creator
description: Create a pi subagent — a Markdown file in ~/.pi/agent/agents/ (or a project's .pi/agents/) that the `task` tool runs by name. Use when the user asks to create, add, make or set up a subagent or an agent for a job ("make me a code reviewer agent", "I want a subagent that writes tests"), or runs /subagents add. Guides the user and asks for every value they did not give; never guesses one.
---

# Create a subagent

A subagent is one Markdown file. The `task` tool runs it by name, in its own context, on its own model,
reasoning level and tools, with the file's body as its role prompt. Your job: find out what the user
wants, ask for what they did not say, show the file, and write it only when they confirm.

## The file

```markdown
---
name: code-reviewer
description: Review diffs for correctness, security, and quality
model: openai-codex/gpt-6-astra
reasoning: low
tools: read, grep, find, ls, bash
---

You review code changes. ...the role prompt...
```

| Field | Required | Rule |
| --- | --- | --- |
| `name` | yes | kebab-case (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`), unique; also the file name: `<name>.md` |
| `description` | yes | one line, what it is for. The main agent reads only this to decide when to delegate, so start with the job ("Review diffs for …"), not with "An agent that …" |
| `model` | no | a model reference: a full `provider/id` is best. Absent = the session model |
| `reasoning` | no | `off` `minimal` `low` `medium` `high` `xhigh` `max`. Absent = pi's default level |
| `tools` | no | comma list from `read, grep, find, ls, edit, write, bash` — only these; a subagent runs without extensions, so tools like `workflow` or `web_search` do not exist for it. Absent = pi's default tools (`read, bash, edit, write`) |
| body | no | the role prompt. Empty = one line built from the name and description |

Where it goes:
- **user** — `~/.pi/agent/agents/<name>.md`: works in every project. The default.
- **project** — `<repo root>/.pi/agents/<name>.md`: only in that repo, and it replaces a user agent of the
  same name. It loads only after the user runs `/trust` for that folder (pi's own trust flag is not
  enough). Say so when you write one.

## Steps

### 1. Read what you have

Take every value the request already gives — name, job, model, reasoning, tools, scope, any rule for
the role prompt. Then look at what exists, so you do not ask about a name that is taken:

```bash
ls ~/.pi/agent/agents/ .pi/agents/ 2>/dev/null
```

If the request names an agent that exists, ask whether to replace it or pick a new name — never
overwrite a file without a clear yes.

### 2. Ask for what is missing — all of it in one call

Use the `ask_user` tool, with every open question in ONE call (it takes up to 4). Ask only about values
the request did not give. Give each question 2–4 concrete options and mark one `recommended: true`, with
the reason in its description; the user can always type their own answer.

- **Job** — only when the request does not say what the subagent is for. Nothing else can be decided
  without it; if it is missing, ask it alone first.
- **Model** — find real choices first:
  ```bash
  pi --list-models <search>        # e.g. pi --list-models gpt   or   pi --list-models claude
  ```
  and read `defaultProvider` / `defaultModel` in `~/.pi/agent/settings.json` (the session model).
  Offer "the session model (leave it out)" plus two or three listed models that fit the job: a fast
  or small one for mechanical or read-only work, the strongest one for review, design and debugging.
  Write the chosen one as a full `provider/id`.
- **Tools** — offer the sets, recommend by the job:
  - read-only: `read, grep, find, ls` — explorers, reviewers that must not change anything;
  - read and run: `read, grep, find, ls, bash` — reviewers that run `git diff` or tests;
  - full: `read, grep, find, ls, edit, write, bash` — agents that change code.
- **Reasoning** — recommend `low` for mechanical work, `medium` for ordinary implementation, `high` for
  review, design and debugging.
- **Scope** — ask only when you are in a project (a git repo); otherwise use user scope without asking.

Do NOT ask about the name or the role prompt here. Propose them yourself in step 3, where the user can
change them.

If `ask_user` is not available, ask the same questions in plain chat and wait. If it says no user can
be reached (a headless run), do not fill the gaps with guesses: stop, and report which values are
missing.

### 3. Show the file, then confirm

Build the whole file:
- **name** — short and from the job (`test-writer`, `migration-checker`), not taken.
- **description** — one line, starts with the job.
- **role prompt** — write one when the job has any rule the description does not carry, which is
  nearly always. Keep it short and in the second person:
  - what it does, and what it must not do (for example "Never edit files", "Run git only read-only");
  - how to work (where to look first, what to check);
  - what to return, and in what shape — its final message is the only thing the caller sees;
  - when to stop.
  Leave the body empty only for a job one line fully describes.

Show the complete file and its path in a code block, then ask with `ask_user`: "Create it" (recommended)
or "Change something". On a change, apply it and show the file again.

### 4. Write it

Write the file with the `write` tool to the chosen path; create the folder when it does not exist.
Then read it back once and check the frontmatter: the three dashes, `name` and `description` present,
`tools` a comma list. Then tell the user, briefly:
- it runs at once: `task` with `subagent_type: "<name>"`;
- `/subagents` shows it; the `task` tool's own list of agents picks it up at the next session start
  or `/reload`;
- for a project agent: it loads only after `/trust` for that folder.

## To change an existing subagent

Edit its file with the same rules. `/subagents edit <name>` opens a dialog for a user agent too.
