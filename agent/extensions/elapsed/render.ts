/**
 * The end-of-turn line: "✻ Cooked for 1m 4s" — a past-tense verb drawn per turn,
 * dimmed, under a marker glyph.
 *
 * The line is display-only: a custom entry, which never enters the model's
 * context. How long a turn took is information for the person reading the
 * scrollback, not for the model.
 *
 * It carries a wall-clock finish time as well as a duration, because the two
 * answer different questions. "6m 7s" says how long you waited; "done 11:03 AM"
 * says *when*, which is the one you want when you come back to a terminal you
 * left an hour ago and are reading down a scrollback of them.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { CONFIG } from "./config.ts";
import { formatDuration } from "./duration.ts";

export interface TurnDurationDetails {
	durationMs: number;
	/** Index into CONFIG.verbs, chosen when the turn ended. */
	verbIndex: number;
	/**
	 * Epoch ms at which the turn settled. STORED, not derived at render time:
	 * these entries are persisted and redrawn whenever the session is resumed or
	 * a branch is replayed, so a clock read while rendering would report when you
	 * reopened the transcript rather than when the work finished.
	 *
	 * Absent on every entry written before this field existed. Those render as
	 * they always did — a duration and nothing after it — rather than inventing a
	 * time for a turn nobody recorded one for.
	 */
	endedAt?: number;
}

/**
 * The finish time, in the reader's own convention: "11:03 AM" where that is how
 * clocks are written, "11:03" where they are not.
 *
 * `undefined` locale rather than a fixed one, the same call panel.ts makes for
 * run start times — a hardcoded en-US here would print AM/PM to someone whose
 * every other clock is 24-hour.
 */
export function finishedAtLabel(endedAt: number): string {
	return new Date(endedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
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
	const worked = `${verbFor(details.verbIndex)} for ${formatDuration(details.durationMs)}`;
	// A finite check, not a truthy one: 0 is a real epoch and NaN is what a
	// hand-edited or half-written entry produces, and "done Invalid Date" is
	// worse than no clock at all.
	return Number.isFinite(details.endedAt) ? `${worked} · done ${finishedAtLabel(details.endedAt!)}` : worked;
}

export function renderTurnDuration(details: TurnDurationDetails, theme: Theme): Text {
	return new Text(theme.fg("muted", `✻ ${turnDurationLine(details)}`), 0, 0);
}
