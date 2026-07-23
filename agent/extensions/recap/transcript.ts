/**
 * Flattening the session branch into the text the recap model reads.
 *
 * The recap call is tool-less and carries no live conversation, so the branch has
 * to be rendered to plain text. Recent messages matter most for "where do things
 * stand", so when the budget is tight the OLDEST messages are dropped first —
 * the same direction the goal evaluator drops in.
 *
 * Pure — no pi APIs — so it is testable without a session. The entry shape is the
 * structural minimum of a pi message entry.
 */

import { CONFIG } from "./config.ts";
import { truncationNotice } from "./prompts.ts";

type ContentBlock = { type?: string; text?: string; name?: string; arguments?: unknown };

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

/** One text section per user/assistant message, oldest first. */
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

/** Count user messages in the branch, for the auto-recap turn gates. */
export function countUserTurns(entries: TranscriptEntry[]): number {
	let count = 0;
	for (const entry of entries) {
		if (entry.type === "message" && entry.message?.role === "user") count++;
	}
	return count;
}

export type Transcript = {
	text: string;
	dropped: number;
};

/** Flatten and fit to the recap model's budget, dropping the oldest first. */
export function buildTranscript(entries: TranscriptEntry[], contextWindow: number): Transcript {
	const sections = buildSections(entries);
	const budgetChars = Math.floor(contextWindow * CONFIG.transcriptBudgetFraction * CONFIG.charsPerToken);

	let used = 0;
	let start = sections.length;
	for (let i = sections.length - 1; i >= 0; i--) {
		const cost = sections[i].length + 2;
		if (start < sections.length && used + cost > budgetChars) break;
		used += cost;
		start = i;
	}

	const kept = sections.slice(start);
	const dropped = sections.length - kept.length;
	const body = kept.join("\n\n");

	return {
		text: dropped > 0 ? `${truncationNotice(dropped)}\n\n${body}` : body,
		dropped,
	};
}
