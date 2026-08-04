# pi config

My personal config for the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent),
kept in git so it survives machine wipes — and so anyone else can lift the parts they like.

pi reads its config from `~/.pi/agent/`, so this repo *is* `~/.pi`.

## What's in here

| Path | What it does |
| --- | --- |
| `agent/settings.json` | Global pi settings: theme, model, and the `permissions` policy. |
| `agent/keybindings.json` | Key overrides. Frees Shift+Tab for the permission-mode cycler. |
| `agent/themes/one-dark-pro.json` | One Dark Pro colour theme. |

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

**`agent/extensions/usage/`** — adds `/usage`: what this session has cost, and where it went.

The statusline above already carries running token totals, but it has one line, so it answers "how
full is the context" rather than "what am I paying for" — and the single number it shows leaves out
every model call that was not a message in this conversation. `/usage` is the breakdown:

```
● Usage  ·  019f89f7  ·  1h 00m span  ·  1 turn
Context  [████········] 84k / 272k (31%)

Source                    calls  input  output  cached      cost
openai-codex/gpt-5.6-sol      1  1.20M     84k    980k  $12.3456
workflow                     40   828k     44k   1.90M   $8.0008
  code-review (16:01)        24   540k     30k   1.26M   $5.2008
  migrate-parser (14:03)     16   288k     14k    640k   $2.8000
compaction                    1   140k    3.1k       0   $0.4200
recap                         3    24k     360       0   $0.0360
────────────────────────────────────────────────────────────────
Total                        45  2.19M    132k   2.88M  $20.8024
5.20M tokens billed  ·  57% of input served from cache  ·  185k reasoning
Model rows are this conversation's own calls. Tool rows are calls those tools made themselves.
```

**`calls` means model calls in every row**, which is less obvious than it sounds. The natural
reading of a tool result is "one call", and for the tools that cost real money that is wrong by an
order of magnitude: a synchronous `workflow` arrives as a *single* tool result carrying the
aggregate spend of a twenty-four agent fleet. Counted naively it put a `1` beside `$5.20` in the
same column as a `3` beside `$3.30`, and made the Total row add round trips to tool invocations and
call the sum a number of calls. pi's `Usage` has nowhere to put a call count, so the convention is
`details.turns` — free-form, and persisted to the session file, which is what lets a resumed
session still report the right number. `details.spendLabel` names the individual run the same way
an announcement's `detail` does, so the indented lines add up to their parent.

**One producer is one row, whichever route its numbers took.** `workflow` above holds both: the
synchronous runs pi recorded on tool results and the background ones the extension announced.
Before, those were `workflow (tool)` and `workflows` in different sections — and which one you got
depended on `wait`, a parameter the report never showed, with a *failed* synchronous run switching
between them because pi builds the error result itself and it carries no usage. An announcement is
now merged into the row of the tool whose name it shares.

Every bug this could have makes the session look **cheaper** than it was, which is the one
direction a cost report must never be wrong in — so the rows below the models are the point. A tool
result carries its own `usage` when the tool itself talked to a model (a synchronous workflow, a
subagent); pi calls that "not part of main LLM context accounting", which is right for context and
wrong for money. Compaction and branch summarisation are model calls pi makes on your behalf,
recorded on their own entries rather than as messages. Counted over the whole session **file**, not
the current branch: an abandoned fork was still paid for, and a `/usage` that got cheaper when you
rewound would be lying.

The last category is spend that reaches the session file **nowhere at all**: background workflow
agents are separate pi processes, and `recap` and `goal` call `completeSimple` directly and store
only a display entry. Each announces on a shared `usage:spend` channel — named for the question,
not for one answer to it, since a channel called `ultracode:spend` made workflows visible and left
the other two invisible. The payload is an increment (`{ source, detail, usage, calls }`, `cost`
flat), so a producer announces as it spends and never keeps a tally of its own. Rows are keyed by
`source`, and the optional `detail` names one run/request inside it — that is what gives the
indented per-run rows above. A producer that isn't installed simply never fires and its row never
appears.

Announced spend is the one category that does **not** survive a resume: it lives in memory and
resets with the session, because there is nothing in the file to rebuild it from. That is why
synchronous workflow spend still rides on the tool result rather than being announced too, which
would have been the tidier-looking fix and would have quietly made a resumed session under-report.
The footnote says so whenever any announced spend is in the table.

The report is written into the transcript as a custom entry, the way `/recap` is, so it never
enters LLM context — and scrolling back to an earlier `/usage` shows what the session had spent *at
that point*, which is what you want when working out what one stretch of work cost. The entry
stores the numbers rather than the drawing, so it re-renders correctly after a theme change.

| File | Role |
| --- | --- |
| `index.ts` | Command, entry renderer, workflow-spend subscription |
| `collect.ts` | Session entries → per-source totals (pure) |
| `render.ts` | Totals → the table (pure) |
| `config.ts` | Channel name, meter glyphs, thresholds |
| `usage.test.ts` | Unit coverage |

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
| `config.ts` | Timeouts and tunables |

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

**Rules can name extension tools too**, which is how `Workflow`, `Advisor` and `Ask_user` are
allowed outright here. Unknown names pass through lower-cased (`resolveToolName`), so `Workflow` resolves to the
`workflow` tool; the capital is required by the rule syntax.

Those two are in `allow` for a reason worth writing down. In `auto` mode any tool without a matching
rule goes to the classifier, which can turn it into a prompt — and for these two the prompt never
stops coming. The remembered-approval grain that would normally silence it is `exact:<tool>:<target>`,
where `target` for a custom tool is `JSON.stringify(input)`. For `advisor` that input is the free-text
question, and for `workflow` it is the entire script, so the target is different on every single call
and an "allow this exact call" grant can never match the next one. The tool-wide grant does stick,
but it has to be found and clicked; allowing them by rule is the honest version of the same thing.
The trade is explicit, and larger for `workflow` than it looks. Both spawn subprocesses with
`--no-extensions`, which disables extension discovery in the child — so the permissions extension,
and with it the destructive table, is **not loaded there at all**. A workflow subagent runs `bash`
with no destructive gate: `rm -rf`, `git push --force` and `curl | sh` are not classified, not
prompted, and not denied. (`--approve` does not help; pi maps it to project *trust*, not tool
approval.) `advisor` is a different case only because it also passes `--no-tools`, so it has no
`bash` to gate. Allowing `workflow` therefore means trusting the scripts this agent writes to run
unsupervised in your project. `deny` rules still outrank everything in the PARENT session, which is
where you and the agent share a shell.

**The default mode is `askDestructive`** — exactly the "only ask me about destructive things" case.
Everything runs silently except commands that destroy work, publish, escalate privilege, or pipe
the network into a shell. Modes, from most to least permissive:

| Mode | Behaviour |
| --- | --- |
| `allowAll` | Never prompt. Rules still apply. |
| `askDestructive` | Prompt only for destructive commands. **Default.** |
| `auto` | `askDestructive`, plus a model's verdict on everything the table cleared. |
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

**Shift+Tab cycles the mode** for the session — `askDestructive → auto → askMutating → askAll` —
and `/permissions mode [<mode>]` does the same thing by name. The change is *not* written back to
`settings.json`: a keystroke is how you say "for the next ten minutes", and a durable policy change
should be a deliberate edit to a file you can read later, not a residue of tabbing. A new session
starts from what the files say.

`allowAll` and `denyAll` are deliberately left out of the cycle. Neither end of the ladder should be
one mistyped keystroke away — tabbing into "never prompt" by accident is precisely the accident this
extension exists to prevent — but both remain available in `settings.json` and via
`/permissions mode allowAll`, where choosing them is deliberate.

One setup step, because **pi already binds Shift+Tab** to `app.thinking.cycle`, and a reserved
binding beats an extension's, so the shortcut does nothing until you move it:

```jsonc
// agent/keybindings.json — in this repo, thinking-level cycling moved to Shift+Ctrl+T
{ "app.thinking.cycle": "shift+ctrl+t" }
```

### `auto` mode — letting a model decide

A pattern table only catches what it names. `auto` mode adds a second opinion: a small model is
shown each tool call the rules did not settle and answers safe or unsafe, and unsafe becomes a
prompt.

```jsonc
// agent/settings.json
{
  "permissions": {
    "defaultMode": "auto",
    "auto": {
      "model": "<provider>/<small-fast-model>",  // unset = the session model
      "skipReadOnly": true,      // don't spend a call on read/grep/find/ls
      "onError": "allow",        // unreachable classifier => fall back to the table
      "timeoutMs": 10000
    }
  }
}
```

