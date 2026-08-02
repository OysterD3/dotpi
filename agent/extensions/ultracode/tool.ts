/**
 * The `workflow` tool: script in, orchestrated subagent fleet out.
 *
 * Runs are BACKGROUND by default: execute() validates the script (meta AND a
 * compile check, so a syntax error fails here rather than arriving minutes
 * later as a failed run), starts the fleet, and returns immediately with a run
 * id. When the run settles, the outcome is sent back as a "workflow-result"
 * custom message — a follow-up if the agent is mid-turn, a turn of its own if
 * idle. Pass wait: true to block the tool call and get the result directly.
 *
 * A run is durable. Everything it does is written under
 * ~/.pi/agent/workflow-runs/<runId>/ as it happens (store.ts), which is what
 * makes the other three properties possible:
 *   - resume: `resumeFromRunId` replays the previous run's journal, so
 *     unchanged agents return instantly and only new or edited ones spawn;
 *   - pause: /workflows pause parks new agents without killing in-flight ones;
 *   - debugging: each agent has its own pi session file under agents/.
 *
 * Subagent models: agent()'s model option and the ultracode.model setting are
 * REFERENCES ("sonnet", "fable", "provider/id"), resolved against the model
 * registry with pi's --model rules (models.ts) before spawning. Routing is
 * said in the request that triggers the workflow, so the names arriving here
 * are the ones the user used — they land on real models or fail that agent
 * loudly, never silently on the wrong model.
 *
 * Accounting: a `wait: true` run attaches its spend to the tool result as
 * `usage`, which is how pi records it. A background run cannot — the tool
 * returned long before the money was spent — so it announces each subagent
 * turn on SPEND_CHANNEL instead, and a reader adds the two up. The two paths
 * are exclusive on purpose: announcing a `wait: true` run as well would bill
 * the same tokens twice.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { loadAgentTypes, type AgentTypeDef, type AgentTypeRegistry } from "./agents.ts";
import { buildContextBundle, seedAgentSession, type BranchEntry } from "./context.ts";
import { CONFIG, SPEND_CHANNEL, SPEND_SOURCE, USAGE_PERSIST_MS, WORKFLOW_DIR, type UltracodeSettings } from "./config.ts";
import { SUBAGENT_PREAMBLE, WORKFLOW_DESCRIPTION, WORKFLOW_PROMPT_SNIPPET } from "./description.ts";
import { runWorkflowScript, validateScript, type AgentOptions, type EngineHooks } from "./engine.ts";
import { ReplayIndex, type JournalInput } from "./journal.ts";
import { resolveModelReference, resolveRole } from "./models.ts";
import {
	allAgentsFailed,
	newProgress,
	PauseGate,
	RunRegistry,
	tallyAgents,
	type AgentRow,
	type RunProgress,
	type WorkflowRun,
} from "./runs.ts";
import { startedLabel } from "./panel.ts";
import { addUsage, emptyUsage, runSubagent, type SpawnUsage } from "./spawn.ts";
import {
	agentErrorPath,
	agentsDir,
	agentSessionId,
	sharedSessionId,
	sessionPathById,
	appendJournalLine,
	createRun,
	newRunId,
	pruneRuns,
	readJournalLines,
	readScript,
	writeMeta,
	type RunMeta,
} from "./store.ts";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const RESULT_MESSAGE = "workflow-result";

export interface WorkflowToolOptions {
	registry: RunRegistry;
	agentDir: string;
	settings: () => UltracodeSettings;
	/** Called whenever any run's progress changes (drives the panel and TUI). */
	onRunEvent?: () => void;
}

/**
 * JSON.stringify that survives circular references and BigInt values.
 *
 * Only true cycles are replaced: the guard tracks the ANCESTOR PATH, not every
 * object ever visited, so a value that legitimately appears twice (a DAG, e.g.
 * `return { items, best: items[0] }`) serializes in full both times. A visited
 * set would silently replace real result data with "[circular]".
 */
export function safeStringify(value: unknown): string {
	if (value === undefined) return "(the script returned no value)";
	try {
		const path: unknown[] = [];
		const text = JSON.stringify(
			value,
			function (this: unknown, _key, entry) {
				if (typeof entry === "bigint") return entry.toString();
				if (typeof entry !== "object" || entry === null) return entry;
				// `this` is the holder of the current key. Unwind the path back to
				// it, so only entries still on the path are genuine ancestors.
				const depth = path.lastIndexOf(this);
				path.length = depth + 1;
				if (path.includes(entry)) return "[circular]";
				path.push(entry);
				return entry;
			},
			2,
		);
		return text ?? "(the script returned no JSON-serializable value)";
	} catch (error) {
		return `(unserializable result: ${error instanceof Error ? error.message : String(error)})`;
	}
}

