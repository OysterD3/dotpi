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
 * The way back from a stub is the `recall` tool (recall.ts), not re-running:
 * a stub names its toolCallId, and recall returns the stored body from the
 * session branch by that id — every original is still there, because this
 * hook only ever rewrites the provider-bound copy, and getBranch() is the raw
 * root→leaf walk, so a result older than a compaction can still be recalled.
 * Re-running was wrong twice over: a bash call repeats whatever it did, and a
 * read returns the file as it is now, not as the model was reasoning about
 * it. Recall is precise, but what it returns re-enters context as a new
 * result and is evicted like any other — which is why the escalation below
 * still stands.
 *
 * The set lives in memory, and that was a hole. pi emits session_start on
 * every process start, resume and reload; the handler reset the set and
 * nothing rebuilt it. The next call then anchored on the last billed figure
 * — the *trimmed* size, under the high-water mark — so no round fired and
 * the hook passed the full history through. Two real sessions did exactly
 * that on the first call after a resume, sending ~837k and ~565k tokens and
 * getting "Your input exceeds the context window" back: the failure this
 * extension exists to prevent, caused by its own state loss. Each round
 * entry now records its decisions, and session_start / session_tree rebuild
 * the set from the branch (session.ts restore()). Rounds written before the
 * field existed cannot be rebuilt; they make the first call distrust the
 * billed anchor once and measure the raw history instead.
 *
 * Two gaps the same forensics traced, both closed here:
 *
 *   - Escalation. The measured session hit six rounds, ~100k tokens dropped
 *     apiece, and never knew it: every stub says how to get its body back,
 *     which reads as permission to read right back into a window that is
 *     about to fill up again, and the turn eventually hit the provider's own
 *     "input exceeds the context window" error — the failure `highWaterRatio`
 *     exists to pre-empt, except it cannot once the model keeps re-opening
 *     what a round just dropped. Past `escalateAfterRounds` EVICTION rounds in
 *     one turn, the model is told directly, once, and an attended user gets
 *     the same news as a ctx.ui.notify warning rather than a muted transcript
 *     line.
 *
 *     Both halves of that sentence were wrong once, and together they put
 *     unexplained "Understood." replies in the transcript.
 *
 *     It counted every round, and with `dropOldReasoning` on a round fires on
 *     every single call once the context is over the mark — each call appends
 *     one assistant message, which pushes exactly one more out of the
 *     `keepRecentReasoning` window, so the sweep always has one new key. The
 *     threshold was therefore reached three calls after crossing the mark, on
 *     every long turn, and told a model that had re-read nothing that it was
 *     reading too fast. Only rounds that actually evict now count (see
 *     evictionRoundsThisTurn in session.ts).
 *
 *     And it was SENT from the `context` hook, which is inside a model call.
 *     A steering message enqueued during a turn's last call is not consumed by
 *     that call: agent-loop.js drains the steer queue after every turn and
 *     re-enters on `while (hasMoreToolCalls || pendingMessages.length > 0)`,
 *     so a turn that was finishing ran one extra assistant call carrying
 *     nothing but this reminder — which arrives as a plain user message, since
 *     custom messages convert to role "user". The model answered it, and
 *     because the reminder is display: false the user saw a reply to nothing.
 *     It is now armed in the hook and delivered from the next `tool_call`,
 *     which is the only moment that proves the turn is still going.
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
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type DietSettings, ENTRY_TYPE, resolveSettings, SETTINGS_KEY } from "./config.ts";
import { type DietEntry, dietRounds, escalationNotice, escalationReminder } from "./diet.ts";
import { RECALL_TOOL, recallResult } from "./recall.ts";
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

	// The way back from a stub. Reads the session branch, not the context the
	// hook below is trimming, so the body comes back whole and nothing re-runs.
	pi.registerTool({
		name: RECALL_TOOL,
		label: "Recall",
		description:
			"Return the full original output of a tool result that was dropped from context and replaced by a one-line " +
			"stub. Pass the id the stub names. The result is read back from this session exactly as it was; nothing is re-run.",
		parameters: Type.Object({
			id: Type.String({ description: "The tool call id named in the stub" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return recallResult(ctx.sessionManager.getBranch(), params.id);
		},
	});

	// Guards turnBoundary() against firing on a retry or a queued continuation
	// that re-enter the SAME run — agent-loop.js's runAgentLoopContinue emits
	// its own agent_start for those, same as the plain retry path. Identical
	// guard to the elapsed extension's `startedAt`, and for the same reason:
	// only a run's FIRST agent_start marks the start of what this extension
	// calls "a turn"; every later one inside the same run is a continuation of
	// it, not a fresh one, and must not reset a count that exists specifically
	// to catch a single turn running long.
	let turnActive = false;

	/**
	 * The escalation, decided but not yet sent.
	 *
	 * It used to be sent from inside the `context` hook, and that is what put
	 * bare "Understood." replies in the transcript. A steering message enqueued
	 * during a turn's LAST model call is not consumed by that call: the loop
	 * drains the steer queue after every turn and re-enters on
	 * `while (hasMoreToolCalls || pendingMessages.length > 0)` — so a turn that
	 * was finishing ran one EXTRA assistant call whose only new input was this
	 * reminder, which reaches the model as a plain user message (custom
	 * messages convert to role "user"). The model answered it, and because the
	 * reminder is display: false the user saw an assistant message replying to
	 * nothing.
	 *
	 * So it is armed here and sent from the next tool_call instead. A tool call
	 * proves the turn is continuing and guarantees another model call after it,
	 * which is where a steer belongs and the only place this reminder was ever
	 * meant to land — the turn it exists to interrupt is by definition one that
	 * keeps calling tools. A turn that ends first sends nothing: it stopped,
	 * which is the outcome the reminder was asking for.
	 */
	let armed: { roundsThisTurn: number; tokensThisTurn: number } | undefined;

	pi.registerEntryRenderer<DietEntry>(ENTRY_TYPE, (entry, _options, theme) => (entry.data ? renderDiet(entry.data, theme) : undefined));

	// Cleared whenever the message list underneath has been replaced wholesale:
	// a toolCallId from the old branch means nothing on the new one. After a
	// compaction the dropped results are gone from context outright and the
	// summary that replaced them is small, so the count starts over there too
	// — round counters and the pin set included, since a toolCallId pinned or
	// counted against the old branch describes nothing on the new one either.
	const reset = () => {
		diet.reset();
		turnActive = false;
		armed = undefined;
	};
	// ...and rebuilt from the new list once it is in place. The set is
	// memory-only, and session_start fires on every process start, resume and
	// reload — a reset with no rebuild is how two real sessions sent their
	// whole untrimmed history on the first call after a resume (see the
	// header). The branch carries every round's decisions, so the set comes
	// back exactly as it was and the stubs stay byte-identical.
	//
	// Bound to the events that fire AFTER the change — session_start follows a
	// completed switch, fork, /new, resume or reload, session_tree a completed
	// tree move — never to the session_before_* ones: those fire before the
	// user can still cancel, and a reset there with no rebuild behind it left
	// a cancelled switch with an empty set over an unchanged, untrimmed list.
	const restore = (_event: unknown, ctx: ExtensionContext) => {
		reset();
		diet.restore(dietRounds(ctx.sessionManager.getBranch()));
	};
	pi.on("session_start", restore);
	pi.on("session_tree", restore);
	pi.on("session_compact", reset);

	pi.on("agent_start", () => {
		if (turnActive) return;
		turnActive = true;
		// Disarmed with the counters it was derived from: "trimmed 3 times this
		// turn" is a claim about the turn that has just ended, and delivering it
		// into the next one would be false as well as unexplained.
		armed = undefined;
		diet.turnBoundary();
	});
	pi.on("agent_settled", () => {
		turnActive = false;
		armed = undefined;
	});

	// The delivery gate. Reached only while the turn is still calling tools, so
	// the steer lands before the next model call rather than forcing one.
	pi.on("tool_call", (_event, ctx) => {
		if (!armed) return;
		const { roundsThisTurn, tokensThisTurn } = armed;
		armed = undefined;
		// "steer", not "followUp": followUp only drains once the model stops
		// calling tools on its own (agent-loop.js's runLoop checks that queue
		// only when hasMoreToolCalls is false), which is exactly the behaviour
		// this reminder exists to interrupt — a turn that never stops calling
		// tools would never see it. No triggerTurn branch either: a tool call is
		// mid-turn by construction, so the idle case cannot arise here.
		pi.sendMessage(
			{ customType: ESCALATION_MESSAGE, content: escalationReminder(roundsThisTurn, tokensThisTurn), display: false },
			{ deliverAs: "steer" },
		);
		// Notified here rather than where the round fired, so the line the user
		// reads ("Told the model to change strategy") is only ever printed when
		// the model was actually told.
		ctx.ui.notify(escalationNotice(roundsThisTurn, tokensThisTurn), "warning");
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

		// Armed, not sent — see `armed` above for what sending from in here did.
		if (step.escalation) armed = step.escalation;

		return step.messages ? { messages: step.messages } : undefined;
	});
}
