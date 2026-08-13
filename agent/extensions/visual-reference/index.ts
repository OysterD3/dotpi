/**
 * visual-reference — look at the thing you are copying, before you copy it.
 *
 * Two parts of one failure, both measured in real GUI builds:
 *
 *   detect.ts     pi's read tool refuses an oversized line and suggests `sed`.
 *                 For a bundled HTML document that advice is a dead end, and
 *                 the agent's only impression of the mockup was its loader.
 *   guideline.ts  the reference was rendered 12 tool calls AFTER the agent
 *                 started writing its own UI, and looked at a quarter as often
 *                 as the agent's own app.
 *
 * There was a third part, verify.ts: a gate that counted unrendered UI edits
 * and, on agent_end, resumed the agent until it screenshotted something. It is
 * REMOVED, because its evidence for "this is UI work" was the file extension
 * of an edit and nothing else. A one-line money-format fix in a .tsx read as
 * twelve unverified UI edits, and the gate sent an agent with no reference and
 * nothing to look at into a browser: in that session every single agent-browser
 * call came after the gate's follow-up, and none before it. The GUI-copy
 * sessions the gate was built for never reached it — they opened the reference
 * in their first handful of tool calls, hundreds of calls before the gate ever
 * spoke, on the guideline alone. It cost the browser trips it was meant to
 * order, and bought none of them.
 *
 * Nothing of it is kept. A pin producer briefly survived — it marked the
 * reference screenshot on the "context-diet:pin" channel so that image
 * outlived context-diet's eviction pass — and went with the rest: half a
 * removed feature, watching every bash command for a file:// URL, is not worth
 * the handler it takes. context-diet's own pin support stands and is simply
 * unused; anything wanting a result protected publishes on that channel.
 *
 * Settings (agent settings.json — per-machine):
 *   visualReference.enabled     boolean, default true
 *   visualReference.readAdvice  boolean, default true (rewrite read refusals)
 *   visualReference.guideline   boolean, default true (system-prompt rule)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { adviseOnReadResult } from "./detect.ts";
import { VISUAL_REFERENCE_GUIDELINE } from "./guideline.ts";

export const SETTINGS_KEY = "visualReference";

export interface VisualReferenceSettings {
	enabled: boolean;
	readAdvice: boolean;
	guideline: boolean;
}

export const DEFAULT_SETTINGS: VisualReferenceSettings = {
	enabled: true,
	readAdvice: true,
	guideline: true,
};

export function resolveSettings(raw: unknown): VisualReferenceSettings {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_SETTINGS };
	const block = raw as Record<string, unknown>;
	const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
	return {
		enabled: flag(block.enabled, DEFAULT_SETTINGS.enabled),
		readAdvice: flag(block.readAdvice, DEFAULT_SETTINGS.readAdvice),
		guideline: flag(block.guideline, DEFAULT_SETTINGS.guideline),
	};
}

export function loadSettings(agentDir: string): VisualReferenceSettings {
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

	if (settings.readAdvice) {
		pi.on("tool_result", (event) => {
			if (event.toolName !== "read") return;
			const blocks = event.content as Array<{ type?: string; text?: string }>;
			const index = blocks.findIndex((b) => b?.type === "text" && typeof b.text === "string");
			if (index === -1) return;
			const advised = adviseOnReadResult(blocks[index]!.text!);
			if (!advised) return;
			const next = blocks.map((b, i) => (i === index ? { ...b, text: advised } : b));
			// EVERY field is echoed back. pi rebuilds the result from this return
			// value wholesale, so an omitted `details` blanks the renderer and an
			// omitted `usage` loses the call's spend — only `isError` has a
			// fallback. Returning content alone looks right and deletes the rest.
			return { content: next as never, details: event.details, isError: event.isError, usage: event.usage };
		});
	}

	if (settings.guideline) {
		// Appended to the system prompt rather than sent as a message, so it is
		// cached across the turn — the pattern memory/ uses. Never replaces:
		// several extensions chain here.
		pi.on("before_agent_start", (event) => ({
			systemPrompt: `${event.systemPrompt}\n\n${VISUAL_REFERENCE_GUIDELINE}`,
		}));
	}
}
