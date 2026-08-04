/**
 * The stateful half: one diet per session, holding the set of results it has
 * already dropped — and, when `dropOldReasoning` is on, the set of assistant
 * messages whose thinking blocks it has stripped.
 *
 * Separated from the wiring so the behaviour that only shows up *across* calls
 * can be tested — that a round runs once and not again on the next call, that a
 * dropped result stays dropped even when the context later sits well under the
 * threshold, and that the transcript entry appears only on the calls where a
 * round actually happened. None of that is visible from a single invocation.
 *
 * Two more pieces of cross-call state live here for the same reason:
 *
 *   - round counters, so `step()` can tell index.ts "this is the Nth round
 *     this turn" without index.ts re-deriving it from transcript entries.
 *     `turnBoundary()` resets the per-turn half; a caller decides when a turn
 *     truly starts (see index.ts's agent_start/agent_settled guard) — this
 *     module only holds the counters, not the event wiring.
 *   - the pin set, keyed by toolCallId, so a result another extension marked
 *     as protected (via the "context-diet:pin" channel) is excluded from
 *     collectCandidates the same way an already-evicted one is.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { CONFIG, type DietSettings } from "./config.ts";
import {
	applyDiet,
	collectReasoningDrops,
	type DietEntry,
	estimateMessagesTokens,
	type EvictionRecord,
	planDiet,
	resolveBounds,
} from "./diet.ts";

export interface DietStep {
	/** Messages to send in place of the originals. Absent means "leave the request alone". */
	messages?: AgentMessage[];
	/** Present only on the calls where a round ran. */
	entry?: DietEntry;
	/**
	 * Present on the one round per turn where roundsThisTurn first reaches
	 * `escalateAfterRounds`. index.ts turns this into the hidden follow-up and
	 * the ctx.ui.notify warning; this module only decides *when*, once, per
	 * turn — see escalatedThisTurn below.
	 */
	escalation?: { roundsThisTurn: number; tokensThisTurn: number };
}

export interface Diet {
	/** How many results are currently being stubbed. */
	readonly size: number;
	/** How many results other extensions have pinned against eviction. */
	readonly pinnedSize: number;
	/** Diet rounds that have fired since the last turnBoundary(). */
	readonly roundsThisTurn: number;
	/** Diet rounds that have fired for the life of this session. */
	readonly roundsThisSession: number;
	/** Forget everything, for when the message list underneath is replaced wholesale. */
	reset(): void;
	/** Zero the per-turn counters and the escalation latch. Call on a genuine turn boundary. */
	turnBoundary(): void;
	/**
	 * Protect a tool result from every eviction rule, including the keepImages
	 * sweep, until reset() clears it. Capped at CONFIG.maxPinned: past the cap
	 * the oldest pin is dropped from this SET (it can be evicted again), never
	 * from context — pinning something new must not un-pin something already
	 * relied on without at least aging out first.
	 */
	pin(toolCallId: string): void;
	/** The stubbed view as it stands, deciding nothing. For measuring what the set already saves. */
	view(messages: readonly AgentMessage[]): AgentMessage[];
	step(args: { messages: readonly AgentMessage[]; contextWindow: number; reportedTokens?: number | null }): DietStep;
}

export function createDiet(settings: DietSettings): Diet {
	const evicted = new Map<string, EvictionRecord>();
	const reasoningDropped = new Set<string>();
	// Insertion-ordered so the oldest pin is the one the cap evicts first —
	// a Map (not a Set) purely to get that ordering with an O(1) "oldest key".
	const pinned = new Map<string, true>();

	let roundsThisTurn = 0;
	let roundsThisSession = 0;
	let tokensThisTurn = 0;
	// Latches the escalation so a turn that keeps firing rounds past the
	// threshold gets the reminder once, not on every subsequent round — the
	// model needs to be told a pattern is happening, not reminded every call
	// that it still is.
	let escalatedThisTurn = false;

	return {
		get size() {
			return evicted.size;
		},
		get pinnedSize() {
			return pinned.size;
		},
		get roundsThisTurn() {
			return roundsThisTurn;
		},
		get roundsThisSession() {
			return roundsThisSession;
		},

		reset() {
			evicted.clear();
			reasoningDropped.clear();
			pinned.clear();
			roundsThisTurn = 0;
			roundsThisSession = 0;
			tokensThisTurn = 0;
			escalatedThisTurn = false;
		},

		turnBoundary() {
			roundsThisTurn = 0;
			tokensThisTurn = 0;
			escalatedThisTurn = false;
		},

		pin(toolCallId) {
			if (pinned.has(toolCallId)) return;
			if (pinned.size >= CONFIG.maxPinned) {
				const oldest = pinned.keys().next().value;
				if (oldest !== undefined) pinned.delete(oldest);
			}
			pinned.set(toolCallId, true);
		},

		view(messages) {
			return applyDiet(messages, evicted, reasoningDropped);
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
			const currentTokens = reportedTokens ?? estimateMessagesTokens(applyDiet(messages, evicted, reasoningDropped));

			const plan = planDiet({ messages, evicted, currentTokens, contextWindow, settings, pinned: new Set(pinned.keys()) });

			// Reasoning rides along on any round, and can carry one alone when the
			// results have nothing left to give — over the mark with every old body
			// already stubbed, stripping reasoning is the only lever remaining.
			let reasoning: { keys: string[]; savedTokens: number } | undefined;
			if (settings.dropOldReasoning && currentTokens > resolveBounds(contextWindow, settings).highWater) {
				const drops = collectReasoningDrops(messages, reasoningDropped, settings.keepRecentReasoning);
				if (drops.keys.length > 0) reasoning = drops;
			}

			let entry: DietEntry | undefined;
			let escalation: DietStep["escalation"];
			if (plan || reasoning) {
				for (const record of plan?.records ?? []) evicted.set(record.toolCallId, record);
				for (const key of reasoning?.keys ?? []) reasoningDropped.add(key);
				const fromTokens = plan?.fromTokens ?? currentTokens;
				const toTokens = (plan?.toTokens ?? currentTokens) - (reasoning?.savedTokens ?? 0);
				entry = {
					dropped: plan?.records.length ?? 0,
					fromTokens,
					toTokens,
					...(reasoning ? { reasoningDropped: reasoning.keys.length } : {}),
				};

				// A round just fired: count it against both budgets before deciding
				// whether this turn has earned the escalation reminder.
				roundsThisTurn++;
				roundsThisSession++;
				tokensThisTurn += Math.max(0, fromTokens - toTokens);

				if (settings.escalateAfterRounds > 0 && roundsThisTurn >= settings.escalateAfterRounds && !escalatedThisTurn) {
					escalatedThisTurn = true;
					escalation = { roundsThisTurn, tokensThisTurn };
				}
			}

			if (evicted.size === 0 && reasoningDropped.size === 0) return {};
			return { messages: applyDiet(messages, evicted, reasoningDropped), entry, ...(escalation ? { escalation } : {}) };
		},
	};
}
