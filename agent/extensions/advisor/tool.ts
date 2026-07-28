/**
 * The `advisor` tool: zero parameters — the conversation is the input. When the
 * main agent calls it, the whole session branch is flattened and forwarded to the
 * configured reviewer model, and the reviewer's advice comes back as the tool
 * result.
 *
 * A server-side version of this would do the forwarding in the API; pi does it
 * here in the client. The behaviour the agent sees is the same: call advisor(),
 * wait, get advice.
 *
 * The wait is the part the *human* sees, and it can run for minutes. The tool
 * streams a live status line — elapsed time, whether the reviewer is reasoning
 * or writing, and how much it has produced — because a single static
 * "Consulting…" for five minutes is indistinguishable from a hung subprocess.
 * See progress.ts.
 */
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { CONFIG, TOOL_NAME } from "./config.ts";
import { ADVISOR_PROMPT_SNIPPET, ADVISOR_TOOL_GUIDANCE, buildReviewerPrompt } from "./guidance.ts";
import { modelRef, resolveModelReference } from "./models.ts";
import { advisorStatus, emptyProgress, type ReviewerProgress } from "./progress.ts";
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
		// No parameters: the conversation is the input.
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

			// A stricter rule would refuse here when the advisor equals the session
			// model. That is allowed on purpose — the reviewer still reads the
			// transcript with a clean context, which is the point. See models.ts.
			const reviewerModel = modelRef(resolved.model);

			// A consult runs for minutes with nothing to show for it until the very
			// end. The status line is repainted on a timer rather than on each
			// streamed event: the clock has to keep moving through the long silence
			// before the first token (otherwise it reads as hung), and once tokens
			// do arrive, once a second is as fast as anyone can read.
			const startedAt = Date.now();
			let progress: ReviewerProgress = emptyProgress();
			const paint = () =>
				onUpdate?.({
					content: [
						{
							type: "text",
							text: advisorStatus({
								model: reviewerModel,
								progress,
								elapsedMs: Date.now() - startedAt,
								timeoutMs: CONFIG.reviewerTimeoutMs,
							}),
						},
					],
					details: {
						advisorModel: reviewerModel,
						phase: progress.phase,
						thinkingChars: progress.thinkingChars,
						adviceChars: progress.adviceChars,
					},
				});

			paint();
			const ticker = setInterval(paint, CONFIG.statusTickMs);
			(ticker as { unref?: () => void }).unref?.();

			const branch = ctx.sessionManager.getBranch() as TranscriptEntry[];
			const transcript = buildTranscript(branch, resolved.model.contextWindow);
			const prompt = buildReviewerPrompt(transcript.text);

			try {
				const result = await runReviewer({
					prompt,
					cwd: ctx.cwd,
					model: reviewerModel,
					signal,
					onProgress: (next) => {
						progress = next;
					},
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
			} finally {
				// Every exit passes through here, abort included: a ticker left
				// running would keep repainting a call that has already finished.
				clearInterval(ticker);
			}
		},
	});
}
