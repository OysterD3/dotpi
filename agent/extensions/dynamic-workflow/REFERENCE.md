# Workflow authoring reference

Read this before you write your first workflow script in a session. The `workflow` tool's own
description covers only when to call the tool and the shape of a script; everything needed to write
one well is here.

## One script or two

Multi-phase work (understand → design → implement → review) is ONE script with a phase() call per stage, not one workflow per phase. Sequencing is what await does, and a result is a variable the next phase's prompt interpolates — so a stage that merely has to wait for the one before it is a stage of the same run. The test for splitting is whether you can author the next phase's prompts NOW, with earlier results pasted in: if you can, it belongs in this script; if the plan itself has to be reshaped by reading the result first, that is a second workflow. What replaces the turn boundary is a gate, not oversight: shell() makes the script correct itself on a fact no agent authored, and the result message brings the finished run back to you. Mid-run you see nothing — so where no gate is available (shell() throws in an untrusted project) a split buys a real checkpoint and can be the right call.

## The script

Every script must begin with `export const meta = {...}` — a PURE object literal (no variables, calls, or interpolation) with required string fields `name` and `description`, and optionally `phases: [{ title, detail? }]` and `deterministic: false` (see Determinism below).

`phases` is the PLAN, and the panel draws it: every phase listed is on the board from the moment the run starts, dimmed until the run reaches it, so a watcher sees where the work is going and not only where it has got to. So list EVERY phase the script goes through, in the order it will reach them, one entry per phase() call and titles matching exactly — including the last one, which for most fan-outs is the stage that reads what came back (`Synthesize`). Declaring one phase for a script with three is not a smaller plan; it is an unstated one, and the panel can only show what the script said.

Script body hooks (plain JavaScript, NOT TypeScript; the body runs in an async context — use await and top-level return):
- agent(prompt, opts?): Promise<any> — spawn a subagent; returns its final text. On failure agent() returns null (filter with .filter(Boolean)). opts:
  - label, phase — how the agent appears in progress output. Neither affects the result, so relabelling never invalidates a resume.
  - model — a REFERENCE resolved like pi's --model: "provider/id", a bare id, or a distinctive partial name ("sonnet", "fable", "haiku"). An ambiguous or unknown reference fails that agent with a clear error, so prefer distinctive names. A full "provider/id" works even when pi does not list that id, if pi knows the provider (as with pi --model).
  - thinking — "low" | "medium" | "high" | "xhigh" | "max".
  - schema — a JSON Schema object. The subagent is told to reply with ONLY matching JSON and agent() returns the parsed value, retrying once on unusable output.
  - agentType — the name of a standing subagent (see Agent types below). It supplies the tools, role prompt, model and thinking level; anything you also pass explicitly wins.
  - tools — an explicit tool allowlist, e.g. ["read","grep","find","ls"] for a read-only agent.
  - context — what to fork into the agent (see Forking context below).
  - session — a name, scoped to this run. Agents sharing a name continue ONE conversation in turn (see Shared sessions below).
- parallel(thunks): Promise<any[]> — run tasks concurrently. This is a BARRIER: awaits all thunks. A thunk that throws resolves to null — the call itself never rejects.
- shell(command, opts?): Promise<{exitCode, stdout, stderr, truncated, timedOut}> — run a command on the HOST and read its real exit code. See **Gating on facts** below; this is the only value in a script an agent cannot author. opts: {timeoutMs?, env?}. Runs in the enclosing withWorktree() scope when there is one. NOT replayed on resume — a gate has to describe the tree as it is now. Unavailable (throws) when the project is not trusted.
- withWorktree(name, callback): Promise<any> — run the callback with every agent() inside it writing in its own git worktree. See **Isolating concurrent writers**. Throws when the project is not a trusted git repository.
- pipeline(items, stage1, stage2, ...): Promise<any[]> — run each item through all stages independently, NO barrier between stages. Every stage callback receives (prevResult, originalItem, index). A stage that throws drops that item to null and skips its remaining stages.
- phase(title): void — enter a phase: subsequent agents are grouped under this title, and the phase is marked reached on the board. Titles must match meta.phases exactly; a title not declared there is appended to the plan as it happens.
- log(message): void — emit a progress line.
- args: any — the value passed as this tool's `args` input, verbatim.
- budget: {total: null, spent(), remaining()} — compatibility stub; total is always null and remaining() Infinity, so budget-guarded loops written for other harnesses fall through cleanly.

## Forking context

