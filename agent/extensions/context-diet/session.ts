/**
 * The stateful half: one diet per session, holding the set of results it has
 * already dropped.
 *
 * Separated from the wiring so the behaviour that only shows up *across* calls
 * can be tested — that a round runs once and not again on the next call, that a
 * dropped result stays dropped even when the context later sits well under the
 * threshold, and that the transcript entry appears only on the calls where a
 * round actually happened. None of that is visible from a single invocation.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { DietSettings } from "./config.ts";
import { applyDiet, type DietEntry, estimateMessagesTokens, type EvictionRecord, planDiet } from "./diet.ts";

export interface DietStep {
	/** Messages to send in place of the originals. Absent means "leave the request alone". */
	messages?: AgentMessage[];
	/** Present only on the calls where a round ran. */
	entry?: DietEntry;
}

export interface Diet {
	/** How many results are currently being stubbed. */
	readonly size: number;
	/** Forget everything, for when the message list underneath is replaced wholesale. */
	reset(): void;
	/** The stubbed view as it stands, deciding nothing. For measuring what the set already saves. */
	view(messages: readonly AgentMessage[]): AgentMessage[];
	step(args: { messages: readonly AgentMessage[]; contextWindow: number; reportedTokens?: number | null }): DietStep;
}

export function createDiet(settings: DietSettings): Diet {
	const evicted = new Map<string, EvictionRecord>();

	return {
		get size() {
			return evicted.size;
		},

		reset() {
			evicted.clear();
		},

		view(messages) {
			return applyDiet(messages, evicted);
		},

		step({ messages, contextWindow, reportedTokens }) {
			if (contextWindow <= 0) return {};

			/**
			 * pi's reported figure is anchored on the last usage the provider actually
			 * billed and extended with a local estimate for whatever arrived since. Once
			 * a round has run, that anchor is the *trimmed* size — so the number
			 * self-corrects every response and never drifts against the real context.
			 * It is null only between a compaction and the next response, and the local
			 * fallback used there reads low by the system prompt and tool schemas, which
			 * is harmless at a point in the session that is nowhere near the threshold.
			 */
			const currentTokens = reportedTokens ?? estimateMessagesTokens(applyDiet(messages, evicted));

			const plan = planDiet({ messages, evicted, currentTokens, contextWindow, settings });
			let entry: DietEntry | undefined;
			if (plan) {
				for (const record of plan.records) evicted.set(record.toolCallId, record);
				entry = { dropped: plan.records.length, fromTokens: plan.fromTokens, toTokens: plan.toTokens };
			}

			if (evicted.size === 0) return {};
			return { messages: applyDiet(messages, evicted), entry };
		},
	};
}
