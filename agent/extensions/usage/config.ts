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

/**
 * pi.events channel the report fires on before it adds anything up.
 *
 * The push half above cannot survive a restart: an announcement is an event, so
 * spend a producer reported in one process is gone from the next one, and a
 * background workflow's tool result carries no usage for the session file to
 * corroborate it with. `pi -c` after a two-hour fleet therefore reported a total
 * that silently excluded a third of the bill — and, because the "announced by
 * extensions" caveat is keyed on having received an announcement, it was the one
 * report that looked complete.
 *
 * So a producer that keeps a DURABLE record of its own spend answers here
 * instead: the report asks, the producer reads its store and announces what it
 * finds on SPEND_CHANNEL, keyed (see `AnnouncedSpend.key`) so the same run
 * cannot be counted twice however many times it is asked.
 *
 * Answers must be SYNCHRONOUS. pi's bus invokes handlers synchronously and does
 * not wait for the promise an async one returns, so anything reported after the
 * first `await` arrives too late for the report that asked.
 */
export const COLLECT_CHANNEL = "usage:collect";

/** Cells in the context meter. */
export const BAR_CELLS = 12;
export const BAR_FILL = "█";
export const BAR_TRACK = "·";

/** Percentages at which the context meter changes colour. */
export const WARN_ABOVE_PERCENT = 70;
export const ERROR_ABOVE_PERCENT = 90;

/**
 * customType for the hidden budget-checkpoint reminder sent via
 * pi.sendMessage — see budget.ts. `display: false` on that message means
 * nothing ever registers a renderer for this; the string only has to be
 * unique enough not to collide with another extension's customType.
 */
export const BUDGET_REMINDER_TYPE = "usage_budget_reminder";
