/**
 * /recap — a one-line summary of where the session stands.
 *
 * Two entry points into one generator — a manual `/recap`, and an automatic
 * summary shown when you return to the terminal after being away 5+ minutes.
 *
 *   - `/recap` is always available and does exactly what it says.
 *   - Auto-on-return is written **at the end of the trace, while you are away**,
 *     so it is on screen when you get back. A timer is armed when the agent
 *     settles and fires once the absence has lasted `idleThresholdMs`; your next
 *     message then goes straight through. It is ON by default (config.ts says
 *     why); the cost is one cheap-model call per absence. Turn it off with
 *     `recap.autoOnReturn: false`.
 *
 * It used to be generated on the way in — held in front of your next message so
 * it landed above it — which meant it did not exist until you had already
 * started typing, and charged you a wait to read a summary of what you had just
 * come back to. That path still exists as a fallback for the case a timer
 * cannot cover: a session resumed from disk, where no `agent_settled` has fired
 * in this process and the gap is only visible once you type.
 *
 * The ideal version would know you were away because the terminal lost and
 * regained focus. pi exposes no focus events, so "away" is still wall-clock
 * idle, and the trade is now the other way round: a five-minute pause spent
 * reading the diff produces a recap nobody asked for, where before it produced
 * one only if you left AND came back.
 *
 * The recap model needs no configuration: unconfigured, the `cheap` role is
 * used when a role map defines it, else the active session model; an explicit
 * `recap.model` overrides. A recap is display-only — information for the
 * person returning, stored as a custom entry that never enters LLM context.
 *
 *   prompts.ts     the recap prompt
 *   generate.ts    the tool-less LLM call and its outcomes
 *   model.ts       resolving `recap.model` the way pi resolves --model (pure)
 *   transcript.ts  session branch -> budgeted transcript text (pure)
 *   settings.ts    the `recap` settings block
 *   gate.ts        the auto-on-return decision (pure)
 *   state.ts       idle timing and a reentrancy guard
 *   render.ts      the recap entry's appearance (pure)
 *   config.ts      limits and constants
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG, ENTRY_TYPE } from "./config.ts";
import { generateRecap, type SpendReport } from "./generate.ts";

/**
 * pi.events channel for announcing model spend, shared by every extension that
 * bills money (the `usage` extension keeps the tally and `/usage` prints it).
 * A literal string rather than an import: each extension here installs on its
 * own, so the two sides share a channel name, not a module. With no subscriber
 * the event goes nowhere.
 */
