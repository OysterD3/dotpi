/**
 * The recap generation call.
 *
 * A tool-less LLM call over a flattened transcript, mirroring how the goal
 * evaluator is built. Claude Code's recap generator (`Zin`) returns one of a
 * small set of outcomes; the same set is reproduced here so callers can phrase
 * Claude Code's exact messages ("Nothing to recap yet…", "Recap cancelled.").
 */

import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG } from "./config.ts";
import { resolveModel } from "./model.ts";
import { RECAP_SYSTEM, recapRequest } from "./prompts.ts";
import { loadSettings } from "./settings.ts";
import { buildTranscript, type TranscriptEntry } from "./transcript.ts";

export type RecapOutcome =
	| { kind: "ok"; text: string }
	| { kind: "no-turn" }
	| { kind: "aborted" }
	| { kind: "failed"; reason: string };

type ModelLike = { readonly id: string; readonly name?: string; readonly provider: string; readonly contextWindow: number };

export type GenerateOptions = {
	agentDir: string;
	/** Manual `/recap` gets the longer timeout; auto-on-return the shorter one. */
	timeoutMs?: number;
	signal?: AbortSignal;
};

/**
 * Produce a recap of the current session, or explain why one could not be made.
 *
 * Model selection: the configured `recap.model` if set and resolvable, otherwise
 * the active session model — the same fallback the goal evaluator uses.
 */
export async function generateRecap(ctx: ExtensionContext, options: GenerateOptions): Promise<RecapOutcome> {
	const { settings } = loadSettings(options.agentDir, ctx.cwd, ctx.isProjectTrusted());

	let model = ctx.model as ModelLike | undefined;
	if (settings.model) {
		const all = ctx.modelRegistry.getAll() as unknown as ModelLike[];
		const resolved = resolveModel(settings.model, all);
		if (!resolved.ok) return { kind: "failed", reason: resolved.error };
		model = resolved.model;
	}
	if (!model) return { kind: "failed", reason: "no model selected" };

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model as never);
	if (!auth.ok) return { kind: "failed", reason: auth.error };

	const entries = ctx.sessionManager.getBranch() as TranscriptEntry[];
	const transcript = buildTranscript(entries, model.contextWindow);
	if (transcript.text.trim().length === 0) return { kind: "no-turn" };

	try {
		const response = await completeSimple(
			model as never,
			{
				systemPrompt: RECAP_SYSTEM,
				messages: [{ role: "user", content: [{ type: "text", text: recapRequest(transcript.text) }], timestamp: Date.now() }],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				signal: options.signal,
				timeoutMs: options.timeoutMs ?? CONFIG.timeoutMs,
				// Claude Code disables thinking for this call; "minimal" is the cheapest pi exposes.
				reasoning: "minimal",
			},
		);

		const text = response.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();

		return text.length > 0 ? { kind: "ok", text } : { kind: "failed", reason: "empty recap" };
	} catch (error) {
		if (options.signal?.aborted) return { kind: "aborted" };
		return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
	}
}
