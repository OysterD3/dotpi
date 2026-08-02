/**
 * stalled-turn — resume a turn that ended because the provider sent nothing.
 *
 * When a provider finishes a response having produced no content and reports
 * `stopReason: "stop"`, pi ends the turn. It is right to: "stop" means the
 * assistant is done. But the assistant never said anything, so the work simply
 * halts mid-task with no error, no explanation and no way to tell it apart from
 * a genuine finish. That is the "terminated halfway" failure.
 *
 * The loop cannot be made to continue from a hook — it only continues on tool
 * calls, and `message_end` can replace a message but not resume execution. So
 * recovery is to re-enter the loop: send one message saying the reply was lost
 * and to carry on. Capped per human turn, because a persistently broken
 * provider would otherwise burn money in a loop that looks like a hang.
 *
 *   detect.ts   what counts as a stall, and why (pure)
 *   config.ts   settings and the resume prompt
 *
 * Provider-agnostic by design, though the known offender is
 * pi-provider-qoder 0.2.9 — see detect.ts for the two lines responsible.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { DEFAULT_SETTINGS, ENTRY_TYPE, RESUME_PROMPT, RESUME_TYPE, resolveSettings, SETTINGS_KEY, type StalledTurnSettings } from "./config.ts";
import { isStalled } from "./detect.ts";

interface StallEntry {
	/** Which attempt this was, 1-based; 0 means the cap was already spent. */
	attempt: number;
	max: number;
	resumed: boolean;
}

export function loadSettings(agentDir: string): StalledTurnSettings {
	try {
		const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		return resolveSettings(raw?.[SETTINGS_KEY]);
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export default function (pi: ExtensionAPI) {
	const settings = loadSettings(getAgentDir());
	if (!settings.enabled) return;

	// Counted per HUMAN turn, not per loop iteration. Our own resume triggers a
	// turn, so resetting on turn_start would clear the counter every time and
	// make the cap meaningless — an empty-completion loop would run forever.
	let resumes = 0;

	pi.registerEntryRenderer<StallEntry>(ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		if (!data) return undefined;
		const text = data.resumed
			? theme.fg("warning", `The provider returned an empty response and the turn ended early — resuming (${data.attempt}/${data.max}).`)
			: theme.fg(
					"error",
					`The provider returned an empty response again after ${data.max} resume${data.max === 1 ? "" : "s"}. Stopping rather than looping; the task is unfinished.`,
				);
		return new Text(text, 0, 0);
	});

	pi.on("session_start", () => {
		resumes = 0;
	});

	// A human prompt is the only thing that starts a fresh budget.
	//
	// streamingBehavior is checked BEFORE source, and that order is the whole
	// guard. pi's InputSource is only "interactive" | "rpc" | "extension" —
	// there is no "steer" source. Text steered into a running turn arrives as
	// {source: "interactive", streamingBehavior: "steer"}, so testing source
	// alone let every steer refill the budget and the cap never bound a provider
	// stuck returning empty completions.
	pi.on("input", (event) => {
		if (event.streamingBehavior === undefined && event.source === "interactive") resumes = 0;
		return { action: "continue" };
	});

	pi.on("message_end", (event, ctx) => {
		if (!isStalled(event.message as never)) return;

		if (resumes >= settings.maxResumes) {
			// Say so and stop. Silently giving up here would reproduce the exact
			// symptom this extension exists to remove.
			pi.appendEntry<StallEntry>(ENTRY_TYPE, { attempt: 0, max: settings.maxResumes, resumed: false });
			return;
		}

		resumes++;
		pi.appendEntry<StallEntry>(ENTRY_TYPE, { attempt: resumes, max: settings.maxResumes, resumed: true });
		// display: false — this is plumbing, and the visible account of what
		// happened is the entry above.
		//
		// NOT deliverAs "nextTurn", which is what this used to send and why it
		// resumed nothing. pi's sendCustomMessage tests deliverAs FIRST: the
		// "nextTurn" branch pushes onto _pendingNextTurnMessages and returns, so
		// the `else if (options?.triggerTurn)` branch that actually calls
		// _runAgentPrompt is never reached. That queue is flushed in exactly one
		// place — inside prompt(), alongside the next HUMAN message — so the
		// resume sat there until the user typed something, and then arrived
		// stapled to whatever they said.
		//
		// The two shapes that do re-enter the loop, same as ultracode's result
		// delivery: followUp while the run is still live (it queues into
		// hasQueuedMessages(), which _handlePostAgentRun drains to continue), and
		// triggerTurn once the run has settled.
		pi.sendMessage(
			{ customType: RESUME_TYPE, content: RESUME_PROMPT, display: false },
			ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "followUp" },
		);
	});
}
