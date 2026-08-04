/**
 * /usage — what this session has cost, and where it went.
 *
 * The statusline already carries running token totals, but it answers "how full
 * is the context" rather than "what am I paying for": it has one line, so it
 * sums everything into one number, and that number leaves out every model call
 * that was not a message in this conversation. `/usage` is the breakdown —
 * per model, per tool, plus pi's own compaction calls and any background
 * workflow spend — with the total underneath.
 *
 *   collect.ts   session entries -> per-source totals, plus the announced-spend
 *                log any extension can add to (pure)
 *   render.ts    totals -> the table (pure)
 *   config.ts    channel names, meter glyphs, thresholds
 *   budget.ts    threshold crossing/latching and checkpoint wording (pure)
 *   settings.ts  the `usage.budget` settings block
 *
 * The report is written into the transcript as a custom entry, the way /recap
 * is: it is information for you, not context for the model, and a custom entry
 * never enters LLM context. That also means scrolling back to an earlier
 * `/usage` shows what the session had spent AT THAT POINT, which is the useful
 * behaviour when you are trying to work out what a particular stretch cost.
 *
 * Budget checkpoints are the push half of the same number. `/usage` above is
 * pull-only — a human has to remember to ask — and forensics on a benchmark
 * run that burned $93 over 10h found zero signals anywhere near that spend.
 * `usage.budget.stepUsd` (0 by default: opt in) recomputes the identical total
 * at every turn_end and, on crossing a new multiple, notifies the human and/or
 * hands the model a hidden reminder to stop and account for what the last
 * checkpoint's worth of spend actually bought. See budget.ts for why this is
 * "latch once" rather than "fire while over".
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { budgetNotice, budgetReminder, crossedThreshold, reachedThreshold, systemReminder } from "./budget.ts";
import { AnnouncedSpendLog, collectUsage, withAnnounced, type AnnouncedSpend, type SessionUsage } from "./collect.ts";
import { BUDGET_REMINDER_TYPE, COLLECT_CHANNEL, ENTRY_TYPE, SPEND_CHANNEL } from "./config.ts";
import { plainUsage, renderUsage, type ReportMeta } from "./render.ts";
import { DEFAULTS, loadSettings, type UsageSettings } from "./settings.ts";


/**
 * The report as stored: the numbers, not the drawing.
 *
 * Keeping the totals rather than the rendered string is what makes an old
 * `/usage` still legible after a theme change, and it is safe precisely because
 * the numbers are a snapshot — the renderer is pure, so re-running it on a
 * redraw cannot restate the entry with today's spend.
 */
