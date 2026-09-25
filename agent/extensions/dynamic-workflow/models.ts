/**
 * Resolving a workflow agent's model reference ("sonnet", "fable",
 * "openai-codex/gpt-5.4-mini") to an actual registry model.
 *
 * This is what makes routing said in plain language work end to end: the user
 * writes "use sonnet for implementation and fable to review" in the request,
 * the main agent passes those short references via agent()'s model option, and
 * this resolver turns them into canonical provider/id pairs before the
 * subagent is spawned — so a typo or an ambiguous reference fails that agent
 * with a clear message instead of silently running on the wrong model.
 *
 * The matching rules are pi's own `--model` rules, reproduced against the
 * ModelRegistry list (pi's resolver is not exported to extensions) — the same
 * transcription the recap extension uses:
 *
 *   1. canonical `provider/id`            exact, case-insensitive
 *   2. `provider/id` split               exact provider + exact id
 *   3. bare `id`                         exact, but rejected if ambiguous
 *   4. partial                           substring of id or name; prefer an alias
 *   5. unlisted `provider/id`            a custom model of that id, when the
 *                                        provider is in the list (only in
 *                                        resolveSuffixedReference; see
 *                                        customModel)
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

/**
 * Resolve `reference` against `models`. Exact matching first, then partial.
 * Pass the registry's full `getAll()` list so an explicitly named model
 * resolves even when its provider has no key yet — the spawn that follows
 * will produce the clearer auth error.
 */
/**
 * Name the models a reference could have meant.
 *
 * An unresolvable reference fails EVERY agent that uses it, so the message is
 * the only thing standing between one bad word in a script and a dead fleet.
 * "matches several models — use a more specific id" does not say which ones, so
 * the next attempt is another guess: the local run store holds five runs killed
 * outright by `model "agent"` and `model "coding"`, re-authored under new names
 * rather than corrected. Listing the candidates turns that into a single fix.
 */
function nameCandidates<M extends ModelLike>(matches: readonly M[], limit = 6): string {
	const shown = matches.slice(0, limit).map((m) => `${m.provider}/${m.id}`);
	const more = matches.length - shown.length;
	return `${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}`;
}

export function resolveModelReference<M extends ModelLike>(reference: string, models: readonly M[]): Resolution<M> {
	const exact = exactMatch(reference, models);
	if (exact === "ambiguous") {
		const canonical = models.filter((m) => `${m.provider}/${m.id}`.toLowerCase() === reference.trim().toLowerCase());
		const byId = models.filter((m) => m.id.toLowerCase() === reference.trim().toLowerCase());
		const matches = canonical.length > 1 ? canonical : byId;
		return {
			ok: false,
			error: `model "${reference}" matches more than one model (${nameCandidates(matches)}) — qualify it as provider/id`,
		};
	}
	if (exact) return { ok: true, model: exact };

	const partial = partialMatch(reference, models);
	if (partial === "ambiguous") {
		const needle = reference.trim().toLowerCase();
		const matches = models.filter(
			(m) => m.id.toLowerCase().includes(needle) || (m.name?.toLowerCase().includes(needle) ?? false),
		);
		return {
			ok: false,
			error: `model "${reference}" matches several models (${nameCandidates(matches)}) — use one of those ids instead`,
		};
	}
	if (partial) return { ok: true, model: partial };

	// The unknown case is worth candidates too: "agent" and "coding" are not
	// model names at all, and seeing the real list is what stops the next guess.
	return { ok: false, error: `model "${reference}" matched no available model (available: ${nameCandidates(models, 8)})` };
}

/**
 * Resolve a configured model reference, which may carry a `:level` suffix
 * (pi's own --model syntax, "provider/id:high").
 *
 * FULL first, split only on a clean miss — the order is load-bearing, because
 * ids with colons are real (OpenRouter ships `deepseek/deepseek-chat:free`)
 * and splitting first would mangle them. An ambiguous full reference FOUND
 * models as-is, so its error answers the question the user configured; the
 * bare retry could quietly resolve to a model the full reference never named.
 * Every extension that resolves configured references keeps this rule;
 * diverging here would make the same configured value resolve in one
 * extension and error in another.
 *
 * The level itself is discarded. Thinking here is pinned per agent type and
 * per run (resolveThinking), all of it configuration written deliberately, and
 * a suffix on a model reference must not override it; the suffix is stripped
 * only so the model resolves.
 */
export function resolveSuffixedReference<M extends ModelLike>(reference: string, models: readonly M[]): Resolution<M> {
	const full = resolveModelReference(reference, models);
	if (full.ok) return full;
	const trimmed = reference.trim();
	if (exactMatch(trimmed, models) === "ambiguous" || partialMatch(trimmed, models) === "ambiguous") return full;
	const split = splitThinking(reference);
	if (split.thinking !== undefined) {
		const bare = resolveModelReference(split.reference, models);
		// A bare ambiguity found models, and naming them is the actionable
		// error, so it is returned as it is and never falls back.
		if (bare.ok || exactMatch(split.reference, models) === "ambiguous" || partialMatch(split.reference, models) === "ambiguous") return bare;
	}
	// Both tries missed cleanly. With no valid level, split.reference is the
	// whole reference, so an unknown suffix such as ":free" stays in the id.
	const custom = customModel(split.reference, models);
	if (custom === "ambiguous") return { ok: false, error: `model "${reference}" matches several models of that provider — use a more specific id` };
	if (custom) return { ok: true, model: custom };
	// A double miss reports the reference as configured — that is the string
	// in settings.json, so the one worth diagnosing.
	return full;
}

/**
 * A model for a full "provider/id" that the list does not contain.
 *
 * pi's own --model does this (buildFallbackModel in
 * dist/core/model-resolver.js): a provider can ship a new id before pi's
 * model list knows it, and `pi --model provider/new-id` still runs it. A
 * configured reference must work the same way, or a name that works on the
 * command line fails here. The model is a copy of the first model of that
 * provider in the list, so the api, base URL and limits come from a model
 * the provider really serves; only the id and the name change.
 *
 * The provider is the text before the FIRST "/", compared case-insensitively;
 * the copy keeps the list's own spelling. A reference with no "/", an empty
 * provider or id, or a provider that no model in the list has, gets nothing
 * here — a typo in a short name must still fail with the list of names.
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
 * Split an optional trailing `:level` off a model reference.
 *
 * A COPY. The suffix is pi's own --model syntax, a contract shared by string,
 * not by module — extensions here install independently and may not import
 * across boundaries — so every extension that resolves a configured model
 * reference keeps its own.
 */
export function splitThinking(reference: string): { reference: string; thinking?: string } {
	const colon = reference.lastIndexOf(":");
	if (colon <= 0) return { reference };
	const suffix = reference.slice(colon + 1).trim().toLowerCase();
	const base = reference.slice(0, colon).trim();
	if (!base || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(suffix)) return { reference };
	return { reference: base, thinking: suffix };
}
