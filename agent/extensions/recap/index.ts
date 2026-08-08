/**
 * /recap — a one-line summary of where the session stands.
 *
 * Two entry points into one generator — a manual `/recap`, and an automatic
 * summary shown when you return to the terminal after being away 5+ minutes. The
 * ideal version knows you were away because the terminal lost and regained focus,
 * and generates the summary *while* you are away so it is ready the instant you
 * return. pi exposes no focus events, so:
 *
 *   - `/recap` is always available and does exactly what it says.
 *   - Auto-on-return is approximated from wall-clock idle — the gap between the
 *     agent going idle and your next message — and generated reactively when you
 *     return, not proactively. It is ON by default (config.ts says why); the
 *     cost is a cheap-model call and a bounded wait in front of your own
 *     message, only after a real absence. Turn it off with
 *     `recap.autoOnReturn: false`.
 *
 * The recap model is configurable: `recap.model` in settings.json, falling back
 * to the active session model. A recap is display-only — information for the
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

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

	// The agent going idle is what a later return is measured against.
	pi.on("agent_settled", () => {
		state.markIdle(Date.now());
	});

	// Automatic recap on return: only genuine idle returns of a typed message.
	pi.on("input", async (event, ctx) => {
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
		// the message simply proceeds. The idle gap that got us here is exactly when
		// a short wait does not matter.
		const idleMs = state.idleMs(Date.now());
		if (!state.begin()) return;
		try {
			const outcome = await generateRecap(ctx, {
				agentDir,
				timeoutMs: CONFIG.autoTimeoutMs,
				signal: ctx.signal,
				onSpend: announce,
			});
			if (outcome.kind === "ok") {
				pi.appendEntry<RecapDetails>(ENTRY_TYPE, { text: outcome.text, trigger: "auto", idleMs });
			}
		} finally {
			state.end();
		}
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
