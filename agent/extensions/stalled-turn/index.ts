/**
 * stalled-turn — resume a turn that ended because the provider sent nothing,
 * plus three related survival mechanisms traced from the same benchmark
 * forensics (a $93/10h run that ended in a bad result): a sentinel for a tool
 * call whose result never comes back, a display-only nudge for the one abort
 * shape that means "unstick this", and two robustness fixes to the resume cap.
 *
 * When a provider finishes a response having produced no content and reports
 * `stopReason: "stop"`, pi ends the turn. It is right to: "stop" means the
 * assistant is done. But the assistant never said anything, so the work simply
 * halts mid-task with no error, no explanation and no way to tell it apart from
 * a genuine finish. That is the "terminated halfway" failure.
 *
 * The loop cannot be made to continue from a hook — it only continues on tool
 * calls, and `message_end` can replace a message but not resume execution. So
 * recovery is to re-enter the loop: send one message saying the reply was lost
 * and to carry on. Capped per human turn, because a persistently broken
 * provider would otherwise burn money in a loop that looks like a hang.
 *
 * The pending-call sentinel (A) answers a different failure from the same
 * forensics: a toolCall issued at 14:47 got its result at 20:59 — 6h12m later,
 * the client closed with the call pending and a permission ask unanswered —
 * and the model went on to reason over a six-hour-stale world with no idea
 * the gap existed. tool_execution_start/tool_execution_end already bracket
 * every call pi runs, so tracking one is just a Map; the three things done
 * with it (warn on shutdown, alert past a threshold, flag a stale-by-the-time-
 * it-lands result) all fall out of the same {toolName, startedAt} record.
 *
 * The abort-recovery affordance (B) answers the fingerprint of Escape used to
 * unstick a hung tool rather than to stop the work: an aborted, empty
 * assistant message directly after a failed tool result that had actually
 * been running long enough to plausibly be hung (see HUNG_TOOL_MIN_MS in
 * config.ts — without that floor, an ordinary fast failure followed by an
 * unrelated Escape has the same shape). It is display-only — appendEntry,
 * never sendMessage — because auto-resuming a user's own Escape would fight
 * them, which this extension must never do.
 *
 *   detect.ts   what counts as a stall or an abort worth flagging, and why (pure)
 *   render.ts   wording and formatting for the sentinel and the abort entry (pure)
 *   config.ts   settings, thresholds, and the resume prompt
 *
 * Provider-agnostic by design, though the known offender for the original
 * empty-completion shapes is pi-provider-qoder 0.2.9 — see detect.ts for the
 * two lines responsible.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	ABORT_RECOVERY_ENTRY_TYPE,
	DEFAULT_SETTINGS,
	ENTRY_TYPE,
	HUNG_TOOL_MIN_MS,
	PENDING_ALERT_TICK_MS,
	PENDING_STALE_MESSAGE_TYPE,
	RESUME_PROMPT,
	RESUME_TYPE,
	resolveSettings,
	SETTINGS_KEY,
	STALE_RESULT_THRESHOLD_MS,
	type StalledTurnSettings,
} from "./config.ts";
import { isAbortAfterHungTool, isStalled, isStaleCompletion, shouldAlertPendingCall } from "./detect.ts";
import { pendingCallAlertText, pendingCallShutdownWarning, renderAbortRecovery, staleResultReminder, systemReminder } from "./render.ts";

interface StallEntry {
	/** Which attempt this was, 1-based; 0 means the cap was already spent. */
	attempt: number;
	max: number;
	resumed: boolean;
}

/** What the abort-recovery entry (B) needs to render: just which tool was hung. */
interface AbortRecoveryEntry {
	toolName: string;
}

/** What the pending-call sentinel (A) tracks between tool_execution_start and tool_execution_end. */
interface PendingCall {
	toolName: string;
	startedAt: number;
}