/** Where a run's script comes from: inline, a saved name, a path, or a resume. */
export function resolveScript(
	params: { script?: string; name?: string; scriptPath?: string; resumeFromRunId?: string },
	agentDir: string,
): { script: string; source: string } {
	if (params.scriptPath) {
		try {
			return { script: readFileSync(params.scriptPath, "utf8"), source: params.scriptPath };
		} catch (error) {
			throw new Error(`cannot read scriptPath ${params.scriptPath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (params.name) {
		const path = join(agentDir, WORKFLOW_DIR, `${params.name}.js`);
		try {
			return { script: readFileSync(path, "utf8"), source: path };
		} catch {
			throw new Error(`no saved workflow named "${params.name}" (looked in ${join(agentDir, WORKFLOW_DIR)})`);
		}
	}
	if (params.script) return { script: params.script, source: "inline" };
	if (params.resumeFromRunId) {
		const previous = readScript(agentDir, params.resumeFromRunId);
		if (previous) return { script: previous, source: `run ${params.resumeFromRunId}` };
		throw new Error(`cannot resume ${params.resumeFromRunId}: its stored script is missing`);
	}
	throw new Error("workflow requires one of: script, name, scriptPath, or resumeFromRunId");
}

export function registerWorkflowTool(pi: ExtensionAPI, options: WorkflowToolOptions): void {
	pi.registerMessageRenderer<RunProgress>(RESULT_MESSAGE, (message, { expanded }, theme) => {
		const progress = message.details;
		if (!progress || !Array.isArray(progress.phases)) {
			const text = typeof message.content === "string" ? message.content : "";
			return new Text(text.split("\n")[0] ?? "", 0, 0);
		}
		return new Text(renderProgress(progress, theme, expanded), 0, 0);
	});

	pi.registerTool({
		name: "workflow",
		label: "Workflow",
		description: WORKFLOW_DESCRIPTION,
		promptSnippet: WORKFLOW_PROMPT_SNIPPET,
		executionMode: "sequential",
		parameters: Type.Object({
			script: Type.Optional(
				Type.String({ description: "Self-contained workflow script starting with `export const meta = {...}`" }),
			),
			name: Type.Optional(Type.String({ description: "Name of a saved workflow in ~/.pi/agent/workflows/<name>.js" })),
			scriptPath: Type.Optional(Type.String({ description: "Path to a workflow script file on disk" })),
			resumeFromRunId: Type.Optional(
				Type.String({
					description:
						"Replay a previous run's journal: unchanged agents return their stored results instantly, edited or new ones run live. Omit script to reuse the stored one.",
				}),
			),
			args: Type.Optional(Type.Any({ description: "Value exposed to the script as the global `args`" })),
			wait: Type.Optional(
				Type.Boolean({
					description: "Block until the workflow finishes and return its result directly (default: false, background)",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Both of these throw straight out as an error tool result, which is
			// the point: an unusable script must fail the call, not a run.
			const { script, source } = resolveScript(params, options.agentDir);
			const { meta } = validateScript(script);
			const run = startRun(pi, { ...params, script, source }, meta.name, ctx, options, params.wait === true);

			if (params.wait === true) {
				// Synchronous mode: stream progress into this tool row and hand the
				// outcome back directly. The turn's own abort cancels the run.
				const onAbort = () => run.controller.abort();
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
				const stream = setInterval(() => {
					onUpdate?.({ content: [{ type: "text", text: phaseText(run.progress) }], details: structuredClone(run.progress) });
				}, 300);
				try {
					await run.settled;
				} finally {
					clearInterval(stream);
					signal?.removeEventListener("abort", onAbort);
				}
				const outcome = run.outcome!;
				if (outcome.isError) {
					// Announce before throwing. A `wait: true` run is normally accounted
					// for by the `usage` on the result below, and announces nothing so
					// the two cannot double up — but pi builds the tool result itself
					// when execute throws, and that one carries no usage at all. Four
					// minutes of agents that then failed would otherwise vanish from
					// every total. Announced once, as the run's whole spend, because
					// the per-turn door was shut for this run.
					announceRunSpend(pi, run.progress.usage, run.spendDetail);
					throw new Error(run.progress.status === "aborted" ? "Workflow aborted" : outcome.text);
				}
				return {
					content: [{ type: "text", text: outcome.text }],
					// `turns` is lifted to the top of details on purpose, beside the
					// progress it duplicates. pi's `Usage` carries tokens and cost but
					// no call count, so a reader adding up a session sees one tool
					// result and counts one call — for a fleet that made twenty-four.
					// details is the only channel that is both free-form and persisted,
					// and `details.turns` is the shape the other spending tools in this
					// repo already use.
					details: { ...structuredClone(run.progress), turns: run.progress.usage.turns, spendLabel: run.spendDetail },
					usage: toPiUsage(run.progress.usage),
				};
			}

			return {
				content: [
					{
						type: "text",
						text: [
							`Workflow "${meta.name}" started in the background (id: ${run.progress.runId}).`,
							`A "${RESULT_MESSAGE}" message will arrive when it completes — do not fabricate or predict its results; continue with other work or end the turn.`,
							`The user can watch the status panel and open /workflows to inspect, pause, resume, or cancel it.`,
						].join("\n"),
					},
				],
				details: { runId: run.progress.runId, name: run.progress.name, background: true },
			};
		},

		renderCall(args, theme: Theme) {
			let name = args.name ?? "workflow";
			let description = "";
			try {
				if (args.script) {
					const meta = validateScript(args.script).meta;
					name = meta.name;
					description = meta.description;
				}
			} catch {
				/* pre-meta or invalid script: render generic */
			}
			if (args.resumeFromRunId) description = description ? `${description} (resuming ${args.resumeFromRunId})` : `resuming ${args.resumeFromRunId}`;
			const mode = args.wait === true ? "" : ` ${theme.fg("muted", "(background)")}`;
			const title = `${theme.fg("toolTitle", theme.bold("Workflow"))} ${theme.fg("accent", name)}${mode}`;
			return new Text(description ? `${title}  ${theme.fg("muted", description)}` : title, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme: Theme) {
			const details = result.details as (RunProgress & { background?: boolean }) | { runId: string; name: string; background: true } | undefined;
			if (details && "background" in details && details.background) {
				// The name, not the run id: this row is read, never typed at. The id
				// stays in the tool's text result, which is what the model reads and
				// what it needs to resume the run.
				return new Text(
					`${theme.fg("success", "▶")} ${theme.fg("text", `started ${details.name}`)}  ${theme.fg("muted", "progress in the panel · /workflows")}`,
					0,
					0,
				);
			}
			if (details && "phases" in details && Array.isArray(details.phases)) {
				return new Text(renderProgress(details, theme, expanded, isPartial), 0, 0);
			}
			const text = result.content.find((block) => block.type === "text");
			return new Text(text && "text" in text ? text.text : "", 0, 0);
		},
	});
}

/** Everything a run needs from the session, snapshotted before it can go stale. */
interface RunEnv {
	cwd: string;
	approved: boolean;
	defaultModel?: string;
	provider?: string;
	modelId?: string;
	branch: BranchEntry[];
	parentSession?: string;
	sessionId?: string;
}

function snapshotEnv(ctx: ExtensionContext, settings: UltracodeSettings): RunEnv {
	// Pinned once, at run start: every agent uses the same default even if the
	// session model changes while the fleet is in flight. An unusable configured
	// default fails the whole run here rather than nulling every agent into a
	// success-shaped empty result.
	const reference = settings.model;
	const defaultModel = reference ? resolveReference(reference, ctx) : ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	// The branch is only ever background material for forked context, and the
	// session file only lineage metadata. Neither is worth failing a run over,
	// so an ephemeral or already-replaced session degrades instead of throwing.
	let branch: BranchEntry[] = [];
	let parentSession: string | undefined;
	let sessionId: string | undefined;
	try {
		branch = (ctx.sessionManager.getBranch() ?? []) as BranchEntry[];
		parentSession = ctx.sessionManager.getSessionFile() ?? undefined;
		sessionId = ctx.sessionManager.getSessionId() ?? undefined;
	} catch {
		/* no session to fork from */
	}
	return {
		cwd: ctx.cwd,
		approved: ctx.isProjectTrusted(),
		defaultModel,
		provider: ctx.model?.provider,
		modelId: ctx.model?.id,
		branch,
		parentSession,
		sessionId,
	};
}

/** Start the fleet; the returned run is already registered and ticking. */
function startRun(
	pi: ExtensionAPI,
	params: { script: string; source: string; args?: unknown; resumeFromRunId?: string },
	name: string,
	ctx: ExtensionContext,
	options: WorkflowToolOptions,
	wait: boolean,
): WorkflowRun {
	const { registry, agentDir } = options;
	const settings = options.settings();
	const env = snapshotEnv(ctx, settings);
	const agentTypes = loadAgentTypes(agentDir);

	const runId = newRunId();
	const progress = newProgress(runId, name);
	progress.resumedFrom = params.resumeFromRunId;
	const controller = new AbortController();
	const gate = new PauseGate();
	const rows = new Map<number, AgentRow>();
	/** Shared session names whose forked context was successfully written. */
	const seededSessions = new Set<string>();
	/**
	 * Shared session names an agent has already run under, seeded or not. A
	 * superset of seededSessions: it says a further seed would collide, which is
	 * a weaker claim than saying the context is there.
	 */
	const startedSessions = new Set<string>();
	let currentPhase: string | undefined;
	let seq = 0;

	const meta: RunMeta = {
		runId,
		name,
		status: "running",
		cwd: env.cwd,
		pid: process.pid,
		sessionId: env.sessionId,
		startedAt: Date.now(),
		agentCount: 0,
		usage: progress.usage,
		resumedFrom: params.resumeFromRunId,
		args: params.args,
	};
	createRun(agentDir, meta, params.script);

	const journal = (record: JournalInput) => appendJournalLine(agentDir, runId, { ...record, seq: ++seq, t: Date.now() });
	let lastPersist = 0;
	const persist = () => {
		meta.status = progress.status;
		meta.agentCount = progress.agentCount;
		meta.usage = progress.usage;
		meta.error = progress.error;
		meta.replayedCount = progress.replayedCount;
		lastPersist = Date.now();
		writeMeta(agentDir, meta);
	};
	/**
	 * Persist, but not on every streamed turn.
	 *
	 * run.json is how ANOTHER pi session sees this run — its own registry has
	 * nothing, so its panel reads the file. Live spend has to reach the file for
	 * that to be true, but a fleet of sixteen agents reporting a turn each would
	 * otherwise rewrite it dozens of times a minute. Every settled agent still
	 * persists unconditionally, so the throttle only ever delays the tail.
	 */
	const persistThrottled = () => {
		if (Date.now() - lastPersist >= USAGE_PERSIST_MS) persist();
	};
	const changed = () => options.onRunEvent?.();

	/**
	 * Announce one subagent turn's spend for whoever is keeping a session total.
	 *
	 * Silent for `wait: true` runs: pi attaches their usage to the tool result
	 * (see `toPiUsage` at the end of execute), so a reader that walks the
	 * transcript already has these tokens. Announcing them as well billed every
	 * synchronous workflow twice — once as a `workflow (tool)` row and once in
	 * the announced total. Only background runs, whose tool result was resolved
	 * long before the money was spent, need this door.
	 */
	// Named once, at start: the run's own label for /usage's per-run rows. Fixed
	// for the run's lifetime so a fleet that crosses midnight does not split into
	// two rows, and carrying the start time because two runs of the same workflow
	// are otherwise indistinguishable.
	const spendDetail = `${name} (${startedLabel(meta.startedAt, meta.startedAt)})`;

	const announceSpend = (delta: SpawnUsage) => {
		if (wait) return;
		// Nothing after the run is cancelled. `session_shutdown` aborts every
		// controller but the children only die on SIGTERM-then-SIGKILL, so their
		// last `message_end` events can arrive seconds later — after pi has
		// started the next session and the subscriber has reset its tally. Those
		// tokens would land in a session that never spent them. The abort is the
		// boundary; the run's own totals still take them (run.json is right).
		if (controller.signal.aborted) return;
		pi.events.emit(SPEND_CHANNEL, {
			source: SPEND_SOURCE,
			detail: spendDetail,
			calls: delta.turns,
			usage: {
				input: delta.input,
				output: delta.output,
				cacheRead: delta.cacheRead,
				cacheWrite: delta.cacheWrite,
				reasoning: delta.reasoning,
				cost: delta.cost,
			},
		});
	};

	// A resume reads the previous journal; a fresh run gets an empty index.
	const replayIndex = params.resumeFromRunId ? new ReplayIndex(readJournalLines(agentDir, params.resumeFromRunId)) : undefined;
	if (replayIndex) {
		progress.logs.push(`resuming ${params.resumeFromRunId}: ${replayIndex.size} completed agent(s) available to replay`);
	}

	const phaseRows = (title: string): AgentRow[] => {
		let entry = progress.phases.find((p) => p.title === title);
		if (!entry) {
			entry = { title, agents: [] };
			progress.phases.push(entry);
		}
		return entry.agents;
	};

	const hooks: EngineHooks = {
		agentStart: (index, label, phase) => {
			const row: AgentRow = { index, label, status: "running", phase: phase ?? currentPhase, startedAt: Date.now() };
			rows.set(index, row);
			phaseRows(row.phase ?? "Agents").push(row);
			progress.agentCount = Math.max(progress.agentCount, index);
			changed();
		},
		agentEnd: (index, ok) => {
			const row = rows.get(index);
			if (row) row.status = ok ? "done" : "failed";
			changed();
		},
		agentSettled: (outcome) => {
			const row = rows.get(outcome.index);
			if (row) {
				row.status = outcome.status === "failed" ? "failed" : outcome.status === "replayed" ? "replayed" : "done";
				row.endedAt = outcome.endedAt;
				row.error = outcome.error;
				row.options = outcome.options;
				row.agentType = outcome.options.agentType;
			}
			if (outcome.status === "replayed") progress.replayedCount++;
			journal({
				kind: "agent",
				index: outcome.index,
				key: outcome.key,
				label: outcome.label,
				phase: outcome.phase,
				model: row?.model,
				agentType: outcome.options.agentType,
				sessionFile: row?.sessionFile,
				status: outcome.status === "failed" ? "failed" : "done",
				result: outcome.status === "failed" ? undefined : outcome.value,
				error: outcome.error,
				usage: row?.usage,
				startedAt: outcome.startedAt,
				endedAt: outcome.endedAt,
				replayed: outcome.status === "replayed",
			});
			persist();
			changed();
		},
		replay: (key) => {
			if (!replayIndex) return { hit: false };
			const found = replayIndex.take(key);
			return found.hit ? { hit: true, value: found.record.result } : { hit: false };
		},
		waitWhilePaused: async (signal) => {
			if (!gate.isPaused()) return;
			if (progress.status === "running") {
				progress.status = "paused";
				journal({ kind: "run", event: "paused" });
				persist();
				changed();
			}
			await gate.wait(signal);
			if (progress.status === "paused" && !gate.isPaused()) {
				progress.status = "running";
				journal({ kind: "run", event: "resumed" });
				persist();
				changed();
			}
		},
		spawn: async (prompt, agentOptions: AgentOptions, index, spawnSignal, attempt) => {
			const type = agentOptions.agentType ? agentTypes.types.get(agentOptions.agentType) : undefined;
			if (agentOptions.agentType && !type) {
				const known = [...agentTypes.types.keys()].join(", ") || "none configured";
				throw new Error(`unknown agentType "${agentOptions.agentType}" (known: ${known})`);
			}
			if (agentOptions.model !== undefined && typeof agentOptions.model !== "string") {
				throw new Error(`agent() model must be a string reference, got ${typeof agentOptions.model}`);
			}
			const model = resolveAgentModel(agentOptions, type, agentTypes.defaults, env, ctx);
			const thinking = resolveThinking(agentOptions, type, agentTypes.defaults);
			const tools = Array.isArray(agentOptions.tools) ? agentOptions.tools : type?.tools;

			// A shared session is addressed by name, so every agent in the chain
			// resolves to the same file and pi reopens it (main.js: an existing
			// --session-id is opened, not recreated). Note the missing `attempt`:
			// a schema retry continues the same conversation rather than starting a
			// clean one, which is what makes the retry prompt's "your previous
			// reply could not be used" mean anything to the agent reading it.
			const shared = typeof agentOptions.session === "string" && agentOptions.session.trim() ? agentOptions.session : undefined;
			const sessionId = shared ? sharedSessionId(runId, shared) : agentSessionId(runId, index, attempt);
			const sessionDir = agentsDir(agentDir, runId);

			const row = rows.get(index);
			if (row) {
				row.model = model;
				row.agentType = agentOptions.agentType;
			}

			// Fork the requested slice of context into the agent's own session,
			// which the child then reopens by id. A seeding failure is not fatal:
			// the agent still runs, just without the background.
			let sessionFile: string | undefined;
			// Seeding CREATES a session file, so it may only happen once per
			// session. For a chain the first agent seeds and the rest inherit;
			// seeding again would build a second file claiming the same id and
			// leave which one pi opens up to a directory scan. A later agent that
			// asks for context is told its request was dropped rather than left to
			// assume the background arrived.
			// Two different states, and conflating them told a positive lie. A
			// session that was SEEDED holds the context; a session that has merely
			// been STARTED (pi created it for an unseeded --session-id, or our seed
			// failed) does not, and can no longer be seeded because a second file
			// claiming that id would leave which one pi opens to a directory scan.
			// Reporting the second case as the first meant a chain whose very first
			// seed failed logged "already holds the conversation" for every later
			// agent, while no agent in it ever saw the context.
			const alreadySeeded = shared !== undefined && seededSessions.has(shared);
			const alreadyStarted = shared !== undefined && startedSessions.has(shared);
			if (agentOptions.context && alreadySeeded) {
				hooks.log(
					`agent ${agentOptions.label ?? index}: context ignored — session "${shared}" already holds the conversation it would have been seeded with`,
				);
			} else if (agentOptions.context && alreadyStarted) {
				hooks.log(
					`agent ${agentOptions.label ?? index}: context NOT delivered — session "${shared}" was already started without it, and seeding it now would collide. No agent in this chain has the forked context.`,
				);
			} else if (agentOptions.context) {
				const bundle = buildContextBundle({
					context: agentOptions.context,
					branch: env.branch,
					cwd: env.cwd,
				});
				if (bundle) {
					sessionFile = seedAgentSession({
						cwd: env.cwd,
						sessionDir,
						sessionId,
						bundle,
						provider: env.provider,
						model: env.modelId,
						parentSession: env.parentSession,
					});
					if (!sessionFile) hooks.log(`agent ${agentOptions.label ?? index}: context could not be seeded, running without it`);
					else if (shared !== undefined) seededSessions.add(shared);
				}
			}
			// Started, not seeded. pi creates the session itself for an unseeded
			// --session-id, so from the second agent onward a further seed would
			// collide either way — but only a seed that actually succeeded above
			// gets to claim the context is present.
			if (shared !== undefined) startedSessions.add(shared);

			// Every agent leaves a transcript, seeded or not — pi creates the
			// session for an unseeded --session-id itself, under a name only it
			// knows. Look it up once the child is done so the TUI can offer it
			// either way; a failed agent's transcript is the interesting one.
			const recordTranscript = () => {
				if (!row) return;
				// Looked up by the id this agent actually ran under. Deriving it from
				// (index, attempt) missed every shared-session agent, whose id is
				// `<runId>-s<slug>-<hash>`.
				row.sessionFile = sessionFile ?? sessionPathById(agentDir, runId, sessionId) ?? row.sessionFile;
			};

			// Spend is applied per turn as the child reports it, not in one lump
			// when it exits: a ten-minute agent used to read $0.0000 for ten
			// minutes, which is precisely when someone is deciding whether to let
			// the fleet keep running. The deltas already cover a dead agent's spend
			// too, so neither branch below adds the total a second time.
			const onUsage = (delta: SpawnUsage) => {
				addUsage(progress.usage, delta);
				if (row) row.usage = addedUsage(row.usage, delta);
				announceSpend(delta);
				persistThrottled();
				changed();
			};

			try {
				const result = await runSubagent({
					prompt: SUBAGENT_PREAMBLE + prompt,
					cwd: env.cwd,
					model,
					thinking,
					tools,
					appendSystemPrompt: type?.prompt,
					sessionDir,
					sessionId,
					stderrPath: agentErrorPath(agentDir, runId, index),
					approved: env.approved,
					signal: spawnSignal,
					onUsage,
				});
				recordTranscript();
				return result.text;
			} catch (error) {
				recordTranscript();
				throw error;
			}
		},
		log: (message) => {
			progress.logs.push(message);
			if (progress.logs.length > CONFIG.memoryLogLines) progress.logs.splice(0, progress.logs.length - CONFIG.memoryLogLines);
			journal({ kind: "log", message });
			changed();
		},
		phase: (title) => {
			currentPhase = title;
			phaseRows(title);
			journal({ kind: "phase", title });
			changed();
		},
	};

	const run: WorkflowRun = {
		progress,
		controller,
		gate,
		startedAt: meta.startedAt,
		settled: Promise.resolve(),
		spendDetail,
	};

	journal({ kind: "run", event: "start" });

	run.settled = runWorkflowScript(params.script, params.args, hooks, controller.signal).then(
		(result) => {
			// The script returning is not the same as the work happening. Judge the
			// run on its agents — see tallyAgents for what this is protecting.
			const tally = tallyAgents(progress);
			const replayed = result.replayedCount > 0 ? `, ${result.replayedCount} replayed` : "";
			const resumeHint = `Pass resumeFromRunId: "${runId}" to retry the failed agents without re-running the ones that succeeded — do that rather than writing a new workflow for the same work.`;

			if (allAgentsFailed(tally)) {
				// A script that swallowed every failure and returned cleanly still
				// produced nothing. Reported as an error so the panel says so, the
				// `wait: true` path throws, and the model is pointed at resume
				// instead of re-authoring.
				progress.status = "error";
				progress.error = `all ${tally.failed} agent${tally.failed === 1 ? "" : "s"} failed`;
				run.outcome = {
					text: [
						`Workflow "${name}" (${runId}) produced nothing: all ${tally.failed} agent${tally.failed === 1 ? "" : "s"} failed. The script completed, but no agent did.`,
						`First failure: ${firstAgentError(progress) ?? "no error recorded"}`,
						resumeHint,
					].join("\n"),
					isError: true,
				};
				return;
			}

			progress.status = "done";
			// No cost in what the model is told either: a summary carrying a dollar
			// figure is a summary the model repeats back, which would put the number
			// in the transcript by another door. Spend still reaches run.json and
			// `/usage`.
			const failures = tally.failed > 0 ? `, ${tally.failed} FAILED` : "";
			const summary = `Workflow "${name}" (${runId}) finished: ${result.agentCount} agent${result.agentCount === 1 ? "" : "s"}${replayed}${failures}, ${progress.usage.turns} turns.`;
			// A partial failure stays "done" — the surviving agents did their work —
			// but it must not read as unqualified success, or the gap is silently
			// inherited by whatever is built on the result.
			const partial =
				tally.failed > 0
					? `\n\n${tally.failed} of ${tally.total} agents failed, so this result is incomplete. First failure: ${firstAgentError(progress) ?? "no error recorded"}\n${resumeHint}`
					: "";
			run.outcome = { text: `${summary}${partial}\n\nResult:\n${safeStringify(result.result)}`, isError: false };
		},
		(error) => {
			const message = error instanceof Error ? error.message : String(error);
			progress.status = controller.signal.aborted || message.includes("workflow aborted") ? "aborted" : "error";
			progress.error = message;
			const verb = progress.status === "aborted" ? "was cancelled" : "failed";
			run.outcome = {
				text: [
					`Workflow "${name}" (${runId}) ${verb} after ${progress.agentCount} agent${progress.agentCount === 1 ? "" : "s"}: ${message}`,
					`Its journal is kept: pass resumeFromRunId: "${runId}" to continue without re-running the agents that already succeeded — do that rather than writing a new workflow for the same work.`,
				].join("\n"),
				isError: true,
			};
		},
	);
	run.settled = run.settled.then(() => {
		meta.endedAt = Date.now();
		journal({ kind: "run", event: "end", status: progress.status, error: progress.error });
		persist();
		pruneRuns(agentDir, CONFIG.retainRuns);
		changed();
		if (!wait) deliverResult(pi, ctx, run);
	});
	registry.add(run);
	persist();
	changed();
	return run;
}

function addedUsage(current: SpawnUsage | undefined, part: SpawnUsage): SpawnUsage {
	const total: SpawnUsage = current ?? emptyUsage();
	addUsage(total, part);
	return total;
}

/**
 * What a workflow agent inherits, most specific first:
 *
 *   agent(…, { model })  →  the agentType's own model  →  subagents.json
 *   `defaults.model`  →  the run default (ultracode.model, else the SESSION's
 *   model)
 *
 * The `defaults` link was missing: agents.ts has always parsed
 * `subagents.json`'s `{ defaults: { model, reasoning } }`, and tool.ts only ever
 * read `types`. So a configured default was silently ignored, and every agent
 * without an explicit model fell straight through to the session model. That is
 * a reasonable last resort but a poor second choice — the whole point of
 * declaring a default is that subagents should not all run on the model you
 * happen to be talking to.
 */
function resolveAgentModel(
	agentOptions: AgentOptions,
	type: AgentTypeDef | undefined,
	defaults: AgentTypeRegistry["defaults"],
	env: RunEnv,
	ctx: ExtensionContext,
): string | undefined {
	const reference = agentOptions.model ?? type?.model ?? defaults.model;
	return reference ? resolveReference(reference, ctx) : env.defaultModel;
}

/**
 * The same chain for the reasoning level, and the same missing link.
 *
 * When nothing supplies a level, `--thinking` is omitted and the child pi falls
 * back to its OWN `defaultThinkingLevel` from settings.json — so a session
 * configured for "max" was quietly running every subagent at max reasoning,
 * which is a third to two thirds of the output tokens in the measured runs.
 * Honouring `defaults.reasoning` is what makes that configurable at all.
 */
export function resolveThinking(
	agentOptions: AgentOptions,
	type: AgentTypeDef | undefined,
	defaults: AgentTypeRegistry["defaults"],
): string | undefined {
	// Normalised, and each source tried in turn rather than the first one
	// present winning outright. Testing `typeof agentOptions.thinking ===
	// "string"` short-circuited the whole chain, so a script that wrote "High"
	// or "xHigh" — one capital letter — failed THINKING_LEVELS, returned
	// undefined, and dropped both the agent type's level and the registry
	// default. `--thinking` was then omitted and the child fell back to its own
	// settings.json defaultThinkingLevel, which is the max-reasoning cost blowup
	// that reading defaults.thinking was added to prevent.
	const normalise = (value: unknown): string | undefined => {
		if (typeof value !== "string") return undefined;
		const level = value.trim().toLowerCase();
		return THINKING_LEVELS.has(level) ? level : undefined;
	};
	return normalise(agentOptions.thinking) ?? normalise(type?.thinking) ?? normalise(defaults.thinking);
}

/**
 * The models this session could actually run.
 *
 * Routing against every KNOWN model sends fleets to providers there are no
 * credentials for: a run here resolved "coding" to kimi-coding and every agent
 * died on "No API key found for kimi-coding" — after spawning, one by one, with
 * the reason buried in each subagent's stderr. An unusable model is not a
 * candidate.
 *
 * Falls back to the full list if the filter leaves nothing, so an unexpected
 * auth representation degrades to the old behaviour rather than making every
 * model unresolvable.
 */
export function usableModels(ctx: ExtensionContext): ReturnType<ExtensionContext["modelRegistry"]["getAll"]> {
	const all = ctx.modelRegistry.getAll();
	try {
		const usable = all.filter((model) => ctx.modelRegistry.hasConfiguredAuth(model));
		return usable.length > 0 ? usable : all;
	} catch {
		return all;
	}
}

function resolveReference(reference: string, ctx: ExtensionContext): string {
	const mapped = resolveRole(reference, getAgentDir());
	const usable = usableModels(ctx);
	const resolved = resolveModelReference(mapped, usable);
	if (resolved.ok) return `${resolved.model.provider}/${resolved.model.id}`;

	// Resolvable only among models we cannot run: say THAT, at resolution time,
	// instead of letting every agent spawn and die on a missing key.
	const all = ctx.modelRegistry.getAll();
	if (all.length !== usable.length) {
		const anywhere = resolveModelReference(mapped, all);
		if (anywhere.ok) {
			throw new Error(
				`model "${reference}" resolves to ${anywhere.model.provider}/${anywhere.model.id}, but there are no credentials for ${anywhere.model.provider} — run /login for it, or name a model from a provider you are signed in to`,
			);
		}
	}
	throw new Error(resolved.error);
}

/** Hand a finished background run's outcome back to the main agent. */
function deliverResult(pi: ExtensionAPI, ctx: ExtensionContext, run: WorkflowRun): void {
	try {
		const idle = ctx.isIdle();
		pi.sendMessage<RunProgress>(
			{
				customType: RESULT_MESSAGE,
				content: run.outcome!.text,
				display: true,
				details: structuredClone(run.progress),
			},
			// Mid-turn: ride the current run as a follow-up. Idle: wake the agent
			// so the result gets processed, the way a task notification would.
			idle ? { triggerTurn: true } : { deliverAs: "followUp" },
		);
	} catch {
		/* a dead session cannot receive results; /workflows still shows them */
	}
}

/**
 * The first agent error in the run, for the outcome the model reads.
 *
 * One is enough and more is worse: when a whole fleet dies it is almost always
 * the same cause repeated (an ambiguous model reference killed all five agents
 * of every run it touched), and pasting it five times buries the fact that
 * there is one thing to fix. The rest are in the journal.
 */
function firstAgentError(progress: RunProgress): string | undefined {
	for (const phase of progress.phases) {
		for (const agent of phase.agents) {
			if (agent.status === "failed" && agent.error) return agent.error;
		}
	}
	return undefined;
}

function phaseText(progress: RunProgress): string {
	const lines: string[] = [];
	for (const phase of progress.phases) {
		const done = phase.agents.filter((a) => a.status === "done" || a.status === "replayed").length;
		const failed = phase.agents.filter((a) => a.status === "failed").length;
		lines.push(`${phase.title}: ${done}/${phase.agents.length} done${failed ? `, ${failed} failed` : ""}`);
	}
	if (progress.logs.length > 0) lines.push(...progress.logs.slice(-3));
	return lines.join("\n") || "starting…";
}

function renderProgress(progress: RunProgress, theme: Theme, expanded: boolean, isPartial = false): string {
	const lines: string[] = [];
	const mark =
		progress.status === "done"
			? theme.fg("success", "✓")
			: progress.status === "running" || progress.status === "paused"
				? theme.fg("warning", progress.status === "paused" ? "⏸" : "◆")
				: theme.fg("error", "✗");
	lines.push(`${mark} ${theme.fg("accent", progress.name)}`);
	for (const phase of progress.phases) {
		const done = phase.agents.filter((a) => a.status === "done").length;
		const replayed = phase.agents.filter((a) => a.status === "replayed").length;
		const failed = phase.agents.filter((a) => a.status === "failed").length;
		const running = phase.agents.filter((a) => a.status === "running").length;
		const parts = [`${done + replayed}/${phase.agents.length}`];
		if (running) parts.push(theme.fg("warning", `${running} running`));
		if (replayed) parts.push(theme.fg("muted", `${replayed} replayed`));
		if (failed) parts.push(theme.fg("error", `${failed} failed`));
		lines.push(`  ${theme.fg("accent", phase.title)}  ${parts.join("  ")}`);
		if (expanded) {
			for (const agent of phase.agents) {
				const agentMark =
					agent.status === "done"
						? theme.fg("success", "✓")
						: agent.status === "replayed"
							? theme.fg("muted", "⟲")
							: agent.status === "failed"
								? theme.fg("error", "✗")
								: theme.fg("warning", "…");
				lines.push(`    ${agentMark} ${theme.fg("text", agent.label)}`);
			}
		}
	}
	const logTail = expanded ? progress.logs : progress.logs.slice(-2);
	lines.push(...logTail.map((entry) => theme.fg("muted", `  ${entry}`)));
	if (progress.status === "error" && progress.error) {
		lines.push(theme.fg("error", `  ${progress.error}`));
	} else if (!isPartial) {
		lines.push(
			theme.fg(
				"muted",
				`  ${progress.agentCount} agent${progress.agentCount === 1 ? "" : "s"} · ${progress.usage.turns} turns`,
			),
		);
	}
	return lines.join("\n");
}

function toPiUsage(usage: SpawnUsage) {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		// Carried, not dropped: this is the only mapper onto pi's Usage, so
		// omitting it made a `wait: true` fleet report zero thinking tokens while
		// an identical background run (which announces) reported them in full.
		reasoning: usage.reasoning,
		totalTokens: usage.totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost },
	};
}

/**
 * Announce a whole run's spend in one go, for the paths that never announced
 * per turn. Same payload shape as the per-turn announcement in startRun; see
 * SPEND_CHANNEL for why `cost` is flat.
 */
function announceRunSpend(pi: ExtensionAPI, usage: SpawnUsage, detail: string | undefined): void {
	if (usage.turns === 0) return;
	pi.events.emit(SPEND_CHANNEL, {
		source: SPEND_SOURCE,
		// Absent only for a run built outside startRun (tests). A subscriber then
		// gets the source row without a per-run child, which is the right
		// degradation: no label is better than a wrong one.
		...(detail ? { detail } : {}),
		calls: usage.turns,
		usage: {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			reasoning: usage.reasoning,
			cost: usage.cost,
		},
	});
}
