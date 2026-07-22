/**
 * Turning Exa results into the compact markdown the model actually reads.
 *
 * Pure functions only — no network, no config mutation — so this module is directly
 * testable.
 */

import { CONFIG } from "./config.ts";
import type { ExaResult } from "./types.ts";

/**
 * Flatten whitespace so a snippet stays on one line, and strip any leading blockquote
 * markers the source page already had — otherwise our own "> " prefix renders as "> >".
 */
export function collapse(text: string): string {
	return text
		.replace(/\s+/g, " ")
		.replace(/^(?:>\s*)+/, "")
		.trim();
}

export function truncate(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`;
}

/**
 * URL with query string and fragment stripped, for dedupe purposes.
 * Falls back to the raw string when it isn't parseable.
 */
export function canonicalUrl(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`.toLowerCase();
	} catch {
		return url.toLowerCase();
	}
}

/** Drop later results that collapse to the same canonical URL as an earlier one. */
export function dedupe(results: ExaResult[]): ExaResult[] {
	if (!CONFIG.dedupeByUrl) return results;
	const seen = new Set<string>();
	const kept: ExaResult[] = [];
	for (const result of results) {
		const key = canonicalUrl(result.url);
		if (key !== undefined) {
			if (seen.has(key)) continue;
			seen.add(key);
		}
		kept.push(result);
	}
	return kept;
}

/** One result as a numbered markdown block: title, URL, metadata, then snippets. */
export function formatResult(result: ExaResult, position: number): string {
	const title = result.title?.trim() || "(untitled)";
	const lines = [`${position}. **${title}**`];
	if (result.url) lines.push(`   ${result.url}`);

	const meta = [
		result.publishedDate ? result.publishedDate.slice(0, 10) : undefined,
		result.author?.trim() || undefined,
	].filter(Boolean);
	if (meta.length > 0) lines.push(`   ${meta.join(" · ")}`);

	const highlights = result.highlights?.filter((highlight) => highlight.trim()) ?? [];
	if (highlights.length > 0) {
		for (const highlight of highlights.slice(0, CONFIG.maxHighlights)) {
			lines.push(`   > ${truncate(collapse(highlight), CONFIG.maxCharsPerHighlight)}`);
		}
	} else if (result.text?.trim()) {
		lines.push(`   ${truncate(collapse(result.text), CONFIG.maxCharsPerResult)}`);
	}

	return lines.join("\n");
}

/** The full tool output: header line then result blocks. */
export function formatResults(
	query: string,
	results: ExaResult[],
	droppedDuplicates: number,
): string {
	const rendered = results.map((result, index) => formatResult(result, index + 1)).join("\n\n");
	// Say so rather than silently returning fewer results than were asked for.
	const deduped = droppedDuplicates > 0 ? ` (${droppedDuplicates} duplicate URL(s) omitted)` : "";
	return `${results.length} result(s) for "${query}"${deduped}:\n\n${rendered}`;
}