export function loadSettings(agentDir: string): StalledTurnSettings {
	try {
		const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		return resolveSettings(raw?.[SETTINGS_KEY]);
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export default function (pi: ExtensionAPI) {
	const settings = loadSettings(getAgentDir());
	if (!settings.enabled) return;

	// Counted per HUMAN turn, not per loop iteration. Our own resume triggers a
	// turn, so resetting on turn_start would clear the counter every time and
	// make the cap meaningless — an empty-completion loop would run forever.
	let resumes = 0;

	// Pending-call sentinel (A) state. Keyed by toolCallId so parallel tool
	// execution mode tracks each call independently; `alerted` stops the 60s
	// sweep from renotifying a call it already flagged on an earlier tick.
	const pending = new Map<string, PendingCall>();
	const alerted = new Set<string>();
	// How long each tool call actually ran, kept just long enough for the abort-
	// recovery check (B) below to read it: message_end fires right after the
	// tool_execution_end for whatever it is reacting to, but by then `pending`
	// has already deleted that call's start time, so this is where its duration
	// survives to be looked up by toolCallId. Read-once — message_end deletes
	// what it reads — so this cannot accumulate entries nothing ever consults.
	const completedElapsedMs = new Map<string, number>();
	let pendingAlertTimer: ReturnType<typeof setInterval> | undefined;
	// The most recent live context, for the alert sweep — a setInterval callback
	// has no ctx of its own, the way message_end/tool_execution_end do.
	let uiCtx: ExtensionContext | undefined;

	const stopPendingAlertTimer = () => {
		if (pendingAlertTimer) clearInterval(pendingAlertTimer);
		pendingAlertTimer = undefined;
	};

	/** The 60s sweep body: notify + bell once per call past pendingToolCallAlertMs. */
	const checkPendingAlerts = () => {
		if (pending.size === 0) {
			stopPendingAlertTimer();
			return;
		}
		// Headless (-p, a json-mode subagent) has nobody to notify and no
		// terminal to ring; tracking and the shutdown warning still apply, only
		// this UI-facing half is skipped.
		//
		// try/catch around every uiCtx use below: this fires from a setInterval,
		// which outlives the session it was started for — /new, /resume, or a
		// fork replaces the session and invalidates uiCtx's ExtensionContext, and
		// pi makes every member access on a stale context throw (see runner.js's
		// invalidate()). An uncaught throw here would be an unhandled exception
		// in a timer callback, which crashes the process rather than the turn —
		// the same hazard elapsed/index.ts guards its waitAlert timer against.
		try {
			if (!uiCtx?.hasUI) return;
		} catch {
			return;
		}
		const now = Date.now();
		for (const [id, call] of pending) {
			if (alerted.has(id)) continue;
			const elapsed = now - call.startedAt;
			if (!shouldAlertPendingCall(elapsed, settings.pendingToolCallAlertMs)) continue;
			alerted.add(id);
			try {
				uiCtx.ui.notify(pendingCallAlertText(call.toolName, elapsed), "warning");
				// Once per call, not once per tick — a call sitting through several
				// sweeps must not ring on every one of them.
				process.stdout.write("\x07");
			} catch {
				/* a replaced session's context throws from every member */
			}
		}
	};

	const startPendingAlertTimerIfNeeded = () => {
		if (pendingAlertTimer || settings.pendingToolCallAlertMs <= 0) return;
		pendingAlertTimer = setInterval(checkPendingAlerts, PENDING_ALERT_TICK_MS);
		// Unref'd: a sentinel sweep must never be the reason the process stays alive.
		(pendingAlertTimer as { unref?: () => void }).unref?.();
	};

	/**
	 * The facts detect.ts's isAbortAfterHungTool needs but cannot fetch itself:
	 * was the message immediately before this one a failed tool result, and
	 * which call was it (so its actual runtime can be looked up in
	 * completedElapsedMs)? Safe to call from message_end because extensions run
	 * BEFORE session persistence (see agent-session.js: _emitExtensionEvent,
	 * then sessionManager.appendMessage) — the current (aborted) message has not
	 * been appended yet, so the leaf entry is still the PRECEDING one.
	 */
	const precedingToolResult = (ctx: ExtensionContext): { isError: boolean; toolName: string; toolCallId: string } | undefined => {
		const entry = ctx.sessionManager.getLeafEntry();
		if (!entry || entry.type !== "message" || entry.message.role !== "toolResult") return undefined;
		return { isError: entry.message.isError, toolName: entry.message.toolName, toolCallId: entry.message.toolCallId };
	};

	pi.registerEntryRenderer<StallEntry>(ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		if (!data) return undefined;
		const text = data.resumed
			? theme.fg("warning", `The provider returned an empty response and the turn ended early — resuming (${data.attempt}/${data.max}).`)
			: theme.fg(
					"error",
					`The provider returned an empty response again after ${data.max} resume${data.max === 1 ? "" : "s"}. Stopping rather than looping; the task is unfinished.`,
				);
		return new Text(text, 0, 0);
	});

	pi.registerEntryRenderer<AbortRecoveryEntry>(ABORT_RECOVERY_ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		if (!data) return undefined;
		return renderAbortRecovery(data.toolName, theme);
	});

	pi.on("session_start", (_event, ctx) => {
		resumes = 0;
		uiCtx = ctx;
	});

	// Real progress resets the budget: a turn that ran tools and got results
	// back is not part of an unbroken run of failures. Without this, maxResumes
	// counts stalls accumulated over an entire multi-hour human turn that
	// mostly worked fine, rather than consecutive ones — the cap would trip on
	// a rare transient stall near the end of otherwise-healthy work.
	pi.on("turn_end", (event) => {
		if (event.toolResults.length > 0) resumes = 0;
	});

	// A human prompt is the only thing that starts a fresh budget.
	//
	// streamingBehavior is checked BEFORE source, and that order is the whole
	// guard. pi's InputSource is only "interactive" | "rpc" | "extension" —
	// there is no "steer" source. Text steered into a running turn arrives as
	// {source: "interactive", streamingBehavior: "steer"}, so testing source
	// alone let every steer refill the budget and the cap never bound a provider
	// stuck returning empty completions.
	pi.on("input", (event) => {
		if (event.streamingBehavior === undefined && event.source === "interactive") resumes = 0;
		return { action: "continue" };
	});

	pi.on("message_end", (event, ctx) => {
		// Abort-recovery (B) first and separately from the stall check below:
		// isStalled(...) always returns false for stopReason "aborted" (see its
		// doc comment), so there is no overlap, but this is display-only and must
		// never fall through into a resume — the whole point is to never fight
		// the user's own Escape.
		const preceding = precedingToolResult(ctx);
		// Read-once: whatever is in here belongs to the batch of tool calls that
		// just fed into the message this handler is looking at, and none of it is
		// meaningful once this message has been classified — see the field's own
		// comment for why that keeps this bounded.
		const precedingElapsedMs = preceding ? completedElapsedMs.get(preceding.toolCallId) : undefined;
		completedElapsedMs.clear();
		if (isAbortAfterHungTool(event.message as never, preceding?.isError ?? false, precedingElapsedMs ?? 0, HUNG_TOOL_MIN_MS)) {
			pi.appendEntry<AbortRecoveryEntry>(ABORT_RECOVERY_ENTRY_TYPE, { toolName: preceding?.toolName ?? "tool" });
			return;
		}

		if (!isStalled(event.message as never)) return;

		if (resumes >= settings.maxResumes) {
			// Say so and stop. Silently giving up here would reproduce the exact
			// symptom this extension exists to remove.
			pi.appendEntry<StallEntry>(ENTRY_TYPE, { attempt: 0, max: settings.maxResumes, resumed: false });
			return;
		}

		resumes++;
		pi.appendEntry<StallEntry>(ENTRY_TYPE, { attempt: resumes, max: settings.maxResumes, resumed: true });
		// display: false — this is plumbing, and the visible account of what
		// happened is the entry above.
		//
		// NOT deliverAs "nextTurn", which is what this used to send and why it
		// resumed nothing. pi's sendCustomMessage tests deliverAs FIRST: the
		// "nextTurn" branch pushes onto _pendingNextTurnMessages and returns, so
		// the `else if (options?.triggerTurn)` branch that actually calls
		// _runAgentPrompt is never reached. That queue is flushed in exactly one
		// place — inside prompt(), alongside the next HUMAN message — so the
		// resume sat there until the user typed something, and then arrived
		// stapled to whatever they said.
		//
		// The two shapes that do re-enter the loop, same as ultracode's result
		// delivery: followUp while the run is still live (it queues into
		// hasQueuedMessages(), which _handlePostAgentRun drains to continue), and
		// triggerTurn once the run has settled.
		pi.sendMessage(
			{ customType: RESUME_TYPE, content: RESUME_PROMPT, display: false },
			ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "followUp" },
		);
	});

	pi.on("tool_execution_start", (event) => {
		pending.set(event.toolCallId, { toolName: event.toolName, startedAt: Date.now() });
		startPendingAlertTimerIfNeeded();
	});

	pi.on("tool_execution_end", (event) => {
		const call = pending.get(event.toolCallId);
		pending.delete(event.toolCallId);
		alerted.delete(event.toolCallId);
		if (pending.size === 0) stopPendingAlertTimer();
		if (!call) return;

		const completedAt = Date.now();
		const elapsed = completedAt - call.startedAt;
		// Recorded unconditionally, not just on the stale-result path below: the
		// abort-recovery check (B) in message_end needs to know how long THIS
		// call ran regardless of whether it also happened to be stale, and this
		// is the only point where that duration is still available (see the
		// completedElapsedMs comment above).
		completedElapsedMs.set(event.toolCallId, elapsed);

		// A.3: the call completed, but long enough after it was issued that its
		// result may describe a workspace that has since moved on. Riding it
		// alongside the result rather than replacing it — the tool's own output
		// is still real and still needed, this only adds the missing context.
		if (!isStaleCompletion(elapsed, STALE_RESULT_THRESHOLD_MS)) return;
		// ALWAYS deliverAs "followUp", never triggerTurn — unlike the resume
		// above, there is no "the turn stalled, someone must re-enter the loop"
		// case here. If the run is still live, followUp queues into it exactly
		// like the resume does. If it is idle, this is a wedged tool settling
		// after the user already Escaped away: sendCustomMessage's non-streaming,
		// non-triggerTurn branch appends straight to agent.state.messages and the
		// session, so the reminder is already sitting in history for whatever the
		// next real turn is — no queue to lose it, nothing to trigger now. Firing
		// triggerTurn here instead would start a brand-new unattended turn seeded
		// on nothing but a hidden reminder, which is exactly the "fight the user"
		// this extension's abort-recovery affordance (B) exists to avoid.
		pi.sendMessage(
			{
				customType: PENDING_STALE_MESSAGE_TYPE,
				content: systemReminder(staleResultReminder(call.toolName, call.startedAt, completedAt)),
				display: false,
			},
			{ deliverAs: "followUp" },
		);
	});

	pi.on("session_shutdown", () => {
		// A.1: the plain-stdout warning, in the same voice pi's own interactive
		// mode uses for "To resume this session:" — process.stdout.write, not
		// ctx.ui, because by the time session_shutdown fires in an interactive
		// quit the TUI has already stopped (ui.stop() runs before
		// runtimeHost.dispose(), which is what emits this event).
		const now = Date.now();
		for (const call of pending.values()) {
			process.stdout.write(`${pendingCallShutdownWarning(call.toolName, now - call.startedAt)}\n`);
		}
		pending.clear();
		alerted.clear();
		completedElapsedMs.clear();
		stopPendingAlertTimer();
		uiCtx = undefined;
	});
}
