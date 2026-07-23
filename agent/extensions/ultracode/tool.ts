/**
 * The `workflow` tool: script in, orchestrated subagent fleet out.
 *
 * Runs are BACKGROUND by default: execute() validates the script, starts the
 * fleet, and returns immediately with a run id — the main agent keeps working
 * while the status panel (panel.ts, owned by index.ts) tracks progress. When
 * the run settles, the outcome is sent back as a "workflow-result" custom
 * message — a follow-up if the agent is mid-turn, a turn of its own if idle.
 * Pass wait: true to block the tool call and get the result directly.
 *
 * Subagent models: agent()'s model option and the ultracode.model setting are
 * REFERENCES ("sonnet", "fable", "provider/id"), resolved against the model
 * registry with pi's --model rules (models.ts) before spawning. Routing is
 * said in the request that triggers the workflow ("ultracode, use sonnet for
 * implementation and fable to review"), so the names arriving here are the
 * ones the user used — they land on real models or fail that agent loudly,
 * never silently on the wrong model.
 *
 * Honest accounting caveat: a background run's spend cannot ride a tool
 * result (the tool already returned), so it is reported in the result message
 * text and /workflows instead of pi's session usage totals; wait: true runs
 * attach usage properly.
 */
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_PREAMBLE, WORKFLOW_DESCRIPTION, WORKFLOW_PROMPT_SNIPPET } from "./description.ts";
import { parseMeta, runWorkflowScript, type AgentOptions, type EngineHooks } from "./engine.ts";
import { resolveModelReference } from "./models.ts";
import { newProgress, RunRegistry, type AgentRow, type RunProgress, type WorkflowRun } from "./runs.ts";
import { addUsage, runSubagent, SubagentError, type SpawnUsage } from "./spawn.ts";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const RESULT_MESSAGE = "workflow-result";