const SPEND_CHANNEL = "usage:spend";
import { type GateEntry, shouldAutoRecap } from "./gate.ts";
import { renderRecap, type RecapDetails } from "./render.ts";
import { loadSettings } from "./settings.ts";
import { RecapState } from "./state.ts";

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	const state = new RecapState();

	/** One recap call's spend, announced as an increment. */
	const announce = (spend: SpendReport) => pi.events.emit(SPEND_CHANNEL, { source: "recap", usage: spend, calls: 1 });

	pi.registerEntryRenderer<RecapDetails>(ENTRY_TYPE, (entry, _options, theme) =>
		entry.data ? renderRecap(entry.data, theme) : undefined,
	);

	pi.on("session_start", (_event, ctx) => {
		state.reset();
		const { warnings } = loadSettings(agentDir, ctx.cwd, ctx.isProjectTrusted());
		for (const warning of warnings) ctx.ui.notify(warning, "warning");
	});

	/**
	 * Generate and append, shared by the idle timer and the on-return fallback.
	 * Returns whether an entry was actually appended.
	 */
	const produce = async (ctx: ExtensionContext, trigger: "auto", idleMs: number | undefined): Promise<boolean> => {
		if (!state.begin()) return false;
		try {
			const outcome = await generateRecap(ctx, {
				agentDir,
				timeoutMs: CONFIG.autoTimeoutMs,
				signal: ctx.signal,
				onSpend: announce,
			});
			if (outcome.kind !== "ok") return false;
			pi.appendEntry<RecapDetails>(ENTRY_TYPE, { text: outcome.text, trigger, idleMs });
			return true;
		} catch {
			// A session replaced under a pending timer throws from every member.
			return false;
		} finally {
			state.end();
		}
	};

	/**
	 * The idle timer: armed when the agent settles, fires once the absence has
	 * lasted long enough to be worth summarising.
	 *
	 * This is what puts the recap at the END OF THE TRACE. It used to be
	 * generated on the way in — held in front of your next message so it landed
	 * above it — which meant it did not exist until you had already started
	 * typing, and cost you a wait to read a summary of what you had come back
	 * to. Waiting out the same threshold on a timer instead produces it while
	 * you are away, so it is on screen when you return and your next message
	 * goes straight through.
	 *
	 * The trade is honest and worth stating: idle is not away. A five-minute
	 * pause spent reading the diff now produces a recap you did not ask for,
	 * where before it produced one only if you left AND came back. That is one
	 * dim line against a bounded wait in front of every returning message, and
	 * `recap.autoOnReturn: false` still turns the whole thing off.
	 */
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let idleCtx: ExtensionContext | undefined;
	/**
	 * Which absence a pending callback belongs to.
	 *
	 * `clearTimeout` is enough to stop a timer that has not fired, but not a
	 * callback already queued, and it says nothing to code that reaches the
	 * callback another way. Bumping this on every disarm lets the callback ask
	 * whether the absence it was scheduled for is still the current one — the
	 * answer is what makes "you came back" actually cancel the recap rather
	 * than merely usually cancel it.
	 */
	let absence = 0;

	const disarm = () => {
		absence += 1;
		if (idleTimer === undefined) return;
		clearTimeout(idleTimer);
		idleTimer = undefined;
	};

	const onIdleElapsed = async (scheduledFor: number) => {
		idleTimer = undefined;
		const ctx = idleCtx;
		if (scheduledFor !== absence) return;
		if (ctx === undefined || state.isGenerating()) return;
		try {
			const { settings } = loadSettings(agentDir, ctx.cwd, ctx.isProjectTrusted());
			const decision = shouldAutoRecap({
				entries: ctx.sessionManager.getBranch() as GateEntry[],
				// The timer having fired IS the elapsed-idle proof — it was set for
				// exactly this threshold when the agent settled — so the gate is
				// told the condition it cannot re-derive here rather than being
				// asked to measure the same gap a second time. Every other
				// condition it checks is still checked.
				idleMs: settings.idleThresholdMs,
				autoOnReturn: settings.autoOnReturn,
				idleThresholdMs: settings.idleThresholdMs,
				minUserTurns: settings.minUserTurns,
				hasPending: ctx.hasPendingMessages(),
			});
			if (!decision.recap) return;
			// The entry still carries the real gap, which is what "away 6m" reads.
			await produce(ctx, "auto", state.idleMs(Date.now()));
		} catch {
			/* the session went away while the timer was pending */
		}
	};

	// The agent going idle is what a later return is measured against, and now
	// also what starts the clock on producing the summary unprompted.
	pi.on("agent_settled", (_event, ctx) => {
		state.markIdle(Date.now());
		disarm();
		if (!ctx.hasUI) return;
		let settings: ReturnType<typeof loadSettings>["settings"];
		try {
			settings = loadSettings(agentDir, ctx.cwd, ctx.isProjectTrusted()).settings;
		} catch {
			return;
		}
		if (!settings.autoOnReturn) return;
		idleCtx = ctx;
		const scheduledFor = absence;
		idleTimer = setTimeout(() => void onIdleElapsed(scheduledFor), settings.idleThresholdMs);
		(idleTimer as { unref?: () => void }).unref?.();
	});

	// The on-return path, now a fallback rather than the usual route. The timer
	// above covers a session that stayed open; this covers the cases it cannot
	// reach — a session resumed from disk, where no `agent_settled` has fired in
	// this process and the idle gap is only visible once you type.
	//
	// It is still held in front of the message so the recap lands above it. That
	// wait is the thing the timer exists to avoid, so it is now paid only when
	// the timer never got the chance to run.
	pi.on("input", async (event, ctx) => {
		// Whatever happens below, the absence is over.
		disarm();
		if (event.source !== "interactive" || event.streamingBehavior !== undefined) return;
		if (!ctx.hasUI || state.isGenerating()) return;

		const { settings } = loadSettings(agentDir, ctx.cwd, ctx.isProjectTrusted());
		const decision = shouldAutoRecap({
			entries: ctx.sessionManager.getBranch() as GateEntry[],
			idleMs: state.idleMs(Date.now()),
			autoOnReturn: settings.autoOnReturn,
			idleThresholdMs: settings.idleThresholdMs,
			minUserTurns: settings.minUserTurns,
			hasPending: ctx.hasPendingMessages(),
		});
		if (!decision.recap) return;

		// Held before the message is processed so the recap lands above it, not in
		// the middle of the reply. Bounded by autoTimeoutMs; on timeout or failure
		// the message simply proceeds.
		await produce(ctx, "auto", state.idleMs(Date.now()));
		// Always pass the message through unchanged.
	});

	pi.registerCommand("recap", {
		description: "Summarise where the session stands",
		handler: async (_args, ctx) => {
			if (!state.begin()) {
				ctx.ui.notify("A recap is already being generated.", "info");
				return;
			}
			try {
				const outcome = await generateRecap(ctx, { agentDir, timeoutMs: CONFIG.timeoutMs, signal: ctx.signal, onSpend: announce });
				switch (outcome.kind) {
					case "ok":
						pi.appendEntry<RecapDetails>(ENTRY_TYPE, { text: outcome.text, trigger: "manual" });
						return;
					case "no-turn":
						ctx.ui.notify("Nothing to recap yet — send a message first.", "info");
						return;
					case "aborted":
						ctx.ui.notify("Recap cancelled.", "info");
						return;
					case "failed":
						ctx.ui.notify(`Couldn't generate a recap: ${outcome.reason}`, "warning");
						return;
				}
			} finally {
				state.end();
			}
		},
	});
}
