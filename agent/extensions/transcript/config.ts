/**
 * The gutter marks, and the colour role each one is painted in.
 *
 * Widths matter as much as the glyphs: the patched components render their
 * content into `width - visibleWidth(mark)` columns and put the mark in the
 * space that leaves, so a wider mark indents its block further. `toolMark` is
 * four columns because a tool call sits *under* the assistant line that made
 * it — mark at column 2, text at column 4.
 */
export const CONFIG = {
	/** Opens an assistant block. Text lands at column 2. */
	assistantMark: "●",
	assistantColor: "accent",
	/** Opens a user turn, outside the background bar. */
	userMark: "▸",
	userColor: "muted",
	/** Opens a tool call, nested under the assistant line above it. */
	toolMark: "  ∟ ",
	toolColor: "dim",
	/**
	 * The same mark for a call that failed. Dropping the box drops the red
	 * tint that was pi's only sign of a failure, so the mark carries it
	 * instead — otherwise a failed command reads exactly like one that worked.
	 */
	toolErrorColor: "error",
} as const;
