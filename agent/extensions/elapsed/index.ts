/**
 * elapsed — how long the agent has been working, and how long it took.
 *
 * pi's working row says only "⠋ Working...", with no indication of whether
 * that has been true for two seconds or two minutes, and nothing records the
 * cost of a turn once it finishes. Two additions, both modelled on Claude Code:
 *
 *   - while the agent runs, the row reads "Working... 12s", updated once a
 *     second (the text only changes that often — durations under a minute are
 *     floored to whole seconds);
 *   - when the turn settles, a dimmed line lands in the transcript:
 *     "✻ Cooked for 1m 4s", using Claude Code's verb pool and duration format.
 *
 * The line is a custom entry, so it stays out of the model's context — the
 * duration is for the person reading the scrollback.
 *
 * Timing runs from the first agent_start to agent_settled, which is the true
 * end of a run: it fires after automatic retries, compaction, and queued
 * continuations, so a turn interrupted by a compaction is still reported as
 * one turn rather than two. agent_start carries no timestamp, so the clock is
 * read in the handler.
 *
 * Settings (agent settings.json):
 *   elapsed.workingTimer      boolean, default true
 *   elapsed.showTurnDuration  boolean, default true (Claude Code's key name)
 *   elapsed.minTurnMs         number, default 0 (Claude Code has no threshold)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG, DEFAULT_SETTINGS, ENTRY_TYPE, SETTINGS_KEY, type ElapsedSettings } from "./config.ts";
import { formatDuration } from "./duration.ts";
import { pickVerbIndex, renderTurnDuration, type TurnDurationDetails } from "./render.ts";

export function loadSettings(agentDir: string): ElapsedSettings {
	try {
		const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		const block = raw?.[SETTINGS_KEY] as Record<string, unknown> | undefined;
		const minTurnMs = typeof block?.minTurnMs === "number" && block.minTurnMs >= 0 ? block.minTurnMs : DEFAULT_SETTINGS.minTurnMs;
		return {
			workingTimer: typeof block?.workingTimer === "boolean" ? block.workingTimer : DEFAULT_SETTINGS.workingTimer,
			showTurnDuration:
				typeof block?.showTurnDuration === "boolean" ? block.showTurnDuration : DEFAULT_SETTINGS.showTurnDuration,
			minTurnMs,
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

/** The working row's text for a run that started `elapsedMs` ago. */
export function workingText(elapsedMs: number): string {
	return `${CONFIG.workingMessage} ${formatDuration(elapsedMs)}`;
}

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	let settings: ElapsedSettings = loadSettings(agentDir);
	let startedAt: number | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;

	pi.registerEntryRenderer<TurnDurationDetails>(ENTRY_TYPE, (entry, _options, theme) =>
		entry.data ? renderTurnDuration(entry.data, theme) : undefined,
	);

	const stopTicker = () => {
		if (!ticker) return;
		clearInterval(ticker);
		ticker = undefined;
	};

	// setWorkingMessage is sticky: whatever was set last is reused at the start
	// of the next run. Clearing it restores pi's own "Working...".
	const clearWorkingMessage = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setWorkingMessage(undefined);
		} catch {
			/* a replaced session's context throws from every member */
		}
	};

	pi.on("session_start", (_event, ctx) => {
		settings = loadSettings(agentDir);
		startedAt = undefined;
		stopTicker();
		clearWorkingMessage(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		// Retries and continuations re-enter the loop within one run; the clock
		// belongs to the run, so only the first start sets it.
		if (startedAt !== undefined) return;
		startedAt = Date.now();
		if (!settings.workingTimer || !ctx.hasUI) return;

		const paint = () => {
			if (startedAt === undefined) return;
			try {
				ctx.ui.setWorkingMessage(workingText(Date.now() - startedAt));
			} catch {
				stopTicker(); // the session went away mid-run
			}
		};
		paint(); // 0s immediately, so the row never shows a stale count
		ticker = setInterval(paint, CONFIG.tickMs);
		(ticker as { unref?: () => void }).unref?.();
	});

	pi.on("agent_settled", (_event, ctx) => {
		stopTicker();
		const started = startedAt;
		startedAt = undefined;
		clearWorkingMessage(ctx);
		if (started === undefined) return;

		const durationMs = Date.now() - started;
		if (!settings.showTurnDuration || durationMs < settings.minTurnMs) return;
		pi.appendEntry<TurnDurationDetails>(ENTRY_TYPE, { durationMs, verbIndex: pickVerbIndex() });
	});
}
