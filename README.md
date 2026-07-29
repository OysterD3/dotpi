# pi config

My personal config for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent),
kept in git so it survives machine wipes — and so anyone else can lift the parts they like.

pi reads its config from `~/.pi/agent/`, so this repo *is* `~/.pi`.

## What's in here

| Path | What it does |
| --- | --- |
| `agent/settings.json` | Global pi settings: theme, model, and the `permissions` policy. |
| `agent/themes/one-dark-pro.json` | One Dark Pro colour theme. |
| `agent/.env.example` | Template for `agent/.env`, which holds your keys and is gitignored. |

Each extension is a folder whose `index.ts` is the entry point; every sibling file is a plain
helper module. That is pi's documented multi-file layout, and it's required here — pi auto-loads
*every* top-level `extensions/*.ts` as its own extension, so a helper sitting beside an entry point
would be loaded as an extension and fail. The lone top-level file is `cmux-session.ts`, which is
cmux's own generated bridge rather than one of ours — see `agent/extensions/cmux-notify/` below.

**`agent/extensions/statusline/`** — custom footer. Line 1: model / cwd / branch / diff stat /
version. Line 2: context bar and token totals. Line 3: subscription limit meters, when the
provider reports any. Below those, one line per active workflow run, while any is in flight —
ultracode announces them on a `pi.events` channel and the footer appends them, so background
fleets stay visible without opening the control panel. Nothing renders when nothing is running.

The footer draws nothing at all while `ask_user` has a question up (announced the same way, on
`ask-user:asking`): the question takes the editor's place, and the statusline stands down so it
has the bottom of the screen to itself. ask-user cannot do that from its side — restoring a footer
means restoring pi's *built-in* one, which would retire this statusline for the rest of the session.
The workflow control panel takes the editor's place too and announces itself the same way, on
`ultracode:panel-open`, so the run lines above stand down with the rest of the footer — the panel
is showing them in full while it is up.

| File | Role |
| --- | --- |
| `index.ts` | Footer wiring and layout |
| `config.ts` | Tunables, colours, bar glyphs |
| `render.ts` | Colours, number formatting, meters (pure) |
| `git.ts` | Working-tree diff counts |
| `usage.ts` | Subscription limit windows via the Codex endpoint |

