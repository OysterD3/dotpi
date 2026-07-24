/**
 * Resolving the configured advisor reference ("sonnet", "opus",
 * "openai-codex/gpt-5.6-sol") to a real registry model, and the validation
 * Claude Code applies before it will use one.
 *
 * The matching rules are pi's own `--model` rules reproduced against the
 * ModelRegistry list (pi's resolver is not exported to extensions), the same
 * transcription the recap and ultracode extensions use:
 *
 *   1. canonical `provider/id`   exact, case-insensitive
 *   2. `provider/id` split       exact provider + exact id
 *   3. bare `id`                 exact, but rejected if ambiguous
 *   4. partial                   substring of id or name; prefer an alias
 *
 * Claude Code's capability checks are ported as far as they port:
 *   - Rut(main, advisor): the advisor must be "at least as capable" as the main
 *     model. Claude Code ranks by a per-model `advisor_rank` field and, tellingly,
 *     ALLOWS when either rank is unknown (`if(r===void 0||n===void 0)return!0`).
 *     pi's registry carries no such rank for arbitrary providers, so every pair
 *     is "unknown" and this reduces to allow — faithfully, not by omission.
 *   - Czg / "cannot be used as an advisor when the request model is <same>":
 *     the advisor cannot BE the model it advises. This one is provider-agnostic
 *     and always enforced (see sameModel).
 */

export type ModelLike = { readonly id: string; readonly name?: string; readonly provider: string; readonly contextWindow?: number };

export type Resolution<M> = { ok: true; model: M } | { ok: false; error: string };

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

	const aliases = matches.filter((m) => isAlias(m.id));
	if (aliases.length === 1) return aliases[0];

	return "ambiguous";
}

/** Resolve `reference` against `models`. Exact matching first, then partial. */
export function resolveModelReference<M extends ModelLike>(reference: string, models: readonly M[]): Resolution<M> {
	const trimmed = reference.trim();
	if (!trimmed) return { ok: false, error: "no advisor model configured" };

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

/** Claude Code's Czg rule: an advisor cannot be the very model it is advising. */
export function sameModel(a: ModelLike | undefined, b: ModelLike | undefined): boolean {
	if (!a || !b) return false;
	return a.provider === b.provider && a.id === b.id;
}
