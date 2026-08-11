/**
 * ask-user — a structured question tool for the main agent.
 *
 * Gives the main agent an `ask_user` tool to pause and put decisions back to the
 * human: up to four questions at once, each with 2-4 suggested options plus a
 * free-text row, any answer annotatable with a note, and a review step before
 * anything is sent.
 *
 * This needs a bespoke component with in-component key bindings. pi's
 * select/input/confirm dialogs cannot bind keys inside themselves, so this uses
 * `ctx.ui.custom()`: a focused component (prompt.ts) over a pure state machine
 * (interaction.ts). That is what makes Tab-to-annotate and ← / → possible at
 * all — as dialogs, each would have to become another modal prompt. The
 * component stands in for the editor while it is up, so the question arrives
 * where the answer would have been typed.
 *
 * Offering the tool is not enough to get it used: the description, the snippet
 * and the guidelines all sit in the cached prefix, read long before there is a
 * request to apply them to. nudge.ts supplies the missing half — on the turn a
 * request that opens new work arrives, a hidden reminder rides in with it and
 * says to settle the open decisions now, or to state the assumption and start.
 *
 * The opening nudge only fires once, though, and a model that reads past it
 * anyway is left with no other checkpoint — which is exactly what happened in
 * the benchmark this closes a gap for: ten hours and $93 built on a guessed
 * data source, with ask_user never called once. So a second reminder watches
 * tool_call for actual cost being spent (write/edit calls) rather than time
 * passing, and speaks up once CONFIG.followUp.afterMutations distinct files
 * have been touched with no ask_user call in between. See nudge.ts for the
 * wording and the rationale, and the tool_call handler below for the set and
 * latch.
 *
 * There is no off switch, by design. Asking when the decision is genuinely
 * the user's is behaviour, not a preference, and a knob for it is only ever a
 * way back to a tool that exists and goes unused. The one condition is that
 * somebody is there to answer: in a headless run (`-p`, an `--mode json`
 * subagent) `ctx.hasUI` is false, the tool is not offered, and the opening
 * nudge stays quiet — a fact about the session, not a choice about it.
 *
 * There is one narrow settings block (settings.ts, `askUser.contractModels`),
 * and it does not compromise that: it never silences the nudge, it only picks
 * which of two always-on wordings a matched model gets. style.ts resolves
 * that choice — "socratic" (OPENING_NUDGE, the original wording) or
 * "contract" (CONTRACT_NUDGE, unconditional and artifact-bearing) — fresh
 * from `ctx.model` at the one point below that actually sends a nudge, never
 * cached, so a model_select mid-session changes the wording on the very next
 * nudge rather than waiting for a new session. Everywhere else — enforcement,
 * compliance detection — keys off `deliveredStyle`, the style that resolved
 * to, not a fresh re-read: the gate a model is answerable to is the one it
 * was actually sent, and a model swapped out mid-session must not desync that
 * from what its own turns are being graded against. See nudge.ts's header for
 * why a second wording exists at all: the benchmark gap it closes is specific
 * to models that do not respond to the judgment-call framing OPENING_NUDGE
 * relies on.
 *
 * Neither can turn anything off.
 */
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { CONFIG, FOLLOWUP_ENTRY_TYPE, NUDGE_ENTRY_TYPE, TOOL_NAME } from "./config.ts";
import {
	CONTRACT_NUDGE,
	contractFollowUpReminder,
	followUpReminder,
	hasAssumptionsBlock,
	OPENING_NUDGE,
	opensWork,
	systemReminder,
} from "./nudge.ts";
import { loadSettings } from "./settings.ts";
import { askStyle, type AskStyle } from "./style.ts";
import { registerAskUserTool } from "./tool.ts";

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	// The pattern list style.ts matches ctx.model against. Loaded once per
	// session_start (settings.json does not change mid-session), but the style
	// DECISION it feeds is never cached — see currentStyle below.
	let contractModelPatterns: readonly string[] = [];

	// Set on the input hook, consumed by before_agent_start on the same turn.
	let nudgeThisTurn = false;
	// Interactive turns since the last nudge went out. Infinity so the first
	// work-opening request of a session is never inside the cooldown.
	let turnsSinceNudge = Number.POSITIVE_INFINITY;

	// The style of the last nudge (or contract follow-up) actually DELIVERED
	// this session — undefined until the first one goes out. Enforcement and
	// compliance detection below key off this, not a fresh askStyle(ctx.model,
	// ...) read: the gate a model is following is whatever text it was
	// actually sent, and re-deriving from ctx.model at every check would
	// desync the moment the model changes mid-session (a model_select, or a
	// fallback after a rate limit) — a contract session would suddenly be
	// graded as socratic (or vice versa) for a gate it was never re-issued.
	// Only before_agent_start, which is what actually PICKS and sends the
	// wording, reads ctx.model fresh — see there for why. A model switch
	// before any nudge has gone out still resolves fresh, because this stays
	// undefined until that first delivery.
	let deliveredStyle: AskStyle | undefined = undefined;
	// Distinct files touched by write/edit tool calls since the last time
	// compliance was met — session-wide, not per turn, because a model that
	// keeps building across many turns without complying is precisely what
	// this counts. A Set, not a count of calls: five edits to one file is one
	// file still unchecked against the opening questions, and the follow-up
	// message says "N files" — it would be false to count tool calls and
	// print that word. Cleared by whatever counts as compliance for the
	// current style: an ask_user call (either style), or an ASSUMPTIONS block
	// (contract style only — see the message_end handler below).
	let mutatedFilesSinceAsk = new Set<string>();
	// Socratic style's one-shot-per-arming latch: true once the follow-up has
	// fired, so it does not repeat on every mutation after the first. Only
	// cleared on compliance (see the tool_call handler), same as the set
	// above. Contract style does not use this — see contractFollowUpsFired.
	let followUpDelivered = false;
	// Contract style's re-arming counter: how many times the follow-up has
	// fired since the last compliance, 0..CONFIG.followUp.maxFollowUps. Each
	// firing's threshold is the current arm's base (see
	// contractHasCompliedOnce below) plus CONFIG.followUp.rearmMutations per
	// prior firing (see the tool_call handler) — a schedule instead of
	// socratic's single latch, because the benchmark gap this closes is a
	// model that reads one reminder and keeps going regardless (nudge.ts's
	// header). Capped so a session that never complies gets a bounded number
	// of reminders, not one forever; reset alongside the set above on
	// compliance, so a session that goes quiet again after complying gets the
	// full budget back rather than being silenced for the rest of the run.
	let contractFollowUpsFired = 0;
	// Whether contract style has EVER registered compliance this session
	// (an ask_user call, or a printed ASSUMPTIONS block) — distinct from
	// contractFollowUpsFired, which resets on every compliance and so cannot
	// carry this. Before the first compliance, an arm's first firing is at
	// CONFIG.followUp.afterMutations, same as socratic. After it, EVERY arm's
	// first firing uses CONFIG.followUp.rearmMutations instead, forever —
	// afterMutations is a one-time grace period, not a threshold a compliant
	// model keeps getting handed back. Without this, markCompliant() resetting
	// contractFollowUpsFired to 0 would drop the next threshold back to
	// afterMutations (5) — LOWER than the intra-arming rearm step (15) — so a
	// model that dutifully complies gets nagged sooner, and more often, than
	// one that never complies at all and simply rides the schedule out to its
	// cap. Worse, message_end fires for an assistant message before that same
	// message's own tool calls execute (pi-agent-core's ordering), so
	// "print ASSUMPTIONS then scaffold 6 files" in one reply would trip
	// afterMutations(5) within the very turn that complied — an accusation of
	// silence aimed at the message that just spoke. See markCompliant and the
	// tool_call handler below.
	let contractHasCompliedOnce = false;

	registerAskUserTool(pi);

	/** The style ctx.model resolves to right now — used ONLY at the moment a
	 * nudge is actually picked and sent (before_agent_start below), which is
	 * also where deliveredStyle is set from this. Nowhere else reads ctx.model
	 * for style, precisely so enforcement cannot desync from what was
	 * delivered — see deliveredStyle's comment above. */
	const currentStyle = (ctx: ExtensionContext): AskStyle => askStyle(ctx.model, contractModelPatterns);

	/** Reset whatever counts as "unaddressed decisions" for both styles at
	 * once. Called on every event that constitutes compliance, whichever
	 * style is active — see the tool_call and message_end handlers below. */
	const markCompliant = () => {
		mutatedFilesSinceAsk = new Set();
		followUpDelivered = false;
		contractFollowUpsFired = 0;
		contractHasCompliedOnce = true;
	};

	/** Deliver a follow-up the same way, regardless of which style's wording
	 * it carries. Same two shapes stalled-turn uses to re-enter the loop
	 * mid-run: pi's sendMessage tests deliverAs before triggerTurn, so
	 * "nextTurn" would just park this on a queue nothing drains until the
	 * next human prompt. tool_call fires while a tool is about to execute, so
	 * the agent is by construction not idle here — the triggerTurn branch is
	 * a backstop against that assumption changing, not a path this takes
	 * today. */
	const deliverFollowUp = (content: string, ctx: ExtensionContext) => {
		pi.sendMessage(
			{ customType: FOLLOWUP_ENTRY_TYPE, content, display: false },
			ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "followUp" },
		);
	};

	/**
	 * The only condition on the tool: somebody is there to answer. Not a setting
	 * and not a toggle — in a headless run there is no user, and a question would
	 * hang the turn on nobody.
	 */
	const isAvailable = (ctx: ExtensionContext): boolean => ctx.hasUI;

	/** Offer the tool exactly when it is available. */
	const syncActive = (ctx: ExtensionContext): boolean => {
		const active = isAvailable(ctx);
		const tools = pi.getActiveTools();
		const has = tools.includes(TOOL_NAME);
		if (active && !has) pi.setActiveTools([...new Set([...tools, TOOL_NAME])]);
		else if (!active && has) pi.setActiveTools(tools.filter((name) => name !== TOOL_NAME));
		// No status chip: whether ask_user is available is not worth a permanent
		// footer slot. Clear any chip a prior version left behind.
		if (ctx.hasUI) ctx.ui.setStatus("ask-user", undefined);
		return active;
	};

	pi.on("session_start", (_event, ctx) => {
		const { settings, warnings } = loadSettings(agentDir, ctx.cwd, ctx.isProjectTrusted());
		contractModelPatterns = settings.contractModels;
		for (const warning of warnings) ctx.ui.notify(warning, "warning");
		syncActive(ctx);
	});

	// Judged on the text as typed, which is the request itself — after command
	// expansion a `/`-prefixed shortcut can look like anything. A prompt steered
	// into a running turn is by definition mid-task and never reaches
	// before_agent_start anyway, so it must not disturb the counter either.
	pi.on("input", (event) => {
		if (event.streamingBehavior !== undefined || event.source !== "interactive") return { action: "continue" };
		turnsSinceNudge++;
		// >=, not >: the constant is "at most one nudge in this many turns", so a
		// nudge on turn N makes turn N+8 eligible, not N+9.
		nudgeThisTurn = turnsSinceNudge >= CONFIG.nudgeCooldownTurns && opensWork(event.text);
		return { action: "continue" };
	});

	// A hidden custom message rather than an addition to the system prompt: the
	// whole point is that it arrives WITH the request instead of above it, and a
	// per-turn system prompt would also break the cached prefix for every turn.
	pi.on("before_agent_start", (_event, ctx) => {
		if (!nudgeThisTurn) return;
		nudgeThisTurn = false;
		// Never tell a headless agent to ask: there is nobody to answer, and the
		// tool it would reach for is not even offered.
		if (!isAvailable(ctx)) return;
		turnsSinceNudge = 0;
		// Resolved here, not read from a variable set at session_start: ctx.model
		// is the freshest source there is (before_agent_start's own event carries
		// no model field), so a model switched mid-session gets the right wording
		// on the very next nudge rather than the next session. Recorded into
		// deliveredStyle so every later check enforces against what was actually
		// sent, not against ctx.model read again later.
		const style = currentStyle(ctx);
		deliveredStyle = style;
		const text = style === "contract" ? CONTRACT_NUDGE : OPENING_NUDGE;
		return { message: { customType: NUDGE_ENTRY_TYPE, content: systemReminder(text), display: false } };
	});

	// The compliance follow-up. Watched on tool_call (before execution), not
	// tool_result: a write that later errors was still a decision acted on
	// without asking, whether or not the file ended up on disk, and the model
	// that never calls ask_user is exactly the one that never learns whether
	// its writes succeeded either.
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName === TOOL_NAME) {
			// An ask_user call is compliance for either style: whatever was built
			// without asking (or without an ASSUMPTIONS block) is now accounted
			// for, and both styles' counters start over for whatever comes next.
			markCompliant();
			return;
		}
		// Nothing to be a backstop for until the opening nudge has actually gone
		// out, and nobody to hand a reminder to without a UI — the same
		// condition the nudge itself is gated on in before_agent_start. Keyed on
		// deliveredStyle, not a fresh currentStyle(ctx) read: what matters here
		// is which gate the model was actually handed, not whichever model
		// happens to be selected right now (see deliveredStyle's comment above).
		if (deliveredStyle === undefined || !ctx.hasUI) return;
		if (event.toolName !== "write" && event.toolName !== "edit") return;

		// write and edit both carry `path: string`; cast defensively rather than
		// relying on narrowing away CustomToolCallEvent's wide `toolName: string`.
		const path = (event.input as Record<string, unknown>).path;
		if (typeof path === "string") mutatedFilesSinceAsk.add(path);

		if (deliveredStyle === "socratic") {
			// One-shot per arming — unchanged from before this file grew a second
			// style. Guarded on followUpDelivered rather than returning early
			// above it, so a socratic session that keeps mutating past the
			// threshold still has its files counted (mutatedFilesSinceAsk feeds
			// both styles), it just does not fire a second time for them.
			if (followUpDelivered || mutatedFilesSinceAsk.size < CONFIG.followUp.afterMutations) return;
			followUpDelivered = true;
			deliverFollowUp(followUpReminder(mutatedFilesSinceAsk.size), ctx);
			return;
		}

		// Contract style: a schedule, not a single latch — see CONFIG.followUp
		// and nudge.ts's header for why. The threshold for the Nth firing is a
		// base plus N-1 further rearmMutations; firing stops once maxFollowUps
		// have gone out this arming. The base is afterMutations ONLY for the
		// very first arm this session ever reaches — once contractHasCompliedOnce
		// is true (any compliance has ever registered), every arm's first
		// firing uses rearmMutations instead, forever, so a model that keeps
		// complying is never nagged sooner than one that never does — see
		// contractHasCompliedOnce's comment above for the false-accusation this
		// prevents. Compliance (an ask_user call, above, or an ASSUMPTIONS
		// block, in message_end below) resets contractFollowUpsFired to 0, so
		// the schedule restarts from that base the next time this arms.
		if (contractFollowUpsFired >= CONFIG.followUp.maxFollowUps) return;
		const base = contractHasCompliedOnce ? CONFIG.followUp.rearmMutations : CONFIG.followUp.afterMutations;
		const threshold = base + contractFollowUpsFired * CONFIG.followUp.rearmMutations;
		if (mutatedFilesSinceAsk.size < threshold) return;
		contractFollowUpsFired++;
		deliverFollowUp(contractFollowUpReminder(mutatedFilesSinceAsk.size), ctx);
	});

	// Contract style's other compliance path: an ASSUMPTIONS block is not
	// something the model tells the follow-up about, it is something it
	// prints in its own reply, so this is the one place that has to go
	// looking for it rather than being told. message_end fires once the
	// message is finalized (not message_update, which streams a partial block
	// that would trip hasAssumptionsBlock on an incomplete line before the
	// model finishes writing it). Socratic sessions are left alone here:
	// CONTRACT_NUDGE is the only wording that ever mentions this marker, so a
	// socratic model's text happening to start a line with "ASSUMPTIONS:"
	// (vanishingly unlikely, but not impossible) must not silently satisfy a
	// gate that was never offered to it. Keyed on deliveredStyle rather than
	// currentStyle(ctx): the block is compliance with the gate that was
	// actually delivered (nudge or follow-up), and a model switched to
	// something style.ts would resolve differently by the time this message
	// finishes must not un-arm a check the model was genuinely just told to
	// pass.
	pi.on("message_end", (event, ctx) => {
		if (deliveredStyle !== "contract" || !ctx.hasUI) return;
		const message = event.message as { role?: string; content?: unknown; stopReason?: string };
		if (message.role !== "assistant" || !Array.isArray(message.content)) return;
		// pi-agent-core finalizes and emits message_end with the PARTIAL message
		// on user abort (Escape) and on a stream error, stopReason "aborted" or
		// "error" either way — a message the user cut off or that never
		// actually reached the model is not the model choosing to comply, so it
		// must not register as having done so (e.g. Escape mid-"ASSUMPTIONS:
		// none" must not silently satisfy the gate for the rest of the run).
		if (message.stopReason === "aborted" || message.stopReason === "error") return;
		const textBlocks = message.content
			.filter((block): block is { type: "text"; text: string } => {
				const candidate = block as { type?: unknown; text?: unknown } | null;
				return !!candidate && typeof candidate === "object" && candidate.type === "text" && typeof candidate.text === "string";
			})
			.map((block) => block.text);
		// Each block checked on its own — not concatenated into one string
		// first — so compliance never depends on how many text blocks the
		// message happened to arrive in or in what order, only on whether ANY
		// of them, read on its own terms, is the artifact CONTRACT_NUDGE asked
		// for. Gluing blocks together with an inserted separator first is not
		// obviously safer: it would make hasAssumptionsBlock's fenced-region
		// tracking depend on which block a fence's opening and closing delimiter
		// happen to land in, an assumption this makes unnecessary.
		if (textBlocks.some((text) => hasAssumptionsBlock(text))) markCompliant();
	});
}
