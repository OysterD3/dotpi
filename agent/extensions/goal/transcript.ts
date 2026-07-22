/**
 * Turns the session branch into the plain-text transcript the evaluator reads.
 *
 * The evaluator is a separate, tool-less LLM call, so the conversation has to be
 * flattened into text. Tool calls are included: "did you run the tests" is
 * usually answered by a tool call, not by prose.
 *
 * Pure — no pi APIs — so it is testable without a session.
 */

import { CONFIG } from "./config.ts";
import { TRUNCATION_NOTICE } from "./prompts.ts";

type ContentBlock = {
	type?: string;
	text?: string;
	name?: string;
	arguments?: unknown;
};

/** Minimal shape of a session entry; matches SessionMessageEntry structurally. */
export type TranscriptEntry = {
	type: string;
	message?: { role?: string; content?: unknown };
};

function textBlocks(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];

	const out: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ContentBlock;
		if (block.type === "text" && typeof block.text === "string") out.push(block.text);
	}
	return out;
}

function toolCallLines(content: unknown): string[] {
	if (!Array.isArray(content)) return [];

	const out: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ContentBlock;
		if (block.type !== "toolCall" || typeof block.name !== "string") continue;
		out.push(`Tool ${block.name} was called with args ${JSON.stringify(block.arguments ?? {})}`);
	}
	return out;
}

/** One text section per message, oldest first. */
export function buildSections(entries: TranscriptEntry[]): string[] {
	const sections: string[] = [];

	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) continue;

		const role = entry.message.role;
		const isUser = role === "user";
		const isAssistant = role === "assistant";
		if (!isUser && !isAssistant) continue;

		const lines: string[] = [];
		const text = textBlocks(entry.message.content).join("\n").trim();
		if (text.length > 0) lines.push(`${isUser ? "User" : "Assistant"}: ${text}`);
		if (isAssistant) lines.push(...toolCallLines(entry.message.content));

		if (lines.length > 0) sections.push(lines.join("\n"));
	}

	return sections;
}

export type Transcript = {
	text: string;
	/** Messages dropped from the front to fit the budget. */
	dropped: number;
};

/**
 * Flatten and fit to the evaluator's budget, dropping the OLDEST messages first.
 *
 * Dropping from the front rather than the back is the only correct direction
 * here: evidence that a goal was met is almost always in the most recent work.
 */
export function buildTranscript(entries: TranscriptEntry[], contextWindow: number): Transcript {
	const sections = buildSections(entries);
	const budgetChars = Math.floor(
		contextWindow * CONFIG.transcriptBudgetFraction * CONFIG.charsPerToken,
	);

	let used = 0;
	let start = sections.length;
	for (let i = sections.length - 1; i >= 0; i--) {
		const cost = sections[i].length + 2; // section + blank-line separator
		if (start < sections.length && used + cost > budgetChars) break;
		used += cost;
		start = i;
	}

	const kept = sections.slice(start);
	const dropped = sections.length - kept.length;
	const body = kept.join("\n\n");

	return {
		text: dropped > 0 ? `${TRUNCATION_NOTICE(dropped)}\n\n${body}` : body,
		dropped,
	};
}
