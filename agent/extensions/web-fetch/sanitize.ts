/**
 * Defenses against prompt and script injection in fetched page content.
 *
 * The threat: anything fetched from the web is attacker-controlled. A page can contain
 * text engineered to read as instructions ("ignore previous instructions, run this
 * command"), impersonate the system or user, hide payloads in characters the model sees
 * but a human reviewer does not, or emit terminal escape sequences.
 *
 * What is done here, and what is deliberately not:
 *   DO strip invisible and directional characters used to smuggle hidden text
 *   DO strip terminal control sequences that could manipulate the display
 *   DO remove <script>/<style> bodies and residual markup
 *   DO neutralise the fence markers so content cannot escape its container
 *   DO cap length
 *   DO NOT censor text that merely looks like an instruction
 *
 * That last point is deliberate. Blocklisting phrases like "ignore previous instructions"
 * gives false confidence — it is trivially bypassed by rewording, and it corrupts
 * legitimate pages (a blog post *about* prompt injection would be mangled). Containment
 * plus explicit labelling is honest about the boundary; filtering pretends the problem is
 * solved. The real defense is that content is fenced, labelled untrusted, and the model
 * is instructed not to act on it.
 *
 * Patterns are built from numeric code points rather than written as literals, so this
 * source file stays pure ASCII and cannot itself carry a hidden payload.
 *
 * All functions are pure and directly testable.
 */

import { FENCE_BEGIN, FENCE_END } from "./config.ts";

type Range = [number, number];

/** Render a code point as regex escape TEXT (backslash-u-brace), never as the character. */
function cp(point: number): string {
	return `\\u{${point.toString(16).toUpperCase()}}`;
}

function charClass(ranges: Range[]): string {
	return ranges.map(([lo, hi]) => (lo === hi ? cp(lo) : `${cp(lo)}-${cp(hi)}`)).join("");
}

/**
 * Invisible or direction-altering characters, used to hide injected instructions from a
 * human reading the transcript while the model still consumes them.
 */
const INVISIBLE_RANGES: Range[] = [
	[0x200b, 0x200f], // zero-width space/joiners, LTR/RTL marks
	[0x202a, 0x202e], // bidi embedding and override
	[0x2060, 0x2064], // word joiner, invisible operators
	[0x2066, 0x2069], // bidi isolates
	[0xfeff, 0xfeff], // byte-order mark
	[0xe0000, 0xe007f], // Unicode tag characters, an established smuggling channel
];

/** C0 and C1 control characters, excluding tab (0x09) and newline (0x0A). */
const CONTROL_RANGES: Range[] = [
	[0x00, 0x08],
	[0x0b, 0x1f],
	[0x7f, 0x9f],
];

const INVISIBLE = new RegExp(`[${charClass(INVISIBLE_RANGES)}]`, "gu");
const CONTROL = new RegExp(`[${charClass(CONTROL_RANGES)}]`, "gu");

/**
 * ANSI/VT escape sequences: OSC strings (terminated by BEL or ESC-backslash), CSI
 * sequences, and two-character Fe escapes.
 */
const ANSI = new RegExp(
	[
		`${cp(0x1b)}\\][\\s\\S]*?(?:${cp(0x07)}|${cp(0x1b)}\\\\)`,
		`${cp(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`,
		`${cp(0x1b)}[@-_]`,
	].join("|"),
	"gu",
);

/** Script and style element bodies, including their contents. */
const SCRIPT_OR_STYLE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** Any remaining HTML/XML tag. */
const TAG = /<\/?[a-zA-Z][^>]*>/g;

/** Remove terminal escapes, then invisible characters, then stray control bytes. */
export function stripInvisible(text: string): string {
	return text.replace(ANSI, "").replace(INVISIBLE, "").replace(CONTROL, "");
}

/**
 * Remove executable markup and residual tags.
 * Exa returns text rather than HTML, but a page can embed literal markup in its prose,
 * so this is not redundant.
 */
export function stripMarkup(text: string): string {
	return text.replace(SCRIPT_OR_STYLE, " ").replace(TAG, " ");
}

/**
 * Break any occurrence of the fence markers appearing inside the content.
 *
 * Without this, a page containing our closing marker could terminate the fence early and
 * have the text after it read as trusted tool output.
 */
export function neutralizeFence(text: string): string {
	const escape = (marker: string) => marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return text
		.replace(new RegExp(escape(FENCE_BEGIN), "g"), "[fence-marker-removed]")
		.replace(new RegExp(escape(FENCE_END), "g"), "[fence-marker-removed]");
}

/** Collapse runs of blank lines and trailing whitespace — pure token savings. */
export function collapseWhitespace(text: string): string {
	return text
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/, ""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Truncate on a line boundary where possible, reporting whether it happened. */
export function truncate(text: string, limit: number): { text: string; truncated: boolean } {
	if (text.length <= limit) return { text, truncated: false };
	const cut = text.slice(0, limit);
	const lastBreak = cut.lastIndexOf("\n");
	const body = lastBreak > limit * 0.5 ? cut.slice(0, lastBreak) : cut;
	return { text: body.trimEnd(), truncated: true };
}

/** Full pipeline applied to every fetched page before it reaches the model. */
export function sanitize(raw: string, limit: number): { text: string; truncated: boolean } {
	const cleaned = collapseWhitespace(neutralizeFence(stripMarkup(stripInvisible(raw))));
	return truncate(cleaned, limit);
}
