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
would be loaded as an extension and fail.

**`agent/extensions/statusline/`** — custom footer. Line 1: model / cwd / branch / diff stat /
version. Line 2: context bar and token totals. Line 3: subscription limit meters, when the
provider reports any.

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

**`agent/extensions/goal/`** — adds `/goal`, a port of Claude Code's command of the same name. Set
a condition and pi keeps working until it holds.

```
/goal all tests pass and the linter is clean
/goal                 # show the active goal, its iteration count and elapsed time
/goal clear           # clear it early (also: stop, off, reset, none, cancel)
```

When the agent finishes a run, a separate LLM call judges the transcript against the condition. If
it is met, the goal clears itself. If not, the reason is fed back and the agent resumes. The judge
can also rule a condition **impossible**, which stops the loop instead of retrying forever.

The logic is taken from the Claude Code binary rather than guessed at, so the prompts, the 4000
character limit, the clear-words and the impossible escape hatch all match. One thing does not:
Claude Code implements this as a **Stop hook** that vetoes the agent's attempt to stop. pi has no
Stop hook and no event that can veto the end of a run, so the block is expressed as pi's own
shipped examples do it — evaluate on `agent_end`, and resume by delivering a follow-up message.
Same behaviour, pi-native mechanism.

Two things worth knowing before you use it. Every stop attempt while a goal is active costs an
extra LLM call carrying up to half the context window; that is inherent to the design, not this
port. And `maxIterations` in `config.ts` (default 20) has no Claude Code equivalent — it exists so
an unsatisfiable goal cannot spend money unattended. Set it to `0` for exact parity.

| File | Role |
| --- | --- |
| `index.ts` | Command, `agent_end` hook, renderers |
| `prompts.ts` | **Evaluator and instruction prompts, transcribed from Claude Code** |
| `judge.ts` | The evaluator call and verdict parsing |
| `transcript.ts` | Session branch → budgeted transcript text (pure) |
| `state.ts` | Active goal, iteration count, persistence across `/resume` |
| `render.ts` | TUI panels and footer status (pure) |
| `config.ts` | Limits and timeouts |

**`agent/extensions/rewind/`** — adds `/rewind` (aliases `/checkpoint`, `/undo`), a port of Claude
Code's command. Pick an earlier prompt, then choose what to restore:

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

**`agent/extensions/permissions/`** — tool permissions in Claude Code's `settings.json` shape. pi
ships nothing like this; its security doc states plainly that built-in tools "can read files, write
files, edit files, and run shell commands with the permissions of the pi process".

Rules live under a `permissions` key in pi's own settings files, exactly like Claude Code's
`settings.json`, so an existing policy can be pasted straight in:

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
scratch, then audited against the shipped Claude Code binary. Claude Code turned out not to gate on
a destructive denylist at all — it has an enumerated destructive regex table that is *advisory
only* (behind a default-off flag, feeding a "Note: may …" hint and telemetry), narrow deterministic
blocking only for `rm` path shape, and a 66-rule taxonomy that is a prompt for an LLM classifier
whose own text says "RULE LISTS ARE EXAMPLES, NOT BOUNDARIES". So nothing was copied; those 66 rule
names were used as a coverage checklist, and the audit added 21 patterns and fixed 18 existing ones
— including `rm -v -rf /srv/data`, which the headline rule silently missed because it required the
flag to be the first token. Detection splits on `;`, `&&`, `||` and
newlines while respecting quotes, and looks inside `$(...)` and backticks, so `echo ok && rm -rf x`
and `echo "$(git reset --hard)"` are both caught. It also treats a destructive command with
runtime-computed arguments (`rm $(cat list)`) as destructive, since it cannot be read statically.
`echo`/`grep`-style commands are judged on their unquoted parts, so searching *for* `rm -rf` does
not prompt.

Precedence is **deny → destructive → ask → allow → mode**. The destructive check sitting ahead of
`allow` is the one deliberate departure from Claude Code, and it fixes a trap Claude Code documents
in its own guidance: prefix rules are string matches with no flag analysis, so `Bash(git *)` also
permits `git push --force` and `git reset --hard`. Allowlisting `git` to stop being nagged about
`git status` is not consent to silent history rewrites. Set `destructiveOverridesAllow: false` for
strict Claude Code ordering.

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
| `rules.ts` | Claude Code rule syntax: parsing and matching (pure) |
| `glob.ts` | Path and command pattern matching (pure) |
| `settings.ts` | Loading and layering the JSON files |
| `grants.ts` | Session-scoped approvals and what each one covers |
| `config.ts` | Modes and their ordering |
| `corpus.test.ts` | 171 safe / 85 dangerous commands the table must get right |

