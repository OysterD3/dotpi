/**
 * The `task` dispatch tool: the main agent delegates a scoped task to one of
 * the configured subagents by name. The chosen
 * subagent runs as a headless pi subprocess with its own model, reasoning
 * level, tool allowlist, and role prompt, and its final message is returned.
 *
 * The tool description is built from the current registry so the model sees the
 * available subagents and their purposes; index.ts re-registers on session
 * start to keep it fresh. `subagent_type` is a plain string validated here
 * (unknown -> a clear "Valid options:" error) rather than a
 * schema enum, so the set can change with config without a schema rebuild.
 */
import { Type } from "typebox";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { TOOL_NAME } from "./config.ts";
import { modelRef, resolveModelReference, resolveRole } from "./models.ts";
import { effective, findAgent } from "./registry.ts";
import type { SubagentsSettings } from "./config.ts";
import { runSubagent, type SpawnUsage, SubagentError } from "./spawn.ts";

export interface TaskToolOptions {
	/** The current registry, read fresh on every call. */
	settings: () => SubagentsSettings;
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

export function buildTaskDescription(settings: SubagentsSettings): string {
	const lines = [
		"Delegate a scoped task to a configured subagent. It runs in its own context, on its own model and reasoning level, and returns a single report. Use it to offload or parallelize specialist work.",
		"",
		"Available subagents (pass the name as subagent_type):",
	];
	for (const agent of settings.agents) lines.push(`- ${agent.name}: ${agent.purpose}`);
	lines.push(
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
		description: buildTaskDescription(options.settings()),
		promptSnippet: "Delegate a scoped task to a configured subagent",
		parameters: Type.Object({
			subagent_type: Type.String({ description: "Name of the configured subagent to run" }),
			description: Type.Optional(Type.String({ description: "A short (3-5 word) label for the task" })),
			prompt: Type.String({ description: "The complete, self-contained instruction for the subagent" }),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
			const settings = options.settings();
			const name = String(params.subagent_type ?? "").trim();
			const agent = findAgent(settings, name);
			if (!agent) {
				const valid = settings.agents.map((a) => a.name).join(", ") || "(none configured)";
				throw new Error(`Unknown subagent "${name}". Valid options: ${valid}.`);
			}

			const prompt = String(params.prompt ?? "").trim();
			if (!prompt) throw new Error(`The "${name}" subagent needs a prompt describing the task.`);

			// Resolve the effective model. An explicit model must resolve; when a
			// subagent pins no model, it inherits the session model.
			const { model: modelReference, reasoning } = effective(agent, settings.defaults);
			let model: string | undefined;
			if (modelReference) {
				const resolved = resolveModelReference(resolveRole(modelReference, getAgentDir()), ctx.modelRegistry.getAll());
				if (!resolved.ok) {
					throw new Error(`Subagent "${name}" model "${modelReference}" could not be used: ${resolved.error}.`);
				}
				model = modelRef(resolved.model);
			} else if (ctx.model) {
				model = `${ctx.model.provider}/${ctx.model.id}`;
			}

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
