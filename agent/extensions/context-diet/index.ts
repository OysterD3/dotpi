/**
 * context-diet — stop a long turn from paying for context it stopped reading.
 *
 * pi checks whether to compact in exactly two places: after `agent_end`, and
 * before a new prompt. Both are turn boundaries. Inside a turn — however many
 * hundred tool calls it runs — `shouldCompact()` is never reached, so the
 * threshold does nothing and context grows until the provider refuses the
 * request. A session measured before this extension existed ran one turn for
 * 2h44m across 399 model calls: context climbed to 375k against a 272k window,
 * compaction fired only when the API returned "your input exceeds the context
 * window", and a second round fired at `agent_end` after the work was already
 * finished, then went unread.
 *
 * The cost of that is not the compaction. It is that 219 of the 397 calls sat
 * above 272k, where the gpt-5.6 family doubles every rate — $5→$10 per Mtok in,
 * $0.50→$1.00 cached — turning $41 of that session's $126 into surcharge on
 * context nobody was reading.
 *
 * So: trim what gets *sent*, per call, and leave the turn alone. The `context`
 * hook runs on every LLM call inside the loop and rewrites only the copy bound
 * for the provider — `context.messages`, the session and the JSONL are all
 * untouched, so /compact, /rewind, fork and tree navigation still see the full
 * history. Nothing is aborted, which is what rules out the obvious alternative:
 * `ctx.compact()` exists and can be called mid-turn, but it opens with
 * `await this.abort()`, and killing a 2.7-hour harness run to save tokens is
 * not a trade worth making.
 *
 * What gets dropped and why is in diet.ts; how the choice carries across calls
 * is in session.ts. The one thing worth repeating here is that evictions are
 * permanent for the session and their stubs never change, because the prompt
 * cache invalidates from the first byte that differs. A diet that re-decided
 * each call would move that byte every call and bill the whole context at the
 * uncached rate — ten times what it costs cached, and strictly worse than doing
 * nothing at all.
 *
 * Reaches the main session only. Workflow subagents and `subagents` tasks spawn
 * with --no-extensions, and they are not the problem: in the measured session
 * 270 subagent calls cost $5.35 between them, because each one starts empty.
 *
 * Settings (agent settings.json), under "contextDiet":
 *   enabled            boolean, default true
 *   highWaterRatio     number, default 0.8   — fraction of the window that triggers a round
 *   targetRatio        number, default 0.55  — fraction a round trims down to
 *   highWaterTokens    number, default 0     — absolute override for the above
 *   targetTokens       number, default 0
 *   keepRecentResults  number, default 24    — newest results never touched
 *   keepImages         number, default 3     — newest screenshots never touched
 *   minResultBytes     number, default 512   — below this a stub would not pay
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type DietSettings, ENTRY_TYPE, resolveSettings, SETTINGS_KEY } from "./config.ts";
import type { DietEntry } from "./diet.ts";
import { renderDiet } from "./render.ts";
import { createDiet } from "./session.ts";

export function loadSettings(agentDir: string): DietSettings {
	try {
		const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		return resolveSettings(raw?.[SETTINGS_KEY]);
	} catch {
		return resolveSettings(undefined);
	}
}

export default function (pi: ExtensionAPI) {
	const settings = loadSettings(getAgentDir());
	if (!settings.enabled) return;

	const diet = createDiet(settings);

	pi.registerEntryRenderer<DietEntry>(ENTRY_TYPE, (entry, _options, theme) => (entry.data ? renderDiet(entry.data, theme) : undefined));

	// Cleared whenever the message list underneath is replaced wholesale: a
	// toolCallId from the old branch means nothing on the new one. After a
	// compaction the dropped results are gone from context outright and the
	// summary that replaced them is small, so the count starts over there too.
	const reset = () => diet.reset();
	pi.on("session_start", reset);
	pi.on("session_before_switch", reset);
	pi.on("session_before_fork", reset);
	pi.on("session_before_tree", reset);
	pi.on("session_compact", reset);

	pi.on("context", (event, ctx) => {
		const step = diet.step({
			messages: event.messages,
			contextWindow: ctx.model?.contextWindow ?? 0,
			reportedTokens: ctx.getContextUsage()?.tokens,
		});
		if (step.entry) pi.appendEntry<DietEntry>(ENTRY_TYPE, step.entry);
		return step.messages ? { messages: step.messages } : undefined;
	});
}