**Where the classifier sits is the entire safety argument**, because a model can be argued with —
that is what prompt injection *is*. So it is placed where being wrong is survivable. Precedence
becomes **deny → destructive → ask → allow → classifier**: it is consulted *only* on calls the
deterministic policy already decided to allow, and its only power is to turn that allow into an ask.
There is no verdict it can return that runs something the rules would have stopped, and none that
blocks outright either — a nondeterministic judge should not get to refuse your work with no way to
overrule it.

That gives a floor worth stating plainly. **Fully compromised, auto mode degrades to
`askDestructive`** — the default this repo has been running all along. Working, it is that plus a
second opinion.

One exception, because an earlier version of this paragraph claimed there was none: **with no UI the
classifier can fail a run.** `askWithoutUi` decides what an "ask" becomes headless and defaults to
`deny`, so in `pi -p` or CI an `unsafe` verdict blocks the tool call with nobody to overrule it.
That is your configured policy for asks rather than a power the classifier holds on its own, but a
false positive costs you a CI run, and `askWithoutUi: "allow"` is the way out.

The classifier is shown the tool, the call, and the working directory — **and nothing else**. No
transcript, no task, no history. Partly cost, mostly injection: a classifier that reads the
conversation can be talked into clearing a command by text earlier *in that conversation*, which is
exactly the attack the gate exists to stop. Judging in isolation means the only thing that can argue
for a command is the command. The call arrives stripped of invisible characters, fenced with markers
it cannot forge, and labelled untrusted, and the classifier is told that text inside the fence
claiming pre-approval is itself grounds to answer unsafe.

Three limits worth knowing before you turn it on:

- **It costs money and latency, per tool call.** `allow` rules short-circuit it, so a decent
  allowlist is what makes the mode affordable; verdicts are cached for the session, so the test
  command an agent runs forty times is paid for once; and `permissions.auto.model` exists so this is
  never a frontier call. `/permissions auto` shows what it has spent.
- **`write` and `edit` are judged on their path, not their content.** Content is unbounded and is
  the richest injection surface there is, and the question that matters for a write is *where* it
  lands — a `.zshrc`, a git hook, a file outside the project.
- **Reads are skipped by default** (`skipReadOnly`), because paying for a model call before every
  `grep` makes the mode unusable. Reading a file is still how a secret gets exposed, so `deny` rules
  remain the answer for `.env` and friends; set `skipReadOnly: false` to close the gap at the price
  of a call per read.

An unreachable, misconfigured, or unreadable classifier is an **error**, never a silent "safe" — the
only way to get a clearance is for the model to have literally answered `{"safe": true}`. What an
error then means is `onError`: the default `allow` degrades the session to the pattern table alone
and says so once, out loud, because a session that believes it is being checked and is not is the
more dangerous misunderstanding. `ask` is the paranoid setting.

`/permissions auto` shows the configuration and the session's tally; `/permissions classify <command>`
asks the real classifier about one command without running it. `/permissions test` stays free and
offline, and reports a classify outcome as the unanswered question it is. `/permissions forget`
drops cached verdicts along with grants — a remembered "safe" is an approval in every sense that
matters.

One layering subtlety: the mode ladder is not a total order, and `auto` is where that shows. It is
not a subset of `askMutating`, which prompts for every write but says nothing at all about custom
tools. So an untrusted project may not "tighten" `auto` into `askMutating` — only `askAll` and
`denyAll` count as an upgrade from it. The whole `auto` block is trusted-only for the same reason:
every field in it can loosen something, and a repo quietly pointing your classifier at another model
should be visible, not merely ineffective.

**This is a guardrail, not a sandbox.** It gates tool calls before they run; it cannot contain code
that is already executing, and `bash` remains able to do anything the pattern table does not name —
nor, in auto mode, anything a model was talked out of naming.

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
| `auto.ts` | Auto mode: the classifier's cache, books, and bounds |
| `prompt.ts` | **What the classifier is shown — edit this to tune it** (pure) |
| `classify.ts` | One classifier call |
| `verdict.ts` | Reading the answer; unreadable is never "safe" (pure) |
| `model.ts` | Resolving `permissions.auto.model` |
| `corpus.test.ts` | 171 safe / 85 dangerous commands the table must get right |
| `auto.test.ts` | Auto mode's bounds: precedence, layering, what reaches the model |
| `auto.live.ts` | Classifier accuracy against a real model (costs a few cents) |

**`agent/extensions/provider/`** — adds `/provider`: switch every model this config uses, at once.

Six extensions here resolve a model reference of their own — advisor, goal, permissions' auto
classifier, recap, subagents, ultracode — and pi has `defaultProvider`/`defaultModel` on top.
Written out concretely, changing provider means finding eight fully-qualified `provider/id` strings
across two files, and every one you miss goes on quietly billing the old provider.

So a setting names a **role**, and roles are defined per provider:

```jsonc
// agent/settings.json
"models": {
  "active": "openai",
  "providers": {
    "openai":    { "session": "openai-codex/gpt-5.6-sol", "frontier": "openai-codex/gpt-5.6-sol", "fast": "openai-codex/gpt-5.6-terra", "cheap": "openai-codex/gpt-5.6-luna" },
    "anthropic": { "session": "anthropic/claude-opus-5",  "frontier": "anthropic/claude-opus-5",  "fast": "anthropic/claude-sonnet-5", "cheap": "anthropic/claude-haiku-4-5" },
    "qoder":     { "session": "qoder/ultimate",           "frontier": "qoder/ultimate",           "fast": "qoder/auto",                "cheap": "qoder/lite" }
  }
},

"advisor":     { "model": "frontier" },
"permissions": { "auto": { "model": "cheap" } }
```

`/provider anthropic` then moves all of it, including the live session model, and prints what each
role became. `/provider` on its own shows where things stand. Role names are yours — `session` is
the only reserved one, and it is what `/provider` writes into pi's `defaultProvider`/`defaultModel`
and pushes into the running session with `setModel`. Those two keys can't be roles themselves: pi
resolves them before any extension runs.

**`session` and `frontier` are worth keeping apart even when they name the same model**, which they
do above. They answer different questions — what you talk to, versus the best thing available — and
the day you put the session on something faster, anything pointed at `session` follows it down.
`advisor` is the case that makes this concrete: it exists to consult a *stronger* model than the one
you are running, so pointing it at `session` quietly defeats it.

**The map is a data contract, not a module.** Every extension here installs independently and may
not import across boundaries, so each carries its own fifteen-line reader — the same arrangement as
the `usage:spend` channel. Consequences worth knowing: this extension is optional (roles work
without it; you just edit `models.active` by hand), and `provider.test.ts` asserts the six copies
have not drifted from the original, so a fix in one is not silently missing from the others.

Every failure returns the reference untouched — no block, a malformed one, an unreadable
settings.json, a role nobody defined. So the feature can be absent, broken, or half-configured and
model resolution behaves exactly as it did before roles existed. A concrete `provider/id` still
works everywhere, for the settings you want pinned regardless of provider.

Two things the switch report says out loud, because both are how you would otherwise find out from
a bill: a role the new profile does **not** define stops being a role and starts being read as a
literal model reference, and a `session` role whose provider has no API key leaves the live model
where it was. `setModel` returns false in that case, so that is reported rather than guessed.

| File | Role |
| --- | --- |
| `index.ts` | The `/provider` command |
| `roles.ts` | Reading the block; **`resolveRole` is the copied part** |
| `settings.ts` | Rewriting settings.json — atomically, preserving every key it does not own |
| `config.ts` | The contract and the reserved `session` role |
| `provider.test.ts` | Fallbacks, the switch plan, the writer, and copy drift |

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
entry, a sparse nudge every 10th user turn, and one exit notice when it goes off. Changing the
thinking level away from xhigh exits the mode. The mode survives session resume: toggles are
replayed from the branch, and delivered reminders are counted so a resumed session continues the
cadence instead of re-announcing.

**What the mode means was rewritten after measuring it.** It used to say *"optimize for the most
exhaustive, correct answer"*, *"use the Workflow tool on every substantive task"* and *"token cost
is not a constraint"*. A 39-turn session on this machine then cost $25.16, of which **three
workflow turns were 83% of the input tokens, 93% of the cached reads and 88% of the output**. The
model was doing exactly what it had been told.

The surprise was in the shape of the spend. Those runs were **four and five agents wide** — fan-out
was never the problem. `pi-desktop-implementation` was 4 agents and **264 agent-turns**, about 66
turns each, for $9.67. Cost is driven by how long an agent runs, not how many you start, and pi has
no `--max-turns` for a headless run: an agent stops when it decides it is finished. Wall-clock is
the only hard bound there is.

