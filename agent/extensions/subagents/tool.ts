/**
 * The `task` dispatch tool: the main agent delegates a scoped task to one of
 * the defined subagents by name, or, naming none, to a one-time agent whose
 * model, reasoning level and tools it chooses in the call. Either way the
 * subagent runs as a headless pi subprocess with its own model, reasoning
 * level, tool allowlist, and role prompt, and its final message is returned.
 *
 * The tool description is built from the agent files so the model sees the
 * available subagents and their purposes; index.ts re-registers on session
 * start to keep it fresh. `subagent_type` is a plain string validated here
 * (unknown -> a clear "Valid options:" error) rather than a
 * schema enum, so the set can change with the files without a schema rebuild.
 * The call itself re-reads the files, so an agent added mid-session runs at
 * once even before the description lists it.
 *
 * The inline model/reasoning/tools belong to one-time agents only. On a
 * defined subagent they are refused rather than applied: its file is the
 * promise the user wrote, and a read-only reviewer must not come back able
 * to edit because the caller asked.
 */
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { SPAWNABLE_TOOLS, type SubagentDef, THINKING_LEVELS, TOOL_NAME } from "./config.ts";
import { modelRef, resolveSuffixedReference } from "./models.ts";
import { effective, findAgent } from "./registry.ts";
import { runSubagent, type SpawnUsage, SubagentError } from "./spawn.ts";

export interface TaskToolOptions {
	/** The defined subagents, for the description. */
	agents: readonly SubagentDef[];
	/** The defined subagents as they are on disk now, read on every call. */
	load: (ctx: ExtensionContext) => readonly SubagentDef[];
}

export function toPiUsage(u: SpawnUsage): Usage {
	return {
		input: u.input,
		output: u.output,
		cacheRead: u.cacheRead,
		cacheWrite: u.cacheWrite,
		totalTokens: u.totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: u.cost },
	};
}

export function buildTaskDescription(agents: readonly SubagentDef[]): string {
	const lines = [
		"Delegate a scoped task to a subagent. It runs in its own context, on its own model and reasoning level, and returns a single report. Use it to keep a broad search or a read across many files out of your own context, or to hand off a self-contained piece of work.",
		"",
	];
	if (agents.length > 0) {
		lines.push("Defined subagents (pass the name as subagent_type):");
		for (const agent of agents) lines.push(`- ${agent.name}: ${agent.purpose}`);
		lines.push("");
	}
	lines.push(
		`One-time agent: omit subagent_type when no defined subagent fits. Then you may set model (a model reference such as provider/id; default: the session model), reasoning (${[...THINKING_LEVELS].join(", ")}), and tools (from ${SPAWNABLE_TOOLS.join(", ")}; default: pi's default tools, normally read, bash, edit, write). Pick a cheaper model for mechanical or read-only work, and give a job that only reads just read, grep, find, ls. These three fields apply to one-time agents only.`,
		"",
		"The subagent cannot see this conversation — give it a complete, self-contained prompt. Its final message is returned to you verbatim.",
	);
	return lines.join("\n");
}

/**
 * The batching rule, appended to whatever role the subagent runs under.
 *
 * A subagent spawns with --no-extensions, so nothing can reach its system
 * prompt except this string. The line is therefore duplicated from
 * tool-batching/guideline.ts rather than imported, which is this repo's rule
 * for anything crossing an extension boundary.
 *
 * It is appended even to a custom `prompt`: a configured role says what the
 * agent is for, not how the tool loop works, and one-tool-call-per-turn is the
 * single largest avoidable cost in a long subagent run.
 */
const BATCHING_LINE =
	"Make independent tool calls in the same message rather than one per message — several reads, several greps, or edits to files that do not overlap all go together, and they run concurrently. Only wait for a result when the next call genuinely depends on it.";

/** The name a one-time agent reports under, in progress and in details. */
export const ONE_TIME = "one-time";

const ONE_TIME_ROLE = "You are a one-time subagent. Do only what the task asks, then report back concisely.";

/**
 * The definition a one-time agent runs under, from the call's own fields.
 * Anything unusable throws: a tool name dropped here would leave the rest, or
 * nothing, and "nothing" means pi's default tools (bash, edit and write among
 * them) to spawn.ts, which is the one outcome worse than refusing (draft.ts has
 * the same rule).
 */
export function oneTimeAgent(params: { model?: unknown; reasoning?: unknown; tools?: unknown }): SubagentDef {
	let reasoning: string | undefined;
	if (params.reasoning !== undefined) {
		reasoning = String(params.reasoning).trim().toLowerCase();
		if (!THINKING_LEVELS.has(reasoning)) {
			throw new Error(`reasoning "${params.reasoning}" is not a thinking level (${[...THINKING_LEVELS].join(", ")}).`);
		}
	}
	let tools: string[] | undefined;
	if (params.tools !== undefined) {
		const wanted = Array.isArray(params.tools) ? params.tools.map((tool) => String(tool).trim().toLowerCase()).filter(Boolean) : [];
		const unknown = wanted.filter((tool) => !(SPAWNABLE_TOOLS as readonly string[]).includes(tool));
		if (wanted.length === 0 || unknown.length > 0) {
			const why = unknown.length > 0 ? ` — ${unknown.join(", ")} cannot run in a subagent` : "";
			throw new Error(`tools must name at least one of ${SPAWNABLE_TOOLS.join(", ")}${why}.`);
		}
		tools = [...new Set(wanted)];
	}
	const model = typeof params.model === "string" && params.model.trim() ? params.model.trim() : undefined;
	return { name: ONE_TIME, purpose: "a one-time task", model, reasoning, tools, prompt: ONE_TIME_ROLE };
}

