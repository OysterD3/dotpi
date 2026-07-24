/**
 * Flattening the session branch into the transcript the reviewer model reads.
 *
 * The advisor guidance promises the reviewer sees "the task, every tool call
 * you've made, every result you've seen", so unlike the recap transcript this
 * one includes tool RESULTS as well as calls. Results can be huge (a file read,
 * a long command dump), so each is truncated to a per-result cap, and then the
 * whole transcript is fitted to the reviewer model's context budget by dropping
 * the OLDEST messages first — recent state matters most for advice.
 *
 * Pure: no pi APIs, so it is testable without a session. The entry shape is the
 * structural minimum of a pi message entry (types from pi-ai: user /
 * assistant / toolResult messages; toolCall content blocks).
 */

import { CONFIG } from "./config.ts";

type ContentBlock = {
	type?: string;
	text?: string;
	name?: string;
	arguments?: unknown;
};

export type TranscriptEntry = {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
		toolName?: string;
	};
};

function textBlocks(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const out: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ContentBlock;
		if (block.type === "text" && typeof block.text === "string") out.push(block.text);
	}
	return out.join("\n");
}

function toolCallLines(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	const out: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ContentBlock;
		if (block.type !== "toolCall" || typeof block.name !== "string") continue;
		let args = "";
		try {
			args = JSON.stringify(block.arguments ?? {});
		} catch {
			args = "{…}";
		}
		if (args.length > 300) args = `${args.slice(0, 300)}…`;
		out.push(`  → called ${block.name}(${args})`);
	}
	return out;
}

function truncate(text: string, cap: number): string {
	if (text.length <= cap) return text;
	const omitted = text.length - cap;
	return `${text.slice(0, cap)}\n… [${omitted} more characters truncated]`;
}

/** One text section per user / assistant / toolResult message, oldest first. */
export function buildSections(entries: TranscriptEntry[]): string[] {
	const sections: string[] = [];

	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) continue;
		const role = entry.message.role;

		if (role === "user") {
			const text = textBlocks(entry.message.content).trim();
			if (text) sections.push(`User:\n${text}`);
			continue;
		}

		if (role === "assistant") {
			const lines: string[] = [];
			const text = textBlocks(entry.message.content).trim();
			if (text) lines.push(`Assistant:\n${text}`);
			lines.push(...toolCallLines(entry.message.content));
			if (lines.length > 0) sections.push(lines.join("\n"));
			continue;
		}

		if (role === "toolResult") {
			const name = entry.message.toolName ?? "tool";
			const text = truncate(textBlocks(entry.message.content).trim(), CONFIG.maxToolResultChars);
			sections.push(`Result of ${name}:\n${text || "(no textual output)"}`);
		}
	}

	return sections;
}

export type Transcript = {
	text: string;
	dropped: number;
};

/**
 * Flatten and fit to the reviewer model's budget, dropping the oldest sections
 * first. `contextWindow` is the reviewer model's, defaulting when unknown.
 */
export function buildTranscript(entries: TranscriptEntry[], contextWindow?: number): Transcript {
	const sections = buildSections(entries);
	const window = contextWindow && contextWindow > 0 ? contextWindow : CONFIG.fallbackContextWindow;
	const budgetChars = Math.floor(window * CONFIG.transcriptBudgetFraction * CONFIG.charsPerToken);

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
	const notice =
		dropped > 0
			? `[${dropped} earlier message${dropped === 1 ? "" : "s"} omitted to fit the context window; the most recent state is below.]\n\n`
			: "";

	return { text: `${notice}${body}`, dropped };
}