Each agent is a fresh pi run, so by default it knows only its prompt. Rather than pasting everything into the prompt string, ask for what it needs:
  agent('Which of these are real bugs?', { context: { parent: 6, files: ['src/parser.ts'], text: findingsSoFar } })
- `parent`: how many recent turns of THIS conversation to carry, or "all". Use it when the agent needs to know what the user actually asked for.
- `files`: paths (project-relative or absolute) to embed. The agent can also read files itself; embed only what it definitely needs, or what it would struggle to find.
- `text`: literal background, e.g. results from an earlier stage.
Nothing here is truncated: every file is embedded whole and every requested turn is included. Seeding a 2MB bundle opens the child past its context window and it fails on the first request, so ask for what the agent needs rather than everything available. It arrives as the agent's opening exchange, so the task prompt itself should still say what to DO.

## Shared sessions

By default each agent is a fresh pi run that forgets everything when it exits, so a three-stage pipeline re-derives the same understanding three times. `session: "<name>"` makes several agents continue ONE conversation: the second sees what the first actually did — its tool calls, its dead ends — not a summary you had to write. Use it for stages that build on each other over the same subject (inspect → change → verify one file), not as a way to share context generally.

Three rules, all enforced:
- SEQUENTIAL. Await one agent before starting the next with the same name. Two at once fails the run, because one conversation cannot have two authors. Inside pipeline(), give each item its own name — session: `file-${index}` — so items stay independent while their stages chain.
- NEVER REPLAYED. A resume re-runs shared-session agents rather than serving stored results, since a replayed agent leaves no conversation for the next one to continue. Long chains are therefore expensive to resume.
- SEEDED ONCE. Only the first agent in a chain can take `context`; later ones already have the conversation, and their `context` is ignored with a log line.

## Agent types