**`agent/extensions/web-search/`** — registers a `web_search` tool backed by
[Exa](https://exa.ai). Requires `EXA_API_KEY`.

| File | Role |
| --- | --- |
| `index.ts` | Tool registration and orchestration |
| `config.ts` | Tunables and endpoint constants |
| `client.ts` | Request building, filter validation, HTTP |
| `format.ts` | Dedupe and markdown rendering (pure) |
| `render.ts` | Collapsed/expanded TUI view |
| `types.ts` | Exa response shapes |

**`agent/extensions/web-fetch/`** — registers a `web_fetch` tool that reads pages by URL via Exa's
`/contents`. Pairs with `web_search`, which finds the URLs. Requires `EXA_API_KEY`.

| File | Role |
| --- | --- |
| `index.ts` | Tool registration and orchestration |
| `config.ts` | Tunables and fence markers |
| `client.ts` | URL validation, request building, HTTP |
| `sanitize.ts` | Injection defenses (pure) |
| `format.ts` | Fenced, labelled rendering (pure) |
| `render.ts` | Collapsed/expanded TUI view |
| `types.ts` | Exa `/contents` response shapes |

**`agent/extensions/lsp/`** — registers an `lsp_diagnostics` tool: real compiler errors and
warnings from language servers, so the agent can verify an edit without running a build. pi has
no LSP support of its own, so this is a complete client.

| File | Role |
| --- | --- |
| `index.ts` | Tool registration and orchestration |
| `servers.ts` | **Server registry — the nvim-lspconfig equivalent; edit this to add a language** |
| `protocol.ts` | `Content-Length` JSON-RPC framing and URI helpers (pure) |
| `client.ts` | One server process: spawn, initialize, didOpen, collect diagnostics |
| `manager.ts` | Server selection, project-root detection, client reuse and idle reaping |
| `format.ts` | Compact `path:line:col: severity: message` rendering (pure) |
| `render.ts` | Collapsed/expanded TUI view |
| `config.ts` | Timeouts and limits |

**`agent/extensions/goal/`** — adds `/goal`. Set a condition and pi keeps working until it holds.

```
/goal all tests pass and the linter is clean
/goal                 # show the active goal and how many turns it has been judged over
/goal clear           # clear it early (also: stop, off, reset, none, cancel)
```

When the agent finishes a run, a separate LLM call judges the transcript against the condition. If
it is met, the goal clears itself and prints `Goal achieved (1m · 3 turns · 12.4k tokens)`. If not,
the reason is fed back and the agent resumes. The judge can also rule a condition **impossible**,
which stops the loop instead of retrying forever.

Failures are non-blocking by design: an evaluator that cannot be reached or parsed lets the agent
stop rather than trapping it, and never counts as met. A judge whose answer can't be understood
must not be able to end a goal, and must not be able to hold one open either.

The natural way to build this is a **stop hook** that vetoes the agent's attempt to end a run. pi
has no stop hook and no event whose return value can veto the end of a run, so the block is
expressed as pi's own shipped examples do it — evaluate on `agent_end`, resume by delivering a
follow-up message. Same behaviour, pi-native mechanism.

The evaluator is a separate model from the session's, so judging never has to cost a frontier call.
Set `goal.model` to name a small, fast one; unset, the session model judges its own work.

```jsonc
// ~/.pi/agent/settings.json — or <project>/.pi/settings.json when the project is trusted
{
  "goal": {
    "model": "<provider>/<small-fast-model>",  // evaluator model; unset = the session model
    "maxIterations": 20                     // 0 = no cap
  }
}
```

One thing worth knowing before you use it: every stop attempt while a goal is active costs an extra
LLM call carrying up to half the context window. That is inherent to the design — `goal.model` is
how you make it cheap. `maxIterations` (default 20) exists so an unsatisfiable goal cannot spend
money unattended; set it to `0` to let a goal run until you interrupt it.

| File | Role |
| --- | --- |
| `index.ts` | Command, `agent_end` hook, renderers |
| `prompts.ts` | Evaluator and instruction prompts |
| `judge.ts` | The evaluator call, model selection and verdict parsing |
| `transcript.ts` | Session branch → budgeted transcript text (pure) |
| `state.ts` | Active goal, iteration count, persistence across `/resume` |
| `render.ts` | TUI panels and summary text (pure) |
| `settings.ts` | The `goal` settings block |
| `model.ts` | Resolving `goal.model` the way pi resolves `--model` |
| `config.ts` | Limits and timeouts |

**`agent/extensions/review/`** — adds `/simplify` and `/code-review`: structured review of the
current diff, at a depth you choose.

```
/simplify                     # 4 cleanup angles, then apply the fixes
/code-review                  # correctness bugs at medium effort
/code-review max --fix        # widest coverage, then fix what survives
/code-review high src/parser.ts
```

They are separate commands rather than one with a flag, because a reviewer asked for both trades
them against each other and a style nit should never displace a real defect. `/simplify` judges
quality only — reuse, simplification, efficiency, altitude. `/code-review` hunts for bugs.

Neither does the reviewing itself: each assembles a prompt and injects it as a turn, and the agent
works it with the tools it has. That is what lets one command scale from a single inline pass to a
verified fleet. **Fan-out is detected, not assumed** — `workflow` (from `ultracode`) orchestrates a
fleet with a real verify stage and is preferred; `task` (from `subagents`) spawns them a call at a
time; with neither active the review still runs inline. The inline variants are told to *say* they
ran inline, so a single pass is never written up as though the fleet had run.

Effort scales four things. Angles: `low` gets a line-by-line scan, `max` adds the removed-behavior
audit, cross-file tracing, language pitfalls and wrapper correctness, plus the cleanup and
conventions angles. Findings cap: 5 at `low` up to 15 at `max`, which forces ranking rather than a
dump. Uncertainty: `low`/`medium` report only what they can confirm, `high` and above may surface
uncertain findings and must label them — a missed bug costs more up there than a false positive.
And `max` alone adds a **sweep**: a final pass looking only for what none of the angles would have
named, since a checklist finds what it lists.

From `high` on, the finder fleet is sized to the diff (one per 150 changed lines, 2–8) — counting
committed work, the working tree, *and untracked files*, which appear in no diff at all and would
otherwise make a branch of all-new files measure as empty. However many finders there are, every
angle is assigned to one: a fleet smaller than the angle list splits it rather than dropping the
remainder.

The verify pass is what separates this from a list of guesses: each candidate goes to a reviewer
told to *refute* it, under a rubric that treats realistic-but-untriggered states (races, cold
caches, falsy-zero, boundary off-by-ones) as **plausible** rather than speculative. Without that
bias verifiers refute nearly everything and the review returns a clean bill of health it hasn't
earned.

| File | Role |
| --- | --- |
| `index.ts` | The two commands, fan-out detection, prompt injection |
| `angles.ts` | **The review lenses** — cleanup and correctness (pure) |
| `phases.ts` | Diff gathering, verdict rubric, output contract (pure) |
| `prompt.ts` | Assembling a prompt per command / level / fan-out (pure) |
| `args.ts` | Parsing `[level] [--fix] [<target>]` (pure) |
| `diff.ts` | Sizing the diff so the fleet matches the work |
| `config.ts` | Levels, caps, finder bounds |

**`agent/extensions/rewind/`** — adds `/rewind` (aliases `/checkpoint`, `/undo`). Pick an earlier
prompt, then choose what to restore:

| Mode | Effect |
| --- | --- |
| Restore code and conversation | Files go back, and the session forks to just before that prompt |
| Restore conversation | Session only; files are left alone |
| Restore code | Files only; the conversation continues |

Code restore is only offered when that point actually has file changes — the picker shows the
count per row, so you can see what a rewind would touch before choosing it.

pi already had half of this: `/fork` and `/tree` navigate the session tree, and
`ctx.fork(id, { position: "before" })` puts the prompt back in the editor. That *is* conversation
rewind, so this calls it rather than reimplementing it. What pi has no answer for is code — its
docs say to "use git or another checkpointing workflow if you want easy rollback". So the file
history is the new part, and it is **git-independent**: it works in a repo, outside one, and on
files git ignores.

How it works: before every `write`/`edit`, the file's current contents are saved to a
content-addressed blob under `agent/file-history/<session>/`. Identical contents share a blob, so
repeatedly touching the same file costs nothing extra. A file that did not exist at the chosen
point is recorded as absent, and restoring **deletes** it. History is inherited when a rewind forks
the session, so you can rewind more than once, and sessions older than 30 days are pruned.

**The limit worth knowing: only `write` and `edit` are checkpointed.** Files changed by `bash` —
`mv`, `rm`, `sed -i`, a build script — are invisible to this and will not be undone. A shell
command's effects cannot be known before it runs, so including `bash` would produce checkpoints
that silently miss files, which is worse than a documented gap. Restoring also refuses to touch
anything that is not a plain regular file, so a symlink in the way is reported, never followed.

| File | Role |
| --- | --- |
| `index.ts` | Command, event wiring, the restore flow |
| `history.ts` | Checkpoint model and its queries (pure) |
| `store.ts` | Content-addressed blobs and the on-disk index |
| `restore.ts` | Applying a code rewind, with the refuse-rather-than-force rules |
| `render.ts` | Picker rows and result summaries (pure) |
| `config.ts` | Tracked tools, size caps, retention |

**`agent/extensions/permissions/`** — tool permissions in the widely-used `settings.json` shape. pi
ships nothing like this; its security doc states plainly that built-in tools "can read files, write
files, edit files, and run shell commands with the permissions of the pi process".

Rules live under a `permissions` key in pi's own settings files, so an existing policy in that
shape can be pasted straight in:

```jsonc
// agent/settings.json  (or <project>/.pi/settings.json)
{
  "theme": "one-dark-pro",
  "permissions": {
    "defaultMode": "askDestructive",
    "deny":  ["Read(**/.env)"],
    "ask":   ["Bash(git push *)"],
    "allow": ["Bash(git status)", "Bash(pnpm test *)"]
  }
}
```

pi's `Settings` type has no `permissions` field, so this was checked rather than assumed: pi
rewrites `settings.json` by merging its modified fields over the parsed current file, which
preserves unknown keys. Verified against the real `SettingsManager` — changing the theme leaves the
permissions block intact.

`Bash(git log *)` is a prefix rule (the space enforces a word boundary; a trailing `:*` is the
legacy spelling), `Bash(git status)` is exact, `Read(src/**)` is a path glob, and a bare `Bash`
matches every use of the tool.

**The default mode is `askDestructive`** — exactly the "only ask me about destructive things" case.
Everything runs silently except commands that destroy work, publish, escalate privilege, or pipe
the network into a shell. Modes, from most to least permissive:

| Mode | Behaviour |
| --- | --- |
| `allowAll` | Never prompt. Rules still apply. |
| `askDestructive` | Prompt only for destructive commands. **Default.** |
| `askMutating` | Prompt for anything that writes: bash, write, edit. |
| `askAll` | Prompt for every tool call. |
| `denyAll` | Refuse everything not explicitly allowed. |

What counts as destructive is a readable table in `destructive.ts` — 62 patterns, no model call in
front of every command, so it is fast, offline, free, and auditable. `/permissions patterns` lists
them; silence any single one by id via `allowDestructive`.

**Provenance, since this is a security control and it matters:** the table was written from
scratch, then audited against a comparable agent's shipped implementation. That one turned out not
to gate on a destructive denylist at all — it has an enumerated destructive regex table that is
*advisory only* (behind a default-off flag, feeding a "Note: may …" hint and telemetry), narrow
deterministic blocking only for `rm` path shape, and a 66-rule taxonomy that is a prompt for an LLM
classifier whose own text says "RULE LISTS ARE EXAMPLES, NOT BOUNDARIES". So nothing was copied;
those 66 rule names were used as a coverage checklist, and the audit added 21 patterns and fixed 18
existing ones — including `rm -v -rf /srv/data`, which the headline rule silently missed because it
required the flag to be the first token. Detection splits on `;`, `&&`, `||` and
newlines while respecting quotes, and looks inside `$(...)` and backticks, so `echo ok && rm -rf x`
and `echo "$(git reset --hard)"` are both caught. It also treats a destructive command with
runtime-computed arguments (`rm $(cat list)`) as destructive, since it cannot be read statically.
`echo`/`grep`-style commands are judged on their unquoted parts, so searching *for* `rm -rf` does
not prompt.

Precedence is **deny → destructive → ask → allow → mode**. The destructive check sitting ahead of
`allow` is a deliberate departure from the conventional ordering, and it fixes a trap that ordering
has: prefix rules are string matches with no flag analysis, so `Bash(git *)` also permits
`git push --force` and `git reset --hard`. Allowlisting `git` to stop being nagged about
`git status` is not consent to silent history rewrites. Set `destructiveOverridesAllow: false` for
the strict conventional ordering.

Two other safety choices: a project's `.pi/settings.json` can always add `deny`/`ask` rules, but
its `allow` rules and any loosening of the mode are **ignored unless the project is trusted**, so
cloning a hostile repo cannot grant itself permissions. And with no interactive session, an "ask"
blocks rather than passes (`askWithoutUi`).

When it does ask, the prompt offers four grains, because "don't ask me again" means different
things at different moments:

| Choice | Scope |
| --- | --- |
| Allow once | Just this call. |
| Allow this exact command | That command string, for the rest of the session. |
| Allow anything that *&lt;reason&gt;* | Every command tripping the same pattern — all recursive deletes, all force-pushes — for the rest of the session. |
| Allow every *&lt;tool&gt;* call | The whole tool, for the rest of the session. |

The third is the one that earns its keep: when you are deleting twenty build directories, being
asked about each distinct path is the same nag with extra steps. It is also the one with teeth —
approving "recursive deletes" does **not** wave through `sudo rm -rf /`, because that command is
also dangerous for a second, ungranted reason. A blanket pass needs every reason covered.

Grants live in memory only and die with the session; a standing approval should be a deliberate
edit to `settings.json`, not something that accumulates from clicking. **No grant can lift a
`deny` rule** — deny is decided before grants are consulted.

`/permissions` shows the active policy, `/permissions test <command>` explains what would happen to
a command without running it, `/permissions grants` lists what you have approved this session,
`/permissions forget` revokes it all, and `/permissions reload` re-reads the files.

**This is a guardrail, not a sandbox.** It gates tool calls before they run; it cannot contain code
that is already executing, and `bash` remains able to do anything the pattern table does not name.

| File | Role |
| --- | --- |
| `index.ts` | Event wiring, the approval prompt, `/permissions` |
| `destructive.ts` | **What counts as destructive — edit this table to taste** |
| `decide.ts` | Precedence engine (pure) |
| `rules.ts` | Rule syntax: parsing and matching (pure) |
| `glob.ts` | Path and command pattern matching (pure) |
| `settings.ts` | Loading and layering the JSON files |
| `grants.ts` | Session-scoped approvals and what each one covers |
| `config.ts` | Modes and their ordering |
| `corpus.test.ts` | 171 safe / 85 dangerous commands the table must get right |

**`agent/extensions/add-dir/`** — adds `/add-dir`, plus `/dirs` to list and remove. Brings another
directory into the session's workspace:

```
/add-dir ../design-system     # tab-completes directories
/add-dir                      # prompts for a path
/dirs                         # list the workspace, remove a directory
```

After the path checks out you get a three-way answer — **this session** / **remember it** / **no** —
and choosing to remember asks one more question: which settings file. pi has no local-settings tier
to write to silently, so the choice is between this project's `.pi/settings.json` (may get
committed) and your global one (applies everywhere). Neither is a safe silent default. It lands
under the same `permissions` block:

