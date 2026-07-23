/**
 * Rendering a recap in the transcript.
 *
 * A recap is display-only: it is information for the person returning to the
 * session, not context for the model. It is stored as a custom entry (which does
 * not enter LLM context) and rendered with a heading, the way Claude Code shows
 * its recap as a distinct line rather than folding it into the assistant's reply.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export type RecapDetails = {
	text: string;
	/** "manual" from /recap, "auto" from returning after an idle gap. */
	trigger: "manual" | "auto";
	/** For auto recaps, roughly how long the session was idle, in ms. */
	idleMs?: number;
};

/** Compact idle duration, e.g. "6m", "1h 12m". */
export function formatIdle(ms: number): string {
	const minutes = Math.max(1, Math.round(ms / 60_000));
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function renderRecap(details: RecapDetails, theme: Theme): Text {
	const heading =
		details.trigger === "auto" && details.idleMs !== undefined
			? `● Recap (away ${formatIdle(details.idleMs)})`
			: "● Recap";

	const lines = [theme.fg("accent", theme.bold(heading)), theme.fg("text", details.text)];
	return new Text(lines.join("\n"), 0, 0);
}
