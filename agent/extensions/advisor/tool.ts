/**
 * The `advisor` tool: zero parameters, exactly as Claude Code declares it. When
 * the main agent calls it, the whole session branch is flattened and forwarded
 * to the configured reviewer model, and the reviewer's advice comes back as the
 * tool result.
 *
 * Claude Code does the forwarding server-side (the `advisor_20260301` beta tool);
 * pi does it here in the client. The behavior the agent sees is the same: call
 * advisor(), wait, get advice.
 */
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { TOOL_NAME } from "./config.ts";
import { ADVISOR_PROMPT_SNIPPET, ADVISOR_TOOL_GUIDANCE, buildReviewerPrompt } from "./guidance.ts";
import { modelRef, resolveModelReference, sameModel } from "./models.ts";
import { runReviewer, type SpawnUsage, SubagentError } from "./spawn.ts";
import { buildTranscript, type TranscriptEntry } from "./transcript.ts";

export interface AdvisorToolOptions {
	/**
	 * The configured advisor reference (a `/advisor` session override, else the
	 * `advisor.model` setting), or undefined when unset/disabled. Read fresh on
	 * every call so a mid-session `/advisor` change takes effect immediately.
	 */
	reference: () => string | undefined;
}

export function toPiUsage(u: SpawnUsage): Usage {
	return {
		input: u.input,
		output: u.output,
		cacheRead: u.cacheRead,
		cacheWrite: u.cacheWrite,
		totalTokens: u.totalTokens,
		// SpawnUsage tracks only the summed cost, not the per-category split.
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: u.cost },
	};
}

export function registerAdvisorTool(pi: ExtensionAPI, options: AdvisorToolOptions): void {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Advisor",
		description: ADVISOR_TOOL_GUIDANCE,
		promptSnippet: ADVISOR_PROMPT_SNIPPET,
		// No parameters, matching Claude Code: the conversation is the input.
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, signal, onUpdate, ctx: ExtensionContext) {
			const reference = options.reference();
			if (!reference) {
				throw new Error(
					"No advisor model is configured. Set `advisor.model` in agent/settings.json or run `/advisor <model>` (for example `/advisor opus`).",
				);
			}

			const models = ctx.modelRegistry.getAll();
			const resolved = resolveModelReference(reference, models);
			if (!resolved.ok) {
				throw new Error(`Advisor model "${reference}" could not be used: ${resolved.error}.`);
			}

			// Claude Code's Czg rule: an advisor cannot be the very model it advises.
			// Degrade gracefully rather than erroring the turn — the agent proceeds
			// without advice instead of entering a retry loop.
			if (sameModel(resolved.model, ctx.model)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Advisor unavailable: it is set to ${modelRef(resolved.model)}, the same model now driving this session, so it cannot advise itself. Configure a different (stronger) advisor model with \`/advisor <model>\`. Proceeding without advice.`,
						},
					],
					details: { skipped: "same-model" as const, advisorModel: modelRef(resolved.model) },
				};
			}

			const reviewerModel = modelRef(resolved.model);
			onUpdate?.({
				content: [{ type: "text", text: `Consulting ${reviewerModel}…` }],
				details: { advisorModel: reviewerModel, phase: "consulting" as const },
			});

			const branch = ctx.sessionManager.getBranch() as TranscriptEntry[];
			const transcript = buildTranscript(branch, resolved.model.contextWindow);
			const prompt = buildReviewerPrompt(transcript.text);

			try {
				const result = await runReviewer({
					prompt,
					cwd: ctx.cwd,
					model: reviewerModel,
					signal,
				});
				const advice = result.text.trim() || "(The advisor returned no advice.)";
				return {
					content: [{ type: "text" as const, text: advice }],
					details: {
						advisorModel: reviewerModel,
						droppedMessages: transcript.dropped,
						turns: result.usage.turns,
					},
					usage: toPiUsage(result.usage),
				};
			} catch (error) {
				if (error instanceof SubagentError) {
					// A failed consult should not fail the agent's turn: return a
					// clear note (not an error) so it proceeds, and still bill the
					// reviewer's partial spend.
					return {
						content: [
							{
								type: "text" as const,
								text: `Advisor unavailable: ${error.message}. Proceeding without advice.`,
							},
						],
						details: { advisorModel: reviewerModel, error: error.message },
						usage: toPiUsage(error.usage),
					};
				}
				throw error;
			}
		},
	});
}
