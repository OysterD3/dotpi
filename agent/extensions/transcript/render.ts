/**
 * Pure line surgery: put a mark in the left gutter of a rendered block.
 *
 * Everything here works on lines that already carry colour, so nothing may
 * measure a string by its length or slice it at an index that counts escape
 * bytes. Widths come from pi's own `visibleWidth`, and the only slicing done
 * is at the boundary of a leading OSC sequence, which is found by pattern
 * rather than by position.
 */
import { visibleWidth } from "@earendil-works/pi-tui";

/** One OSC string: ESC ] ... terminated by BEL or by ST. */
const OSC = "\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)";

/** SGR colours and OSC strings — both occupy no columns. */
const ANSI = new RegExp(`\\u001b\\[[0-9;?]*[A-Za-z]|${OSC}`, "g");

/** An OSC run at the head of a line, which must stay at column 0. */
const LEADING_OSC = new RegExp(`^(?:${OSC})+`);

/** True when a line shows nothing — blank, or colour codes over spaces. */
export function isBlank(line: string): boolean {
	return line.replace(ANSI, "").trim() === "";
}

/**
 * Inserts `gutter` at column 0.
 *
 * pi marks the first and last line of a message with OSC 133 shell-integration
 * escapes, and a terminal reads those as "a zone starts here" only while they
 * lead the line. So a leading OSC run keeps its place and the gutter goes in
 * behind it.
 */
export function prefix(line: string, gutter: string): string {
	const osc = LEADING_OSC.exec(line)?.[0] ?? "";
	return osc + gutter + line.slice(osc.length);
}

/**
 * Puts `mark` beside the first line that shows anything, and blanks of the
 * same width beside every other line — a hanging indent, so a wrapped
 * paragraph stays aligned under its own first word rather than under the mark.
 *
 * The first line of a block is usually pi's own spacer, which is why the mark
 * hunts for the first *visible* line instead of taking line 0.
 */
export function withGutter(lines: string[], mark: string): string[] {
	const blank = " ".repeat(visibleWidth(mark));
	let marked = false;
	return lines.map((line) => {
		// A line that draws no columns is pi's spacer — empty, or nothing but
		// the OSC 133 marker it carries. Widening it to a run of spaces would
		// put trailing whitespace into every copied transcript and buy nothing.
		// A line of *painted* blanks is different: that is the background bar
		// behind a user turn, and it has to keep its full width.
		if (visibleWidth(line) === 0) return line;
		if (marked || isBlank(line)) return prefix(line, blank);
		marked = true;
		return prefix(line, mark);
	});
}

/** Drops the blank lines a block's own padding leaves at its edges. */
export function trimBlank(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && isBlank(lines[start] ?? "")) start += 1;
	while (end > start && isBlank(lines[end - 1] ?? "")) end -= 1;
	return lines.slice(start, end);
}