/** The role prompt the subagent runs under: its own prompt, else its purpose. */
export function rolePrompt(agent: { name: string; purpose: string; prompt?: string }): string {
	const role =
		agent.prompt ??
		`You are the "${agent.name}" subagent. Your role: ${agent.purpose}. Do only what the task asks, then report back concisely.`;
	return `${role}\n\n${BATCHING_LINE}`;
}

export function registerTaskTool(pi: ExtensionAPI, options: TaskToolOptions): void {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Task",
		description: buildTaskDescription(options.agents),
		promptSnippet: "Delegate a scoped task to a defined or one-time subagent",
		promptGuidelines: [
			"Use task to hand a self-contained piece of work (a broad codebase search, a read across many files, an independent review) to a subagent when you only need its conclusion; omit subagent_type for a one-time agent when no defined subagent fits.",
		],
		parameters: Type.Object({
			subagent_type: Type.Optional(Type.String({ description: "Name of a defined subagent. Omit it to run a one-time agent." })),
			description: Type.Optional(Type.String({ description: "A short (3-5 word) label for the task" })),
			prompt: Type.String({ description: "The complete, self-contained instruction for the subagent" }),
			model: Type.Optional(Type.String({ description: "One-time agent only: a model reference such as provider/id. Default: the session model." })),
			reasoning: Type.Optional(Type.String({ description: "One-time agent only: off, minimal, low, medium, high, xhigh or max." })),
			tools: Type.Optional(
				Type.Array(Type.String(), { description: 'One-time agent only: tool allowlist, e.g. ["read","grep","find","ls"]. Default: pi\'s default tools, normally read, bash, edit, write.' }),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
			const requested = String(params.subagent_type ?? "").trim();
			const inline = (["model", "reasoning", "tools"] as const).filter((key) => params[key] !== undefined);
			let agent: SubagentDef;
			if (requested) {
				const agents = options.load(ctx);
				const found = findAgent(agents, requested);
				if (!found) {
					const valid = agents.map((a) => a.name).join(", ") || "(none defined)";
					throw new Error(`Unknown subagent "${requested}". Valid options: ${valid}. Omit subagent_type to run a one-time agent.`);
				}
				if (inline.length > 0) {
					throw new Error(`${inline.join(", ")} apply only to a one-time agent — "${requested}" runs on its own settings. Drop them, or omit subagent_type.`);
				}
				agent = found;
			} else {
				agent = oneTimeAgent(params);
			}
			const name = agent.name;

			const prompt = String(params.prompt ?? "").trim();
			if (!prompt) throw new Error(`The "${name}" subagent needs a prompt describing the task.`);

			// Resolve the effective model. An explicit model must resolve; when a
			// subagent pins no model, it inherits the session model. A model
			// reference may carry a `:level` suffix — the spawn's --model still
			// needs the bare provider/id, but the level is honored, not dropped.
			// It counts only when resolution actually split: on a full match the
			// colon was the id's own, and there is no level.
			const { model: modelReference } = effective(agent);
			let model: string | undefined;
			let carried: string | undefined;
			if (modelReference) {
				const resolved = resolveSuffixedReference(modelReference, ctx.modelRegistry.getAll());
				if (!resolved.ok) {
					throw new Error(`Subagent "${name}" model "${modelReference}" could not be used: ${resolved.error}.`);
				}
				model = modelRef(resolved.model);
				carried = resolved.thinking;
			} else if (ctx.model) {
				model = `${ctx.model.provider}/${ctx.model.id}`;
			}

			// agent.reasoning ?? carried — effective() holds why the pin wins.
			const { reasoning } = effective(agent, carried);

			onUpdate?.({
				content: [{ type: "text", text: `Delegating to ${name}${model ? ` (${model}${reasoning ? `, ${reasoning}` : ""})` : ""}…` }],
				details: { subagent: name, model, reasoning, phase: "running" as const },
			});

			try {
				const result = await runSubagent({
					prompt,
					cwd: ctx.cwd,
					model,
					thinking: reasoning,
					tools: agent.tools,
					appendSystemPrompt: rolePrompt(agent),
					approved: ctx.isProjectTrusted?.() ?? false,
					signal,
				});
				const text = result.text.trim() || `(The ${name} subagent returned no output.)`;
				return {
					content: [{ type: "text" as const, text }],
					details: { subagent: name, model, reasoning, turns: result.usage.turns },
					usage: toPiUsage(result.usage),
				};
			} catch (error) {
				if (error instanceof SubagentError) {
					// Surface the failure as a tool error so the main agent can react,
					// but keep the message clean.
					throw new Error(`Subagent "${name}" failed: ${error.message}`);
				}
				throw error;
			}
		},
	});
}
