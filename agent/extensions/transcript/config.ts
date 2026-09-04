/**
 * The gutter marks, and the colour role each one is painted in.
 *
 * Widths matter as much as the glyphs: a patched component renders its content
 * into `width - visibleWidth(mark)` columns and puts the mark in the space that
 * leaves, so a wider mark indents its block further. Every glyph here is one
 * terminal cell wide, which is checked rather than assumed — `visibleWidth`
 * measures the marks, so a two-cell glyph would indent correctly rather than
 * drift, but the columns quoted below assume one.
 *
 * A tool call is two blocks, not one. The call opens at column 0 under its own
 * dot, coloured by how it turned out; its result hangs below at column 2 under
 * a corner, text at column 5. That is the shape being matched:
 *
 *     ● $ echo "Hello World"
 *       ⎿  Hello World
 */
export const CONFIG = {
	/** Opens an assistant block. Text lands at column 2. */
	assistantMark: "●",
	assistantColor: "text",

	/** Opens a user turn, outside the background bar. */
	userMark: ">",
	userColor: "muted",

	/** Opens a tool call. Rendered without pi's own padding, so it carries its own. */
	callMark: "● ",
	/** How the call turned out — the dot is the only place that says so now. */
	callOkColor: "success",
	callErrorColor: "error",
	callPendingColor: "muted",

	/** Opens the call's result, indented under it. Text lands at column 5. */
	resultMark: "  ⎿  ",
	resultColor: "dim",

	/**
	 * pi's own tools whose `renderShell: "self"` is a mechanical choice — the
	 * shell that keeps a large preview stable while it streams — rather than an
	 * author's framing. They are unboxed and folded like every other built-in,
	 * and once one has settled it draws as a single line carrying its diff's
	 * counts: the diff itself is the diff panel's to show, and ctrl+o brings it
	 * back here.
	 */
	ownSelfShell: ["edit"] as readonly string[],
	/** The counts after a settled edit: lines added, lines removed. */
	countAddedColor: "success",
	countRemovedColor: "error",

	/**
	 * How many settled tool calls in a row before they collapse to one summary
	 * line. Two, because one is not "several": a lone call's output is usually
	 * the thing being looked at, and hiding it would cost more than the line it
	 * saves. A run of two or more is where the transcript stops being readable.
	 */
	collapseFrom: 2,
	/**
	 * Opens a collapsed run. The same dot a call gets — it stands for calls.
	 *
	 * `dim`, not `muted`: the line exists to say "nothing here needs you", and
	 * at muted it read as bright as the answer above it. It should be the
	 * quietest thing on the screen, next to the diet's own notice.
	 */
	summaryColor: "dim",
} as const;
