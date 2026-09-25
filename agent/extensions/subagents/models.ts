/**
 * Resolving a subagent's model reference ("gpt-5.6-luna", "sonnet",
 * "openai-codex/gpt-5.6-sol") to a real registry model, using pi's own
 * `--model` rules reproduced against the ModelRegistry list (pi's resolver is
 * not exported to extensions). Same transcription the recap and ultracode
 * extensions use; duplicated here so this extension is independently
 * installable. Like `pi --model`, a full "provider/id" that the list does not
 * hold still resolves when its provider is known (resolveSuffixedReference).
 */

export type ModelLike = { readonly id: string; readonly name?: string; readonly provider: string };

export type Resolution<M> = { ok: true; model: M } | { ok: false; error: string };

/**
 * A Resolution that may carry the `:level` split off the reference. `thinking`
 * is set ONLY when the split path resolved — on a full match the colon was part
 * of the model id, so there is no level to carry.
 */
export type SuffixedResolution<M> = { ok: true; model: M; thinking?: string } | { ok: false; error: string };

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

	const aliases = matches.filter((m) => isAlias(m.id));
	if (aliases.length === 1) return aliases[0];

	return "ambiguous";
}

export function resolveModelReference<M extends ModelLike>(reference: string, models: readonly M[]): Resolution<M> {
	const trimmed = reference.trim();
	if (!trimmed) return { ok: false, error: "no model given" };

	const exact = exactMatch(trimmed, models);
	if (exact === "ambiguous") {
		return { ok: false, error: `model "${reference}" matches more than one model — qualify it as provider/id` };
	}
	if (exact) return { ok: true, model: exact };

	const partial = partialMatch(trimmed, models);
	if (partial === "ambiguous") {
		return { ok: false, error: `model "${reference}" matches several models — use a more specific id` };
	}
	if (partial) return { ok: true, model: partial };

	return { ok: false, error: `model "${reference}" matched no available model` };
}

/** Canonical "provider/id" reference for a resolved model, for pi's --model flag. */
export function modelRef(model: ModelLike): string {
	return `${model.provider}/${model.id}`;
}

/**
 * resolveModelReference, for a reference that may end in `:level` — pi's own
 * `--model` syntax, which an agent file or a task call can carry. The FULL
 * reference is matched first and only a clean miss splits: ids with colons
 * are real (OpenRouter ships `deepseek/deepseek-chat:free`), so splitting
 * first would mangle them, and an ambiguous full reference FOUND models
 * as-is — its error answers the question the user configured, where the bare
 * retry could quietly resolve to a model the full reference never named.
 * Every extension that resolves suffixed references keeps this rule;
 * diverging here would make the same reference resolve in one extension and
 * error in another.
 *
 * The split's level rides back on the ok result so the caller can weigh it
 * against per-agent and default reasoning (tool.ts holds that precedence). A
 * full match carries none — its colon belonged to the id — and which model any
 * reference resolves to is unchanged from when the level was discarded.
 *
 * When every try misses cleanly, a full "provider/id" still resolves through
 * fallbackModel below, the same way `pi --model` accepts a model its list does
 * not hold yet. The fallback is tried on the bare reference when a level was
 * split off (and that level is carried), else on the whole reference. An
 * ambiguous reference never reaches it: it found models, and its error stays.
 */
export function resolveSuffixedReference<M extends ModelLike>(reference: string, models: readonly M[]): SuffixedResolution<M> {
	const full = resolveModelReference(reference, models);
	if (full.ok) return full;
	const trimmed = reference.trim();
	if (exactMatch(trimmed, models) === "ambiguous" || partialMatch(trimmed, models) === "ambiguous") return full;
	const split = splitThinking(reference);
	if (split.thinking === undefined) {
		const custom = fallbackModel(trimmed, models);
		if (custom === "ambiguous") return { ok: false, error: `model "${reference}" matches several models of that provider — use a more specific id` };
		return custom ? { ok: true, model: custom } : full;
	}
	const bare = resolveModelReference(split.reference, models);
	// A double miss that the fallback cannot use reports the reference as
	// configured — that is the string in the agent file or the task call, so
	// the one worth diagnosing. A bare ambiguity is the exception: it found
	// models, and naming them is the actionable error.
	if (!bare.ok && exactMatch(split.reference, models) !== "ambiguous" && partialMatch(split.reference, models) !== "ambiguous") {
		const custom = fallbackModel(split.reference, models);
		if (custom === "ambiguous") return { ok: false, error: `model "${reference}" matches several models of that provider — use a more specific id` };
		return custom ? { ok: true, model: custom, thinking: split.thinking } : full;
	}
	return bare.ok ? { ok: true, model: bare.model, thinking: split.thinking } : bare;
}

/**
 * A model for a full "provider/id" that the list does not hold. It mirrors
 * pi's buildFallbackModel (dist/core/model-resolver.js), so a model name that
 * works with `pi --model` also works here.
 *
 * The provider is the text before the FIRST "/", the id is all the text after
 * it (an OpenRouter id can hold a slash), and both must be there. The provider
 * must match a model in the list, case-insensitively: the new model is a copy
 * of the first such model (its api, base URL and other provider fields), with
 * the id and the name set to the id. pi copies its own default model of the
 * provider when it has one; that table is not exported, so the first listed
 * model is the copy here. The list's own provider spelling stays, so the
 * spawn's --model names a provider pi knows. An unknown provider gives
 * undefined: there is nothing to copy the provider fields from.
 */
function fallbackModel<M extends ModelLike>(candidate: string, models: readonly M[]): M | "ambiguous" | undefined {
	const slash = candidate.indexOf("/");
	if (slash === -1) return undefined;
	const provider = candidate.slice(0, slash).trim().toLowerCase();
	const id = candidate.slice(slash + 1).trim();
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
 * A COPY: every extension that resolves suffixed references keeps its own,
 * because extensions here install independently and may not import across
 * boundaries. Only pi's seven levels split — any other suffix is part of the
 * id — and the registry must be tried with the FULL reference before
 * splitting, which is what resolveSuffixedReference does.
 */
export function splitThinking(reference: string): { reference: string; thinking?: string } {
	const colon = reference.lastIndexOf(":");
	if (colon <= 0) return { reference };
	const suffix = reference.slice(colon + 1).trim().toLowerCase();
	const base = reference.slice(0, colon).trim();
	if (!base || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(suffix)) return { reference };
	return { reference: base, thinking: suffix };
}