So the mode now reads as **permission rather than instruction** — reach for a fleet when the task's
shape needs it (coverage wider than one context holds, independent verification of a claim you
cannot check yourself, a mechanical sweep over many files) and work inline when it does not — and
the tool description gained a **Bounding an agent** section, with the matching discipline in the
subagent preamble: do what the task asks and then stop, do not widen scope, returning early is
correct. The tool description is *not* smaller for this; it sits in the cached prefix, where ~2.7k
tokens cost a few cents across a long session, so it is written for behaviour rather than brevity.
The e2e suite asserts both the presence of the new sections and the **absence** of the old phrasings,
because the old phrasings are what the spend was made of.

### Nothing is capped

There used to be an `ultracode.limits` block over most of this — a concurrency cap, an agent cap per
run, an item cap on `parallel()`/`pipeline()`, a per-agent wall-clock ceiling, and character budgets
on forked context. All of it is gone, and the reasoning is worth keeping because it is the opposite
of what a limits block is usually for.

None of those caps ever bound a run that was going *well*. Measured here, the runs that hurt were one
agent deep for an hour, and no ceiling shortens that — the ceiling had in fact been raised to ten
hours precisely because at ten minutes it was killing work in progress, which wastes everything the
agent already spent and leaves nothing to resume from. A cap that you have to disable to get correct
behaviour is not protecting you.

So: **an agent runs until it finishes or you abort it.** There is no timeout.

One bound survives, and it is a different kind of thing: a **process-wide ceiling of 32 concurrent
subagents**, shared by every run. Not the per-run throttle that was removed — a single fan-out of
thirty still starts together — but `/workflows` supports several runs at once, and N runs × M agents
with nothing counting is N×M `pi` processes, each a node process with a model connection. That is not
a slow workflow, it is a fork bomb with a progress bar.

The per-run `peakConcurrency` in `run.json` cannot see this: it is measured inside one run, so two
runs peaking at eight apiece read as "8" twice and the sixteen appears in no field anywhere. There
was no observation short of the machine falling over — which is why this one is a backstop rather
than something to wait for evidence on.

Past the ceiling, agents queue and are dispatched **round-robin across runs**, so a hundred-agent
sweep cannot starve a two-agent workflow queued behind it. Within a run the queue is FIFO. Breadth is now free to ask for and entirely the script's
responsibility to get right — the tool description says so in as many words, and pairs it with the
decomposition guidance that makes a wide run the *normal* shape for implementation work rather than a
special case.

Two internals survive, and neither is a budget: `retainRuns` (how many run directories to keep before
the oldest are pruned — without it the store grows without bound) and `schemaRetries` (how many times
to re-ask an agent whose JSON did not parse). Both are fixed constants in `config.ts`, not settings.

A leftover `ultracode.limits` block in `agent/settings.json` is inert; nothing reads it.

### Why the output did not work

Slow and wrong turned out to have different causes, and the second one was partly self-inflicted.

The workflow that ran for an hour produced an Electron backend that did not start. Both its agents
reported success, and neither was lying: between them they ran 36 bash commands — `pnpm check`
twenty-five times, plus `pnpm test` and `pnpm build` — and the final reports said "`pnpm check`
passes" and "`pnpm test` passed 17/17 tests across 4 files".

Grepping those 36 commands for anything that touches the real application returns **one** hit in the
implementer (`command -v electron`, a *which* check) and **zero** in the adversarial reviewer that
followed it. Electron was never launched. A real `pi` process was never spoken to. The 17 tests ran
against a fake RPC fixture that the same agent had written earlier in the same run.

Two things caused that, and both are fixed:

**The script named a finish line the agent could satisfy by writing it.** The implement prompt ended
"Run pnpm check"; the review prompt said "rerun `pnpm check`, and report evidence". A typecheck
proves the code compiles. Tests an agent wrote against a fixture it also wrote are a closed loop that
closes green whatever the code does. The tool description now says this in as many words, with the
measurement attached, and asks for acceptance stated against the real artifact — start the binary and
see it answer, drive the actual endpoint, run the pre-existing suite and not just the new one — with
the exact command and the observable that means success.

**The subagent preamble told them not to check.** It read "Do what the task asks and then stop. Do
not widen the scope, do not verify beyond what was asked…". That clause was written to stop a
*research* agent grinding through 90 turns of one-more-thing, and to an implementer it reads as
permission to ship unrun code. Self-verification is now carved out of the stop-early rule
explicitly — checking what you built is the last step of the task, not a widening of it — along with
an instruction to report what was observed rather than what was intended, and to say plainly when the
only thing that ran was a typecheck. The e2e suite asserts the old phrasing stays gone, because its
return brings the behaviour back.


The **`workflow` tool** is the thing the reminders point at: the model writes a plain-JS script
with `export const meta = {...}` and orchestrates subagents with `agent()`, `parallel()`, and
`pipeline()` (plus `phase()`/`log()` for progress and an optional JSON `schema` per agent, with
one retry on unusable output). Each subagent is a headless `pi --mode json -p --no-extensions
--no-skills` subprocess in the project directory — pi's own vendor pattern — so a wedged agent
cannot take down the session, subagents cannot recurse into further workflows, and project trust
is forwarded (`--approve` only when the parent session trusts the project). Concurrency is
unbounded and there is no timeout — see **Nothing is capped** above.

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

**A run is judged on its agents, not on the script returning** — a rule bought at some expense.
`agent()` returns `null` on failure and the script is free to carry on, so a script that swallows
every failure and returns a perfectly valid value used to be recorded `done`. Five runs in the local
store did exactly that: an ambiguous model reference from an older `subagents.json` killed all four
or five agents on spawn, and each run was filed as **`done`, 0 turns, $0.00**. Told a workflow had
succeeded, the model wrote a fresh one under a new name — `-fallback`, `-default` — and paid for the
same discovery three and four times over.

Now the agents are counted. If every one failed, the run is an `error` whatever the script returned:
the panel says so, a `wait: true` call throws, and the message carries the first failure once
(a dead fleet is almost always one cause repeated, and printing it five times buries the single
thing to fix). If only some failed the run stays `done` — four good results should not be thrown
away because a fifth verifier died — but the summary says `N FAILED` and calls the result
incomplete, so the gap is not silently inherited by whatever gets built on it.

Every failure path now also says **resume instead of re-authoring**, in those words. Across 23 runs
in the local store `resumeFromRunId` was used exactly zero times, while three of four attempts at one
implementation died and restarted from nothing — $11.15 and 72 minutes in runs that finished with
no result, whose successful agents were sitting on disk the whole time. The interrupted-run notice
also used to list every dead run but offer a resume call for only the first, so a session that lost
three was told how to recover one.

**Agents can be forked context.** `agent(prompt, { context: { parent: 6, files: [...], text: ... } })`
seeds that agent's session with recent turns of the conversation, whole files, or literal
background, instead of the script pasting everything into a prompt string. It is built with pi's
own `SessionManager` as a user message plus a one-line assistant acknowledgement — both are
required, since providers reject consecutive user messages and pi only flushes a session to disk
once it holds an assistant turn. `agentType` borrows a standing definition from `subagents.json`
(its tools, role prompt, model and reasoning level), and `tools` pins an allowlist directly.

**Agents can share a session.** By default every agent is a fresh pi run that forgets everything on
exit, so a three-stage pipeline derives the same understanding three times — which is most of why
one measured build re-ran "discovery" four separate times. `agent(prompt, { session: "explore" })`
makes several calls continue **one** conversation: the second sees what the first actually did, its
tool calls and its dead ends, rather than a summary someone had to write into a prompt.

It works because `--session-id` pointing at an existing session makes pi **open** it rather than
create one (`main.js`) — the same mechanism context seeding already relied on. The id is
`<runId>-s<slug>-<hash>`: slugged so the file is recognisable, hashed so it is injective, because
two script names that collided ("my session" and "my-session" slug identically) would silently merge
two chains into one transcript. The `-s` prefix keeps it out of the `-a<index>` namespace, so an
agent named "1" cannot land on agent 1's file.

Three properties are enforced rather than documented, because each failure mode is silent:

- **Sequential.** Two agents holding one name at once fails the *run*, not just the agent. A
  conversation cannot have two authors, and by the time a second claimant arrives the chain's
  ordering is already undefined — every later link would read state assembled in an unknown order
  and return answers that look right. The claim is taken before the pause and the semaphore, so the
  error is immediate and does not depend on the concurrency limit. Inside `pipeline()`, give each
  item its own name (`session: \`file-${index}\``) so items stay independent while their stages chain.
