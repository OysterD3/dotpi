/**
 * Constants for the usage extension.
 */

export const ENTRY_TYPE = "usage";

/**
 * pi.events channel any extension announces its own model spend on.
 *
 * Named for the question, not for one answer to it. An earlier version was
 * `ultracode:spend`, which made workflow agents visible and left every other
 * extension that bills money invisible — `recap` and `goal` both call
 * `completeSimple` directly and record nothing on the session, so a report
 * wired to a single producer understates the bill, which is the one direction
 * it must never be wrong in.
 *
 * Payload — an INCREMENT, not a running total, so a producer announces as it
 * spends and never has to hold a session-scoped tally of its own:
 *
 *     { source: string; usage: { input?, output?, cacheRead?, cacheWrite?,
 *       reasoning?, cost?: number }; calls?: number }
 *
 * `cost` is a plain number (pi's `Usage.cost.total`, flattened). `calls`
 * defaults to 1. Rows are keyed by `source` and accumulated.
 *
 * Declared here rather than imported: every extension in this repo installs on
 * its own, so the two sides share a string, not a module. A producer that is
 * not installed simply never fires and its row never appears.
 */
export const SPEND_CHANNEL = "usage:spend";

/** Cells in the context meter. */
export const BAR_CELLS = 12;
export const BAR_FILL = "█";
export const BAR_TRACK = "·";

/** Percentages at which the context meter changes colour. */
export const WARN_ABOVE_PERCENT = 70;
export const ERROR_ABOVE_PERCENT = 90;
