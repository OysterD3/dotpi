/**
 * test-streak — say something when the suite is being re-run instead of read.
 *
 * A turn that keeps calling `pnpm test` with nothing changed between the calls
 * is not verifying anything after the first one. It looks like progress from
 * inside the loop, which is why nothing already in this config catches it:
 * every run is a legitimate tool call, the turn never stalls, and the model is
 * doing exactly what it was asked to do, forever.
 *
 * A reminder rather than a block. The streak is a heuristic about intent, and
 * refusing a suite run on a heuristic would eventually refuse the one that
 * mattered; a wrong reminder costs a sentence of context and the model can
 * disagree with it. See streak.ts for what counts and what clears.
 *
 * Delivered as `steer`, not `followUp` — the same reasoning context-diet
 * writes out at its escalation: followUp only drains once the model stops
 * calling tools of its own accord, which is the exact behaviour this exists to
 * interrupt. `steer` is polled every round, right after the tool results that
 * triggered it.
 *
 * There is no settings block. The two constants are in streak.ts, and "should
 * the agent be told it is looping" is not a preference anyone holds.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rerunNotice, rerunReminder, systemReminder } from "./reminder.ts";
import { CheckStreak, CONFIG, EDIT_TOOLS, isCheckCommand } from "./streak.ts";

const ENTRY_TYPE = "test-streak-nudge";

export default function (pi: ExtensionAPI) {
	const streak = new CheckStreak();

	pi.on("agent_start", () => {
		streak.newTurn();
	});

	pi.on("tool_call", (event, ctx) => {
		if (EDIT_TOOLS.has(event.toolName)) {
			streak.reset();
			return;
		}
		if (event.toolName !== "bash") return;

		// Read defensively: this is another tool's input, and a bash call with
		// no command is not one this has anything to say about.
		const command = String((event.input as { command?: unknown } | undefined)?.command ?? "").trim();
		if (!command || !isCheckCommand(command)) return;

		const count = streak.record(CONFIG.nudgeEvery, CONFIG.maxNudgesPerTurn);
		if (count === null) return;

		pi.sendMessage(
			{ customType: ENTRY_TYPE, content: systemReminder(rerunReminder(count, command)), display: false },
			ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "steer" },
		);
		if (ctx.hasUI) ctx.ui.notify(rerunNotice(count), "warning");
	});
}
