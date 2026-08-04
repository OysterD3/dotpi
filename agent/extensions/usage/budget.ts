/**
 * Budget checkpoints: latch-once threshold crossings over the session's own
 * running spend.
 *
 * The gap this closes: `/usage` is pull-only — spend accrues on every model
 * call, and the only way to see it is to remember to ask. Forensics on the
 * benchmark run that burned $93 over 10h found zero signals anywhere near
 * that spend: no warning to the human, nothing that made the model stop and
 * ask itself whether the approach was still worth its cost. This is the push
 * half for the exact number `/usage` already answers — recomputed the same
 * way, from the same entries, so the two can never disagree about how much a
 * session has cost.
 *
 * "Latch once" is the whole design. A threshold is a level, not an edge, and
 * spend inside one session only goes up — so once `total` has passed $30 it
 * stays past $30 for the rest of the session. Recomputing at every turn_end
 * and firing whenever `total >= threshold` would notify once and then EVERY
 * turn after, forever. index.ts keeps exactly one number across turns — the
 * highest threshold already reported — and this module is pure: given that
 * number and today's total, it says whether anything new has been crossed.
 *
 * Pure — no ctx, no I/O — so crossing, latching and the exact wording are all
 * unit-testable without a session.
 */

import { formatCost, formatElapsed } from "./render.ts";

/**
 * The highest whole multiple of `stepUsd` that `total` has reached, or 0 when
 * checkpoints are off (`stepUsd <= 0`) or `total` has not reached one step
 * yet.
 *
 * A half-cent of slack absorbs float drift in `total`, which is a running sum
 * of many small floating-point costs: `total / stepUsd` can land a hair under
 * an exact multiple (30 / 10 as 2.9999999999999996) and floor down one step
 * early. It cannot round a threshold that was not really reached UP past it —
 * half a cent is smaller than any real per-call cost this fires on.
 */
export function reachedThreshold(total: number, stepUsd: number): number {
	if (!(stepUsd > 0) || !(total > 0)) return 0;
	const steps = Math.floor((total + 0.005) / stepUsd);
	if (steps <= 0) return 0;
	// `steps * stepUsd` is exact in the domain this runs in (whole steps times a
	// decimal dollar amount) only in the sense that the MATH is exact; floating
	// point multiplication of two decimals is not, and an unrounded
	// 29.999999999999996 would print exactly the ugly number this whole function
	// exists to avoid producing.
	return Math.round(steps * stepUsd * 100) / 100;
}

/**
 * The new checkpoint to report, or undefined when nothing new has been
 * crossed since `previousLatch`.
 *
 * Reports only the HIGHEST threshold reached, not every one skipped over on
 * the way there. A background workflow fleet's spend can land between two
 * turn_end recomputes as one lump — total jumping from $2 to $47 with
 * stepUsd=10 has crossed four checkpoints between one turn and the next — and
 * firing four near-identical reminders in the same breath is something the
 * model has to read through, not four separate pieces of signal. Latching
 * straight to the highest still keeps the one property a latch has to have:
 * $10, $20 and $30 are never re-announced later just because the total is
 * still above them.
 */
export function crossedThreshold(previousLatch: number, total: number, stepUsd: number): number | undefined {
	const reached = reachedThreshold(total, stepUsd);
	return reached > previousLatch ? reached : undefined;
}

/**
 * A threshold — and `stepUsd` itself — is always an exact multiple of the
 * step by construction, so it is always a "clean" number: $10, $12.50. Table
 * precision (formatCost's four decimals below $100, so `$10.0000`) would read
 * as a rounding artefact on a number that never had a fraction of a cent to
 * begin with.
 */
function formatClean(usd: number): string {
	return `$${usd % 1 === 0 ? usd.toFixed(0) : usd.toFixed(2)}`;
}

/**
 * "0m" only when the session genuinely has no timestamped entries yet.
 * collectUsage leaves firstAt/lastAt undefined until the first one arrives,
 * which cannot be true by the time a turn has ended — handled anyway because
 * this is pure and has to return something for every input.
 */
function elapsedText(elapsedMs: number | undefined): string {
	return elapsedMs === undefined ? "0m" : formatElapsed(elapsedMs);
}

/** The user-facing notice: ctx.ui.notify's argument when a checkpoint fires. */
export function budgetNotice(threshold: number, elapsedMs: number | undefined): string {
	return `Session spend crossed ${formatClean(threshold)} (${elapsedText(elapsedMs)} elapsed)`;
}

/**
 * The hidden reminder sent to the model, unwrapped — index.ts adds the
 * <system-reminder> tags, matching how every other hidden nudge in this repo
 * is wrapped (see ask-user/nudge.ts's systemReminder).
 *
 * `stepUsd`, not the threshold just crossed, is what "the last $<step>"
 * means: the question is always "what did the last checkpoint-sized slice of
 * spend buy", regardless of which multiple of it this happens to be — the
 * fifth checkpoint asks exactly the same thing the first one did.
 *
 * The closing steers toward changing approach, not toward stopping or asking
 * the user — the goal extension's active instruction is "do not stop to ask
 * the user what to do next", and a checkpoint that lands in the same turn as
 * that reminder must not tell the model to do the opposite of what it was
 * just told.
 */
export function budgetReminder(totalUsd: number, elapsedMs: number | undefined, stepUsd: number): string {
	return (
		`This session has now cost ~${formatCost(totalUsd)} over ${elapsedText(elapsedMs)}. ` +
		"Stop and account: which of the task's acceptance criteria are verified done, which are not, and is the current approach converging? " +
		`If you cannot name concrete progress since the last ${formatClean(stepUsd)}, change approach: delegate, simplify, or consult the advisor — do not keep grinding the same path.`
	);
}

/** Wrap a reminder the way pi's own hidden-message reminders are wrapped. */
export function systemReminder(text: string): string {
	return `<system-reminder>\n${text}\n</system-reminder>`;
}