- **Never replayed.** Resume allocates a fresh `runId`, so a replayed agent writes no session file
  into the new run; a later live agent in the chain would find nothing, quietly start a new
  conversation and answer without the accumulated context. Replaying only when the *whole* chain
  replays can't be decided up front — `pipeline()` has no fixed order — so the chain re-runs, and
  says so in the log rather than leaving it to be discovered from a bill. `session` is also part of
  the agent key, so a later plain agent with the same prompt can't be served a chained result.
- **Seeded once.** Seeding *creates* a session file, so only the first agent in a chain may take
  `context`; a second would leave two files claiming one id with a directory scan deciding which pi
  opens. A later `context` is refused with a log line rather than silently dropped.

Reach for it when stages build on each other over the same subject — inspect → change → verify one
file — not as a general way to share context. It is not a substitute for working inline: your main
session is already one accumulating context, with your extensions, memory and you in it. And note
that subagents run `--no-extensions`, so a long chain that fills its window compacts with pi's
built-in behaviour, whatever the parent session is configured to use.

**Workflows don't block the session.** The tool validates the script — meta *and* a compile check,
so a syntax error fails the call rather than arriving minutes later as a failed run — starts the
fleet, and returns immediately with a run id; the main agent keeps working while the bottom of the
footer shows each run's phases, agent counts and elapsed time. ultracode does not draw that
itself — it announces the lines on the `ultracode:panel` event channel and the statusline appends
them, the same decoupling `permissions` → `cmux-notify` uses. When a run settles
its outcome comes back to the model as a `workflow-result` message: a follow-up if the agent is
mid-turn, a turn of its own if the session is idle, so results get processed the way a task
notification would. The model can pass `wait: true` for the rare workflow whose result it needs
before doing anything else; only those attach their spend to the tool result as `usage`, which is
what puts them in `/usage` under their tool name (a background run's tool result is long gone by the
time money is spent, so its spend arrives on the `usage:spend` channel instead).

**The workflow control panel is a panel, not a list.** `shift+↓` at the prompt opens it, and
`/workflows` still does — the footer line advertising it sits directly under where you type, so
reaching it should not need a typed command. It takes the editor's
place at the bottom of the screen — framed by a rule above and below, key hints under the lower one — the same slot pi's own
selector and an `ask_user` question use, and the statusline stands down for it, so the panel owns
the prompt and the footer between them. Three levels: this session's runs, then one run's phases
and agents, then one agent. `↑↓` selects,
`→`/`←` moves between levels, `p` pauses or resumes, `c` cancels, `g` toggles the log pane, `x`
exports the selected agent's transcript to HTML, `e` shows where its stderr was written, and `R`
puts a resume instruction in the editor for you to send. The trade is ask_user's: while the panel
is up there is no prompt to type into, so `q`, `ctrl+c` and Esc all close it (Esc a level at a
time) — and Esc-to-interrupt is unavailable until you do, which a one-key gesture makes that bit
easier to trip into. Pausing is live: in-flight agents finish and new ones park at a gate, so a run can be held
mid-fleet and let go again. The subcommands remain for scripting:
`/workflows list|show <id>|pause <id>|resume <id>|cancel [id]`.

**Runs are shown by name, not by id.** `wf-0ms5sqq7r-6` is fourteen characters of base36 in a line
the statusline clips, and there is nothing in the panel you address by id anyway — you select with
the arrows and act with a key. So the panel, the footer lines and the transcript row all read
`migrate-parser`, and the start time takes the id's place in the run list, since with names alone
five `code-review` runs are otherwise indistinguishable and `c` cancels whichever one the caret is
on. Clock time for today's runs, a date for older ones:

```
▸ ◆ migrate-parser  running · 5 agent(s) · 1m35s · 16:01
  ✓ code-review     done · 12 agent(s) · 3m20s · 14:03
  ✗ code-review     error · 3 agent(s) · 1m00s · Jul 27
```

Ids survive exactly where something has to be *named*: `/workflows list` and `show` print them in
trailing brackets, because finding an id to pass to `pause`/`cancel`/`show` is the only reason to
type those rather than open the panel; argument completion offers `cancel code-review (16:01)` as
the label and inserts the id, and matches on either, so you can complete by the name you know — with
the same start-time disambiguator, since five identical labels that insert different ids are worse
than the base36 they replaced. The model-facing text is untouched — the tool result, the
`workflow-result` message and the `R` resume instruction all carry the run id, since
`resumeFromRunId` is the only handle that identifies a run to the tool.

**Spend is tracked here and reported in `/usage`.** No workflow surface quotes a price — not the
panel, not the footer line, not `list` or `show`, not the transcript row, not the summary the model
gets back. Watching work and watching money are different activities, and a live dollar figure
under the prompt is a thing to stare at rather than read. Nothing is lost by moving it: each run
announces under its own name, so `/usage` reports a row per run inside the `workflows` total and
answers "which of these five cost $40" there instead.

The numbers are still collected, and collected *promptly*: a subagent reports usage on every turn
it takes and the run folds each one in as it arrives, rather than when the subprocess finally
exits. `run.json` keeps a per-run total (written on a throttle while agents stream) — the only
place per-run cost is now recorded, since no command prints it — and each turn is announced on the
shared `usage:spend` channel, which is where `/usage` gets a workflow row it could not otherwise
know about.

A `wait: true` run announces **nothing** while it runs: pi already attaches its spend to the tool
result, which `/usage` reads off the transcript as a `workflow (tool)` row, so announcing as well
would bill every synchronous workflow twice. The exception is a run that fails or is cancelled —
`execute` throws, pi builds the error result itself and that one carries no usage at all, so the
run announces its total on the way out. The two doors stay exclusive; which one opens depends on
how the run ended. Announcements also stop the moment a run is aborted, so children still dying
after `/new` cannot bill the next session for tokens it never spent.

**The list is scoped to this session — with one exception.** `/workflows` and its `list` show the
runs this session started, not fifty deep of history; the store keeps 50 of them and every
one is still on disk. Runs from another session stay reachable where you name them explicitly:
`show <id>` reads any of them and says which session it came from. A run is matched by the session
id recorded in its `run.json`; a run this process is *driving* is always listed whatever that says,
so an ephemeral session (`--no-session`, which has no id to match) still sees its own fleet.

The exception is **an interrupted run nothing has resumed**, which crosses the session boundary and
stays in the panel until it is picked up or pruned. Scoping it out was a mistake with teeth: `R
resume run` lives in that panel, so the filter removed the only way to reach the very run the notice
was telling the model to resume, leaving its id recoverable only by opening `run.json` by hand. A
run counts as dealt with once another records it as `resumedFrom`, at which point it drops out
again. Aborted and errored runs stay scoped out — the first was cancelled deliberately, the second
already reported its failure, with a resume hint, in the session that ran it.

Runs still do not survive a session switch — shutdown cancels the fleet — but that is no longer
silent. A run whose owning process is gone is reconciled to `interrupted` on next start, and the
model is told which ids died *and that each is resumable*, rather than the old approach of scraping
its own transcript for the sentence that announced them.

**And it keeps being told.** `reconcile()` skips anything already settled, which is right for
"this died a moment ago" but made the notice a one-shot: a run not resumed in the very session
after the crash was never mentioned again, and had just left the panel as well. Runs still owed are
now gathered separately and repeated once per session start until something resumes them. That
second half of the notice is deliberately quiet — it tells the model to raise them *only if they
bear on what the user is asking now* — because it recurs, and a nag on every unrelated turn would
be worse than the silence it replaced. The list is capped at three with the remainder counted, not
dropped.

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

**What an agent inherits, most specific first:** `agent(…, { model })` → the agentType's own model →
`subagents.json`'s `defaults.model` → the run default (`ultracode.model`, else the **session's**
model). The same chain applies to the reasoning level.

The `defaults` link was missing until it was measured. `agents.ts` has always parsed
`subagents.json`'s `{ defaults: { model, reasoning } }` and `tool.ts` only ever read `types`, so a
configured default was silently ignored and every unpinned agent fell straight through to whichever
model you happened to be talking to. The reasoning half was worse: with no `--thinking` passed, the
child pi reads its *own* `defaultThinkingLevel` from `settings.json` — so a session set to `max` ran
every subagent at max reasoning, which is a third to two thirds of output tokens in the measured
runs, and no amount of configuring `subagents.json` changed it.

**A word is only a model name if it resolves to one.** The vocabulary that reminder is built from
comes from splitting registry ids into segments — which quietly turned a provider called
`kimi-coding`, with models `kimi-for-coding` and `kimi-for-coding-highspeed`, into the vocabulary
word **"coding"**. Every prompt about a *pi coding agent* then looked like it named a model, and the
reminder instructed the model, in the imperative, to call `agent(prompt, { model: "coding" })` — a
reference matching two kimi models and resolving to neither. All three agents died and the run
produced nothing, on an instruction this repo generated rather than one the user gave. A `NOISE`
word list cannot fix it: "coding" and "agent" are exactly the words a coding-agent prompt contains,
and the next provider brings its own. So a segment enters the vocabulary only if
`resolveModelReference` resolves it to exactly one model — vocabulary and resolver cannot disagree.
Full ids are always included; shared family words ("kimi" here, "claude" across two claude models)
are not.