```jsonc
{ "permissions": { "additionalDirectories": ["/Users/me/work/design-system"] } }
```

**What this does and does not do is worth being precise about**, because the name is borrowed from
tools where it means something stronger. Elsewhere the workspace is a permission boundary: tools
refuse paths outside it, so `/add-dir` unlocks access. pi has no such fence — `read`, `edit` and
`bash` already accept any absolute path. So this **grants nothing**. What it does is tell the model
the directory is in scope, and load that directory's `AGENTS.md` the way pi loads the project's own.
Both are capped (24 directories, 48k characters of guidance) because they are re-sent every turn.

Session-scoped additions are written to the session as custom entries rather than held in memory,
which makes them behave correctly around `/rewind`: rewinding past an `/add-dir` un-adds the
directory, and resuming a session keeps what you added. Validation is specific rather than generic —
a path that is already covered says *which* directory covers it, and pointing at a file suggests its
parent. macOS `/tmp` vs `/private/tmp` is normalised, so those are not two directories.

The same trust rule as `permissions` applies: an untrusted project's `additionalDirectories` is
ignored on load, and choosing to remember into an untrusted project says so and falls back to the
session rather than writing a file that would be quietly ignored.

| File | Role |
| --- | --- |
| `index.ts` | Commands, dialogs, prompt injection |
| `paths.ts` | Expansion and containment (pure) |
| `validate.ts` | The checks and the wording for each |
| `workspace.ts` | The directory set and its session persistence |
| `settings.ts` | Reading and writing `settings.json` without losing pi's own writes |
| `prompt.ts` | What gets appended to the system prompt |
| `config.ts` | Caps and labels |
| `add-dir.test.ts` / `add-dir.e2e.ts` | Unit and end-to-end coverage |

**`agent/extensions/recap/`** — adds `/recap`, an "away summary": a one- or two-line plain-text
summary of where the session stands.

```
/recap                         # summarise now
```

A recap leads with the overall goal and current task, then the one next action, in under 40 words
with no markdown. It runs as a tool-less LLM call over a recent-biased transcript of the branch, and
shows up as a display-only entry — information for the person returning, never fed back into the
model's context.

**The recap model is configurable.** Set `recap.model` in settings.json to a model reference (a
bare id, or `provider/id` to disambiguate); it falls back to the active session model. Resolution
uses the same rules as pi's `--model`, so an ambiguous bare id is an error rather than a silent
pick:

```jsonc
{
  "recap": {
    "model": "<small-fast-model>", // optional; default: the active model
    "autoOnReturn": false,          // optional; see below
    "idleThresholdMs": 300000,      // optional; "away" gap, floored at 30s
    "minUserTurns": 3               // optional
  }
}
```

**Two doors into one generator.** There is the manual `/recap`, and an automatic summary shown when
you return to the terminal after being away 5+ minutes. The ideal version knows you were away
because the terminal loses and regains focus, and generates the summary *while* you are away so it
is ready the instant you come back. pi exposes no focus events, so:

- `/recap` is always available and does exactly what it says.
- Auto-on-return is approximated from wall-clock idle — the gap between the agent going idle
  (`agent_settled`) and your next message — and generated *reactively* when you return, not
  proactively. Because that costs a model call and a few seconds in front of your own message,
  it is **off by default**. Enable it with `recap.autoOnReturn: true`.

The auto path has three more gates: a minimum of user turns before a recap is worthwhile (3), a
minimum of turns since the last recap so the same spot is not recapped twice (2), and never while
background work is pending. A project's `.pi/settings.json` can turn auto-recap on for itself, but
its `recap.model` is honoured only when the project is trusted — a clone cannot silently redirect
where your transcript is sent.

| File | Role |
| --- | --- |
| `index.ts` | Command, event wiring, the auto-on-return flow |
| `prompts.ts` | The recap prompt |
| `generate.ts` | The tool-less LLM call and its outcomes |
| `model.ts` | Resolving `recap.model` the way pi resolves `--model` (pure) |
| `transcript.ts` | Session branch → budgeted transcript text (pure) |
| `settings.ts` | The `recap` settings block |
| `gate.ts` | The auto-on-return decision (pure) |
| `state.ts` | Idle timing and a reentrancy guard |
| `render.ts` | The recap entry's appearance (pure) |
| `config.ts` | Limits and constants |
| `recap.test.ts` / `recap.e2e.ts` | Unit and wiring coverage (`recap.live.ts` hits the real model) |

**`agent/extensions/ultracode/`** — ultracode: a `workflow` tool that orchestrates fleets of
subagents from a script, and the triggers that opt the model into using it.

```
ultracode find every place this event is mishandled     # keyword: opts in this one turn
/ultracode                                              # session mode: on until turned off
```

The **keyword** is matched on whole words, so a whole-word "ultracode" triggers it but
`ultracode.ts`, `extensions/ultracode`, a quoted "ultracode", or `/effort ultracode` do not. It
injects the reminder for that turn and nothing else: the prompt is not rewritten and the thinking
level is untouched — the keyword and the session mode are independent.

The **session mode** (`/ultracode`, or `/ultracode on|off|status`) raises thinking to xhigh for the
session, and standing reminders follow a fixed cadence — the full "Ultracode is on" reminder on
entry, a sparse "still on" nudge every 10th user turn, and one exit notice when it goes off.
Changing the thinking level away from xhigh exits the mode. The mode survives session resume:
toggles are replayed from the branch, and delivered reminders are counted so a resumed session
continues the cadence instead of re-announcing.

The **`workflow` tool** is the thing the reminders point at: the model writes a plain-JS script
with `export const meta = {...}` and orchestrates subagents with `agent()`, `parallel()`, and
`pipeline()` (plus `phase()`/`log()` for progress and an optional JSON `schema` per agent, with
one retry on unusable output). Each subagent is a headless `pi --mode json -p --no-extensions
--no-skills` subprocess in the project directory — pi's own vendor pattern — so a wedged agent
cannot take down the session, subagents cannot recurse into further workflows, and project trust
is forwarded (`--approve` only when the parent session trusts the project). Concurrency is
`min(16, cores − 2)` with 1000-agent and 4096-item caps; all of those are settings.

**Every run is a directory.** `~/.pi/agent/workflow-runs/<runId>/` holds `run.json` (the row
`/workflows` lists), `journal.jsonl` (an append-only record of every agent, log line and result),
`script.js` verbatim, and `agents/` — a `--session-dir` in which **each subagent keeps a real pi
session**. That last part is the difference between a fleet you can debug and one you can only
watch: a finished agent's transcript renders with `pi --export` like any other session, tool calls
and all, and its full stderr sits beside it. Run ids are `wf-<base36 ms>-<n>`, unique across
processes and legal as pi `--session-id`s, which is how agent sessions are named `<runId>-a<n>`.

