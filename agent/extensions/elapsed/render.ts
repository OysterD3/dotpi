/**
 * The end-of-turn line. Claude Code renders "✻ Cooked for 1m 4s" — a past-tense
 * verb drawn per turn, dimmed, under a marker glyph. Same here, using the same
 * verb pool and the same duration format.
 *
 * The line is display-only: a custom entry, which never enters the model's
 * context. How long a turn took is information for the person reading the
 * scrollback, not for the model.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { CONFIG } from "./config.ts";
import { formatDuration } from "./duration.ts";

export interface TurnDurationDetails {
	durationMs: number;
	/** Index into CONFIG.verbs, chosen when the turn ended. */
	verbIndex: number;
}

export function verbFor(index: number): string {
	const verbs = CONFIG.verbs;
	// Stored indexes must stay meaningful if the pool ever changes.
	return verbs[((index % verbs.length) + verbs.length) % verbs.length] ?? "Worked";
}

export function pickVerbIndex(random = Math.random): number {
	return Math.floor(random() * CONFIG.verbs.length);
}

export function turnDurationLine(details: TurnDurationDetails): string {
	return `${verbFor(details.verbIndex)} for ${formatDuration(details.durationMs)}`;
}

export function renderTurnDuration(details: TurnDurationDetails, theme: Theme): Text {
	return new Text(theme.fg("muted", `✻ ${turnDurationLine(details)}`), 0, 0);
}
