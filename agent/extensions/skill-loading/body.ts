/**
 * Reading a skill's body for `preload` mode, within a budget.
 *
 * The frontmatter goes because it is already in the prompt: pi's own entry
 * carries the name and description, so re-sending the YAML block would pay twice
 * for the same two fields and hand the model a second, differently-shaped copy
 * of them.
 *
 * The budget is the whole reason this mode is safe to offer. A preloaded skill
 * is re-sent on every request for the rest of the session, so one large
 * SKILL.md — and skills are often long, since being long is what makes them
 * worth having — could quietly cost more than every other skill's listing put
 * together. Two ceilings rather than one: per-skill so a single file cannot
 * dominate, and total so a config that preloads six of them cannot.
 *
 * Truncation is announced in the text rather than done silently. A model reading
 * instructions that stop mid-sentence has no way to know that is what happened,
 * and the pointer to the file is what lets it recover.
 */

import { readFileSync } from "node:fs";

export type LoadedBody = {
	name: string;
	location: string;
	text: string;
	truncated: boolean;
};

/**
 * Strip a leading YAML frontmatter block.
 *
 * Only a block that starts on the very first line counts, and only `---`. A
 * horizontal rule further down the file is content, not a delimiter, and an
 * unterminated opener means the file is not frontmatter-shaped at all — in which
 * case the whole thing is body, which is the reading that cannot lose text.
 */
export function stripFrontmatter(raw: string): string {
	if (!raw.startsWith("---")) return raw;

	const firstBreak = raw.indexOf("\n");
	if (firstBreak === -1) return raw;
	if (raw.slice(3, firstBreak).trim() !== "") return raw;

	const end = raw.indexOf("\n---", firstBreak);
	if (end === -1) return raw;

	const afterMarker = raw.indexOf("\n", end + 1);
	return afterMarker === -1 ? "" : raw.slice(afterMarker + 1).replace(/^\n+/, "");
}

/**
 * Read the bodies for `skills`, in order, until the total budget runs out.
 *
 * A skill that does not fit is dropped rather than included empty, and a skill
 * whose file cannot be read is dropped rather than reported as a failure — it
 * still has its `<available_skills>` entry pointing at the path, so the model's
 * fallback is exactly what `name` mode would have given it.
 */
export function loadBodies(
	skills: ReadonlyArray<{ name: string; location: string }>,
	limits: { maxCharsPerSkill: number; maxChars: number },
): LoadedBody[] {
	const loaded: LoadedBody[] = [];
	let budget = limits.maxChars;

	for (const skill of skills) {
		if (budget <= 0) break;

		let raw: string;
		try {
			raw = readFileSync(skill.location, "utf8");
		} catch {
			continue;
		}

		const body = stripFrontmatter(raw).trim();
		if (body.length === 0) continue;

		const limit = Math.min(limits.maxCharsPerSkill, budget);
		const truncated = body.length > limit;
		const text = truncated ? body.slice(0, limit) : body;

		budget -= text.length;
		loaded.push({ name: skill.name, location: skill.location, text, truncated });
	}

	return loaded;
}

/** The block appended to the system prompt, or "" when nothing was preloaded. */
export function renderBodies(bodies: LoadedBody[]): string {
	if (bodies.length === 0) return "";

	const parts = bodies.map((body) => {
		const note = body.truncated
			? ` truncated="true"` : "";
		const tail = body.truncated
			? `\n\n[Truncated to fit the preload budget. Read ${body.location} for the rest.]`
			: "";
		return `<skill_instructions name="${body.name}" path="${body.location}"${note}>\n${body.text}${tail}\n</skill_instructions>`;
	});

	return [
		"",
		"",
		"The full instructions for these skills are already below — use them directly, without reading their files first.",
		"",
		...parts,
	].join("\n");
}
