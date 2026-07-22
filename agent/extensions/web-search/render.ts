/**
 * TUI rendering for the web_search tool result.
 *
 * The text handed to the model is always complete — only the on-screen view collapses.
 * pi's default tool renderer does not truncate at all (only bash-execution imports the
 * visual-truncate helper), so long results otherwise fill the transcript.
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

export type SearchDetails = {
	query?: string;
	results?: Array<{ title?: string; url?: string }>;
};

/**
 * A component that shows `collapsedLines` of output plus a hint, and the whole thing
 * once expanded. Truncation happens inside render() because that is where the width is
 * known.
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
			// tail, which suits log output but not a ranked list — the first result is the
			// one worth seeing while collapsed.
			const { visualLines } = truncateToVisualLines(body, NO_LIMIT, width, 0);
			const shown = expanded ? visualLines : visualLines.slice(0, CONFIG.collapsedLines);
			const skipped = visualLines.length - shown.length;

			// The body already opens with the result count, so an extra summary line would
			// just repeat it.
			const lines = summary ? [theme.fg("muted", summary), ...shown] : [...shown];
			if (skipped > 0) {
				lines.push(theme.fg("dim", `… ${skipped} more line(s) — `) + expandHint());
			}
			return lines;
		},
	};
}

/** Summary line shown above the (possibly collapsed) body. */
export function summarize(details: SearchDetails | undefined): string {
	const count = details?.results?.length ?? 0;
	const query = details?.query ? ` for "${details.query}"` : "";
	return `${count} result(s)${query}`;
}
