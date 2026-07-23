/**
 * The `workflow` tool: script in, orchestrated subagent fleet out.
 *
 * The engine (engine.ts) interprets the script; this file is the pi-facing
 * shell — TypeBox parameters, subagent spawning wired to the session's model
 * and trust, streamed progress rendering, and usage accounting on the result
 * so subagent spend (including spend by agents that then failed) shows up in
 * the session totals.
 */
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_PREAMBLE, WORKFLOW_DESCRIPTION, WORKFLOW_PROMPT_SNIPPET } from "./description.ts";
import { parseMeta, runWorkflowScript, type AgentOptions, type EngineHooks } from "./engine.ts";
import { addUsage, emptyUsage, runSubagent, SubagentError, type SpawnUsage } from "./spawn.ts";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

interface AgentRow {
	label: string;
	status: "running" | "done" | "failed";
}

export interface WorkflowDetails {
	name: string;
	status: "running" | "done" | "error";
	phases: Array<{ title: string; agents: AgentRow[] }>;
	logs: string[];
	agentCount: number;
	usage: SpawnUsage;
	error?: string;
}

export interface WorkflowToolOptions {
	/** Default model pattern for subagents, from settings ultracode.model. */
	subagentModel?: () => string | undefined;
}

/** JSON.stringify that survives circular references and BigInt values. */
export function safeStringify(value: unknown): string {
	if (value === undefined) return "(the script returned no value)";
	try {
		const seen = new WeakSet<object>();
		const text = JSON.stringify(
			value,
			(_key, entry) => {
				if (typeof entry === "bigint") return entry.toString();
				if (typeof entry === "object" && entry !== null) {
					if (seen.has(entry)) return "[circular]";
					seen.add(entry);
				}
				return entry;
			},
			2,
		);
		return text ?? "(the script returned no JSON-serializable value)";
	} catch (error) {
		return `(unserializable result: ${error instanceof Error ? error.message : String(error)})`;
	}
}

export function registerWorkflowTool(pi: ExtensionAPI, options: WorkflowToolOptions = {}): void {
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
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const details: WorkflowDetails = {
				name: "workflow",
				status: "running",
				phases: [],
				logs: [],
				agentCount: 0,
				usage: emptyUsage(),
			};
			const rows = new Map<number, AgentRow>();
			let currentPhase: string | undefined;

			const emit = () => {
				onUpdate?.({ content: [{ type: "text", text: progressText(details) }], details: { ...details } });
			};
			const phaseRows = (title: string): AgentRow[] => {
				let entry = details.phases.find((p) => p.title === title);
				if (!entry) {
					entry = { title, agents: [] };
					details.phases.push(entry);
				}
				return entry.agents;
			};

			const defaultModel =
				options.subagentModel?.() ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
			const approved = ctx.isProjectTrusted();

			const hooks: EngineHooks = {
				agentStart: (index, label, phase) => {
					const row: AgentRow = { label, status: "running" };
					rows.set(index, row);
					phaseRows(phase ?? currentPhase ?? "Agents").push(row);
					details.agentCount = Math.max(details.agentCount, index);
					emit();
				},
				agentEnd: (index, ok) => {
					const row = rows.get(index);
					if (row) row.status = ok ? "done" : "failed";
					emit();
				},
				spawn: async (prompt, agentOptions: AgentOptions, _index, spawnSignal) => {
					const thinking =
						typeof agentOptions.thinking === "string" && THINKING_LEVELS.has(agentOptions.thinking)
							? agentOptions.thinking
							: undefined;
					try {
						const result = await runSubagent({
							prompt: SUBAGENT_PREAMBLE + prompt,
							cwd: ctx.cwd,
							model: agentOptions.model ?? defaultModel,
							thinking,
							approved,
							signal: spawnSignal,
						});
						addUsage(details.usage, result.usage);
						return result.text;
					} catch (error) {
						// A dead agent's spend still counts.
						if (error instanceof SubagentError) addUsage(details.usage, error.usage);
						throw error;
					}
				},
				log: (message) => {
					details.logs.push(message);
					if (details.logs.length > 200) details.logs.splice(0, details.logs.length - 200);
					emit();
				},
				phase: (title) => {
					currentPhase = title;
					phaseRows(title);
					emit();
				},
			};

			try {
				details.name = parseMeta(params.script).meta.name;
				emit();
				const run = await runWorkflowScript(params.script, params.args, hooks, signal);
				if (signal?.aborted) throw new Error("workflow aborted");
				details.status = "done";

				const summary = `Workflow "${run.meta.name}" finished: ${run.agentCount} agent${run.agentCount === 1 ? "" : "s"}, ${details.usage.turns} turns, $${details.usage.cost.toFixed(4)}.`;
				return {
					content: [{ type: "text", text: `${summary}\n\nResult:\n${safeStringify(run.result)}` }],
					// A snapshot: the live object must not be mutated after return
					// by any spawn still winding down.
					details: structuredClone(details),
					usage: toPiUsage(details.usage),
				};
			} catch (error) {
				details.status = "error";
				details.error = error instanceof Error ? error.message : String(error);
				emit();
				if (signal?.aborted || details.error.includes("workflow aborted")) throw new Error("Workflow aborted");
				throw new Error(`Workflow failed: ${details.error}`);
			}
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
			const title = `${theme.fg("toolTitle", theme.bold("Workflow"))} ${theme.fg("accent", name)}`;
			return new Text(description ? `${title}  ${theme.fg("muted", description)}` : title, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme: Theme) {
			const details = result.details as WorkflowDetails | undefined;
			if (!details || !Array.isArray(details.phases)) {
				const text = result.content.find((block) => block.type === "text");
				return new Text(text && "text" in text ? text.text : "", 0, 0);
			}
			return new Text(renderDetails(details, theme, { expanded, isPartial }), 0, 0);
		},
	});
}