**`agent/extensions/add-dir/`** — adds `/add-dir`, a port of Claude Code's command, plus `/dirs` to
list and remove. Brings another directory into the session's workspace:

```
/add-dir ../design-system     # tab-completes directories
/add-dir                      # prompts for a path
/dirs                         # list the workspace, remove a directory
```

After the path checks out you get Claude Code's three-way answer — **this session** / **remember
it** / **no** — and choosing to remember asks one more question pi needs and Claude Code does not:
which settings file. Claude Code always writes `.claude/settings.local.json`, a per-project file
its own setup gitignores; pi has no local-settings tier, so the choice is between this project's
`.pi/settings.json` (may get committed) and your global one (applies everywhere). Neither is a safe
silent default. It lands under the same `permissions` block:

```jsonc
{ "permissions": { "additionalDirectories": ["/Users/me/work/design-system"] } }
```

**What this does and does not do is worth being precise about**, because the name is borrowed from
a tool where it means something stronger. In Claude Code the workspace is a permission boundary:
tools refuse paths outside it, so `/add-dir` unlocks access. pi has no such fence — `read`, `edit`
and `bash` already accept any absolute path. So this **grants nothing**. What it does is tell the
model the directory is in scope, and load that directory's `AGENTS.md` the way pi loads the
project's own. Claude Code does that second part too; it keeps a separate list of added directories
for exactly this. Both are capped (24 directories, 48k characters of guidance) because they are
re-sent every turn.

Session-scoped additions are written to the session as custom entries rather than held in memory,
which makes them behave correctly around `/rewind`: rewinding past an `/add-dir` un-adds the
directory, and resuming a session keeps what you added. Validation is Claude Code's, including its
wording — a path that is already covered says *which* directory covers it, and pointing at a file
suggests its parent. macOS `/tmp` vs `/private/tmp` is normalised, so those are not two directories.

The same trust rule as `permissions` applies: an untrusted project's `additionalDirectories` is
ignored on load, and choosing to remember into an untrusted project says so and falls back to the
session rather than writing a file that would be quietly ignored.

| File | Role |
| --- | --- |
| `index.ts` | Commands, dialogs, prompt injection |
| `paths.ts` | Expansion and containment (pure) |
| `validate.ts` | The checks and Claude Code's wording for each |
| `workspace.ts` | The directory set and its session persistence |
| `settings.ts` | Reading and writing `settings.json` without losing pi's own writes |
| `prompt.ts` | What gets appended to the system prompt |
| `config.ts` | Caps and labels |
| `add-dir.test.ts` / `add-dir.e2e.ts` | Unit and end-to-end coverage |

**`agent/extensions/recap/`** — adds `/recap`, a port of Claude Code's recap (its "away summary"):
a one- or two-line plain-text summary of where the session stands.

```
/recap                         # summarise now
```

The prompt is transcribed verbatim from the Claude Code binary, so a recap leads with the overall
goal and current task, then the one next action, in under 40 words with no markdown. It runs as a
tool-less LLM call over a recent-biased transcript of the branch, and shows up as a display-only
entry — information for the person returning, never fed back into the model's context.

**The recap model is configurable.** Set `recap.model` in settings.json to a model reference
(`claude-haiku-4-5`, or `anthropic/claude-haiku-4-5` to disambiguate); it falls back to the active
session model. Resolution uses the same rules as pi's `--model`, so an ambiguous bare id is an
error rather than a silent pick:

```jsonc
{
  "recap": {
    "model": "claude-haiku-4-5",   // optional; default: the active model
    "autoOnReturn": false,          // optional; see below
    "idleThresholdMs": 300000,      // optional; "away" gap, floored at 30s
    "minUserTurns": 3               // optional
  }
}
```

**Where this diverges from Claude Code, and why.** Claude Code has two doors into one generator: the
manual `/recap`, and an automatic summary shown when you return to the terminal after being away 5+
minutes. It knows you were away because the terminal loses and regains focus, and it generates the
summary *while* you are away so it is ready the instant you come back. pi exposes no focus events,
so:

