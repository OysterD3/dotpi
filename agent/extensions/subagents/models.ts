/**
 * Resolving a subagent's model reference ("gpt-5.6-luna", "sonnet",
 * "openai-codex/gpt-5.6-sol") to a real registry model, using pi's own
 * `--model` rules reproduced against the ModelRegistry list (pi's resolver is
 * not exported to extensions). Same transcription the recap, ultracode, and
 * advisor extensions use; duplicated here so this extension is independently
 * installable.
 */

export type ModelLike = { readonly id: string; readonly name?: string; readonly provider: string };

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
