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
 *   5. full name, not in the list        a custom model, if the provider is known
 *
 * Ambiguity is an error rather than a silent pick, because "recap ran on a model
 * I didn't expect" is worse than "recap told me the reference was ambiguous".
 *
 * A reference may end in `:level` — pi's `--model` syntax, which a configured
 * reference can carry. The FULL reference is matched first and the suffix split
 * off only when that finds nothing, because ids with colons are real (OpenRouter
 * ships `deepseek/deepseek-chat:free`). Recap ignores the level itself: its own
 * thinking setting is task-pinned in generate.ts, so the suffix exists here only
 * to be stripped so the model resolves.
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

/** One pass of the matching rules. `undefined` means it found nothing at all. */
function matchReference<M extends ModelLike>(reference: string, models: readonly M[]): Resolution<M> | undefined {
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

	return undefined;
}

/**
 * A full `provider/id` name that no listed model has, built as a custom model —
 * pi's `buildFallbackModel`, so a full name works here as it does for
 * `pi --model`. A new model can be used before pi's list knows it.
 *
 * The provider must be one the list knows: the custom model copies the first
 * listed model of that provider (its API, base URL, and limits) and changes
 * only the id and the name. An unknown provider gives no model to copy, and a
 * bare id names no provider, so both stay a miss. The split is at the FIRST
 * slash, because ids can contain slashes (`openrouter/zai-org/glm-5`).
 */
function customModel<M extends ModelLike>(reference: string, models: readonly M[]): M | "ambiguous" | undefined {
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
 * Resolve `reference` against `models`. Exact matching first, then partial,
 * then the full-name fallback.
 * `models` should be the registry's list; pass `getAll()` so an explicitly named
 * model resolves even when its provider has no key yet — the auth check that
 * follows will produce the clearer error.
 *
 * The split-on-miss retry runs only when the whole reference matched nothing:
 * an ambiguous full reference DID find models, so treating its tail as a
 * thinking level would resolve it to a model the reference never named. For
 * the same reason the fallback runs only when both tries found nothing. It gets
 * the reference without its level, so the level never becomes part of the id.
 */
export function resolveModel<M extends ModelLike>(reference: string, models: readonly M[]): Resolution<M> {
	const full = matchReference(reference, models);
	if (full !== undefined) return full;

	const { reference: bare, thinking } = splitThinking(reference);
	if (thinking !== undefined) {
		const stripped = matchReference(bare, models);
		if (stripped !== undefined) return stripped;
	}

	// `bare` is the whole reference when no valid level was split off.
	const custom = customModel(bare, models);
	if (custom === "ambiguous") return { ok: false, error: `recap.model "${reference}" matches several models of that provider — use a more specific id` };
	if (custom) return { ok: true, model: custom };

	// Every miss names the reference as configured — the suffix may be the typo.
	return { ok: false, error: `recap.model "${reference}" matched no available model` };
}

/**
 * Pick the model a recap call runs on.
 *
 * An explicit `recap.model` must resolve or the recap fails: the user named
 * it, and a silent stand-in would send their transcript somewhere they did
 * not choose. With nothing configured, the session model is used: the default
 * configured nothing, so it must not be able to break anything.
 */
export function selectModel<M extends ModelLike>(
	configured: string | undefined,
	sessionModel: M | undefined,
	models: readonly M[],
): Resolution<M> {
	if (configured) return resolveModel(configured, models);
	return sessionModel ? { ok: true, model: sessionModel } : { ok: false, error: "no model selected" };
}

/**
 * Split an optional trailing `:level` off a model reference.
 *
 * A COPY of pi's own `--model` suffix rule; every extension that resolves a
 * model carries one, because extensions here install independently and may not
 * import across boundaries. Only pi's seven thinking levels split — any other
 * suffix is part of the id, because ids with colons are real. Match the FULL
 * reference first; split only when that misses.
 */
export function splitThinking(reference: string): { reference: string; thinking?: string } {
	const colon = reference.lastIndexOf(":");
	if (colon <= 0) return { reference };
	const suffix = reference.slice(colon + 1).trim().toLowerCase();
	const base = reference.slice(0, colon).trim();
	if (!base || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(suffix)) return { reference };
	return { reference: base, thinking: suffix };
}
