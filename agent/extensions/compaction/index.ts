/**
 * compaction — write the compaction summary with a cheaper model.
 *
 * pi writes the summary with the session model at the session thinking level,
 * and it sends that request with no prompt cache. On gpt-6-astra at xhigh, one
 * compaction cost $2.8-6.4. A summary is mostly transcription, so this sends
 * the same request to MODEL at THINKING instead.
 *
 * It calls pi's own exported compact(), so the summary prompt, the split-turn
 * prefix, and the read/modified file lists stay pi's code. An extension cannot
 * reach pi's retry settings, so this call has no retry. Every failure returns
 * undefined, and pi then runs its built-in compaction as if this were absent.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { compact, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MODEL = { provider: "openai-codex", id: "gpt-6.1-sol" };
const THINKING: ThinkingLevel = "medium";

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const model = ctx.modelRegistry.find(MODEL.provider, MODEL.id);
		if (!model) return undefined;
		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) return undefined;
			const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
			const compaction = await compact(
				event.preparation,
				requestModel,
				auth.apiKey,
				// pi marks a removed header with null; it drops those the same way.
				auth.headers
					? (Object.fromEntries(Object.entries(auth.headers).filter((entry) => entry[1] !== null)) as Record<string, string>)
					: undefined,
				event.customInstructions,
				event.signal,
				THINKING,
				undefined,
				auth.env,
			);
			return { compaction };
		} catch (error) {
			if (!event.signal.aborted) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`${MODEL.id} compaction failed (${message}); using the session model`, "warning");
			}
			return undefined;
		}
	});
}