**Runs resume.** A run that failed, was cancelled, or died with its session keeps its journal, and
`resumeFromRunId` replays it: every agent whose prompt and options are unchanged returns its stored
result instantly, while new, edited and previously *failed* agents actually run. Matching is by
content hash rather than call order — `pipeline()` has no barrier, so the index an agent receives
depends on when earlier stages finished, and only a content key is stable under that. The price is
determinism: `Date.now()`, argless `new Date()` and `Math.random()` throw inside a script (a script
that truly needs them sets `deterministic: false` in its meta and gives up resume).

**Agents can be forked context.** `agent(prompt, { context: { parent: 6, files: [...], text: ... } })`
seeds that agent's session with recent turns of the conversation, whole files, or literal
background, instead of the script pasting everything into a prompt string. It is built with pi's
own `SessionManager` as a user message plus a one-line assistant acknowledgement — both are
required, since providers reject consecutive user messages and pi only flushes a session to disk
once it holds an assistant turn. `agentType` borrows a standing definition from `subagents.json`
(its tools, role prompt, model and reasoning level), and `tools` pins an allowlist directly.

**Workflows don't block the session.** The tool validates the script — meta *and* a compile check,
so a syntax error fails the call rather than arriving minutes later as a failed run — starts the
fleet, and returns immediately with a run id; the main agent keeps working while the bottom of the
footer shows each run's phases, agent counts, spend, and elapsed time. ultracode does not draw that
itself — it announces the lines on the `ultracode:panel` event channel and the statusline appends
them, the same decoupling `permissions` → `cmux-notify` uses. When a run settles
its outcome comes back to the model as a `workflow-result` message: a follow-up if the agent is
mid-turn, a turn of its own if the session is idle, so results get processed the way a task
notification would. The model can pass `wait: true` for the rare workflow whose result it needs
before doing anything else; only those attach their spend to the tool result as `usage` (a
background run's tool result is long gone by the time money is spent, so its cost is reported in
the result message and `/workflows` instead).

**The workflow control panel is a panel, not a list.** `shift+↓` at the prompt opens it, and
`/workflows` still does — the footer line advertising it sits directly under where you type, so
reaching it should not need a typed command. It takes the editor's
place at the bottom of the screen — framed by a rule above and below, key hints under the lower one — the same slot pi's own
selector and an `ask_user` question use, and the statusline stands down for it, so the panel owns
the prompt and the footer between them. Three levels: every run the store knows about (including
ones from previous sessions), then one run's phases and agents, then one agent. `↑↓` selects,
`→`/`←` moves between levels, `p` pauses or resumes, `c` cancels, `g` toggles the log pane, `x`
exports the selected agent's transcript to HTML, `e` shows where its stderr was written, and `R`
puts a resume instruction in the editor for you to send. The trade is ask_user's: while the panel
is up there is no prompt to type into, so `q`, `ctrl+c` and Esc all close it (Esc a level at a
time) — and Esc-to-interrupt is unavailable until you do, which a one-key gesture makes that bit
easier to trip into. Pausing is live: in-flight agents finish and new ones park at a gate, so a run can be held
mid-fleet and let go again. The subcommands remain for scripting:
`/workflows list|show <id>|pause <id>|resume <id>|cancel [id]`.

Runs still do not survive a session switch — shutdown cancels the fleet — but that is no longer
silent. A run whose owning process is gone is reconciled to `interrupted` on next start, and the
model is told which ids died *and that each is resumable*, rather than the old approach of scraping
its own transcript for the sentence that announced them.

**Say which models to use in the request itself.** Routing is not configured ahead of time — it is
part of the prompt that triggers the workflow:

```
ultracode, use sonnet for implementation and fable to review — port the parser to the new AST
ultracode audit this with haiku
```

The agent gives each subagent a model *reference* drawn from what you asked for, and every
reference is resolved with pi's own `--model` rules (partial names fine, aliases preferred over
dated ids, ambiguity is a loud error) before anything spawns — so a typo fails that one agent with
the reason in the run log, never silently on the wrong model. When a triggering request names
models, a reminder rides that turn so the instruction lands on the workflow rather than being read
as conversation; roles you did not mention use the default subagent model, and a routing
instruction holds for later workflows until you change it.

```jsonc
{
  "ultracode": {
    "keywordTrigger": true,   // optional; whether the "ultracode" keyword opts in a turn
    "model": "gpt-5.4-mini",  // optional default for agents no request routes (a resolved reference)
    "limits": {               // all optional; anything absent keeps its default
      "maxConcurrency": 8,    // default min(16, cores − 2)
      "maxAgentsPerRun": 1000,
      "maxItemsPerCall": 4096,
      "agentTimeoutMs": 600000,
      "schemaRetries": 1,
      "retainRuns": 50,          // run directories kept before the oldest are pruned
      "contextBudgetChars": 60000,  // ceiling on what one agent may be forked
      "fileBudgetChars": 20000      // ceiling per embedded file
    }
  }
}
```

Saved workflows live in `~/.pi/agent/workflows/<name>.js` and run by `name`; any file on disk runs
by `scriptPath`.