**Routing only considers models you can actually run.** The follow-up failure was `No API key found
for kimi-coding`, discovered once per agent after spawning, with the reason buried in each
subagent's stderr. Both the vocabulary and reference resolution now filter the registry by
`hasConfiguredAuth`, falling back to the full list if that leaves nothing so an unexpected auth
shape degrades rather than making every model unresolvable. A reference resolving *only* among
unusable models now fails at resolution time, naming the provider and pointing at `/login`, instead
of letting a fleet spawn and die one agent at a time.

```jsonc
{
  "ultracode": {
    "keywordTrigger": true,   // optional; whether the "ultracode" keyword opts in a turn
    "model": "fast"           // optional default for agents no request routes; a role or a reference
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
| `config.ts` | Constants and pi-side tunables |
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

**Being tool-less is also its failure mode.** The reviewer sees the transcript and nothing else — it
cannot list a directory or open a file — while being asked to be specific and to produce prioritised
next steps. So it invents concrete detail. Observed here: step 1 of a numbered plan was *"Read
`~/.pi/agent/skills/ultracode/SKILL.md`"*, a file that does not exist; `agent/skills/` holds two
symlinks and nothing else. Because the caller is told to give the advice serious weight, an invented
path becomes an errand the agent runs and finds nothing at the end of.

Both halves are now stated. The reviewer is told to stay inside what it has seen — every path,
symbol, flag or API it names must appear in the transcript — and given the alternative, which is to
say what to look *for* rather than inventing where it lives, and to mark inferences as inferences
("if X exists"). Without that alternative it would comply by going vague, which throws away the
point of the tool. The caller is told the matching rule: weight the judgment, verify the details,
and when a detail turns out wrong, take the intent rather than the literal target — a wrong filename
does not make the underlying point wrong.

The natural way to build this is a server-side tool, where the API forwards the whole conversation
to the reviewer model. pi has no such server tool, so the forwarding is done in the client — the tool
flattens the session branch (task, every tool call, every result) and runs the reviewer as a
**tool-less headless `pi` call** (`--no-tools`, so it advises and cannot act). What the agent sees is
the same either way: call `advisor()`, wait, get advice back.

That child call also passes `--thinking` explicitly (`CONFIG.reviewerThinking`, currently `medium`).
Omitting the flag does **not** mean "the model's default" — the child reads `settings.json` and
inherits `defaultThinkingLevel`, so raising that for the session being reviewed silently raised every
consult along with it, at one spawn per `advisor()` call with the whole transcript in the prompt.

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

The transcript budget is 20% of the reviewer's window (down from 50%), priced from session
`019fcad1`: seven consults forwarded 614k input tokens — advisor spawns are fresh processes, so
none of it cached, and the over-window ones billed at gpt-5.6's doubled long-context rate — $3.20
of transcript for seven answers. Advice quality lives in recent state and the transcript already
drops oldest-first, so the cheap 80% is the stale 80%; on sol this still forwards ~54k tokens.

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
code-explorer      gpt-5.6-terra  High      Read-only codebase discovery and investigation
quick-implementer  gpt-5.6-terra  High      Small, well-defined changes in one or two files
implementer        gpt-5.6-terra  High      Features and bug fixes with tests and validation
code-reviewer      gpt-5.6-sol    Low       Review diffs for correctness, security, and quality
commit-pusher      gpt-5.6-luna   Low       Stage, commit, and push completed changes
```

Every subagent names a **role** rather than a model (see the `provider` extension): `fast` for the
three that do the engineering, `frontier` for the reviewer, `cheap` for the one that only runs git.
Each says its own role even where `defaults` would supply the same one — a subagent's tier is part
of what it is, and reading it off the agent beats inferring it from a default three entries up. `code-reviewer` names `frontier` and not `session` deliberately — reviewing diffs wants the
best model available, so tying it to whatever you happen to be chatting with would quietly downgrade
it the moment you moved the session to something quicker.

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

**`agent/extensions/tool-batching/`** — six lines of prompt, because turns are what a task costs.

pi's system prompt never mentions batching tool calls, and it turns out that is the largest
avoidable cost in a long run. Profiling the workflow agent that ran for 53 minutes on this machine:

| | |
| --- | --- |
| assistant messages | 151 |
| **made exactly one tool call** | **142** |
| batched (3–4 calls) | 7 |
| tool calls total | 166 — 73 edit, 32 write, 25 bash, 19 read, 12 grep |

The agent was not over-exploring — only 31 of 166 calls were reads or greps. It was *building*, one
round trip at a time. And a round trip is not free: that run re-read **16,310,272 cached tokens
across 177 turns**, about 92k tokens of context per turn, whether the turn carried one grep or ten.
Reads, greps, finds and `ls` are almost all mutually independent, and so are edits to files that do
not overlap; batching those removes turns one for one.

pi has supported this the whole time. `agent-loop.js` sends the calls in one assistant message
through `executeToolCallsParallel` unless some tool in the batch declares `executionMode:
"sequential"` — which `ask_user` does, deliberately, because it blocks on a human. Nothing needed
building. The model simply was never told. (Claude Code carries this instruction in its own system
prompt, which is part of why the same task finished there in half an hour.)

The guideline names the exception as loudly as the rule, because "always batch" would have an agent
editing a file it has not read: serialise on a *real* dependency — needing the first result to
decide the second call — and not because one-at-a-time reads more tidily.

There is no settings block. It is six lines of prompt describing how the tool loop already works,
and a kill switch would be more code than the feature.

Reaching a subagent needs a second copy: workflow agents and `task` subagents spawn with
`--no-extensions`, so no extension can touch their system prompt and the rule travels in their
`--append-system-prompt` preamble instead — in `ultracode/description.ts` and `subagents/tool.ts`.
Duplicated text rather than a shared import, per this repo's no-cross-extension-imports rule, so
both copies are pinned by assertions in their own suites.

| File | Role |
| --- | --- |
| `guideline.ts` | **The rule, and the measurement that justifies it** (pure) |
| `index.ts` | One `before_agent_start` append — chained, never replacing |
| `tool-batching.test.ts` | The text, the short subagent variant, and that the append does not clobber |

**`agent/extensions/context-diet/`** — stops a long turn paying for context it stopped reading.

pi decides whether to compact in exactly two places: after `agent_end`, and before a new prompt.
Both are turn boundaries. Inside a turn, `_runAgentPrompt` awaits the whole tool loop before the
check is reached (`agent-session.js:776`), so `shouldCompact()` is unreachable for the duration —
however many hundred calls that is. Its own docstring says as much: *"Called after agent_end and
before prompt submission."*

Session `019fcad1` is what that costs. One prompt, one turn, 2h44m, 399 model calls, 530 tool calls,
**$125.86**:

| | |
| --- | --- |
| context, first call → last | 12,641 → **375,108** tokens, against a 272,000 window |
| calls above the window | **219 of 397** |
| first compaction | overflow recovery, *after* the API returned "your input exceeds the context window" |
| second compaction | at `agent_end`, 51s after the final answer — 347k summarised, then never read |
| both compactions | $7.47, cache disabled by design, billed at the over-window rate |

The threshold itself was set correctly — `272000 - 16384` reserve is 255,616, comfortably under the
cliff. It was simply never evaluated. And the cliff is where the money is: gpt-5.6 doubles every
rate above 272k (in $5→$10, cached $0.50→$1.00, out $30→$45 per Mtok), so those 219 calls cost
$81.85 of the $107 main-loop spend. The split is exactly clean — the largest 1× call carried
269,836 tokens, the smallest 2× call 273,729.

So this trims what gets *sent*, per call, and leaves the turn alone. The `context` hook runs inside
`streamAssistantResponse` on every LLM call and rewrites only the copy bound for the provider;
`context.messages`, the session and the JSONL are untouched, so `/compact`, `/rewind`, fork and tree
navigation all still see the full history. Nothing is aborted — which rules out the obvious
alternative, because `ctx.compact()` can be called mid-turn but opens with `await this.abort()`, and
killing a 2.7-hour harness run to save tokens is not a trade worth making.

