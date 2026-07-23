/**
 * Resolving the configured recap model reference to an actual model.
 *
 * pi's own resolver (`findExactModelReferenceMatch` / `resolveCliModel`) is not
 * exported to extensions and needs the `ModelRuntime`, which extensions do not
 * get — they get the `ModelRegistry` facade and its `getAll()`. So the matching
 * rules are reproduced here against that list, deliberately the same rules pi
 * applies, so `recap.model` behaves like `--model` does:
 *
 *   1. canonical `provider/id`            exact, case-insensitive
 *   2. `provider/id` split               exact provider + exact id
 *   3. bare `id`                         exact, but rejected if ambiguous
 *   4. partial                           substring of id or name; prefer an alias
 *
 * Ambiguity is an error rather than a silent pick, because "recap ran on a model
 * I didn't expect" is worse than "recap told me the reference was ambiguous".
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
 * `models` should be the registry's list; pass `getAll()` so an explicitly named
 * model resolves even when its provider has no key yet — the auth check that
 * follows will produce the clearer error.
 */
export function resolveModel<M extends ModelLike>(reference: string, models: readonly M[]): Resolution<M> {
	const exact = exactMatch(reference, models);
	if (exact === "ambiguous") {
		return { ok: false, error: `recap.model "${reference}" matches more than one model — qualify it as provider/id` };
	}
	if (exact) return { ok: true, model: exact };

	const partial = partialMatch(reference, models);
	if (partial === "ambiguous") {
		return { ok: false, error: `recap.model "${reference}" matches several models — use a more specific id` };
	}
	if (partial) return { ok: true, model: partial };

	return { ok: false, error: `recap.model "${reference}" matched no available model` };
}
