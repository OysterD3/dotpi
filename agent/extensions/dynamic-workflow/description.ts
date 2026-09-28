/**
 * The workflow tool's LLM-facing description, and where the rest of it lives.
 *
 * The description holds only what decides WHETHER and HOW to call the tool:
 * background versus wait, the opt-in rule, the Ultracode and Bounding sections
 * the reminder texts name, and the shape of a script. Everything needed to
 * WRITE one well (every agent() option, forking, shared sessions, resume, the
 * pipeline and JOIN patterns, gating on shell() facts, worktrees, quality
 * patterns, model routing) is in REFERENCE.md beside this file, and the
 * description tells the model to read it before its first script in a session.
 * Measured on 2026-09-27, the whole text was ~5.7k tokens on every request
 * (with the schema, 6.5k of the 14.9k all extensions added), paid by sessions
 * that never run a workflow; the split leaves ~1.3k here and costs one read in
 * the sessions that do.
 *
 * On the wording, which predates the split: what was removed was the material
 * that pushed the model to expand (an instruction to workflow every
 * substantive task, "token cost is not a constraint", a completeness critic
 * whose whole job is generating another round); what was added is Bounding an
 * agent, because measured runs spend on agent DEPTH, not fleet width. That
 * correction then overshot, in two lines that were about width rather than
 * depth: "most work is served by three to five agents" put a number where the
 * task's own seams belong, and the fleet-shape list beside it named only work
 * that READS, so an implement request came out one agent wide. Width is now
 * counted from seams, a fleet of one is ruled out, and the tier split is named
 * as a smell (in REFERENCE.md). The guard against enthusiasm survives as the
 * thing it should always have been: say what each agent ALONE owns.
 *
 * Without an opt-in the rule used to end "do NOT call this tool without asking
 * the user first", and the permission lines said "without asking first". With
 * the mode off, a task that could use a fleet then became a question to the
 * user — "may I use a workflow?" — in 6 of 6 live trials. Whether to run one
 * is the model's call, so nothing here mentions asking any more.
 */

import { fileURLToPath } from "node:url";

/** The authoring reference the description points at, by absolute path. */
export const REFERENCE_PATH = fileURLToPath(new URL("./REFERENCE.md", import.meta.url));

export const WORKFLOW_DESCRIPTION = `Execute a workflow script that orchestrates multiple subagents deterministically. Each agent is a fresh headless pi run in this project directory with the standard tools (read, bash, edit, write); agents cannot spawn further workflows.

**Before you write your first script in a session, read ${REFERENCE_PATH}.** It is the authoring reference: every agent() option, forking context, shared sessions, agent types, resume, determinism, saved workflows, the concurrency ceiling, pipeline() versus barriers, the JOIN and review patterns, implementing as fan-out, gating on shell() facts, worktrees, quality patterns and model routing. This description covers only when to call the tool and the shape of a script.

Workflows run in the BACKGROUND: this call validates the script, starts the fleet, and returns immediately with a run id. A "workflow-result" message arrives when the run completes — NEVER fabricate or predict a pending run's results. Needing the result is not a reason to block: start the run and END YOUR TURN; the result message resumes the plan, and the user keeps the prompt meanwhile. The user watches progress in the status panel and can inspect, pause, resume or cancel runs from /workflows. Use wait: true only when the user asked to block, or when the session cannot outlive your turn (print/json mode, a one-shot invocation): there, ending the turn ends the process, and background work would silently vanish.

Runs are durable: every agent, log line and result is written to ~/.pi/agent/workflow-runs/<runId>/ as it happens, so a failed run can be resumed with resumeFromRunId and its transcripts survive.

ONLY call this tool when the user has explicitly opted into multi-agent orchestration. A workflow is expensive — the user must request that scale, not have it inferred. Explicit opt-in means one of:
- The user included the keyword "ultracode" in their prompt (you'll see a system-reminder confirming it).
- Ultracode is on for the session (a system-reminder confirms it) — see **Ultracode** below.
- The user directly asked for a workflow or multi-agent orchestration in their own words ("use a workflow", "fan out agents").

For any other task — even one that would clearly benefit from parallelism — do NOT call this tool; do the work inline.

**Ultracode.** When a system-reminder says ultracode is on, the opt-in is standing: you may run a workflow. That is permission, not an instruction to run one for every task. Reach for a fleet when the task's shape needs it — coverage wider than one context holds, independent verification of a claim you cannot check yourself, a mechanical sweep over many files, or a request carrying several deliverables that different agents would own — and work inline when it does not. A task that is merely large or important is not automatically one of those. Width is COUNTED, not chosen: count the task's seams — deliverables to build, files that would collide, findings to verify — and run one agent per seam. Ten real deliverables is ten agents, and there is no default size to fall back on. If you cannot say what each agent ALONE owns, you have not decomposed the task, and more agents will not do it for you. A fleet of ONE is the same failure from the other side: one agent's worth of work belongs inline, unless you are deliberately moving a long job off your turn. Multi-phase work (understand → design → implement → review) is ONE script with a phase() call per stage; start a second workflow only when the plan itself must be reshaped by reading a result first (see "One script or two" in the reference). A finished workflow is not a trigger for the next one: read the result and continue from it, and start another only if the result surfaced work whose shape needs a fleet. When a reminder says ultracode is off, revert to the opt-in rule above.

**Bounding an agent.** Spend is driven far more by how long each agent runs than by how many you start — a four-agent run routinely costs more than a twenty-agent one, because each agent keeps working until it decides it is finished. There is no turn limit; the prompt is the only budget an agent has. So give each one a single deliverable and a visible finish line ("return the three files that define routing" rather than "investigate routing"), prefer several bounded agents to one open-ended one, name the files or directories to start from when you already know them, and pass tools: ["read","grep","find","ls"] to any agent that only needs to look — an agent that cannot edit cannot wander off into fixing things.

**The shape of a script.** It begins with \`export const meta = {...}\`: a PURE object literal (no variables, calls or interpolation) with string fields \`name\` and \`description\`, \`phases: [{ title, detail? }]\` listing EVERY phase in the order the script reaches it (titles match the phase() calls; the panel draws this plan), and optionally \`deterministic: false\`. The body is plain JavaScript, NOT TypeScript, in an async context (use await and top-level return), with these globals:
- agent(prompt, opts?) — spawn a subagent; returns its final text, or null on failure. opts: label, phase, model, thinking, schema (returns parsed JSON), agentType, tools, context, session.
- parallel(thunks) — run concurrently; a BARRIER. A thunk that throws resolves to null.
- pipeline(items, stage1, stage2, ...) — each item through every stage, NO barrier between stages; stages receive (prevResult, originalItem, index).
- shell(command, opts?) — run a command on the host: {exitCode, stdout, stderr, truncated, timedOut}. The only value in a script an agent cannot author.
- withWorktree(name, callback) — agents inside the callback write in their own git worktree.
- phase(title), log(message), args (this tool's \`args\` input), budget (a stub: total is null).
Date.now(), argless new Date() and Math.random() throw inside a script, because they would break resume.`;

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