Over the high-water mark (80% of the window) a round drops the bodies of old tool results, oldest
first, down to a target of 55%. Errors are never dropped, nor are the newest 24 results — the live
working set. Two kinds of staleness reach inside that recent window anyway: screenshots (only the
newest 3 survive, because one goes stale the moment the next is taken and costs ~1.2k tokens to
keep saying so) and superseded reads — when a file has been read again, every older copy is a
*stale* version of something the model is probably editing, so rounds sweep those even past the
target. "Superseded" is deliberately narrow: a later whole-file read covers any earlier read of
that path, an identical (path, offset, limit) covers its exact duplicate, and a later partial read
covers nothing — the model may still be using the rest. The measured session read three of its own
source files three times each. Each dropped body becomes one line naming the call and its size —
and for a superseded read, saying the fresh copy is below — so the model can find what it actually
wants.

`dropOldReasoning` (default **off**, experimental) lets rounds also strip thinking blocks from all
but the newest 10 assistant messages. The measured session carried 1MB of encrypted reasoning
signatures across 455 messages — on the order of 10–25% of peak context, re-read on every call;
replaying with the flag on saves another ~$6 (est., likely high — the replay prices signatures at
chars/4 and the API bills the decoded reasoning). Off by default because the failure mode is a hard
400, not a quality dip: the Responses API can reject a replayed `function_call` whose paired
reasoning item is missing, and whether that check reaches long-completed rounds is undocumented.
Validation plan: turn it on for one real harness session; if a turn dies with "was provided without
its required reasoning item", turn it back off — nothing else changes and the session is intact.

Two invariants carry the whole thing, and both are asserted directly:

- **A dropped result is replaced, never removed.** Remove the message and every later request is
  rejected for having a tool call with no result — which reads as a provider outage, not a bug here.
- **A stub renders byte-identically forever.** Evictions are permanent for the session and built
  from facts fixed when they were made. The prompt cache invalidates from the first byte that
  differs, so a diet that re-decided each call would move that byte every call and re-bill the whole
  context uncached — ten times the cached rate, and strictly worse than doing nothing. The gap
  between the two ratios is the hysteresis that keeps rounds rare; narrowing it is the one change
  here that can cost more than it saves.

Replaying `019fcad1` through it, charging each round's cache break in full:

| | real | with the diet |
| --- | --- | --- |
| peak context | 375k | **218k** |
| calls above the cliff | 219 | **0** |
| main-loop cost | $107.00 | **$52.71** |

Five rounds across the session, 180 results stubbed. Peak never reaches 255,616 either, so the
overflow that forced the first compaction does not happen and the unread second one does not fire —
the $7.47 goes too. Main-session only: workflow and `task` subagents spawn with `--no-extensions`,
and they were never the problem — 270 subagent calls cost $5.35 between them, because each starts
empty.

| File | Role |
| --- | --- |
| `diet.ts` | **What gets dropped, and what the model reads instead** (pure) |
| `session.ts` | The per-session eviction sets — stickiness and hysteresis (pure) |
| `config.ts` | Settings, defaults, and the validation that rejects an inverted pair |
| `index.ts` | The `context` hook, and the resets that clear the sets |
| `render.ts` | The one-line transcript entry |
| `context-diet.test.ts` | 101 checks, both invariants included. Imports pi for types only, so it runs from a bare checkout |

**`agent/extensions/stalled-turn/`** — resumes a turn that ended because the provider sent nothing.

When a provider finishes a response having produced no content and reports `stopReason: "stop"`, pi
ends the turn — correctly, because "stop" means the assistant is done. But the assistant never said
anything, so the work halts mid-task with no error, no explanation, and nothing distinguishing it
from a genuine finish. That is the "it terminated halfway" failure.

The known offender is **`pi-provider-qoder` 0.2.9**, whose stream finalisation ends with:

```js
if (toolCallsState.length > 0) output.stopReason = "toolUse";
else output.stopReason = "stop";
```

run unconditionally, **overwriting the real `finish_reason`** captured forty lines earlier. Any
stream ending without tool calls — a dropped connection, a truncated SSE, a `length` cap, a content
filter — is reported as a clean finish. Every local qoder session ends with `content: []`,
`stopReason: "stop"` after four to eight successful tool calls. The bug also destroys the evidence
needed to diagnose it: the discarded `finish_reason` is the field that would say which of those it
was. (Its other defect is unrelated but worth knowing: `usage` is initialised to zeros and never
populated, so qoder spend is invisible to `/usage`. That does *not* break compaction — pi's
`getAssistantUsage` rejects all-zero usage and falls back to a chars/4 estimate.)

Nothing in the extension is qoder-specific, because nothing needs to be: an assistant message with
no content at all is never a legitimate reply, whoever produced it. Thinking blocks don't count as
content — reasoning with no reply is still no reply, and it's a shape qoder produces. `aborted` and
`error` are excluded: the first is the user pressing escape, and resuming would fight them; the
second is already reported, and resuming would loop on a real fault.

**Recovery has to re-enter the loop.** No hook can make pi continue — `message_end` can replace a
message but the loop only continues on tool calls, and forcing `stopReason` to `error` would just
end the turn with an error instead. So the extension sends one message saying the reply was lost and
to carry on from the existing tool results, phrased as a transport fact rather than a reprimand (the
model didn't choose to stop; telling it to "continue as instructed" invites it to apologise and
re-plan).

**The cap is the load-bearing part.** A provider stuck returning empty completions would otherwise
loop forever, spending real money producing nothing and looking like a hang. Two resumes per *human*
turn — counted per human turn, not per loop iteration, because the resume itself triggers a turn and
a turn-based reset would refill the budget every time and make the cap meaningless. Only an
interactive prompt refills it. When the cap is spent the extension says so; giving up silently would
reproduce the exact symptom it exists to remove.

```jsonc
{
  "stalledTurn": {
    "enabled": true,    // optional
    "maxResumes": 2     // optional; 0 detects and reports without ever resuming
  }
}
```

| File | Role |
| --- | --- |
| `index.ts` | Settings, the `message_end` hook, the per-human-turn budget |
| `detect.ts` | What counts as a stall, and the provider bug behind it (pure) |
| `config.ts` | Settings and the resume prompt |
| `stalled-turn.test.ts` | Detection, settings, the cap, and the reset guard |

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

**The guidance was written against one failure mode and caused the other.** Asking permission
instead of doing the work is the noisy failure, and every line pushed against it: *only* when,
*genuinely* blocked, *cannot* resolve, *do NOT*, *prefer acting on a reasonable default*. Nothing
said when asking was right, so the tool went unused where it mattered and the model guessed on
things it had no way to guess — surfacing at the end as work built on the wrong premise. That
failure is the worse one precisely because it is invisible: a needless question costs one
interruption, a wrong assumption can cost the whole task.

So the positive case now comes first and concretely — ask when two readings lead to *materially
different work*, when the choice gets baked into a schema or an API that later work depends on, when
the answer is a preference or business rule that exists nowhere in the repo, or when a long piece of
work is about to rest on an assumption. The prohibitions keep their force but come after, scoped to
what they were always about: permission, verification, and handing back judgment the task already
settles. The dividing line is stated once — *is this information only the user has?*

The model calls `ask_user` with **1-4 questions at once** — the bound is `CONFIG.maxQuestions`,
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

**This one has no settings block and no off switch.** Every other extension here is configurable;
this one is not, deliberately. An agent that asks when the decision is genuinely yours is not a
preference to be tuned, it is how the agent is meant to behave — and a knob for it is only ever a
route back to a tool that exists and never gets used. A stray `askUser` block left in
`settings.json` is inert, and `/ask-user off` does nothing.

The one condition is that somebody is there to answer, which is a fact about the session rather than
a choice about it: in a headless run (`-p`, an `--mode json` subagent) `ctx.hasUI` is false, the tool
is not offered by active-tool sync, and the opening nudge below stays quiet. If the model somehow
calls it headless anyway it gets a graceful "no user available, proceed" result instead of hanging.
`/ask-user` reports that state and `/ask-user test` runs two sample questions — one of them
recommended — so you can try the arrows, the badge, Tab notes and review live.

### Getting it used at all

Offering the tool turned out not to be the same as getting it used, and the gap is **timing, not
wording**. The description, the prompt snippet and the guidelines all live in the cached prefix:
read once, above twenty other tools, long before there is a request to weigh them against. By the
time a request lands with three unresolved decisions in it, the only thing in recent context is the
request — and a model trained to be autonomous starts working. Rewriting the description to name the
cases where asking is right changed nothing, because none of it was being read at the moment it
mattered.

The agents that do ask — Claude Code, Qoder — ask at turn zero, before the first file is touched,
because that is the only cheap moment. So `nudge.ts` fires exactly there. When a human prompt looks
like it **opens new work**, a hidden reminder rides into that turn alongside the request: settle the
decisions that are the user's to make now, in one `ask_user` call, before building on a guess.

