/**
 * TUI rendering for the web_fetch tool result.
 *
 * The text handed to the model is always complete — only the on-screen view collapses.
 * That matters here: a fetched page is thousands of characters, and pi's default tool
 * renderer does not truncate at all (only bash-execution imports the visual-truncate
 * helper), so a page would otherwise flood the transcript.
 *
 * Expansion is keyboard-driven: `app.tools.expand`, Ctrl+O by default. pi's TUI has no
 * mouse handling, so there is nothing to hook a click to.
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { keyHint, truncateToVisualLines, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { CONFIG } from "./config.ts";

/** Flatten a tool result's content parts into the text to display. */
export function bodyText(content: ReadonlyArray<TextContent | ImageContent>): string {
	return content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

/** Effectively unlimited, without risking arithmetic on Infinity inside the helper. */
const NO_LIMIT = 100_000;

/**
 * The configured hint for `app.tools.expand`, showing whatever key the user has bound.
 *
 * `keyHint` resolves against pi's global theme and throws when that isn't initialised.
 * In the TUI it always is, but a throw here would take out the whole result render, so
 * this degrades to the stock binding instead.
 */
function expandHint(): string {
	try {
		return keyHint("app.tools.expand", "to expand");
	} catch {
		return "ctrl+o to expand";
	}
}

export type FetchDetails = {
	mode?: string;
	fetched?: Array<string | undefined>;
	failed?: Array<{ url?: string; tag?: string }>;
};

/**
 * A component showing `collapsedLines` of output plus an expand hint, and the whole
 * thing once expanded. Truncation happens inside render() because that is where the
 * width is known.
 */
export function renderCollapsible(
	body: string,
	summary: string,
	expanded: boolean,
	theme: Theme,
): Component {
	return {
		invalidate() {},
		render(width: number): string[] {
			// Wrap everything first, then keep the HEAD. truncateToVisualLines keeps the
			// tail, which suits log output but not a fetched page — the top of the document
			// is what you want to see while collapsed.
			const { visualLines } = truncateToVisualLines(body, NO_LIMIT, width, 0);
			const shown = expanded ? visualLines : visualLines.slice(0, CONFIG.collapsedLines);
			const skipped = visualLines.length - shown.length;

			const lines = [theme.fg("muted", summary), ...shown];
			if (skipped > 0) {
				lines.push(theme.fg("dim", `… ${skipped} more line(s) — `) + expandHint());
			}
			return lines;
		},
	};
}

/**
 * Summary line shown above the (possibly collapsed) body.
 * Failures are always named here, so a failed fetch is visible without expanding.
 */
export function summarize(details: FetchDetails | undefined): string {
	const fetched = details?.fetched?.length ?? 0;
	const failed = details?.failed?.length ?? 0;
	const mode = details?.mode ? ` (${details.mode})` : "";
	const failedPart = failed > 0 ? `, ${failed} failed` : "";
	return `${fetched} page(s)${failedPart}${mode}`;
}