Reach for a standing subagent instead of describing a role inline: `agent(prompt, { agentType: 'code-explorer' })`. The names are the defined subagents (~/.pi/agent/agents/<name>.md, plus a trusted project's .pi/agents/). An unknown name fails that agent and lists the known names.

## Resume

A run that failed, was cancelled, or died with its session keeps its journal. Pass `resumeFromRunId: "<id>"` (with no `script`, to reuse the stored one, or with an edited script) and every agent whose prompt and options are unchanged returns its stored result instantly — only new, edited, and previously FAILED agents actually run. Prefer this to re-running a large workflow from the top. Matching is by content, not call order, so reordering a script is free.

## Determinism

Date.now(), argless new Date(), and Math.random() throw inside a script: they would make a replay diverge. Pass timestamps in through `args`, and vary agents by index rather than randomly. A script that genuinely needs them can set `deterministic: false` in meta, which makes that run unresumable.

## Saved workflows

`name: "<name>"` runs ~/.pi/agent/workflows/<name>.js, and `scriptPath` runs any file on disk. Exactly one of script, name, scriptPath, or resumeFromRunId is required.

## Almost nothing is capped

No agent limit per run, no item limit on parallel()/pipeline(), and no wall-clock ceiling on an agent — an agent runs until it finishes or the user aborts. There is ONE bound: a process-wide ceiling of 32 concurrent subagents shared by every run at once, which exists because several workflows can run simultaneously and N runs times M agents is a lot of processes. A single fan-out of thirty starts together and is unaffected; past the ceiling agents queue, dispatched round-robin across runs so one big sweep cannot starve a small workflow behind it. So breadth stays free to ask for and yours to get right: fan out along real seams. Nested workflow() throws. The script body runs on the host event loop: always await — a synchronous busy-wait loop freezes the whole session.

DEFAULT TO pipeline(). A barrier (parallel between stages) is correct ONLY when stage N needs cross-item context from all of stage N-1 — dedup/merge across the full result set, early-exit on a zero count, or a prompt that references "the other findings". "The stages are conceptually separate" is not a reason; barrier latency is real.

phase() is a LABEL, not a barrier. It groups rows in the progress panel and orders nothing; what orders work is what you await. A phase boundary is therefore free, and awaiting a result you do not need costs the whole difference between the two — so never split work to keep a phase tidy, and never join it because the panel would look neater.

The shape most work has is neither one barrier nor N independent chains: it is a JOIN. Start the agents that do not depend on each other, HOLD their promises, and await only where a result is genuinely an input.

```js
const api = agent('...', { label: 'api', phase: 'Build' })
const store = agent('...', { label: 'store', phase: 'Build' })
const docs = agent('...', { label: 'docs', phase: 'Build' })
const wired = await Promise.all([api, store]).then(([a, s]) =>
  agent('Wire these together: ' + a + '\n' + s, { phase: 'Wire' }))
return { wired, docs: await docs }
```

docs never waits for api or store, and the wiring agent starts when its two inputs land rather than when the slowest agent of the round does. An unawaited agent() promise is safe — every one carries an observer, so its rejection cannot take the session down — but await it somewhere before the script returns: when the run settles, agents still in flight are aborted.

The canonical multi-stage pattern — each dimension verifies as soon as its review completes:

```js
export const meta = { name: 'review', description: 'review then verify', phases: [{ title: 'Review' }, { title: 'Verify' }] }
const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, { label: 'review:' + d.key, phase: 'Review', schema: FINDINGS_SCHEMA }),
  review => parallel((review?.findings ?? []).map(f => () =>
    agent('Adversarially verify: ' + f.title, { phase: 'Verify', schema: VERDICT_SCHEMA }).then(v => ({ ...f, verdict: v }))))
)
return results.flat().filter(Boolean).filter(f => f.verdict?.isReal)
```

## Implementing is fan-out too

Every pattern here reads, judges or verifies, and that is an accident of which patterns got written down — not a claim that building is inherently serial. A request carrying several deliverables (a transport, a session store, an IPC surface, a fixture and its tests) is ONE AGENT PER DELIVERABLE, not one agent handed the list. Split by what each agent OWNS: the files it alone will write. Agents owning disjoint files run concurrently as they are. For agents that WOULD collide, see **Isolating concurrent writers** below — there is no per-agent `isolation` option, and an unknown option is silently ignored rather than rejected, so passing one buys nothing.

```js
export const meta = {
  name: 'ship-the-scheduler',
  description: 'build it, gate on the real suite, fix what the gate finds, audit',
  phases: [{ title: 'Implement' }, { title: 'Gate' }, { title: 'Fix' }, { title: 'Audit' }],
}
const PARTS = [
  { key: 'router',    owns: 'src/router/**',     prompt: '...' },
  { key: 'api',       owns: 'src/api/**',        prompt: '...' },
  { key: 'tasks',     owns: 'src/tasks/**',      prompt: '...' },
  { key: 'cron',      owns: 'src/cron/**',       prompt: '...' },
  { key: 'workspace', owns: 'src/workspace/**',  prompt: '...' },
  { key: 'worktools', owns: 'src/worktools/**',  prompt: '...' },
  { key: 'store',     owns: 'src/store/**',      prompt: '...' },
  { key: 'migrate',   owns: 'src/migrations/**', prompt: '...' },
  { key: 'main',      owns: 'src/main.ts',       prompt: '...' },
  { key: 'e2e',       owns: 'test/e2e/**',       prompt: '...' },
]
phase('Implement')
await parallel(PARTS.map(p => () =>
  agent(p.prompt + '\n\nYou own ' + p.owns + '. Do not edit anything outside it — another agent owns those files and your edit would be lost.',
    { label: 'impl:' + p.key, phase: 'Implement' })))
phase('Gate')
const gate = await shell('pnpm build && pnpm test')
phase('Fix')
if (gate.exitCode !== 0) {
  await agent('The build is red. Fix it and resolve the seams between the parts. Failures:\n' + gate.stderr.slice(-4000), { phase: 'Fix' })
}
phase('Audit')
const audit = await parallel(PARTS.map(p => () =>
  agent('Review ' + p.owns + ' against what it was asked to build. Return findings only.',
    { label: 'audit:' + p.key, phase: 'Audit', tools: ['read', 'grep', 'find', 'ls'], schema: FINDINGS_SCHEMA })))
return { green: gate.exitCode === 0, findings: audit.filter(Boolean).flatMap(a => a.findings) }
```

Its three barriers are forced by one fact, and it is worth naming: the gate is a SINGLE GLOBAL command, so it cannot run until every part is written, and everything after it inherits that. Where a gate is per-item — one module's tests, one endpoint's smoke check — that item's gate and fix belong in a pipeline() chain of its own, and item 7 never waits on item 3. Copy the barriers only with the reason.

Stating the ownership IN THE PROMPT is what keeps concurrent agents in one repo from overwriting each other, and it costs nothing next to a worktree per agent. Resolving the seams between the parts is one agent's job — that is Fix, and what tells it which seams are actually broken is the gate, not a guess written before anything ran. Ten deliverables is what ten agents looks like: the panel reads "Implement · 10 agents", and the count came from the request rather than from a default.

Three smells that all mean the same thing. A prompt containing a bulleted list of requirements: that list IS the fan-out, so split it before you run it. A single agent past ~40 turns: that is a decomposition failure showing up as wall-clock, not diligence. And a split into backend / frontend / cli — or any other tier an org chart would recognise: that taxonomy existed before the request did, so it cannot be a description of THIS task's seams. Name the files each agent alone writes; when two of them both own src/, the split is a label and not a decomposition. Not one of the three is fixed by giving an agent more thinking.

## Gating on facts, not on claims

An implement agent satisfies exactly the check you write into its prompt, so a weak check buys code that passes it and nothing else. But the deeper problem is who produces the verdict: if the agent reports whether it succeeded, the verdict is prose, and prose is free to be wrong.

This is measured, not hypothetical. A run here told its agent "Run pnpm check", got 25 invocations of `pnpm check && pnpm test`, a report of "17/17 passing", and an application that did not start. The adversarial reviewer that followed ran zero commands touching the real thing. Both agents were honest; the acceptance criterion was one they could satisfy by writing it.

So do NOT ask an agent whether the work is good. Run the gate yourself: that is the Gate phase in the script above, and it is a shell() call rather than an agent, with Fix running on what it returned.

shell() runs in the host process, and agents cannot call it — they have their own bash inside their own pi, but its output reaches you only as something they chose to type. Only shell() gives you a number the model never touched. Write gates as `exitCode === 0`, never `!== 0`: a signal-killed process reports null.

Prefer a gate that exercises the real artifact — start the binary and see it answer, drive the endpoint, run the PRE-EXISTING suite and not only the new one. Tests the same agent wrote against a fixture it also wrote are a closed loop, and it closes green whatever the code does. Where no such check exists yet, building one is the first agent's job, and it is worth its own agent running in parallel with the parts it will check.

Still say what each agent owns in its prompt. The gate tells you whether the work is good; ownership is what keeps concurrent writers from destroying each other's work.

## Isolating concurrent writers

`withWorktree(name, cb)` gives every agent inside the callback its own git worktree. Isolation is BETWEEN scopes, not between agents: agents in one scope share a directory, so put things that must not collide in different scopes.

```js
await parallel([
  () => withWorktree('transport', () => agent('Rewrite the transport in src/rpc/**')),
  () => withWorktree('panes', () => agent('Rewrite the panes in src/ui/**')),
])
```

Three things to know. The scope starts from your UNCOMMITTED tree, not HEAD, so agents see the work in progress. The work is COMMITTED to a retained branch and never merged automatically — the result names the branch and the command to apply it, and until you run that your working tree is untouched. A scope that changed nothing is removed.

Do not reach for it by default. It costs a worktree per scope and the merge is yours to do; stating file ownership in each agent's prompt is cheaper and enough whenever the agents genuinely own different files. Use a scope when they cannot: two implementations of the same module, a risky refactor you want to diff before keeping, or agents that must each run the build in place.

Quality patterns, for when the request justifies the extra agents:
- Adversarial verify: N independent skeptics per finding, each prompted to REFUTE; kill if a majority refute. Prevents plausible-but-wrong findings from surviving. One verifier is the default; go to three only for claims that are expensive to be wrong about.
- Perspective-diverse verify: give each verifier a distinct lens (correctness, security, perf, does-it-reproduce) instead of N identical refuters.
- Judge panel: N independent attempts from different angles, parallel judges score, synthesize from the winner.
- Loop-until-dry: for unknown-size discovery, keep spawning finders until K consecutive rounds return nothing new; dedup against everything seen in plain code, not an agent. Vary each round by index, never randomly. Bound the loop — it is the easiest way to spend an unlimited amount.
- Multi-modal sweep: parallel agents each searching a different way (by-container, by-content, by-entity, by-time); useful when one search angle won't find everything.
- No silent caps: if the script bounds coverage (top-N, sampling), log() what was dropped.

Subagents are told their final text is machine-consumed — prompt them to return raw data, not prose for humans.

## Model routing

When the triggering request assigns models to roles ("ultracode, use sonnet for implementation and fable to review"), pass each matching agent that reference via opts.model and leave opts.model off for roles the request does not mention, which then use the session's default subagent model. The instruction holds for later workflows until the user changes it. Pass the name the user used rather than guessing at a canonical id: an ambiguous or unavailable reference fails that agent with the reason instead of quietly running on something else.
