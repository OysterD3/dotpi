/**
 * What each effort level means, in one table.
 *
 * This started as five separate structures — a caps record, two Sets, and two
 * fallthrough chains selecting angles — which meant "what is xhigh?" could only
 * be answered by reading all five and noticing they happened to agree. Nothing
 * declared that `xhigh` and `max` were identical bar the sweep; it was an
 * accident of five independent defaults landing on the same values, and any one
 * of them could drift without the others noticing.
 *
 * One row per level makes the relationships visible and the drift impossible:
 * `xhigh` and `max` differ by exactly one field, and adding a level is one row
 * rather than five edits.
 */

import { CLEANUP, CORRECTNESS, SIMPLIFY_ANGLES } from "./angles.ts";

export const LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Level = (typeof LEVELS)[number];

export type FanOut = "workflow" | "task" | "none";

export type LevelSpec = {
	/**
	 * Most findings that may survive. A forcing function, not a quota: it makes
	 * the reviewer rank and cut instead of emptying its notebook onto the screen.
	 */
	cap: number;
	/**
	 * Whether findings that could not be confirmed may be reported.
	 *
	 * Below `high` an uncertain finding is noise — someone running a quick review
	 * wants what is definitely wrong. Above it a missed bug costs more than a
	 * false positive, so "plausible" earns its place.
	 */
	uncertain: boolean;
	/** Whether the finder fleet is sized to the diff rather than pinned at the floor. */
	scaleFinders: boolean;
	/**
	 * Whether to add a final sweep for what the angles structurally miss.
	 *
	 * Angles are a checklist, and a checklist finds what it lists. This is the
	 * pass that goes looking for what no angle named — and the only thing that
	 * separates `max` from `xhigh`.
	 */
	sweep: boolean;
	/** Correctness lenses, cheapest coverage first. */
	correctness: readonly string[];
	/** Quality lenses. Quick reviews carry none: a style nit is not what they were asked for. */
	cleanup: readonly string[];
};

const { lineByLine, removedBehavior, crossFile, languagePitfalls, wrappers } = CORRECTNESS;
const ALL_CORRECTNESS = [lineByLine, removedBehavior, crossFile, languagePitfalls, wrappers];
const ALL_CLEANUP = [CLEANUP.reuse, CLEANUP.simplification, CLEANUP.efficiency, CLEANUP.altitude, CLEANUP.conventions];

export const LEVEL_SPECS: Record<Level, LevelSpec> = {
	low: { cap: 5, uncertain: false, scaleFinders: false, sweep: false, correctness: [lineByLine], cleanup: [] },
	medium: { cap: 8, uncertain: false, scaleFinders: false, sweep: false, correctness: [lineByLine, removedBehavior], cleanup: [] },
	high: {
		cap: 10,
		uncertain: true,
		scaleFinders: true,
		sweep: false,
		correctness: [lineByLine, removedBehavior, crossFile],
		cleanup: [CLEANUP.reuse, CLEANUP.simplification],
	},
	xhigh: { cap: 15, uncertain: true, scaleFinders: true, sweep: false, correctness: ALL_CORRECTNESS, cleanup: ALL_CLEANUP },
	// max is xhigh plus the sweep. One field, so it stays one field.
	max: { cap: 15, uncertain: true, scaleFinders: true, sweep: true, correctness: ALL_CORRECTNESS, cleanup: ALL_CLEANUP },
};

/** Correctness lenses for a level. */
export function correctnessAngles(level: Level): readonly string[] {
	return LEVEL_SPECS[level].correctness;
}

/** Quality lenses for a level. */
export function cleanupAngles(level: Level): readonly string[] {
	return LEVEL_SPECS[level].cleanup;
}

/** Every lens a level runs, correctness first. */
export function anglesFor(level: Level): string[] {
	return [...correctnessAngles(level), ...cleanupAngles(level)];
}

export const CONFIG = {
	/** Level used when `/code-review` is called with no level argument. */
	defaultLevel: "medium" as Level,

	/** Diff lines per finder subagent, and the bounds that clamp the result. */
	linesPerFinder: 150,
	minFinders: 2,
	maxFinders: 8,

	/**
	 * Fleet size when the diff cannot be measured at all.
	 *
	 * Deliberately not the floor. "Unmeasurable" is not "small" — no upstream
	 * configured and a path target both land here, and either can be a large
	 * change. The floor would quietly give the biggest reviews the smallest
	 * fleet, so an unknown size gets a middling one instead.
	 */
	unmeasurableFinders: 4,

	/**
	 * Tools that can fan work out to subagents, in preference order.
	 *
	 * `workflow` orchestrates a whole fleet deterministically and is worth
	 * reaching for first; `task` spawns them one call at a time. With neither
	 * active the review still runs — it just runs inline, and says so.
	 *
	 * Naming sibling extensions' tools is the same idiom the statusline uses to
	 * notice ultracode: pi's tool list carries names, not capabilities, so there
	 * is nothing more structural to match on.
	 */
	fanOutTools: ["workflow", "task"] as const,

	/**
	 * Cleanup angles /simplify works through — derived, never hand-counted.
	 *
	 * The prompt narrates this number in nine places ("the usual 4-agent
	 * fan-out"). A literal here would keep saying 4 after a fifth angle was
	 * added, and a prompt that miscounts its own angles fails silently.
	 */
	simplifyAngles: SIMPLIFY_ANGLES.length,
};
