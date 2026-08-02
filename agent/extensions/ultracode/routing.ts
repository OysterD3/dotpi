/**
 * Spotting model names in the prompt that triggers a workflow.
 *
 * Routing is said in the request — "ultracode, use sonnet for implementation
 * and fable to review" — not configured ahead of time. The model reads the
 * request itself, so nothing here parses the mapping; this only notices that
 * the turn names models at all, so the reminder can bind the instruction to
 * that turn ("honor the routing in this request") instead of relying on the
 * model to remember a general rule.
 *
 * The vocabulary is derived from the models actually available, so it follows
 * the registry rather than a hardcoded list of families.
 */

import { resolveModelReference } from "./models.ts";

type ModelLike = { readonly id: string; readonly name?: string; readonly provider: string };

/** Segments too generic to signal "the user named a model". */
const NOISE = new Set([
	"and",
	"api",
	"chat",
	"code",
	"exp",
	"for",
	"instruct",
	"latest",
	"model",
	"preview",
	"the",
	"thinking",
	"use",
	"v",
	"version",
]);

/**
 * Lowercase tokens whose presence in a prompt suggests a model reference.
 *
 * A segment only qualifies if passing it as `model:` would ACTUALLY RESOLVE to
 * one model. That test is `resolveModelReference` itself, so the vocabulary and
 * the resolver cannot disagree — a word that would fail as a reference is not
 * treated as one.
 *
 * This is not a refinement; it is the fix for a bug that killed whole fleets.
 * Splitting ids into segments turns any model called `kimi-for-coding` into the
 * vocabulary word "coding". The reminder built from that vocabulary then tells
 * the model, in the imperative, to call `agent(prompt, { model: "coding" })` —
 * so every prompt about a *coding agent* routed its whole fleet to a reference
 * that matches two kimi models and resolves to neither. Three agents dead, run
 * produced nothing, and the instruction came from us, not from the user.
 *
 * The NOISE list cannot solve this: "coding" and "agent" are exactly the words
 * a coding-agent prompt contains, and the next provider brings its own. Asking
 * whether the word actually names one model is the general form of the rule.
 */
export function modelVocabulary(models: readonly ModelLike[]): Set<string> {
	const vocabulary = new Set<string>();
	const candidates = new Set<string>();
	for (const model of models) {
		const id = model.id.toLowerCase();
		// A full id is explicit enough to stand on its own.
		vocabulary.add(id);
		for (const source of [id, (model.name ?? "").toLowerCase()]) {
			for (const segment of source.split(/[^a-z0-9.]+/)) {
				// Words only: bare numbers and version fragments say nothing.
				if (segment.length < 3 || NOISE.has(segment)) continue;
				if (!/^[a-z][a-z0-9]*$/.test(segment)) continue;
				candidates.add(segment);
			}
		}
	}
	for (const segment of candidates) {
		if (vocabulary.has(segment)) continue;
		if (resolveModelReference(segment, models).ok) vocabulary.add(segment);
	}
	return vocabulary;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Model names mentioned in `text`, in order of first appearance. Matching is
 * whole-word and case-insensitive; the longest match at a position wins, so
 * "claude-sonnet-4-5" is reported once rather than as three fragments.
 */
export function findModelMentions(text: string, vocabulary: Set<string>, limit = 6): string[] {
	if (!text || vocabulary.size === 0) return [];
	const terms = [...vocabulary].sort((a, b) => b.length - a.length);
	const found: Array<{ token: string; at: number }> = [];
	const claimed: Array<{ start: number; end: number }> = [];

	for (const term of terms) {
		const pattern = new RegExp(`(?<![a-z0-9])${escapeRegExp(term)}(?![a-z0-9])`, "gi");
		for (const match of text.matchAll(pattern)) {
			const start = match.index;
			if (start === undefined) continue;
			const end = start + match[0].length;
			// A longer term already covers this span.
			if (claimed.some((span) => start < span.end && end > span.start)) continue;
			claimed.push({ start, end });
			found.push({ token: term, at: start });
		}
	}

	return found
		.sort((a, b) => a.at - b.at)
		.map((entry) => entry.token)
		.slice(0, limit);
}