export interface WorkflowToolOptions {
	registry: RunRegistry;
	/** Default model reference for subagents, from settings ultracode.model. */
	subagentModel?: () => string | undefined;
	/** Called whenever any run's progress changes (drives the panel). */
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
				let depth = path.lastIndexOf(this);
				if (depth === -1 && path.length > 0 && this === undefined) depth = 0;
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
			script: Type.String({
				description: "Self-contained workflow script starting with `export const meta = {...}`",
			}),
			args: Type.Optional(Type.Any({ description: "Value exposed to the script as the global `args`" })),
			wait: Type.Optional(
				Type.Boolean({
					description: "Block until the workflow finishes and return its result directly (default: false, background)",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const meta = parseMeta(params.script).meta; // throws -> error tool result
			const run = startRun(pi, params, meta.name, ctx, options, params.wait === true);

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
							`The user can watch the status panel and use /workflows (or /workflows cancel ${run.progress.runId}).`,
						].join("\n"),
					},
				],
				details: { runId: run.progress.runId, name: run.progress.name, background: true },
			};
		},

		renderCall(args, theme: Theme) {
			let name = "workflow";
			let description = "";
			try {
				const meta = parseMeta(args.script ?? "").meta;
				name = meta.name;
				description = meta.description;
			} catch {
				/* pre-meta or invalid script: render generic */
			}
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

/** Start the fleet; the returned run is already registered and ticking. */
function startRun(
	pi: ExtensionAPI,
	params: { script: string; args?: unknown },
	name: string,
	ctx: ExtensionContext,
	options: WorkflowToolOptions,
	wait: boolean,
): WorkflowRun {
	const registry = options.registry;
	const progress = newProgress(registry.nextId(), name);
	const controller = new AbortController();
	const rows = new Map<number, AgentRow>();
	let currentPhase: string | undefined;
	const changed = () => options.onRunEvent?.();

	const phaseRows = (title: string): AgentRow[] => {
		let entry = progress.phases.find((p) => p.title === title);
		if (!entry) {
			entry = { title, agents: [] };
			progress.phases.push(entry);
		}
		return entry.agents;
	};

	// Pinned once, at run start: every agent in a run uses the same default,
	// even if the session model changes while the fleet is in flight. An
	// unusable configured default fails the whole run here rather than nulling
	// every agent into a success-shaped empty result.
	const defaultModel = (() => {
		const reference = options.subagentModel?.();
		if (reference) return resolveReference(reference, ctx);
		return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	})();

	const hooks: EngineHooks = {
		agentStart: (index, label, phase) => {
			const row: AgentRow = { label, status: "running" };
			rows.set(index, row);
			phaseRows(phase ?? currentPhase ?? "Agents").push(row);
			progress.agentCount = Math.max(progress.agentCount, index);
			changed();
		},
		agentEnd: (index, ok) => {
			const row = rows.get(index);
			if (row) row.status = ok ? "done" : "failed";
			changed();
		},
		spawn: async (prompt, agentOptions: AgentOptions, _index, spawnSignal) => {
			const thinking =
				typeof agentOptions.thinking === "string" && THINKING_LEVELS.has(agentOptions.thinking)
					? agentOptions.thinking
					: undefined;
			if (agentOptions.model !== undefined && typeof agentOptions.model !== "string") {
				throw new Error(`agent() model must be a string reference, got ${typeof agentOptions.model}`);
			}
			try {
				const result = await runSubagent({
					prompt: SUBAGENT_PREAMBLE + prompt,
					cwd: ctx.cwd,
					model: agentOptions.model ? resolveReference(agentOptions.model, ctx) : defaultModel,
					thinking,
					approved: ctx.isProjectTrusted(),
					signal: spawnSignal,
				});
				addUsage(progress.usage, result.usage);
				return result.text;
			} catch (error) {
				// A dead agent's spend still counts.
				if (error instanceof SubagentError) addUsage(progress.usage, error.usage);
				throw error;
			}
		},
		log: (message) => {
			progress.logs.push(message);
			if (progress.logs.length > 200) progress.logs.splice(0, progress.logs.length - 200);
			changed();
		},
		phase: (title) => {
			currentPhase = title;
			phaseRows(title);
			changed();
		},
	};

	const run: WorkflowRun = {
		progress,
		controller,
		startedAt: Date.now(),
		settled: Promise.resolve(),
	};

	run.settled = runWorkflowScript(params.script, params.args, hooks, controller.signal).then(
		(result) => {
			progress.status = "done";
			const summary = `Workflow "${name}" (${progress.runId}) finished: ${result.agentCount} agent${result.agentCount === 1 ? "" : "s"}, ${progress.usage.turns} turns, $${progress.usage.cost.toFixed(4)}.`;
			run.outcome = { text: `${summary}\n\nResult:\n${safeStringify(result.result)}`, isError: false };
		},
		(error) => {
			const message = error instanceof Error ? error.message : String(error);
			progress.status = controller.signal.aborted || message.includes("workflow aborted") ? "aborted" : "error";
			progress.error = message;
			const verb = progress.status === "aborted" ? "was cancelled" : "failed";
			run.outcome = {
				text: `Workflow "${name}" (${progress.runId}) ${verb} after ${progress.agentCount} agent${progress.agentCount === 1 ? "" : "s"} ($${progress.usage.cost.toFixed(4)}): ${message}`,
				isError: true,
			};
		},
	);
	run.settled = run.settled.then(() => {
		changed();
		if (!wait) deliverResult(pi, ctx, run);
	});
	registry.add(run);
	changed();
	return run;
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
		const done = phase.agents.filter((a) => a.status === "done").length;
		const failed = phase.agents.filter((a) => a.status === "failed").length;
		lines.push(`${phase.title}: ${done}/${phase.agents.length} done${failed ? `, ${failed} failed` : ""}`);
	}
	if (progress.logs.length > 0) lines.push(...progress.logs.slice(-3));
	return lines.join("\n") || "starting…";
}

function renderProgress(progress: RunProgress, theme: Theme, expanded: boolean, isPartial = false): string {
	const lines: string[] = [];
	const mark = progress.status === "done" ? theme.fg("success", "✓") : progress.status === "running" ? theme.fg("warning", "◆") : theme.fg("error", "✗");
	lines.push(`${mark} ${theme.fg("accent", `${progress.runId} ${progress.name}`)}`);
	for (const phase of progress.phases) {
		const done = phase.agents.filter((a) => a.status === "done").length;
		const failed = phase.agents.filter((a) => a.status === "failed").length;
		const running = phase.agents.filter((a) => a.status === "running").length;
		const parts = [`${done}/${phase.agents.length}`];
		if (running) parts.push(theme.fg("warning", `${running} running`));
		if (failed) parts.push(theme.fg("error", `${failed} failed`));
		lines.push(`  ${theme.fg("accent", phase.title)}  ${parts.join("  ")}`);
		if (expanded) {
			for (const agent of phase.agents) {
				const agentMark = agent.status === "done" ? theme.fg("success", "✓") : agent.status === "failed" ? theme.fg("error", "✗") : theme.fg("warning", "…");
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