interface UsageEntry {
	usage: SessionUsage;
	meta: ReportMeta;
}

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();

	// Announcements accumulate, because the report is built on demand and the
	// events arrive whenever an extension spends. Increments rather than
	// snapshots, so several producers can announce without overwriting each
	// other and none of them has to keep a tally of its own.
	const announced = new AnnouncedSpendLog();
	pi.events.on(SPEND_CHANNEL, (data) => announced.add(data as AnnouncedSpend | undefined));

	let settings: UsageSettings = DEFAULTS;
	// Highest stepUsd multiple already reported this process, or undefined
	// before session_start has ever run. 0 is a real, meaningful value (the
	// session hasn't reached one step yet) so it cannot double as "unset" —
	// see the session_start handler below for why that distinction matters on
	// resume.
	let latch: number | undefined;

	/**
	 * The session's running total, computed exactly the way /usage's own
	 * handler computes it: ask durable producers first (COLLECT_CHANNEL), then
	 * add the file's own entries, then fold the two together. Shared rather
	 * than duplicated so the budget total and a manually-typed /usage can
	 * never disagree — the one property the spec for this feature required.
	 */
	const gatherUsage = (ctx: ExtensionContext): SessionUsage => {
		pi.events.emit(COLLECT_CHANNEL, {});
		const collected = collectUsage(ctx.sessionManager.getEntries());
		return withAnnounced(collected, announced.rows(new Set(collected.accountedKeys)));
	};

	// A new session starts a new tally. Without this, /usage after /new would
	// still be quoting the previous session's announced spend — the session file
	// resets, this log would not.
	pi.on("session_start", (_event, ctx) => {
		announced.reset();
		const loaded = loadSettings(agentDir, ctx.cwd, ctx.isProjectTrusted());
		settings = loaded.settings;
		for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");

		// Seed the latch from what the session already has, not from zero. A
		// /resume on a session that already crossed $80 must not immediately
		// re-fire every checkpoint on its very first turn back — that "zero" is
		// this PROCESS's memory resetting, not evidence the session's spend did.
		// Emitting COLLECT_CHANNEL here (inside gatherUsage) picks up durable
		// producers' totals from before the resume too, so the seed is the same
		// number /usage would print if asked right now.
		//
		// Skipped entirely while off (stepUsd 0, the default): reachedThreshold
		// would return 0 regardless, so the gather below would be a session-file
		// scan paid for by every session whether or not it opted into this.
		latch = settings.budget.stepUsd > 0 ? reachedThreshold(gatherUsage(ctx).total.cost, settings.budget.stepUsd) : 0;
	});

	pi.registerEntryRenderer<UsageEntry>(ENTRY_TYPE, (entry, _options, theme) =>
		entry.data ? new Text(renderUsage(entry.data.usage, entry.data.meta, theme), 0, 0) : undefined,
	);

	pi.registerCommand("usage", {
		description: "Show what this session has cost, broken down by model, tool and workflow",
		handler: async (_args: string, ctx) => {
			// Ask first, add up second. Producers that keep a durable record of their
			// own spend answer here, which is what makes a resumed session report the
			// fleets it inherited instead of silently dropping them. Synchronous by
			// contract: pi's bus calls handlers in place and does not wait for the
			// promise an async one returns, so an answer given after the first
			// `await` would arrive after the report below was built. Each handler is
			// wrapped in try/catch by the bus, so a producer that throws costs its
			// own rows and nothing else.
			const usage = gatherUsage(ctx);

			// pi reports tokens and percent as null before the first turn has been
			// measured, which is a different thing from "no context window" — the
			// meter should still draw, empty.
			const context = ctx.getContextUsage();
			const meta: ReportMeta = {
				sessionId: ctx.sessionManager.getSessionId(),
				contextTokens: context?.tokens ?? undefined,
				contextWindow: context?.contextWindow ?? ctx.model?.contextWindow,
				contextPercent: context?.percent ?? undefined,
				// First entry to last: the session's SPAN, not time spent working.
				// A session opened Monday and resumed Wednesday reads ~53h even if
				// only twenty minutes of it was work, because the first entry's
				// timestamp is when it was opened. An earlier comment here claimed
				// the opposite; the number was never the one it described. Nothing
				// pi records distinguishes working time from idle time, so the
				// honest options were an accurate label or a wrong number.
				elapsedMs: usage.firstAt !== undefined && usage.lastAt !== undefined ? usage.lastAt - usage.firstAt : undefined,
			};

			if (!ctx.hasUI) {
				ctx.ui.notify(plainUsage(usage, meta), "info");
				return;
			}
			pi.appendEntry<UsageEntry>(ENTRY_TYPE, { usage, meta });
		},
	});

	// The push half: recomputed every turn rather than only when asked. Skipped
	// entirely while off (stepUsd 0, the default) so an unconfigured session
	// pays nothing extra beyond the settings read already done at session_start.
	pi.on("turn_end", (_event, ctx) => {
		if (!(settings.budget.stepUsd > 0)) return;

		const usage = gatherUsage(ctx);
		const crossed = crossedThreshold(latch ?? 0, usage.total.cost, settings.budget.stepUsd);
		if (crossed === undefined) return;
		latch = crossed;

		const elapsedMs = usage.firstAt !== undefined && usage.lastAt !== undefined ? usage.lastAt - usage.firstAt : undefined;

		// Attention proportional to real money spent, matching the severity
		// `goal` uses for a blocked stop attempt rather than the "info" level
		// /usage's own headless report uses for a report nobody had to react to.
		if (settings.budget.notifyUser) ctx.ui.notify(budgetNotice(crossed, elapsedMs), "warning");

		if (settings.budget.remindModel) {
			// display: false — this is a hidden accounting nudge, not a visible
			// transcript entry; ctx.ui.notify above is the human-facing half.
			//
			// turn_end fires while the agent run is still active, so ctx.isIdle()
			// reads false in practice and this always takes the followUp branch —
			// queued in and picked up by the very next context assembly, at no
			// extra model-call cost. triggerTurn is the defensive fallback for the
			// same reason stalled-turn and goal both keep it: a run settling
			// between this check and the send is not a state this handler can rule
			// out, and followUp alone would leave the reminder stranded unsent.
			pi.sendMessage(
				{
					customType: BUDGET_REMINDER_TYPE,
					content: systemReminder(budgetReminder(usage.total.cost, elapsedMs, settings.budget.stepUsd)),
					display: false,
				},
				ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "followUp" },
			);
		}
	});
}
