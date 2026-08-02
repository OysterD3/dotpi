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
 * There is no settings block and no off switch, by design. Asking when the
 * decision is genuinely the user's is behaviour, not a preference, and a knob
 * for it is only ever a way back to a tool that exists and goes unused. The one
 * condition is that somebody is there to answer: in a headless run (`-p`, an
 * `--mode json` subagent) `ctx.hasUI` is false, the tool is not offered, and the
 * opening nudge stays quiet — a fact about the session, not a choice about it.
 *
 * `/ask-user` reports that state and `/ask-user test` demonstrates the prompt.
 * Neither can turn anything off.
 */
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG, NUDGE_ENTRY_TYPE, TOOL_NAME } from "./config.ts";
import { type AskQuestion, AskSession, renderOutcomeText } from "./interaction.ts";
import { OPENING_NUDGE, opensWork, systemReminder } from "./nudge.ts";
import { showAsk } from "./prompt.ts";
import { registerAskUserTool } from "./tool.ts";

export default function (pi: ExtensionAPI) {
	// Set on the input hook, consumed by before_agent_start on the same turn.
	let nudgeThisTurn = false;
	// Interactive turns since the last nudge went out. Infinity so the first
	// work-opening request of a session is never inside the cooldown.
	let turnsSinceNudge = Number.POSITIVE_INFINITY;

	registerAskUserTool(pi);

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

	// A block body, not a one-liner: syncActive returns a boolean, and returning
	// it here makes TypeScript resolve a different `pi.on` overload.
	pi.on("session_start", (_event, ctx) => {
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
		return { message: { customType: NUDGE_ENTRY_TYPE, content: systemReminder(OPENING_NUDGE), display: false } };
	});

	const describeStatus = (ctx: ExtensionContext): string =>
		ctx.hasUI
			? `ask_user is on, and there is no way to turn it off: asking when a decision is genuinely yours is how the agent is meant to behave. A request that opens new work is reminded to settle its open decisions first, at most once every ${CONFIG.nudgeCooldownTurns} turns. Press Tab on any answer to annotate it.`
			: "ask_user is unavailable: this session has no interactive user to answer.";

	pi.registerCommand("ask-user", {
		description: "Show what ask_user is doing, or try the prompt (/ask-user [status | test])",
		getArgumentCompletions: (prefix: string) =>
			["status", "test"].filter((option) => option.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args: string, ctx) => {
			const arg = args.trim().toLowerCase();

			if (arg === "test") {
				if (!ctx.hasUI) return void ctx.ui.notify("The test needs the interactive TUI.", "error");
				// Two questions on purpose: the test should exercise ← / → and the
				// review step, not just a single selector. The first carries a
				// recommendation, so the badge and the pre-focused row are visible too.
				const questions: AskQuestion[] = [
					{
						question: "This is a test of ask_user. How does it look?",
						header: "Test",
						options: [
							{
								label: "Looks good",
								description: "Selection, the free-text row, and notes all behave",
								recommended: true,
							},
							{ label: "Needs tweaks", description: "Something feels off — press Tab here and say what" },
						],
						multiSelect: false,
					},
					{
						question: "Which parts did you try?",
						header: "Coverage",
						options: [
							{ label: "Arrow navigation", description: "← / → between questions" },
							{ label: "Tab note", description: "Annotating an answer in place" },
							{ label: "Free-text row", description: "Typing an answer of your own" },
						],
						multiSelect: true,
					},
				];
				const session = new AskSession(questions);
				// Not blocking: the user opened this themselves and the agent is not
				// waiting on it, so the turn clock and the cmux bell stay out of it.
				ctx.ui.notify(renderOutcomeText(await showAsk(pi, ctx, session, false)), "info");
				return;
			}

			// "" or "status" or anything else: report status.
			ctx.ui.notify(describeStatus(ctx), "info");
		},
	});
}
