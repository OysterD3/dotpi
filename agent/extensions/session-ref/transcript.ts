/**
 * Flattening a foreign session's branch into plain text.
 *
 * Adapted from the recap extension's transcript.ts (same flattening rules, so
 * a session reads the same whether it is being recapped or referenced), with
 * one difference: the budget arrives in CHARACTERS decided by the caller,
 * because `/ref` budgets against the context actually left in the CURRENT
 * session, not against the reading model's window. When the budget is tight
 * the OLDEST messages drop first — the end of a session is where it landed.
 *
 * Pure — no pi APIs — so it is testable without a session.
 */

type ContentBlock = { type?: string; text?: string; name?: string; arguments?: unknown };

export type TranscriptEntry = {
	type: string;
	message?: { role?: string; content?: unknown };
	/** Compaction and branch-summary entries: the text standing in for history. */
	summary?: string;
	/** Custom message entries: extension-injected context. */
	content?: unknown;
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

/**
 * One text section per context-bearing entry, oldest first.
 *
 * More than user/assistant messages carry the story. A compacted session's
 * branch STARTS with a compaction entry whose summary stands in for the
 * entire pre-compaction history — dropping it would silently begin the
 * transcript mid-story, which is exactly the omission this file exists to
 * announce. Branch summaries and injected custom messages enter the foreign
 * session's own context, so they are part of its record too.
 */
export function buildSections(entries: TranscriptEntry[]): string[] {
	const sections: string[] = [];

	for (const entry of entries) {
		if ((entry.type === "compaction" || entry.type === "branch_summary") && typeof entry.summary === "string" && entry.summary.trim()) {
			sections.push(`Summary of earlier work: ${entry.summary.trim()}`);
			continue;
		}

		if (entry.type === "custom_message") {
			const text = textBlocks(entry.content).join("\n").trim();
			if (text.length > 0) sections.push(`Context: ${text}`);
			continue;
		}

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
	dropped: number;
	/** True when even the newest message alone exceeded the budget and was cut. */
	clipped: boolean;
};

function truncationNotice(dropped: number): string {
	return `[${dropped} earlier message${dropped === 1 ? "" : "s"} omitted to fit the context budget]`;
}

/**
 * Flatten and fit to `budgetChars`, dropping the oldest sections first.
 *
 * The budget is a CAP, not a preference. Recap's version of this loop keeps
 * the newest section unconditionally, which is harmless there (the budget is
 * half a model window) — here the budget can be a sliver of remaining
 * context, and a single pasted-file-sized message must not sail through it.
 * When even the newest section is over budget on its own, its TAIL is kept —
 * the end of a message is where it landed — behind an explicit notice.
 */
export function buildTranscript(entries: TranscriptEntry[], budgetChars: number): Transcript {
	const sections = buildSections(entries);
	const budget = Math.max(0, Math.floor(budgetChars));

	let used = 0;
	let start = sections.length;
	for (let i = sections.length - 1; i >= 0; i--) {
		const cost = sections[i].length + 2;
		if (used + cost > budget) break;
		used += cost;
		start = i;
	}

	// Nothing fit whole: keep the tail of the newest section, never nothing.
	if (start === sections.length && sections.length > 0) {
		const newest = sections[sections.length - 1];
		const clippedText = budget > 0 ? newest.slice(-budget) : "";
		const dropped = sections.length - 1;
		const notice = `[${dropped > 0 ? `${dropped} earlier message${dropped === 1 ? "" : "s"} omitted and ` : ""}the final message cut to fit the context budget]`;
		return {
			text: clippedText.length > 0 ? `${notice}\n\n…${clippedText}` : notice,
			dropped,
			clipped: true,
		};
	}

	const kept = sections.slice(start);
	const dropped = sections.length - kept.length;
	const body = kept.join("\n\n");

	return {
		text: dropped > 0 ? `${truncationNotice(dropped)}\n\n${body}` : body,
		dropped,
		clipped: false,
	};
}
