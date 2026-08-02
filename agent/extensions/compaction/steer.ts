/**
 * The steering decision, with pi's compact() injected so it can be tested
 * without a provider.
 *
 * Every branch that is not "we produced a summary" returns undefined, and
 * undefined means pi runs its own built-in compaction. That is the contract the
 * tests hold this to: there is no failure mode here that leaves a session
 * un-compacted, because compaction fires when the context is nearly full.
 */

import type { CompactionSettings } from "./config.ts";
import { compactionInstructions } from "./instructions.ts";

/** The subset of pi's compact() signature this uses, positionally. */
export type CompactFn = (
	preparation: unknown,
	model: unknown,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	customInstructions: string | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: string | undefined,
	streamFn: undefined,
	env: Record<string, string> | undefined,
) => Promise<unknown>;

/** The parts of SessionBeforeCompactEvent that matter here. */
export interface SteerEvent {
	preparation: unknown;
	customInstructions?: string;
	signal: AbortSignal;
}

/** The parts of ExtensionContext that matter here. */
export interface SteerContext {
	model: unknown;
	modelRegistry: {
		getApiKeyAndHeaders(model: unknown): Promise<
			| { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
			| { ok: false; error?: string }
		>;
	};
}

/** Only the two fields the call actually reads — the thresholds are not its business. */
export type SteerSettings = Pick<CompactionSettings, "thinking" | "maxWords">;

export async function steerCompaction(
	event: SteerEvent,
	ctx: SteerContext,
	settings: SteerSettings,
	compactFn: CompactFn,
): Promise<{ compaction: unknown } | undefined> {
	// No model means no call to make; pi is in the same position and reports it.
	if (!ctx.model) return undefined;

	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok) return undefined;

		const compaction = await compactFn(
			event.preparation,
			ctx.model,
			auth.apiKey,
			auth.headers,
			compactionInstructions(settings.maxWords, event.customInstructions),
			event.signal,
			// The point of the exercise: the configured level, NOT the session's.
			settings.thinking,
			undefined,
			auth.env,
		);

		// An aborted compaction can still resolve. Handing pi a summary it asked
		// to cancel would write it into the session anyway.
		if (event.signal.aborted) return undefined;
		if (!compaction) return undefined;
		return { compaction };
	} catch {
		// Deliberately silent. pi is about to do this itself, and a notify would
		// fire at the exact moment the user is watching a context-limit recovery
		// they never asked about.
		return undefined;
	}
}
