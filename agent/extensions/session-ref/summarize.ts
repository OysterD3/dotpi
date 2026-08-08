/**
 * The summary call: tool-less, over the referenced session's flattened
 * branch, on the cheap-role model (model.ts selectModel — recap's policy,
 * copied). Mirrors recap's generate.ts because it is the same kind of call;
 * the differences are the prompt (a structured handoff, not a one-liner) and
 * the input (a foreign session's branch, not the current one's).
 */

import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG } from "./config.ts";
import { selectModel } from "./model.ts";
import { SUMMARY_SYSTEM, summaryRequest } from "./prompts.ts";
import { buildTranscript, type TranscriptEntry } from "./transcript.ts";

export type SummaryOutcome = { ok: true; text: string } | { ok: false; reason: string };

/** Flattened spend from the summary call, for the `usage:spend` channel — the
 * same shape recap announces. A summary is a real model call that leaves no
 * usage anywhere in the session, so without this it is spend nothing can see. */
export type SpendReport = { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; cost: number };

type ModelLike = { readonly id: string; readonly name?: string; readonly provider: string; readonly contextWindow: number };

export async function summarize(
	ctx: ExtensionContext,
	entries: TranscriptEntry[],
	agentDir: string,
	signal?: AbortSignal,
	onSpend?: (spend: SpendReport) => void,
): Promise<SummaryOutcome> {
	const all = ctx.modelRegistry.getAll() as unknown as ModelLike[];
	const selected = selectModel(undefined, ctx.model as ModelLike | undefined, all, agentDir);
	if (!selected.ok) return { ok: false, reason: selected.error };
	const model = selected.model;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model as never);
	if (!auth.ok) return { ok: false, reason: auth.error };

	const budgetChars = Math.floor(model.contextWindow * CONFIG.summaryTranscriptFraction * CONFIG.charsPerToken);
	const transcript = buildTranscript(entries, budgetChars);
	if (transcript.text.trim().length === 0) return { ok: false, reason: "the referenced session has no conversation to summarise" };

	try {
		const response = await completeSimple(
			model as never,
			{
				systemPrompt: SUMMARY_SYSTEM,
				messages: [{ role: "user", content: [{ type: "text", text: summaryRequest(transcript.text) }], timestamp: Date.now() }],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				signal,
				timeoutMs: CONFIG.summaryTimeoutMs,
				// A summary earns nothing from thinking; "minimal" is the cheapest pi exposes.
				reasoning: "minimal",
			},
		);

		// Before the outcome is decided: an errored or empty response was still
		// billed for whatever it consumed.
		onSpend?.({
			input: response.usage?.input ?? 0,
			output: response.usage?.output ?? 0,
			cacheRead: response.usage?.cacheRead ?? 0,
			cacheWrite: response.usage?.cacheWrite ?? 0,
			reasoning: response.usage?.reasoning ?? 0,
			cost: response.usage?.cost?.total ?? 0,
		});

		const text = response.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();

		return text.length > 0 ? { ok: true, text } : { ok: false, reason: "the summariser returned nothing" };
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
}
