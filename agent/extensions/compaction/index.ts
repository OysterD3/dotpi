/**
 * compaction — make the summary shed as well as accumulate, and stop paying max
 * reasoning to write it.
 *
 * Two things were wrong with the default path on a long session:
 *
 *  1. The update prompt is effectively append-only (see instructions.ts), so the
 *     summary — the one thing that survives every compaction — is the one thing
 *     that only ever grows.
 *  2. pi passes the SESSION's thinking level to the summarizer. With
 *     defaultThinkingLevel "max", every compaction writes its summary at max
 *     reasoning, and reasoning bills at output rates. Summarizing is mostly
 *     transcription; it does not earn that.
 *
 * Rather than reimplement compaction, this calls pi's own exported compact()
 * with different arguments. Everything genuinely hard — the split-turn prefix
 * summary, the read/modified file lists, the previous-summary merge — stays
 * pi's code and keeps working.
 *
 *   config.ts        settings, and why they share pi's `compaction` block
 *   instructions.ts  the steering text (pure)
 *   steer.ts         the decision, with compact() injected (testable)
 *
 * An extension cannot reach pi's retry settings or stream function, so this
 * call has no retry behind it where pi's own does. Every failure path returns
 * undefined, which makes pi run its built-in compaction exactly as if this
 * extension were absent. The steering is an optimisation, never a dependency.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compact, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type CompactionSettings, DEFAULT_SETTINGS, resolveSettings, SETTINGS_KEY } from "./config.ts";
import { type CompactFn, steerCompaction } from "./steer.ts";
import { shouldTrigger } from "./threshold.ts";

export function loadSettings(agentDir: string): CompactionSettings {
	try {
		const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		return resolveSettings(raw?.[SETTINGS_KEY]);
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export default function (pi: ExtensionAPI) {
	const settings = loadSettings(getAgentDir());

	if (settings.steer) {
		pi.on("session_before_compact", async (event, ctx) => {
			const result = await steerCompaction(event as never, ctx as never, settings, compact as unknown as CompactFn);
			return result as never;
		});
	}

	if (settings.compactAtPercent > 0 || settings.compactAtTokens > 0) {
		// ctx.compact() does not await, so without this the next turn_end would
		// see the same over-threshold reading and ask again. pi reports tokens as
		// null while a compaction is in flight, which is not enough on its own:
		// null is also what it reports at other times.
		let pending = false;
		pi.on("session_compact", () => {
			pending = false;
		});

		// agent_settled, NOT turn_end. Compaction rewrites the branch, so it has to
		// happen between runs rather than inside one — and turn_end is inside one.
		// pi emits it from agent-loop.js, which runs within _runAgentPrompt where
		// _isAgentRunActive is still true, and ctx.isIdle is literally
		// `() => !this._isAgentRunActive`. So the idle guard below was false on
		// every single turn_end and this whole feature never once fired.
		//
		// agent_settled is emitted from _emitAgentSettled, which clears the flag on
		// its first line and is documented as running after "no automatic retry,
		// compaction, or queued continuation will run" — exactly the moment a
		// branch rewrite is safe. The isIdle check is kept as a cheap assertion
		// rather than load-bearing logic: it is now expected to be true.
		pi.on("agent_settled", (_event, ctx) => {
			if (pending || !ctx.isIdle()) return;
			if (!shouldTrigger(ctx.getContextUsage(), settings)) return;
			pending = true;
			ctx.compact({
				// A failed threshold compaction is not worth interrupting anyone
				// over — pi's own trigger is still underneath, and the next turn
				// will ask again.
				onError: () => {
					pending = false;
				},
			});
		});
	}
}
