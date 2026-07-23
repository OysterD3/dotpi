/**
 * Resolving a workflow agent's model reference ("sonnet", "fable",
 * "openai-codex/gpt-5.4-mini") to an actual registry model.
 *
 * This lets the user's natural-language routing policy ("use sonnet for
 * implementation, use fable to review") work end to end: the main agent reads
 * the policy from the tool description and passes short references via
 * agent()'s model option; this resolver turns them into canonical
 * provider/id pairs before the subagent is spawned, so a typo or an ambiguous
 * reference fails that agent with a clear message instead of silently running
 * on the wrong model.
 *
 * The matching rules are pi's own `--model` rules, reproduced against the
 * ModelRegistry list (pi's resolver is not exported to extensions) — the same
 * transcription the recap extension uses:
 *
 *   1. canonical `provider/id`            exact, case-insensitive
 *   2. `provider/id` split               exact provider + exact id
 *   3. bare `id`                         exact, but rejected if ambiguous
 *   4. partial                           substring of id or name; prefer an alias
 */

type ModelLike = { readonly id: string; readonly name?: string; readonly provider: string };

export type Resolution<M> =
	| { ok: true; model: M }
	| { ok: false; error: string };

/** True for an undated alias id like `claude-haiku-4-5` (no trailing `-YYYYMMDD`). */
function isAlias(id: string): boolean {
	return !/-\d{8}$/.test(id);
}

function exactMatch<M extends ModelLike>(reference: string, models: readonly M[]): M | undefined | "ambiguous" {
	const trimmed = reference.trim();
	const normalized = trimmed.toLowerCase();

	const canonical = models.filter((m) => `${m.provider}/${m.id}`.toLowerCase() === normalized);
	if (canonical.length === 1) return canonical[0];
	if (canonical.length > 1) return "ambiguous";

	const slash = trimmed.indexOf("/");
	if (slash !== -1) {
		const provider = trimmed.slice(0, slash).trim().toLowerCase();
		const id = trimmed.slice(slash + 1).trim().toLowerCase();
		if (provider && id) {
			const byPair = models.filter((m) => m.provider.toLowerCase() === provider && m.id.toLowerCase() === id);
			if (byPair.length === 1) return byPair[0];
			if (byPair.length > 1) return "ambiguous";
		}
	}

	const byId = models.filter((m) => m.id.toLowerCase() === normalized);
	if (byId.length === 1) return byId[0];
	if (byId.length > 1) return "ambiguous";

	return undefined;
}

function partialMatch<M extends ModelLike>(reference: string, models: readonly M[]): M | undefined | "ambiguous" {
	const needle = reference.trim().toLowerCase();
	const matches = models.filter(
		(m) => m.id.toLowerCase().includes(needle) || (m.name?.toLowerCase().includes(needle) ?? false),
	);
	if (matches.length === 0) return undefined;
	if (matches.length === 1) return matches[0];

	// Prefer aliases over dated versions, as pi does; if that narrows to one, take it.
	const aliases = matches.filter((m) => isAlias(m.id));
	if (aliases.length === 1) return aliases[0];

	return "ambiguous";
}

/**
 * Resolve `reference` against `models`. Exact matching first, then partial.
 * Pass the registry's full `getAll()` list so an explicitly named model
 * resolves even when its provider has no key yet — the spawn that follows
 * will produce the clearer auth error.
 */
export function resolveModelReference<M extends ModelLike>(reference: string, models: readonly M[]): Resolution<M> {
	const exact = exactMatch(reference, models);
	if (exact === "ambiguous") {
		return { ok: false, error: `model "${reference}" matches more than one model — qualify it as provider/id` };
	}
	if (exact) return { ok: true, model: exact };

	const partial = partialMatch(reference, models);
	if (partial === "ambiguous") {
		return { ok: false, error: `model "${reference}" matches several models — use a more specific id` };
	}
	if (partial) return { ok: true, model: partial };

	return { ok: false, error: `model "${reference}" matched no available model` };
}
