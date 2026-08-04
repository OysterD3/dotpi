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
 *   collect.ts  session entries -> per-source totals, plus the announced-spend
 *               log any extension can add to (pure)
 *   render.ts   totals -> the table (pure)
 *   config.ts   channel names, meter glyphs, thresholds
 *
 * The report is written into the transcript as a custom entry, the way /recap
 * is: it is information for you, not context for the model, and a custom entry
 * never enters LLM context. That also means scrolling back to an earlier
 * `/usage` shows what the session had spent AT THAT POINT, which is the useful
 * behaviour when you are trying to work out what a particular stretch cost.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { AnnouncedSpendLog, collectUsage, withAnnounced, type AnnouncedSpend, type SessionUsage } from "./collect.ts";
import { COLLECT_CHANNEL, ENTRY_TYPE, SPEND_CHANNEL } from "./config.ts";
import { plainUsage, renderUsage, type ReportMeta } from "./render.ts";


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
	// Announcements accumulate, because the report is built on demand and the
	// events arrive whenever an extension spends. Increments rather than
	// snapshots, so several producers can announce without overwriting each
	// other and none of them has to keep a tally of its own.
	const announced = new AnnouncedSpendLog();
	pi.events.on(SPEND_CHANNEL, (data) => announced.add(data as AnnouncedSpend | undefined));

	// A new session starts a new tally. Without this, /usage after /new would
	// still be quoting the previous session's announced spend — the session file
	// resets, this log would not.
	pi.on("session_start", () => announced.reset());

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
			pi.events.emit(COLLECT_CHANNEL, {});
			const collected = collectUsage(ctx.sessionManager.getEntries());
			// Runs the file already accounts for are dropped from the answer: a
			// producer offering its whole store cannot know which of them also
			// recorded their usage on a tool result.
			const usage = withAnnounced(collected, announced.rows(new Set(collected.accountedKeys)));

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
}
