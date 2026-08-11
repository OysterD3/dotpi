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
} as const;
