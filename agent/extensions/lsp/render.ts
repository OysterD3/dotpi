/**
 * Collapsed/expanded TUI view for the lsp_diagnostics result, matching the other tools.
 * The model always receives the full text; only the on-screen view collapses.
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { keyHint, truncateToVisualLines, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { CONFIG } from "./config.ts";

const NO_LIMIT = 100_000;

export function bodyText(content: ReadonlyArray<TextContent | ImageContent>): string {
	return content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

/**
 * `keyHint` resolves against pi's global theme and throws when that isn't initialised;
 * a throw here would take out the whole result render.
 */
function expandHint(): string {
	try {
		return keyHint("app.tools.expand", "to expand");
	} catch {
		return "ctrl+o to expand";
	}
}

export function renderCollapsible(body: string, expanded: boolean, theme: Theme): Component {
	return {
		invalidate() {},
		render(width: number): string[] {
			// Wrap first, then keep the head: the summary and the first errors are what
			// matter, not the tail.
			const { visualLines } = truncateToVisualLines(body, NO_LIMIT, width, 0);
			const shown = expanded ? visualLines : visualLines.slice(0, CONFIG.collapsedLines);
			const skipped = visualLines.length - shown.length;

			const lines = [...shown];
			if (skipped > 0) {
				lines.push(theme.fg("dim", `… ${skipped} more line(s) — `) + expandHint());
			}
			return lines;
		},
	};
}
