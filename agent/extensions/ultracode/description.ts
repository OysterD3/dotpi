/**
 * The workflow tool's LLM-facing description, covering exactly the features
 * implemented here (no worktree isolation, no nested workflow(), no budget
 * directive) and the Ultracode section the reminder texts reference.
 *
 * On its size: this sits in the cached request prefix, so its ~2.7k tokens cost
 * cacheRead rates — a few cents across a long session, against runs that cost
 * tens of dollars. It is therefore written for behaviour, not brevity. What was
 * removed was the material that pushed the model to expand (an instruction to
 * workflow every substantive task, "token cost is not a constraint", a
 * completeness critic whose whole job is generating another round); what was
 * added is Bounding an agent, because measured runs spend on agent DEPTH, not
 * fleet width. Trimming words here would have saved nothing worth having.
 */

export const WORKFLOW_DESCRIPTION = `Execute a workflow script that orchestrates multiple subagents deterministically. Each agent is a fresh headless pi run in this project directory with the standard tools (read, bash, edit, write); agents cannot spawn further workflows.

Workflows run in the BACKGROUND: this call validates the script, starts the fleet, and returns immediately with a run id. A "workflow-result" message arrives when the run completes — NEVER fabricate or predict a pending run's results; continue with other work or end the turn and wait. The user watches progress in the status panel and can inspect, pause, resume or cancel runs from /workflows. Pass wait: true only when the result is needed before you can do anything else.

Runs are durable: every agent, log line and result is written to ~/.pi/agent/workflow-runs/<runId>/ as it happens, and each subagent keeps its own pi session there, so a failed run can be resumed (see Resume) and its transcripts survive for inspection.

ONLY call this tool when the user has explicitly opted into multi-agent orchestration. A workflow is expensive — the user must request that scale, not have it inferred. Explicit opt-in means one of:
- The user included the keyword "ultracode" in their prompt (you'll see a system-reminder confirming it).
- Ultracode is on for the session (a system-reminder confirms it) — see **Ultracode** below.
- The user directly asked for a workflow or multi-agent orchestration in their own words ("use a workflow", "fan out agents").

For any other task — even one that would clearly benefit from parallelism — do NOT call this tool; briefly describe what a workflow could do and ask.

**Ultracode.** When a system-reminder says ultracode is on, the opt-in is standing: you may run a workflow without asking first. That is permission, not an instruction to run one for every task. Reach for a fleet when the task's shape needs it — coverage wider than one context holds, independent verification of a claim you cannot check yourself, or a mechanical sweep over many files — and work inline when it does not. A task that is merely large or important is not automatically one of those. Scale to the request: most work is served by three to five agents, and a bigger pool needs a reason stated in the request rather than enthusiasm. For multi-phase work (understand → design → implement → review) run several workflows in sequence, one per phase, so you stay in the loop between them. When a reminder says ultracode is off, revert to the opt-in rule above.

**Bounding an agent.** Spend is driven far more by how long each agent runs than by how many you start — a four-agent run routinely costs more than a twenty-agent one, because each agent keeps working until it decides it is finished. There is no turn limit; the prompt is the only budget an agent has. So give each one a single deliverable and a visible finish line ("return the three files that define routing" rather than "investigate routing"), prefer several bounded agents to one open-ended one, name the files or directories to start from when you already know them, and pass tools: ["read","grep","find","ls"] to any agent that only needs to look — an agent that cannot edit cannot wander off into fixing things.

Every script must begin with \`export const meta = {...}\` — a PURE object literal (no variables, calls, or interpolation) with required string fields \`name\` and \`description\`, and optionally \`phases: [{ title, detail? }]\` and \`deterministic: false\` (see Determinism below).

Script body hooks (plain JavaScript, NOT TypeScript; the body runs in an async context — use await and top-level return):
- agent(prompt, opts?): Promise<any> — spawn a subagent; returns its final text. On failure agent() returns null (filter with .filter(Boolean)). opts:
  - label, phase — how the agent appears in progress output. Neither affects the result, so relabelling never invalidates a resume.
  - model — a REFERENCE resolved like pi's --model: "provider/id", a bare id, or a distinctive partial name ("sonnet", "fable", "haiku"). An ambiguous or unknown reference fails that agent with a clear error, so prefer distinctive names.
  - thinking — "low" | "medium" | "high" | "xhigh" | "max".
  - schema — a JSON Schema object. The subagent is told to reply with ONLY matching JSON and agent() returns the parsed value, retrying once on unusable output.
  - agentType — the name of a standing subagent (see Agent types below). It supplies the tools, role prompt, model and thinking level; anything you also pass explicitly wins.
  - tools — an explicit tool allowlist, e.g. ["read","grep","find","ls"] for a read-only agent.
  - context — what to fork into the agent (see Forking context below).
  - session — a name, scoped to this run. Agents sharing a name continue ONE conversation in turn (see Shared sessions below).
- parallel(thunks): Promise<any[]> — run tasks concurrently. This is a BARRIER: awaits all thunks. A thunk that throws resolves to null — the call itself never rejects.
- shell(command, opts?): Promise<{exitCode, stdout, stderr, truncated, timedOut}> — run a command on the HOST and read its real exit code. See **Gating on facts** below; this is the only value in a script an agent cannot author. opts: {timeoutMs?, env?}. Replayed on resume like an agent. Unavailable (throws) when the project is not trusted.
- withWorktree(name, callback): Promise<any> — run the callback with every agent() inside it writing in its own git worktree. See **Isolating concurrent writers**. Throws when the project is not a trusted git repository.
- pipeline(items, stage1, stage2, ...): Promise<any[]> — run each item through all stages independently, NO barrier between stages. Every stage callback receives (prevResult, originalItem, index). A stage that throws drops that item to null and skips its remaining stages.
- phase(title): void — group subsequent agents under this title in progress output.
- log(message): void — emit a progress line.
- args: any — the value passed as this tool's \`args\` input, verbatim.
- budget: {total: null, spent(), remaining()} — compatibility stub; total is always null and remaining() Infinity, so budget-guarded loops written for other harnesses fall through cleanly.

**Forking context.** Each agent is a fresh pi run, so by default it knows only its prompt. Rather than pasting everything into the prompt string, ask for what it needs:
  agent('Which of these are real bugs?', { context: { parent: 6, files: ['src/parser.ts'], text: findingsSoFar } })
- \`parent\`: how many recent turns of THIS conversation to carry, or "all". Use it when the agent needs to know what the user actually asked for.
- \`files\`: paths (project-relative or absolute) to embed. The agent can also read files itself; embed only what it definitely needs, or what it would struggle to find.
- \`text\`: literal background, e.g. results from an earlier stage.
Nothing here is truncated: every file is embedded whole and every requested turn is included. Seeding a 2MB bundle opens the child past its context window and it fails on the first request, so ask for what the agent needs rather than everything available. It arrives as the agent's opening exchange, so the task prompt itself should still say what to DO.

**Shared sessions.** By default each agent is a fresh pi run that forgets everything when it exits, so a three-stage pipeline re-derives the same understanding three times. \`session: "<name>"\` makes several agents continue ONE conversation: the second sees what the first actually did — its tool calls, its dead ends — not a summary you had to write. Use it for stages that build on each other over the same subject (inspect → change → verify one file), not as a way to share context generally.

Three rules, all enforced:
- SEQUENTIAL. Await one agent before starting the next with the same name. Two at once fails the run, because one conversation cannot have two authors. Inside pipeline(), give each item its own name — session: \`file-\${index}\` — so items stay independent while their stages chain.
- NEVER REPLAYED. A resume re-runs shared-session agents rather than serving stored results, since a replayed agent leaves no conversation for the next one to continue. Long chains are therefore expensive to resume.
- SEEDED ONCE. Only the first agent in a chain can take \`context\`; later ones already have the conversation, and their \`context\` is ignored with a log line.

**Agent types.** Reach for a standing subagent instead of describing a role inline: \`agent(prompt, { agentType: 'code-explorer' })\`. An unknown name fails that agent and lists the configured names.

**Resume.** A run that failed, was cancelled, or died with its session keeps its journal. Pass \`resumeFromRunId: "<id>"\` (with no \`script\`, to reuse the stored one, or with an edited script) and every agent whose prompt and options are unchanged returns its stored result instantly — only new, edited, and previously FAILED agents actually run. Prefer this to re-running a large workflow from the top. Matching is by content, not call order, so reordering a script is free.

**Determinism.** Date.now(), argless new Date(), and Math.random() throw inside a script: they would make a replay diverge. Pass timestamps in through \`args\`, and vary agents by index rather than randomly. A script that genuinely needs them can set \`deterministic: false\` in meta, which makes that run unresumable.

**Saved workflows.** \`name: "<name>"\` runs ~/.pi/agent/workflows/<name>.js, and \`scriptPath\` runs any file on disk. Exactly one of script, name, scriptPath, or resumeFromRunId is required.

**Almost nothing is capped.** No agent limit per run, no item limit on parallel()/pipeline(), and no wall-clock ceiling on an agent — an agent runs until it finishes or the user aborts. There is ONE bound: a process-wide ceiling of 32 concurrent subagents shared by every run at once, which exists because several workflows can run simultaneously and N runs times M agents is a lot of processes. A single fan-out of thirty starts together and is unaffected; past the ceiling agents queue, dispatched round-robin across runs so one big sweep cannot starve a small workflow behind it. So breadth stays free to ask for and yours to get right: fan out along real seams. Nested workflow() throws. The script body runs on the host event loop: always await — a synchronous busy-wait loop freezes the whole session.

DEFAULT TO pipeline(). A barrier (parallel between stages) is correct ONLY when stage N needs cross-item context from all of stage N-1 — dedup/merge across the full result set, early-exit on a zero count, or a prompt that references "the other findings". "The stages are conceptually separate" is not a reason; barrier latency is real.

The canonical multi-stage pattern — each dimension verifies as soon as its review completes:
  export const meta = { name: 'review', description: 'review then verify', phases: [{ title: 'Review' }, { title: 'Verify' }] }
  const results = await pipeline(
    DIMENSIONS,
    d => agent(d.prompt, { label: 'review:' + d.key, phase: 'Review', schema: FINDINGS_SCHEMA }),
    review => parallel((review?.findings ?? []).map(f => () =>
      agent('Adversarially verify: ' + f.title, { phase: 'Verify', schema: VERDICT_SCHEMA }).then(v => ({ ...f, verdict: v }))))
  )
  return results.flat().filter(Boolean).filter(f => f.verdict?.isReal)

**Implementing is fan-out too.** Every pattern here reads, judges or verifies, and that is an accident of which patterns got written down — not a claim that building is inherently serial. A request carrying several deliverables (a transport, a session store, an IPC surface, a fixture and its tests) is ONE AGENT PER DELIVERABLE, not one agent handed the list. Split by what each agent OWNS: the files it alone will write. Agents owning disjoint files run concurrently as they are. For agents that WOULD collide, see **Isolating concurrent writers** below — there is no per-agent \`isolation\` option, and an unknown option is silently ignored rather than rejected, so passing one buys nothing.

  phase('Implement')
  const PARTS = [
    { key: 'transport', owns: 'src/main/rpc/**', prompt: '...' },
    { key: 'sessions', owns: 'src/main/sessions/**', prompt: '...' },
    { key: 'ipc', owns: 'src/main/ipc/**', prompt: '...' },
  ]
  const built = await parallel(PARTS.map(p => () =>
    agent(p.prompt + '\\n\\nYou own ' + p.owns + '. Do not edit anything outside it — another agent owns those files and your edit would be lost.',
      { label: p.key, phase: 'Implement' })))
  phase('Integrate')
  await agent('Wire the parts together and make the build and tests pass. ' + built.filter(Boolean).join('\\n'), { phase: 'Integrate' })

Stating the ownership IN THE PROMPT is what keeps concurrent agents in one repo from overwriting each other, and it costs nothing next to a worktree per agent. A short integrate stage afterwards is normal and expected: that is where the seams get resolved, and it is one agent because it is genuinely one job.

Two smells that both mean the same thing. A prompt containing a bulleted list of requirements: that list IS the fan-out, so split it before you run it. And a single agent past ~40 turns: that is a decomposition failure showing up as wall-clock, not diligence. Neither is fixed by giving the one agent more thinking.

**Gating on facts, not on claims.** An implement agent satisfies exactly the check you write into its prompt, so a weak check buys code that passes it and nothing else. But the deeper problem is who produces the verdict: if the agent reports whether it succeeded, the verdict is prose, and prose is free to be wrong.

This is measured, not hypothetical. A run here told its agent "Run pnpm check", got 25 invocations of \`pnpm check && pnpm test\`, a report of "17/17 passing", and an application that did not start. The adversarial reviewer that followed ran zero commands touching the real thing. Both agents were honest; the acceptance criterion was one they could satisfy by writing it.

So do NOT ask an agent whether the work is good. Run the gate yourself:

  phase('Implement')
  await parallel(PARTS.map(p => () => agent(p.prompt, { label: p.key, phase: 'Implement' })))
  phase('Verify')
  const tests = await shell('pnpm check && pnpm test')
  if (tests.exitCode !== 0) {
    await agent('The build is red. Fix it. Failures:\\n' + tests.stderr.slice(-4000), { phase: 'Verify' })
  }
  return { green: tests.exitCode === 0, output: tests.stdout.slice(-2000) }

shell() runs in the host process, and agents cannot call it — they have their own bash inside their own pi, but its output reaches you only as something they chose to type. Only shell() gives you a number the model never touched. Write gates as \`exitCode === 0\`, never \`!== 0\`: a signal-killed process reports null.

Prefer a gate that exercises the real artifact — start the binary and see it answer, drive the endpoint, run the PRE-EXISTING suite and not only the new one. Tests the same agent wrote against a fixture it also wrote are a closed loop, and it closes green whatever the code does. Where no such check exists yet, building one is the first agent's job, and it is worth its own agent running in parallel with the parts it will check.

Still say what each agent owns in its prompt. The gate tells you whether the work is good; ownership is what keeps concurrent writers from destroying each other's work.

**Isolating concurrent writers.** \`withWorktree(name, cb)\` gives every agent inside the callback its own git worktree. Isolation is BETWEEN scopes, not between agents: agents in one scope share a directory, so put things that must not collide in different scopes.

  await parallel([
    () => withWorktree('backend', () => agent('Rewrite the transport in src/rpc/**')),
    () => withWorktree('renderer', () => agent('Rewrite the panes in src/ui/**')),
  ])

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

**Model routing.** When the triggering request assigns models to roles ("ultracode, use sonnet for implementation and fable to review"), pass each matching agent that reference via opts.model and leave opts.model off for roles the request does not mention, which then use the session's default subagent model. The instruction holds for later workflows until the user changes it. Pass the name the user used rather than guessing at a canonical id: an ambiguous or unavailable reference fails that agent with the reason instead of quietly running on something else.`;

