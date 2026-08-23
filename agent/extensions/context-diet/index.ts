/**
 * context-diet — stop a long turn from paying for context it stopped reading.
 *
 * pi checks whether to compact in exactly two places: after `agent_end`, and
 * before a new prompt. Both are turn boundaries. Inside a turn — however many
 * hundred tool calls it runs — `shouldCompact()` is never reached, so the
 * threshold does nothing and context grows until the provider refuses the
 * request. A session measured before this extension existed ran one turn for
 * 2h44m across 399 model calls: context climbed to 375k against a 272k window,
 * compaction fired only when the API returned "your input exceeds the context
 * window", and a second round fired at `agent_end` after the work was already
 * finished, then went unread.
 *
 * The cost of that is not the compaction. It is that 219 of the 397 calls sat
 * above 272k, where the gpt-5.6 family doubles every rate — $5→$10 per Mtok in,
 * $0.50→$1.00 cached — turning $41 of that session's $126 into surcharge on
 * context nobody was reading.
 *
 * So: trim what gets *sent*, per call, and leave the turn alone. The `context`
 * hook runs on every LLM call inside the loop and rewrites only the copy bound
 * for the provider — `context.messages`, the session and the JSONL are all
 * untouched, so /compact, /rewind, fork and tree navigation still see the full
 * history. Nothing is aborted, which is what rules out the obvious alternative:
 * `ctx.compact()` exists and can be called mid-turn, but it opens with
 * `await this.abort()`, and killing a 2.7-hour harness run to save tokens is
 * not a trade worth making.
 *
 * What gets dropped and why is in diet.ts; how the choice carries across calls
 * is in session.ts. The one thing worth repeating here is that evictions are
 * permanent for the session and their stubs never change, because the prompt
 * cache invalidates from the first byte that differs. A diet that re-decided
 * each call would move that byte every call and bill the whole context at the
 * uncached rate — ten times what it costs cached, and strictly worse than doing
 * nothing at all.
 *
 * Reaches the main session only. Workflow subagents and `subagents` tasks spawn
 * with --no-extensions, and they are not the problem: in the measured session
 * 270 subagent calls cost $5.35 between them, because each one starts empty.
 *
 * Two gaps the same forensics traced, both closed here:
 *
 *   - Escalation. The measured session hit six rounds, ~100k tokens dropped
 *     apiece, and never knew it: every stub says "re-run the tool if you
 *     still need it", which reads as permission to read right back into a
 *     window that is about to fill up again, and the turn eventually hit the
 *     provider's own "input exceeds the context window" error — the failure
 *     `highWaterRatio` exists to pre-empt, except it cannot once the model
 *     keeps re-opening what a round just dropped. Past `escalateAfterRounds`
 *     rounds in one turn, the model is told directly, once, and an attended
 *     user gets the same news as a ctx.ui.notify warning rather than a muted
 *     transcript line.
 *   - Pinning. Other extensions can protect a specific result from every
 *     eviction rule — including the keepImages sweep, which only spares the
 *     newest few screenshots — by emitting `pi.events.emit("context-diet:pin",
 *     { toolCallId })`. The motivating case is a reference mockup the agent
 *     is meant to keep matching against for the whole session: it is old by
 *     construction, so age-based protection can never cover it, and it must
 *     outlive the agent's own newer (and by then more numerous) screenshots
 *     of its own work.
 *
 * Settings (agent settings.json), under "contextDiet":
 *   enabled              boolean, default true
 *   highWaterRatio       number, default 0.8   — fraction of the window that triggers a round
 *   targetRatio          number, default 0.55  — fraction a round trims down to
 *   highWaterTokens      number, default 0     — absolute override for the above
 *   targetTokens         number, default 0
 *   keepRecentResults    number, default 24    — newest results never touched
 *   keepImages           number, default 3     — newest screenshots never touched
 *   minResultBytes       number, default 512   — below this a stub would not pay
 *   dropOldReasoning     boolean, default false — EXPERIMENTAL; rounds also strip old
 *                        thinking blocks. May be rejected by the Responses API
 *                        (see config.ts); validate on one live session first
 *   keepRecentReasoning  number, default 10    — newest assistant messages keep theirs
 *   escalateAfterRounds  number, default 3     — rounds fired in one turn before the model is told to change strategy; 0 = off
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type DietSettings, ENTRY_TYPE, resolveSettings, SETTINGS_KEY } from "./config.ts";
import { type DietEntry, escalationNotice, escalationReminder } from "./diet.ts";
import { renderDiet } from "./render.ts";
import { createDiet } from "./session.ts";

/**
 * Consumer side of a pi.events channel a producer extension emits on to
 * protect one tool result from every diet eviction rule for the rest of the
 * session — payload `{ toolCallId }`. A literal string, not a shared import,
 * the same contract shape as goal's SPEND_CHANNEL: each side installs on its
 * own, and with no producer registered the channel simply goes unused.
 */