function progressText(details: WorkflowDetails): string {
	const lines: string[] = [];
	for (const phase of details.phases) {
		const done = phase.agents.filter((a) => a.status === "done").length;
		const failed = phase.agents.filter((a) => a.status === "failed").length;
		lines.push(`${phase.title}: ${done}/${phase.agents.length} done${failed ? `, ${failed} failed` : ""}`);
	}
	if (details.logs.length > 0) lines.push(...details.logs.slice(-3));
	return lines.join("\n") || "starting…";
}

function renderDetails(
	details: WorkflowDetails,
	theme: Theme,
	view: { expanded: boolean; isPartial: boolean },
): string {
	const lines: string[] = [];
	for (const phase of details.phases) {
		const done = phase.agents.filter((a) => a.status === "done").length;
		const failed = phase.agents.filter((a) => a.status === "failed").length;
		const running = phase.agents.filter((a) => a.status === "running").length;
		const parts = [`${done}/${phase.agents.length}`];
		if (running) parts.push(theme.fg("warning", `${running} running`));
		if (failed) parts.push(theme.fg("error", `${failed} failed`));
		lines.push(`${theme.fg("accent", phase.title)}  ${parts.join("  ")}`);
		if (view.expanded) {
			for (const agent of phase.agents) {
				const mark = agent.status === "done" ? theme.fg("success", "✓") : agent.status === "failed" ? theme.fg("error", "✗") : theme.fg("warning", "…");
				lines.push(`  ${mark} ${theme.fg("text", agent.label)}`);
			}
		}
	}
	const logTail = view.expanded ? details.logs : details.logs.slice(-3);
	lines.push(...logTail.map((entry) => theme.fg("muted", entry)));
	if (details.status === "error" && details.error) {
		lines.push(theme.fg("error", details.error));
	} else if (!view.isPartial) {
		lines.push(
			theme.fg(
				"muted",
				`${details.agentCount} agent${details.agentCount === 1 ? "" : "s"} · ${details.usage.turns} turns · $${details.usage.cost.toFixed(4)}`,
			),
		);
	}
	return lines.join("\n") || theme.fg("muted", "starting…");
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