The detector is narrow and biased toward silence. A continuation (`also…`, `now do the other one`)
is work already framed, and its decisions were settled on the turn that opened it. An informational
lead (`why does…`, `check whether…`) asks about the code, and the answer is to go and look, never to
ask back. Anything under six words is a follow-up — real task statements are not four words. What
survives is the shape that carries expensive decisions: `build…`, `implement…`, `refactor…`, and the
verbless intent openers (`I want the agent to…`, `we need something that…`) that most substantial
requests actually use.

The reminder's second half is as load-bearing as the first. "Consider asking" on its own reads as
"ask", which is the opposite bug and the one the tool description spends four lines warning about —
so the same reminder says, in as many words, that finding nothing is the common case and the correct
response to it is to state the assumption in one line and get on with the work.

A cooldown (`CONFIG.nudgeCooldownTurns`, 8) keeps a session of successive task statements from
pulling the same reminder in over and over; the previous one is still in context and still applies.
And it never fires headless, because telling an agent to ask when nobody is there spends the turn
waiting on no one. Like the tool itself, neither of those is a setting — the cooldown is a tunable in
`config.ts`, next to the option cap and the badge text.

| File | Role |
| --- | --- |
| `index.ts` | Tool registration, active-tool sync, the nudge hooks, `/ask-user [status\|test]` |
| `tool.ts` | The `ask_user` tool: normalize questions/options, run the prompt, graceful headless path |
| `interaction.ts` | The interaction as a pure state machine — selection, free text, notes, review |
| `prompt.ts` | The focused TUI component that stands in for the editor: layout, scrolling, key handling |
| `guidance.ts` | Tool description, prompt snippet, and the guideline bullets appended when active |
| `nudge.ts` | **Whether a prompt opens new work, and what the model is told when it does** (pure) |
| `config.ts` | Tunables — caps, the badge, the nudge cooldown. No settings; nothing here is a switch |
| `ask-user.test.ts` | Normalization, the full flow, rendering, and wiring — including that there is no off switch |
| `nudge.test.ts` | The detector against real prompts, the cooldown, and every path that must stay silent |

Not tracked (see `.gitignore`): `agent/auth.json` (credentials), `agent/sessions/` (transcripts),
`agent/skills/` (symlinks into `~/.agents/skills`, shared with other agents and living elsewhere),
the vendored package trees `agent/npm/` and `agent/git/`, the per-machine artifacts those packages
write (`agent/qoder-machine-id`, `agent/state/`, the model caches), and the extension key files
(`web-search.json`, `agent/openai-server-compaction.json`).

**`agent/settings.json` and `agent/models.json` ARE tracked**, which is what lets a clone reproduce
this setup. That makes them public files in a public repo:

> **Never put a credential in `agent/settings.json` or `agent/models.json`.** Both are committed.
> pi's own schema invites it — `models.json` accepts a per-provider `apiKey` and `headers`, and
> settings has `httpProxy`, which can embed `user:pass`. Keys belong in a file that is gitignored
> *and* listed in `permissions.deny`, so neither git nor the agent itself can read it;
> `web-search.json` is the worked example. Turning on `enableAnalytics` also makes pi write a
> persistent `trackingId` UUID into settings.json — leave it off, or accept publishing it.

`agent/settings.example.json` is the annotated reference, kept in step with the real file. It is
**not** something to copy over `agent/settings.json` on a clone — see the install section.

**Composing prompts in nvim.** pi already ships this — press **Ctrl+X** in the prompt and it hands
the current text to an external editor in a temp `prompt.md`, suspends its own TUI while the editor
owns the terminal, and reads the file back when the editor exits. It picks the editor from
`externalEditor` in settings.json, falling back to `$VISUAL`, then `$EDITOR`, then `nano`. The
template sets it to `nvim` explicitly rather than leaning on `$EDITOR`, which on this machine points
at plain `vim` — and changing `$EDITOR` to suit pi would change it for git, crontab and everything
else too. Keep it as strict JSON: pi parses settings with `JSON.parse`, so a `//` comment silently
breaks the whole file.

## Isolating concurrent writers

`withWorktree(name, callback)` runs every `agent()` inside the callback in its own git worktree.
Isolation is **between scopes**, not between agents — agents in one scope share a directory.

```js
await parallel([
  () => withWorktree('backend',  () => agent('Rewrite the transport in src/rpc/**')),
  () => withWorktree('renderer', () => agent('Rewrite the panes in src/ui/**')),
])
```

Three properties, each of which is a deliberate difference from the implementation this was modelled
against:

- **The scope starts from your uncommitted tree**, not `HEAD`, so agents see work in progress. Built
  with a throwaway `GIT_INDEX_FILE`, so `git add -A` inside it never stages anything of yours — you
  can run a workflow on a dirty tree without it rearranging your index.
- **The branch is retained and nothing is merged automatically.** The run result names the branch,
  the diffstat, and the commands: `git diff <base>..<branch>` to review, `git merge --no-ff <branch>`
  to apply. Your working tree is untouched until you run that.
- **A scope that changed nothing is removed**, branch included. There is provably nothing to lose,
  and a list of empty scopes is a list you stop reading.

The comparison that produced this is worth recording. `QuintinShaw/pi-dynamic-workflows` offers a
per-agent `isolation: 'worktree'` flag and then tears the worktree down in an unconditional
`finally` — `worktree remove --force` followed by `branch -D`, on the success path too; their own
test asserts the branch is gone. An isolated agent's work is destroyed the moment it returns, and
only the text of its final message survives. That is worse than having no isolation, because it
looks like it worked. `vekexasia/pi-extensible-workflows` gets the scope model right but, like
QuintinShaw, has **no merge-back path at all** — both leave you to discover a branch.

Don't reach for it by default: it costs a worktree per scope and the merge is yours to do. Stating
file ownership in each agent's prompt is cheaper and enough whenever agents genuinely own different
files. Use a scope when they cannot — two implementations of one module, a risky refactor you want
to diff before keeping, agents that each need to build in place.

Worktrees live under `agent/workflow-runs/<runId>/worktrees/`, which is gitignored. Scope branches
are `pi/wf/<runId>/<slug>-<digest>`; the digest is of the full scope name, because truncating a slug
alone lets two long names collide on one directory — a bug this repo's own test caught during
implementation.

**Lifecycle.** A worktree is registered in the *project's* git, not here, so retention deleting a run
directory would leave an entry git calls `prunable` — and, verified against a real repo, git then
refuses to reuse that path at all (`worktree add` fails with "missing but already registered").
`pruneRuns` therefore runs `git worktree prune` in the affected project after removing the directory.
The scope **branches are never touched** by any of that: pruning a run's bookkeeping is not a
decision to throw away work it committed.

Which means scope branches accumulate until you deal with them. They are recorded in `run.json`
(`worktrees[]`, with the branch, base commit and file count) and written the moment a scope settles
rather than at run end, so a crash cannot leave committed work with nothing pointing at it.
`git branch --list 'pi/wf/*'` finds the lot.

## Watching an agent work

Open `/workflows` (or **shift+↓**), pick a run with **→**, pick an agent, and the detail view tails
that agent's live pi session:

```
status   ● running
model    openai-codex/gpt-5.6-sol
elapsed  4m 12s (running)
tokens   82.1k in / 6.3k out · 31 turn(s)
session  …/workflow-runs/wf-…/agents/2026-…_wf-…-a2.jsonl
─ live ─
  think    the transport needs the framing fixed before the tests will pass
  read     src/rpc/transport.ts
  edit     src/rpc/transport.ts
  bash     pnpm test
  text     Framing fixed; two tests still fail on the cursor case
```

Everything above the rule is what the orchestrator knows — status, turns, spend. That says an agent
is busy and never what it is busy *with*, so a wedged run and a grinding one look identical. The
lines below come from the agent's own transcript as it is written.

Two things had to change for this to work at all. The session path used to be resolved only when
the child **exited**, so a running agent showed `session none` — the panel had no file to tail for
exactly the window you care about. It is now resolved on the first streamed turn instead. And the
tail is parsed from the end of the file with a size-keyed cache, because these transcripts reach
megabytes and the panel re-renders on every turn; re-reading whole files would make the cost of
watching grow with how long you had been watching.

Tool *results* are deliberately not shown — that is the build output the agent is reading, not
something it did, and it would drown the view. A half-written final line is skipped rather than
thrown on, which is the normal state of a file a child process is appending to.

## Run shape

`run.json` records two numbers beyond the totals, and the workflow result reports them back to the
model that wrote the script:

- **`peakConcurrency`** — the most agents ever in flight at once.
- **`deepestAgentTurns`** — the turn count of the single deepest agent.

