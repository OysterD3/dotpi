/**
 * Resolving a prompt hook's `model` reference to an actual model.
 *
 * A COPY of permissions/model.ts, which documents the matching rules — they are
 * pi's own `--model` rules, reproduced because pi does not export its resolver
 * to extensions. Every extension in this repo installs on its own and may not
 * import across extension boundaries, so each one that resolves a model keeps
 * a copy; only the error wording differs.
 */

type ModelLike = { readonly id: string; readonly name?: string; readonly provider: string };

export type Resolution<M> =
	| { ok: true; model: M }
	| { ok: false; error: string };

/** True for an undated alias id (no trailing `-YYYYMMDD`). */
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

function matchOnce<M extends ModelLike>(
	reference: string,
	models: readonly M[],
): M | undefined | "ambiguous-exact" | "ambiguous-partial" {
	const exact = exactMatch(reference, models);
	if (exact === "ambiguous") return "ambiguous-exact";
	if (exact) return exact;
	const partial = partialMatch(reference, models);
	if (partial === "ambiguous") return "ambiguous-partial";
	return partial;
}

/**
 * Resolve `reference` against `models`. Exact matching first, then partial.
 * `models` should be the registry's list; pass `getAll()` so an explicitly named
 * model resolves even when its provider has no key yet — the auth check that
 * follows will produce the clearer error.
 */
export function resolveModel<M extends ModelLike>(reference: string, models: readonly M[]): Resolution<M> {
	// Full reference first, split only on a miss. Ids with colons are real —
	// OpenRouter ships `deepseek/deepseek-chat:free` — so a registry carrying
	// both `m` and `m:high` must answer `m:high` for the full string, and an
	// ambiguous match is not a miss: the reference found models as-is, and
	// splitting it would answer a different question. Same order as pi's own
	// parseModelPattern.
	let match = matchOnce(reference, models);
	// The name the full-name fallback below tries: the bare reference when a
	// level was split off, the whole reference when not.
	let candidate = reference;
	if (match === undefined) {
		const split = splitThinking(reference);
		// The level is stripped, never plumbed: a prompt hook's thinking is
		// pinned in config.ts (`PROMPT_REASONING`). The split exists so the
		// model resolves.
		if (split.thinking !== undefined) {
			candidate = split.reference;
			match = matchOnce(split.reference, models);
		}
	}

	if (match === "ambiguous-exact") {
		return { ok: false, error: `hook model "${reference}" matches more than one model — qualify it as provider/id` };
	}
	if (match === "ambiguous-partial") {
		return { ok: false, error: `hook model "${reference}" matches several models — use a more specific id` };
	}
	if (match) return { ok: true, model: match };

	// Both tries missed cleanly, so no model in the list has this name. A full
	// `provider/id` name still resolves when the list has that provider, the
	// way `pi --model` accepts a model pi does not list yet.
	const custom = fallbackModel(candidate, models);
	if (custom === "ambiguous") {
		return { ok: false, error: `hook model "${reference}" matches several models of that provider — use a more specific id` };
	}
	if (custom) return { ok: true, model: custom };

	return { ok: false, error: `hook model "${reference}" matched no available model` };
}

/**
 * A custom model for a `provider/id` name that is not in the list: a copy of
 * the first listed model of that provider, with the new id as its id and its
 * name. This is pi's buildFallbackModel (dist/core/model-resolver.js), less its
 * per-provider default model — the first listed model is the base here.
 *
 * The provider compares case-insensitively, and the result keeps the list's
 * own spelling of it, because every field except id and name comes from the
 * listed model. `undefined` when the name has no provider part, no id part, or
 * a provider that no listed model has. Only the part before the FIRST `/` is
 * the provider, so `openrouter/deepseek/deepseek-chat` keeps its id whole.
 */
function fallbackModel<M extends ModelLike>(reference: string, models: readonly M[]): M | "ambiguous" | undefined {
	const trimmed = reference.trim();
	const slash = trimmed.indexOf("/");
	if (slash === -1) return undefined;
	const provider = trimmed.slice(0, slash).trim().toLowerCase();
	const id = trimmed.slice(slash + 1).trim();
	if (!provider || !id) return undefined;
	const own = models.filter((m) => m.provider.toLowerCase() === provider);
	if (own.length === 0) return undefined;
	// pi matches the id among that provider's models before it makes one up
	// (parseModelPattern, then buildFallbackModel), so "openai-codex/luna" is
	// the listed luna model, not a new id "luna". An id that two of them
	// contain is ambiguous, as it is anywhere else.
	const listed = exactMatch(id, own) ?? partialMatch(id, own);
	if (listed) return listed;
	return { ...own[0], id, name: id };
}

/**
 * Split an optional trailing `:level` off a model reference.
 *
 * A COPY: every extension here that resolves a model keeps its own, because
 * each one installs on its own and may not import across extension boundaries.
 * The suffix is pi's `--model` syntax (`provider/id:high`); only pi's seven
 * levels split, because ids with colons are real (OpenRouter ships
 * `deepseek/deepseek-chat:free`). resolveModel tries the full reference first
 * and splits only on a miss, and discards the level it finds — this
 * extension's thinking is pinned in config.ts (PROMPT_REASONING), so the split
 * exists purely so the model resolves.
 */
export function splitThinking(reference: string): { reference: string; thinking?: string } {
	const colon = reference.lastIndexOf(":");
	if (colon <= 0) return { reference };
	const suffix = reference.slice(colon + 1).trim().toLowerCase();
	const base = reference.slice(0, colon).trim();
	if (!base || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(suffix)) return { reference };
	return { reference: base, thinking: suffix };
}
