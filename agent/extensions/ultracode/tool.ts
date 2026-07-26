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
 * Honest accounting caveat: a background run's spend cannot ride a tool
 * result (the tool already returned), so it is reported in the result message
 * text and /workflows instead of pi's session usage totals; wait: true runs
 * attach usage properly.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { loadAgentTypes, type AgentTypeDef } from "./agents.ts";
import { buildContextBundle, seedAgentSession, type BranchEntry } from "./context.ts";
import { CONFIG, WORKFLOW_DIR, type UltracodeSettings } from "./config.ts";
import { SUBAGENT_PREAMBLE, WORKFLOW_DESCRIPTION, WORKFLOW_PROMPT_SNIPPET } from "./description.ts";
import { runWorkflowScript, validateScript, type AgentOptions, type EngineHooks } from "./engine.ts";
import { ReplayIndex, type JournalInput } from "./journal.ts";
import { resolveModelReference } from "./models.ts";
import { newProgress, PauseGate, RunRegistry, type AgentRow, type RunProgress, type WorkflowRun } from "./runs.ts";
import { addUsage, runSubagent, SubagentError, type SpawnUsage } from "./spawn.ts";
import {
	agentErrorPath,
	agentsDir,
	agentSessionId,
	agentSessionPath,
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
					throw new Error(run.progress.status === "aborted" ? "Workflow aborted" : outcome.text);
				}
				return {
					content: [{ type: "text", text: outcome.text }],
					details: structuredClone(run.progress),
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
				return new Text(
					`${theme.fg("success", "▶")} ${theme.fg("text", `started ${details.runId}`)}  ${theme.fg("muted", "progress in the panel · /workflows")}`,
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
	try {
		branch = (ctx.sessionManager.getBranch() ?? []) as BranchEntry[];
		parentSession = ctx.sessionManager.getSessionFile() ?? undefined;
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
	const limits = settings.limits;
	const env = snapshotEnv(ctx, settings);
	const agentTypes = loadAgentTypes(agentDir);

	const runId = newRunId();
	const progress = newProgress(runId, name);
	progress.resumedFrom = params.resumeFromRunId;
	const controller = new AbortController();
	const gate = new PauseGate();
	const rows = new Map<number, AgentRow>();
	let currentPhase: string | undefined;
	let seq = 0;

	const meta: RunMeta = {
		runId,
		name,
		status: "running",
		cwd: env.cwd,
		pid: process.pid,
		startedAt: Date.now(),
		agentCount: 0,
		usage: progress.usage,
		resumedFrom: params.resumeFromRunId,
		args: params.args,
	};
	createRun(agentDir, meta, params.script);

	const journal = (record: JournalInput) => appendJournalLine(agentDir, runId, { ...record, seq: ++seq, t: Date.now() });
	const persist = () => {
		meta.status = progress.status;
		meta.agentCount = progress.agentCount;
		meta.usage = progress.usage;
		meta.error = progress.error;
		meta.replayedCount = progress.replayedCount;
		writeMeta(agentDir, meta);
	};
	const changed = () => options.onRunEvent?.();

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
			const model = resolveAgentModel(agentOptions, type, env, ctx);
			const thinking = resolveThinking(agentOptions, type);
			const tools = Array.isArray(agentOptions.tools) ? agentOptions.tools : type?.tools;

			const sessionId = agentSessionId(runId, index, attempt);
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
			if (agentOptions.context) {
				const bundle = buildContextBundle({
					context: agentOptions.context,
					branch: env.branch,
					cwd: env.cwd,
					limits,
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
				}
			}

			// Every agent leaves a transcript, seeded or not — pi creates the
			// session for an unseeded --session-id itself, under a name only it
			// knows. Look it up once the child is done so the TUI can offer it
			// either way; a failed agent's transcript is the interesting one.
			const recordTranscript = () => {
				if (!row) return;
				row.sessionFile = sessionFile ?? agentSessionPath(agentDir, runId, index, attempt) ?? row.sessionFile;
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
					timeoutMs: limits.agentTimeoutMs,
				});
				addUsage(progress.usage, result.usage);
				if (row) row.usage = addedUsage(row.usage, result.usage);
				recordTranscript();
				return result.text;
			} catch (error) {
				// A dead agent's spend still counts.
				if (error instanceof SubagentError) {
					addUsage(progress.usage, error.usage);
					if (row) row.usage = addedUsage(row.usage, error.usage);
				}
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
	};

	journal({ kind: "run", event: "start" });

	run.settled = runWorkflowScript(params.script, params.args, hooks, controller.signal, { limits }).then(
		(result) => {
			progress.status = "done";
			const replayed = result.replayedCount > 0 ? `, ${result.replayedCount} replayed` : "";
			const summary = `Workflow "${name}" (${runId}) finished: ${result.agentCount} agent${result.agentCount === 1 ? "" : "s"}${replayed}, ${progress.usage.turns} turns, $${progress.usage.cost.toFixed(4)}.`;
			run.outcome = { text: `${summary}\n\nResult:\n${safeStringify(result.result)}`, isError: false };
		},
		(error) => {
			const message = error instanceof Error ? error.message : String(error);
			progress.status = controller.signal.aborted || message.includes("workflow aborted") ? "aborted" : "error";
			progress.error = message;
			const verb = progress.status === "aborted" ? "was cancelled" : "failed";
			run.outcome = {
				text: [
					`Workflow "${name}" (${runId}) ${verb} after ${progress.agentCount} agent${progress.agentCount === 1 ? "" : "s"} ($${progress.usage.cost.toFixed(4)}): ${message}`,
					`Its journal is kept: pass resumeFromRunId: "${runId}" to continue without re-running the agents that already succeeded.`,
				].join("\n"),
				isError: true,
			};
		},
	);
	run.settled = run.settled.then(() => {
		meta.endedAt = Date.now();
		journal({ kind: "run", event: "end", status: progress.status, error: progress.error });
		persist();
		pruneRuns(agentDir, limits.retainRuns);
		changed();
		if (!wait) deliverResult(pi, ctx, run);
	});
	registry.add(run);
	persist();
	changed();
	return run;
}

function addedUsage(current: SpawnUsage | undefined, part: SpawnUsage): SpawnUsage {
	const total: SpawnUsage = current ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0, turns: 0 };
	addUsage(total, part);
	return total;
}

function resolveAgentModel(
	agentOptions: AgentOptions,
	type: AgentTypeDef | undefined,
	env: RunEnv,
	ctx: ExtensionContext,
): string | undefined {
	// agent()'s own model wins, then the agent type's, then the run default.
	const reference = agentOptions.model ?? type?.model;
	return reference ? resolveReference(reference, ctx) : env.defaultModel;
}

function resolveThinking(agentOptions: AgentOptions, type: AgentTypeDef | undefined): string | undefined {
	const level = typeof agentOptions.thinking === "string" ? agentOptions.thinking : type?.thinking;
	return level && THINKING_LEVELS.has(level) ? level : undefined;
}

function resolveReference(reference: string, ctx: ExtensionContext): string {
	const resolved = resolveModelReference(reference, ctx.modelRegistry.getAll());
	if (!resolved.ok) throw new Error(resolved.error);
	return `${resolved.model.provider}/${resolved.model.id}`;
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
	lines.push(`${mark} ${theme.fg("accent", `${progress.runId} ${progress.name}`)}`);
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
				`  ${progress.agentCount} agent${progress.agentCount === 1 ? "" : "s"} · ${progress.usage.turns} turns · $${progress.usage.cost.toFixed(4)}`,
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
		totalTokens: usage.totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost },
	};
}