They exist because they are what separates a fleet from a queue, and a split task from one agent
grinding, and neither was recoverable from `run.json` before — only by hand-parsing timestamps out
of `journal.jsonl`. That is precisely why a 53-minute run that was **one agent deep against a
10-slot scheduler** went unnoticed: every other field looked like a healthy run.

Two diagnostics ride on them, and only fire when earned:

```
Every one of the 4 agents ran alone: peak concurrency was 1, so this was a queue, not a fleet.
One agent used 90 turns. Past ~40 that is a decomposition failure showing up as wall-clock.
```

The model sees these in its own result, which is the only feedback channel that reaches it without
someone noticing first and saying so.

## Gating a workflow on facts

`shell(command, opts?)` runs a command in the **host** process and returns
`{exitCode, stdout, stderr, truncated, timedOut}`. It is the only value in a workflow script an
agent cannot author.

That matters because the alternative does not work. A run here told its agent "Run pnpm check", got
25 invocations of `pnpm check && pnpm test`, a report of *"17/17 passing"*, and an application that
did not start; the adversarial reviewer that followed ran zero commands touching the real thing.
Both agents were honest — the acceptance criterion was one they could satisfy by writing it. Asking
a model to pick a better criterion is still asking the model for the verdict.

```js
phase('Verify')
const tests = await shell('pnpm check && pnpm test')
if (tests.exitCode !== 0) await agent('Build is red, fix it:\n' + tests.stderr.slice(-4000))
```

Three properties worth knowing:

- **Agents cannot call it.** They have bash inside their own pi process, but its output reaches the
  script only as something they chose to type. `shell()` exists solely in the orchestration sandbox.
- **It grants no new power.** A subagent already runs arbitrary commands. This relocates existing
  reach to where the *result* is trustworthy. It is bound only when the project is trusted, and
  throws with a reason otherwise — a gate that silently stops gating is worse than none.
- **Write `exitCode === 0`, never `!== 0`.** A signal-killed process reports `null`.
- **It runs in the enclosing scope.** Inside a `withWorktree()` callback the gate measures the
  scope's tree, not the project's — otherwise it would certify code the agents never touched.

Calls are journaled for the audit trail but deliberately **not replayed** on resume, unlike agents.
A verdict describes the tree at a moment, and a resume is exactly the case where that moment has
passed: a cached green exit would certify code that has since changed, and a cached `exitCode: null`
from a killed call would wedge the gate so no resume could ever get past it. Re-running is the
cheaper mistake — which is also why mutations do not belong in `shell()`.

Output is capped per stream at 200KB, with `truncated` set whenever anything was dropped, including
when the overflowing chunk is the last one.
There is no default timeout, matching every other wall-clock decision here; pass `timeoutMs` when a
specific gate can hang.

## `agent/models.json`

Tracked, alongside `settings.json`. pi reads it from `getAgentDir()/models.json` and its schema
(`core/model-config.js`) allows per-provider `baseUrl`, `apiKey`, `headers`, extra `models`, and
`modelOverrides`.

Today it carries only `contextWindow: 272000` for the three `openai-codex` models. **Those values
match what pi already reports**, so the file currently changes nothing — it is a pin, not a
correction.

That is worth knowing because `modelOverrides` is applied as the topmost layer in
`composeModelProvider`, *after* `refreshModels`. So if OpenAI raises the real window, pi will keep
reporting 272k and keep compacting early, and nothing will point at a three-line file that appeared
to do nothing when it was added. Delete the entry rather than editing it if you want pi's own number
back.

**No credential goes in here.** The schema accepts `apiKey` and `headers` per provider, and this file
is committed to a public repo. Keys belong in a gitignored file that is also listed in
`permissions.deny` — see `web-search.json`.

## Installed packages

Five third-party packages are pinned in `settings.packages`. `pi install` vendors them into
`agent/npm/` and `agent/git/`, both gitignored — the pins are the record, not the trees.

| Package | What it does | Configured by |
| --- | --- | --- |
| `pi-provider-qoder` | The Qoder provider. Pinned to a fork carrying four fixes upstream hasn't merged: dropped tool-result images, tool calls silently discarded when arguments arrive empty, plus the two known `finish_reason`/`usage` bugs. | `models.providers.qoder` |
| `pi-openai-server-compaction` | Codex-style **server-side** compaction for OpenAI models: sends `compaction_trigger` through `POST /v1/responses` and gets an encrypted `compaction` item back, instead of a text summary. | `agent/openai-server-compaction.json` — **not** `settings.compaction` |
| `pi-web-access` | Web search, URL fetch, repo clone, PDF and video extraction. Replaced the removed `web-search`/`web-fetch` extensions. | `web-search.json` (gitignored, and in `permissions.deny`) |
| `@ryan_nookpi/pi-extension-codex-fast-mode` | `/codex-fast` toggle. | `agent/state/codex-fast-mode.json` (gitignored) |
| `@ff-labs/pi-fff` | **Replaces the built-in `find` and `grep`** with FFF, a Rust-native indexed searcher: fuzzy matching, frecency ranking, git-aware, no `fd`/`rg` subprocess per call. Also backs `@` file autocomplete. | `PI_FFF_MODE` env var / `--fff-mode` flag |

**The `compact-tools` extension was removed for this.** It re-registered `read`, `bash`, `grep`,
`find` and `ls` to give each a one-line collapsed row, and pi-fff in `override` mode re-registers
`find` and `grep` for real. Two extensions claiming the same tool name is decided by load order, and
it resolves the opposite way to the obvious guess: `getAllRegisteredTools` keeps the **first**
registration for a name (`if (!toolsByName.has(name))`), and installed packages load **last**, after
`agent/extensions/`. So **compact-tools would have won, and pi-fff's `find`/`grep` would have been
the thing silently ignored** — the collision would have quietly defeated the package that was
installed for exactly those two tools. Deleting the local extension is what actually hands the names
to FFF, not merely a tidy-up. The cost is that `read`, `bash` and `ls` go back to pi's default
multi-line collapsed rendering.

**`override` mode is set via `PI_FFF_MODE=override` in `~/.zshrc`**, not here. pi has no settings
key for extension flags — the mode comes from `--fff-mode`, the env var, or `/fff-mode override`,
and the last of those only persists for one session (it is stored as a session entry). With the
`env` extension gone there is no `.env` to put it in either, so the shell profile is the only
durable place left.

**All five are pinned to an exact version or commit.** The lockfile that would otherwise record what
landed lives in `agent/npm/`, which is gitignored, so anything left floating lets a clone silently
get a different build — `pi-web-access` and `codex-fast-mode` used to float for exactly that reason
and no longer do. Bump the pins deliberately; nothing else in the repo records what you were running.

**Compaction moved out of tracked config.** The local `compaction` extension was removed because
`pi-openai-server-compaction` registers the same `session_before_compact` hook and one would silently
win. The surviving `"compaction"` block in settings.json now configures only pi's *built-in* fallback
path; the replacement reads none of it. Its knobs — `enabled`, `thresholdRatio` (0.7),
`compactThreshold`, `usePreviousResponseId`, `notify` — come from `~/.pi/agent/openai-server-compaction.json`,
which this repo does not create. Create it to retune, and note it is gitignored and deny-listed
because the same file can carry an API key.

**Known gap:** `/usage` no longer shows a compaction row. The old extension called pi's exported
`compact()`, so pi recorded the spend on the session entry where `usage/collect.ts` finds it. The
replacement pays for its own calls and reports usage nested under `details`, and emits nothing on the
`usage:spend` channel, so that spend is invisible to the report. Total understates real cost by
whatever compaction consumed.

## Install on a new machine

```sh
# 1. Clone this config into place (it IS ~/.pi, with agent/ inside)
git clone git@github.com:OysterD3/dotpi.git ~/.pi     # or https://github.com/OysterD3/dotpi.git

# 2. Nothing to copy: agent/settings.json is tracked and arrives with the clone,
#    package pins and all. Do NOT cp settings.example.json over it — that would
#    wipe the `packages` array and revert permissions.defaultMode.

# 3. Authenticate this machine (auth.json is gitignored — each machine logs in itself)
pi          # then /login; pi installs everything in `packages` on first start
```

If `~/.pi` already exists (pi created it), move it aside first — `mv ~/.pi ~/.pi.bak` — then clone and
copy your machine-local `agent/auth.json` back in.

Machine-local drift in `agent/settings.json` (thinking level, active model) shows up as a diff and can
conflict on `git pull`. `git update-index --skip-worktree agent/settings.json` silences it on that
machine without untracking the file.

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
- **Tool output is collapsed** — the noisier tools show the first
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