- `/recap` is faithful and always available.
- Auto-on-return is approximated from wall-clock idle — the gap between the agent going idle
  (`agent_settled`) and your next message — and generated *reactively* when you return, not
  proactively. Because that costs a model call and a few seconds in front of your own message,
  it is **off by default** (Claude Code's is on). Enable it with `recap.autoOnReturn: true`.

The auto path reuses Claude Code's other gates exactly: a minimum of user turns before a recap is
worthwhile (its `BIS` = 3), a minimum of turns since the last recap so the same spot is not
recapped twice (`UIS` = 2), and never while background work is pending. A project's `.pi/settings.json`
can turn auto-recap on for itself, but its `recap.model` is honoured only when the project is
trusted — a clone cannot silently redirect where your transcript is sent.

| File | Role |
| --- | --- |
| `index.ts` | Command, event wiring, the auto-on-return flow |
| `prompts.ts` | **The recap prompt, transcribed from Claude Code** |
| `generate.ts` | The tool-less LLM call and its outcomes |
| `model.ts` | Resolving `recap.model` the way pi resolves `--model` (pure) |
| `transcript.ts` | Session branch → budgeted transcript text (pure) |
| `settings.ts` | The `recap` settings block |
| `gate.ts` | The auto-on-return decision (pure) |
| `state.ts` | Idle timing and a reentrancy guard |
| `render.ts` | The recap entry's appearance (pure) |
| `config.ts` | Limits and Claude Code's constants |
| `recap.test.ts` / `recap.e2e.ts` | Unit and wiring coverage (`recap.live.ts` hits the real model) |

**`agent/extensions/ultracode/`** — a port of Claude Code's ultracode: a `workflow` tool that
orchestrates fleets of subagents from a script, and the triggers that opt the model into using it.

```
ultracode find every place this event is mishandled     # keyword: opts in this one turn
/ultracode                                              # session mode: on until turned off
```

The **keyword** works exactly as in Claude Code — the detector is transcribed from the binary, so
a whole-word "ultracode" triggers it but `ultracode.ts`, `extensions/ultracode`, a quoted
"ultracode", or `/effort ultracode` do not. It injects Claude Code's verbatim reminder for that
turn and nothing else: the prompt is not rewritten and the thinking level is untouched (that
matches Claude Code, where the keyword and the session mode are independent).

The **session mode** (`/ultracode`, or `/ultracode on|off|status`) is Claude Code's
`/effort ultracode`: thinking is raised to xhigh for the session and standing reminders follow the
same cadence — the full "Ultracode is on" reminder on entry, a sparse "still on" nudge every 10th
user turn (its `TURNS_BETWEEN_MAINTENANCE`), and one exit notice when it goes off. Changing the
thinking level away from xhigh exits the mode, the way picking another effort level does in Claude
Code. The mode survives session resume: toggles are replayed from the branch, and delivered
reminders are counted so a resumed session continues the cadence instead of re-announcing.

The **`workflow` tool** is the thing the reminders point at: the model writes a plain-JS script
with `export const meta = {...}` and orchestrates subagents with `agent()`, `parallel()`, and
`pipeline()` (plus `phase()`/`log()` for progress and an optional JSON `schema` per agent, with
one retry on unusable output). Each subagent is a headless `pi --mode json -p --no-session
--no-extensions --no-skills` subprocess in the project directory — pi's own vendor pattern — so a
wedged agent cannot take down the session, subagents cannot recurse into further workflows, and
project trust is forwarded (`--approve` only when the parent session trusts the project).
Concurrency is Claude Code's `min(16, cores − 2)` with its 1000-agent and 4096-item caps.

**Workflows don't block the session.** The tool validates the script, starts the fleet, and
returns immediately with a run id; the main agent keeps working while a status panel above the
editor shows each run's phases, agent counts, spend, and elapsed time. `/workflows` lists runs,
`/workflows cancel <id>` stops one (cancelling interrupts even a sleeping script, and kills its
subprocesses). When a run settles — finished, failed, or cancelled — its outcome comes back to the
model as a `workflow-result` message: a follow-up if the agent is mid-turn, a turn of its own if
the session is idle, so results get processed the way a task notification would. The model can
pass `wait: true` for the rare workflow whose result it needs before doing anything else; only
those attach their spend to the tool result as `usage` (a background run's tool result is long
gone by the time money is spent, so its cost is reported in the result message and `/workflows`
instead). Runs don't survive a session switch: shutdown cancels the fleet.

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
    "keywordTrigger": true,   // optional; Claude Code: workflowKeywordTriggerEnabled
    "model": "gpt-5.4-mini"   // optional default for agents no request routes (a resolved reference)
  }
}
```

**Where this diverges from Claude Code, and why.** Reminders arrive as hidden custom messages
(pi's plan-mode pattern) rather than attachments — same text, same position, invisible in the
transcript UI. Workflow runs have no resume journal and no worktree isolation (pi has neither
primitive; a failed run re-runs from the top, so the tool description steers toward several small
workflows). The keyword has no alt+w dismiss and no live composer highlight — pi extensions see
input only on submit — and a prompt steered into a *running* turn cannot carry the keyword
reminder (steered input never reaches `before_agent_start`). `budget` is a stub (`total: null`)
since pi has no "+500k" directive; budget-guarded scripts written for Claude Code fall through
cleanly rather than crash. Two pi-native behaviours to know about: pi persists every thinking
change to `defaultThinkingLevel` in settings.json (ultracode's xhigh is no exception — the
pre-ultracode level is stored in the session and restored on `/ultracode off`, even after a
resume), and on models without an xhigh mapping pi clamps upward, so Claude models get `max` —
reported honestly in the confirmation. Models that can't reach xhigh at all are refused, as in
Claude Code. One caveat inherited from running scripts in-process: a workflow script that
busy-waits synchronously would freeze the session, so the tool description instructs the model to
always await.

| File | Role |
| --- | --- |
| `index.ts` | Triggers, `/ultracode`, `/workflows`, panel wiring, resume restore |
| `keyword.ts` | **The keyword detector, transcribed from Claude Code** (pure) |
| `reminders.ts` | **Claude Code's reminder texts, verbatim** |
| `mode.ts` | The session-mode reminder cadence (pure) |
| `engine.ts` | The workflow script engine — meta, agent/parallel/pipeline, caps (pure) |
| `spawn.ts` | One subagent as a headless pi subprocess |
| `runs.ts` | The background run registry — status, cancellation, pruning |
| `panel.ts` | The status panel and `/workflows` report lines (pure) |
| `routing.ts` | Spotting model names in the triggering request (pure) |
| `models.ts` | Model references resolved with pi's `--model` rules (pure) |
| `tool.ts` | Tool registration, background starts, result delivery, rendering |
| `description.ts` | The tool's LLM-facing contract, adapted from Claude Code |
| `config.ts` | Claude Code's constants and pi-side limits |
| `ultracode.test.ts` / `ultracode.e2e.ts` | Unit and wiring coverage (`ultracode.live.ts` spawns real subagents) |

**`agent/extensions/elapsed/`** — how long the agent has been working, and how long it took.

pi's working row says only `⠋ Working...`, which tells you nothing about whether that has been true
for two seconds or two minutes, and nothing records the cost of a turn once it finishes. Both are
filled in, modelled on Claude Code:

```
⠋ Working... 1m 4s          while the agent runs, updated once a second
✻ Cooked for 1m 4s          when the turn settles, dimmed, in the transcript
```

The duration format is transcribed from Claude Code's `formatDuration`, so the two read alike: a
hard cut at one minute, seconds **floored** below it (a ticking counter never shows a second that
has not fully passed) and **rounded with carry** above it, and days never showing seconds. The
end-of-turn verb is drawn from Claude Code's own pool — Baked, Brewed, Churned, Cogitated, Cooked,
Crunched, Sautéed, Worked.

That line is a display-only custom entry, so it stays in your scrollback and never enters the
model's context: how long a turn took is information for you, not for it. Timing runs from the
first `agent_start` to `agent_settled`, which is the true end of a run — after retries, compaction,
and queued continuations — so a turn interrupted by a compaction is reported as one turn, not two.

```jsonc
{
  "elapsed": {
    "workingTimer": true,      // optional; the live counter
    "showTurnDuration": true,  // optional; Claude Code's key name for the end-of-turn line
    "minTurnMs": 0             // optional; skip the line for turns shorter than this
  }
}
```

| File | Role |
| --- | --- |
| `index.ts` | Turn timing, the tick, and the settings block |
| `duration.ts` | **Claude Code's `formatDuration`, transcribed** (pure) |
| `render.ts` | The end-of-turn line and its verb pool (pure) |
| `config.ts` | Tick period and Claude Code's constants |
| `elapsed.test.ts` | Unit and wiring coverage |

**`agent/extensions/cmux-notify/`** — tells [cmux](https://github.com/manaflow-ai/cmux) when pi is
blocked waiting for your approval, so a permission prompt in a pane you are not looking at raises
the session's "needs input" chip and a banner instead of waiting silently.

cmux installs its own bridge at `agent/extensions/cmux-session.ts`, which reports session start,
prompt submit, and stop — but not the one state worth interrupting you for. cmux's own docs list pi
as having no approval integration; this fills that gap. It is a separate extension deliberately:
cmux's file says "DO NOT EDIT MANUALLY", and that is true — the file on disk is byte-for-byte a
template embedded in the cmux binary, rewritten on install, so an edit there would disappear on the
next upgrade. This one is yours and survives.

The coupling goes through pi's inter-extension event bus, not through cmux: `permissions` announces
`permissions:ask` at the moment a human is certain to be blocked (after grants and the headless
fallback have had their say), knowing nothing about cmux, and this extension translates that into a
`cmux hooks pi notification`. Anything else wanting the same signal — a desktop notifier, a webhook —
subscribes to the same channel. It sends asynchronously, unlike cmux's own `spawnSync` bridge, since
this is the one place in pi where a subprocess would sit in front of a waiting human. Gating matches
cmux's file exactly: nothing happens outside a cmux surface (`CMUX_SURFACE_ID`), and
`CMUX_PI_HOOKS_DISABLED=1` silences both.

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

**`agent/extensions/advisor/`** — Claude Code's Advisor Tool, ported. A zero-parameter `advisor`
tool that lets the agent pause and consult a **stronger reviewer model** on the whole session so far,
at the moments that matter — before committing to an approach, when stuck, and before declaring done.

```
Assistant  → called advisor()
Result of advisor:
  Biggest issue: don't use yaml.load on a user upload — use safe_load. …