**Rough edges worth knowing.** Reminders arrive as hidden custom messages (pi's plan-mode pattern)
rather than attachments — invisible in the transcript UI. Workflow runs have no worktree isolation
(pi has no such primitive), so a fleet that edits files in parallel can still conflict. The keyword
has no dismiss shortcut and no live composer highlight — pi extensions see input only on submit —
and a prompt steered into a *running* turn cannot carry the keyword reminder (steered input never
reaches `before_agent_start`). `budget` is a stub (`total: null`) since pi has no token-budget
directive, so budget-guarded scripts fall through cleanly rather than crash. Two pi-native
behaviours to know about: pi persists every thinking change to `defaultThinkingLevel` in
settings.json (ultracode's xhigh is no exception — the pre-ultracode level is stored in the session
and restored on `/ultracode off`, even after a resume), and on models without an xhigh mapping pi
clamps upward, so some models get `max` — reported honestly in the confirmation. Models that can't
reach xhigh at all are refused. One caveat inherited from running scripts in-process: a workflow
script that busy-waits synchronously would freeze the session, so the tool description instructs
the model to always await.

| File | Role |
| --- | --- |
| `index.ts` | Triggers, `/ultracode`, `/workflows`, the `shift+↓` gesture, panel wiring, resume restore |
| `keyword.ts` | The keyword detector (pure) |
| `reminders.ts` | The reminder texts |
| `mode.ts` | The session-mode reminder cadence (pure) |
| `engine.ts` | The workflow script engine — meta, agent/parallel/pipeline, replay, pause, caps (pure) |
| `store.ts` | The on-disk run store: run.json, journal, script, agent sessions |
| `journal.ts` | Journal records and the content-keyed replay index (pure) |
| `context.ts` | What an agent is forked — rendering (pure) and session seeding |
| `agents.ts` | `agentType` resolved against `subagents.json` (pure) |
| `tui.ts` | **The `/workflows` control panel** — runs, agents, pause/cancel/export |
| `spawn.ts` | One subagent as a headless pi subprocess, with its own session |
| `runs.ts` | The in-process run registry — status, pause gate, cancellation |
| `panel.ts` | The status panel, the text report, and journal→view rebuilding (pure) |
| `routing.ts` | Spotting model names in the triggering request (pure) |
| `models.ts` | Model references resolved with pi's `--model` rules (pure) |
| `tool.ts` | Tool registration, background starts, result delivery, rendering |
| `description.ts` | The tool's LLM-facing contract |
| `config.ts` | Constants and pi-side limits |
| `ultracode.test.ts` / `ultracode.e2e.ts` | Unit and wiring coverage (`ultracode.live.ts` spawns real subagents) |

**`agent/extensions/elapsed/`** — how long the agent has been working, and how long it took.

pi's working row says only `⠋ Working...`, which tells you nothing about whether that has been true
for two seconds or two minutes, and nothing records the cost of a turn once it finishes. Both are
filled in:

```
⠋ Working... 1m 4s          while the agent runs, updated once a second
✻ Cooked for 1m 4s          when the turn settles, dimmed, in the transcript
```

The duration format has a hard cut at one minute, seconds **floored** below it (a ticking counter
never shows a second that has not fully passed) and **rounded with carry** above it, and days never
showing seconds. The end-of-turn verb is drawn from a pool — Baked, Brewed, Churned, Cogitated,
Cooked, Crunched, Sautéed, Worked.

That line is a display-only custom entry, so it stays in your scrollback and never enters the
model's context: how long a turn took is information for you, not for it. Timing runs from the
first `agent_start` to `agent_settled`, which is the true end of a run — after retries, compaction,
and queued continuations — so a turn interrupted by a compaction is reported as one turn, not two.

**The clock stops while the agent is waiting on you.** A turn's duration is meant to say how long
the *agent* worked; the moment it stops and asks you something, the seconds are yours, and counting
them turns "Cooked for 4m 20s" into a measure of how long you took to decide. The live row holds at
the value it had when the prompt appeared and resumes from there — no jump to catch up when you
answer — and the end-of-turn line reports work only.

Both kinds of block are excluded, on the same terms, or the one line would mean two different things
depending on which prompt fired: `ask_user` questions via `ask-user:asking` (the same announcement
the statusline and `cmux-notify` use), and permission prompts via `permissions:ask` plus the
`permissions:answered` edge added for this — an opening announcement alone would stop the clock and
never restart it. The `/ask-user test` demo is deliberately *not* excluded: its `blocking: false`
says the prompt is on screen but the agent never stopped, so pausing would subtract time the agent
really did spend. The arithmetic lives in `waiting.ts` as a pure clock-injected accumulator, tested
without sleeping.

```jsonc
{
  "elapsed": {
    "workingTimer": true,      // optional; the live counter
    "showTurnDuration": true,  // optional; the end-of-turn line
    "minTurnMs": 0             // optional; skip the line for turns shorter than this
  }
}
```

| File | Role |
| --- | --- |
| `index.ts` | Turn timing, the tick, and the settings block |
| `duration.ts` | Duration formatting (pure) |
| `waiting.ts` | Time spent stopped on a question, excluded from the turn (pure) |
| `render.ts` | The end-of-turn line and its verb pool (pure) |
| `config.ts` | Tick period and constants |
| `elapsed.test.ts` | Unit and wiring coverage |

**`agent/extensions/cmux-notify/`** — tells [cmux](https://github.com/manaflow-ai/cmux) when pi is
blocked waiting on *you*, so a pane you are not looking at raises the session's "needs input" chip
and a banner instead of waiting silently. Two things qualify: a permission prompt, and an `ask_user`
question.

cmux installs its own bridge at `agent/extensions/cmux-session.ts`, which reports session start,
prompt submit, and stop — but not the one state worth interrupting you for. cmux's own docs list pi
as having no approval integration; this fills that gap. It is a separate extension deliberately:
cmux's file says "DO NOT EDIT MANUALLY", and that is true — the file on disk is byte-for-byte a
template embedded in the cmux binary, rewritten on install, so an edit there would disappear on the
next upgrade. This one is yours and survives.

The coupling goes through pi's inter-extension event bus, not through cmux: `permissions` announces
`permissions:ask` at the moment a human is certain to be blocked (after grants and the headless
fallback have had their say), knowing nothing about cmux, and this extension translates that into a
`cmux hooks pi notification`. It also announces `permissions:answered` when the prompt closes — in a
`finally`, so an aborted prompt still releases it — which is what lets the turn clock exclude an
approval rather than only learning that the agent stopped. Anything else wanting the same signal — a desktop notifier, a webhook —
subscribes to the same channel. It sends asynchronously, unlike cmux's own `spawnSync` bridge, since
this is the one place in pi where a subprocess would sit in front of a waiting human. Gating matches
cmux's file exactly: nothing happens outside a cmux surface (`CMUX_SURFACE_ID`), and
`CMUX_PI_HOOKS_DISABLED=1` silences both.

`ask_user` questions arrive the same way, on `ask-user:asking`, and the banner carries the question
itself ("Pi is asking: …", or "Pi is asking 3 questions: …") — being told to come back matters less
when you cannot see what for. They never touch the permissions extension, which is why they used to
pass in silence: the one state most worth interrupting for was the one nothing announced. Only the
opening edge notifies; the closing announcement exists so the statusline can come back, and a second
send would just re-ring the bell for a question already answered.

Verified against the shipped cmux binary: `notification_type: "permission_prompt"` is load-bearing —
without it you get an "Attention" banner and the session stays marked *running*. One honest
limitation: nothing re-marks the session as running once you answer. cmux exposes no event that
clears the flag (a second `prompt-submit` appears to work but unbalances cmux's own depth counter and
leaves the session wedged as busy — measured), so the chip clears when the turn ends and cmux's
bridge sends `stop`.

| File | Role |
| --- | --- |
| `index.ts` | Bus subscription and the fire-and-forget send |
| `notify.ts` | Payload and banner text (pure) |
| `config.ts` | The cmux protocol constants and env-var names |
| `cmux-notify.test.ts` | Unit and wiring coverage |

**`agent/extensions/advisor/`** — an advisor tool. A zero-parameter `advisor` tool that lets the
agent pause and consult a **stronger reviewer model** on the whole session so far,
at the moments that matter — before committing to an approach, when stuck, and before declaring done.

```
Assistant  → called advisor()
Result of advisor:
  Biggest issue: don't use yaml.load on a user upload — use safe_load. …
```

The natural way to build this is a server-side tool, where the API forwards the whole conversation
to the reviewer model. pi has no such server tool, so the forwarding is done in the client — the tool
flattens the session branch (task, every tool call, every result) and runs the reviewer as a
**tool-less headless `pi` call** (`--no-tools`, so it advises and cannot act). What the agent sees is
the same either way: call `advisor()`, wait, get advice back.

The reviewer model is **configurable and required** — that is the whole feature. With none set the
tool is not offered at all. Set it three ways, in priority order:

- `/advisor <model>` — a session override (also `/advisor off` / `on` / `status`)
- `--advisor <model>` — a CLI flag for one run
- `advisor.model` — the durable default in `agent/settings.json`

Model names resolve with pi's own `--model` rules (`opus`, `sonnet`, `openai-codex/gpt-5.6-sol`),
against the live registry. One rule you might expect is deliberately **not** enforced: that an
advisor cannot be the very model it advises. What the advisor actually buys is a clean-context read
of the whole session, and that holds even when the reviewer is the same model — it sees the
transcript without the anchoring of having produced it, and refusing would leave a single-model
setup with no advisor at all. `/advisor status` says when the reviewer equals the session model, but
it runs. An "advisor must be at least as capable" rank check reduces to *allow*, because pi's
registry carries no capability rank for arbitrary providers.

**A consult says what it is doing while it does it.** It can run for minutes — the transcript is
large, reviewer models are slow, and a reasoning model spends most of that time thinking before it
writes a word — and a single static line for five minutes is indistinguishable from a wedged
subprocess. The headless child streams pi's own session events, so the wait is not actually opaque:

```
Consulting openai-codex/gpt-5.6-sol… 8s
openai-codex/gpt-5.6-sol is thinking… 1m 12s · 3.1k chars of reasoning
openai-codex/gpt-5.6-sol is writing advice… 1m 40s · 840 chars
openai-codex/gpt-5.6-sol is writing advice… 4m 2s · 2.4k chars · gives up at 5m 0s
```

The line repaints on a one-second timer rather than per event, because the clock has to keep moving
through the long silence *before* the first token — that silence is when it looks hung, and a moving
number is the only thing that answers it. The deadline is named only in the back half of the budget,
where the question stops being curiosity and starts being "should I kill this?". `progress.ts` is
pure, and the stream parsing is tested against a fake `pi` child, so both are covered without a model.

The main-agent guidance (when and how to call it) lives in the tool description so it rides in the
system prompt. The reviewer-side prompt is authored here, reconstructed from the documented
behaviour of server-side implementations, whose instructions never ship in a client.

```jsonc
{
  "advisor": {
    "model": "opus",     // required to enable; the reviewer model
    "enabled": true      // optional kill switch
  }
}
```

| File | Role |
| --- | --- |
| `index.ts` | Settings, `--advisor` flag, `/advisor` command, active-tool sync, status chip |
| `tool.ts` | The `advisor` tool: resolve the reviewer, forward the session, return advice + usage |
| `transcript.ts` | Session branch → budgeted transcript, with tool results, oldest dropped first (pure) |
| `guidance.ts` | The tool guidance and the reviewer prompt |
| `models.ts` | Model reference resolution; `sameModel` labels a self-advising setup (pure) |
| `progress.ts` | Reading thinking/writing out of the child's stream, and the status line (pure) |
| `spawn.ts` | The tool-less headless `pi` reviewer subprocess |
| `advisor.test.ts` | Unit and wiring coverage (`advisor.live.ts` spawns a real reviewer) |

**`agent/extensions/subagents/`** — configurable subagents. You define a set of named subagents,
each pinned to a model, a reasoning (thinking) level, a purpose, and optionally a tool allowlist and
a role prompt; the main agent delegates a scoped task to one by name through the `task` tool, and it
runs in its own context and reports back.

`/subagents` shows the table:

```
Subagent           Model         Reasoning  Purpose
───────────────────────────────────────────────────
code-explorer      gpt-5.6-luna  High       Read-only codebase discovery and investigation
quick-implementer  gpt-5.6-luna  High       Small, well-defined changes in one or two files
implementer        gpt-5.6-luna  High       Features and bug fixes with tests and validation
code-reviewer      gpt-5.6-sol   Low        Review diffs for correctness, security, and quality
commit-pusher      gpt-5.6-luna  Low        Stage, commit, and push completed changes
```

Each subagent runs as a headless `pi` subprocess with its `--model`, `--thinking` (the reasoning
level), and `--tools` (the allowlist), plus its role prompt via `--append-system-prompt` — the same
spawn mechanism the ultracode workflow uses, here driven by standing definitions instead of a script.
A subagent that pins no model inherits the session model; `defaults` supplies a shared
model/reasoning for the ones that omit them. The `task` tool is offered only when at least one
subagent is configured (active-tool sync, like the advisor), so an empty config adds nothing to the
prompt, and its description lists the available subagents so the model knows what it can delegate to.

**Configure inside pi, not by hand.** `/subagents add | edit | remove` walks through pi's dialogs —
name, model (picked from your registry), reasoning, purpose, tools (all / read-only / custom), and an
optional role prompt — and writes `agent/subagents.json`. That file is the source of truth and takes
precedence over a `subagents` block in `settings.json`, which is kept only as a read fallback for
manual or legacy config; the first interactive edit migrates such a block into the store. A bad entry
is dropped with a reason (shown under `/subagents`), never fatal. The store ships seeded with the set
below — edit or clear it with `/subagents`:

```jsonc
// agent/subagents.json — managed by /subagents (pretty-printed, git-friendly)
{
  "defaults": { "model": "gpt-5.6-luna", "reasoning": "high" },
  "agents": [
    { "name": "code-explorer", "reasoning": "high", "tools": ["read", "grep", "find", "ls"],
      "purpose": "Read-only codebase discovery and investigation" },
    { "name": "code-reviewer", "model": "gpt-5.6-sol", "reasoning": "low", "tools": ["read", "grep", "find", "ls", "bash"],
      "purpose": "Review diffs for correctness, security, and quality" }
    // …
  ]
}
```

| File | Role |
| --- | --- |
| `index.ts` | Load, tool registration, active-tool sync, `/subagents add\|edit\|remove`, status chip |
| `manage.ts` | The interactive wizard over pi's dialogs (pure of pi imports; scriptable in tests) |
| `tool.ts` | The `task` dispatch tool: validate, resolve the pinned model, spawn, return the report + usage |
| `registry.ts` | Parse/validate the definitions, the file-first store (`subagents.json`), and its save (pure) |
| `panel.ts` | The Subagent / Model / Reasoning / Purpose table (pure) |
| `models.ts` | Model reference resolution (pure) |
| `spawn.ts` | The headless `pi` subagent subprocess (model, reasoning, tools, role prompt) |
| `subagents.test.ts` | Unit and wiring coverage (`subagents.live.ts` spawns a real subagent) |

**`agent/extensions/self-update/`** — keeps a machine current by pulling this repo in the background
at session start, so once a device has cloned it stays up to date with no manual step.

Because `~/.pi` **is** the git repo, "update" is a `git pull` in its root. On session start (interactive
only — headless subagents load no extensions), throttled to `intervalHours` across launches via a
gitignored timestamp, it runs `git pull --rebase --autostash` fire-and-forget and notifies **only when
HEAD actually moved** (`pi config updated (N new commits) — restart pi or /reload to apply`). New code
applies on the next launch or `/reload`.

`--rebase --autostash` is what makes it safe on a machine that edits its own config: pi rewrites
`settings.json` at runtime, so the tree is usually dirty; autostash tucks those changes aside, pulls,
and reapplies them. If the pull fails (offline, or a real conflict) the rebase is aborted so the tree
is left clean, and the run stays silent — a stale checkout beats a nagging banner or a half-rebased
repo. It's disabled where it can't help (no `pi.exec`, non-interactive) and can be turned off entirely.

```jsonc
{
  "selfUpdate": {
    "enabled": true,       // optional; master switch
    "intervalHours": 6     // optional; 0 = check every start
  }
}
```

| File | Role |
| --- | --- |
| `index.ts` | session_start gating (interactive, enabled, throttled) and the fire-and-forget run |
| `update.ts` | resolve root → remember HEAD → pull → report only if HEAD moved; abort on failure (pure of pi) |
| `state.ts` | the throttle timestamp and `isDue` (pure) |
| `config.ts` | defaults and constants |
| `self-update.test.ts` | Throttle, settings, the flow against scripted git, and session_start gating |

**`agent/extensions/compact-tools/`** — one-line rows for the noisy tools; detail on demand.

pi already collapses tool output and expands it with **ctrl+o** ("Toggle tool output"), but the
collapsed view still shows up to ~10 lines per call. This shrinks the **read-only / exec** built-ins
to a **single summary line** when collapsed, and shows the detail only once the row is expanded:

```
read src/foo.ts            42 lines
$ pnpm test                done (18 lines)
grep TODO in src           7 matches
ls src                     9 entries
```

**`write` and `edit` are left alone on purpose** — their whole point is the change they make, so
pi's own renderers stay in place: a write shows a syntax-highlighted preview of the new file
(`Wrote 96 lines …`, then `… +86 lines`), and an edit shows its coloured `+`/`-` diff. Compacting is
only for tools whose output is context to skim, not a change to see.

It re-registers each compacted built-in (`read`, `bash`, `grep`, `find`, `ls`) under its own name,
**delegates execution unchanged** to the original SDK tool (`create*Tool`), and replaces only the
rendering — the pattern from pi's own `examples/extensions/built-in-tool-renderer.ts`. Execution,
diffs, the file-mutation queue: all untouched. Press **ctrl+o** to expand a row (the summaries then
show up to `expandedLines` of detail). One honest limitation: pi has no mouse handling, so expansion
is the keypress, not a click; and pi prints a one-time startup warning when a built-in is overridden,
which is expected here.

```jsonc
{
  "compactTools": {
    "enabled": true,        // optional; false restores pi's default rendering
    "expandedLines": 100    // optional; lines of detail shown when a row is expanded
  }
}
```

| File | Role |
| --- | --- |
| `index.ts` | Re-registers the five compacted built-ins, delegating execute; wires the compact renderers |
| `render.ts` | The per-tool call/result summary strings, collapsed and expanded (pure) |
| `config.ts` | Settings and the tool list (write/edit excluded) |
| `compact-tools.test.ts` | Summary builders, settings, and wiring coverage |

**`agent/extensions/memory/`** — gives pi memory by reading another agent's store on this machine.

That store lives at `~/.claude/projects/<slug>/memory/`: a `MEMORY.md` index loaded into context
each session, plus per-fact markdown files with YAML frontmatter (`name` / `description` / `type`,
body with **Why:** / **How to apply:**). This finds the store that matches pi's current project — by
the same `cwd → slug` encoding that store uses (every non-alphanumeric char becomes `-`, so
`/Users/me/.pi` → `-Users-me--pi`, with an underscore-preserving fallback) — reads the index and
facts, and **appends them to pi's system prompt** each turn (via `before_agent_start`, so it's
cached, not resent as a message). A global `~/.claude/CLAUDE.md` is folded in when present. pi
already loads project `CLAUDE.md`/`AGENTS.md` as context files, so those aren't touched — this adds
the dedicated memory store on top.

`/memory` shows what's loaded and from where; `/memory show` prints the block; `/memory reload`
re-reads. Verified against a real store (an 8-fact project loaded cleanly at 10.5 KB).

Reading that store is the "for a start" scope; writing pi's own memory can layer on later over the
same format and location.

```jsonc
{
  "memory": {
    "enabled": true,        // optional; master switch
    "includeFacts": true,   // optional; full fact bodies, not just the MEMORY.md index
    "maxChars": 24000,      // optional; budget for the injected block (oldest facts dropped past it)
    "claudeHome": "~/.claude" // optional; where the store lives
  }
}
```

| File | Role |
| --- | --- |
| `index.ts` | Load on session start, append to the system prompt, `/memory`, status chip |
| `locate.ts` | `cwd → slug` and finding the matching memory directory (pure) |
| `load.ts` | Read MEMORY.md + fact files, parse frontmatter, budgeted assembly (pure) |
| `config.ts` | Settings and the injected-block header |
| `memory.test.ts` | Locating, parsing, assembly, settings, and wiring coverage |

**`agent/extensions/ask-user/`** — a structured question tool. Gives the main agent an `ask_user`
tool to pause and put a decision back to *you* — when it's genuinely blocked on a call
only you can make, rather than guessing.

The model calls `ask_user` with **1-4 questions at once** — the bound is `askUser`'s `maxQuestions`,
interpolated into the guidance and into the schema's `maxItems` from the same constant so the prompt
and the validator cannot drift apart. The guidance asks for the decisions it is *already* blocked on
and explicitly excludes any question another answer could invalidate: everything is shown at once
with no branching, so "which Postgres migration tool?" alongside "Postgres or SQLite?" would force an
answer to a question the first answer erases. You answer them in a single pass:

- **pick** one option (or several, when the model sets `multiSelect`). On a single-select question
  **Enter is a commit**: it picks the focused answer and moves straight to the next question, or to
  the review step from the last one. There is nothing left to decide once one answer is chosen, so
  making you then press → would be a keystroke carrying no information. Multi-select keeps Enter as
  a toggle and names its own "done" key (→), because there the question is not over until you say so,
- **take the model's advice, or don't.** When it leans one way it sets `recommended: true` on that
  one option: the row is badged **★ Recommended** and starts focused, so accepting costs a single
  Enter and disagreeing costs an arrow key. Nothing is pre-selected on your behalf — the badge is
  advice, not a default. At most one option per question can carry it (advice naming two answers
  isn't advice), and the reason belongs in that option's description. A model reaching for the
  common convention of writing "(Recommended)" into the label gets the same rendered row: the
  marker is lifted out of the label into the badge, so it never shows up as literal text,
- **paste into either.** A terminal wraps pasted text in bracketed-paste markers, which begin with
  ESC — so the free-text row and the note both used to ignore a paste entirely, since anything
  starting with ESC reads as an escape sequence rather than typing. Pastes are now matched before
  any key handling and flattened to one line, with newlines and tabs becoming spaces so words
  don't run together,
- **type your own answer** into the free-text row at the bottom — it shows *Type my own answer* until
  you start typing, so there is no "Other" to select first and no follow-up prompt. Enter finishes it,
  and on a single-select question that moves on too: finishing the text *is* answering,
- press **Tab** on any answer to annotate it: the cursor lands at the end of that answer and you keep
  typing. The note reaches the model *labelled as a note*, so it reads as you qualifying the choice
  rather than as part of it. Committing a note only closes the note — an annotation is not an answer,
- move between questions with **← / →**, and
- **review every answer** before anything is sent.

**It arrives where the answer goes.** The question takes the editor's place at the bottom of the
screen — framed by a rule above and below, key hints under the lower one — rather than floating over
the middle of the chat, and the statusline blanks itself for the duration (see it above), so the
question owns the prompt and the footer between them. pi's own `select` and `input` sit in exactly
the same slot; the transcript above stays put and readable, and the editor comes back afterwards
with whatever you had typed in it still there.

Both of those follow from one announcement: `ask-user:asking` carries the question, and subscribers
decide what to do with it. Three listen today — the statusline stands down, `cmux-notify` raises the
pane so a question waiting in a tab you are not watching rings the same bell a permission prompt
does, and `elapsed` stops the turn clock. The payload's `blocking` flag separates a question the
agent is stuck behind from the `/ask-user test` demo, which puts the same prompt on screen while the
agent carries on working: the two subscribers that act on "the agent has stopped" honour it, and the
statusline does not, because the demo owns the bottom of the screen either way.

Nothing is truncated: long options and descriptions wrap, because the description is often what the
choice turns on. What the screen cannot fit **scrolls** instead — the option list windows around the
focused row, keeping each option and its description together, and says how many rows are out of
view, so a tall question never pushes the conversation off the screen and no answer is ever silently
unreachable.

This is a real focused component (`ctx.ui.custom()`), not a stack of dialogs. That is forced by the
feature set rather than chosen for looks — pi cannot bind keys inside a `select`/`input`/`confirm`
dialog, so Tab-to-annotate, arrow-key navigation and typing straight into a row are simply not
expressible that way. The component (`prompt.ts`) is a thin renderer over a pure state machine
(`interaction.ts`), so the whole interaction is testable without a TUI.

The tool is offered only in an interactive session (it needs a real user) and only while enabled —
active-tool sync, like the advisor — so a headless run (`-p`) or a disabled setting adds nothing to
the prompt; if the model somehow calls it headless it gets a graceful "no user available, proceed"
result instead of hanging. `/ask-user` shows status; `/ask-user off` / `on` toggles it for the
session; `/ask-user test` runs two sample questions — one of them recommended — so you can try the
arrows, the badge, Tab notes and review live.

```jsonc
{
  "askUser": {
    "enabled": true,     // optional; master switch (also /ask-user off|on per session)
    "allowNotes": true   // optional; whether Tab attaches a note to the focused answer
  }
}
```

| File | Role |
| --- | --- |
| `index.ts` | Settings, tool registration, active-tool sync, `/ask-user [status\|on\|off\|test]` |
| `tool.ts` | The `ask_user` tool: normalize questions/options, run the prompt, graceful headless path |
| `interaction.ts` | The interaction as a pure state machine — selection, free text, notes, review |
| `prompt.ts` | The focused TUI component that stands in for the editor: layout, scrolling, key handling |
| `guidance.ts` | Tool description, prompt snippet, and the guideline bullets appended when active |
| `config.ts` | Settings and tunables |
| `ask-user.test.ts` | Normalization, the full flow, rendering, settings, and wiring coverage |

**`agent/extensions/env/`** — loads `.env` files into `process.env` at session start. pi has no
built-in dotenv support.

| File | Role |
| --- | --- |
| `index.ts` | Extension wiring |
| `config.ts` | Tunables |
| `parse.ts` | dotenv text → key/value pairs (pure) |
| `load.ts` | File discovery, permission check, applying to `process.env` |

Not tracked (see `.gitignore`): `agent/auth.json` (credentials), `agent/sessions/` (transcripts),
`agent/skills/` (symlinks into `~/.agents/skills`, shared with other agents and living elsewhere), and
`agent/settings.json` — because pi rewrites it at runtime (thinking level, model, `lastChangelogVersion`),
so tracking it would churn and fight `git pull`. The tracked `agent/settings.example.json` is the
template; copy it per machine. The shared permissions policy lives in that template.

**Composing prompts in nvim.** pi already ships this — press **Ctrl+X** in the prompt and it hands
the current text to an external editor in a temp `prompt.md`, suspends its own TUI while the editor
owns the terminal, and reads the file back when the editor exits. It picks the editor from
`externalEditor` in settings.json, falling back to `$VISUAL`, then `$EDITOR`, then `nano`. The
template sets it to `nvim` explicitly rather than leaning on `$EDITOR`, which on this machine points
at plain `vim` — and changing `$EDITOR` to suit pi would change it for git, crontab and everything
else too. Keep it as strict JSON: pi parses settings with `JSON.parse`, so a `//` comment silently
breaks the whole file.

## Install on a new machine

```sh
# 1. Clone this config into place (it IS ~/.pi, with agent/ inside)
git clone git@github.com:OysterD3/dotpi.git ~/.pi     # or https://github.com/OysterD3/dotpi.git

# 2. Create the per-machine settings from the template
cp ~/.pi/agent/settings.example.json ~/.pi/agent/settings.json

# 3. Authenticate this machine (auth.json is gitignored — each machine logs in itself)
pi          # then /login;  and set up agent/.env from agent/.env.example if you use web-search
```

If `~/.pi` already exists (pi created it), move it aside first — `mv ~/.pi ~/.pi.bak` — then clone and
copy your machine-local `agent/auth.json` and `agent/.env` back in.

Extensions and themes are picked up automatically by filename — no registration step.

**Staying in sync.** The `self-update` extension pulls this repo in the background at startup, so a
cloned machine keeps itself current (see its section above). To update by hand, or on demand:

```sh
git -C ~/.pi pull --rebase --autostash    # then restart pi or /reload
```

Model, thinking level, and other per-machine settings stay local (untracked `settings.json`); shared
things — extensions, themes, the permissions policy template, subagents — travel with the repo.

## Customising

- **Theme** — drop a JSON file in `agent/themes/`, then set `"theme"` in `agent/settings.json` to
  its `name`. Copy `one-dark-pro.json` as a starting point. A theme is two layers: `vars` is the raw
  palette (`blue: "#61afef"`, …) and `colors` maps semantic roles (`accent`, `error`, `success`,
  `muted`, `mdCode`, …) onto those vars. The statusline and the rest of the UI only ever reference
  roles, so retargeting a role restyles everything that uses it. The file's `$schema` points at
  pi's theme schema, so an editor will autocomplete the valid role names.
- **Statusline** — every knob lives in the `CONFIG` block at the top of
  `agent/extensions/statusline/config.ts`: bar width, whether to show the limit meters, reset
  formatting (`"clock"` → `resets 04:51 Wed`, `"relative"` → `2d 6h left`), the warn/error
  thresholds, and per-segment colours. Each colour is either one of pi's semantic theme roles
  (follows the active theme) or a `#rrggbb` literal (pinned, ignores the theme). Roles are
  typed against pi's own `ThemeColor` union, so a typo is a compile error rather than a silent
  mis-render.
- **Limit meters** — shown only when the provider actually reports limit windows, and each is
  labelled from the duration the API returns rather than from its position in the response.
  A ChatGPT/Codex account reports a single weekly window, so you get `Weekly:` and nothing else.
  Set `CONFIG.showLimits` to `false` to drop the line entirely.
- **Web search** — needs an Exa key from <https://dashboard.exa.ai/api-keys>; put it in
  `agent/.env` (see below). Tunables (result count, snippet length, search mode, timeout) live in
  `agent/extensions/web-search/config.ts`. Exa bills per search, and
  `CONFIG.searchType` values `deep`/`deep-reasoning` cost substantially more and are far slower than
  the default `auto` (~1s vs 4–40s). Highlights-only is the default content mode because it keeps
  token cost predictable; set `CONFIG.includeText` to also pull page text. Categories `company` and
  `people` disable `excludeDomains` and both date filters — the tool rejects that combination up
  front rather than letting Exa 400. Canonical API reference:
  <https://exa.ai/docs/reference/search-api-guide-for-coding-agents>
- **Secrets / env vars** — pi has no built-in dotenv support, so `agent/extensions/env/` adds it:

  ```sh
  cp ~/.pi/agent/.env.example ~/.pi/agent/.env
  chmod 600 ~/.pi/agent/.env
  ```

  Put `EXA_API_KEY=...` (and anything else) in there. Precedence is **most specific wins**: a var
  already exported in your shell beats `<cwd>/.pi/.env`, which beats `~/.pi/agent/.env`. Nothing
  already set is ever overwritten. `.env` is gitignored — **never** put a key in `settings.json`
  or `.env.example`, both of which are committed to this public repo.

  Caveat: the loader runs at `session_start`, so it reliably serves anything read at call time
  (like `EXA_API_KEY`, which `web-search` reads inside `execute()`). Whether it lands early
  enough for pi's *own* provider credentials (`ANTHROPIC_API_KEY` etc.) is untested — keep
  provider keys in your shell profile or use `/login`.
- **Web fetch, and its trust boundary** — `web_fetch` returns third-party content, which is
  attacker-controlled by definition. Defenses: invisible/bidi/tag characters, terminal escapes and
  markup are stripped; content is wrapped in fence markers randomised per process (so a page can't
  forge the closing marker) with any copy inside neutralised; and an explicit untrusted-data notice
  precedes it. Instruction-like prose is **not** censored — blocklisting phrases is trivially
  bypassed and mangles legitimate pages, so the design is containment plus labelling. **This raises
  the bar; it does not make reading hostile pages safe.** Nothing fetched is ever executed.
  Because Exa performs the fetch, SSRF against localhost and private ranges is impossible by
  construction — which also means intranet URLs don't work.
- **Keeping fetches cheap** — pass a `query` to `web_fetch` and it returns a focused summary plus
  targeted excerpts instead of the whole page. Measured: **1,604 chars vs 6,571 — 75.6% smaller**
  on the same document. Text mode is capped at `CONFIG.maxCharsPerPage` (6k) and reports truncation
  rather than silently cutting. Note that Exa's documented `text.verbosity: "compact"` knob had
  **no measurable effect** in testing (identical 18,668 chars vs `"full"`), so the character cap is
  the only control that actually works.
- **Tool output is collapsed** — `web_search` and `web_fetch` results show the first
  `CONFIG.collapsedLines` (8) lines with a `… N more line(s)` hint; press **Ctrl+O**
  (`app.tools.expand`) for the full detail. pi's TUI has **no mouse support**, so expansion is
  keyboard-only. The model always receives the complete text — only the on-screen view collapses.
  pi's default tool renderer does not truncate at all, so this is done by each tool's `render.ts`.
- **LSP: adding a language** — one entry in `agent/extensions/lsp/servers.ts`, in
  lspconfig's vocabulary:

  ```ts
  rust_analyzer: {
    cmd: () => [resolveBin("rust-analyzer")],
    extensions: ["rs"],
    languageId: "rust",
    rootMarkers: ["Cargo.toml", ".git"],
  },
  ```

  `resolveBin` prefers `agent/lsp/node_modules/.bin`, then `agent/lsp/bin` (Go tools), then
  `PATH`. `cmd` is a function so a missing binary reports an install hint at call time instead
  of breaking the extension at import. Root detection walks upward to the nearest marker, so a
  monorepo package resolves to the package rather than the repo root.
- **LSP: installed servers** — `cd agent/lsp && pnpm install` (the lockfile is committed;
  `node_modules/` is not).

  | Language | Server | Status |
  | --- | --- | --- |
  | TypeScript / JavaScript | `typescript-language-server` + `typescript` | installed |
  | Python | `pyright` | installed |
  | Go | `gopls` | resolved from PATH |
  | Java | `jdtls` | **configured but not installed** — `brew install jdtls` |

  **`typescript` is pinned to 5.9.3 on purpose.** TypeScript 7.0.x dropped the `tsserver`
  binary (its `bin` field is only `tsc`), and `typescript-language-server` drives `tsserver` —
  so `typescript@latest` silently breaks TS/JS diagnostics.
- **LSP: latency** — the first call for a project is slow while the server indexes it
  (~1.6s measured on small fixtures, much longer on a real codebase); later calls reuse the
  running server. Warm calls are dominated by `CONFIG.settleMs` (1200ms), which is how long the
  client keeps listening after the first `publishDiagnostics` — servers routinely send an empty
  batch first and the real errors a moment later. Lower it for snappier checks at the risk of
  missing a late batch. Idle servers are shut down after 10 minutes.
- **Adding an extension** — create `agent/extensions/<name>/index.ts` with a default-exported
  factory, and put helpers in sibling files. Import them with an explicit `.ts` extension
  (`from "./config.ts"`), which is what pi's own examples do — extensions load through jiti, so
  TypeScript runs uncompiled and no build step is involved.
- **Disable an extension** — remove or rename the file out of `agent/extensions/`.

`agent/settings.json` also gains machine-local keys as you use pi (e.g. `lastChangelogVersion`).
Harmless to commit, but expect churn there.