const PIN_CHANNEL = "context-diet:pin";

/** Hidden follow-up carrying the escalation reminder. Never rendered — see escalationReminder() in diet.ts. */
const ESCALATION_MESSAGE = "context-diet-escalation";

export function loadSettings(agentDir: string): DietSettings {
	try {
		const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		return resolveSettings(raw?.[SETTINGS_KEY]);
	} catch {
		return resolveSettings(undefined);
	}
}

export default function (pi: ExtensionAPI) {
	const settings = loadSettings(getAgentDir());
	if (!settings.enabled) return;

	const diet = createDiet(settings);

	// Guards turnBoundary() against firing on a retry or a queued continuation
	// that re-enter the SAME run — agent-loop.js's runAgentLoopContinue emits
	// its own agent_start for those, same as the plain retry path. Identical
	// guard to the elapsed extension's `startedAt`, and for the same reason:
	// only a run's FIRST agent_start marks the start of what this extension
	// calls "a turn"; every later one inside the same run is a continuation of
	// it, not a fresh one, and must not reset a count that exists specifically
	// to catch a single turn running long.
	let turnActive = false;

	pi.registerEntryRenderer<DietEntry>(ENTRY_TYPE, (entry, _options, theme) => (entry.data ? renderDiet(entry.data, theme) : undefined));

	// Cleared whenever the message list underneath is replaced wholesale: a
	// toolCallId from the old branch means nothing on the new one. After a
	// compaction the dropped results are gone from context outright and the
	// summary that replaced them is small, so the count starts over there too
	// — round counters and the pin set included, since a toolCallId pinned or
	// counted against the old branch describes nothing on the new one either.
	const reset = () => {
		diet.reset();
		turnActive = false;
	};
	pi.on("session_start", reset);
	pi.on("session_before_switch", reset);
	pi.on("session_before_fork", reset);
	pi.on("session_before_tree", reset);
	pi.on("session_compact", reset);

	pi.on("agent_start", () => {
		if (turnActive) return;
		turnActive = true;
		diet.turnBoundary();
	});
	pi.on("agent_settled", () => {
		turnActive = false;
	});

	// Producer side lives wherever another extension calls pi.events.emit on
	// this same channel name — pi.events has no schema to enforce, so a
	// malformed or foreign payload is ignored rather than thrown.
	pi.events.on(PIN_CHANNEL, (data) => {
		const toolCallId = (data as { toolCallId?: unknown } | null)?.toolCallId;
		if (typeof toolCallId === "string" && toolCallId.length > 0) diet.pin(toolCallId);
	});

	pi.on("context", (event, ctx) => {
		const step = diet.step({
			messages: event.messages,
			contextWindow: ctx.model?.contextWindow ?? 0,
			reportedTokens: ctx.getContextUsage()?.tokens,
		});
		if (step.entry) pi.appendEntry<DietEntry>(ENTRY_TYPE, step.entry);

		if (step.escalation) {
			// deliverAs "steer", not "followUp": followUp only drains once the
			// model stops calling tools on its own (agent-loop.js's runLoop checks
			// the followUp queue only when hasMoreToolCalls is false), which is
			// exactly the behaviour this reminder exists to interrupt — a turn
			// that never stops calling tools would never see it. "steer" is
			// polled every round, right after the current round's tool results
			// and before the next LLM call, which is the earliest the model can
			// act on it and lines up with where the round that triggered this
			// just landed.
			pi.sendMessage(
				{
					customType: ESCALATION_MESSAGE,
					content: escalationReminder(step.escalation.roundsThisTurn, step.escalation.tokensThisTurn),
					display: false,
				},
				ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "steer" },
			);
			ctx.ui.notify(escalationNotice(step.escalation.roundsThisTurn, step.escalation.tokensThisTurn), "warning");
		}

		return step.messages ? { messages: step.messages } : undefined;
	});
}
