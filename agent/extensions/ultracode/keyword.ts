/**
 * The "ultracode" keyword detector, transcribed from Claude Code 2.1.217 (the
 * shared scanner it also uses for "ultraplan" and "ultrareview").
 *
 * A match is a whole word, case-insensitive, EXCEPT when:
 *   - the message is a slash command (starts with "/");
 *   - the word sits inside a quoted or bracketed span — backticks, double
 *     quotes, single quotes, <tags>, {braces}, [brackets], (parens). A single
 *     quote only opens a span when not preceded by a word character, and only
 *     closes one when not followed by a word character, so apostrophes
 *     ("don't") never swallow text. "<" only opens when followed by a letter
 *     or "/", so "a < b" is not a span;
 *   - it is preceded by "/", "\" or "-" (paths, flags, hyphenations);
 *   - it is followed by "/", "\", "-" or "?" — mentioning "ultracode?" as a
 *     question does not trigger;
 *   - it is followed by "." and a word character (filenames like ultracode.ts).
 */

export interface KeywordMatch {
	word: string;
	start: number;
	end: number;
}

const PAIRS: Record<string, string> = {
	"`": "`",
	'"': '"',
	"<": ">",
	"{": "}",
	"[": "]",
	"(": ")",
	"'": "'",
};

function isWordChar(ch: string | undefined): boolean {
	return !!ch && /[\p{L}\p{N}_]/u.test(ch);
}

export function findKeyword(text: string, keyword: string): KeywordMatch[] {
	if (!new RegExp(keyword, "i").test(text)) return [];
	if (text.startsWith("/")) return [];

	// Pass 1: mark quoted/bracketed spans. Claude Code keeps only the innermost
	// "[" when they nest, and never closes an apostrophe mid-word.
	const spans: Array<{ start: number; end: number }> = [];
	let open: string | null = null;
	let openStart = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (open) {
			if (open === "[" && ch === "[") {
				openStart = i;
				continue;
			}
			if (ch !== PAIRS[open]) continue;
			if (open === "'" && isWordChar(text[i + 1])) continue;
			spans.push({ start: openStart, end: i + 1 });
			open = null;
		} else if (
			(ch === "<" && i + 1 < text.length && /[a-zA-Z/]/.test(text[i + 1]!)) ||
			(ch === "'" && !isWordChar(text[i - 1])) ||
			(ch !== "<" && ch !== "'" && ch in PAIRS)
		) {
			open = ch;
			openStart = i;
		}
	}

	// Pass 2: whole-word matches outside those spans and their excluded contexts.
	const matches: KeywordMatch[] = [];
	for (const found of text.matchAll(new RegExp(`\\b${keyword}\\b`, "gi"))) {
		const start = found.index;
		if (start === undefined) continue;
		const end = start + found[0].length;
		if (spans.some((s) => start >= s.start && start < s.end)) continue;
		const before = text[start - 1];
		const after = text[end];
		if (before === "/" || before === "\\" || before === "-") continue;
		if (after === "/" || after === "\\" || after === "-" || after === "?") continue;
		if (after === "." && isWordChar(text[end + 1])) continue;
		matches.push({ word: found[0], start, end });
	}
	return matches;
}

export function hasUltracodeKeyword(text: string): boolean {
	return findKeyword(text, "ultracode").length > 0;
}
