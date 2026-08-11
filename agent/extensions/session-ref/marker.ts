/**
 * The reference marker: what `#` leaves behind in the prompt, and how it is
 * read back out on submit.
 *
 * `#[Name·id]` asks for the summary, `##[Name·id]` for the full transcript.
 * The brackets make the end of a name unambiguous (session names contain
 * spaces), and the hash count is the mode, so there is nothing to remember
 * beyond "more hashes, more session".
 *
 * ## Why the id is in the text
 *
 * The first version carried the name alone and resolved it through a map this
 * process filled as it offered suggestions. Two sessions can share a display
 * name, so that map could bind one marker to the wrong session — and it could
 * be REBOUND after the fact, because merely rendering a later popup wrote to
 * it. The failure was silent and looked correct: the right name in the header,
 * another conversation in the context.
 *
 * Eight hex characters of the session id fix it at the source. The marker names
 * exactly one session, no process state is needed to read it back, and a marker
 * still resolves after a restart, from another project, or typed by hand.
 *
 * The marker never reaches the model. On submit it is replaced by the name in
 * quotes and the session arrives as its own provenance-wrapped block, so the
 * sentence the user wrote still reads as a sentence — `like "parser rewrite"
 * did`, not `like did`.
 *
 * Pure string transforms, so both directions are directly testable.
 */

export type RefMode = "summary" | "full";

export type Marker = {
	/** The exact text in the prompt, e.g. `#[parser rewrite·0a3f1c2b]`. */
	text: string;
	mode: RefMode;
	/** The readable half, which is all the model is shown. */
	name: string;
	/** Session id prefix, when the marker carries one. Absent on hand-typed markers. */
	id?: string;
	start: number;
	end: number;
};

/** Separates the readable name from the id. Not a trigger character. */
export const ID_SEP = "\u00b7";

/** How much of a session id a marker carries. Collision-free in practice, short enough to read. */
export const ID_CHARS = 8;

/**
 * Three hashes or more is not a deeper mode, it is prose (`### heading`), so
 * the pattern requires the run of hashes to be exactly one or two AND to start
 * at a token boundary. `[^\]\n]` keeps a marker on one line and lets the first
 * `]` end it.
 */
const MARKER = /(?:^|(?<=\s))(#{1,2})\[([^\]\n]{1,80})\]/g;

export function markerText(mode: RefMode, name: string, id?: string): string {
	const tail = id ? `${ID_SEP}${id.slice(0, ID_CHARS)}` : "";
	return `${mode === "full" ? "##" : "#"}[${name}${tail}]`;
}

/**
 * A name safe to put inside `[...]`: no bracket to end the marker early, no
 * newline to split it, no separator to be mistaken for the id, and no leading
 * hash to be read as another marker. Empty after cleaning (a session named only
 * punctuation) falls back rather than producing `#[]`, which the pattern would
 * not match.
 */
export function safeName(raw: string): string {
	const cleaned = raw
		.replace(/[[\]\n\r\u00b7]/g, " ")
		.replace(/\s+/g, " ")
		.replace(/^#+/, "")
		.trim()
		.slice(0, 64)
		.trim();
	return cleaned.length > 0 ? cleaned : "session";
}

export function findMarkers(text: string): Marker[] {
	const found: Marker[] = [];
	for (const match of text.matchAll(MARKER)) {
		// Split on the LAST separator: a session name may contain one.
		const inner = match[2];
		// Anything after the last separator is the id by construction: safeName()
		// strips the separator from names, so a name cannot contain one. Testing
		// the tail for a shape instead would tie this to how ids happen to be
		// generated today.
		const cut = inner.lastIndexOf(ID_SEP);
		const tail = cut === -1 ? "" : inner.slice(cut + ID_SEP.length).trim();
		const hasId = cut !== -1 && tail.length > 0;
		found.push({
			text: match[0],
			mode: match[1] === "##" ? "full" : "summary",
			name: (hasId ? inner.slice(0, cut) : inner).trim(),
			id: hasId ? tail.toLowerCase() : undefined,
			start: match.index,
			end: match.index + match[0].length,
		});
	}
	return found;
}

/**
 * Rewrite every marker through `replace`. Right to left, so an earlier
 * marker's offsets stay valid after a later one changes length.
 */
export function replaceMarkers(text: string, replace: (marker: Marker) => string): string {
	let out = text;
	for (const marker of findMarkers(text).reverse()) {
		out = out.slice(0, marker.start) + replace(marker) + out.slice(marker.end);
	}
	return out;
}

/** What the model sees in place of the marker. Quoted so it reads as a name. */
export function spokenName(marker: Marker): string {
	return `"${marker.name}"`;
}