export const WORKFLOW_PROMPT_SNIPPET =
	"workflow: orchestrate fleets of subagents from a script, in the background (requires explicit user opt-in, e.g. the ultracode keyword)";

/**
 * Appended to every subagent prompt so replies come back as data. An agent
 * given forked context has already seen it as its opening exchange, so this
 * says nothing about it — the prompt that follows is the task.
 *
 * The second sentence is a cost control, not a style note, and it now carries
 * the whole load. pi has no --max-turns for a headless run, and the wall-clock
 * ceiling that used to backstop it has been removed — an agent runs until it
 * decides it is finished or the user aborts. Measured runs spent far more on
 * four deep agents than on any wide fleet. This is quite literally the only
 * budget an agent gets, so it is imperative and placed before the task.
 */
export const SUBAGENT_PREAMBLE =
	"You are a subagent in a deterministic workflow. Your final message is consumed by a script, not read by a person: return the requested data directly, with no preamble and no offers of further help.\n\nDo what the task asks and then stop. Do not widen the scope, do not go hunting for adjacent problems, and do not keep exploring once you can answer — another agent covers what you were not asked about.\n\nChecking that what you built actually works is NOT widening the scope; it is the last step of the task. If you wrote code, run it. Report what you observed, not what you intended — and if the only thing you ran was a typecheck, or tests you wrote yourself against a fixture you also wrote, say exactly that rather than calling it verified. If the task cannot be completed, say so in one line rather than working around it.\n\nMake independent tool calls in the same message rather than one per message — several reads, several greps, or edits to files that do not overlap all go together, and they run concurrently. Only wait for a result when the next call genuinely depends on it.\n\n";
