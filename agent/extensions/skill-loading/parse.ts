/**
 * Finding, reading and rewriting the `<available_skills>` block in pi's system
 * prompt.
 *
 * ## Why edit the prompt instead of the skill list
 *
 * pi has no extension hook that removes a skill. `resources_discover` only lets
 * an extension *add* paths, and the `skillsOverride` seam in resource-loader.js
 * is an SDK option, not something an extension is handed. What an extension does
 * get is `before_agent_start`, which can return a replacement system prompt —
 * so that is where this works.
 *
 * Editing pi's own output has one large advantage over re-deriving it: the list
 * being edited *is* the list pi loaded. Names, descriptions and absolute paths
 * all come from pi's discovery, across every directory it searches and every
 * package that contributed one, so this extension cannot disagree with pi about
 * which skills exist or where they live. Reimplementing discovery would have
 * meant duplicating those rules and then drifting from them.
 *
 * ## Failing open
 *
 * The cost is a dependency on a format this repo does not own. Every function
 * here treats "I do not recognise this" as "change nothing": an absent block, an
 * unterminated one, or entries that do not parse all leave the prompt byte-identical.
 * The failure mode of guessing wrong would be a silently
 * truncated system prompt — the model losing instructions with nothing to show
 * for it — and no amount of token saving is worth that risk.
 *
 * Pure: no filesystem, no pi APIs.
 */

import { CLOSE, OPEN, PREAMBLE } from "./config.ts";

export type SkillEntry = {
	name: string;
	description: string;
	/** Absolute path to SKILL.md, as pi resolved it. */
	location: string;
	/** The entry's own `<skill>…</skill>` text, reused verbatim when kept. */
	raw: string;
};

export type SkillsSection = {
	/** Offset of the first character this extension may replace. */
	start: number;
	/** Offset just past the last character this extension may replace. */
	end: number;
	entries: SkillEntry[];
};

/** XML entities pi's `escapeXml` produces, reversed. */
export function unescapeXml(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		// Ampersand last, so `&amp;lt;` round-trips to `&lt;` rather than `<`.
		.replace(/&amp;/g, "&");
}

const ENTRY =
	/<skill>\s*<name>([\s\S]*?)<\/name>\s*<description>([\s\S]*?)<\/description>\s*<location>([\s\S]*?)<\/location>\s*<\/skill>/g;

/**
 * Locate the block and read the skills out of it, or undefined when this prompt
 * does not have one to edit.
 *
 * `start` reaches back over the preamble when it is there, so a rewrite that
 * keeps nothing can remove the introduction along with the list. The two
 * markers are searched with `lastIndexOf`/`indexOf` rather than a single regex
 * so a description that happens to contain the literal text of a marker cannot
 * confuse the bounds — descriptions are author-written and one of the skills in
 * this very repo is about writing skills.
 */
export function findSkillsSection(prompt: string): SkillsSection | undefined {
	const open = prompt.lastIndexOf(OPEN);
	if (open === -1) return undefined;

	const close = prompt.indexOf(CLOSE, open);
	if (close === -1) return undefined;

	const end = close + CLOSE.length;
	const body = prompt.slice(open + OPEN.length, close);

	const entries: SkillEntry[] = [];
	ENTRY.lastIndex = 0;
	for (const match of body.matchAll(ENTRY)) {
		entries.push({
			name: unescapeXml(match[1]!.trim()),
			description: unescapeXml(match[2]!.trim()),
			location: unescapeXml(match[3]!.trim()),
			raw: match[0]!,
		});
	}

	// A block we cannot read is a block we must not rewrite.
	if (entries.length === 0) return undefined;

	const preamble = prompt.lastIndexOf(PREAMBLE, open);
	// Only when it really is this block's preamble, not an older one further up.
	let start = preamble === -1 ? open : preamble;

	// pi joins the section onto the prompt with exactly "\n\n". Those belong to
	// the section, not to what precedes it: leaving them behind when every skill
	// is hidden turns the seam into a run of four blank-ish newlines. At most two
	// are taken, so a deliberate run of blank lines in the prompt above survives.
	for (let taken = 0; taken < 2 && start > 0 && prompt[start - 1] === "\n"; taken++) start--;

	return { start, end, entries };
}

/**
 * The replacement text for the section: the kept entries, in their original
 * order and wording.
 *
 * Entries are re-emitted from `raw` rather than rebuilt from the parsed fields,
 * so anything in pi's format this file does not model — an attribute, a new
 * child element — survives being filtered rather than being silently dropped.
 */
export function renderSection(prompt: string, section: SkillsSection, kept: SkillEntry[]): string {
	if (kept.length === 0) return "";

	// Everything from the preamble through the opening marker, exactly as pi wrote
	// it — including the blank line and the two instruction sentences.
	const head = prompt.slice(section.start, prompt.indexOf(OPEN, section.start) + OPEN.length);

	// `raw` starts at `<skill>` and carries its own inner indentation, so only the
	// two spaces pi puts before each entry have to be reapplied here.
	return `${head}${kept.map((entry) => `\n  ${entry.raw}`).join("")}\n${CLOSE}`;
}
