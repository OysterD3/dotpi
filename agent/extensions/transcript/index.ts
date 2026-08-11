/**
 * transcript — draws the transcript column the way Claude Code draws it.
 *
 * pi's transcript reads as a stack of filled panels: a user turn is a bar of
 * background colour, an assistant turn is unmarked prose indented one column,
 * and every tool call is a full-width box tinted green, red or grey by its
 * outcome. On a turn that reads four files and runs three commands the boxes
 * are most of the screen, and the tint carries information — succeeded — that
 * the reader already had from the output inside it.
 *
 * Claude Code's transcript is the same information with the panels taken away.
 * One mark opens each block and the text hangs off it:
 *
 *     ▸ Review my chat with Glendon
 *
 *     ● Done. 405 tests pass, ruff clean. The log line above is a real send —
 *       method, path, params, and nothing else.
 *
 *       ∟ read src/app/config.py
 *
 * That is what this extension does, and all it does: it reserves a gutter and
 * puts a mark in it, and it steps around the box a tool call is drawn in. The
 * content of every block — pi's markdown, its diffs, its highlighted source,
 * its command output — is untouched.
 *
 * ## The mechanism, and what it costs
 *
 * pi exposes no hook for its own transcript; `registerMessageRenderer` and
 * `registerEntryRenderer` are keyed by a custom type and only ever draw
 * entries an extension invented. So this patches the `render` method on the
 * three component classes pi exports publicly. That is sound — pi's extension
 * loader aliases the package to the running `dist/index.js`, so the classes an
 * extension imports are the objects `interactive-mode.js` builds from, which
 * this repo confirmed by identity before the code was written — but it is a
 * reach into internals that carry no compatibility promise.
 *
 * The limit follows from that, and is the honest headline: **a pi upgrade can
 * silently revert the transcript to stock**. Every patch is wrapped in a
 * try/catch that falls back to the original renderer, so the failure mode is
 * losing the marks, never losing the session — but nothing here will warn you
 * that it happened. Verified against pi 0.84.1.
 *
 * Three kinds of tool call keep pi's own framing, because restyling them would
 * be worse than leaving them alone: any tool an extension registered a
 * renderer for (its author already chose how it looks — this repo's workflow
 * panel and advisor progress rows both rely on that), any tool that draws its
 * own frame, and any result carrying images. See `patch.ts`.
 *
 * There is no settings block. The extension either draws the transcript or it
 * does not, and deleting the folder is the off switch.
 */
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyPatches, setPaint } from "./patch.ts";

/**
 * pi's live theme, which is a proxy onto whichever theme is current, so a
 * `/theme` switch repaints the marks with everything else.
 *
 * It is reached by path rather than by import because pi re-exports its Theme
 * *class* publicly but not the active *instance*. `process.argv[1]` is pi's
 * own `dist/cli.js` under every launcher it ships, and the module that sits
 * beside it is the one already loaded — so this resolves the same singleton
 * the components paint with, not a second copy of it.
 */
async function loadPaint(): Promise<void> {
	const themeModule = join(dirname(process.argv[1] ?? ""), "modes", "interactive", "theme", "theme.js");
	const { theme } = (await import(themeModule)) as {
		theme: { fg(color: string, text: string): string };
	};
	setPaint((color, text) => theme.fg(color, text));
}

export default function (_pi: ExtensionAPI) {
	applyPatches();

	// Fire and forget: the marks render unpainted until this lands, which is
	// long before a session draws its first line, and an old or repackaged pi
	// that has moved the theme module leaves them unpainted rather than
	// unrendered.
	void loadPaint().catch(() => {});
}