```

In Claude Code the advisor is a server-side beta tool: the API request carries a
`{type:"advisor_20260301", name:"advisor", model}` schema and Anthropic's API forwards the whole
conversation to that model. pi has no such server tool, so the forwarding is done in the client — the
tool flattens the session branch (task, every tool call, every result) and runs the reviewer as a
**tool-less headless `pi` call** (`--no-tools`, so it advises and cannot act). What the agent sees is
identical: call `advisor()`, wait, get advice back.

The reviewer model is **configurable and required** — that is the whole feature. With none set the
tool is not offered, mirroring Claude Code (its `Lyo()` returns nothing when `advisorModel` is unset,
and no tool is attached). Set it three ways, in priority order:

- `/advisor <model>` — a session override (also `/advisor off` / `on` / `status`)
- `--advisor <model>` — a CLI flag for one run (Claude Code's own flag name)
- `advisor.model` — the durable default in `agent/settings.json`

Model names resolve with pi's own `--model` rules (`opus`, `sonnet`, `openai-codex/gpt-5.6-sol`),
against the live registry. Claude Code's validation is ported as far as it ports: the one
provider-agnostic hard rule — an advisor **cannot be the very model it advises** (Claude Code's `Czg`)
— is enforced (the tool degrades to a note rather than self-reviewing); the "advisor must be at least
as capable" rank check reduces to *allow*, because pi's registry carries no `advisor_rank` for
arbitrary providers and Claude Code itself allows when a rank is unknown.

The main-agent guidance (when and how to call it) is Claude Code's text **verbatim**, placed in the
tool description so it rides in the system prompt. The reviewer-side prompt is **authored, not
transcribed** — Claude Code runs the reviewer server-side, so its instructions never ship in the
client; this reconstructs them from the documented behavior.

```jsonc
{
  "advisor": {
    "model": "opus",     // required to enable; the reviewer model (Claude Code: advisorModel)
    "enabled": true      // optional kill switch (Claude Code: CLAUDE_CODE_DISABLE_ADVISOR_TOOL)
  }
}
```

| File | Role |
| --- | --- |
| `index.ts` | Settings, `--advisor` flag, `/advisor` command, active-tool sync, status chip |
| `tool.ts` | The `advisor` tool: resolve, enforce advisor ≠ current model, forward, return advice + usage |
| `transcript.ts` | Session branch → budgeted transcript, with tool results, oldest dropped first (pure) |
| `guidance.ts` | **Claude Code's tool guidance, verbatim** + the authored reviewer prompt |
| `models.ts` | Model reference resolution and the `Czg` same-model rule (pure) |
| `spawn.ts` | The tool-less headless `pi` reviewer subprocess |
| `advisor.test.ts` | Unit and wiring coverage (`advisor.live.ts` spawns a real reviewer) |

**`agent/extensions/subagents/`** — Claude Code's subagents, made configurable. You define a set of
named subagents, each pinned to a model, a reasoning (thinking) level, a purpose, and optionally a
tool allowlist and a role prompt; the main agent delegates a scoped task to one by name through the
`task` tool (Claude Code's `subagent_type`), and it runs in its own context and reports back.

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
