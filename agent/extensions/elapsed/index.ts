/**
 * elapsed — how long the agent has been working, and how long it took.
 *
 * pi's working row says only "⠋ Working...", with no indication of whether
 * that has been true for two seconds or two minutes, and nothing records the
 * cost of a turn once it finishes. Two additions:
 *
 *   - while the agent runs, the row reads "Working... 12s", updated once a
 *     second (the text only changes that often — durations under a minute are
 *     floored to whole seconds);
 *   - when the turn settles, a dimmed line lands in the transcript:
 *     "✻ Cooked for 1m 4s", drawing a past-tense verb from a fixed pool.
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
 * That freeze had a blind spot: the row kept reading "Working... 4m 12s",
 * unchanged, for as long as the question or permission ask sat open — which
 * looks exactly like a long tool call, not like the one moment pi is stopped
 * dead waiting on the person at the keyboard. Forensics on a benchmark run
 * traced real cost to this: permission prompts sat unanswered for 10-17
 * minutes because nothing on screen (or off it) said so. Two fixes, both
 * scoped to while a wait is open:
 *
 *   - the row switches to "Waiting on your answer... Xs", a live wall clock
 *     of the open wait itself (waits.openWaitMs), so it visibly ticks instead
 *     of sitting frozen;
 *   - past elapsed.waitAlertMs (default 2 minutes), a repeating
 *     ctx.ui.notify() plus a terminal bell escalate it, firing again at every
 *     further interval for as long as the wait stays open.
 *
 * Settings (agent settings.json):
 *   elapsed.workingTimer      boolean, default true
 *   elapsed.showTurnDuration  boolean, default true
 *   elapsed.minTurnMs         number, default 0 (0 reports every turn)
 *   elapsed.waitAlertMs       number, default 120000 (0 disables the alert)
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
		// 0 is meaningful (the alert is off); anything else negative is not a duration.
		const waitAlertMs =
			typeof block?.waitAlertMs === "number" && block.waitAlertMs >= 0 ? block.waitAlertMs : DEFAULT_SETTINGS.waitAlertMs;
		return {
			workingTimer: typeof block?.workingTimer === "boolean" ? block.workingTimer : DEFAULT_SETTINGS.workingTimer,
			showTurnDuration:
				typeof block?.showTurnDuration === "boolean" ? block.showTurnDuration : DEFAULT_SETTINGS.showTurnDuration,
			minTurnMs,
			waitAlertMs,
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

/** The working row's text for a run that started `elapsedMs` ago. */
export function workingText(elapsedMs: number): string {
	return `${CONFIG.workingMessage} ${formatDuration(elapsedMs)}`;
}

/** The working row's text while a question or permission ask has been open for `openMs`. */
export function waitingText(openMs: number): string {
	return `${CONFIG.waitingMessage} ${formatDuration(openMs)}`;
}

/**
 * What the repeating waitAlertMs notice says. Shares "answer" with
 * waitingText() so the loud, occasional interruption and the quiet, constant
 * row read as the same event rather than two different ones — and so it stays
 * true for an ask-user question, which this same wait covers and which is not
 * something you "approve".
 */
export function waitAlertText(waitedMs: number): string {
	return `pi has been waiting ${formatDuration(waitedMs)} for your answer`;
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
	/**
	 * The live run's context, held only so the ASK/PERMISSION bus handlers below
	 * — which the EventBus calls with just a payload, no ctx — can reach
	 * ctx.ui.notify() for the waitAlertMs nag. Set at agent_start, cleared at
	 * agent_settled/session_start alongside startedAt.
	 */
	let runCtx: ExtensionContext | undefined;
	/** The repeating waitAlertMs notice for the wait currently open, if any. */
	let waitAlertTimer: ReturnType<typeof setInterval> | undefined;

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

	const stopWaitAlert = () => {
		if (!waitAlertTimer) return;
		clearInterval(waitAlertTimer);
		waitAlertTimer = undefined;
	};

	// Escalation for a wait that runs long: a repeating notify plus a terminal
	// bell, so a prompt does not depend on someone happening to glance at the
	// live row. Started once per open wait (the caller checks `waits.waiting`
	// before calling waits.open(), so a second announcement on an already-open
	// wait — same shared-channel hazard the comment below describes — cannot
	// restart the interval early). Guarded on ctx.hasUI for the same reason
	// clearWorkingMessage is: a context without dialog-capable UI has nothing
	// to notify(), and no terminal in front of a person to ring a bell at.
	const startWaitAlert = () => {
		if (settings.waitAlertMs <= 0 || !runCtx?.hasUI) return;
		const ctx = runCtx;
		waitAlertTimer = setInterval(() => {
			// The wait should already be closed out by stopWaitAlert() before this
			// can fire stale, but a wait really is what is being reported on, so
			// checking again costs nothing and guards against a future caller that
			// forgets to stop the timer on close.
			if (!waits.waiting) return;
			process.stdout.write("\u0007"); // terminal bell — audible even in a background pane
			try {
				ctx.ui.notify(waitAlertText(waits.openWaitMs(Date.now())), "warning");
			} catch {
				/* a replaced session's context throws from every member */
			}
		}, settings.waitAlertMs);
		(waitAlertTimer as { unref?: () => void }).unref?.();
	};

	// A prompt stops the agent dead until someone answers. The counter holds at
	// whatever it read when the prompt appeared and picks up from there, so it
	// keeps meaning "how long the agent has been working" rather than turning
	// into a stopwatch on the person reading it. Repainting on the announcement
	// rather than waiting for the next tick means the row stops and starts on the
	// keystroke that opens and closes the prompt.
	const pause = () => {
		const alreadyOpen = waits.waiting;
		waits.open(Date.now());
		paint?.();
		if (!alreadyOpen) startWaitAlert();
	};
	const resume = () => {
		waits.close(Date.now());
		stopWaitAlert();
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
		runCtx = undefined;
		waits.reset();
		stopTicker();
		stopWaitAlert();
		clearWorkingMessage(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		// Retries and continuations re-enter the loop within one run; the clock
		// belongs to the run, so only the first start sets it.
		if (startedAt !== undefined) return;
		startedAt = Date.now();
		waits.reset();
		// Captured unconditionally, ahead of the workingTimer/hasUI early return
		// below: waitAlertMs is its own setting and must work even with the live
		// row turned off, so pause() needs a ctx to notify() with regardless of
		// whether this run sets up a painter.
		runCtx = ctx;
		if (!settings.workingTimer || !ctx.hasUI) return;

		// Held locally as well as published, because stopTicker() clears the
		// published one: the first paint below can fail and stop the ticker, and
		// setInterval must not then be handed an undefined callback.
		let alive = true;
		const painter = () => {
			if (startedAt === undefined) return;
			try {
				const now = Date.now();
				// While a question or permission ask is open, show its own live
				// clock instead of the turn counter — see the file header for why
				// a frozen row here is the whole problem this extension now fixes.
				ctx.ui.setWorkingMessage(
					waits.waiting ? waitingText(waits.openWaitMs(now)) : workingText(workedMs(startedAt, now, waits)),
				);
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
		// A wait left open by an abort has no resume() coming to stop this, so it
		// is stopped here too — otherwise the nag would keep firing for a turn
		// that already ended.
		stopWaitAlert();
		startedAt = undefined;
		runCtx = undefined;
		clearWorkingMessage(ctx);
		if (started === undefined) return;

		if (!settings.showTurnDuration || durationMs < settings.minTurnMs) return;
		pi.appendEntry<TurnDurationDetails>(ENTRY_TYPE, { durationMs, verbIndex: pickVerbIndex() });
	});
}
