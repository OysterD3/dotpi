/**
 * Parsing `[--quick|--standard|--deep] <question>`.
 *
 * The depth is a FLAG here rather than a leading positional word, which is the
 * one place this deliberately differs from /code-review. That command's target
 * is a path or a ref, so a bare first word is almost never a real target and
 * guessing costs little. A research question is free text, and "deep learning
 * on small datasets" opens with a depth name. Positional would have eaten it.
 *
 * Pure, so the whole table of inputs is testable without a session.
 */

import { CONFIG, type Depth, DEPTHS } from "./config.ts";

export type ParsedArgs = {
	depth: Depth;
	/** Everything that was not a flag: the question, whitespace-normalised. */
	question: string;
	/** Flags that are not a depth, kept so the caller can complain. */
	unknownFlags: string[];
	/** A second depth flag, kept so the caller can say which one won. */
	extraDepths: string[];
};

function asDepth(word: string): Depth | undefined {
	const bare = word.replace(/^--/, "").toLowerCase();
	return (DEPTHS as readonly string[]).includes(bare) ? (bare as Depth) : undefined;
}

/** Split a raw command argument string into words. */
export function tokenize(raw: string): string[] {
	return raw.trim().split(/\s+/).filter(Boolean);
}

export function parseArgs(raw: string): ParsedArgs {
	const words = tokenize(raw);
	const rest: string[] = [];
	const unknownFlags: string[] = [];
	const depths: Depth[] = [];
	const extraDepths: string[] = [];

	for (const word of words) {
		if (!word.startsWith("--")) {
			rest.push(word);
			continue;
		}
		const depth = asDepth(word);
		if (depth === undefined) {
			unknownFlags.push(word);
			continue;
		}
		// First one wins, and the rest are reported rather than silently dropped:
		// "--quick --deep" is a person changing their mind mid-line, and running
		// the deep sweep because it was typed last is the expensive misreading.
		if (depths.length === 0) depths.push(depth);
		else extraDepths.push(word);
	}

	return {
		depth: depths[0] ?? CONFIG.defaultDepth,
		question: rest.join(" "),
		unknownFlags,
		extraDepths,
	};
}

/**
 * A filesystem-safe stem for the question, for the report and its source directory.
 *
 * Capped, because the question is arbitrary user text and a 300-character path
 * component fails on some filesystems and is unreadable on all of them. Empty
 * input returns "research" rather than "": a nameless file is worse than a
 * generic one.
 */
export function slugify(question: string, max = 48): string {
	const slug = question
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, max)
		.replace(/-+$/, "");
	return slug || "research";
}
