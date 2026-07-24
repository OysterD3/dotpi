/**
 * cmux-notify — tell cmux when pi is blocked waiting for your approval.
 *
 * cmux already knows when a pi session starts, gets a prompt, and stops: its
 * generated bridge (agent/extensions/cmux-session.ts) sends those three. What
 * it never learned is the state you actually want to be interrupted for — the
 * agent sitting on a permission prompt in a pane you are not looking at. cmux
 * documents pi as having no approval integration at all; this is that gap.
 *
 * It lives in its own extension on purpose. cmux-session.ts carries the header
 * "DO NOT EDIT MANUALLY. cmux upgrades this file in place." — verified true: it
 * is byte-for-byte a template embedded in the cmux binary, which rewrites it on
 * install. An edit there would vanish silently on the next cmux upgrade.
 *
 * The coupling runs through pi's inter-extension bus rather than through cmux:
 * the permissions extension announces "I am about to block" on
 * `permissions:ask`, knowing nothing about cmux, and this extension translates
 * that into a cmux hook. Anything else wanting the same signal (a desktop
 * notifier, a webhook) subscribes to the same channel.
 *
 * Protocol notes, all verified against the shipped cmux binary:
 *   - the SUBCOMMAND decides how cmux handles the event, not the payload's
 *     hook_event_name;
 *   - `notification_type: "permission_prompt"` is load-bearing. Without it a
 *     notification is only an "Attention" banner and the session stays marked
 *     running; with it the session flips to needsInput and gets the bell chip;
 *   - the send is asynchronous. cmux's own bridge uses spawnSync, which is
 *     fine at session start but would stall the approval dialog behind a
 *     subprocess — the one place in pi where latency is in front of a human.
 *
 * Honest limitation: nothing re-marks the session as running once you answer.
 * cmux offers no event that clears needsInput (a second prompt-submit "works"
 * but unbalances cmux's own depth counter and leaves the session wedged as
 * busy — measured). The flag clears when the turn ends and cmux's own bridge
 * sends `stop`, so between answering and end-of-turn the chip is stale.
 */
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ASK_CHANNEL, BIN_ENV, CONFIG } from "./config.ts";
import { asAskEvent, buildPayload, shouldSend } from "./notify.ts";

export default function (pi: ExtensionAPI) {
	let cwd = process.cwd();
	let sessionId: string | undefined;

	pi.on("session_start", (_event, ctx) => {
		cwd = ctx.cwd || process.cwd();
		sessionId = ctx.sessionManager.getSessionId() ?? undefined;
	});

	pi.events.on(ASK_CHANNEL, (data) => {
		if (!shouldSend(process.env)) return;
		const event = asAskEvent(data);
		if (!event) return;

		// The announcing extension knows its own session; fall back to what was
		// captured at startup so a missing field cannot drop the notification.
		const id = event.sessionId ?? sessionId;
		if (!id) return;

		send(buildPayload(event, id, event.cwd ?? cwd));
	});
}

/**
 * Hand the payload to cmux without waiting. Every failure is swallowed: a
 * notification is a courtesy, and the approval prompt behind it must appear
 * whether or not cmux is reachable.
 */
function send(payload: Record<string, unknown>): void {
	try {
		const env = { ...process.env };
		delete env.AMP_API_KEY; // dropped by cmux's own bridge; keep parity
		const child = spawn(process.env[BIN_ENV] || "cmux", ["hooks", "pi", CONFIG.subcommand], {
			env,
			shell: false,
			stdio: ["pipe", "ignore", "ignore"],
			timeout: CONFIG.timeoutMs,
		});
		child.on("error", () => {});
		child.stdin.on("error", () => {}); // cmux exiting first must not throw EPIPE
		child.stdin.end(JSON.stringify(payload));
		child.unref();
	} catch {
		/* never let a notification break a permission prompt */
	}
}
