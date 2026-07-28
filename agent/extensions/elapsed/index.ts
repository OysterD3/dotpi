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
 * The clock stops while ask_user has a question up (announced on ASK_CHANNEL).
 * A turn's duration is meant to say how long the *agent* worked; once it stops
 * and asks you something, the seconds belong to you, and counting them would
 * turn "Cooked for 4m 20s" into a measure of how long you took to decide. The
 * live row holds at the value it had when the question appeared and resumes
 * from there, rather than jumping to catch up when you answer.
 *
 * Settings (agent settings.json):
 *   elapsed.workingTimer      boolean, default true
 *   elapsed.showTurnDuration  boolean, default true (Claude Code's key name)
 *   elapsed.minTurnMs         number, default 0 (Claude Code has no threshold)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	ASK_CHANNEL,
	CONFIG,
	DEFAULT_SETTINGS,
	ENTRY_TYPE,
	PERMISSION_ANSWERED_CHANNEL,
	PERMISSION_CHANNEL,
	SETTINGS_KEY,
	type ElapsedSettings,
} from "./config.ts";
import { formatDuration } from "./duration.ts";
import { pickVerbIndex, renderTurnDuration, type TurnDurationDetails } from "./render.ts";
import { WaitClock, workedMs } from "./waiting.ts";

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
	/** Time this turn has spent stopped on a question, excluded from the count. */
	const waits = new WaitClock();
	/** The current run's repaint, so a question can freeze the row on the spot. */
	let paint: (() => void) | undefined;

	pi.registerEntryRenderer<TurnDurationDetails>(ENTRY_TYPE, (entry, _options, theme) =>
		entry.data ? renderTurnDuration(entry.data, theme) : undefined,
	);

	const stopTicker = () => {
		paint = undefined;
		if (!ticker) return;
		clearInterval(ticker);
		ticker = undefined;
	};

	/** True while the question on screen is one the agent is actually blocked on. */
	const isBlocking = (data: unknown): boolean => {
		const event = data as { active?: boolean; blocking?: boolean } | undefined;
		// blocking is absent on older announcements; a question that did not say
		// otherwise is assumed to be one the agent is waiting on.
		return event?.active === true && event.blocking !== false;
	};

	// A prompt stops the agent dead until someone answers. The counter holds at
	// whatever it read when the prompt appeared and picks up from there, so it
	// keeps meaning "how long the agent has been working" rather than turning
	// into a stopwatch on the person reading it. Repainting on the announcement
	// rather than waiting for the next tick means the row stops and starts on the
	// keystroke that opens and closes the prompt.
	const pause = () => {
		waits.open(Date.now());
		paint?.();
	};
	const resume = () => {
		waits.close(Date.now());
		paint?.();
	};

	pi.events.on(ASK_CHANNEL, (data) => {
		if (isBlocking(data)) pause();
		// Only an explicit close resumes. Treating "anything that is not an open"
		// as a close would let a future announcement on this shared channel — a
		// mid-question update, say — silently restart the count while the question
		// is still on screen.
		else if ((data as { active?: boolean } | undefined)?.active === false) resume();
	});

	// A permission prompt blocks on a human in exactly the same way, so it is
	// excluded on the same terms — otherwise "Cooked for 4m 20s" would mean the
	// agent's time after a question and the reader's after an approval. Its two
	// edges arrive on two channels rather than as one payload with a flag,
	// because `permissions:ask` predates this and its shape is already published.
	pi.events.on(PERMISSION_CHANNEL, pause);
	pi.events.on(PERMISSION_ANSWERED_CHANNEL, resume);

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
		waits.reset();
		stopTicker();
		clearWorkingMessage(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		// Retries and continuations re-enter the loop within one run; the clock
		// belongs to the run, so only the first start sets it.
		if (startedAt !== undefined) return;
		startedAt = Date.now();
		waits.reset();
		if (!settings.workingTimer || !ctx.hasUI) return;

		// Held locally as well as published, because stopTicker() clears the
		// published one: the first paint below can fail and stop the ticker, and
		// setInterval must not then be handed an undefined callback.
		let alive = true;
		const painter = () => {
			if (startedAt === undefined) return;
			try {
				ctx.ui.setWorkingMessage(workingText(workedMs(startedAt, Date.now(), waits)));
			} catch {
				alive = false;
				stopTicker(); // the session went away mid-run
			}
		};

		painter(); // 0s immediately, so the row never shows a stale count
		if (!alive) return; // a UI that already threw will not start working now
		ticker = setInterval(painter, CONFIG.tickMs);
		(ticker as { unref?: () => void }).unref?.();
		paint = painter;
	});

	pi.on("agent_settled", (_event, ctx) => {
		const started = startedAt;
		// A question still open at settle time (an abort, say) is closed out here:
		// waitedBy() counts the wait in progress, so its seconds are excluded like
		// any other.
		const durationMs = started === undefined ? 0 : workedMs(started, Date.now(), waits);
		stopTicker();
		startedAt = undefined;
		clearWorkingMessage(ctx);
		if (started === undefined) return;

		if (!settings.showTurnDuration || durationMs < settings.minTurnMs) return;
		pi.appendEntry<TurnDurationDetails>(ENTRY_TYPE, { durationMs, verbIndex: pickVerbIndex() });
	});
}
