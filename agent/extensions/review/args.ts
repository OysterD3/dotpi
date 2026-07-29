/**
 * Parsing `[level] [--fix] [<target>]` for both commands.
 *
 * The level is optional AND positional, which is the whole difficulty: the
 * first word is a level only if it *is* one, and otherwise it is the start of
 * the target. Getting that backwards silently reviews the wrong thing —
 * `/code-review HEAD~1` must not become "no target" and quietly widen to the
 * entire diff.
 *
 * That means the "did you mistype a level?" rule has to be narrow. An earlier
 * version guessed from shape (one short word, no slash or dot) and swallowed
 * `HEAD~1`, `main`, `src`, `Makefile` and bare PR numbers — every one of them a
 * legitimate target. The rule is now purely lexical: a word counts as a
 * mistyped level only if it and a real level are prefixes of one another, so
 * `hi`→high and `maximum`→max are caught while `main` and `max` stay distinct.
 *
 * Pure, so the whole table of inputs is testable without a session.
 */

import { CONFIG, LEVELS, type Level } from "./config.ts";

export type ParsedArgs = {
	level: Level;
	/** Everything that was not a level or a flag: a path, a ref range, a PR number. */
	target: string;
	/** Whether to apply the findings after reporting them. */
	fix: boolean;
	/** A first word that was almost a level, kept so it can be warned about. */
	unrecognizedLevel?: string;
	/** Flags that are not `--fix`, kept so they can be warned about. */
	unknownFlags: string[];
};

function isLevel(word: string): word is Level {
	return (LEVELS as readonly string[]).includes(word);
}

/**
 * Whether `word` is close enough to a level to be a typo rather than a target.
 *
 * Prefix in either direction, both ways round: "hi" is a prefix of "high",
 * "maximum" has "max" as a prefix. "main" is neither for any level, so it
 * survives as a target — which is the case that matters.
 */
export function nearLevel(word: string): boolean {
	const lower = word.toLowerCase();
	return LEVELS.some((level) => level.startsWith(lower) || lower.startsWith(level));
}

/** Split the flags off, keeping any we do not recognise so the caller can complain. */
export function splitFlags(words: string[]): { rest: string[]; fix: boolean; unknownFlags: string[] } {
	const rest: string[] = [];
	const unknownFlags: string[] = [];
	let fix = false;

	for (const word of words) {
		if (!word.startsWith("-")) {
			rest.push(word);
			continue;
		}
		// Case-insensitive: the level is lowercased too, and `--FIX` silently
		// becoming a review target is worse than accepting a shouted flag.
		if (word.toLowerCase() === "--fix") fix = true;
		else unknownFlags.push(word);
	}

	return { rest, fix, unknownFlags };
}

/** Split a raw command argument string into words. */
export function tokenize(raw: string): string[] {
	return raw.trim().split(/\s+/).filter(Boolean);
}

export function parseArgs(raw: string): ParsedArgs {
	const { rest, fix, unknownFlags } = splitFlags(tokenize(raw));

	const first = rest[0]?.toLowerCase();
	if (first !== undefined && isLevel(first)) {
		return { level: first, target: rest.slice(1).join(" "), fix, unknownFlags };
	}

	// Only a lone near-miss is a typo. With more words following, the first word
	// is the start of a target however level-ish it looks.
	const mistyped = rest.length === 1 && first !== undefined && nearLevel(first);

	return {
		level: CONFIG.defaultLevel,
		target: mistyped ? "" : rest.join(" "),
		fix,
		unrecognizedLevel: mistyped ? rest[0] : undefined,
		unknownFlags,
	};
}
